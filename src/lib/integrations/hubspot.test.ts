import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  splitFullName,
  testHubSpotConnection,
  findHubSpotContactByEmail,
  findHubSpotContactByPhone,
  createHubSpotContact,
  updateHubSpotContact,
  syncContactToHubSpot,
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

    it('checks email first: if email does NOT exist, creates the contact in HubSpot', async () => {
      // 1. GET by email -> returns 404 (not found)
      // 2. POST -> returns 201 (created contact)
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: async () => ({ status: 'error', category: 'OBJECT_NOT_FOUND' }),
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
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('throws error when contact has neither email nor phone', async () => {
      await expect(
        syncContactToHubSpot('token', {
          name: 'No Contact Info',
        })
      ).rejects.toThrow('Contact must have an email or phone number');
    });
  });
});
