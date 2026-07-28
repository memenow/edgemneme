CREATE INDEX outbox_projection_rebuild_history
ON outbox_events (
  json_extract(payload_json, '$.projectionTargetId'),
  json_extract(payload_json, '$.executionOrdinal'),
  event_id
)
WHERE event_type = 'projection.rebuild.requested'
  AND event_id GLOB 'projection-rebuild:*'
  AND json_extract(payload_json, '$.projectionMode')
      IN ('snapshot', 'search', 'delete');

CREATE INDEX outbox_dispatch_ready
ON outbox_events (created_at, event_id)
WHERE dispatched_at IS NULL AND failed_at IS NULL;

CREATE INDEX outbox_projection_rebuild_reconcile
ON outbox_events (
  COALESCE(next_attempt_at, ''),
  json_extract(payload_json, '$.projectionTargetId'),
  json_extract(payload_json, '$.executionOrdinal'),
  event_id
)
WHERE event_type = 'projection.rebuild.requested'
  AND event_id GLOB 'projection-rebuild:*'
  AND json_extract(payload_json, '$.projectionMode')
      IN ('snapshot', 'search', 'delete')
  AND dispatched_at IS NOT NULL
  AND failed_at IS NULL
  AND last_error_code IS NULL;

CREATE INDEX workflow_runs_projection_rebuild_latest
ON workflow_runs (
  project_id,
  root_workflow_id,
  updated_at DESC,
  workflow_id DESC
);
