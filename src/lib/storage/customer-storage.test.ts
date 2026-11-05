import { describe, expect, it, vi, beforeEach } from "vitest";
import { syncCustomerDetailsToStorage } from "./customer-storage";

describe("syncCustomerDetailsToStorage", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("uploads customer_details.json to the customer folder", async () => {
    const uploads: Array<{ bucket: string; path: string; options: unknown; body: Buffer }> = [];
    const fakeStorage = {
      from(bucket: string) {
        return {
          upload(path: string, body: Buffer, options: unknown) {
            uploads.push({ bucket, path, options, body });
            return Promise.resolve({ error: null });
          },
          getPublicUrl(path: string) {
            return { data: { publicUrl: `https://storage.test/${bucket}/${path}` } };
          },
        };
      },
    };

    const contact = {
      id: "cust-12345",
      name: "Jane Doe",
      phone: "+15551234567",
      email: "jane@example.com",
      company: "Acme Inc",
      tags: ["vip", "enterprise"],
    };

    const url = await syncCustomerDetailsToStorage(fakeStorage, "acc-999", contact);

    expect(uploads).toHaveLength(1);
    expect(uploads[0].bucket).toBe("chat-media");
    expect(uploads[0].path).toBe("account-acc-999/Jane Doe - cust-123/customer_details.json");
    expect(url).toBe("https://storage.test/chat-media/account-acc-999/Jane Doe - cust-123/customer_details.json");

    const savedData = JSON.parse(uploads[0].body.toString("utf-8"));
    expect(savedData.name).toBe("Jane Doe");
    expect(savedData.phone).toBe("+15551234567");
    expect(savedData.tags).toEqual(["vip", "enterprise"]);
  });

  it("handles contact ids that already have contact- prefix", async () => {
    const uploads: Array<{ path: string }> = [];
    const fakeStorage = {
      from(bucket: string) {
        return {
          upload(path: string) {
            uploads.push({ path });
            return Promise.resolve({ error: null });
          },
          getPublicUrl(path: string) {
            return { data: { publicUrl: `https://storage.test/${bucket}/${path}` } };
          },
        };
      },
    };

    await syncCustomerDetailsToStorage(fakeStorage, "acc-999", { id: "contact-abc" });
    expect(uploads[0].path).toBe("account-acc-999/contact-abc/customer_details.json");
  });
});

