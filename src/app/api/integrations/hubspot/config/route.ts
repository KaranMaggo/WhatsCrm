import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  getHubSpotConfigForAccount,
  saveHubSpotConfigForAccount,
} from '@/lib/integrations/hubspot-config';
import { testHubSpotConnection } from '@/lib/integrations/hubspot';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const config = await getHubSpotConfigForAccount(supabase, accountId);

    return NextResponse.json({
      configured: config.configured,
      has_token: !!config.token,
      portal_id: config.portalId ?? null,
      auto_sync_on_message: config.autoSyncOnMessage,
      auto_sync_contacts: config.autoSyncContacts,
      is_env: config.isEnv,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : undefined;
    const portalId = typeof body.portal_id === 'string' ? body.portal_id.trim() : undefined;
    const autoSyncOnMessage =
      typeof body.auto_sync_on_message === 'boolean' ? body.auto_sync_on_message : undefined;
    const autoSyncContacts =
      typeof body.auto_sync_contacts === 'boolean' ? body.auto_sync_contacts : undefined;

    // If a new access token is supplied, verify it first before persisting
    if (accessToken) {
      const testResult = await testHubSpotConnection(accessToken);
      if (!testResult.ok) {
        return NextResponse.json(
          { error: testResult.error || 'HubSpot connection test failed with this token.' },
          { status: 400 }
        );
      }
    }

    const saveResult = await saveHubSpotConfigForAccount(supabase, accountId, userId, {
      accessToken,
      portalId,
      autoSyncOnMessage,
      autoSyncContacts,
    });

    if (!saveResult.ok) {
      return NextResponse.json(
        { error: saveResult.error || 'Failed to save HubSpot configuration.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, message: 'HubSpot configuration saved successfully.' });
  } catch (err) {
    return toErrorResponse(err);
  }
}
