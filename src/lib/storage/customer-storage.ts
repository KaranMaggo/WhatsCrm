import { MIRROR_BUCKET, type MirrorStorage } from "@/lib/whatsapp/mirror-inbound-media";
import { buildCustomerSubfolder } from "./upload-media";

export interface CustomerDetails {
  id: string;
  account_id: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  avatar_url?: string | null;
  wa_user_id?: string | null;
  tags?: string[] | null;
  hubspot_contact_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  synced_at?: string;
  [key: string]: unknown;
}

/**
 * Syncs contact/customer details as customer_details.json into the customer's
 * folder within the chat-media storage bucket:
 *   chat-media/account-<accountId>/contact-<contactId>/customer_details.json
 *
 * Best-effort and non-blocking: returns the public URL or null on error.
 */
export async function syncCustomerDetailsToStorage(
  storage: MirrorStorage,
  accountId: string,
  contact: Record<string, unknown>,
): Promise<string | null> {
  try {
    if (!contact?.id || !accountId) return null;

    const contactId = String(contact.id);
    const contactName = (contact.name as string) ?? null;
    const subfolder = buildCustomerSubfolder(contactId, "", contactName);
    const customerDir = subfolder.endsWith("/") ? subfolder.slice(0, -1) : subfolder;
    const path = `account-${accountId}/${customerDir}/customer_details.json`;

    const details: CustomerDetails = {
      id: contactId,
      account_id: accountId,
      name: (contact.name as string) ?? null,
      phone: (contact.phone as string) ?? null,
      email: (contact.email as string) ?? null,
      company: (contact.company as string) ?? null,
      avatar_url: (contact.avatar_url as string) ?? null,
      wa_user_id: (contact.wa_user_id as string) ?? null,
      tags: Array.isArray(contact.tags) ? (contact.tags as string[]) : [],
      hubspot_contact_id: (contact.hubspot_contact_id as string) ?? null,
      created_at: (contact.created_at as string) ?? null,
      updated_at: (contact.updated_at as string) ?? new Date().toISOString(),
      synced_at: new Date().toISOString(),
    };

    const payload = Buffer.from(JSON.stringify(details, null, 2), "utf-8");

    const { error } = await storage.from(MIRROR_BUCKET).upload(path, payload, {
      contentType: "application/json",
      cacheControl: "300",
      upsert: true,
    });

    if (error) {
      console.warn(
        `[customer-storage] Failed to sync customer details for ${contactId}:`,
        error.message,
      );
      return null;
    }

    const {
      data: { publicUrl },
    } = storage.from(MIRROR_BUCKET).getPublicUrl(path);

    return publicUrl || null;
  } catch (err) {
    console.warn(
      `[customer-storage] Error syncing customer details for ${contact?.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

