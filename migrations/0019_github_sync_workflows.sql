CREATE TABLE github_sync_dispatches (
  dispatch_id TEXT PRIMARY KEY CHECK (
    length(dispatch_id) = 64 AND dispatch_id NOT GLOB '*[^0-9a-f]*'
  ),
  credential_version TEXT NOT NULL CHECK (
    length(credential_version) BETWEEN 1 AND 128
    AND trim(credential_version) = credential_version
    AND instr(credential_version, char(0)) = 0
  ),
  workflow_instance_id TEXT NOT NULL UNIQUE CHECK (
    length(workflow_instance_id) = 68
    AND workflow_instance_id GLOB 'ghd-*'
    AND substr(workflow_instance_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  scheduled_for TEXT NOT NULL,
  utc_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('materialized', 'dispatching', 'complete', 'failed')
  ),
  github_request_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(github_request_count) = 'integer'
    AND github_request_count BETWEEN 0 AND 900
  ),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT,
  UNIQUE (credential_version, scheduled_for),
  CHECK (
    length(scheduled_for) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_for) = scheduled_for
    AND utc_date = substr(scheduled_for, 1, 10)
  ),
  CHECK (
    length(created_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  CHECK (
    completed_at IS NULL
    OR (
      length(completed_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
    )
  ),
  CHECK (
    (status IN ('materialized', 'dispatching')
      AND completed_at IS NULL AND last_error_code IS NULL)
    OR (status = 'complete'
      AND completed_at IS NOT NULL AND last_error_code IS NULL)
    OR (status = 'failed'
      AND completed_at IS NOT NULL AND last_error_code IS NOT NULL)
  )
);

CREATE TRIGGER github_sync_dispatches_identity_immutable
BEFORE UPDATE OF dispatch_id, credential_version, workflow_instance_id,
  scheduled_for, utc_date, created_at
ON github_sync_dispatches
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch identity is immutable');
END;

CREATE TRIGGER github_sync_dispatches_terminal_immutable
BEFORE UPDATE ON github_sync_dispatches
WHEN OLD.status IN ('complete', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch is terminal');
END;

CREATE TRIGGER github_sync_dispatches_transition_guard
BEFORE UPDATE OF status, completed_at, last_error_code
ON github_sync_dispatches
WHEN (OLD.status = 'materialized' AND NEW.status NOT IN ('dispatching', 'failed'))
  OR (OLD.status = 'dispatching' AND NEW.status NOT IN ('complete', 'failed'))
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch transition is invalid');
END;

CREATE TRIGGER github_sync_dispatches_request_count_guard
BEFORE UPDATE OF github_request_count ON github_sync_dispatches
WHEN OLD.status <> 'materialized'
  OR NEW.status <> OLD.status
  OR NEW.github_request_count <= OLD.github_request_count
  OR NEW.github_request_count > OLD.github_request_count + 100
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch request count update is invalid');
END;

CREATE TRIGGER github_sync_dispatches_no_delete
BEFORE DELETE ON github_sync_dispatches
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatches cannot be deleted');
END;

CREATE INDEX github_sync_dispatches_by_status
  ON github_sync_dispatches(status, scheduled_for, dispatch_id);

CREATE TABLE github_sync_dispatch_items (
  item_id TEXT PRIMARY KEY CHECK (
    length(item_id) = 64 AND item_id NOT GLOB '*[^0-9a-f]*'
  ),
  dispatch_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL CHECK (
    length(ref) BETWEEN 1 AND 1024
    AND trim(ref) = ref
    AND instr(ref, char(0)) = 0
  ),
  scheduled_for TEXT NOT NULL,
  full_reconciliation INTEGER NOT NULL CHECK (full_reconciliation IN (0, 1)),
  repository_configuration_version INTEGER NOT NULL CHECK (
    typeof(repository_configuration_version) = 'integer'
    AND repository_configuration_version >= 1
    AND repository_configuration_version <= 9007199254740991
  ),
  cursor_version INTEGER NOT NULL CHECK (
    typeof(cursor_version) = 'integer'
    AND cursor_version >= 1
    AND cursor_version < 9007199254740991
  ),
  selected_head_manifest_id TEXT,
  selected_head_version INTEGER NOT NULL CHECK (
    typeof(selected_head_version) = 'integer'
    AND selected_head_version >= 0
    AND selected_head_version < 9007199254740991
  ),
  repository_updated_at TEXT NOT NULL,
  cursor_status TEXT NOT NULL,
  cursor_updated_at TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL UNIQUE CHECK (
    length(workflow_instance_id) = 68
    AND workflow_instance_id GLOB 'ghr-*'
    AND substr(workflow_instance_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'complete', 'failed')
  ),
  github_request_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(github_request_count) = 'integer'
    AND github_request_count BETWEEN 0 AND 2005
  ),
  run_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT,
  FOREIGN KEY (dispatch_id)
    REFERENCES github_sync_dispatches(dispatch_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id),
  FOREIGN KEY (run_id)
    REFERENCES github_repository_sync_runs(run_id),
  UNIQUE (dispatch_id, project_id, repository_id, ref),
  CHECK (
    length(scheduled_for) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_for) = scheduled_for
  ),
  CHECK (
    selected_head_manifest_id IS NULL
    OR (
      length(selected_head_manifest_id) = 64
      AND selected_head_manifest_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    (selected_head_version = 0 AND selected_head_manifest_id IS NULL)
    OR (selected_head_version > 0 AND selected_head_manifest_id IS NOT NULL)
  ),
  CHECK (
    length(created_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  CHECK (
    completed_at IS NULL
    OR (
      length(completed_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
    )
  ),
  CHECK (
    (status = 'pending' AND run_id IS NULL AND completed_at IS NULL
      AND last_error_code IS NULL)
    OR (status = 'running' AND run_id IS NOT NULL AND completed_at IS NULL
      AND last_error_code IS NULL)
    OR (status = 'complete' AND run_id IS NOT NULL AND completed_at IS NOT NULL
      AND last_error_code IS NULL)
    OR (status = 'failed' AND completed_at IS NOT NULL
      AND last_error_code IS NOT NULL)
  )
);

CREATE INDEX github_sync_dispatch_items_by_dispatch
  ON github_sync_dispatch_items(dispatch_id, status, item_id);
CREATE INDEX github_sync_dispatch_items_by_project
  ON github_sync_dispatch_items(project_id, repository_id, ref, scheduled_for);

CREATE TRIGGER github_sync_dispatch_items_identity_immutable
BEFORE UPDATE OF item_id, dispatch_id, project_id, repository_id, ref,
  scheduled_for, full_reconciliation, repository_configuration_version,
  cursor_version, selected_head_manifest_id, selected_head_version,
  repository_updated_at, cursor_status, cursor_updated_at,
  workflow_instance_id, created_at
ON github_sync_dispatch_items
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch item identity is immutable');
END;

CREATE TRIGGER github_sync_dispatch_items_terminal_immutable
BEFORE UPDATE ON github_sync_dispatch_items
WHEN OLD.status IN ('complete', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch item is terminal');
END;

CREATE TRIGGER github_sync_dispatch_items_transition_guard
BEFORE UPDATE OF status, run_id, completed_at, last_error_code
ON github_sync_dispatch_items
WHEN (
    OLD.status = 'pending'
    AND (
      (
        NEW.status = 'running' AND (
          NEW.run_id IS NULL OR NEW.completed_at IS NOT NULL
          OR NEW.last_error_code IS NOT NULL
        )
      )
      OR (
        NEW.status = 'failed' AND (
          NEW.run_id IS NOT NULL OR NEW.completed_at IS NULL
          OR NEW.last_error_code IS NULL
        )
      )
      OR NEW.status NOT IN ('running', 'failed')
    )
  )
  OR (
    OLD.status = 'running'
    AND (
      NEW.status NOT IN ('complete', 'failed')
      OR NEW.run_id IS NOT OLD.run_id OR NEW.completed_at IS NULL
      OR (NEW.status = 'complete' AND NEW.last_error_code IS NOT NULL)
      OR (NEW.status = 'failed' AND NEW.last_error_code IS NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch item transition is invalid');
END;

CREATE TRIGGER github_sync_dispatch_items_request_count_guard
BEFORE UPDATE OF github_request_count ON github_sync_dispatch_items
WHEN OLD.status <> 'running'
  OR NEW.status <> OLD.status
  OR NEW.github_request_count <= OLD.github_request_count
  OR NEW.github_request_count > OLD.github_request_count + 100
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch item request count update is invalid');
END;

CREATE TRIGGER github_sync_dispatch_items_no_delete
BEFORE DELETE ON github_sync_dispatch_items
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch items cannot be deleted');
END;

CREATE TABLE github_sync_dispatch_materialization_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 64 AND receipt_id NOT GLOB '*[^0-9a-f]*'
  ),
  dispatch_id TEXT NOT NULL UNIQUE,
  item_count INTEGER NOT NULL CHECK (
    typeof(item_count) = 'integer'
    AND item_count >= 0
    AND item_count < 9007199254740991
  ),
  completed_at TEXT NOT NULL,
  FOREIGN KEY (dispatch_id)
    REFERENCES github_sync_dispatches(dispatch_id),
  CHECK (
    length(completed_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
  )
);

CREATE TRIGGER github_sync_dispatch_materialization_receipts_insert_guard
BEFORE INSERT ON github_sync_dispatch_materialization_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM github_sync_dispatches AS dispatch
  WHERE dispatch.dispatch_id = NEW.dispatch_id
    AND dispatch.status IN ('dispatching', 'complete')
    AND (
      SELECT COUNT(*) FROM github_sync_dispatch_items AS item
      WHERE item.dispatch_id = dispatch.dispatch_id
    ) = NEW.item_count
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub dispatch materialization receipt state is invalid');
END;

CREATE TRIGGER github_sync_dispatch_materialization_receipts_no_update
BEFORE UPDATE ON github_sync_dispatch_materialization_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub dispatch materialization receipts are immutable');
END;

CREATE TRIGGER github_sync_dispatch_materialization_receipts_no_delete
BEFORE DELETE ON github_sync_dispatch_materialization_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM github_sync_dispatches AS dispatch
  WHERE dispatch.dispatch_id = OLD.dispatch_id
    AND dispatch.credential_version GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub dispatch materialization receipts are immutable');
END;

CREATE TABLE github_sync_dispatch_item_rejection_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 64 AND receipt_id NOT GLOB '*[^0-9a-f]*'
  ),
  dispatch_item_id TEXT NOT NULL UNIQUE,
  dispatch_id TEXT NOT NULL,
  credential_version TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  last_error_code TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (dispatch_item_id)
    REFERENCES github_sync_dispatch_items(item_id),
  FOREIGN KEY (dispatch_id)
    REFERENCES github_sync_dispatches(dispatch_id),
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id),
  CHECK (
    length(completed_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
  )
);

CREATE TRIGGER github_sync_dispatch_item_rejection_receipts_insert_guard
BEFORE INSERT ON github_sync_dispatch_item_rejection_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM github_sync_dispatch_items AS item
  JOIN github_sync_dispatches AS dispatch
    ON dispatch.dispatch_id = item.dispatch_id
  WHERE item.item_id = NEW.dispatch_item_id
    AND item.dispatch_id = NEW.dispatch_id
    AND dispatch.credential_version = NEW.credential_version
    AND item.project_id = NEW.project_id
    AND item.repository_id = NEW.repository_id
    AND item.ref = NEW.ref
    AND item.status = 'failed' AND item.run_id IS NULL
    AND item.last_error_code = NEW.last_error_code
    AND item.completed_at = NEW.completed_at
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub dispatch item rejection receipt state is invalid');
END;

CREATE TRIGGER github_sync_dispatch_item_rejection_receipts_no_update
BEFORE UPDATE ON github_sync_dispatch_item_rejection_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub dispatch item rejection receipts are immutable');
END;

CREATE TRIGGER github_sync_dispatch_item_rejection_receipts_no_delete
BEFORE DELETE ON github_sync_dispatch_item_rejection_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub dispatch item rejection receipts are immutable');
END;

CREATE TABLE github_credential_sync_lane (
  credential_version TEXT PRIMARY KEY CHECK (
    length(credential_version) BETWEEN 1 AND 128
    AND trim(credential_version) = credential_version
    AND instr(credential_version, char(0)) = 0
  ),
  holder_kind TEXT CHECK (holder_kind IN ('dispatch', 'ref')),
  holder_id TEXT,
  lease_claim_id TEXT CHECK (
    lease_claim_id IS NULL
    OR (length(lease_claim_id) = 64 AND lease_claim_id NOT GLOB '*[^0-9a-f]*')
  ),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(lease_epoch) = 'integer'
    AND lease_epoch >= 0
    AND lease_epoch < 9007199254740991
  ),
  lease_until TEXT,
  available_after TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (holder_kind IS NULL AND holder_id IS NULL AND lease_claim_id IS NULL AND lease_until IS NULL)
    OR (holder_kind IS NOT NULL AND holder_id IS NOT NULL AND lease_claim_id IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CHECK (
    lease_until IS NULL
    OR (
      length(lease_until) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) = lease_until
    )
  ),
  CHECK (
    length(available_after) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', available_after) = available_after
    AND length(updated_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
  )
);

CREATE TRIGGER github_credential_sync_lane_version_guard
BEFORE UPDATE ON github_credential_sync_lane
WHEN NEW.credential_version IS NOT OLD.credential_version
  OR NEW.lease_epoch < OLD.lease_epoch
  OR NEW.lease_epoch > OLD.lease_epoch + 1
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lane update is invalid');
END;

CREATE TRIGGER github_credential_sync_lane_transition_guard
BEFORE UPDATE ON github_credential_sync_lane
WHEN (
    NEW.holder_id IS NOT NULL
    AND (
      OLD.holder_kind IS NOT NEW.holder_kind
      OR OLD.holder_id IS NOT NEW.holder_id
      OR OLD.lease_claim_id IS NOT NEW.lease_claim_id
      OR OLD.lease_until IS NOT NEW.lease_until
    )
    AND NEW.lease_epoch <> OLD.lease_epoch + 1
  )
  OR (
    OLD.holder_id IS NOT NULL AND NEW.holder_id IS NULL
    AND NEW.lease_epoch <> OLD.lease_epoch
  )
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lane transition is invalid');
END;

CREATE TRIGGER github_credential_sync_lane_no_delete
BEFORE DELETE ON github_credential_sync_lane
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lanes cannot be deleted');
END;

CREATE TABLE github_credential_sync_lane_release_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 64 AND receipt_id NOT GLOB '*[^0-9a-f]*'
  ),
  credential_version TEXT NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('dispatch', 'ref')),
  holder_id TEXT NOT NULL CHECK (
    length(holder_id) BETWEEN 1 AND 128
    AND trim(holder_id) = holder_id
    AND instr(holder_id, char(0)) = 0
  ),
  lease_claim_id TEXT NOT NULL CHECK (
    length(lease_claim_id) = 64
    AND lease_claim_id NOT GLOB '*[^0-9a-f]*'
  ),
  lease_epoch INTEGER NOT NULL CHECK (
    typeof(lease_epoch) = 'integer'
    AND lease_epoch > 0
    AND lease_epoch < 9007199254740991
  ),
  lease_until TEXT NOT NULL,
  released_at TEXT NOT NULL,
  available_after TEXT NOT NULL,
  FOREIGN KEY (credential_version)
    REFERENCES github_credential_sync_lane(credential_version),
  UNIQUE (credential_version, lease_epoch),
  CHECK (
    length(lease_until) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) = lease_until
    AND length(released_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', released_at) = released_at
    AND length(available_after) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', available_after) = available_after
    AND available_after > released_at
  )
);

CREATE TRIGGER github_credential_sync_lane_release_receipts_insert_guard
BEFORE INSERT ON github_credential_sync_lane_release_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM github_credential_sync_lane AS lane
  WHERE lane.credential_version = NEW.credential_version
    AND lane.holder_kind = NEW.holder_kind
    AND lane.holder_id = NEW.holder_id
    AND lane.lease_claim_id = NEW.lease_claim_id
    AND lane.lease_epoch = NEW.lease_epoch
    AND lane.lease_until = NEW.lease_until
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lane release receipt state is invalid');
END;

CREATE TRIGGER github_credential_sync_lane_release_receipts_no_update
BEFORE UPDATE ON github_credential_sync_lane_release_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lane release receipts are immutable');
END;

CREATE TRIGGER github_credential_sync_lane_release_receipts_no_delete
BEFORE DELETE ON github_credential_sync_lane_release_receipts
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lane release receipts are immutable');
END;

CREATE TABLE github_repository_sync_finish_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (
    length(receipt_id) = 64 AND receipt_id NOT GLOB '*[^0-9a-f]*'
  ),
  run_id TEXT NOT NULL UNIQUE,
  dispatch_item_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'failed')),
  last_error_code TEXT,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (run_id)
    REFERENCES github_repository_sync_runs(run_id),
  FOREIGN KEY (dispatch_item_id)
    REFERENCES github_sync_dispatch_items(item_id),
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id),
  CHECK (
    length(completed_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
  )
);

