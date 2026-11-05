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
  hubspotContactId?: string | null;
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
  mediaNotesCreatedCount?: number;
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
 * Generate candidate phone strings to maximize search matches across
 * formatting differences (with/without leading '+', formatted parentheses/dashes vs digits).
 */
export function getPhoneSearchCandidates(phone: string): string[] {
  const trimmed = phone?.trim();
  if (!trimmed) return [];

  const candidates = new Set<string>();
  candidates.add(trimmed);

  if (trimmed.startsWith('+')) {
    const withoutPlus = trimmed.slice(1).trim();
    if (withoutPlus) candidates.add(withoutPlus);
  } else {
    candidates.add(`+${trimmed}`);
  }

  // Also try digits-only variations (handles "+1 (555) 123-4567" -> "15551234567" and "+15551234567")
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly) {
    candidates.add(digitsOnly);
    candidates.add(`+${digitsOnly}`);
  }

  return Array.from(candidates);
}

/**
 * Check if a contact exists in HubSpot by phone number via Search API.
 * Searches both `phone` and `mobilephone` properties using the `IN` operator across
 * candidate format variations, with a resilient fallback.
 */
export async function findHubSpotContactByPhone(
  token: string,
  phone: string
): Promise<HubSpotContact | null> {
  const cleanPhone = phone?.trim();
  if (!cleanPhone) return null;

  const candidates = getPhoneSearchCandidates(cleanPhone);
  if (candidates.length === 0) return null;

  // 1. Primary search: query `phone` and `mobilephone` using `IN` with all candidate variations
  try {
    const res = await fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: getHeaders(token),
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'phone',
                operator: 'IN',
                values: candidates,
              },
            ],
          },
          {
            filters: [
              {
                propertyName: 'mobilephone',
                operator: 'IN',
                values: candidates,
              },
            ],
          },
        ],
        properties: ['email', 'firstname', 'lastname', 'phone', 'mobilephone', 'company'],
        limit: 1,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.total > 0 && Array.isArray(data.results) && data.results.length > 0) {
        const item = data.results[0];
        return {
          id: String(item.id),
          properties: item.properties || {},
        };
      }
      return null;
    }

    // 2. Fallback: if search with `IN` operator returned non-OK HTTP status, try individual queries with `EQ`
    for (const candidate of candidates) {
      const foundPhone = await searchHubSpotContact(token, 'phone', candidate);
      if (foundPhone) return foundPhone;
      const foundMobile = await searchHubSpotContact(token, 'mobilephone', candidate);
      if (foundMobile) return foundMobile;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Search HubSpot contacts by an exact property match.
 */
export async function searchHubSpotContact(
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
        properties: ['email', 'firstname', 'lastname', 'phone', 'mobilephone', 'company'],
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
  } catch {
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

  // 409 Conflict: Contact already exists with this email or phone
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

    if (input.phone) {
      const existingByPhone = await findHubSpotContactByPhone(token, input.phone);
      if (existingByPhone) {
        return await updateHubSpotContact(token, existingByPhone.id, input);
      }
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
 * 1. If hubspotContactId is provided, attempts to update that contact directly.
 * 2. Checks if contact email already exists in HubSpot.
 *    If email exists: updates the existing contact in HubSpot.
 * 3. Checks if contact phone number exists in HubSpot (searching both phone and mobilephone).
 *    If phone exists: updates the existing contact in HubSpot.
 * 4. If neither email nor phone exists in HubSpot: creates a new contact in HubSpot.
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
  const hubspotContactId = contact.hubspotContactId?.trim() || null;

  if (!email && !phone && !hubspotContactId) {
    throw new Error('Contact must have an email or phone number to sync with HubSpot.');
  }

  // 1. Direct ID update if known
  if (hubspotContactId) {
    try {
      console.info(`[HubSpot] Updating contact by existing HubSpot ID: ${hubspotContactId}...`);
      const updated = await updateHubSpotContact(token, hubspotContactId, contact);
      console.info(`[HubSpot] ✓ Contact updated in HubSpot by ID (ID: ${updated.id})`);
      return {
        action: 'updated',
        hubspotContactId: updated.id,
        email: contact.email || null,
        properties: updated.properties,
      };
    } catch (idErr) {
      console.warn(
        `[HubSpot] Update by ID (${hubspotContactId}) failed, falling back to email/phone lookup:`,
        idErr
      );
    }
  }

  let existing: HubSpotContact | null = null;

  // 2. Check HubSpot by email first if email is provided
  if (email) {
    console.info(`[HubSpot] Checking if contact exists in HubSpot for email: "${email}"...`);
    existing = await findHubSpotContactByEmail(token, email);
    if (existing) {
      console.info(`[HubSpot] Contact exists in HubSpot by email (ID: ${existing.id}). Updating contact...`);
    }
  }

  // 3. If contact was not found by email, check HubSpot by phone number
  if (!existing && phone) {
    console.info(`[HubSpot] Checking if contact exists in HubSpot for phone: "${phone}"...`);
    existing = await findHubSpotContactByPhone(token, phone);
    if (existing) {
      console.info(`[HubSpot] Contact exists in HubSpot by phone (ID: ${existing.id}). Updating contact...`);
    }
  }

  // 4. If contact was found (by email or phone), UPDATE existing contact
  if (existing) {
    const updated = await updateHubSpotContact(token, existing.id, contact);
    console.info(`[HubSpot] ✓ Contact updated in HubSpot (ID: ${updated.id})`);
    return {
      action: 'updated',
      hubspotContactId: updated.id,
      email: contact.email || null,
      properties: updated.properties,
    };
  }

  // 5. Contact does not exist in HubSpot by email or phone -> CREATE new contact
  console.info(
    `[HubSpot] Contact not found by email ("${email || 'N/A'}") or phone ("${phone || 'N/A'}"). Creating new contact in HubSpot...`
  );
  const created = await createHubSpotContact(token, contact);
  console.info(`[HubSpot] ✓ Contact created in HubSpot (ID: ${created.id})`);
  return {
    action: 'created',
    hubspotContactId: created.id,
    email: contact.email || null,
    properties: created.properties,
  };
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format an inbound WhatsApp media message (image/video) into a Note for HubSpot.
 * Includes note title ("Images shared on WhatsApp" or "Videos shared on WhatsApp"),
 * caption, and media attachment link.
 */
export function formatWhatsAppMediaNote(
  contentType: string,
  caption?: string | null,
  mediaUrl?: string | null,
  fileName?: string | null
): { title: string; htmlBody: string; plainText: string } {
  const isVideo = contentType === 'video';
  // Matches user specification: "Images shared on WhatsApp" / "Videos shared on WhatsApp"
  const title = isVideo ? 'Videos shared on WhatsApp' : 'Images shared on WhatsApp';
  const cleanCaption = caption?.trim() || null;
  const cleanUrl = mediaUrl?.trim() || null;
  const displayFile = fileName?.trim() || (isVideo ? 'WhatsApp Video' : 'WhatsApp Image');

  const plainParts: string[] = [title];
  if (cleanCaption) {
    plainParts.push(`Caption: ${cleanCaption}`);
  }
  if (cleanUrl) {
    plainParts.push(`Attachment: ${cleanUrl}`);
  }
  const plainText = plainParts.join('\n');

  let htmlBody = `<p><strong>${escapeHtml(title)}</strong></p>`;
  if (cleanCaption) {
    htmlBody += `<p><strong>Caption:</strong> ${escapeHtml(cleanCaption)}</p>`;
  }
  if (cleanUrl) {
    htmlBody += `<p><strong>Attachment:</strong> <a href="${escapeHtml(
      cleanUrl
    )}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayFile)}</a></p>`;
  }

  return { title, htmlBody, plainText };
}

/**
 * Retrieve deal IDs associated with a contact in HubSpot.
 * Checks both v4 and v3 associations endpoints.
 */
export async function getHubSpotContactDeals(
  token: string,
  hubspotContactId: string
): Promise<string[]> {
  if (!token?.trim() || !hubspotContactId?.trim()) return [];

  const dealIds = new Set<string>();

  // 1. Try v4 associations endpoint: /crm/v4/objects/contacts/{contactId}/associations/deals
  try {
    const res = await fetch(
      `${HUBSPOT_BASE_URL}/crm/v4/objects/contacts/${encodeURIComponent(
        hubspotContactId
      )}/associations/deals?limit=100`,
      {
        method: 'GET',
        headers: getHeaders(token),
      }
    );

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.results)) {
        for (const item of data.results) {
          const id = item.toObjectId || item.id;
          if (id) dealIds.add(String(id));
        }
        if (dealIds.size > 0) {
          return Array.from(dealIds);
        }
      }
    }
  } catch (err) {
    console.warn('[hubspot] getHubSpotContactDeals v4 lookup failed, trying fallback:', err);
  }

  // 2. Fallback to v3 contact read with associations=deals
  try {
    const res = await fetch(
      `${HUBSPOT_BASE_URL}/crm/v3/objects/contacts/${encodeURIComponent(
        hubspotContactId
      )}?associations=deals`,
      {
        method: 'GET',
        headers: getHeaders(token),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const results = data.associations?.deals?.results;
      if (Array.isArray(results)) {
        for (const item of results) {
          if (item.id) dealIds.add(String(item.id));
        }
      }
    }
  } catch (err) {
    console.warn('[hubspot] getHubSpotContactDeals v3 fallback failed:', err);
  }

  return Array.from(dealIds);
}

/**
 * Upload a media file to HubSpot Files API (/files/v3/files).
 * Returns the uploaded file ID and URL for CRM note attachments.
 */
export async function uploadFileToHubSpot(
  token: string,
  options: {
    fileName: string;
    fileBuffer: Buffer | Uint8Array;
    mimeType?: string;
    folderPath?: string;
  }
): Promise<{ id: string; url?: string } | null> {
  if (!token?.trim() || !options.fileBuffer) return null;

  try {
    const formData = new FormData();
    const blob = new Blob([options.fileBuffer as unknown as BlobPart], {
      type: options.mimeType || 'application/octet-stream',
    });
    formData.append('file', blob, options.fileName);
    formData.append('fileName', options.fileName);
    formData.append('options', JSON.stringify({ access: 'PUBLIC_NOT_INDEXABLE' }));
    formData.append('folderPath', options.folderPath || '/WhatsApp Media');

    const cleanToken = token.trim().replace(/^Bearer\s+/i, '');
    const res = await fetch(`${HUBSPOT_BASE_URL}/files/v3/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cleanToken}`,
      },
      body: formData,
    });

    if (res.status === 200 || res.status === 201) {
      const data = await res.json();
      return {
        id: String(data.id),
        url: data.url,
      };
    }

    const err = await res.json().catch(() => null);
    console.warn('[hubspot] uploadFileToHubSpot error:', res.status, err?.message || err);
    return null;
  } catch (err) {
    console.warn('[hubspot] uploadFileToHubSpot network/exception error:', err);
    return null;
  }
}

