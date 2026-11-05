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
  formatWhatsAppMediaNote,
  formatHubSpotContactFolderPath,
  getHubSpotContactDeals,
  uploadFileToHubSpot,
  createHubSpotMediaNote,
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

    it('creates media note attached to contacts and deals when client shares an image', async () => {
      const insertedNotes: any[] = [];
      const updatedDeals: any[] = [];
      const updatedMessages: any[] = [];

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'conversations') {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: {
                      id: 'conv-2',
                      user_id: 'u-1',
                      contact_id: 'cont-2',
                      created_at: '2026-10-26T12:00:00Z',
                      hubspot_started_synced: true,
                      hubspot_contact_id: 'hs-cont-456',
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'contacts') {
            return {
              select: () => ({
                eq: () => ({
                  single: async () => ({
                    data: {
                      id: 'cont-2',
                      user_id: 'u-1',
                      name: 'Marcus Aurelius',
                      email: 'marcus@example.com',
                      phone: '+15559876543',
                      company: 'Rome',
                      hubspot_contact_id: 'hs-cont-456',
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'accounts') {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { name: 'Cosmedic Express' },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'deals') {
            return {
              select: () => ({
                eq: async () => ({
                  data: [
                    {
                      id: 'deal-1',
                      hubspot_deal_id: 'hs-deal-789',
                      notes: 'Initial deal notes',
                    },
                  ],
                  error: null,
                }),
              }),
              update: (patch: any) => ({
                eq: async (col: string, val: string) => {
                  updatedDeals.push({ ...patch, [col]: val });
                  return { data: null, error: null };
                },
              }),
            };
          }
          if (table === 'contact_notes') {
            return {
              insert: async (note: any) => {
                insertedNotes.push(note);
                return { data: null, error: null };
              },
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
                          id: 'msg-img-1',
                          sender_type: 'customer',
                          content_type: 'image',
                          content_text: 'Damage inspection photo',
                          media_url: 'https://example.com/photo.jpg',
                          media_type: 'image/jpeg',
                          created_at: '2026-10-26T12:05:00Z',
                          hubspot_communication_id: null,
                          hubspot_note_id: null,
                        },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
              update: (patch: any) => ({
                eq: async (col: string, val: string) => {
                  updatedMessages.push({ ...patch, [col]: val });
                  return { data: null, error: null };
                },
              }),
            };
          }
          return {
            insert: () => Promise.resolve({ data: null, error: null }),
          };
        }),
      } as unknown as any;

      const fetchCalls: { url: string; body?: any }[] = [];
      global.fetch = vi.fn().mockImplementation((url: string, init?: any) => {
        let body = null;
        if (init?.body && typeof init.body === 'string') {
          try {
            body = JSON.parse(init.body);
          } catch {
            body = init.body;
          }
        }
        fetchCalls.push({ url, body });

        if (url.includes('/associations/deals')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              results: [{ toObjectId: 'hs-deal-999' }],
            }),
          });
        }
        if (url.includes('/files/v3/files')) {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: async () => ({ id: 'hs-file-888', url: 'https://api.hubapi.com/files/888' }),
          });
        }
        if (url.includes('/crm/v3/objects/notes')) {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: async () => ({ id: 'note-media-100' }),
          });
        }
        if (url.includes('/crm/v3/objects/communications')) {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: async () => ({ id: 'comm-img-1' }),
          });
        }
        if (url.includes('photo.jpg')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'image/jpeg' }),
            arrayBuffer: async () => new ArrayBuffer(8),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      });

      const res = await syncConversationChatToHubSpot({
        supabase: mockSupabase,
        accountId: 'acc-1',
        conversationId: 'conv-2',
        token: 'test-token',
      });

      expect(res.ok).toBe(true);
      expect(res.mediaNotesCreatedCount).toBe(1);

      // Verify Note API was called with both Contact and Deal associations
      const noteCall = fetchCalls.find((c) => c.url.includes('/crm/v3/objects/notes'));
      expect(noteCall).toBeDefined();
      expect(noteCall?.body.properties.hs_note_body).toContain('Images shared on WhatsApp');
      expect(noteCall?.body.properties.hs_note_body).toContain('Damage inspection photo');
      expect(noteCall?.body.properties.hs_attachment_ids).toBe('hs-file-888');

      // Contact association (202)
      expect(noteCall?.body.associations).toContainEqual(
        expect.objectContaining({
          to: { id: 'hs-cont-456' },
          types: expect.arrayContaining([
            expect.objectContaining({ associationTypeId: 202 }),
          ]),
        })
      );

      // Deal associations (214) from HubSpot (hs-deal-999) and local (hs-deal-789)
      expect(noteCall?.body.associations).toContainEqual(
        expect.objectContaining({
          to: { id: 'hs-deal-999' },
          types: expect.arrayContaining([
            expect.objectContaining({ associationTypeId: 214 }),
          ]),
        })
      );
      expect(noteCall?.body.associations).toContainEqual(
        expect.objectContaining({
          to: { id: 'hs-deal-789' },
          types: expect.arrayContaining([
            expect.objectContaining({ associationTypeId: 214 }),
          ]),
        })
      );

      // Local contact_notes and deals are left clean for manual staff notes
      expect(insertedNotes).toHaveLength(0);
      expect(updatedDeals).toHaveLength(0);

      // Verify message row updated with hubspot_note_id
      expect(updatedMessages).toContainEqual(
        expect.objectContaining({
          id: 'msg-img-1',
          hubspot_note_id: 'note-media-100',
        })
      );
    });
  });

  describe('formatWhatsAppMediaNote', () => {
    it('formats image note without caption', () => {
      const res = formatWhatsAppMediaNote('image', null, 'https://cdn.example.com/img.jpg');
      expect(res.title).toBe('Images shared on WhatsApp');
      expect(res.htmlBody).toContain('Images shared on WhatsApp');
      expect(res.htmlBody).toContain('https://cdn.example.com/img.jpg');
      expect(res.plainText).toContain('Images shared on WhatsApp');
    });

    it('formats image note with caption', () => {
      const res = formatWhatsAppMediaNote('image', 'Prescription details', 'https://cdn.example.com/rx.jpg');
      expect(res.title).toBe('Images shared on WhatsApp');
      expect(res.htmlBody).toContain('Prescription details');
      expect(res.plainText).toContain('Caption: Prescription details');
    });

    it('formats video note with custom title and filename', () => {
      const res = formatWhatsAppMediaNote('video', 'Clinic walkthrough', 'https://cdn.example.com/walkthrough.mp4', 'clinic.mp4');
      expect(res.title).toBe('Videos shared on WhatsApp');
      expect(res.htmlBody).toContain('Videos shared on WhatsApp');
      expect(res.htmlBody).toContain('clinic.mp4');
      expect(res.plainText).toContain('Videos shared on WhatsApp');
    });
  });

  describe('getHubSpotContactDeals', () => {
    it('returns deal IDs from v4 associations endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ toObjectId: '101' }, { toObjectId: '202' }],
        }),
      });

      const deals = await getHubSpotContactDeals('token', 'cont-1');
      expect(deals).toEqual(['101', '202']);
    });

    it('falls back to v3 associations parameter when v4 fails', async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/crm/v4/')) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            associations: {
              deals: {
                results: [{ id: '303' }],
              },
            },
          }),
        });
      });

      const deals = await getHubSpotContactDeals('token', 'cont-1');
      expect(deals).toEqual(['303']);
    });
  });

  describe('formatHubSpotContactFolderPath', () => {
    it('formats /WhatsApp Media/<Contact Name> cleanly', () => {
      expect(formatHubSpotContactFolderPath('Karan Maggo')).toBe('/WhatsApp Media/Karan Maggo');
    });

    it('sanitizes illegal path characters from contact name', () => {
      expect(formatHubSpotContactFolderPath('John: Doe / VIP?')).toBe('/WhatsApp Media/John_ Doe _ VIP_');
    });

    it('falls back to phone number when name is empty', () => {
      expect(formatHubSpotContactFolderPath('', '+91 94780-52194')).toBe('/WhatsApp Media/919478052194');
    });

    it('falls back to contactId when name and phone are empty', () => {
      expect(formatHubSpotContactFolderPath('', '', 'contact-uuid-1')).toBe('/WhatsApp Media/contact-contact-uuid-1');
    });

    it('falls back to base folder when all are empty', () => {
      expect(formatHubSpotContactFolderPath('', '', '')).toBe('/WhatsApp Media');
    });
  });

  describe('createHubSpotMediaNote', () => {
    it('creates note with contact (202) and deal (214) associations and file attachment', async () => {
      let requestBody: any = null;
      global.fetch = vi.fn().mockImplementation((_url: string, init: any) => {
        requestBody = JSON.parse(init.body);
        return Promise.resolve({
          status: 201,
          json: async () => ({ id: 'new-note-id' }),
        });
      });

      const res = await createHubSpotMediaNote('token', {
        hubspotContactId: 'c-100',
        dealIds: ['d-200', 'd-300'],
        noteBody: '<p>Images shared on WhatsApp</p>',
        fileId: 'file-999',
      });

      expect(res).toEqual({ id: 'new-note-id' });
      expect(requestBody.properties.hs_attachment_ids).toBe('file-999');
      expect(requestBody.properties.hs_note_body).toBe('<p>Images shared on WhatsApp</p>');
      expect(requestBody.associations).toEqual([
        {
          to: { id: 'c-100' },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        },
        {
          to: { id: 'd-200' },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }],
        },
        {
          to: { id: 'd-300' },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }],
        },
      ]);
    });
  });
});
