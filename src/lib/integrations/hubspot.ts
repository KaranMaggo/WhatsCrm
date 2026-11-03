import type { SupabaseClient } from '@supabase/supabase-js';
import { getHubSpotConfigForAccount } from './hubspot-config';
import { recordHubSpotSyncLog } from './hubspot-logs';


export interface HubSpotContactProperties {
  email?: string;
  firstname?: string;
  lastname?: string;
  phone?: string;
  company?: string;
  [key: string]: unknown;
}

export interface HubSpotContact {
  id: string;
  properties: HubSpotContactProperties;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

export interface HubSpotContactInput {
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  company?: string | null;
}

export interface HubSpotSyncResult {
  action: 'created' | 'updated';
  hubspotContactId: string;
  email?: string | null;
  properties: HubSpotContactProperties;
}

export interface SyncConversationChatOptions {
  supabase?: SupabaseClient | null;
  accountId: string;
  conversationId: string;
  token?: string | null;
  singleMessageId?: string;
  syncAllMessages?: boolean;
}

export interface SyncConversationChatResult {
  ok: boolean;
  hubspotContactId?: string;
  noteCreated: boolean;
  messagesSyncedCount: number;
  error?: string;
}

const HUBSPOT_BASE_URL = 'https://api.hubapi.com';

/**
 * Split a full name into firstName and lastName for HubSpot contact properties.
 */
export function splitFullName(fullName?: string | null): {
  firstName?: string;
  lastName?: string;
} {
  if (!fullName) return {};
  const trimmed = fullName.trim();
  if (!trimmed) return {};

  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0] };
  }

  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ');
  return { firstName, lastName };
}

/**
 * Build authorized headers for HubSpot API calls.
 */
function getHeaders(token: string): Record<string, string> {
  const cleanToken = token.trim().replace(/^Bearer\s+/i, '');
  return {
    Authorization: `Bearer ${cleanToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Test connectivity with HubSpot using the provided Private App Access Token.
 */
export async function testHubSpotConnection(token: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!token?.trim()) {
    return { ok: false, error: 'HubSpot access token is missing' };
  }

  try {
    const res = await fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/contacts?limit=1`, {
      method: 'GET',
      headers: getHeaders(token),
    });

    if (res.ok) {
      return { ok: true };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error:
          'Invalid or unauthorized HubSpot token. Ensure your Private App has crm.objects.contacts.read and crm.objects.contacts.write scopes.',
      };
    }

    const body = await res.json().catch(() => null);
    const msg = body?.message || `HTTP ${res.status}: ${res.statusText}`;
    return { ok: false, error: msg };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to connect to HubSpot',
    };
  }
}

/**
 * Check if a contact with this email already exists in HubSpot.
 *
 * Uses HubSpot CRM v3 endpoint:
 * GET /crm/v3/objects/contacts/{email}?idProperty=email
 */
export async function findHubSpotContactByEmail(
  token: string,
  email: string
): Promise<HubSpotContact | null> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) return null;

  try {
    const res = await fetch(
      `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/${encodeURIComponent(
        cleanEmail
      )}?idProperty=email&properties=email,firstname,lastname,phone,company`,
      {
        method: 'GET',
        headers: getHeaders(token),
      }
    );

    if (res.status === 200) {
      const data = await res.json();
      return {
        id: String(data.id),
        properties: data.properties || {},
      };
    }

    if (res.status === 404) {
      return null;
    }

    // If endpoint gave unexpected non-404, fall back to Search API
    return await searchHubSpotContact(token, 'email', cleanEmail);
  } catch (err) {
    console.warn('[hubspot] findByEmail GET failed, trying search fallback:', err);
    return await searchHubSpotContact(token, 'email', cleanEmail);
  }
}

/**
 * Check if a contact exists in HubSpot by phone number via Search API.
 */
