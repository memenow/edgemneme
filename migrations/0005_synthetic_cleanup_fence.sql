ALTER TABLE synthetic_cleanup_registry
  ADD COLUMN cleanup_fenced_at TEXT CHECK (
    cleanup_fenced_at IS NULL OR (
      julianday(cleanup_fenced_at) IS NOT NULL
      AND length(cleanup_fenced_at) >= 20
      AND substr(cleanup_fenced_at, 11, 1) = 'T'
      AND substr(cleanup_fenced_at, -1, 1) = 'Z'
    )
  );

ALTER TABLE synthetic_cleanup_registry
  ADD COLUMN cleanup_claim_id TEXT CHECK (
    cleanup_claim_id IS NULL OR (
      length(cleanup_claim_id) > 0 AND instr(cleanup_claim_id, char(0)) = 0
    )
  );

ALTER TABLE synthetic_cleanup_registry
  ADD COLUMN cleanup_claim_expires_at TEXT CHECK (
    cleanup_claim_expires_at IS NULL OR (
      julianday(cleanup_claim_expires_at) IS NOT NULL
      AND length(cleanup_claim_expires_at) >= 20
      AND substr(cleanup_claim_expires_at, 11, 1) = 'T'
      AND substr(cleanup_claim_expires_at, -1, 1) = 'Z'
    )
  );

CREATE INDEX synthetic_cleanup_registry_claim
  ON synthetic_cleanup_registry(cleanup_claim_expires_at, expires_at, project_id);

CREATE TRIGGER synthetic_cleanup_registry_fence_immutable
BEFORE UPDATE OF cleanup_fenced_at ON synthetic_cleanup_registry
WHEN OLD.cleanup_fenced_at IS NOT NULL
  AND NEW.cleanup_fenced_at IS NOT OLD.cleanup_fenced_at
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup fence is immutable');
END;

CREATE TRIGGER synthetic_cleanup_registry_claim_guard
BEFORE UPDATE OF cleanup_claim_id, cleanup_claim_expires_at
ON synthetic_cleanup_registry
WHEN (NEW.cleanup_claim_id IS NULL) <> (NEW.cleanup_claim_expires_at IS NULL)
  OR (
    NEW.cleanup_claim_id IS NOT NULL
    AND NEW.cleanup_fenced_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup claim requires a fence and expiry');
END;

DROP TRIGGER synthetic_cleanup_registry_delete_child_guard;
CREATE TRIGGER synthetic_cleanup_registry_delete_child_guard
BEFORE DELETE ON synthetic_cleanup_registry
WHEN EXISTS (SELECT 1 FROM consolidation_outputs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM consolidation_inputs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM session_consolidations WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM review_decisions WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM review_requests WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM version_evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM conflicts WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM memory_versions WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM memories WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM observation_evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM observations WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM workflow_runs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM sync_cursors WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM repositories WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM idempotency_records WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM outbox_events WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM taxonomy_policies WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM projection_snapshots WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM audit_events WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM sessions WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM project_grants WHERE project_id = OLD.project_id)
  OR EXISTS (
    SELECT 1 FROM github_rate_observations observation
    JOIN github_access_baselines baseline
      ON baseline.credential_version = observation.credential_version
    WHERE baseline.approved_by_principal_id = OLD.principal_id
      AND baseline.credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_access_baselines
    WHERE approved_by_principal_id = OLD.principal_id
      AND credential_version = 'system.synthetic.' || OLD.project_id
  )
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup requires child-first deletion');
END;

CREATE TRIGGER synthetic_cleanup_projects_update_fence
BEFORE UPDATE ON projects
WHEN EXISTS (
  SELECT 1 FROM synthetic_cleanup_registry
  WHERE project_id = OLD.project_id AND cleanup_fenced_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup is fenced');
END;

CREATE TRIGGER synthetic_cleanup_outbox_insert_fence
BEFORE INSERT ON outbox_events
WHEN EXISTS (
  SELECT 1 FROM synthetic_cleanup_registry
  WHERE project_id = NEW.project_id AND cleanup_fenced_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup is fenced');
END;

CREATE TRIGGER synthetic_cleanup_workflow_insert_fence
BEFORE INSERT ON workflow_runs
WHEN NEW.status NOT IN ('complete', 'failed', 'terminated')
  AND EXISTS (
    SELECT 1 FROM synthetic_cleanup_registry
    WHERE project_id = NEW.project_id AND cleanup_fenced_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup is fenced');
END;

CREATE TRIGGER synthetic_cleanup_workflow_update_fence
BEFORE UPDATE OF status ON workflow_runs
WHEN NEW.status NOT IN ('complete', 'failed', 'terminated')
  AND EXISTS (
    SELECT 1 FROM synthetic_cleanup_registry
    WHERE project_id = NEW.project_id AND cleanup_fenced_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup is fenced');
END;
