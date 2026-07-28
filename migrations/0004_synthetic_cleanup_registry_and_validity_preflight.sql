CREATE TABLE migration_0004_validity_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT validity_preflight_failed CHECK (must_be_zero = 0)
);

INSERT INTO migration_0004_validity_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (
  SELECT 1 FROM observations
  WHERE (valid_from IS NOT NULL AND (
      julianday(valid_from) IS NULL
      OR length(valid_from) < 20
      OR substr(valid_from, 11, 1) <> 'T'
      OR (
        substr(valid_from, -1, 1) <> 'Z'
        AND (
          substr(valid_from, -6, 1) NOT IN ('+', '-')
          OR substr(valid_from, -3, 1) <> ':'
        )
      )
    ))
    OR (valid_until IS NOT NULL AND (
      julianday(valid_until) IS NULL
      OR length(valid_until) < 20
      OR substr(valid_until, 11, 1) <> 'T'
      OR (
        substr(valid_until, -1, 1) <> 'Z'
        AND (
          substr(valid_until, -6, 1) NOT IN ('+', '-')
          OR substr(valid_until, -3, 1) <> ':'
        )
      )
    ))
    OR (
      valid_from IS NOT NULL
      AND valid_until IS NOT NULL
      AND julianday(valid_from) > julianday(valid_until)
    )
)
OR EXISTS (
  SELECT 1 FROM memory_versions
  WHERE (valid_from IS NOT NULL AND (
      julianday(valid_from) IS NULL
      OR length(valid_from) < 20
      OR substr(valid_from, 11, 1) <> 'T'
      OR (
        substr(valid_from, -1, 1) <> 'Z'
        AND (
          substr(valid_from, -6, 1) NOT IN ('+', '-')
          OR substr(valid_from, -3, 1) <> ':'
        )
      )
    ))
    OR (valid_until IS NOT NULL AND (
      julianday(valid_until) IS NULL
      OR length(valid_until) < 20
      OR substr(valid_until, 11, 1) <> 'T'
      OR (
        substr(valid_until, -1, 1) <> 'Z'
        AND (
          substr(valid_until, -6, 1) NOT IN ('+', '-')
          OR substr(valid_until, -3, 1) <> ':'
        )
      )
    ))
    OR (
      valid_from IS NOT NULL
      AND valid_until IS NOT NULL
      AND julianday(valid_from) > julianday(valid_until)
    )
);

DROP TABLE migration_0004_validity_preflight;

CREATE TABLE synthetic_cleanup_registry (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  expires_at TEXT NOT NULL CHECK (
    julianday(expires_at) IS NOT NULL
    AND length(expires_at) >= 20
    AND substr(expires_at, 11, 1) = 'T'
    AND substr(expires_at, -1, 1) = 'Z'
  ),
  created_at TEXT NOT NULL CHECK (
    julianday(created_at) IS NOT NULL
    AND length(created_at) >= 20
    AND substr(created_at, 11, 1) = 'T'
    AND substr(created_at, -1, 1) = 'Z'
  ),
  last_attempt_at TEXT CHECK (
    last_attempt_at IS NULL OR (
      julianday(last_attempt_at) IS NOT NULL
      AND length(last_attempt_at) >= 20
      AND substr(last_attempt_at, 11, 1) = 'T'
      AND substr(last_attempt_at, -1, 1) = 'Z'
    )
  ),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code = 'SYNTHETIC_CLEANUP_FAILED'
  ),
  CHECK (julianday(expires_at) > julianday(created_at))
);

CREATE INDEX synthetic_cleanup_registry_expiry
  ON synthetic_cleanup_registry(expires_at, project_id);

CREATE TRIGGER synthetic_cleanup_registry_scope_guard
BEFORE INSERT ON synthetic_cleanup_registry
WHEN NOT EXISTS (
    SELECT 1 FROM projects
    WHERE project_id = NEW.project_id
      AND project_ref GLOB 'system.synthetic.*'
  )
  OR NOT EXISTS (
    SELECT 1 FROM principals
    WHERE principal_id = NEW.principal_id
      AND issuer = 'system.synthetic'
      AND subject = NEW.principal_id
  )
BEGIN
  SELECT RAISE(ABORT, 'synthetic project and principal required');
END;

CREATE TRIGGER synthetic_cleanup_registry_identity_immutable
BEFORE UPDATE OF project_id, principal_id, expires_at, created_at
ON synthetic_cleanup_registry
WHEN NEW.project_id <> OLD.project_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.expires_at <> OLD.expires_at
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup registration is immutable');
END;

CREATE TRIGGER synthetic_cleanup_registry_delete_identity_guard
BEFORE DELETE ON synthetic_cleanup_registry
WHEN NOT EXISTS (
    SELECT 1 FROM projects
    WHERE project_id = OLD.project_id
      AND project_ref GLOB 'system.synthetic.*'
  )
  OR NOT EXISTS (
    SELECT 1 FROM principals
    WHERE principal_id = OLD.principal_id
      AND issuer = 'system.synthetic'
      AND subject = OLD.principal_id
  )
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup identity is invalid');
END;

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
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup requires child-first deletion');
END;
