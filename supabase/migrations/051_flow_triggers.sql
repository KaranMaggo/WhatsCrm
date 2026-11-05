-- 051_flow_triggers.sql — Expand flow trigger_type check constraint
-- Supports contact_property, tag_added, tag_removed, new_contact_created,
-- new_message_received, and conversation_assigned triggers in flows.

ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check;

ALTER TABLE flows
  ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN (
    'keyword',
    'first_inbound_message',
    'manual',
    'tag_added',
    'tag_removed',
    'contact_property',
    'new_contact_created',
    'new_message_received',
    'conversation_assigned'
  ));

CREATE INDEX IF NOT EXISTS idx_flows_account_active_trigger
  ON flows(account_id, trigger_type)
  WHERE status = 'active';

