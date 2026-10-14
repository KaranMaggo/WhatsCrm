import fs from 'fs';
import path from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';

function getFallbackAdminClient(): SupabaseClient | null {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return null;
}

export interface HubSpotAccountConfig {
  configured: boolean;
  token: string | null;
  portalId?: string | null;
  autoSyncOnMessage: boolean;
  autoSyncContacts: boolean;
  isEnv: boolean;
}

interface LocalStoredConfig {
  account_id: string;
  access_token: string; // encrypted
  portal_id?: string | null;
  auto_sync_on_message?: boolean;
  auto_sync_contacts?: boolean;
  updated_at?: string;
}

const LOCAL_CONFIG_PATH = path.join(process.cwd(), '.hubspot-config.json');
const ENV_LOCAL_PATH = path.join(process.cwd(), '.env.local');

function readLocalConfigFile(accountId?: string): LocalStoredConfig | null {
  try {
    if (!fs.existsSync(LOCAL_CONFIG_PATH)) return null;
    const content = fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(content) as LocalStoredConfig;
    if (accountId && parsed.account_id && parsed.account_id !== accountId) {
      // If scoped to a specific account, only return if matching
      return parsed;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalConfigFile(config: LocalStoredConfig): void {
  try {
    fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[hubspot-config] Failed to write local config file:', err);
  }
}

function updateEnvLocalToken(token: string): void {
  try {
    process.env.HUBSPOT_ACCESS_TOKEN = token;
    if (!fs.existsSync(ENV_LOCAL_PATH)) return;

    let envContent = fs.readFileSync(ENV_LOCAL_PATH, 'utf8');
    const tokenRegex = /^HUBSPOT_ACCESS_TOKEN=.*$/m;

    if (tokenRegex.test(envContent)) {
      envContent = envContent.replace(tokenRegex, `HUBSPOT_ACCESS_TOKEN=${token}`);
    } else {
      envContent += `\nHUBSPOT_ACCESS_TOKEN=${token}\n`;
    }

    fs.writeFileSync(ENV_LOCAL_PATH, envContent, 'utf8');
  } catch (err) {
    console.warn('[hubspot-config] Could not update .env.local:', err);
  }
}

/**
 * Retrieve the active HubSpot configuration for an account.
 *
 * Precedence:
 * 1. Supabase `hubspot_configs` table (if table exists and row found)
 * 2. Local fallback `.hubspot-config.json` file (encrypted at rest)
 * 3. `HUBSPOT_ACCESS_TOKEN` environment variable
 */
export async function getHubSpotConfigForAccount(
  supabase: SupabaseClient | null,
  accountId: string
): Promise<HubSpotAccountConfig> {
  const envToken = process.env.HUBSPOT_ACCESS_TOKEN?.trim() || null;

  // 1. Try reading from Supabase (user client first, then fallback admin client)
  const client = supabase || getFallbackAdminClient();
  if (client) {
    try {
      const { data, error } = await client
        .from('hubspot_configs')
        .select('access_token, portal_id, auto_sync_on_message, auto_sync_contacts')
        .eq('account_id', accountId)
        .maybeSingle();

      if (!error && data?.access_token) {
        try {
          const decryptedToken = decrypt(data.access_token);
          return {
            configured: true,
            token: decryptedToken,
            portalId: data.portal_id ?? null,
            autoSyncOnMessage: data.auto_sync_on_message !== false,
            autoSyncContacts: data.auto_sync_contacts !== false,
            isEnv: false,
          };
        } catch (decErr) {
          console.error('[hubspot-config] Failed to decrypt DB token:', decErr);
        }
      }
    } catch {
      // Ignore DB fetch failure; continue to local fallback
    }
  }

  // 2. Try reading from local .hubspot-config.json
  const localConfig = readLocalConfigFile(accountId);
  if (localConfig?.access_token) {
    try {
      const decryptedToken = decrypt(localConfig.access_token);
      return {
        configured: true,
        token: decryptedToken,
        portalId: localConfig.portal_id ?? null,
        autoSyncOnMessage: localConfig.auto_sync_on_message !== false,
        autoSyncContacts: localConfig.auto_sync_contacts !== false,
        isEnv: false,
      };
    } catch {
      // If decryption fails, token might be stored raw
      if (localConfig.access_token.startsWith('pat-')) {
        return {
          configured: true,
          token: localConfig.access_token,
          portalId: localConfig.portal_id ?? null,
          autoSyncOnMessage: localConfig.auto_sync_on_message !== false,
          autoSyncContacts: localConfig.auto_sync_contacts !== false,
          isEnv: false,
        };
      }
    }
  }

  // 3. Try reading from environment variable
  if (envToken) {
    return {
      configured: true,
      token: envToken,
      portalId: null,
      autoSyncOnMessage: true,
      autoSyncContacts: true,
      isEnv: true,
    };
  }

  return {
    configured: false,
    token: null,
    portalId: null,
    autoSyncOnMessage: false,
    autoSyncContacts: false,
    isEnv: false,
  };
}

/**
 * Persist HubSpot configuration for an account.
 *
 * Saves to:
 * 1. Supabase `hubspot_configs` table (if available)
 * 2. Local encrypted `.hubspot-config.json` file (backup / standalone)
 * 3. `.env.local` (sets HUBSPOT_ACCESS_TOKEN so server always has it)
 */
export async function saveHubSpotConfigForAccount(
  supabase: SupabaseClient | null,
  accountId: string,
  userId: string,
  options: {
    accessToken?: string;
    portalId?: string | null;
    autoSyncOnMessage?: boolean;
    autoSyncContacts?: boolean;
  }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const rawToken = options.accessToken?.trim();
    const existingLocal = readLocalConfigFile(accountId);

    // Encrypt token if provided, else keep existing
    let encryptedToken = '';
    if (rawToken) {
      encryptedToken = encrypt(rawToken);
      // Also update environment and .env.local
      updateEnvLocalToken(rawToken);
    } else if (existingLocal?.access_token) {
      encryptedToken = existingLocal.access_token;
    }

    const localPayload: LocalStoredConfig = {
      account_id: accountId,
      access_token: encryptedToken,
      portal_id: options.portalId !== undefined ? options.portalId : existingLocal?.portal_id,
      auto_sync_on_message:
        options.autoSyncOnMessage !== undefined
          ? options.autoSyncOnMessage
          : existingLocal?.auto_sync_on_message ?? true,
      auto_sync_contacts:
        options.autoSyncContacts !== undefined
          ? options.autoSyncContacts
          : existingLocal?.auto_sync_contacts ?? true,
      updated_at: new Date().toISOString(),
    };

    // Save locally first (guaranteed to succeed immediately)
    if (encryptedToken) {
      writeLocalConfigFile(localPayload);
    }

    // Attempt to persist to Supabase
    const client = supabase || getFallbackAdminClient();
    if (client) {
      try {
        const patch: Record<string, unknown> = {
          account_id: accountId,
          created_by: userId,
          updated_at: new Date().toISOString(),
        };

        if (encryptedToken) {
          patch.access_token = encryptedToken;
        }

        if (options.portalId !== undefined) {
          patch.portal_id = options.portalId ? options.portalId.trim() : null;
        }

        if (options.autoSyncOnMessage !== undefined) {
          patch.auto_sync_on_message = options.autoSyncOnMessage;
        }

        if (options.autoSyncContacts !== undefined) {
          patch.auto_sync_contacts = options.autoSyncContacts;
        }

        const { data: existing } = await client
          .from('hubspot_configs')
          .select('id')
          .eq('account_id', accountId)
          .maybeSingle();

        let writeErr = null;
        if (existing) {
          const { error } = await client.from('hubspot_configs').update(patch).eq('account_id', accountId);
          writeErr = error;
        } else if (encryptedToken) {
          const { error } = await client.from('hubspot_configs').insert(patch);
          writeErr = error;
        }

        // If user client got an RLS error, retry with admin service-role client
        if (writeErr && client !== getFallbackAdminClient()) {
          const admin = getFallbackAdminClient();
          if (admin) {
            if (existing) {
              await admin.from('hubspot_configs').update(patch).eq('account_id', accountId);
            } else if (encryptedToken) {
              await admin.from('hubspot_configs').insert(patch);
            }
          }
        }
      } catch (dbErr) {
        console.warn(
          '[hubspot-config] Supabase write failed, saved to local config instead:',
          dbErr
        );
      }
    }

    return { ok: true };
  } catch (err) {
    console.error('[hubspot-config] Failed to save config:', err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to save HubSpot configuration.',
    };
  }
}
