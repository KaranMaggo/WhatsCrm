# HubSpot CRM Integration

Connect WhatsCRM with HubSpot to automatically synchronize WhatsApp contacts and leads.

## Overview

Whenever a message is received on WhatsApp (or when a contact is created/updated):
1. **Email Existence Check**: The integration first checks if a contact with that email address already exists in HubSpot via HubSpot CRM API v3.
2. **Update on Match**: If the contact exists in HubSpot with that email, it updates the existing HubSpot contact with the contact's name, phone, and company.
3. **Create on New**: If the contact does not exist in HubSpot, it creates a new contact in HubSpot with email, name, phone, and company.
4. **Phone Fallback**: If no email is present, it searches HubSpot by phone number to update existing or create new.

---

## 1. Setup in HubSpot

To connect WhatsCRM with HubSpot, you need a **HubSpot Private App Access Token**:

1. In HubSpot, click the **Settings (gear icon)** in the top navigation bar.
2. In the left sidebar, navigate to **Integrations → Private Apps**.
3. Click **Create a private app**.
4. Give your app a name (e.g. `WhatsCRM Sync`).
5. Open the **Scopes** tab and check:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
6. Click **Create app** and confirm.
7. Click **Show token** and copy the access token (starts with `pat-...`).

---

## 2. Configuration in WhatsCRM

### Option A: Dashboard Settings (Recommended)
1. Open WhatsCRM and go to **Settings → HubSpot** (`/settings?tab=hubspot`).
2. Paste your Private App Access Token into the field.
3. Optionally enter your **HubSpot Portal ID** for direct links to HubSpot contact records.
4. Enable **Sync on WhatsApp Message Received** (default: On).
5. Enable **Sync on Contact Create & Update** (default: On).
6. Click **Test Connection** to verify with HubSpot.
7. Click **Save Settings**. (The token is stored AES-256-GCM encrypted in your database).

### Option B: Environment Variable (Self-Hosting / Docker)
Add to your `.env.local` or environment:
```bash
HUBSPOT_ACCESS_TOKEN=pat-na1-...
```

---

## 3. How Synchronization Works

### When a WhatsApp Message is Received
- When an inbound WhatsApp message arrives at `/api/whatsapp/webhook`, WhatsCRM resolves or creates the contact.
- If the contact does not yet have an email, WhatsCRM automatically inspects the incoming WhatsApp message text for an email address (e.g. `john@example.com`). If found, it saves it to the contact record.
- WhatsCRM queries HubSpot:
  - `GET /crm/v3/objects/contacts/{email}?idProperty=email`
  - If **found (HTTP 200)**: Updates the contact via `PATCH /crm/v3/objects/contacts/{id}`.
  - If **not found (HTTP 404)**: Creates a new contact via `POST /crm/v3/objects/contacts`.
- This runs asynchronously inside Next.js `after()`, so the WhatsApp webhook responds immediately to Meta with `200 OK`.

---

## 4. Manual Sync & Direct API

### Manual Sync via UI
- **Contact Details**: In **Contacts**, click any contact and select **Sync to HubSpot** in the header.
- **Contact Table**: Click the `...` menu on any row and choose **Sync to HubSpot**.

### Direct API Endpoint
You can hit the API route to trigger a contact sync:

```bash
POST /api/integrations/hubspot/sync
Content-Type: application/json
```

**Body (Sync by Contact ID):**
```json
{
  "contactId": "c56a4180-65aa-42ec-a945-5fd2dec05382"
}
```

**Body (Sync by payload):**
```json
{
  "email": "customer@example.com",
  "name": "Jane Doe",
  "phone": "+15551234567",
  "company": "Acme Corp"
}
```

**Response:**
```json
{
  "ok": true,
  "action": "updated", // or "created"
  "hubspotContactId": "12345",
  "email": "customer@example.com"
}
```
