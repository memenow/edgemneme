CREATE INDEX outbox_ordinary_workflow_reconcile
ON outbox_events (
  COALESCE(next_attempt_at, ''),
  created_at,
  event_id
)
WHERE event_type <> 'projection.rebuild.requested'
  AND event_type IN (
    'candidate.submitted',
    'candidate.reviewed',
    'session.consolidation.requested',
    'github.sync.requested',
    'memory.changed'
  )
  AND dispatched_at IS NOT NULL
  AND failed_at IS NULL
  AND (
    last_error_code IS NULL
    OR last_error_code IN (
      'WORKFLOW_RECONCILIATION_PENDING',
      'WORKFLOW_CONTROL_PLANE_UNKNOWN'
    )
  );
