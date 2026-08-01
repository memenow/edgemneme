CREATE TABLE github_sync_activation_schema_preflight (
  guard_id INTEGER PRIMARY KEY CHECK (guard_id = 1),
  invalid_head_version_count INTEGER NOT NULL CHECK (
    invalid_head_version_count = 0
  )
);

INSERT INTO github_sync_activation_schema_preflight
  (guard_id, invalid_head_version_count)
SELECT 1, COUNT(*)
FROM github_tree_ref_heads
WHERE typeof(head_version) <> 'integer'
  OR head_version < 1
  OR head_version > 9007199254740991;

DROP TABLE github_sync_activation_schema_preflight;

ALTER TABLE repositories
  ADD COLUMN github_sync_configuration_version INTEGER NOT NULL DEFAULT 1
    CHECK (
      typeof(github_sync_configuration_version) = 'integer'
      AND github_sync_configuration_version >= 1
      AND github_sync_configuration_version <= 9007199254740991
    );

ALTER TABLE sync_cursors
  ADD COLUMN cursor_version INTEGER NOT NULL DEFAULT 1
    CHECK (
      typeof(cursor_version) = 'integer'
      AND cursor_version >= 1
      AND cursor_version <= 9007199254740991
    );

ALTER TABLE github_repository_sync_runs ADD COLUMN claimed_ref TEXT;
ALTER TABLE github_repository_sync_runs
  ADD COLUMN claimed_head_manifest_id TEXT;
ALTER TABLE github_repository_sync_runs
  ADD COLUMN claimed_head_version INTEGER;
ALTER TABLE github_repository_sync_runs
  ADD COLUMN repository_configuration_version INTEGER;
ALTER TABLE github_repository_sync_runs ADD COLUMN cursor_version INTEGER;
ALTER TABLE github_repository_sync_runs
  ADD COLUMN claim_contract_version INTEGER NOT NULL DEFAULT 0
    CHECK (claim_contract_version IN (0, 1));

DROP TRIGGER IF EXISTS synthetic_cleanup_registry_delete_child_guard;

CREATE TABLE github_repository_sync_runs_next (
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
  claimed_ref TEXT,
  claimed_head_manifest_id TEXT,
  claimed_head_version INTEGER,
  repository_configuration_version INTEGER,
  cursor_version INTEGER,
  claim_contract_version INTEGER NOT NULL DEFAULT 0
    CHECK (claim_contract_version IN (0, 1)),
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id),
  UNIQUE (project_id, repository_id, claimed_ref, scheduled_for),
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

INSERT INTO github_repository_sync_runs_next
  (run_id, project_id, repository_id, scheduled_for, full_reconciliation,
   status, started_at, lease_expires_at, completed_at, last_error_code,
   claimed_ref, claimed_head_manifest_id, claimed_head_version,
   repository_configuration_version, cursor_version, claim_contract_version)
SELECT run_id, project_id, repository_id, scheduled_for, full_reconciliation,
       status, started_at, lease_expires_at, completed_at, last_error_code,
       claimed_ref, claimed_head_manifest_id, claimed_head_version,
       repository_configuration_version, cursor_version, claim_contract_version
FROM github_repository_sync_runs;

DROP TABLE github_repository_sync_runs;
ALTER TABLE github_repository_sync_runs_next RENAME TO github_repository_sync_runs;

CREATE INDEX github_repository_sync_runs_by_repository
  ON github_repository_sync_runs(
    project_id, repository_id, claimed_ref, scheduled_for DESC
  );

CREATE INDEX github_repository_sync_runs_by_active_lease
  ON github_repository_sync_runs(
    project_id, repository_id, claimed_ref, status, lease_expires_at
  );

CREATE TRIGGER repositories_github_sync_configuration_version_initial_guard
BEFORE INSERT ON repositories
WHEN NEW.github_sync_configuration_version <> 1
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository configuration initial version must be one');
END;

CREATE TRIGGER repositories_github_sync_configuration_version_monotonic
BEFORE UPDATE OF github_sync_configuration_version ON repositories
WHEN NEW.github_sync_configuration_version <
       OLD.github_sync_configuration_version
  OR NEW.github_sync_configuration_version >
       OLD.github_sync_configuration_version + 1
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository configuration version cannot decrease');
END;

