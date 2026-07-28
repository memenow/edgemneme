ALTER TABLE outbox_events
ADD COLUMN projection_unknown_count INTEGER NOT NULL DEFAULT 0
CHECK (projection_unknown_count BETWEEN 0 AND 12);

ALTER TABLE outbox_events
ADD COLUMN projection_unknown_first_observed_at TEXT;

ALTER TABLE outbox_events
ADD COLUMN projection_unknown_last_observed_at TEXT;

ALTER TABLE outbox_events
ADD COLUMN projection_unknown_alerted_at TEXT;

DROP INDEX outbox_projection_rebuild_reconcile;

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
  AND (
    last_error_code IS NULL
    OR last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'
  );
