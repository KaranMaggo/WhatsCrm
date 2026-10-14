import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  getHubSpotConfigForAccount,
  saveHubSpotConfigForAccount,
} from '@/lib/integrations/hubspot-config';
import { syncContactToHubSpot } from '@/lib/integrations/hubspot';
import { recordHubSpotSyncLog } from '@/lib/integrations/hubspot-logs';

export async function POST(request: Request) {
  let accountIdForLog = '';
  let contactIdForLog: string | null = null;
  let nameForLog: string | null = null;
  let emailForLog: string | null = null;
  let phoneForLog: string | null = null;
  let sourceForLog: 'manual' | 'api' | 'contact_form' | 'test' = 'manual';

  try {
    const { supabase, accountId, userId } = await getCurrentAccount();
    accountIdForLog = accountId;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a JSON object.' },
        { status: 400 }
      );
    }

    const providedToken =
      typeof body.access_token === 'string' && body.access_token.trim()
        ? body.access_token.trim()
        : null;

    const config = await getHubSpotConfigForAccount(supabase, accountId);
    const tokenToUse = config.token || providedToken;

    if (!tokenToUse) {
      return NextResponse.json(
        {
          error:
            'HubSpot integration is not configured. Please paste your Private App token and click "Save Settings" under Settings → HubSpot, or configure HUBSPOT_ACCESS_TOKEN in .env.local.',
        },
        { status: 400 }
      );
    }

    // If caller provided token and it's not yet saved, save it now
    if (providedToken && !config.token) {
      saveHubSpotConfigForAccount(supabase, accountId, userId, {
        accessToken: providedToken,
      }).catch((e) => console.warn('[hubspot/sync] Auto-saving provided token failed:', e));
    }

    if (
      body.source === 'api' ||
      body.source === 'manual' ||
      body.source === 'contact_form' ||
      body.source === 'test'
    ) {
      sourceForLog = body.source;
    } else if (!body.contactId) {
      sourceForLog = 'api';
    }

    let email = typeof body.email === 'string' ? body.email.trim() : null;
    let name = typeof body.name === 'string' ? body.name.trim() : null;
    let phone = typeof body.phone === 'string' ? body.phone.trim() : null;
    let company = typeof body.company === 'string' ? body.company.trim() : null;

    if (body.contactId && typeof body.contactId === 'string') {
      contactIdForLog = body.contactId;
      const { data: contact, error: contactErr } = await supabase
        .from('contacts')
        .select('*')
        .eq('id', body.contactId)
        .eq('account_id', accountId)
        .single();

      if (contactErr || !contact) {
        return NextResponse.json({ error: 'Contact not found.' }, { status: 404 });
      }

      email = email || contact.email || null;
      name = name || contact.name || null;
      phone = phone || contact.phone || null;
      company = company || contact.company || null;
    }

    nameForLog = name;
    emailForLog = email;
    phoneForLog = phone;

    if (!email && !phone) {
      return NextResponse.json(
        { error: 'Contact must have an email or phone number to sync with HubSpot.' },
        { status: 400 }
      );
    }

    const result = await syncContactToHubSpot(tokenToUse, {
      email,
      name,
      phone,
      company,
    });

    // Record successful sync log
    await recordHubSpotSyncLog(supabase, {
      account_id: accountId,
      contact_id: contactIdForLog,
      contact_name: nameForLog,
      email: emailForLog,
      phone: phoneForLog,
      action: result.action,
      hubspot_contact_id: result.hubspotContactId,
      status: 'success',
      source: sourceForLog,
    });

    return NextResponse.json({
      ok: true,
      action: result.action,
      hubspotContactId: result.hubspotContactId,
      email: result.email,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'HubSpot contact sync failed.';

    if (accountIdForLog) {
      await recordHubSpotSyncLog(null, {
        account_id: accountIdForLog,
        contact_id: contactIdForLog,
        contact_name: nameForLog,
        email: emailForLog,
        phone: phoneForLog,
        action: 'failed',
        status: 'error',
        error_message: message,
        source: sourceForLog,
      }).catch(() => {});
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
