-- ============================================================
-- 052_hubspot_media_notes.sql — HubSpot Media Notes & Deal Association
--
-- Enables syncing notes for images/videos shared on WhatsApp
-- to HubSpot Contacts and Deals with attachments:
-- 1. messages.hubspot_note_id (text) — Tracks the created HubSpot Note ID for media.
-- 2. deals.hubspot_deal_id (text) — Cached HubSpot Deal ID for deal association.
-- 3. hubspot_configs.auto_sync_media_notes (boolean) — Option to sync media as notes to deals & contacts.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS hubspot_note_id text;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS hubspot_deal_id text;

ALTER TABLE hubspot_configs
  ADD COLUMN IF NOT EXISTS auto_sync_media_notes boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_messages_hubspot_note
  ON messages (hubspot_note_id);

CREATE INDEX IF NOT EXISTS idx_deals_hubspot_deal
  ON deals (hubspot_deal_id);