/**
 * Create a Note associated to both Contact (202) and Deals (214) in HubSpot,
 * with optional file attachment (hs_attachment_ids).
 */
export async function createHubSpotMediaNote(
  token: string,
  options: {
    hubspotContactId: string;
    dealIds?: string[];
    noteBody: string;
    fileId?: string | null;
    timestamp?: string;
  }
): Promise<{ id: string } | null> {
  const { hubspotContactId, dealIds = [], noteBody, fileId, timestamp } = options;
  if (!token?.trim() || !hubspotContactId?.trim() || !noteBody?.trim()) return null;

  const associations: Array<{
    to: { id: string };
    types: Array<{ associationCategory: string; associationTypeId: number }>;
  }> = [
    {
      to: { id: hubspotContactId },
      types: [
        {
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId: 202, // Note to Contact
        },
      ],
    },
  ];

  // Associate Note to each Deal (associationTypeId 214)
  for (const dealId of dealIds) {
    if (dealId && dealId !== hubspotContactId) {
      associations.push({
        to: { id: String(dealId) },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 214, // Note to Deal
          },
        ],
      });
    }
  }

  const properties: Record<string, string> = {
    hs_timestamp: timestamp || new Date().toISOString(),
    hs_note_body: noteBody,
  };

  if (fileId) {
    properties.hs_attachment_ids = String(fileId);
  }

  try {
    const res = await fetch(`${HUBSPOT_BASE_URL}/crm/v3/objects/notes`, {
      method: 'POST',
      headers: getHeaders(token),
      body: JSON.stringify({
        properties,
        associations,
      }),
    });

    if (res.status === 201) {
      const data = await res.json();
      return { id: String(data.id) };
    }

    const err = await res.json().catch(() => null);
    console.warn('[hubspot] createHubSpotMediaNote error:', res.status, err?.message || err);
    return null;
  } catch (err) {
    console.error('[hubspot] createHubSpotMediaNote network error:', err);
    return null;
  }
}