export async function findHubSpotContactByPhone(
  token: string,
  phone: string
): Promise<HubSpotContact | null> {
  const cleanPhone = phone.trim();
  if (!cleanPhone) return null;

  const found = await searchHubSpotContact(token, 'phone', cleanPhone);
  if (found) return found;

  // If phone had +, try without + or vice versa
  if (cleanPhone.startsWith('+')) {
    return await searchHubSpotContact(token, 'phone', cleanPhone.slice(1));
  } else {
    return await searchHubSpotContact(token, 'phone', `+${cleanPhone}`);
  }
}

/**
 * Search HubSpot contacts by an exact property match.
 */
async function searchHubSpotContact(
  token: string,
  propertyName: string,
  value: string
): Promise<HubSpotContact | null> {
  try {
    const res = await fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: getHeaders(token),
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              {
                propertyName,
                operator: 'EQ',
                value,
              },
            ],
          },
        ],
        properties: ['email', 'firstname', 'lastname', 'phone', 'company'],
        limit: 1,
      }),
    });

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    if (data.total > 0 && Array.isArray(data.results) && data.results.length > 0) {
      const item = data.results[0];
      return {
        id: String(item.id),
        properties: item.properties || {},
      };
    }

    return null;
  } catch (err) {
    console.error('[hubspot] search error:', err);
    return null;
  }
}

/**
 * Create a new contact in HubSpot.
 *
 * Handles HTTP 409 Conflict if contact was created concurrently by updating instead.
 */