CREATE TRIGGER repositories_github_sync_configuration_version_bump
AFTER UPDATE OF provider, external_id, expected_owner_external_id, owner, name,
  default_branch, tracked_refs_json, sync_enabled
ON repositories
WHEN NEW.github_sync_configuration_version =
       OLD.github_sync_configuration_version
  AND (
    NEW.provider IS NOT OLD.provider
    OR NEW.external_id IS NOT OLD.external_id
    OR NEW.expected_owner_external_id IS NOT OLD.expected_owner_external_id
    OR NEW.owner IS NOT OLD.owner
    OR NEW.name IS NOT OLD.name
    OR NEW.default_branch IS NOT OLD.default_branch
    OR NEW.tracked_refs_json IS NOT OLD.tracked_refs_json
    OR NEW.sync_enabled IS NOT OLD.sync_enabled
  )
BEGIN
  UPDATE repositories
  SET github_sync_configuration_version =
        OLD.github_sync_configuration_version + 1
  WHERE project_id = OLD.project_id
    AND repository_id = OLD.repository_id
    AND github_sync_configuration_version =
      OLD.github_sync_configuration_version;
END;

CREATE TRIGGER sync_cursors_version_monotonic
BEFORE UPDATE OF cursor_version ON sync_cursors
WHEN NEW.cursor_version < OLD.cursor_version
  OR NEW.cursor_version > OLD.cursor_version + 1
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync cursor version cannot decrease');
END;

CREATE TRIGGER sync_cursors_initial_version_guard
BEFORE INSERT ON sync_cursors
WHEN NEW.cursor_version <> 1
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync cursor initial version must be one');
END;

CREATE TRIGGER sync_cursors_no_delete
BEFORE DELETE ON sync_cursors
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync cursors cannot be deleted');
END;

CREATE TRIGGER sync_cursors_version_bump
AFTER UPDATE OF observed_sha, status, etag, last_sync_at, next_sync_at,
  history_gap_possible, credential_status, last_error_code, updated_at
ON sync_cursors
WHEN NEW.cursor_version = OLD.cursor_version
  AND (
    NEW.observed_sha IS NOT OLD.observed_sha
    OR NEW.status IS NOT OLD.status
    OR NEW.etag IS NOT OLD.etag
    OR NEW.last_sync_at IS NOT OLD.last_sync_at
    OR NEW.next_sync_at IS NOT OLD.next_sync_at
    OR NEW.history_gap_possible IS NOT OLD.history_gap_possible
    OR NEW.credential_status IS NOT OLD.credential_status
    OR NEW.last_error_code IS NOT OLD.last_error_code
    OR NEW.updated_at IS NOT OLD.updated_at
  )
BEGIN
  UPDATE sync_cursors
  SET cursor_version = OLD.cursor_version + 1
  WHERE project_id = OLD.project_id
    AND repository_id = OLD.repository_id
    AND ref = OLD.ref
    AND cursor_version = OLD.cursor_version;
END;

CREATE TRIGGER github_tree_ref_heads_safe_version_guard
BEFORE UPDATE OF head_version ON github_tree_ref_heads
WHEN OLD.head_version >= 9007199254740991
  OR NEW.head_version > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree ref head version is exhausted');
END;

CREATE TRIGGER github_tree_ref_heads_safe_version_insert_guard
BEFORE INSERT ON github_tree_ref_heads
WHEN typeof(NEW.head_version) <> 'integer'
  OR NEW.head_version < 1
  OR NEW.head_version > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree ref head version is invalid');
END;