/**
 * Download raw bytes of a media URL for uploading to HubSpot Files.
 */
export async function fetchMediaBytes(
  mediaUrl: string
): Promise<{ buffer: Buffer; mimeType?: string; fileName?: string } | null> {
  if (!mediaUrl?.trim()) return null;

  try {
    let targetUrl = mediaUrl.trim();
    if (targetUrl.startsWith('/')) {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
      targetUrl = `${siteUrl.replace(/\/$/, '')}${targetUrl}`;
    }

    const res = await fetch(targetUrl);
    if (!res.ok) {
      console.warn('[hubspot] fetchMediaBytes failed with status:', res.status, targetUrl);
      return null;
    }

    const mimeType = res.headers.get('content-type') || undefined;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let fileName = 'media_file';
    try {
      const parsedUrl = new URL(targetUrl);
      const lastSegment = parsedUrl.pathname.split('/').pop();
      if (lastSegment && lastSegment.includes('.')) {
        fileName = decodeURIComponent(lastSegment);
      } else {
        const ext = mimeType?.includes('video') ? '.mp4' : '.jpg';
        fileName = `whatsapp_${Date.now()}${ext}`;
      }
    } catch {
      const ext = mimeType?.includes('video') ? '.mp4' : '.jpg';
      fileName = `whatsapp_${Date.now()}${ext}`;
    }

    return { buffer, mimeType, fileName };
  } catch (err) {
    console.warn('[hubspot] fetchMediaBytes exception:', err);
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
    .select('id, user_id, contact_id, created_at, hubspot_started_synced, hubspot_contact_id')
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
    .select('id, user_id, name, email, phone, company, hubspot_contact_id')
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
    .select('id, sender_type, content_type, content_text, media_url, media_type, template_name, interactive_reply_id, created_at, hubspot_communication_id, hubspot_note_id')
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
      mediaNotesCreatedCount: 0,
      messagesSyncedCount: 0,
    };
  }

  let messagesSyncedCount = 0;
  let mediaNotesCreatedCount = 0;
  let cachedDealIds: string[] | null = null;
  const currentContactId = contact.id;

  async function resolveContactDeals(): Promise<string[]> {
    if (cachedDealIds !== null) return cachedDealIds;
    const deals = await getHubSpotContactDeals(token!, hubspotContactId!);
    try {
      const { data: localDeals } = await client!
        .from('deals')
        .select('id, hubspot_deal_id, notes')
        .eq('contact_id', currentContactId);

      if (localDeals && Array.isArray(localDeals)) {
        for (const ld of localDeals) {
          if (ld.hubspot_deal_id && !deals.includes(ld.hubspot_deal_id)) {
            deals.push(ld.hubspot_deal_id);
          }
        }
      }
    } catch (e) {
      console.warn('[hubspot] reading local deals error:', e);
    }
    cachedDealIds = deals;
    return deals;
  }

  if (messagesToSync && messagesToSync.length > 0) {
    for (const msg of messagesToSync) {
      const isClientMedia =
        msg.sender_type === 'customer' &&
        (msg.content_type === 'image' || msg.content_type === 'video');

      // 7A. Sync Media Note to Contacts & Deals if it's client image/video and not yet synced as note
      if (isClientMedia && !msg.hubspot_note_id) {
        const deals = await resolveContactDeals();
        const formattedNote = formatWhatsAppMediaNote(
          msg.content_type,
          msg.content_text,
          msg.media_url
        );

        let fileAttachmentId: string | null = null;
        if (msg.media_url) {
          try {
            const mediaBytes = await fetchMediaBytes(msg.media_url);
            if (mediaBytes) {
              const uploaded = await uploadFileToHubSpot(token!, {
                fileName:
                  mediaBytes.fileName ||
                  (msg.content_type === 'video'
                    ? 'whatsapp_video.mp4'
                    : 'whatsapp_image.jpg'),
                fileBuffer: mediaBytes.buffer,
                mimeType: mediaBytes.mimeType || msg.media_type,
              });
              if (uploaded?.id) {
                fileAttachmentId = uploaded.id;
              }
            }
          } catch (uploadErr) {
            console.warn(
              '[HubSpot] File upload for media note failed, will link in note body:',
              uploadErr
            );
          }
        }

        console.info(
          `[HubSpot] Creating media note for ${msg.content_type} on contact ${hubspotContactId} and deals [${deals.join(', ')}]...`
        );
        const noteResult = await createHubSpotMediaNote(token!, {
          hubspotContactId,
          dealIds: deals,
          noteBody: formattedNote.htmlBody,
          fileId: fileAttachmentId,
          timestamp: msg.created_at,
        });

        if (noteResult?.id) {
          mediaNotesCreatedCount++;
          msg.hubspot_note_id = noteResult.id;
          try {
            await client
              .from('messages')
              .update({
                hubspot_note_id: noteResult.id,
                hubspot_synced_at: new Date().toISOString(),
              })
              .eq('id', msg.id);
          } catch (msgUpdateErr) {
            console.warn('[hubspot] updating message hubspot_note_id failed:', msgUpdateErr);
          }

          // Add to local contact_notes so it's visible in WACRM contact sidebar
          try {
            await client.from('contact_notes').insert({
              contact_id: contact.id,
              account_id: accountId,
              user_id: conv.user_id || contact.user_id || '00000000-0000-0000-0000-000000000000',
              note_text: formattedNote.plainText,
            });
          } catch (noteInsertErr) {
            console.warn('[hubspot] local contact_note insert failed:', noteInsertErr);
          }

          // Also update local deals' notes if any exist
          try {
            const { data: localDeals } = await client
              .from('deals')
              .select('id, notes')
              .eq('contact_id', contact.id);

            if (localDeals && Array.isArray(localDeals)) {
              for (const d of localDeals) {
                const updatedNotes = d.notes
                  ? `${d.notes}\n\n[${formattedNote.title}]: ${msg.content_text || ''} ${msg.media_url || ''}`.trim()
                  : `[${formattedNote.title}]: ${msg.content_text || ''} ${msg.media_url || ''}`.trim();
                await client
                  .from('deals')
                  .update({ notes: updatedNotes, updated_at: new Date().toISOString() })
                  .eq('id', d.id);
              }
            }
          } catch (dealNoteErr) {
            console.warn('[hubspot] local deal notes update failed:', dealNoteErr);
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
            source: 'whatsapp_message',
          });
          console.info(`[HubSpot] ✓ Created media note in HubSpot (Note ID: ${noteResult.id})`);
        }
      }

      // 7B. Also log timeline communication if not yet logged
      if (!msg.hubspot_communication_id) {
        const body = formatWhatsAppMessageForHubSpot(
          msg.sender_type,
          msg.content_text,
          msg.content_type,
          accountName,
          contact.name || 'Customer'
        );

        console.info(`[HubSpot] Logging WhatsApp message to HubSpot: "${body.slice(0, 50)}..."`);
        const commResult = await logHubSpotWhatsAppMessage(
          token!,
          hubspotContactId,
          {
            body,
            timestamp: msg.created_at,
          }
        );

        if (commResult?.id) {
          messagesSyncedCount++;
          msg.hubspot_communication_id = commResult.id;
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
    }
    console.info(
      `[HubSpot] ✓ Logged ${messagesSyncedCount} messages, ${mediaNotesCreatedCount} media notes to HubSpot contact ${hubspotContactId}`
    );
  }

  return {
    ok: true,
    hubspotContactId,
    noteCreated,
    mediaNotesCreatedCount,
    messagesSyncedCount,
  };
}

