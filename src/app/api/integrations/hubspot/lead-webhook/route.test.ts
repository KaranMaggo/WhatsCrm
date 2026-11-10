import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, GET } from './route';

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: vi.fn(),
}));

vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(),
}));

import { supabaseAdmin } from '@/lib/supabase/admin';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';

describe('HubSpot Lead Webhook Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET returns status ok and description', async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.target_path).toBe('/api/integrations/hubspot/lead-webhook');
  });

  it('handles standard HubSpot properties payload structure', async () => {
    const mockDb = {
      from: vi.fn((table: string) => {
        if (table === 'hubspot_configs') {
          return {
            select: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { account_id: 'acc-123' },
            }),
          };
        }
        if (table === 'contacts') {
          return {
            update: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        if (table === 'messages') {
          return {
            insert: vi.fn().mockReturnThis(),
            select: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { id: 'msg-abc' },
              error: null,
            }),
          };
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { unread_count: 0 } }),
            update: vi.fn().mockReturnThis(),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    };

    vi.mocked(supabaseAdmin).mockReturnValue(mockDb as unknown as ReturnType<typeof supabaseAdmin>);
    vi.mocked(resolveConversationByPhone).mockResolvedValue({
      conversationId: 'conv-456',
      contactId: 'contact-789',
      contactCreated: true,
    });

    const hubspotPayload = {
      portalId: 12345,
      object: {
        objectId: 99999,
        objectType: 'CONTACT',
      },
      properties: {
        firstname: { value: 'Tanjie' },
        lastname: { value: 'Baker' },
        phone: { value: '+447872029082' },
        email: { value: 'tanjiebaker@gmail.com' },
        city: { value: 'Middlesbrough' },
        which_procedure_are_you_interested_in_: { value: 'Other' },
        what_is_your_main_goal_: { value: 'Enhance appearance' },
        when_are_you_planning_the_procedure_: { value: '3–6 months' },
      },
    };

    const req = new Request('https://example.com/api/integrations/hubspot/lead-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hubspotPayload),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.contact_id).toBe('contact-789');
    expect(json.data.conversation_id).toBe('conv-456');
    expect(json.data.phone).toBe('+447872029082');
    expect(json.data.name).toBe('Tanjie Baker');

    // Verify resolveConversationByPhone was called with parsed name & phone
    expect(resolveConversationByPhone).toHaveBeenCalledWith(
      mockDb,
      'acc-123',
      '+447872029082',
      'Tanjie Baker'
    );
  });

  it('rejects payload missing a phone number', async () => {
    const mockDb = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { account_id: 'acc-123' },
        }),
      })),
    };
    vi.mocked(supabaseAdmin).mockReturnValue(mockDb as unknown as ReturnType<typeof supabaseAdmin>);

    const req = new Request('https://example.com/api/integrations/hubspot/lead-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstname: 'John' }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('No valid phone number found');
  });
});

