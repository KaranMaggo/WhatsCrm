import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'
import { engineSendText } from '@/lib/flows/meta-send'
import { interpolateVars, loadContactVars } from '@/lib/flows/engine'

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 */
function isCronAuthorized(request: Request): boolean {
  const secrets = [
    process.env.AUTOMATION_CRON_SECRET,
    process.env.CRON_SECRET,
  ].filter(Boolean) as string[];

  if (secrets.length === 0) {
    return false;
  }

  // Check Bearer token (Vercel native cron)
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    for (const s of secrets) {
      if (timingSafeCompare(token, s)) return true;
    }
  }

  // Check x-cron-secret header (external pingers)
  const xSecret = request.headers.get('x-cron-secret');
  if (xSecret) {
    for (const s of secrets) {
      if (timingSafeCompare(xSecret, s)) return true;
    }
  }

  return false;
}

function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function GET(request: Request) {
  const secrets = [process.env.AUTOMATION_CRON_SECRET, process.env.CRON_SECRET].filter(Boolean);
  if (secrets.length === 0) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }

  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin()
  const now = new Date()

  // Pull all currently-active runs along with their parent flow's
  // fallback_policy. Joined in one query — the small set of active
  // runs per tenant keeps this cheap.
  const { data: runs, error } = await admin
    .from('flow_runs')
    .select(
      'id, flow_id, account_id, user_id, contact_id, conversation_id, last_prompt_message_id, vars, current_node_key, last_advanced_at, flows ( fallback_policy )',
    )
    .eq('status', 'active')

  if (error) {
    console.error('[flows-cron] active-run scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!runs?.length) return NextResponse.json({ swept: 0 })

  type Row = {
    id: string
    flow_id: string
    account_id: string
    user_id: string
    contact_id: string | null
    conversation_id: string | null
    last_prompt_message_id: string | null
    vars: Record<string, unknown> | null
    current_node_key: string | null
    last_advanced_at: string
    flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null
  }

  let swept = 0
  for (const r of runs as Row[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null)
    const lastAdvanced = new Date(r.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)

    const runVars = (r.vars ?? {}) as Record<string, unknown>
    const followupsSent = typeof runVars._followup_count === 'number' ? runVars._followup_count : 0
    const followupsList = policy.followup_enabled && Array.isArray(policy.followups)
      ? policy.followups.filter((f) => f && f.message?.trim())
      : []

    // If follow-ups are configured and not yet exhausted:
    if (followupsList.length > 0 && followupsSent < followupsList.length) {
      const nextFollowup = followupsList[followupsSent]
      if (nextFollowup && ageHours >= nextFollowup.delay_hours) {
        if (r.conversation_id && r.contact_id) {
          try {
            const contactVars = await loadContactVars(admin, r.contact_id)
            const text = interpolateVars(nextFollowup.message, runVars, contactVars)

            await engineSendText({
              accountId: r.account_id,
              userId: r.user_id,
              conversationId: r.conversation_id,
              contactId: r.contact_id,
              text,
            })

            const updatedVars = {
              ...runVars,
              _followup_count: followupsSent + 1,
              _last_followup_at: now.toISOString(),
            }

            await admin
              .from('flow_runs')
              .update({ vars: updatedVars })
              .eq('id', r.id)
              .eq('status', 'active')

            await admin.from('flow_run_events').insert({
              flow_run_id: r.id,
              event_type: 'followup_sent',
              node_key: r.current_node_key,
              payload: {
                followup_number: followupsSent + 1,
                delay_hours: nextFollowup.delay_hours,
                text,
              },
            })

            swept += 1
            continue
          } catch (fErr) {
            console.error('[flows-cron] follow-up send failed:', fErr)
          }
        }
      } else {
        // Still within follow-up delay window, don't time out yet
        continue
      }
    }

    if (ageHours < policy.on_timeout_hours) continue

    const endStatus = policy.on_exhaust === 'handoff' ? 'handed_off' : 'timed_out'
    if (endStatus === 'handed_off' && r.conversation_id) {
      await admin
        .from('conversations')
        .update({ status: 'pending', updated_at: now.toISOString() })
        .eq('id', r.conversation_id)
    }

    // Mark run finished — guarded by the precondition `status='active'`
    const { data: updated } = await admin
      .from('flow_runs')
      .update({
        status: endStatus,
        ended_at: now.toISOString(),
        end_reason: 'stale_sweep',
      })
      .eq('id', r.id)
      .eq('status', 'active')
      .select('id')

    if (Array.isArray(updated) && updated.length > 0) {
      await admin.from('flow_run_events').insert({
        flow_run_id: r.id,
        event_type: endStatus === 'handed_off' ? 'handoff' : 'timeout',
        node_key: r.current_node_key,
        payload: {
          age_hours: Math.round(ageHours * 10) / 10,
          policy_hours: policy.on_timeout_hours,
          reason: 'stale_sweep',
        },
      })
      swept += 1
    }
  }

  return NextResponse.json({ swept })
}
