-- ============================================================
-- 053_per_customer_storage.sql
--
-- Enables per-customer folders in chat-media:
--   account-<accountId>/contact-<contactId>/
--     ├── customer_details.json (customer details & metadata)
--     ├── inbound/ (media received from customer)
--     └── outbound/ (media sent to customer)
--
-- Adds 'application/json' to chat-media allowed_mime_types.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media',
  'chat-media',
  TRUE,
  16777216, -- 16 MB
  ARRAY[
    -- Images
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    -- Videos
    'video/mp4', 'video/3gpp', 'video/3gp', 'video/quicktime',
    -- Documents
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    -- Audio
    'audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/amr', 'audio/opus',
    -- Customer Profile & Details JSON
    'application/json'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