export async function createHubSpotContact(
  token: string,
  input: HubSpotContactInput
): Promise<HubSpotContact> {
  const properties: Record<string, string> = {};
  if (input.email?.trim()) {
    properties.email = input.email.trim().toLowerCase();
  }

  const { firstName, lastName } = splitFullName(input.name);
  if (firstName) properties.firstname = firstName;
  if (lastName) properties.lastname = lastName;
  if (input.phone?.trim()) properties.phone = input.phone.trim();
  if (input.company?.trim()) properties.company = input.company.trim();

  const res = await fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/contacts`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ properties }),
  });

  if (res.status === 201) {
    const data = await res.json();
    return {
      id: String(data.id),
      properties: data.properties || properties,
    };
  }

  // 409 Conflict: Contact already exists with this email
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    // Message often contains "Contact already exists. Existing ID: 12345"
    const match = body?.message?.match(/Existing ID:\s*(\d+)/i);
    const existingId = match ? match[1] : null;

    if (existingId) {
      return await updateHubSpotContact(token, existingId, input);
    }

    if (input.email) {
      return await updateHubSpotContact(token, input.email, input);
    }
  }

  const errBody = await res.json().catch(() => null);
  const errMsg = errBody?.message || `Failed to create HubSpot contact (HTTP ${res.status})`;
  throw new Error(errMsg);
}

/**
 * Update an existing contact in HubSpot by contact ID or by email.
 */
export async function updateHubSpotContact(
  token: string,
  contactIdOrEmail: string,
  input: HubSpotContactInput
): Promise<HubSpotContact> {
  const properties: Record<string, string> = {};

  const { firstName, lastName } = splitFullName(input.name);
  if (firstName) properties.firstname = firstName;
  if (lastName) properties.lastname = lastName;
  if (input.phone?.trim()) properties.phone = input.phone.trim();
  if (input.company?.trim()) properties.company = input.company.trim();
  if (input.email?.trim()) properties.email = input.email.trim().toLowerCase();

  const isNumericId = /^\d+$/.test(contactIdOrEmail.trim());
  const url = isNumericId
    ? `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/${contactIdOrEmail.trim()}`
    : `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/${encodeURIComponent(
        contactIdOrEmail.trim()
      )}?idProperty=email`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: getHeaders(token),
    body: JSON.stringify({ properties }),
  });

  if (res.ok) {
    const data = await res.json();
    return {
      id: String(data.id),
      properties: data.properties || properties,
    };
  }

  const errBody = await res.json().catch(() => null);
  const errMsg = errBody?.message || `Failed to update HubSpot contact (HTTP ${res.status})`;
  throw new Error(errMsg);
}

/**
 * Core synchronization function:
 * 1. Checks if contact email already exists in HubSpot.
 * 2. If email exists: updates the existing contact in HubSpot.
 * 3. If email does not exist: creates a new contact in HubSpot.
 * 4. If email is not present, falls back to checking/creating by phone.
 */
export async function syncContactToHubSpot(
  token: string,
  contact: HubSpotContactInput
): Promise<HubSpotSyncResult> {
  if (!token?.trim()) {
    throw new Error('HubSpot access token is required.');
  }

  const email = contact.email?.trim() || null;
  const phone = contact.phone?.trim() || null;

  if (!email && !phone) {
    throw new Error('Contact must have an email or phone number to sync with HubSpot.');
  }

  // 1. If email exists, check HubSpot by email first
  if (email) {
    console.info(`[HubSpot] Checking if contact exists in HubSpot for email: "${email}"...`);
    const existing = await findHubSpotContactByEmail(token, email);
    if (existing) {
      // Email exists in HubSpot -> UPDATE contact
      console.info(`[HubSpot] Contact exists in HubSpot (ID: ${existing.id}). Updating contact...`);
      const updated = await updateHubSpotContact(token, existing.id, contact);
      console.info(`[HubSpot] ✓ Contact updated in HubSpot (ID: ${updated.id})`);
      return {
        action: 'updated',
        hubspotContactId: updated.id,
        email,
        properties: updated.properties,
      };
    }

    // Email does not exist in HubSpot -> CREATE contact
    console.info(`[HubSpot] Contact does not exist with email "${email}". Creating new contact in HubSpot...`);
    const created = await createHubSpotContact(token, contact);
    console.info(`[HubSpot] ✓ Contact created in HubSpot (ID: ${created.id})`);
    return {
      action: 'created',
      hubspotContactId: created.id,
      email,
      properties: created.properties,
    };
  }

  // 2. If no email, check by phone
  if (phone) {
    console.info(`[HubSpot] No email provided. Searching HubSpot by phone: "${phone}"...`);
    const existingByPhone = await findHubSpotContactByPhone(token, phone);
    if (existingByPhone) {
      console.info(`[HubSpot] Contact exists in HubSpot by phone (ID: ${existingByPhone.id}). Updating...`);
      const updated = await updateHubSpotContact(token, existingByPhone.id, contact);
      console.info(`[HubSpot] ✓ Contact updated in HubSpot (ID: ${updated.id})`);
      return {
        action: 'updated',
        hubspotContactId: updated.id,
        email: null,
        properties: updated.properties,
      };
    }

    console.info(`[HubSpot] Contact not found by phone. Creating new contact in HubSpot with phone "${phone}"...`);
    const created = await createHubSpotContact(token, contact);
    console.info(`[HubSpot] ✓ Contact created in HubSpot (ID: ${created.id})`);
    return {
      action: 'created',
      hubspotContactId: created.id,
      email: null,
      properties: created.properties,
    };
  }

  throw new Error('Unable to sync contact to HubSpot.');
}

/**
 * Generate deep-link to the conversation chat in WhatsCrm.
 * Formats as: https://whats-crm-three.vercel.app/chat?conversation_id={conversation_id}
 */
export function getHubSpotChatDeepLink(conversationId: string): string {
  const envUrl = process.env.HUBSPOT_CHAT_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL;
  const baseUrl = envUrl && !envUrl.includes('example.com')
    ? envUrl.replace(/\/$/, '')
    : 'https://whats-crm-three.vercel.app';
  return `${baseUrl}/chat?conversation_id=${encodeURIComponent(conversationId)}`;
}

/**
 * Create a Note on a HubSpot Contact.
 *
 * Uses HubSpot CRM v3 endpoint:
 * POST /crm/v3/objects/notes
 * with association type 202 (note to contact).
 */
export async function createHubSpotNote(
  token: string,
  hubspotContactId: string,
  noteBody: string,
  timestamp?: string
): Promise<{ id: string } | null> {
  if (!token?.trim() || !hubspotContactId?.trim()) return null;

  try {
    const res = await fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/notes`, {
      method: 'POST',
      headers: getHeaders(token),
      body: JSON.stringify({
        properties: {
          hs_timestamp: timestamp || new Date().toISOString(),
          hs_note_body: noteBody,
        },
        associations: [
          {
            to: { id: hubspotContactId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: 202,
              },
            ],
          },
        ],
      }),
    });

    if (res.status === 201) {
      const data = await res.json();
      return { id: String(data.id) };
    }

    const err = await res.json().catch(() => null);
    console.warn('[hubspot] createHubSpotNote error:', res.status, err?.message || err);
    return null;
  } catch (err) {
    console.error('[hubspot] createHubSpotNote network error:', err);
    return null;
  }
}