CREATE TRIGGER github_repository_sync_finish_receipts_insert_guard
BEFORE INSERT ON github_repository_sync_finish_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM github_repository_sync_runs AS run
  JOIN github_sync_dispatch_items AS item
    ON item.item_id = NEW.dispatch_item_id
   AND item.run_id = run.run_id
  WHERE run.run_id = NEW.run_id
    AND run.project_id = NEW.project_id
    AND run.repository_id = NEW.repository_id
    AND run.claimed_ref = NEW.ref
    AND run.status = NEW.status
    AND run.last_error_code IS NEW.last_error_code
    AND run.completed_at = NEW.completed_at
    AND item.project_id = NEW.project_id
    AND item.repository_id = NEW.repository_id
    AND item.ref = NEW.ref
    AND item.status = NEW.status
    AND item.last_error_code IS NEW.last_error_code
    AND item.completed_at = NEW.completed_at
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository sync finish receipt state is invalid');
END;

CREATE TRIGGER github_repository_sync_finish_receipts_no_update
BEFORE UPDATE ON github_repository_sync_finish_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository sync finish receipts are immutable');
END;

CREATE TRIGGER github_repository_sync_finish_receipts_no_delete
BEFORE DELETE ON github_repository_sync_finish_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository sync finish receipts are immutable');
END;

