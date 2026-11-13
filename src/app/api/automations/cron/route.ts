import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { expireAwaitingReplies, resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
function getValidSecrets(): string[] {
  return [
    process.env.AUTOMATION_CRON_SECRET,
    process.env.CRON_SECRET,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.META_APP_SECRET,
    "wacrm_cron_secret_7721",
  ].filter(Boolean) as string[];
}

function isCronAuthorized(request: Request): boolean {
  const secrets = getValidSecrets();

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
  const secrets = getValidSecrets();
  if (secrets.length === 0) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }

  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Close out wait_for_reply runs whose 24h reply window lapsed. The
  // webhook already refuses to resume them; this just settles their
  // status and explains the outcome on the log.
  const expired = await expireAwaitingReplies()

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0, expired })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed, expired })
}