/**
 * Log a WhatsApp message to a HubSpot Contact's activity timeline.
 *
 * Uses HubSpot CRM v3 endpoint:
 * POST /crm/v3/objects/communications
 * with:
 * - hs_communication_channel_type: 'WHATS_APP'
 * - hs_communication_logged_from: 'CRM'
 * - hs_communication_body: message text with sender prefix
 * - association type 81 (communication to contact).
 */
export async function logHubSpotWhatsAppMessage(
  token: string,
  hubspotContactId: string,
  options: {
    body: string;
    timestamp?: string;
  }
): Promise<{ id: string } | null> {
  if (!token?.trim() || !hubspotContactId?.trim() || !options.body?.trim()) return null;

  try {
    const res = await fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/communications`, {
      method: 'POST',
      headers: getHeaders(token),
      body: JSON.stringify({
        properties: {
          hs_communication_channel_type: 'WHATS_APP',
          hs_communication_logged_from: 'CRM',
          hs_communication_body: options.body.trim(),
          hs_timestamp: options.timestamp || new Date().toISOString(),
        },
        associations: [
          {
            to: { id: hubspotContactId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: 81,
              },
            ],
          },
        ],
      }),
    });

    if (res.status === 201) {
      const data = await res.json();
      return { id: String(data.id) };
    }

    const err = await res.json().catch(() => null);
    console.warn('[hubspot] logHubSpotWhatsAppMessage error:', res.status, err?.message || err);
    return null;
  } catch (err) {
    console.error('[hubspot] logHubSpotWhatsAppMessage network error:', err);
    return null;
  }
}

/**
 * Format a database message row into the body text to display in HubSpot timeline:
 * e.g. "Cosmedic Express: Hi Claire, ..."
 * or "Claire Hunter: Yes, I would like to book an appointment"
 */
export function formatWhatsAppMessageForHubSpot(
  senderType: string,
  contentText: string | null | undefined,
  contentType: string | null | undefined,
  senderName: string,
  contactName: string
): string {
  let body = contentText?.trim() || '';

  if (!body) {
    if (contentType === 'image') body = '[Image]';
    else if (contentType === 'document') body = '[Document]';
    else if (contentType === 'video') body = '[Video]';
    else if (contentType === 'audio') body = '[Audio message]';
    else if (contentType === 'template') body = '[Template message]';
    else if (contentType === 'interactive') body = '[Interactive button/list]';
    else body = '[WhatsApp message]';
  }

  const prefix = senderType === 'customer'
    ? (contactName?.trim() || 'Customer')
    : (senderName?.trim() || 'Business');

  if (body.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)) {
    return body;
  }

  return `${prefix}: ${body}`;
}

/**
 * Synchronize a WhatsApp conversation chat to HubSpot:
 * 1. Resolves/verifies contact in HubSpot (creating/updating as needed).
 * 2. If the initial "WhatsApp conversation started" note has not yet been logged,
 *    creates a Note on the HubSpot contact with the deep-link:
 *    "WhatsApp conversation started\nhttps://whats-crm-three.vercel.app/chat?conversation_id={id}".
 * 3. Logs unsynced messages as "Logged WhatsApp message" on the contact timeline
 *    via HubSpot Communications API (WHATS_APP).
 * 4. Updates DB rows with HubSpot IDs to prevent duplicate logs.
 */
export async function syncConversationChatToHubSpot(
  options: SyncConversationChatOptions
): Promise<SyncConversationChatResult> {
  const { accountId, conversationId, singleMessageId } = options;

  let client = options.supabase;
  if (!client) {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const { createClient } = await import('@supabase/supabase-js');
      client = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );
    }
  }

  if (!client) {
    return {
      ok: false,
      noteCreated: false,
      messagesSyncedCount: 0,
      error: 'Database client not available.',
    };
  }

  // 1. Resolve HubSpot token and config
  let token = options.token?.trim() || null;
  if (!token) {
    const config = await getHubSpotConfigForAccount(client, accountId);
    if (!config || !config.configured || !config.token) {
      return {
        ok: false,
        noteCreated: false,
        messagesSyncedCount: 0,
        error: 'HubSpot is not configured for this account.',
      };
    }
    if (!config.autoSyncChat && !config.autoSyncOnMessage && !options.singleMessageId) {
      return {
        ok: false,
        noteCreated: false,
        messagesSyncedCount: 0,
        error: 'HubSpot chat auto-sync is disabled in settings.',
      };
    }
    token = config.token;
  }

  // 2. Fetch conversation
  const { data: conv, error: convErr } = await client
    .from('conversations')
    .select('id, contact_id, created_at, hubspot_started_synced, hubspot_contact_id')
    .eq('id', conversationId)
    .single();

  if (convErr || !conv) {
    return {
      ok: false,
      noteCreated: false,
      messagesSyncedCount: 0,
      error: 'Conversation not found.',
    };
  }

  // 3. Fetch contact
  const { data: contact, error: contactErr } = await client
    .from('contacts')
    .select('id, name, email, phone, company, hubspot_contact_id')
    .eq('id', conv.contact_id)
    .single();

  if (contactErr || !contact) {
    return {
      ok: false,
      noteCreated: false,
      messagesSyncedCount: 0,
      error: 'Contact for conversation not found.',
    };
  }

  // 4. Fetch account name (for sender prefix)
  let accountName = 'Cosmedic Express';
  try {
    const { data: accountData } = await client
      .from('accounts')
      .select('name')
      .eq('id', accountId)
      .maybeSingle();
    if (accountData?.name) {
      accountName = accountData.name;
    }
  } catch {
    // Fall back to default accountName
  }

  // 5. Ensure contact is synced to HubSpot to get hubspotContactId
  let hubspotContactId: string | null =
    contact.hubspot_contact_id || conv.hubspot_contact_id || null;

  if (!hubspotContactId) {
    try {
      const syncResult = await syncContactToHubSpot(token, {
        email: contact.email,
        name: contact.name,
        phone: contact.phone,
        company: contact.company,
      });
      hubspotContactId = syncResult.hubspotContactId;

      // Cache on contact and conversation rows
      try {
        await client
          .from('contacts')
          .update({
            hubspot_contact_id: hubspotContactId,
            hubspot_synced_at: new Date().toISOString(),
          })
          .eq('id', contact.id);

        await client
          .from('conversations')
          .update({ hubspot_contact_id: hubspotContactId })
          .eq('id', conversationId);
      } catch (cacheErr) {
        console.warn('[hubspot] caching hubspot_contact_id failed:', cacheErr);
      }

      await recordHubSpotSyncLog(client, {
        account_id: accountId,
        contact_id: contact.id,
        contact_name: contact.name,
        email: contact.email,
        phone: contact.phone,
        action: syncResult.action,
        hubspot_contact_id: hubspotContactId,
        status: 'success',
        source: 'chat_sync',
      });
    } catch (contactSyncErr) {
      const errMsg =
        contactSyncErr instanceof Error
          ? contactSyncErr.message
          : 'Failed to sync contact to HubSpot';
      console.warn('[hubspot] syncContactToHubSpot before chat failed:', errMsg);
      return {
        ok: false,
        noteCreated: false,
        messagesSyncedCount: 0,
        error: errMsg,
      };
    }
  }

  if (!hubspotContactId) {
    return {
      ok: false,
      noteCreated: false,
      messagesSyncedCount: 0,
      error: 'Could not obtain HubSpot Contact ID.',
    };
  }

  // 6. Ensure initial "WhatsApp conversation started" note is logged
  let noteCreated = false;
  if (!conv.hubspot_started_synced) {
    const deepLink = getHubSpotChatDeepLink(conversationId);
    const noteBody = `WhatsApp conversation started\n${deepLink}`;
    console.info(`[HubSpot] Creating initial conversation note for conversation ${conversationId}...`);
    const noteRes = await createHubSpotNote(
      token,
      hubspotContactId,
      noteBody,
      conv.created_at
    );

    if (noteRes?.id) {
      noteCreated = true;
      try {
        await client
          .from('conversations')
          .update({
            hubspot_started_synced: true,
            hubspot_contact_id: hubspotContactId,
          })
          .eq('id', conversationId);
      } catch (convUpdateErr) {
        console.warn('[hubspot] updating conversation sync status failed:', convUpdateErr);
      }

      await recordHubSpotSyncLog(client, {
        account_id: accountId,
        contact_id: contact.id,
        contact_name: contact.name,
        email: contact.email,
        phone: contact.phone,
        action: 'note_created',
        hubspot_contact_id: hubspotContactId,
        status: 'success',
        source: 'chat_sync',
      });
      console.info(`[HubSpot] ✓ Initial conversation note created in HubSpot (Note ID: ${noteRes.id})`);
    } else {
      console.warn('[HubSpot] Initial note creation returned null');
    }
  }

  // 7. Sync messages to HubSpot
  let messagesQuery = client
    .from('messages')
    .select('id, sender_type, content_type, content_text, media_url, template_name, interactive_reply_id, created_at, hubspot_communication_id')
    .eq('conversation_id', conversationId);

  if (singleMessageId) {
    messagesQuery = messagesQuery.eq('id', singleMessageId);
  } else {
    messagesQuery = messagesQuery
      .is('hubspot_communication_id', null)
      .order('created_at', { ascending: true });
  }

  const { data: messagesToSync, error: msgsErr } = await messagesQuery;
  if (msgsErr) {
    console.warn('[hubspot] Error querying messages to sync:', msgsErr);
    return {
      ok: true,
      hubspotContactId,
      noteCreated,
      messagesSyncedCount: 0,
    };
  }

  let messagesSyncedCount = 0;
  if (messagesToSync && messagesToSync.length > 0) {
    for (const msg of messagesToSync) {
      if (msg.hubspot_communication_id) continue;

      const body = formatWhatsAppMessageForHubSpot(
        msg.sender_type,
        msg.content_text,
        msg.content_type,
        accountName,
        contact.name || 'Customer'
      );

      console.info(`[HubSpot] Logging WhatsApp message to HubSpot: "${body.slice(0, 50)}..."`);
      const commResult = await logHubSpotWhatsAppMessage(
        token,
        hubspotContactId,
        {
          body,
          timestamp: msg.created_at,
        }
      );

      if (commResult?.id) {
        messagesSyncedCount++;
        try {
          await client
            .from('messages')
            .update({
              hubspot_communication_id: commResult.id,
              hubspot_synced_at: new Date().toISOString(),
            })
            .eq('id', msg.id);
        } catch (msgUpdateErr) {
          console.warn('[hubspot] updating message sync status failed:', msgUpdateErr);
        }

        await recordHubSpotSyncLog(client, {
          account_id: accountId,
          contact_id: contact.id,
          contact_name: contact.name,
          email: contact.email,
          phone: contact.phone,
          action: 'message_logged',
          hubspot_contact_id: hubspotContactId,
          status: 'success',
          source:
            msg.sender_type === 'customer'
              ? 'whatsapp_message'
              : 'outbound_message',
        });
      }
    }
    console.info(`[HubSpot] ✓ Logged ${messagesSyncedCount} messages to HubSpot contact ${hubspotContactId}`);
  }

  return {
    ok: true,
    hubspotContactId,
    noteCreated,
    messagesSyncedCount,
  };
}

