import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/tags
 *
 * Lists all tags for the authenticated user's account.
 * Used by flow builder (tag condition and set_tag nodes), contacts, etc.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('tags')
      .select('id, name, color')
      .eq('account_id', accountId)
      .order('name', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ tags: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
