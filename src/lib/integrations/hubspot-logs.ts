import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function getFallbackAdminClient(): SupabaseClient | null {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return null;
}

export interface HubSpotSyncLog {
  id: string;
  account_id: string;
  contact_id?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  action: 'created' | 'updated' | 'failed';
  hubspot_contact_id?: string | null;
  status: 'success' | 'error';
  error_message?: string | null;
  source: 'whatsapp_message' | 'manual' | 'api' | 'contact_form' | 'test';
  created_at: string;
}

// In-memory fallback ring buffer (stores up to 100 entries per account)
// Ensures logs are always visible in the UI even before database migrations are run
const inMemoryLogs = new Map<string, HubSpotSyncLog[]>();

export async function recordHubSpotSyncLog(
  supabase: SupabaseClient | null,
  entry: Omit<HubSpotSyncLog, 'id' | 'created_at'>
): Promise<HubSpotSyncLog> {
  const log: HubSpotSyncLog = {
    ...entry,
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    created_at: new Date().toISOString(),
  };

  // 1. Console log with formatted prefix
  const time = new Date().toLocaleTimeString();
  const sourceLabel = `[${log.source}]`;
  const contactLabel = log.contact_name
    ? `${log.contact_name} (${log.email || log.phone || 'no contact info'})`
    : log.email || log.phone || 'unnamed';

  if (log.status === 'success') {
    console.info(
      `\x1b[32m[HubSpot Sync ${time}]\x1b[0m ${sourceLabel} \x1b[1m${log.action.toUpperCase()}\x1b[0m contact: ${contactLabel} -> HubSpot ID: ${log.hubspot_contact_id || 'N/A'}`
    );
  } else {
    console.error(
      `\x1b[31m[HubSpot Sync ${time}]\x1b[0m ${sourceLabel} \x1b[1mFAILED\x1b[0m for ${contactLabel}: ${log.error_message}`
    );
  }

  // 2. Always store in memory for instant UI display
  const accountList = inMemoryLogs.get(log.account_id) || [];
  accountList.unshift(log);
  if (accountList.length > 100) accountList.pop();
  inMemoryLogs.set(log.account_id, accountList);

  // 3. Persist to Supabase
  const client = supabase || getFallbackAdminClient();
  if (client) {
    try {
      const { error } = await client.from('hubspot_sync_logs').insert({
        account_id: log.account_id,
        contact_id: log.contact_id || null,
        contact_name: log.contact_name || null,
        email: log.email || null,
        phone: log.phone || null,
        action: log.action,
        hubspot_contact_id: log.hubspot_contact_id || null,
        status: log.status,
        error_message: log.error_message || null,
        source: log.source,
        created_at: log.created_at,
      });

      // If user client hit RLS error, retry with admin client
      if (error && client !== getFallbackAdminClient()) {
        const admin = getFallbackAdminClient();
        if (admin) {
          await admin.from('hubspot_sync_logs').insert({
            account_id: log.account_id,
            contact_id: log.contact_id || null,
            contact_name: log.contact_name || null,
            email: log.email || null,
            phone: log.phone || null,
            action: log.action,
            hubspot_contact_id: log.hubspot_contact_id || null,
            status: log.status,
            error_message: log.error_message || null,
            source: log.source,
            created_at: log.created_at,
          });
        }
      }
    } catch {
      // In-memory buffer covers it
    }
  }

  return log;
}

export async function getHubSpotSyncLogs(
  supabase: SupabaseClient | null,
  accountId: string,
  limit = 50
): Promise<HubSpotSyncLog[]> {
  // Try reading from database first
  const client = supabase || getFallbackAdminClient();
  if (client) {
    try {
      const { data, error } = await client
        .from('hubspot_sync_logs')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!error && Array.isArray(data) && data.length > 0) {
        return data as HubSpotSyncLog[];
      }
    } catch {
      // Fallback to memory
    }
  }

  // Return from in-memory ring buffer
  return (inMemoryLogs.get(accountId) || []).slice(0, limit);
}

export async function clearHubSpotSyncLogs(
  supabase: SupabaseClient | null,
  accountId: string
): Promise<void> {
  inMemoryLogs.delete(accountId);

  const client = supabase || getFallbackAdminClient();
  if (client) {
    try {
      await client.from('hubspot_sync_logs').delete().eq('account_id', accountId);
    } catch {
      // Ignore
    }
  }
}
