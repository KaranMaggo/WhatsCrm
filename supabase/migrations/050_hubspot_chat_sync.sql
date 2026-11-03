-- ============================================================
-- 050_hubspot_chat_sync.sql — HubSpot Timeline Chat & Activity Sync
--
-- Adds tracking columns to sync full WhatsApp conversations to HubSpot:
-- 1. conversations.hubspot_started_synced (boolean) — Tracks if the initial
--    "WhatsApp conversation started" note has been posted to HubSpot.
-- 2. conversations.hubspot_contact_id (text) — Cached HubSpot Contact ID.
-- 3. messages.hubspot_communication_id (text) — HubSpot Communication object ID
--    logged as "WHATS_APP" on the contact timeline.
-- 4. messages.hubspot_synced_at (timestamptz) — When the message was logged.
-- 5. contacts.hubspot_contact_id (text) — Cached HubSpot Contact ID on contacts.
-- 6. contacts.hubspot_synced_at (timestamptz) — Contact sync timestamp.
-- 7. hubspot_configs.auto_sync_chat (boolean) — Option to auto-sync chat messages.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS hubspot_started_synced boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hubspot_contact_id text;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS hubspot_communication_id text,
  ADD COLUMN IF NOT EXISTS hubspot_synced_at timestamptz;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS hubspot_contact_id text,
  ADD COLUMN IF NOT EXISTS hubspot_synced_at timestamptz;

ALTER TABLE hubspot_configs
  ADD COLUMN IF NOT EXISTS auto_sync_chat boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_messages_hubspot_comm
  ON messages (conversation_id, hubspot_communication_id);

CREATE INDEX IF NOT EXISTS idx_conversations_hubspot_contact
  ON conversations (hubspot_contact_id);

CREATE INDEX IF NOT EXISTS idx_contacts_hubspot_contact
  ON contacts (hubspot_contact_id);