CREATE TRIGGER github_repository_sync_runs_claim_insert_guard
BEFORE INSERT ON github_repository_sync_runs
WHEN (
    NEW.claim_contract_version = 0
    AND (
      NEW.claimed_ref IS NOT NULL
      OR NEW.claimed_head_manifest_id IS NOT NULL
      OR NEW.claimed_head_version IS NOT NULL
      OR NEW.repository_configuration_version IS NOT NULL
      OR NEW.cursor_version IS NOT NULL
    )
  )
  OR (
    NEW.claim_contract_version = 1
    AND (
      NEW.claimed_ref IS NULL
      OR length(NEW.claimed_ref) = 0
      OR trim(NEW.claimed_ref) <> NEW.claimed_ref
      OR instr(NEW.claimed_ref, char(0)) <> 0
      OR typeof(NEW.claimed_head_version) <> 'integer'
      OR NEW.claimed_head_version < 0
      OR NEW.claimed_head_version >= 9007199254740991
      OR (
        NEW.claimed_head_version = 0
        AND NEW.claimed_head_manifest_id IS NOT NULL
      )
      OR (
        NEW.claimed_head_version > 0
        AND (
          NEW.claimed_head_manifest_id IS NULL
          OR length(NEW.claimed_head_manifest_id) <> 64
          OR NEW.claimed_head_manifest_id GLOB '*[^0-9a-f]*'
        )
      )
      OR typeof(NEW.repository_configuration_version) <> 'integer'
      OR NEW.repository_configuration_version < 1
      OR NEW.repository_configuration_version > 9007199254740991
      OR typeof(NEW.cursor_version) <> 'integer'
      OR NEW.cursor_version < 1
      OR NEW.cursor_version > 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository sync run claim is invalid');
END;

CREATE TRIGGER github_repository_sync_runs_no_delete
BEFORE DELETE ON github_repository_sync_runs
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository sync runs cannot be deleted');
END;

CREATE TRIGGER github_repository_sync_runs_claim_immutable
BEFORE UPDATE OF run_id, project_id, repository_id, scheduled_for,
  full_reconciliation, started_at, lease_expires_at, claimed_ref,
  claimed_head_manifest_id, claimed_head_version,
  repository_configuration_version, cursor_version, claim_contract_version
ON github_repository_sync_runs
WHEN NEW.run_id IS NOT OLD.run_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.repository_id IS NOT OLD.repository_id
  OR NEW.scheduled_for IS NOT OLD.scheduled_for
  OR NEW.full_reconciliation IS NOT OLD.full_reconciliation
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.lease_expires_at IS NOT OLD.lease_expires_at
  OR NEW.claimed_ref IS NOT OLD.claimed_ref
  OR NEW.claimed_head_manifest_id IS NOT OLD.claimed_head_manifest_id
  OR NEW.claimed_head_version IS NOT OLD.claimed_head_version
  OR NEW.repository_configuration_version IS NOT
    OLD.repository_configuration_version
  OR NEW.cursor_version IS NOT OLD.cursor_version
  OR NEW.claim_contract_version IS NOT OLD.claim_contract_version
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository sync run claim is immutable');
END;

CREATE TRIGGER github_repository_sync_runs_terminal_immutable
BEFORE UPDATE OF status, completed_at, last_error_code
ON github_repository_sync_runs
WHEN OLD.status <> 'running'
  AND (
    NEW.status IS NOT OLD.status
    OR NEW.completed_at IS NOT OLD.completed_at
    OR NEW.last_error_code IS NOT OLD.last_error_code
  )
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository sync run is terminal');
END;

CREATE TABLE github_tree_activation_witnesses (
  activation_token TEXT PRIMARY KEY CHECK (
    length(activation_token) = 64
    AND activation_token NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_id TEXT NOT NULL UNIQUE CHECK (
    length(receipt_id) = 64
    AND receipt_id NOT GLOB '*[^0-9a-f]*'
  ),
  run_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  activation_request_digest TEXT NOT NULL CHECK (
    length(activation_request_digest) = 64
    AND activation_request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  FOREIGN KEY (run_id)
    REFERENCES github_repository_sync_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id),
  FOREIGN KEY (project_id, repository_id, ref, manifest_id)
    REFERENCES github_tree_manifests(project_id, repository_id, ref, manifest_id),
  UNIQUE (activation_token, receipt_id, run_id)
);

CREATE INDEX github_tree_activation_witnesses_by_project
ON github_tree_activation_witnesses(project_id, created_at, activation_token);

CREATE TRIGGER github_tree_activation_witnesses_insert_guard
BEFORE INSERT ON github_tree_activation_witnesses
WHEN NOT EXISTS (
  SELECT 1
  FROM github_repository_sync_runs AS sync_run
  JOIN repositories AS repository
    ON repository.project_id = sync_run.project_id
   AND repository.repository_id = sync_run.repository_id
  JOIN sync_cursors AS cursor
    ON cursor.project_id = sync_run.project_id
   AND cursor.repository_id = sync_run.repository_id
   AND cursor.ref = sync_run.claimed_ref
  JOIN github_tree_manifests AS manifest
    ON manifest.project_id = sync_run.project_id
   AND manifest.repository_id = sync_run.repository_id
   AND manifest.ref = sync_run.claimed_ref
   AND manifest.manifest_id = NEW.manifest_id
  LEFT JOIN github_tree_ref_heads AS head
    ON head.project_id = sync_run.project_id
   AND head.repository_id = sync_run.repository_id
   AND head.ref = sync_run.claimed_ref
  WHERE sync_run.run_id = NEW.run_id
    AND sync_run.project_id = NEW.project_id
    AND sync_run.repository_id = NEW.repository_id
    AND sync_run.claimed_ref = NEW.ref
    AND sync_run.claim_contract_version = 1
    AND sync_run.status = 'running'
    AND sync_run.completed_at IS NULL
    AND sync_run.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND repository.sync_enabled = 1
    AND lower(repository.provider) = 'github'
    AND repository.github_sync_configuration_version =
      sync_run.repository_configuration_version
    AND cursor.cursor_version = sync_run.cursor_version
    AND cursor.status <> 'paused'
    AND manifest.status = 'complete'
    AND manifest.collection_key = sync_run.scheduled_for
    AND (
      (
        manifest.repository_authority = 'default_branch'
        AND manifest.ref = 'refs/heads/' || repository.default_branch
      )
      OR (
        manifest.repository_authority = 'tracked_ref'
        AND EXISTS (
          SELECT 1
          FROM json_each(repository.tracked_refs_json) AS tracked_ref
          WHERE tracked_ref.value = manifest.ref
        )
      )
    )
    AND (
      (
        sync_run.claimed_head_version = 0
        AND sync_run.claimed_head_manifest_id IS NULL
        AND head.manifest_id IS NULL
      )
      OR (
        sync_run.claimed_head_version >= 1
        AND head.manifest_id IS sync_run.claimed_head_manifest_id
        AND head.head_version = sync_run.claimed_head_version
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation witness pre-state is invalid');
END;

CREATE TRIGGER github_tree_activation_witnesses_no_update
BEFORE UPDATE ON github_tree_activation_witnesses
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation witnesses are immutable');
END;

CREATE TRIGGER github_tree_activation_witnesses_no_delete
BEFORE DELETE ON github_tree_activation_witnesses
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation witnesses are immutable');
END;

CREATE TABLE github_tree_activation_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 64
    AND receipt_id NOT GLOB '*[^0-9a-f]*'
  ),
  activation_token TEXT NOT NULL UNIQUE CHECK (
    length(activation_token) = 64
    AND activation_token NOT GLOB '*[^0-9a-f]*'
  ),
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  expected_head_manifest_id TEXT,
  expected_head_version INTEGER NOT NULL CHECK (
    typeof(expected_head_version) = 'integer'
    AND expected_head_version >= 0
    AND expected_head_version < 9007199254740991
  ),
  activated_head_version INTEGER NOT NULL CHECK (
    typeof(activated_head_version) = 'integer'
    AND activated_head_version >= 1
    AND activated_head_version <= 9007199254740991
  ),
  expected_cursor_observed_sha TEXT,
  expected_cursor_status TEXT NOT NULL,
  expected_cursor_updated_at TEXT NOT NULL,
  expected_cursor_version INTEGER NOT NULL CHECK (
    typeof(expected_cursor_version) = 'integer'
    AND expected_cursor_version >= 1
    AND expected_cursor_version < 9007199254740991
  ),
  activated_cursor_version INTEGER NOT NULL CHECK (
    typeof(activated_cursor_version) = 'integer'
    AND activated_cursor_version >= 2
    AND activated_cursor_version <= 9007199254740991
  ),
  expected_repository_configuration_version INTEGER NOT NULL CHECK (
    typeof(expected_repository_configuration_version) = 'integer'
    AND expected_repository_configuration_version >= 1
    AND expected_repository_configuration_version <= 9007199254740991
  ),
  expected_repository_updated_at TEXT NOT NULL,
  observed_sha TEXT NOT NULL,
  sync_event_id TEXT NOT NULL,
  sync_event_payload_digest TEXT NOT NULL CHECK (
    length(sync_event_payload_digest) = 64
    AND sync_event_payload_digest NOT GLOB '*[^0-9a-f]*'
  ),
  activation_request_digest TEXT NOT NULL CHECK (
    length(activation_request_digest) = 64
    AND activation_request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  scheduled_for TEXT NOT NULL,
  full_reconciliation INTEGER NOT NULL CHECK (full_reconciliation IN (0, 1)),
  next_sync_at TEXT NOT NULL,
  history_gap_possible INTEGER NOT NULL CHECK (history_gap_possible IN (0, 1)),
  credential_status TEXT NOT NULL CHECK (
    credential_status IN ('active', 'expiring')
  ),
  etag TEXT,
  activated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id),
  FOREIGN KEY (project_id, repository_id, ref, manifest_id)
    REFERENCES github_tree_manifests(project_id, repository_id, ref, manifest_id),
  FOREIGN KEY (run_id)
    REFERENCES github_repository_sync_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (activation_token, receipt_id, run_id)
    REFERENCES github_tree_activation_witnesses(
      activation_token, receipt_id, run_id
    ),
  UNIQUE (run_id),
  UNIQUE (project_id, repository_id, ref, manifest_id),
  UNIQUE (project_id, repository_id, ref, activated_head_version),
  CHECK (
    expected_head_manifest_id IS NULL
    OR (
      length(expected_head_manifest_id) = 64
      AND expected_head_manifest_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    activated_head_version = expected_head_version + 1
    AND activated_cursor_version = expected_cursor_version + 1
  ),
  CHECK (
    expected_cursor_observed_sha IS NULL
    OR (
      length(expected_cursor_observed_sha) BETWEEN 40 AND 128
      AND expected_cursor_observed_sha NOT GLOB '*[^0-9A-Fa-f]*'
    )
  ),
  CHECK (
    length(scheduled_for) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_for) = scheduled_for
    AND length(next_sync_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', next_sync_at) = next_sync_at
    AND length(activated_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) = activated_at
  )
);

CREATE INDEX github_tree_activation_receipts_by_ref
  ON github_tree_activation_receipts(
    project_id, repository_id, ref, activated_at, receipt_id
  );

CREATE TRIGGER github_tree_activation_receipts_insert_guard
BEFORE INSERT ON github_tree_activation_receipts
WHEN NOT (
  EXISTS (
    SELECT 1
    FROM github_tree_activation_witnesses AS witness
    WHERE witness.activation_token = NEW.activation_token
      AND witness.receipt_id = NEW.receipt_id
      AND witness.run_id = NEW.run_id
      AND witness.project_id = NEW.project_id
      AND witness.repository_id = NEW.repository_id
      AND witness.ref = NEW.ref
      AND witness.manifest_id = NEW.manifest_id
      AND witness.activation_request_digest = NEW.activation_request_digest
      AND witness.created_at = NEW.activated_at
  )
  AND
  EXISTS (
    SELECT 1
    FROM repositories AS repository
    WHERE repository.project_id = NEW.project_id
      AND repository.repository_id = NEW.repository_id
      AND lower(repository.provider) = 'github'
      AND repository.sync_enabled = 1
      AND repository.github_sync_configuration_version =
        NEW.expected_repository_configuration_version
      AND repository.updated_at = NEW.expected_repository_updated_at
  )
  AND EXISTS (
    SELECT 1
    FROM github_tree_manifests AS manifest
    JOIN repositories AS manifest_repository
      ON manifest_repository.project_id = manifest.project_id
     AND manifest_repository.repository_id = manifest.repository_id
    WHERE manifest.project_id = NEW.project_id
      AND manifest.repository_id = NEW.repository_id
      AND manifest.ref = NEW.ref
      AND manifest.manifest_id = NEW.manifest_id
      AND manifest.observed_sha = NEW.observed_sha
      AND manifest.status = 'complete'
      AND manifest.collection_key = NEW.scheduled_for
      AND (
        (
          manifest.repository_authority = 'default_branch'
          AND manifest.ref =
            'refs/heads/' || manifest_repository.default_branch
        )
        OR (
          manifest.repository_authority = 'tracked_ref'
          AND EXISTS (
            SELECT 1
            FROM json_each(
              manifest_repository.tracked_refs_json
            ) AS tracked_ref
            WHERE tracked_ref.value = manifest.ref
          )
        )
      )
  )
  AND EXISTS (
    SELECT 1
    FROM github_tree_ref_heads AS head
    WHERE head.project_id = NEW.project_id
      AND head.repository_id = NEW.repository_id
      AND head.ref = NEW.ref
      AND head.manifest_id = NEW.manifest_id
      AND head.head_version = NEW.activated_head_version
  )
  AND EXISTS (
    SELECT 1
    FROM sync_cursors AS cursor
    WHERE cursor.project_id = NEW.project_id
      AND cursor.repository_id = NEW.repository_id
      AND cursor.ref = NEW.ref
      AND cursor.observed_sha = NEW.observed_sha
      AND cursor.status = 'observed'
      AND cursor.last_sync_at = NEW.scheduled_for
      AND cursor.next_sync_at = NEW.next_sync_at
      AND cursor.history_gap_possible = NEW.history_gap_possible
      AND cursor.credential_status = NEW.credential_status
      AND cursor.etag IS NEW.etag
      AND cursor.last_error_code IS NULL
      AND cursor.updated_at = NEW.activated_at
      AND cursor.cursor_version = NEW.activated_cursor_version
  )
  AND EXISTS (
    SELECT 1
    FROM github_repository_sync_runs AS sync_run
    WHERE sync_run.run_id = NEW.run_id
      AND sync_run.project_id = NEW.project_id
      AND sync_run.repository_id = NEW.repository_id
      AND sync_run.claimed_ref = NEW.ref
      AND sync_run.claimed_head_manifest_id IS NEW.expected_head_manifest_id
      AND sync_run.claimed_head_version = NEW.expected_head_version
      AND sync_run.scheduled_for = NEW.scheduled_for
      AND sync_run.full_reconciliation = NEW.full_reconciliation
      AND sync_run.repository_configuration_version =
        NEW.expected_repository_configuration_version
      AND sync_run.cursor_version = NEW.expected_cursor_version
      AND sync_run.claim_contract_version = 1
      AND sync_run.status = 'complete'
      AND sync_run.completed_at = NEW.activated_at
      AND sync_run.last_error_code IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM outbox_events AS event
    WHERE event.event_id = NEW.sync_event_id
      AND event.project_id = NEW.project_id
      AND event.event_type = 'github.sync.requested'
      AND event.payload_digest = NEW.sync_event_payload_digest
  )
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation receipt final state is invalid');
END;

CREATE TRIGGER github_tree_activation_receipts_no_update
BEFORE UPDATE ON github_tree_activation_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation receipts are immutable');
END;

CREATE TRIGGER github_tree_activation_receipts_no_delete
BEFORE DELETE ON github_tree_activation_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation receipts are immutable');
END;

DROP TRIGGER IF EXISTS synthetic_cleanup_registry_delete_child_guard;
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
  OR EXISTS (
    SELECT 1 FROM github_tree_activation_receipts
    WHERE project_id = OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_tree_activation_witnesses
    WHERE project_id = OLD.project_id
  )
  OR EXISTS (SELECT 1 FROM github_repository_sync_runs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_ref_heads WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_manifest_deltas WHERE project_id = OLD.project_id)
  OR EXISTS (
    SELECT 1 FROM github_tree_manifest_lifecycle_events
    WHERE project_id = OLD.project_id
  )
  OR EXISTS (SELECT 1 FROM github_tree_manifest_entries WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_manifests WHERE project_id = OLD.project_id)
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
