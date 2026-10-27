-- ============================================================
-- 049_flow_ai_nodes.sql — Flow AI Bot: ai_reply node & AI handoff
-- ============================================================

-- 1. flow_nodes.node_type — add 'ai_reply'
ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end',
    'ai_reply'
  ));

-- 2. flow_run_events.event_type — add 'ai_reply'
ALTER TABLE flow_run_events
  DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;

ALTER TABLE flow_run_events
  ADD CONSTRAINT flow_run_events_event_type_check
  CHECK (event_type IN (
    'started',
    'node_entered',
    'message_sent',
    'reply_received',
    'fallback_fired',
    'handoff',
    'timeout',
    'error',
    'completed',
    'ai_reply'
  ));
