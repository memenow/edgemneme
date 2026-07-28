ALTER TABLE repositories
  ADD COLUMN expected_owner_external_id INTEGER
    CHECK (
      expected_owner_external_id IS NULL
      OR (
        typeof(expected_owner_external_id) = 'integer'
        AND expected_owner_external_id > 0
      )
    );

CREATE TABLE migration_0010_github_owner_identity_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT github_owner_identity_preflight_failed CHECK (must_be_zero = 0)
);

INSERT INTO migration_0010_github_owner_identity_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (
  SELECT 1
  FROM repositories
  WHERE lower(provider) = 'github'
    AND sync_enabled = 1
    AND expected_owner_external_id IS NULL
);

DROP TABLE migration_0010_github_owner_identity_preflight;

CREATE INDEX repositories_github_sync_identity
  ON repositories(
    lower(provider),
    sync_enabled,
    external_id,
    expected_owner_external_id
  );

CREATE TRIGGER repositories_github_sync_owner_insert_guard
BEFORE INSERT ON repositories
WHEN lower(NEW.provider) = 'github'
  AND NEW.sync_enabled = 1
  AND NEW.expected_owner_external_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'github repository owner identity is required');
END;

CREATE TRIGGER repositories_github_sync_owner_update_guard
BEFORE UPDATE OF provider, sync_enabled, expected_owner_external_id ON repositories
WHEN lower(NEW.provider) = 'github'
  AND NEW.sync_enabled = 1
  AND NEW.expected_owner_external_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'github repository owner identity is required');
END;

CREATE TABLE github_credential_states (
  credential_version TEXT PRIMARY KEY,
  expires_at TEXT,
  last_observed_at TEXT NOT NULL,
  credential_status TEXT NOT NULL CHECK (
    credential_status IN ('active', 'expiring', 'expired', 'invalid')
  ),
  warning_threshold_days INTEGER CHECK (
    warning_threshold_days IS NULL OR warning_threshold_days IN (14, 7, 1)
  ),
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (credential_version)
    REFERENCES github_access_baselines(credential_version),
  CHECK (
    expires_at IS NULL
    OR (
      length(expires_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at
    )
  ),
  CHECK (
    length(last_observed_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', last_observed_at) = last_observed_at
  ),
  CHECK (
    length(updated_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
  ),
  CHECK (
    (credential_status = 'expiring' AND warning_threshold_days IS NOT NULL)
    OR (credential_status <> 'expiring' AND warning_threshold_days IS NULL)
  )
);

CREATE TRIGGER github_credential_expiry_identity_guard
BEFORE UPDATE OF credential_version, expires_at ON github_credential_states
WHEN NEW.credential_version <> OLD.credential_version
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'github credential version must change with expiration');
END;

CREATE TABLE github_credential_expiry_warnings (
  event_id TEXT PRIMARY KEY,
  credential_version TEXT NOT NULL,
  threshold_days INTEGER NOT NULL CHECK (threshold_days IN (14, 7, 1)),
  expires_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  FOREIGN KEY (credential_version)
    REFERENCES github_access_baselines(credential_version),
  UNIQUE (credential_version, threshold_days),
  CHECK (
    length(expires_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at
  ),
  CHECK (
    length(observed_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) = observed_at
  )
);

CREATE INDEX github_credential_states_by_status
  ON github_credential_states(credential_status, expires_at);

CREATE INDEX github_credential_warnings_by_expiry
  ON github_credential_expiry_warnings(expires_at, threshold_days);

CREATE TRIGGER github_credential_expiry_warnings_no_update
BEFORE UPDATE ON github_credential_expiry_warnings
BEGIN
  SELECT RAISE(ABORT, 'github credential expiry warnings are immutable');
END;

CREATE TRIGGER github_credential_expiry_warnings_no_delete
BEFORE DELETE ON github_credential_expiry_warnings
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'github credential expiry warnings are immutable');
END;

CREATE TABLE github_repository_sync_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  full_reconciliation INTEGER NOT NULL CHECK (full_reconciliation IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  started_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT,
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id),
  UNIQUE (project_id, repository_id, scheduled_for),
  CHECK (
    length(scheduled_for) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_for) = scheduled_for
  ),
  CHECK (
    length(started_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) = started_at
  ),
  CHECK (
    length(lease_expires_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) = lease_expires_at
    AND lease_expires_at > started_at
  ),
  CHECK (
    completed_at IS NULL
    OR (
      length(completed_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
    )
  ),
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status <> 'running' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX github_repository_sync_runs_by_repository
  ON github_repository_sync_runs(project_id, repository_id, scheduled_for DESC);

CREATE INDEX github_repository_sync_runs_by_active_lease
  ON github_repository_sync_runs(
    project_id, repository_id, status, lease_expires_at
  );

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
  OR EXISTS (SELECT 1 FROM memory_repository_contexts WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM observation_evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM memories WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM observations WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM workflow_runs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM idempotency_records WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM taxonomy_policies WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_repository_sync_runs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM sync_cursors WHERE project_id = OLD.project_id)
  OR EXISTS (
    SELECT 1 FROM project_grant_repository_contexts
    WHERE project_id = OLD.project_id
  )
  OR EXISTS (SELECT 1 FROM project_grants WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM sessions WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM repositories WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM outbox_events WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM projection_snapshots WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM audit_events WHERE project_id = OLD.project_id)
  OR EXISTS (
    SELECT 1 FROM github_credential_expiry_warnings AS warning
    JOIN github_access_baselines AS baseline
      ON baseline.credential_version = warning.credential_version
    WHERE baseline.approved_by_principal_id = OLD.principal_id
      AND baseline.credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_credential_states AS state
    JOIN github_access_baselines AS baseline
      ON baseline.credential_version = state.credential_version
    WHERE baseline.approved_by_principal_id = OLD.principal_id
      AND baseline.credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_rate_observations AS observation
    JOIN github_access_baselines AS baseline
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
