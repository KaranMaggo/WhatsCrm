-- 054_whatsapp_config_meta_app.sql — Per-account Meta App ID and Secret
-- Adds optional columns to whatsapp_config so accounts can override the deployment-wide
-- META_APP_ID and META_APP_SECRET environment variables.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS app_id text,
  ADD COLUMN IF NOT EXISTS app_secret text;

COMMENT ON COLUMN whatsapp_config.app_id IS 'Optional per-account Meta App ID (overrides env META_APP_ID)';
COMMENT ON COLUMN whatsapp_config.app_secret IS 'Optional per-account Meta App Secret (AES-256-GCM encrypted, overrides/augments env META_APP_SECRET)';
