-- ============================================================
-- 048_hubspot_integration.sql — HubSpot CRM integration
--
-- Adds account-scoped configuration for syncing contacts to HubSpot.
-- Supports Private App access token (AES-256-GCM encrypted),
-- auto-sync settings on WhatsApp message received and contact update,
-- plus sync audit logs.
-- ============================================================

CREATE TABLE IF NOT EXISTS hubspot_configs (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                        uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  access_token                      text NOT NULL,            -- AES-256-GCM-encrypted HubSpot Private App token
  portal_id                         text,                     -- Optional HubSpot Portal ID
  auto_sync_on_message              boolean NOT NULL DEFAULT true, -- Sync to HubSpot when an inbound WhatsApp message arrives
  auto_sync_contacts                boolean NOT NULL DEFAULT true, -- Sync to HubSpot on contact create/update
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

-- RLS for hubspot_configs
ALTER TABLE hubspot_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view hubspot config" ON hubspot_configs;
CREATE POLICY "Members can view hubspot config"
  ON hubspot_configs FOR SELECT
  USING (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Admins can manage hubspot config" ON hubspot_configs;
CREATE POLICY "Admins can manage hubspot config"
  ON hubspot_configs FOR ALL
  USING (
    account_id IN (
      SELECT p.account_id FROM profiles p
      JOIN accounts a ON a.id = p.account_id
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin')
    )
  );

-- Sync audit logs
CREATE TABLE IF NOT EXISTS hubspot_sync_logs (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id                        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  contact_name                      text,
  email                             text,
  phone                             text,
  action                            text NOT NULL, -- 'created', 'updated', 'failed'
  hubspot_contact_id                text,
  status                            text NOT NULL, -- 'success', 'error'
  error_message                     text,
  source                            text NOT NULL DEFAULT 'whatsapp_message', -- 'whatsapp_message', 'manual', 'api', 'contact_form'
  created_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hubspot_sync_logs_account_created
  ON hubspot_sync_logs (account_id, created_at DESC);

ALTER TABLE hubspot_sync_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view hubspot sync logs" ON hubspot_sync_logs;
CREATE POLICY "Members can view hubspot sync logs"
  ON hubspot_sync_logs FOR SELECT
  USING (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Service role and admins can insert hubspot sync logs" ON hubspot_sync_logs;
CREATE POLICY "Service role and admins can insert hubspot sync logs"
  ON hubspot_sync_logs FOR INSERT
  WITH CHECK (
    account_id IN (
      SELECT account_id FROM profiles WHERE user_id = auth.uid()
    )
  );

GRANT ALL ON hubspot_configs TO anon, authenticated, service_role;
GRANT ALL ON hubspot_sync_logs TO anon, authenticated, service_role;
