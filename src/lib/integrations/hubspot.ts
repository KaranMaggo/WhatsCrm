/**
 * HubSpot CRM API v3 Client
 *
 * Implements contact synchronization:
 * - First checks if contact email already exists in HubSpot
 * - If email exists -> updates the contact with latest details
 * - If email does not exist -> creates the contact in HubSpot
 * - Supports fallback search by phone when email is absent
 */

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