DROP TRIGGER IF EXISTS synthetic_cleanup_registry_delete_child_guard;
CREATE TRIGGER synthetic_cleanup_registry_delete_child_guard
BEFORE DELETE ON synthetic_cleanup_registry
WHEN EXISTS (SELECT 1 FROM consolidation_outputs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM consolidation_inputs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM consolidation_batch_receipts WHERE project_id = OLD.project_id)
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
  OR EXISTS (SELECT 1 FROM github_repository_sync_finish_receipts WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_sync_dispatch_item_rejection_receipts WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_sync_dispatch_items WHERE project_id = OLD.project_id)
  OR EXISTS (
    SELECT 1 FROM github_sync_dispatch_materialization_receipts AS receipt
    JOIN github_sync_dispatches AS dispatch
      ON dispatch.dispatch_id = receipt.dispatch_id
    WHERE dispatch.credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_sync_dispatches
    WHERE credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_credential_sync_lane_release_receipts
    WHERE credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (
    SELECT 1 FROM github_credential_sync_lane
    WHERE credential_version = 'system.synthetic.' || OLD.project_id
  )
  OR EXISTS (SELECT 1 FROM github_tree_activation_receipts WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_activation_witnesses WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_repository_sync_runs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_ref_heads WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_manifest_deltas WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_manifest_lifecycle_events WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_manifest_entries WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM github_tree_manifests WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM sync_cursors WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM project_grant_repository_contexts WHERE project_id = OLD.project_id)
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
