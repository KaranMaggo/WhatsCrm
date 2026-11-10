import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

/**
 * Extracts a property value from a HubSpot payload.
 * Handles both HubSpot's object structure: `{ properties: { firstname: { value: "..." } } }`
 * or flat objects: `{ properties: { firstname: "..." } }`
 * or direct body: `{ firstname: "..." }`.
 */
function extractProperty(
  body: Record<string, unknown>,
  keys: string[]
): string | null {
  const properties = (body.properties && typeof body.properties === 'object'
    ? body.properties
    : null) as Record<string, unknown> | null;

  const fields = (body.fields && typeof body.fields === 'object'
    ? body.fields
    : null) as Record<string, unknown> | null;

  for (const key of keys) {
    // 1. Check body.properties[key]
    if (properties && properties[key] !== undefined && properties[key] !== null) {
      const val = properties[key];
      if (typeof val === 'object' && val !== null && 'value' in val) {
        const inner = (val as { value?: unknown }).value;
        if (inner !== undefined && inner !== null && String(inner).trim()) {
          return String(inner).trim();
        }
      } else if (typeof val === 'string' && val.trim()) {
        return val.trim();
      } else if (typeof val === 'number') {
        return String(val);
      }
    }

    // 2. Check body.fields[key]
    if (fields && fields[key] !== undefined && fields[key] !== null) {
      const val = fields[key];
      if (typeof val === 'object' && val !== null && 'value' in val) {
        const inner = (val as { value?: unknown }).value;
        if (inner !== undefined && inner !== null && String(inner).trim()) {
          return String(inner).trim();
        }
      } else if (typeof val === 'string' && val.trim()) {
        return val.trim();
      }
    }

    // 3. Check direct body[key]
    if (body[key] !== undefined && body[key] !== null) {
      const val = body[key];
      if (typeof val === 'object' && val !== null && 'value' in val) {
        const inner = (val as { value?: unknown }).value;
        if (inner !== undefined && inner !== null && String(inner).trim()) {
          return String(inner).trim();
        }
      } else if (typeof val === 'string' && val.trim()) {
        return val.trim();
      } else if (typeof val === 'number') {
        return String(val);
      }
    }
  }

  return null;
}

/**
 * Clean phone number to E.164 (adds leading + if missing).
 */
function cleanPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'HubSpot Lead Webhook endpoint is active and listening for POST requests.',
    target_path: '/api/integrations/hubspot/lead-webhook',
  });
}

