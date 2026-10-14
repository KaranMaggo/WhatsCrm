import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  getHubSpotSyncLogs,
  clearHubSpotSyncLogs,
} from '@/lib/integrations/hubspot-logs';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const logs = await getHubSpotSyncLogs(supabase, accountId);

    return NextResponse.json({ logs });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    await clearHubSpotSyncLogs(supabase, accountId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
