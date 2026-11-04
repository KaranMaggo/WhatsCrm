import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  splitFullName,
  testHubSpotConnection,
  findHubSpotContactByEmail,
  findHubSpotContactByPhone,
  getPhoneSearchCandidates,
  createHubSpotContact,
  updateHubSpotContact,
  syncContactToHubSpot,
  getHubSpotChatDeepLink,
  formatWhatsAppMessageForHubSpot,
  createHubSpotNote,
  logHubSpotWhatsAppMessage,
  syncConversationChatToHubSpot,
} from './hubspot';

describe('HubSpot Integration Client', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('splitFullName', () => {
    it('handles empty or whitespace strings', () => {
      expect(splitFullName(null)).toEqual({});
      expect(splitFullName(undefined)).toEqual({});
      expect(splitFullName('')).toEqual({});
      expect(splitFullName('   ')).toEqual({});
    });

    it('splits single word name into firstName', () => {
      expect(splitFullName('Alice')).toEqual({ firstName: 'Alice' });
    });

    it('splits two word name into firstName and lastName', () => {
      expect(splitFullName('John Doe')).toEqual({
        firstName: 'John',
        lastName: 'Doe',
      });
    });

    it('handles multi-token names correctly', () => {
      expect(splitFullName('Mary Jane Watson')).toEqual({
        firstName: 'Mary',
        lastName: 'Jane Watson',
      });
    });
  });

  describe('testHubSpotConnection', () => {
    it('fails when token is empty', async () => {
      const res = await testHubSpotConnection('');
      expect(res.ok).toBe(false);
      expect(res.error).toContain('missing');
    });

    it('returns ok: true when HubSpot returns 200', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      } as unknown as Response);

      const res = await testHubSpotConnection('pat-valid-token');
      expect(res.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.hubapi.com/crm/v3/objects/contacts?limit=1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer pat-valid-token',
          }),
        })
      );
    });

    it('returns friendly error on 401/403 unauthorized', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ message: 'Invalid token' }),
      } as unknown as Response);

      const res = await testHubSpotConnection('pat-bad-token');
      expect(res.ok).toBe(false);
      expect(res.error).toContain('crm.objects.contacts');
    });
  });

  describe('findHubSpotContactByEmail', () => {
    it('returns contact when found by email (200 OK)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: '12345',
          properties: {
            email: 'john@example.com',
            firstname: 'John',
            lastname: 'Doe',
          },
        }),
      } as unknown as Response);

      const contact = await findHubSpotContactByEmail('token', 'john@example.com');
      expect(contact).not.toBeNull();
      expect(contact?.id).toBe('12345');
      expect(contact?.properties.email).toBe('john@example.com');
    });

    it('returns null when contact is not found (404 Not Found)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ status: 'error', category: 'OBJECT_NOT_FOUND' }),
      } as unknown as Response);

      const contact = await findHubSpotContactByEmail('token', 'notfound@example.com');
      expect(contact).toBeNull();
    });
  });

  describe('createHubSpotContact', () => {
    it('creates a new contact in HubSpot with proper properties', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          id: '999',
          properties: {
            email: 'new@example.com',
            firstname: 'Jane',
            lastname: 'Smith',
            phone: '+15551234567',
            company: 'Acme Corp',
          },
        }),
      } as unknown as Response);

      const created = await createHubSpotContact('token', {
        email: 'new@example.com',
        name: 'Jane Smith',
        phone: '+15551234567',
        company: 'Acme Corp',
      });

      expect(created.id).toBe('999');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.hubapi.com/crm/v3/objects/contacts',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            properties: {
              email: 'new@example.com',
              firstname: 'Jane',
              lastname: 'Smith',
              phone: '+15551234567',
              company: 'Acme Corp',
            },
          }),
        })
      );
    });
  });

  describe('updateHubSpotContact', () => {
    it('updates contact properties by numeric ID', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: '12345',
          properties: {
            firstname: 'UpdatedName',
            phone: '+19998887777',
          },
        }),
      } as unknown as Response);

      const updated = await updateHubSpotContact('token', '12345', {
        name: 'UpdatedName',
        phone: '+19998887777',
      });

      expect(updated.id).toBe('12345');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.hubapi.com/crm/v3/objects/contacts/12345',
        expect.objectContaining({
          method: 'PATCH',
        })
      );
    });

    it('updates contact properties by email using ?idProperty=email', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: '12345',
          properties: {
            firstname: 'UpdatedName',
          },
        }),
      } as unknown as Response);

      const updated = await updateHubSpotContact('token', 'john@example.com', {
        name: 'UpdatedName',
      });

      expect(updated.id).toBe('12345');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.hubapi.com/crm/v3/objects/contacts/john%40example.com?idProperty=email',
        expect.objectContaining({
          method: 'PATCH',
        })
      );
    });
  });

  describe('syncContactToHubSpot — Check Email First logic', () => {
    it('checks email first: if email exists, updates the contact in HubSpot', async () => {
      // 1. GET by email -> returns 200 (existing contact)
      // 2. PATCH -> returns 200 (updated contact)
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'existing-hs-id-101',
            properties: {
              email: 'lead@example.com',
              firstname: 'OldFirst',
            },
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'existing-hs-id-101',
            properties: {
              email: 'lead@example.com',
              firstname: 'NewFirst',
              phone: '+15553334444',
            },
          }),
        } as unknown as Response);

      const result = await syncContactToHubSpot('token', {
        email: 'lead@example.com',
        name: 'NewFirst Name',
        phone: '+15553334444',
      });

      expect(result.action).toBe('updated');
      expect(result.hubspotContactId).toBe('existing-hs-id-101');
      expect(result.email).toBe('lead@example.com');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('checks email first: if email does NOT exist and phone does not exist, creates the contact in HubSpot', async () => {
      // 1. GET by email -> returns 404 (not found)
      // 2. POST search by phone -> returns 200 (total: 0)
      // 3. POST create contact -> returns 201 (created contact)
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: async () => ({ status: 'error', category: 'OBJECT_NOT_FOUND' }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ total: 0, results: [] }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            id: 'new-hs-id-202',
            properties: {
              email: 'brandnew@example.com',
              firstname: 'Brand',
              lastname: 'New',
            },
          }),
        } as unknown as Response);

      const result = await syncContactToHubSpot('token', {
        email: 'brandnew@example.com',
        name: 'Brand New',
        phone: '+15558889999',
      });

      expect(result.action).toBe('created');
      expect(result.hubspotContactId).toBe('new-hs-id-202');
      expect(result.email).toBe('brandnew@example.com');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('checks phone when email does not exist: updates existing contact matched by phone number', async () => {
      // 1. GET by email -> returns 404 (not found)
      // 2. POST search by phone -> returns 200 with existing contact
      // 3. PATCH update contact -> returns 200
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: async () => ({ status: 'error', category: 'OBJECT_NOT_FOUND' }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            total: 1,
            results: [
              {
                id: 'existing-phone-contact-55',
                properties: {
                  phone: '+15558889999',
                  firstname: 'Existing',
                },
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'existing-phone-contact-55',
            properties: {
              email: 'brandnew@example.com',
              phone: '+15558889999',
              firstname: 'Brand',
              lastname: 'New',
            },
          }),
        } as unknown as Response);

      const result = await syncContactToHubSpot('token', {
        email: 'brandnew@example.com',
        name: 'Brand New',
        phone: '+15558889999',
      });

      expect(result.action).toBe('updated');
      expect(result.hubspotContactId).toBe('existing-phone-contact-55');
      expect(result.email).toBe('brandnew@example.com');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('checks phone when only phone is provided: updates existing contact matched by phone', async () => {
      // 1. POST search by phone -> returns 200 with existing contact
      // 2. PATCH update contact -> returns 200
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            total: 1,
            results: [
              {
                id: 'existing-phone-contact-66',
                properties: {
                  phone: '+15557778888',
                },
              },
            ],
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'existing-phone-contact-66',
            properties: {
              phone: '+15557778888',
              firstname: 'Phone',
              lastname: 'Only',
            },
          }),
        } as unknown as Response);

      const result = await syncContactToHubSpot('token', {
        name: 'Phone Only',
        phone: '+15557778888',
      });

      expect(result.action).toBe('updated');
      expect(result.hubspotContactId).toBe('existing-phone-contact-66');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('checks phone when only phone is provided: creates new contact if phone not found', async () => {
      // 1. POST search by phone -> returns 200 (total: 0)
      // 2. POST create contact -> returns 201
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ total: 0, results: [] }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            id: 'new-phone-contact-77',
            properties: {
              phone: '+15559990000',
              firstname: 'Phone',
              lastname: 'User',
            },
          }),
        } as unknown as Response);

      const result = await syncContactToHubSpot('token', {
        name: 'Phone User',
        phone: '+15559990000',
      });

      expect(result.action).toBe('created');
      expect(result.hubspotContactId).toBe('new-phone-contact-77');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('updates directly when hubspotContactId is provided', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'existing-cached-88',
          properties: {
            firstname: 'Cached',
          },
        }),
      } as unknown as Response);

      const result = await syncContactToHubSpot('token', {
        hubspotContactId: 'existing-cached-88',
        name: 'Cached Contact',
        phone: '+15551112222',
      });

      expect(result.action).toBe('updated');
      expect(result.hubspotContactId).toBe('existing-cached-88');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('throws error when contact has neither email nor phone', async () => {
      await expect(
        syncContactToHubSpot('token', {
          name: 'No Contact Info',
        })
      ).rejects.toThrow('Contact must have an email or phone number');
    });
  });

  describe('getPhoneSearchCandidates', () => {
    it('generates candidates with and without leading +', () => {
      const candidates = getPhoneSearchCandidates('+15551234567');
      expect(candidates).toContain('+15551234567');
      expect(candidates).toContain('15551234567');
    });

    it('generates candidates for numbers without leading +', () => {
      const candidates = getPhoneSearchCandidates('15551234567');
      expect(candidates).toContain('15551234567');
      expect(candidates).toContain('+15551234567');
    });

    it('generates stripped digits for formatted numbers', () => {
      const candidates = getPhoneSearchCandidates('+1 (555) 123-4567');
      expect(candidates).toContain('+1 (555) 123-4567');
      expect(candidates).toContain('15551234567');
      expect(candidates).toContain('+15551234567');
    });

    it('returns empty array for empty or whitespace input', () => {
      expect(getPhoneSearchCandidates('')).toEqual([]);
      expect(getPhoneSearchCandidates('   ')).toEqual([]);
    });
  });

  describe('findHubSpotContactByPhone', () => {
    it('finds contact by phone via Search API with IN operator', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          total: 1,
          results: [
            {
              id: 'hs-phone-found-1',
              properties: {
                phone: '+15551234567',
                firstname: 'Alice',
              },
            },
          ],
        }),
      } as unknown as Response);

      const found = await findHubSpotContactByPhone('token', '+15551234567');
      expect(found).not.toBeNull();
      expect(found?.id).toBe('hs-phone-found-1');
      expect(found?.properties.phone).toBe('+15551234567');
    });

    it('returns null when contact is not found by phone', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          total: 0,
          results: [],
        }),
      } as unknown as Response);

      const found = await findHubSpotContactByPhone('token', '+15550000000');
      expect(found).toBeNull();
    });
  });

  describe('getHubSpotChatDeepLink', () => {
    it('generates the default deep-link format matching https://whats-crm-three.vercel.app/chat?conversation_id=...', () => {
      const link = getHubSpotChatDeepLink('conv-1234-uuid');
      expect(link).toBe('https://whats-crm-three.vercel.app/chat?conversation_id=conv-1234-uuid');
    });
  });

  describe('formatWhatsAppMessageForHubSpot', () => {
    it('formats customer inbound message with customer name', () => {
      const formatted = formatWhatsAppMessageForHubSpot(
        'customer',
        'Hello, which area can you treat?',
        'text',
        'Cosmedic Express',
        'Claire Hunter'
      );
      expect(formatted).toBe('Claire Hunter: Hello, which area can you treat?');
    });

    it('formats agent outbound message with business name', () => {
      const formatted = formatWhatsAppMessageForHubSpot(
        'agent',
        'Hi Claire, we are the ONLY British and American-owned clinic abroad...',
        'text',
        'Cosmedic Express',
        'Claire Hunter'
      );
      expect(formatted).toBe('Cosmedic Express: Hi Claire, we are the ONLY British and American-owned clinic abroad...');
    });

    it('does not duplicate prefix if already present', () => {
      const formatted = formatWhatsAppMessageForHubSpot(
        'agent',
        'Cosmedic Express: Special offer',
        'text',
        'Cosmedic Express',
        'Claire Hunter'
      );
      expect(formatted).toBe('Cosmedic Express: Special offer');
    });

    it('handles media attachments with fallback placeholders', () => {
      const formatted = formatWhatsAppMessageForHubSpot(
        'customer',
        '',
        'image',
        'Cosmedic Express',
        'Claire Hunter'
      );
      expect(formatted).toBe('Claire Hunter: [Image]');
    });
  });

  describe('createHubSpotNote', () => {
    it('posts to /crm/v3/objects/notes with note association 202', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 201,
        json: async () => ({ id: 'note-101' }),
      });

      const res = await createHubSpotNote('token', 'contact-999', 'WhatsApp conversation started\nhttps://whats-crm-three.vercel.app/chat?conversation_id=abc');
      expect(res).toEqual({ id: 'note-101' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.hubapi.com/crm/v3/objects/notes',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('WhatsApp conversation started'),
        })
      );
    });
  });

  describe('logHubSpotWhatsAppMessage', () => {
    it('posts to /crm/v3/objects/communications with WHATS_APP channel and association 81', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 201,
        json: async () => ({ id: 'comm-202' }),
      });

      const res = await logHubSpotWhatsAppMessage('token', 'contact-999', {
        body: 'Cosmedic Express: Hello Claire',
      });
      expect(res).toEqual({ id: 'comm-202' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.hubapi.com/crm/v3/objects/communications',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('WHATS_APP'),
        })
      );
    });
  });

  describe('syncConversationChatToHubSpot', () => {
    it('creates start note and logs unsynced messages', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'conversations') {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: {
                      id: 'conv-1',
                      contact_id: 'cont-1',
                      created_at: '2026-10-26T12:00:00Z',
                      hubspot_started_synced: false,
                      hubspot_contact_id: 'hs-cont-123',
                    },
                    error: null,
                  }),
                }),
              }),
              update: () => ({
                eq: () => Promise.resolve({ data: null, error: null }),
              }),
            };
          }
          if (table === 'contacts') {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: {
                      id: 'cont-1',
                      name: 'Claire Hunter',
                      email: 'claire@example.com',
                      phone: '+447000000000',
                      company: 'Clinic UK',
                      hubspot_contact_id: 'hs-cont-123',
                    },
                    error: null,
                  }),
                }),
              }),
              update: () => ({
                eq: () => Promise.resolve({ data: null, error: null }),
              }),
            };
          }
          if (table === 'accounts') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { name: 'Cosmedic Express' },
                  }),
                }),
              }),
            };
          }
          if (table === 'messages') {
            return {
              select: () => ({
                eq: () => ({
                  is: () => ({
                    order: async () => ({
                      data: [
                        {
                          id: 'msg-1',
                          sender_type: 'agent',
                          content_type: 'text',
                          content_text: 'Hi Claire, welcome!',
                          created_at: '2026-10-26T12:01:00Z',
                          hubspot_communication_id: null,
                        },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
              update: () => ({
                eq: () => Promise.resolve({ data: null, error: null }),
              }),
            };
          }
          return {
            insert: () => Promise.resolve({ data: null, error: null }),
          };
        }),
      } as unknown as any;

      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/notes')) {
          return Promise.resolve({
            status: 201,
            json: async () => ({ id: 'note-hs-1' }),
          });
        }
        if (url.includes('/communications')) {
          return Promise.resolve({
            status: 201,
            json: async () => ({ id: 'comm-hs-1' }),
          });
        }
        return Promise.resolve({ status: 200, json: async () => ({}) });
      });

      const res = await syncConversationChatToHubSpot({
        supabase: mockSupabase,
        accountId: 'acc-1',
        conversationId: 'conv-1',
        token: 'test-token',
      });

      expect(res.ok).toBe(true);
      expect(res.noteCreated).toBe(true);
      expect(res.messagesSyncedCount).toBe(1);
      expect(res.hubspotContactId).toBe('hs-cont-123');
    });
  });
});