export async function POST(request: Request) {
  const db = supabaseAdmin();

  try {
    const url = new URL(request.url);
    const queryAccountId = url.searchParams.get('account_id')?.trim();

    // 1. Resolve Account ID
    let accountId = queryAccountId;
    if (!accountId) {
      // Find the first account configured with HubSpot or WhatsApp
      const { data: hubspotConfig } = await db
        .from('hubspot_configs')
        .select('account_id')
        .limit(1)
        .maybeSingle();

      if (hubspotConfig?.account_id) {
        accountId = hubspotConfig.account_id;
      } else {
        const { data: waConfig } = await db
          .from('whatsapp_config')
          .select('account_id')
          .limit(1)
          .maybeSingle();
        if (waConfig?.account_id) {
          accountId = waConfig.account_id;
        }
      }
    }

    if (!accountId) {
      return NextResponse.json(
        { error: 'No active account found. Pass ?account_id=<uuid> in the webhook URL.' },
        { status: 400 }
      );
    }

    // 2. Parse request body
    const rawBody = await request.json().catch(() => null);
    if (!rawBody || typeof rawBody !== 'object') {
      return NextResponse.json(
        { error: 'Invalid or missing JSON payload' },
        { status: 400 }
      );
    }

    // HubSpot sometimes wraps batch webhooks in an array
    const body: Record<string, unknown> = Array.isArray(rawBody)
      ? (rawBody[0] as Record<string, unknown>)
      : rawBody;

    // 3. Extract core contact properties
    const rawPhone = extractProperty(body, [
      'phone',
      'mobilephone',
      'whatsapp_number',
      'phone_number',
      'hs_whatsapp_phone_number',
    ]);
    const phone = cleanPhone(rawPhone);

    if (!phone) {
      return NextResponse.json(
        {
          error:
            'No valid phone number found in payload. Include phone, mobilephone, or phone_number in the webhook.',
          received_keys: Object.keys(body),
        },
        { status: 400 }
      );
    }

    const firstName =
      extractProperty(body, ['firstname', 'first_name']) || '';
    const lastName =
      extractProperty(body, ['lastname', 'last_name']) || '';
    const fullNameRaw = extractProperty(body, ['full_name', 'name']);
    const name =
      fullNameRaw ||
      [firstName, lastName].filter(Boolean).join(' ') ||
      phone;

    const email = extractProperty(body, ['email']);
    const city = extractProperty(body, ['city']);

    // Extract form-specific questions
    const procedure = extractProperty(body, [
      'which_procedure_are_you_interested_in_',
      'which_procedure_are_you_interested_in',
      'which_procedure',
      'procedure',
      'surgery_type',
      'procedure_type',
      'service',
    ]);

    const timeline = extractProperty(body, [
      'when_are_you_planning_the_procedure_',
      'when_are_you_planning_the_procedure',
      'planning_procedure',
      'procedure_timeline',
      'timeline',
      'timeframe',
    ]);

    const goal = extractProperty(body, [
      'what_is_your_main_goal_',
      'what_is_your_main_goal',
      'main_goal',
      'goal',
    ]);

    // Extract HubSpot contact ID if present
    const hubspotContactId =
      extractProperty(body, ['hs_object_id', 'objectId', 'id']) ||
      ((body.object as { objectId?: unknown } | undefined)?.objectId
        ? String((body.object as { objectId?: unknown }).objectId)
        : null);

    // 4. Resolve or create contact and conversation in WhatsCRM
    const { conversationId, contactId, contactCreated } =
      await resolveConversationByPhone(db, accountId, phone, name);

    // Update contact with email & HubSpot contact ID if available
    const contactUpdates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (email) contactUpdates.email = email;
    if (hubspotContactId) contactUpdates.hubspot_contact_id = hubspotContactId;
    if (Object.keys(contactUpdates).length > 1) {
      await db.from('contacts').update(contactUpdates).eq('id', contactId);
    }

    // 5. Build the formatted chat message (matching the Meta form view)
    const lines: string[] = [
      'Hello! I filled in your form and would like to know more about your business.',
      '',
    ];

    if (timeline) {
      lines.push(`When are you planning the procedure?: ${timeline}`);
    }
    lines.push(`Full name: ${name}`);
    if (city) {
      lines.push(`City: ${city}`);
    }
    if (goal) {
      lines.push(`What is your main goal?: ${goal}`);
    }
    lines.push(`Phone number: ${phone}`);
    if (procedure) {
      lines.push(`Which procedure are you interested in?: ${procedure}`);
    }
    if (email) {
      lines.push(`Email: ${email}`);
    }

    const messageContent = lines.join('\n');

    // 6. Insert message into conversation
    const nowIso = new Date().toISOString();
    const { data: insertedMsg, error: insertError } = await db
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'customer',
        content_type: 'text',
        content_text: messageContent,
        status: 'delivered',
        created_at: nowIso,
      })
      .select()
      .single();

    if (insertError) {
      console.error('[hubspot-lead-webhook] message insert error:', insertError);
      return NextResponse.json(
        { error: 'Failed to record message in conversation', details: insertError.message },
        { status: 500 }
      );
    }

    // 7. Update conversation metadata
    const { data: convData } = await db
      .from('conversations')
      .select('unread_count')
      .eq('id', conversationId)
      .maybeSingle();

    await db
      .from('conversations')
      .update({
        last_message_text: messageContent.slice(0, 500),
        last_message_at: nowIso,
        unread_count: ((convData?.unread_count as number) || 0) + 1,
        updated_at: nowIso,
      })
      .eq('id', conversationId);

    // 8. Fire realtime webhook event so UI chat updates immediately
    void dispatchWebhookEvent(db, accountId, 'message.received', {
      conversation_id: conversationId,
      message_id: insertedMsg.id,
      contact_id: contactId,
      sender_type: 'customer',
      content_type: 'text',
      content_text: messageContent,
    });

    console.info(
      `[hubspot-lead-webhook] ✓ Lead form synced for ${name} (${phone}) in conversation ${conversationId}`
    );

    return NextResponse.json({
      ok: true,
      data: {
        contact_id: contactId,
        conversation_id: conversationId,
        message_id: insertedMsg.id,
        contact_created: contactCreated,
        phone,
        name,
      },
    });
  } catch (err) {
    console.error('[hubspot-lead-webhook] Unhandled error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

