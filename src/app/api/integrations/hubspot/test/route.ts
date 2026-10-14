import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { getHubSpotConfigForAccount } from '@/lib/integrations/hubspot-config';
import { testHubSpotConnection } from '@/lib/integrations/hubspot';

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const body = await request.json().catch(() => null);
    const providedToken =
      typeof body?.access_token === 'string' && body.access_token.trim()
        ? body.access_token.trim()
        : null;

    let tokenToTest = providedToken;

    if (!tokenToTest) {
      const config = await getHubSpotConfigForAccount(supabase, accountId);
      tokenToTest = config.token;
    }

    if (!tokenToTest) {
      return NextResponse.json(
        { ok: false, error: 'No HubSpot access token configured or provided.' },
        { status: 400 }
      );
    }

    const result = await testHubSpotConnection(tokenToTest);
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
