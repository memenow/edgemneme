-- EdgeMneme authority schema (squashed terminal state of migrations 0001-0021).
-- The service is pre-launch; this single migration creates the final schema directly.

PRAGMA foreign_keys = ON;

CREATE TABLE audit_events (
  audit_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  request_digest TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (project_id, sequence),
  UNIQUE (project_id, event_hash),
  UNIQUE (project_id, audit_id)
);

CREATE TABLE conflicts (
  conflict_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  left_memory_id TEXT NOT NULL,
  right_memory_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  relation TEXT NOT NULL,
  confidence REAL,
  audit_id TEXT REFERENCES audit_events(audit_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, conflict_id),
  FOREIGN KEY (project_id, left_memory_id) REFERENCES memories(project_id, memory_id),
  FOREIGN KEY (project_id, right_memory_id) REFERENCES memories(project_id, memory_id)
);

CREATE TABLE consolidation_batch_receipts (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  consolidation_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL CHECK (
    typeof(batch_index) = 'integer'
    AND batch_index >= 0
    AND batch_index <= 900719925474098
  ),
  lease_owner TEXT NOT NULL CHECK (
    length(lease_owner) BETWEEN 1 AND 512
    AND trim(lease_owner) = lease_owner
  ),
  lease_claim_id TEXT NOT NULL CHECK (
    length(lease_claim_id) = 36
    AND lower(lease_claim_id) = lease_claim_id
    AND lease_claim_id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(lease_claim_id, '-', '')) = 32
    AND substr(lease_claim_id, 9, 1) = '-'
    AND substr(lease_claim_id, 14, 1) = '-'
    AND substr(lease_claim_id, 15, 1) = '4'
    AND substr(lease_claim_id, 19, 1) = '-'
    AND substr(lease_claim_id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(lease_claim_id, 24, 1) = '-'
  ),
  lease_epoch INTEGER NOT NULL CHECK (
    typeof(lease_epoch) = 'integer'
    AND lease_epoch >= 1
    AND lease_epoch <= 9007199254740991
  ),
  lease_operation_id TEXT NOT NULL CHECK (
    length(lease_operation_id) = 36
    AND lower(lease_operation_id) = lease_operation_id
    AND lease_operation_id NOT GLOB '*[^0-9a-f-]*'
    AND length(replace(lease_operation_id, '-', '')) = 32
    AND substr(lease_operation_id, 9, 1) = '-'
    AND substr(lease_operation_id, 14, 1) = '-'
    AND substr(lease_operation_id, 15, 1) = '4'
    AND substr(lease_operation_id, 19, 1) = '-'
    AND substr(lease_operation_id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(lease_operation_id, 24, 1) = '-'
  ),
  batch_input_digest TEXT NOT NULL CHECK (
    length(batch_input_digest) = 64
    AND batch_input_digest NOT GLOB '*[^0-9a-f]*'
  ),
  model_result_digest TEXT NOT NULL CHECK (
    length(model_result_digest) = 64
    AND model_result_digest NOT GLOB '*[^0-9a-f]*'
  ),
  output_manifest_json TEXT NOT NULL CHECK (
    json_valid(output_manifest_json)
    AND json_type(output_manifest_json) = 'array'
  ),
  output_manifest_digest TEXT NOT NULL CHECK (
    length(output_manifest_digest) = 64
    AND output_manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  suggestion_count INTEGER NOT NULL CHECK (
    typeof(suggestion_count) = 'integer'
    AND suggestion_count BETWEEN 0 AND 10
    AND json_array_length(output_manifest_json) = suggestion_count
  ),
  completed_at TEXT NOT NULL CHECK (
    length(completed_at) = 24
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+0 seconds') IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+0 seconds') = completed_at
  ),
  PRIMARY KEY (project_id, consolidation_id, batch_index),
  FOREIGN KEY (project_id, consolidation_id)
    REFERENCES session_consolidations(project_id, consolidation_id)
);

CREATE TABLE consolidation_inputs (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  consolidation_id TEXT NOT NULL,
  input_order INTEGER NOT NULL CHECK (input_order >= 0),
  input_kind TEXT NOT NULL CHECK (input_kind IN ('summary', 'candidate')),
  source_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  PRIMARY KEY (project_id, consolidation_id, input_order),
  UNIQUE (project_id, consolidation_id, input_kind, source_id),
  FOREIGN KEY (project_id, consolidation_id)
    REFERENCES session_consolidations(project_id, consolidation_id)
);

CREATE TABLE consolidation_outputs (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  consolidation_id TEXT NOT NULL,
  output_order INTEGER NOT NULL CHECK (output_order >= 0),
  candidate_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, consolidation_id, output_order),
  UNIQUE (project_id, candidate_id),
  FOREIGN KEY (project_id, consolidation_id)
    REFERENCES session_consolidations(project_id, consolidation_id),
  FOREIGN KEY (project_id, candidate_id)
    REFERENCES observations(project_id, observation_id)
);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  source_type TEXT NOT NULL,
  locator TEXT NOT NULL,
  repository_id TEXT REFERENCES repositories(repository_id),
  commit_sha TEXT,
  excerpt_hash TEXT NOT NULL,
  object_uri TEXT,
  sensitivity_status TEXT NOT NULL CHECK (
    sensitivity_status IN ('clear', 'quarantined', 'tombstone')
  ),
  recorded_at TEXT NOT NULL, repository_ref TEXT CHECK (
  repository_ref IS NULL OR (
    length(repository_ref) > 0
    AND trim(repository_ref) = repository_ref
    AND instr(repository_ref, char(0)) = 0
  )
), repository_path TEXT CHECK (
  repository_path IS NULL OR (
    length(repository_path) > 0
    AND substr(repository_path, 1, 1) <> '/'
    AND instr(repository_path, char(0)) = 0
    AND instr(repository_path, char(92)) = 0
  )
), repository_authority TEXT CHECK (
  repository_authority IS NULL OR repository_authority IN (
    'default_branch', 'tracked_ref', 'agent_supplied'
  )
),
  UNIQUE (project_id, source_type, locator, excerpt_hash),
  UNIQUE (project_id, evidence_id),
  FOREIGN KEY (project_id, repository_id) REFERENCES repositories(project_id, repository_id)
);

CREATE TABLE github_access_baselines (
  credential_version TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  repositories_json TEXT NOT NULL CHECK (json_valid(repositories_json)),
  approved_by_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  approval_audit_id TEXT,
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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

CREATE TABLE github_rate_observations (
  observation_id TEXT PRIMARY KEY,
  credential_version TEXT NOT NULL,
  resource TEXT,
  rate_limit INTEGER CHECK (rate_limit IS NULL OR rate_limit >= 0),
  remaining INTEGER CHECK (remaining IS NULL OR remaining >= 0),
  used INTEGER CHECK (used IS NULL OR used >= 0),
  reset_at TEXT,
  retry_after_ms INTEGER CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
  observed_at TEXT NOT NULL,
  FOREIGN KEY (credential_version)
    REFERENCES github_access_baselines(credential_version)
);

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

CREATE TABLE "github_repository_sync_runs" (
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
  last_error_code TEXT, github_request_overflow_count INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(github_request_overflow_count) = 'integer'
      AND github_request_overflow_count BETWEEN 0 AND 8
    ),
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

CREATE TABLE github_tree_manifest_deltas (
  delta_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  old_manifest_id TEXT,
  new_manifest_id TEXT NOT NULL,
  path_digest TEXT NOT NULL CHECK (
    length(path_digest) = 64
    AND path_digest NOT GLOB '*[^0-9a-f]*'
  ),
  safe_path TEXT,
  change_kind TEXT NOT NULL CHECK (
    change_kind IN ('added', 'changed', 'deleted', 'withdrawn')
  ),
  old_blob_sha TEXT CHECK (
    old_blob_sha IS NULL
    OR (
      length(old_blob_sha) BETWEEN 40 AND 128
      AND old_blob_sha NOT GLOB '*[^0-9A-Fa-f]*'
    )
  ),
  new_blob_sha TEXT CHECK (
    new_blob_sha IS NULL
    OR (
      length(new_blob_sha) BETWEEN 40 AND 128
      AND new_blob_sha NOT GLOB '*[^0-9A-Fa-f]*'
    )
  ),
  old_disposition TEXT CHECK (
    old_disposition IS NULL
    OR old_disposition IN (
      'text', 'binary_excluded', 'generated_excluded',
      'sensitive_tombstone', 'partial'
    )
  ),
  new_disposition TEXT CHECK (
    new_disposition IS NULL
    OR new_disposition IN (
      'text', 'binary_excluded', 'generated_excluded',
      'sensitive_tombstone', 'partial'
    )
  ),
  affected_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(affected_memory_ids_json)
    AND json_type(affected_memory_ids_json) = 'array'
  ),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, repository_id, ref, old_manifest_id)
    REFERENCES github_tree_manifests(project_id, repository_id, ref, manifest_id),
  FOREIGN KEY (project_id, repository_id, ref, new_manifest_id)
    REFERENCES github_tree_manifests(project_id, repository_id, ref, manifest_id),
  UNIQUE (project_id, delta_id),
  UNIQUE (project_id, old_manifest_id, new_manifest_id, path_digest),
  UNIQUE (project_id, idempotency_key),
  CHECK (
    (
      change_kind = 'added'
      AND old_blob_sha IS NULL
      AND old_disposition IS NULL
      AND new_blob_sha IS NOT NULL
      AND new_disposition IS NOT NULL
    )
    OR
    (
      change_kind = 'changed'
      AND old_manifest_id IS NOT NULL
      AND old_blob_sha IS NOT NULL
      AND new_blob_sha IS NOT NULL
      AND old_disposition IS NOT NULL
      AND new_disposition IS NOT NULL
      AND (
        old_blob_sha <> new_blob_sha
        OR old_disposition <> new_disposition
      )
      AND NOT (
        old_disposition = 'text'
        AND new_disposition IN (
          'binary_excluded', 'generated_excluded', 'sensitive_tombstone'
        )
      )
    )
    OR
    (
      change_kind = 'deleted'
      AND old_manifest_id IS NOT NULL
      AND old_blob_sha IS NOT NULL
      AND old_disposition IS NOT NULL
      AND new_blob_sha IS NULL
      AND new_disposition IS NULL
    )
    OR
    (
      change_kind = 'withdrawn'
      AND safe_path IS NULL
      AND old_manifest_id IS NOT NULL
      AND old_blob_sha IS NOT NULL
      AND new_blob_sha IS NOT NULL
      AND old_disposition = 'text'
      AND new_disposition IN (
        'binary_excluded', 'generated_excluded', 'sensitive_tombstone'
      )
    )
  )
);

CREATE TABLE github_tree_manifest_entries (
  project_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  path_digest TEXT NOT NULL CHECK (
    length(path_digest) = 64
    AND path_digest NOT GLOB '*[^0-9a-f]*'
  ),
  safe_path TEXT CHECK (
    safe_path IS NULL
    OR (
      length(safe_path) > 0
      AND substr(safe_path, 1, 1) <> '/'
      AND instr(safe_path, char(0)) = 0
      AND instr(safe_path, char(92)) = 0
    )
  ),
  blob_sha TEXT NOT NULL CHECK (
    length(blob_sha) BETWEEN 40 AND 128
    AND blob_sha NOT GLOB '*[^0-9A-Fa-f]*'
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  disposition TEXT NOT NULL CHECK (
    disposition IN (
      'text', 'binary_excluded', 'generated_excluded',
      'sensitive_tombstone', 'partial'
    )
  ),
  CHECK (disposition <> 'sensitive_tombstone' OR safe_path IS NULL),
  PRIMARY KEY (project_id, manifest_id, path_digest),
  FOREIGN KEY (project_id, manifest_id)
    REFERENCES github_tree_manifests(project_id, manifest_id)
);

CREATE TABLE github_tree_manifest_lifecycle_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) = 64
    AND event_id NOT GLOB '*[^0-9a-f]*'
  ),
  project_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  retention_version INTEGER NOT NULL CHECK (
    typeof(retention_version) = 'integer' AND retention_version >= 0
  ),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('failed', 'purge_chunk', 'purged')
  ),
  failure_code TEXT NOT NULL CHECK (failure_code IN (
    'GITHUB_AUTHORIZATION_REQUIRED',
    'GITHUB_CREDENTIAL_EXPIRED',
    'GITHUB_SSO_REQUIRED',
    'GITHUB_CLASSIC_PAT_BLOCKED',
    'GITHUB_PERMISSION_INSUFFICIENT',
    'GITHUB_REPOSITORY_UNAVAILABLE',
    'GITHUB_RATE_LIMITED',
    'GITHUB_PARTIAL_SYNC',
    'GITHUB_RECONCILIATION_REQUIRED'
  )),
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  entries_checksum TEXT NOT NULL CHECK (
    length(entries_checksum) = 64
    AND entries_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  chunk_entry_count INTEGER CHECK (
    chunk_entry_count IS NULL
    OR (chunk_entry_count BETWEEN 1 AND 500)
  ),
  chunk_digest TEXT CHECK (
    chunk_digest IS NULL
    OR (
      length(chunk_digest) = 64
      AND chunk_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) = recorded_at
  ),
  FOREIGN KEY (project_id, manifest_id)
    REFERENCES github_tree_manifests(project_id, manifest_id),
  UNIQUE (project_id, manifest_id, event_id),
  CHECK (
    (event_type IN ('failed', 'purged')
      AND chunk_entry_count IS NULL AND chunk_digest IS NULL)
    OR
    (event_type = 'purge_chunk'
      AND chunk_entry_count IS NOT NULL AND chunk_digest IS NOT NULL)
  )
);

CREATE TABLE github_tree_manifest_retention_cursors (
  lane TEXT PRIMARY KEY CHECK (lane IN ('staging', 'failed')),
  after_project_id TEXT NOT NULL,
  after_manifest_id TEXT NOT NULL,
  cursor_version INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(cursor_version) = 'integer' AND cursor_version >= 0
  ),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
  ),
  CHECK (
    (after_project_id = '' AND after_manifest_id = '')
    OR (
      length(after_project_id) > 0
      AND instr(after_project_id, char(0)) = 0
      AND length(after_manifest_id) = 64
      AND after_manifest_id NOT GLOB '*[^0-9a-f]*'
    )
  )
);

CREATE TABLE github_tree_manifests (
  manifest_id TEXT PRIMARY KEY CHECK (
    length(manifest_id) = 64
    AND manifest_id NOT GLOB '*[^0-9a-f]*'
  ),
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL CHECK (
    length(ref) > 0
    AND trim(ref) = ref
    AND instr(ref, char(0)) = 0
  ),
  observed_sha TEXT NOT NULL CHECK (
    length(observed_sha) BETWEEN 40 AND 128
    AND observed_sha NOT GLOB '*[^0-9A-Fa-f]*'
  ),
  tree_sha TEXT NOT NULL CHECK (
    length(tree_sha) BETWEEN 40 AND 128
    AND tree_sha NOT GLOB '*[^0-9A-Fa-f]*'
  ),
  repository_authority TEXT NOT NULL CHECK (
    repository_authority IN ('default_branch', 'tracked_ref')
  ),
  collection_key TEXT NOT NULL CHECK (
    length(collection_key) > 0
    AND instr(collection_key, char(0)) = 0
  ),
  status TEXT NOT NULL CHECK (
    status IN ('staging', 'complete', 'failed', 'purging', 'purged')
  ),
  entry_count INTEGER CHECK (entry_count IS NULL OR entry_count >= 0),
  entries_checksum TEXT CHECK (
    entries_checksum IS NULL
    OR (
      length(entries_checksum) = 64
      AND entries_checksum NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'GITHUB_AUTHORIZATION_REQUIRED',
      'GITHUB_CREDENTIAL_EXPIRED',
      'GITHUB_SSO_REQUIRED',
      'GITHUB_CLASSIC_PAT_BLOCKED',
      'GITHUB_PERMISSION_INSUFFICIENT',
      'GITHUB_REPOSITORY_UNAVAILABLE',
      'GITHUB_RATE_LIMITED',
      'GITHUB_PARTIAL_SYNC',
      'GITHUB_RECONCILIATION_REQUIRED'
    )
  ),
  retention_version INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(retention_version) = 'integer' AND retention_version >= 0
  ),
  retention_attempt INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(retention_attempt) = 'integer' AND retention_attempt >= 0
  ),
  retention_next_attempt_at TEXT,
  purge_token TEXT CHECK (
    purge_token IS NULL
    OR (
      length(purge_token) = 64
      AND purge_token NOT GLOB '*[^0-9a-f]*'
    )
  ),
  purge_lease_until TEXT,
  purged_at TEXT,
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id),
  UNIQUE (project_id, manifest_id),
  UNIQUE (project_id, repository_id, ref, manifest_id),
  UNIQUE (project_id, repository_id, ref, collection_key),
  CHECK (
    (status = 'staging' AND entry_count IS NULL
      AND entries_checksum IS NULL AND completed_at IS NULL
      AND failed_at IS NULL AND failure_code IS NULL
      AND retention_version = 0 AND retention_attempt = 0
      AND retention_next_attempt_at IS NULL AND purge_token IS NULL
      AND purge_lease_until IS NULL AND purged_at IS NULL)
    OR
    (status = 'complete' AND entry_count IS NOT NULL
      AND entries_checksum IS NOT NULL AND completed_at IS NOT NULL
      AND failed_at IS NULL AND failure_code IS NULL
      AND retention_version = 0 AND retention_attempt = 0
      AND retention_next_attempt_at IS NULL AND purge_token IS NULL
      AND purge_lease_until IS NULL AND purged_at IS NULL)
    OR
    (status = 'failed' AND entry_count IS NOT NULL
      AND entries_checksum IS NOT NULL AND completed_at IS NULL
      AND failed_at IS NOT NULL AND failure_code IS NOT NULL
      AND retention_version = 0 AND retention_attempt = 0
      AND retention_next_attempt_at IS NULL AND purge_token IS NULL
      AND purge_lease_until IS NULL AND purged_at IS NULL)
    OR
    (status = 'purging' AND entry_count IS NOT NULL
      AND entries_checksum IS NOT NULL AND completed_at IS NULL
      AND failed_at IS NOT NULL AND failure_code IS NOT NULL
      AND retention_version >= 1 AND retention_attempt >= 1
      AND retention_next_attempt_at IS NOT NULL AND purge_token IS NOT NULL
      AND purge_lease_until IS NOT NULL AND purged_at IS NULL)
    OR
    (status = 'purged' AND entry_count IS NOT NULL
      AND entries_checksum IS NOT NULL AND completed_at IS NULL
      AND failed_at IS NOT NULL AND failure_code IS NOT NULL
      AND retention_version >= 2 AND retention_attempt >= 1
      AND retention_next_attempt_at IS NULL AND purge_token IS NULL
      AND purge_lease_until IS NULL AND purged_at IS NOT NULL)
  ),
  CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    AND (
      completed_at IS NULL
      OR (
        strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
      )
    )
    AND (
      failed_at IS NULL
      OR (
        strftime('%Y-%m-%dT%H:%M:%fZ', failed_at) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', failed_at) = failed_at
      )
    )
    AND (
      retention_next_attempt_at IS NULL
      OR (
        strftime(
          '%Y-%m-%dT%H:%M:%fZ', retention_next_attempt_at
        ) IS NOT NULL
        AND strftime(
          '%Y-%m-%dT%H:%M:%fZ', retention_next_attempt_at
        ) = retention_next_attempt_at
      )
    )
    AND (
      purge_lease_until IS NULL
      OR (
        strftime('%Y-%m-%dT%H:%M:%fZ', purge_lease_until) IS NOT NULL
        AND strftime(
          '%Y-%m-%dT%H:%M:%fZ', purge_lease_until
        ) = purge_lease_until
      )
    )
    AND (
      purged_at IS NULL
      OR (
        strftime('%Y-%m-%dT%H:%M:%fZ', purged_at) IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', purged_at) = purged_at
      )
    )
  )
);

CREATE TABLE github_tree_ref_heads (
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  head_version INTEGER NOT NULL CHECK (head_version >= 1),
  activated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, repository_id, ref),
  FOREIGN KEY (project_id, repository_id, ref, manifest_id)
    REFERENCES github_tree_manifests(project_id, repository_id, ref, manifest_id)
);

CREATE TABLE idempotency_records (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  audit_id TEXT REFERENCES audit_events(audit_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, principal_id, operation, idempotency_key)
);

CREATE TABLE memories (
  memory_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  current_revision_id TEXT,
  memory_version INTEGER NOT NULL DEFAULT 0 CHECK (memory_version >= 0),
  kind TEXT NOT NULL CHECK (
    kind IN ('decision', 'fact', 'convention', 'procedure', 'learning', 'incident', 'reference', 'feedback')
  ),
  memory_class TEXT NOT NULL CHECK (memory_class IN ('semantic', 'procedural', 'episodic')),
  scope TEXT NOT NULL CHECK (scope IN ('project', 'repository', 'ref', 'worktree', 'session')),
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'contested', 'superseded', 'invalidated', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, memory_id),
  UNIQUE (project_id, current_revision_id)
);

CREATE TABLE memory_repository_contexts (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  memory_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, memory_id),
  FOREIGN KEY (project_id, memory_id)
    REFERENCES memories(project_id, memory_id),
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id)
);

CREATE TABLE memory_versions (
  revision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  memory_id TEXT NOT NULL REFERENCES memories(memory_id),
  memory_version INTEGER NOT NULL CHECK (memory_version >= 1),
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  audit_id TEXT NOT NULL,
  source_observation_id TEXT,
  recorded_at TEXT NOT NULL,
  UNIQUE (project_id, memory_id, memory_version),
  UNIQUE (project_id, revision_id),
  FOREIGN KEY (project_id, memory_id) REFERENCES memories(project_id, memory_id),
  FOREIGN KEY (project_id, audit_id) REFERENCES audit_events(project_id, audit_id),
  FOREIGN KEY (project_id, source_observation_id)
    REFERENCES observations(project_id, observation_id)
);

CREATE TABLE observation_evidence (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  observation_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, observation_id, evidence_id),
  FOREIGN KEY (project_id, observation_id)
    REFERENCES observations(project_id, observation_id),
  FOREIGN KEY (project_id, evidence_id)
    REFERENCES evidence(project_id, evidence_id)
);

CREATE TABLE observations (
  observation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  session_id TEXT REFERENCES sessions(session_id),
  principal_id TEXT REFERENCES principals(principal_id),
  candidate_version INTEGER NOT NULL DEFAULT 1 CHECK (candidate_version >= 1),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'pending_review', 'approved', 'rejected', 'request_changes',
      'rejected_sensitive', 'promoted', 'noop'
    )
  ),
  content TEXT,
  content_sha256 TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  kind TEXT CHECK (
    kind IS NULL OR kind IN (
      'decision', 'fact', 'convention', 'procedure', 'learning', 'incident', 'reference', 'feedback'
    )
  ),
  memory_class TEXT CHECK (
    memory_class IS NULL OR memory_class IN ('semantic', 'procedural', 'episodic')
  ),
  scope TEXT CHECK (
    scope IS NULL OR scope IN ('project', 'repository', 'ref', 'worktree', 'session')
  ),
  scope_id TEXT,
  valid_from TEXT,
  valid_until TEXT,
  analysis_json TEXT CHECK (analysis_json IS NULL OR json_valid(analysis_json)),
  review_reason TEXT,
  reviewed_content TEXT,
  promoted_memory_id TEXT,
  promoted_revision_id TEXT,
  source_consolidation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, session_id),
  UNIQUE (project_id, observation_id)
);

CREATE TABLE outbox_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  project_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  dispatched_at TEXT,
  next_attempt_at TEXT,
  failed_at TEXT,
  last_error_code TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at TEXT NOT NULL
, projection_unknown_count INTEGER NOT NULL DEFAULT 0
CHECK (projection_unknown_count BETWEEN 0 AND 12), projection_unknown_first_observed_at TEXT, projection_unknown_last_observed_at TEXT, projection_unknown_alerted_at TEXT);

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (issuer, subject)
);

CREATE TABLE project_grant_repository_contexts (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  grant_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, grant_id),
  FOREIGN KEY (project_id, grant_id)
    REFERENCES project_grants(project_id, grant_id),
  FOREIGN KEY (project_id, repository_id)
    REFERENCES repositories(project_id, repository_id)
);

CREATE TABLE project_grants (
  grant_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  role TEXT NOT NULL CHECK (role IN ('reader', 'writer', 'maintainer')),
  scope_kind TEXT NOT NULL DEFAULT 'project' CHECK (
    scope_kind IN ('project', 'repository', 'ref', 'worktree', 'session')
  ),
  scope_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (project_id, principal_id, scope_kind, scope_id)
);

CREATE TABLE projection_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  project_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'active', 'superseded', 'failed')),
  manifest_key TEXT,
  manifest_sha256 TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (project_id, project_version)
);

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  project_ref TEXT NOT NULL UNIQUE,
  locator TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  project_version INTEGER NOT NULL DEFAULT 0 CHECK (project_version >= 0),
  audit_head_hash TEXT,
  active_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE repositories (
  repository_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  provider TEXT NOT NULL,
  external_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT,
  tracked_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tracked_refs_json)),
  sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (sync_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, expected_owner_external_id INTEGER
    CHECK (
      expected_owner_external_id IS NULL
      OR (
        typeof(expected_owner_external_id) = 'integer'
        AND expected_owner_external_id > 0
      )
    ), github_sync_configuration_version INTEGER NOT NULL DEFAULT 1
    CHECK (
      typeof(github_sync_configuration_version) = 'integer'
      AND github_sync_configuration_version >= 1
      AND github_sync_configuration_version <= 9007199254740991
    ),
  UNIQUE (project_id, provider, external_id),
  UNIQUE (project_id, repository_id)
);

CREATE TABLE review_decisions (
  decision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  review_request_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_version INTEGER NOT NULL CHECK (candidate_version >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'request_changes')),
  reason TEXT NOT NULL,
  edits_json TEXT CHECK (edits_json IS NULL OR json_valid(edits_json)),
  actor_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  audit_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, decision_id),
  UNIQUE (project_id, candidate_id, candidate_version),
  FOREIGN KEY (project_id, review_request_id)
    REFERENCES review_requests(project_id, review_request_id),
  FOREIGN KEY (project_id, candidate_id)
    REFERENCES observations(project_id, observation_id),
  FOREIGN KEY (project_id, audit_id)
    REFERENCES audit_events(project_id, audit_id)
);

CREATE TABLE review_requests (
  review_request_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  candidate_id TEXT,
  conflict_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'rejected', 'changes_requested', 'cancelled')
  ),
  required_role TEXT NOT NULL DEFAULT 'maintainer',
  audit_id TEXT REFERENCES audit_events(audit_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (candidate_id IS NOT NULL AND conflict_id IS NULL)
    OR (candidate_id IS NULL AND conflict_id IS NOT NULL)
  ),
  UNIQUE (project_id, review_request_id),
  UNIQUE (project_id, candidate_id),
  FOREIGN KEY (project_id, candidate_id)
    REFERENCES observations(project_id, observation_id),
  FOREIGN KEY (project_id, conflict_id)
    REFERENCES conflicts(project_id, conflict_id)
);

CREATE TABLE session_consolidations (
  consolidation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  session_id TEXT NOT NULL,
  session_version INTEGER NOT NULL CHECK (session_version >= 2),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'complete', 'failed', 'noop')
  ),
  input_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, lease_operation_id TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (
    typeof(lease_epoch) = 'integer'
    AND lease_epoch >= 0
    AND lease_epoch <= 9007199254740991
  ), lease_claim_id TEXT, receipt_post_state_valid INTEGER NOT NULL
  DEFAULT 1 CHECK (receipt_post_state_valid IN (0, 1)),
  UNIQUE (project_id, consolidation_id),
  UNIQUE (project_id, session_id, session_version),
  FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, session_id)
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'expired')),
  agent_meta_json TEXT NOT NULL CHECK (json_valid(agent_meta_json)),
  worktree_meta_json TEXT CHECK (worktree_meta_json IS NULL OR json_valid(worktree_meta_json)),
  summary TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT, repository_id TEXT REFERENCES repositories(repository_id), repository_ref TEXT CHECK (
  repository_ref IS NULL OR (
    length(repository_ref) > 0
    AND trim(repository_ref) = repository_ref
    AND instr(repository_ref, char(0)) = 0
  )
), worktree_id TEXT CHECK (
  worktree_id IS NULL OR (
    length(worktree_id) > 0
    AND trim(worktree_id) = worktree_id
    AND instr(worktree_id, char(0)) = 0
  )
), worktree_scope_id TEXT CHECK (
  worktree_scope_id IS NULL OR (
    length(worktree_scope_id) > 0
    AND trim(worktree_scope_id) = worktree_scope_id
    AND instr(worktree_scope_id, char(0)) = 0
  )
),
  UNIQUE (project_id, session_id)
);

CREATE TABLE sync_cursors (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
  ref TEXT NOT NULL,
  observed_sha TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (
    status IN ('idle', 'observed', 'pending_review', 'complete', 'failed', 'paused')
  ),
  etag TEXT,
  last_sync_at TEXT,
  next_sync_at TEXT,
  history_gap_possible INTEGER NOT NULL DEFAULT 0 CHECK (history_gap_possible IN (0, 1)),
  credential_status TEXT NOT NULL DEFAULT 'unknown',
  last_error_code TEXT,
  updated_at TEXT NOT NULL, ref_scope_id TEXT CHECK (
  ref_scope_id IS NULL OR (
    length(ref_scope_id) > 0
    AND trim(ref_scope_id) = ref_scope_id
    AND instr(ref_scope_id, char(0)) = 0
  )
), cursor_version INTEGER NOT NULL DEFAULT 1
    CHECK (
      typeof(cursor_version) = 'integer'
      AND cursor_version >= 1
      AND cursor_version <= 9007199254740991
    ),
  PRIMARY KEY (project_id, repository_id, ref)
);

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
  ), cleanup_fenced_at TEXT CHECK (
    cleanup_fenced_at IS NULL OR (
      julianday(cleanup_fenced_at) IS NOT NULL
      AND length(cleanup_fenced_at) >= 20
      AND substr(cleanup_fenced_at, 11, 1) = 'T'
      AND substr(cleanup_fenced_at, -1, 1) = 'Z'
    )
  ), cleanup_claim_id TEXT CHECK (
    cleanup_claim_id IS NULL OR (
      length(cleanup_claim_id) > 0 AND instr(cleanup_claim_id, char(0)) = 0
    )
  ), cleanup_claim_expires_at TEXT CHECK (
    cleanup_claim_expires_at IS NULL OR (
      julianday(cleanup_claim_expires_at) IS NOT NULL
      AND length(cleanup_claim_expires_at) >= 20
      AND substr(cleanup_claim_expires_at, 11, 1) = 'T'
      AND substr(cleanup_claim_expires_at, -1, 1) = 'Z'
    )
  ),
  CHECK (julianday(expires_at) > julianday(created_at))
);

CREATE TABLE taxonomy_policies (
  policy_revision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  audit_id TEXT REFERENCES audit_events(audit_id),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, policy_version)
);

CREATE TABLE version_evidence (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  revision_id TEXT NOT NULL REFERENCES memory_versions(revision_id),
  evidence_id TEXT NOT NULL REFERENCES evidence(evidence_id),
  PRIMARY KEY (project_id, revision_id, evidence_id),
  FOREIGN KEY (project_id, revision_id)
    REFERENCES memory_versions(project_id, revision_id),
  FOREIGN KEY (project_id, evidence_id)
    REFERENCES evidence(project_id, evidence_id)
);

CREATE TABLE workflow_runs (
  workflow_id TEXT PRIMARY KEY,
  root_workflow_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  workflow_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'waiting', 'paused', 'complete', 'failed', 'terminated')
  ),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIEW canonical_repository_scope_ownership AS
SELECT repository.project_id, 'repository' AS scope_kind,
       repository.repository_id AS scope_id, repository.repository_id,
       repository.repository_id AS source_id
FROM repositories AS repository
UNION ALL
SELECT session_record.project_id, 'session', session_record.session_id,
       session_record.repository_id, session_record.session_id
FROM sessions AS session_record
WHERE session_record.repository_id IS NOT NULL
UNION ALL
SELECT cursor.project_id, 'ref', cursor.ref_scope_id,
       cursor.repository_id, cursor.ref
FROM sync_cursors AS cursor
WHERE cursor.ref_scope_id IS NOT NULL
UNION ALL
SELECT session_record.project_id, 'worktree', session_record.worktree_scope_id,
       session_record.repository_id, session_record.session_id
FROM sessions AS session_record
WHERE session_record.repository_id IS NOT NULL
  AND session_record.worktree_id IS NOT NULL
  AND session_record.worktree_scope_id IS NOT NULL;

CREATE VIEW invalid_canonical_repository_scope_ownership AS
SELECT 'grant' AS entity_kind, grant_record.project_id,
       grant_record.grant_id AS entity_id
FROM project_grants AS grant_record
LEFT JOIN project_grant_repository_contexts AS grant_context
  ON grant_context.project_id = grant_record.project_id
 AND grant_context.grant_id = grant_record.grant_id
WHERE (
    grant_record.scope_kind = 'project'
    AND (
      grant_record.scope_id <> grant_record.project_id
      OR grant_context.grant_id IS NOT NULL
    )
  )
  OR (
    grant_record.scope_kind <> 'project'
    AND NOT EXISTS (
      SELECT 1
      FROM canonical_repository_scope_ownership AS ownership
      WHERE ownership.project_id = grant_record.project_id
        AND ownership.scope_kind = grant_record.scope_kind
        AND ownership.scope_id = grant_record.scope_id
        AND ownership.repository_id = grant_context.repository_id
    )
  )
UNION ALL
SELECT 'memory', memory_record.project_id, memory_record.memory_id
FROM memories AS memory_record
LEFT JOIN memory_repository_contexts AS memory_context
  ON memory_context.project_id = memory_record.project_id
 AND memory_context.memory_id = memory_record.memory_id
WHERE (
    memory_record.scope = 'project'
    AND (
      memory_record.scope_id <> memory_record.project_id
      OR memory_context.memory_id IS NOT NULL
    )
  )
  OR (
    memory_record.scope <> 'project'
    AND NOT EXISTS (
      SELECT 1
      FROM canonical_repository_scope_ownership AS ownership
      WHERE ownership.project_id = memory_record.project_id
        AND ownership.scope_kind = memory_record.scope
        AND ownership.scope_id = memory_record.scope_id
        AND ownership.repository_id = memory_context.repository_id
    )
  );

CREATE VIEW invalid_session_repository_metadata AS
SELECT session_record.project_id, session_record.session_id
FROM sessions AS session_record
WHERE (
    session_record.repository_id IS NULL
    AND (
      session_record.repository_ref IS NOT NULL
      OR session_record.worktree_id IS NOT NULL
    )
  )
  OR (
    json_type(session_record.worktree_meta_json, '$.repository_id') IS NOT NULL
    AND json_type(session_record.worktree_meta_json, '$.repository_id') NOT IN ('text', 'null')
  )
  OR (
    json_type(session_record.worktree_meta_json, '$.repository_ref') IS NOT NULL
    AND json_type(session_record.worktree_meta_json, '$.repository_ref') NOT IN ('text', 'null')
  )
  OR (
    json_type(session_record.worktree_meta_json, '$.ref') IS NOT NULL
    AND json_type(session_record.worktree_meta_json, '$.ref') NOT IN ('text', 'null')
  )
  OR (
    json_type(session_record.worktree_meta_json, '$.worktree_id') IS NOT NULL
    AND json_type(session_record.worktree_meta_json, '$.worktree_id') NOT IN ('text', 'null')
  )
  OR (
    (
      json_type(session_record.worktree_meta_json, '$.repository_ref') = 'text'
      OR json_type(session_record.worktree_meta_json, '$.ref') = 'text'
      OR json_type(session_record.worktree_meta_json, '$.worktree_id') = 'text'
    )
    AND json_type(session_record.worktree_meta_json, '$.repository_id') IS NOT 'text'
  )
  OR (
    json_type(session_record.worktree_meta_json, '$.repository_ref') = 'text'
    AND json_type(session_record.worktree_meta_json, '$.ref') = 'text'
    AND json_extract(session_record.worktree_meta_json, '$.repository_ref')
      <> json_extract(session_record.worktree_meta_json, '$.ref')
  )
  OR (
    json_type(session_record.worktree_meta_json, '$.repository_id') = 'text'
    AND json_extract(session_record.worktree_meta_json, '$.repository_id')
      IS NOT session_record.repository_id
  )
  OR (
    (
      json_type(session_record.worktree_meta_json, '$.repository_ref') = 'text'
      OR json_type(session_record.worktree_meta_json, '$.ref') = 'text'
    )
    AND COALESCE(
      json_extract(session_record.worktree_meta_json, '$.repository_ref'),
      json_extract(session_record.worktree_meta_json, '$.ref')
    ) IS NOT session_record.repository_ref
  )
  OR (
    json_type(session_record.worktree_meta_json, '$.worktree_id') = 'text'
    AND json_extract(session_record.worktree_meta_json, '$.worktree_id')
      IS NOT session_record.worktree_id
  );

CREATE VIEW invalid_sync_cursor_repository_ownership AS
SELECT cursor.project_id, cursor.repository_id, cursor.ref
FROM sync_cursors AS cursor
WHERE NOT EXISTS (
  SELECT 1
  FROM repositories AS repository
  WHERE repository.project_id = cursor.project_id
    AND repository.repository_id = cursor.repository_id
);

CREATE INDEX consolidation_batch_receipts_by_claim
  ON consolidation_batch_receipts(
    project_id, consolidation_id, lease_claim_id, lease_epoch, batch_index
  );

CREATE UNIQUE INDEX consolidation_inputs_one_summary
  ON consolidation_inputs(project_id, consolidation_id)
  WHERE input_kind = 'summary';

CREATE INDEX consolidation_outputs_by_receipt_candidate
  ON consolidation_outputs(project_id, candidate_id, consolidation_id, output_order);

CREATE INDEX consolidations_pending
  ON session_consolidations(project_id, status, created_at);

CREATE INDEX evidence_by_repository
  ON evidence(project_id, repository_id, commit_sha);

CREATE INDEX evidence_by_repository_ref_path
  ON evidence(
    project_id, repository_id, repository_ref, repository_path, evidence_id
  );

CREATE INDEX github_credential_states_by_status
  ON github_credential_states(credential_status, expires_at);

CREATE INDEX github_credential_warnings_by_expiry
  ON github_credential_expiry_warnings(expires_at, threshold_days);

CREATE INDEX github_rate_by_credential
  ON github_rate_observations(credential_version, observed_at DESC);

CREATE INDEX github_repository_sync_runs_by_active_lease
  ON github_repository_sync_runs(
    project_id, repository_id, claimed_ref, status, lease_expires_at
  );

CREATE INDEX github_repository_sync_runs_by_repository
  ON github_repository_sync_runs(
    project_id, repository_id, claimed_ref, scheduled_for DESC
  );

CREATE INDEX github_sync_dispatch_items_by_dispatch
  ON github_sync_dispatch_items(dispatch_id, status, item_id);

CREATE INDEX github_sync_dispatch_items_by_project
  ON github_sync_dispatch_items(project_id, repository_id, ref, scheduled_for);

CREATE INDEX github_sync_dispatches_by_status
  ON github_sync_dispatches(status, scheduled_for, dispatch_id);

CREATE INDEX github_tree_activation_receipts_by_ref
  ON github_tree_activation_receipts(
    project_id, repository_id, ref, activated_at, receipt_id
  );

CREATE INDEX github_tree_activation_witnesses_by_project
ON github_tree_activation_witnesses(project_id, created_at, activation_token);

CREATE INDEX github_tree_manifest_deltas_by_manifest
  ON github_tree_manifest_deltas(project_id, new_manifest_id);

CREATE INDEX github_tree_manifest_deltas_by_new_manifest
  ON github_tree_manifest_deltas(
    project_id, repository_id, ref, new_manifest_id, change_kind, path_digest
  );

CREATE INDEX github_tree_manifest_deltas_by_old_manifest
  ON github_tree_manifest_deltas(project_id, old_manifest_id);

CREATE INDEX github_tree_manifest_entries_by_path
  ON github_tree_manifest_entries(
    project_id, path_digest, safe_path, manifest_id
  );

CREATE INDEX github_tree_manifest_lifecycle_by_manifest
  ON github_tree_manifest_lifecycle_events(
    project_id, manifest_id, recorded_at, event_id
  );

CREATE UNIQUE INDEX github_tree_manifest_lifecycle_chunk_once
  ON github_tree_manifest_lifecycle_events(
    project_id, manifest_id, retention_version, chunk_digest
  )
  WHERE event_type = 'purge_chunk';

CREATE UNIQUE INDEX github_tree_manifest_lifecycle_terminal_once
  ON github_tree_manifest_lifecycle_events(
    project_id, manifest_id, event_type, retention_version
  )
  WHERE event_type IN ('failed', 'purged');

CREATE INDEX github_tree_manifests_by_ref
  ON github_tree_manifests(project_id, repository_id, ref, created_at DESC);

CREATE INDEX github_tree_manifests_failed_keyset
  ON github_tree_manifests(project_id, manifest_id)
  WHERE status IN ('failed', 'purging');

CREATE INDEX github_tree_manifests_staging_keyset
  ON github_tree_manifests(project_id, manifest_id)
  WHERE status = 'staging';

CREATE INDEX github_tree_ref_heads_by_manifest
  ON github_tree_ref_heads(project_id, manifest_id);

CREATE INDEX memories_search_filter
  ON memories(project_id, status, kind, memory_class, scope, updated_at);

CREATE INDEX memory_contexts_by_repository
  ON memory_repository_contexts(project_id, repository_id, memory_id);

CREATE INDEX memory_versions_by_memory
  ON memory_versions(project_id, memory_id, memory_version DESC);

CREATE INDEX observation_evidence_by_evidence
  ON observation_evidence(project_id, evidence_id, observation_id);

CREATE INDEX observations_review_queue
  ON observations(project_id, status, created_at);

CREATE INDEX outbox_dispatch_ready
ON outbox_events (created_at, event_id)
WHERE dispatched_at IS NULL AND failed_at IS NULL;

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

CREATE INDEX outbox_pending
  ON outbox_events(project_id, dispatched_at, created_at);

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

CREATE INDEX project_grant_contexts_by_repository
  ON project_grant_repository_contexts(project_id, repository_id, grant_id);

CREATE UNIQUE INDEX project_grants_project_identity
  ON project_grants(project_id, grant_id);

CREATE INDEX repositories_github_sync_identity
  ON repositories(
    lower(provider),
    sync_enabled,
    external_id,
    expected_owner_external_id
  );

CREATE UNIQUE INDEX repositories_global_provider_external
  ON repositories(lower(provider), external_id);

CREATE INDEX review_requests_pending
  ON review_requests(project_id, status, created_at);

CREATE INDEX session_consolidations_lease_expiry
  ON session_consolidations(status, lease_expires_at)
  WHERE status = 'running';

CREATE INDEX sessions_by_repository
  ON sessions(project_id, repository_id, status, opened_at);

CREATE UNIQUE INDEX sessions_by_worktree_scope
  ON sessions(project_id, worktree_scope_id)
  WHERE worktree_scope_id IS NOT NULL;

CREATE UNIQUE INDEX sync_cursors_by_ref_scope
  ON sync_cursors(project_id, ref_scope_id)
  WHERE ref_scope_id IS NOT NULL;

CREATE INDEX synthetic_cleanup_registry_claim
  ON synthetic_cleanup_registry(cleanup_claim_expires_at, expires_at, project_id);

CREATE INDEX synthetic_cleanup_registry_expiry
  ON synthetic_cleanup_registry(expires_at, project_id);

CREATE INDEX workflow_runs_projection_rebuild_latest
ON workflow_runs (
  project_id,
  root_workflow_id,
  updated_at DESC,
  workflow_id DESC
);

CREATE INDEX workflow_runs_root_lookup
  ON workflow_runs(project_id, root_workflow_id, updated_at);

-- Seed the two persistent retention rotation lanes.
INSERT INTO github_tree_manifest_retention_cursors
  (lane, after_project_id, after_manifest_id, cursor_version, updated_at)
VALUES
  ('staging', '', '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('failed', '', '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER audit_project_maintainer_guard
BEFORE INSERT ON audit_events
WHEN NOT EXISTS (
  SELECT 1 FROM project_grants
  WHERE project_id = NEW.project_id
    AND principal_id = NEW.actor_principal_id
    AND role = 'maintainer'
    AND scope_kind = 'project'
    AND scope_id = NEW.project_id
    AND revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'project maintainer grant required');
END;

CREATE TRIGGER audit_sequence_guard
BEFORE INSERT ON audit_events
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = NEW.project_id
    AND project_version = NEW.sequence - 1
    AND audit_head_hash IS NEW.previous_event_hash
)
BEGIN
  SELECT RAISE(ABORT, 'stale project head');
END;

CREATE TRIGGER consolidation_batch_receipts_insert_guard
BEFORE INSERT ON consolidation_batch_receipts
WHEN NOT EXISTS (
    SELECT 1
    FROM session_consolidations AS consolidation
    WHERE consolidation.project_id = NEW.project_id
      AND consolidation.consolidation_id = NEW.consolidation_id
      AND consolidation.status = 'running'
      AND consolidation.lease_owner = NEW.lease_owner
      AND consolidation.lease_claim_id = NEW.lease_claim_id
      AND consolidation.lease_epoch = NEW.lease_epoch
      AND consolidation.lease_operation_id = NEW.lease_operation_id
      AND consolidation.lease_expires_at IS NOT NULL
      AND consolidation.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.output_manifest_json) AS entry
    WHERE COALESCE(
      entry.type = 'object'
      AND (SELECT COUNT(*) FROM json_each(entry.value)) = 4
      AND (
        SELECT COUNT(*) FROM json_each(entry.value) AS member
        WHERE member.key = 'output_order'
      ) = 1
      AND (
        SELECT COUNT(*) FROM json_each(entry.value) AS member
        WHERE member.key = 'candidate_id'
      ) = 1
      AND (
        SELECT COUNT(*) FROM json_each(entry.value) AS member
        WHERE member.key = 'content_sha256'
      ) = 1
      AND (
        SELECT COUNT(*) FROM json_each(entry.value) AS member
        WHERE member.key = 'evidence_ids'
      ) = 1
      AND json_type(entry.value, '$.output_order') = 'integer'
      AND CAST(json_extract(entry.value, '$.output_order') AS INTEGER)
            BETWEEN NEW.batch_index * 10 AND NEW.batch_index * 10 + 9
      AND json_type(entry.value, '$.candidate_id') = 'text'
      AND length(json_extract(entry.value, '$.candidate_id')) = 36
      AND lower(json_extract(entry.value, '$.candidate_id')) =
            json_extract(entry.value, '$.candidate_id')
      AND json_extract(entry.value, '$.candidate_id') NOT GLOB '*[^0-9a-f-]*'
      AND length(replace(json_extract(entry.value, '$.candidate_id'), '-', '')) = 32
      AND substr(json_extract(entry.value, '$.candidate_id'), 9, 1) = '-'
      AND substr(json_extract(entry.value, '$.candidate_id'), 14, 1) = '-'
      AND substr(json_extract(entry.value, '$.candidate_id'), 15, 1) = '5'
      AND substr(json_extract(entry.value, '$.candidate_id'), 19, 1) = '-'
      AND substr(json_extract(entry.value, '$.candidate_id'), 20, 1) = 'a'
      AND substr(json_extract(entry.value, '$.candidate_id'), 24, 1) = '-'
      AND json_type(entry.value, '$.content_sha256') = 'text'
      AND length(json_extract(entry.value, '$.content_sha256')) = 64
      AND json_extract(entry.value, '$.content_sha256') NOT GLOB '*[^0-9a-f]*'
      AND json_type(entry.value, '$.evidence_ids') = 'array'
      AND json_array_length(json_extract(entry.value, '$.evidence_ids')) BETWEEN 1 AND 50
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(entry.value, '$.evidence_ids')) AS evidence_id
        WHERE COALESCE(
          evidence_id.type = 'text'
          AND length(evidence_id.value) BETWEEN 1 AND 512,
          0
        ) = 0
      )
      AND (
        SELECT COUNT(DISTINCT evidence_id.value)
        FROM json_each(json_extract(entry.value, '$.evidence_ids')) AS evidence_id
      ) = json_array_length(json_extract(entry.value, '$.evidence_ids'))
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(json_extract(entry.value, '$.evidence_ids')) AS current_evidence
        JOIN json_each(json_extract(entry.value, '$.evidence_ids')) AS previous_evidence
          ON CAST(previous_evidence.key AS INTEGER) =
             CAST(current_evidence.key AS INTEGER) - 1
        WHERE CAST(current_evidence.key AS INTEGER) > 0
          AND previous_evidence.value >= current_evidence.value
      ),
      0
    ) = 0
  )
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.output_manifest_json) AS entry
    WHERE NOT EXISTS (
        SELECT 1
        FROM consolidation_outputs AS output
        JOIN observations AS candidate
          ON candidate.project_id = output.project_id
         AND candidate.observation_id = output.candidate_id
        WHERE output.project_id = NEW.project_id
          AND output.consolidation_id = NEW.consolidation_id
          AND output.output_order = json_extract(entry.value, '$.output_order')
          AND output.candidate_id = json_extract(entry.value, '$.candidate_id')
          AND output.input_digest = (
            SELECT input_digest
            FROM session_consolidations
            WHERE project_id = NEW.project_id
              AND consolidation_id = NEW.consolidation_id
          )
          AND candidate.source_consolidation_id = NEW.consolidation_id
          AND candidate.content_sha256 = json_extract(entry.value, '$.content_sha256')
          AND candidate.status = 'pending_review'
          AND candidate.content IS NOT NULL
          AND candidate.analysis_json IS NOT NULL
          AND json_valid(candidate.analysis_json)
          AND json_type(candidate.analysis_json) = 'object'
      )
  )
  OR (
    SELECT COUNT(DISTINCT json_extract(entry.value, '$.output_order'))
    FROM json_each(NEW.output_manifest_json) AS entry
  ) <> NEW.suggestion_count
  OR (
    SELECT COUNT(DISTINCT json_extract(entry.value, '$.candidate_id'))
    FROM json_each(NEW.output_manifest_json) AS entry
  ) <> NEW.suggestion_count
  OR (
    SELECT COUNT(DISTINCT json_extract(entry.value, '$.content_sha256'))
    FROM json_each(NEW.output_manifest_json) AS entry
  ) <> NEW.suggestion_count
  OR EXISTS (
    SELECT 1
    FROM json_each(NEW.output_manifest_json) AS entry
    JOIN consolidation_outputs AS output
      ON output.project_id = NEW.project_id
     AND output.consolidation_id = NEW.consolidation_id
     AND output.output_order = json_extract(entry.value, '$.output_order')
     AND output.candidate_id = json_extract(entry.value, '$.candidate_id')
    WHERE NOT EXISTS (
        SELECT 1
        FROM review_requests AS review
        WHERE review.project_id = NEW.project_id
          AND review.candidate_id = output.candidate_id
          AND review.review_request_id = output.candidate_id
          AND review.status = 'pending'
          AND review.required_role = 'maintainer'
      )
      OR (
        SELECT COUNT(*)
        FROM observation_evidence AS linked
        WHERE linked.project_id = NEW.project_id
          AND linked.observation_id = output.candidate_id
      ) <> json_array_length(json_extract(entry.value, '$.evidence_ids'))
      OR EXISTS (
        SELECT 1
        FROM json_each(json_extract(entry.value, '$.evidence_ids')) AS expected_evidence
        WHERE NOT EXISTS (
          SELECT 1
          FROM observation_evidence AS linked
          JOIN evidence AS evidence
            ON evidence.project_id = linked.project_id
           AND evidence.evidence_id = linked.evidence_id
          WHERE linked.project_id = NEW.project_id
            AND linked.observation_id = output.candidate_id
            AND linked.evidence_id = expected_evidence.value
            AND evidence.sensitivity_status = 'clear'
        )
      )
  )
  OR EXISTS (
    SELECT 1
    FROM consolidation_outputs AS output
    JOIN observations AS candidate
      ON candidate.project_id = output.project_id
     AND candidate.observation_id = output.candidate_id
    WHERE output.project_id = NEW.project_id
      AND output.consolidation_id = NEW.consolidation_id
      AND output.output_order
            BETWEEN NEW.batch_index * 10 AND NEW.batch_index * 10 + 9
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(NEW.output_manifest_json) AS entry
        WHERE json_extract(entry.value, '$.output_order') = output.output_order
          AND json_extract(entry.value, '$.candidate_id') = output.candidate_id
          AND json_extract(entry.value, '$.content_sha256') = candidate.content_sha256
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation batch receipt final state is invalid');
END;

CREATE TRIGGER consolidation_batch_receipts_no_delete
BEFORE DELETE ON consolidation_batch_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation batch receipts are immutable');
END;

CREATE TRIGGER consolidation_batch_receipts_no_update
BEFORE UPDATE ON consolidation_batch_receipts
BEGIN
  SELECT RAISE(ABORT, 'consolidation batch receipts are immutable');
END;

CREATE TRIGGER consolidation_inputs_no_delete
BEFORE DELETE ON consolidation_inputs
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation inputs are immutable');
END;

CREATE TRIGGER consolidation_inputs_no_update
BEFORE UPDATE ON consolidation_inputs
BEGIN
  SELECT RAISE(ABORT, 'consolidation inputs are immutable');
END;

CREATE TRIGGER consolidation_inputs_shape_insert_guard
BEFORE INSERT ON consolidation_inputs
WHEN NEW.input_kind = 'summary'
  AND EXISTS (
    SELECT 1
    FROM consolidation_inputs
    WHERE project_id = NEW.project_id
      AND consolidation_id = NEW.consolidation_id
      AND input_kind = 'summary'
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation may contain only one summary input');
END;

CREATE TRIGGER consolidation_outputs_no_delete
BEFORE DELETE ON consolidation_outputs
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation outputs are immutable');
END;

CREATE TRIGGER consolidation_outputs_no_update
BEFORE UPDATE ON consolidation_outputs
BEGIN
  SELECT RAISE(ABORT, 'consolidation outputs are immutable');
END;

CREATE TRIGGER consolidation_receipt_candidate_delete_guard
BEFORE DELETE ON observations
WHEN EXISTS (
  SELECT 1
  FROM consolidation_outputs AS output
  JOIN consolidation_batch_receipts AS receipt
    ON receipt.project_id = output.project_id
   AND receipt.consolidation_id = output.consolidation_id
   AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
  WHERE output.project_id = OLD.project_id
    AND output.candidate_id = OLD.observation_id
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt candidate state is immutable');
END;

CREATE TRIGGER consolidation_receipt_candidate_update_guard
BEFORE UPDATE OF observation_id, project_id, session_id, principal_id, content,
  content_sha256, evidence_json, kind, memory_class, scope, scope_id, valid_from,
  valid_until, analysis_json, source_consolidation_id, created_at
ON observations
WHEN (
    NEW.observation_id IS NOT OLD.observation_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.session_id IS NOT OLD.session_id
    OR NEW.principal_id IS NOT OLD.principal_id
    OR NEW.content IS NOT OLD.content
    OR NEW.content_sha256 IS NOT OLD.content_sha256
    OR NEW.evidence_json IS NOT OLD.evidence_json
    OR NEW.kind IS NOT OLD.kind
    OR NEW.memory_class IS NOT OLD.memory_class
    OR NEW.scope IS NOT OLD.scope
    OR NEW.scope_id IS NOT OLD.scope_id
    OR NEW.valid_from IS NOT OLD.valid_from
    OR NEW.valid_until IS NOT OLD.valid_until
    OR NEW.analysis_json IS NOT OLD.analysis_json
    OR NEW.source_consolidation_id IS NOT OLD.source_consolidation_id
    OR NEW.created_at IS NOT OLD.created_at
  )
  AND EXISTS (
    SELECT 1
    FROM consolidation_outputs AS output
    JOIN consolidation_batch_receipts AS receipt
      ON receipt.project_id = output.project_id
     AND receipt.consolidation_id = output.consolidation_id
     AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
    WHERE output.project_id = OLD.project_id
      AND output.candidate_id = OLD.observation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt candidate state is immutable');
END;

CREATE TRIGGER consolidation_receipt_consolidation_update_guard
BEFORE UPDATE OF consolidation_id, project_id, session_id, session_version,
  input_digest, created_at
ON session_consolidations
WHEN (
    NEW.consolidation_id IS NOT OLD.consolidation_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.session_id IS NOT OLD.session_id
    OR NEW.session_version IS NOT OLD.session_version
    OR NEW.input_digest IS NOT OLD.input_digest
    OR NEW.created_at IS NOT OLD.created_at
  )
  AND EXISTS (
    SELECT 1
    FROM consolidation_batch_receipts AS receipt
    WHERE receipt.project_id = OLD.project_id
      AND receipt.consolidation_id = OLD.consolidation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt source state is immutable');
END;

CREATE TRIGGER consolidation_receipt_evidence_link_delete_guard
BEFORE DELETE ON observation_evidence
WHEN NOT EXISTS (
    SELECT 1 FROM projects
    WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
  )
  AND EXISTS (
    SELECT 1
    FROM consolidation_outputs AS output
    JOIN consolidation_batch_receipts AS receipt
      ON receipt.project_id = output.project_id
     AND receipt.consolidation_id = output.consolidation_id
     AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
    WHERE output.project_id = OLD.project_id
      AND output.candidate_id = OLD.observation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt evidence links are immutable');
END;

CREATE TRIGGER consolidation_receipt_evidence_link_insert_guard
BEFORE INSERT ON observation_evidence
WHEN EXISTS (
    SELECT 1
    FROM consolidation_outputs AS output
    JOIN consolidation_batch_receipts AS receipt
      ON receipt.project_id = output.project_id
     AND receipt.consolidation_id = output.consolidation_id
     AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
    WHERE output.project_id = NEW.project_id
      AND output.candidate_id = NEW.observation_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt evidence links are immutable');
END;

CREATE TRIGGER consolidation_receipt_evidence_sensitivity_invalidation
AFTER UPDATE OF sensitivity_status ON evidence
WHEN NEW.sensitivity_status IS NOT OLD.sensitivity_status
BEGIN
  UPDATE session_consolidations
  SET receipt_post_state_valid = 0
  WHERE project_id = OLD.project_id
    AND status IN ('queued', 'running', 'failed')
    AND receipt_post_state_valid = 1
    AND EXISTS (
      SELECT 1
      FROM observation_evidence AS linked
      JOIN consolidation_outputs AS output
        ON output.project_id = linked.project_id
       AND output.candidate_id = linked.observation_id
      JOIN consolidation_batch_receipts AS receipt
        ON receipt.project_id = output.project_id
       AND receipt.consolidation_id = output.consolidation_id
       AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
      WHERE linked.project_id = OLD.project_id
        AND linked.evidence_id = OLD.evidence_id
        AND output.consolidation_id = session_consolidations.consolidation_id
    );
END;

CREATE TRIGGER consolidation_receipt_input_insert_guard
BEFORE INSERT ON consolidation_inputs
WHEN EXISTS (
  SELECT 1
  FROM consolidation_batch_receipts AS receipt
  WHERE receipt.project_id = NEW.project_id
    AND receipt.consolidation_id = NEW.consolidation_id
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt input set is immutable');
END;

CREATE TRIGGER consolidation_receipt_output_insert_guard
BEFORE INSERT ON consolidation_outputs
WHEN EXISTS (
    SELECT 1
    FROM consolidation_batch_receipts AS receipt
    WHERE receipt.project_id = NEW.project_id
      AND receipt.consolidation_id = NEW.consolidation_id
      AND receipt.batch_index = CAST(NEW.output_order / 10 AS INTEGER)
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt output slots are immutable');
END;

CREATE TRIGGER consolidation_receipt_review_delete_guard
BEFORE DELETE ON review_requests
WHEN EXISTS (
  SELECT 1
  FROM consolidation_outputs AS output
  JOIN consolidation_batch_receipts AS receipt
    ON receipt.project_id = output.project_id
   AND receipt.consolidation_id = output.consolidation_id
   AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
  WHERE output.project_id = OLD.project_id
    AND output.candidate_id = OLD.candidate_id
)
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt review identity is immutable');
END;

CREATE TRIGGER consolidation_receipt_review_update_guard
BEFORE UPDATE OF review_request_id, project_id, candidate_id, conflict_id,
  required_role, created_at
ON review_requests
WHEN (
    NEW.review_request_id IS NOT OLD.review_request_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.candidate_id IS NOT OLD.candidate_id
    OR NEW.conflict_id IS NOT OLD.conflict_id
    OR NEW.required_role IS NOT OLD.required_role
    OR NEW.created_at IS NOT OLD.created_at
  )
  AND EXISTS (
    SELECT 1
    FROM consolidation_outputs AS output
    JOIN consolidation_batch_receipts AS receipt
      ON receipt.project_id = output.project_id
     AND receipt.consolidation_id = output.consolidation_id
     AND receipt.batch_index = CAST(output.output_order / 10 AS INTEGER)
    WHERE output.project_id = OLD.project_id
      AND output.candidate_id = OLD.candidate_id
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt review identity is immutable');
END;

CREATE TRIGGER evidence_identity_immutable
BEFORE UPDATE OF evidence_id, project_id, source_type, locator, excerpt_hash, commit_sha,
  recorded_at ON evidence
WHEN NEW.evidence_id IS NOT OLD.evidence_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.source_type IS NOT OLD.source_type
  OR NEW.locator IS NOT OLD.locator
  OR NEW.excerpt_hash IS NOT OLD.excerpt_hash
  OR NEW.commit_sha IS NOT OLD.commit_sha
  OR NEW.recorded_at IS NOT OLD.recorded_at
BEGIN
  SELECT RAISE(ABORT, 'evidence identity is immutable');
END;

CREATE TRIGGER evidence_repository_context_insert_guard
BEFORE INSERT ON evidence
WHEN (
    NEW.repository_id IS NULL
    AND (
      NEW.repository_ref IS NOT NULL
      OR NEW.repository_path IS NOT NULL
      OR NEW.repository_authority IS NOT NULL
    )
  )
  OR (
    NEW.repository_id IS NOT NULL
    AND (
      NEW.repository_authority IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM repositories
        WHERE project_id = NEW.project_id AND repository_id = NEW.repository_id
      )
    )
  )
  OR (
    NEW.source_type = 'github_blob'
    AND (
      NEW.repository_ref IS NULL
      OR NEW.repository_authority NOT IN ('default_branch', 'tracked_ref')
      OR NEW.sensitivity_status NOT IN ('clear', 'tombstone')
      OR (NEW.sensitivity_status = 'clear' AND NEW.repository_path IS NULL)
      OR (
        NEW.sensitivity_status = 'tombstone'
        AND (
          NEW.repository_path IS NOT NULL
          OR NEW.commit_sha IS NULL
          OR instr(NEW.locator, '/path-sha256/') = 0
          OR length(substr(
            NEW.locator,
            instr(NEW.locator, '/path-sha256/') + length('/path-sha256/')
          )) <> 64
          OR substr(
            NEW.locator,
            instr(NEW.locator, '/path-sha256/') + length('/path-sha256/')
          ) GLOB '*[^0-9a-f]*'
          OR NEW.locator <> (
            'github://' || (
              SELECT repository.external_id
              FROM repositories AS repository
              WHERE repository.project_id = NEW.project_id
                AND repository.repository_id = NEW.repository_id
            ) || '/' || NEW.commit_sha || '/path-sha256/' || substr(
              NEW.locator,
              instr(NEW.locator, '/path-sha256/') + length('/path-sha256/')
            )
          )
        )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'evidence repository context is invalid');
END;

CREATE TRIGGER evidence_repository_context_update_guard
BEFORE UPDATE OF project_id, repository_id, repository_ref, repository_path,
  repository_authority ON evidence
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.repository_id IS NOT OLD.repository_id
  OR NEW.repository_ref IS NOT OLD.repository_ref
  OR NEW.repository_path IS NOT OLD.repository_path
  OR NEW.repository_authority IS NOT OLD.repository_authority
BEGIN
  SELECT RAISE(ABORT, 'evidence repository context is immutable');
END;

CREATE TRIGGER github_access_baselines_no_delete
BEFORE DELETE ON github_access_baselines
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'GitHub access baselines are immutable');
END;

CREATE TRIGGER github_access_baselines_no_update
BEFORE UPDATE ON github_access_baselines
BEGIN
  SELECT RAISE(ABORT, 'GitHub access baselines are immutable');
END;

CREATE TRIGGER github_credential_expiry_identity_guard
BEFORE UPDATE OF credential_version, expires_at ON github_credential_states
WHEN NEW.credential_version <> OLD.credential_version
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'github credential version must change with expiration');
END;

CREATE TRIGGER github_credential_expiry_warnings_no_delete
BEFORE DELETE ON github_credential_expiry_warnings
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'github credential expiry warnings are immutable');
END;

CREATE TRIGGER github_credential_expiry_warnings_no_update
BEFORE UPDATE ON github_credential_expiry_warnings
BEGIN
  SELECT RAISE(ABORT, 'github credential expiry warnings are immutable');
END;

CREATE TRIGGER github_credential_sync_lane_no_delete
BEFORE DELETE ON github_credential_sync_lane
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lanes cannot be deleted');
END;

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

CREATE TRIGGER github_credential_sync_lane_release_receipts_no_delete
BEFORE DELETE ON github_credential_sync_lane_release_receipts
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lane release receipts are immutable');
END;

CREATE TRIGGER github_credential_sync_lane_release_receipts_no_update
BEFORE UPDATE ON github_credential_sync_lane_release_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lane release receipts are immutable');
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

CREATE TRIGGER github_credential_sync_lane_version_guard
BEFORE UPDATE ON github_credential_sync_lane
WHEN NEW.credential_version IS NOT OLD.credential_version
  OR NEW.lease_epoch < OLD.lease_epoch
  OR NEW.lease_epoch > OLD.lease_epoch + 1
BEGIN
  SELECT RAISE(ABORT, 'GitHub credential lane update is invalid');
END;

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

CREATE TRIGGER github_repository_sync_finish_receipts_no_delete
BEFORE DELETE ON github_repository_sync_finish_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository sync finish receipts are immutable');
END;

CREATE TRIGGER github_repository_sync_finish_receipts_no_update
BEFORE UPDATE ON github_repository_sync_finish_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub repository sync finish receipts are immutable');
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

CREATE TRIGGER github_sync_dispatch_item_rejection_receipts_no_delete
BEFORE DELETE ON github_sync_dispatch_item_rejection_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub dispatch item rejection receipts are immutable');
END;

CREATE TRIGGER github_sync_dispatch_item_rejection_receipts_no_update
BEFORE UPDATE ON github_sync_dispatch_item_rejection_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub dispatch item rejection receipts are immutable');
END;

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

CREATE TRIGGER github_sync_dispatch_items_no_delete
BEFORE DELETE ON github_sync_dispatch_items
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch items cannot be deleted');
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

CREATE TRIGGER github_sync_dispatch_items_request_overflow_guard
BEFORE UPDATE OF github_request_overflow_count ON github_sync_dispatch_items
WHEN OLD.status <> 'running'
  OR NEW.status <> OLD.status
  OR NEW.github_request_count <> OLD.github_request_count
  OR OLD.github_request_count <> 2005
  OR NEW.github_request_overflow_count <= OLD.github_request_overflow_count
  OR NEW.github_request_overflow_count > OLD.github_request_overflow_count + 8
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch item request overflow update is invalid');
END;

CREATE TRIGGER github_sync_dispatch_items_request_overflow_initial_guard
BEFORE INSERT ON github_sync_dispatch_items
WHEN NEW.github_request_overflow_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch item request overflow must start at zero');
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

CREATE TRIGGER github_sync_dispatch_materialization_receipts_no_update
BEFORE UPDATE ON github_sync_dispatch_materialization_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub dispatch materialization receipts are immutable');
END;

CREATE TRIGGER github_sync_dispatches_identity_immutable
BEFORE UPDATE OF dispatch_id, credential_version, workflow_instance_id,
  scheduled_for, utc_date, created_at
ON github_sync_dispatches
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch identity is immutable');
END;

CREATE TRIGGER github_sync_dispatches_no_delete
BEFORE DELETE ON github_sync_dispatches
WHEN OLD.credential_version NOT GLOB 'system.synthetic.*'
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatches cannot be deleted');
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

CREATE TRIGGER github_tree_activation_receipts_no_delete
BEFORE DELETE ON github_tree_activation_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation receipts are immutable');
END;

CREATE TRIGGER github_tree_activation_receipts_no_update
BEFORE UPDATE ON github_tree_activation_receipts
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation receipts are immutable');
END;

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

CREATE TRIGGER github_tree_activation_witnesses_no_delete
BEFORE DELETE ON github_tree_activation_witnesses
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation witnesses are immutable');
END;

CREATE TRIGGER github_tree_activation_witnesses_no_update
BEFORE UPDATE ON github_tree_activation_witnesses
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree activation witnesses are immutable');
END;

CREATE TRIGGER github_tree_manifest_deltas_insert_guard
BEFORE INSERT ON github_tree_manifest_deltas
WHEN NOT EXISTS (
    SELECT 1 FROM github_tree_manifests AS manifest
    WHERE manifest.project_id = NEW.project_id
      AND manifest.manifest_id = NEW.new_manifest_id
      AND manifest.status = 'complete'
  )
  OR (
    NEW.old_manifest_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_manifests AS manifest
      WHERE manifest.project_id = NEW.project_id
        AND manifest.manifest_id = NEW.old_manifest_id
        AND manifest.status = 'complete'
    )
  )
  OR (
    NEW.change_kind IN ('added', 'changed', 'withdrawn')
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_manifest_entries AS entry
      WHERE entry.project_id = NEW.project_id
        AND entry.manifest_id = NEW.new_manifest_id
        AND entry.path_digest = NEW.path_digest
        AND entry.blob_sha = NEW.new_blob_sha
        AND entry.disposition = NEW.new_disposition
        AND (
          (
            NEW.change_kind = 'withdrawn'
            AND NEW.safe_path IS NULL
          )
          OR (
            NEW.change_kind <> 'withdrawn'
            AND entry.safe_path IS NEW.safe_path
          )
        )
    )
  )
  OR (
    NEW.change_kind = 'deleted'
    AND EXISTS (
      SELECT 1 FROM github_tree_manifest_entries AS entry
      WHERE entry.project_id = NEW.project_id
        AND entry.manifest_id = NEW.new_manifest_id
        AND entry.path_digest = NEW.path_digest
    )
  )
  OR (
    NEW.change_kind = 'added'
    AND NEW.old_manifest_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM github_tree_manifest_entries AS entry
      WHERE entry.project_id = NEW.project_id
        AND entry.manifest_id = NEW.old_manifest_id
        AND entry.path_digest = NEW.path_digest
    )
  )
  OR (
    NEW.change_kind IN ('changed', 'deleted', 'withdrawn')
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_manifest_entries AS entry
      WHERE entry.project_id = NEW.project_id
        AND entry.manifest_id = NEW.old_manifest_id
        AND entry.path_digest = NEW.path_digest
        AND entry.blob_sha = NEW.old_blob_sha
        AND entry.disposition = NEW.old_disposition
        AND (
          NEW.change_kind <> 'deleted'
          OR entry.safe_path IS NEW.safe_path
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest delta provenance is invalid');
END;

CREATE TRIGGER github_tree_manifest_deltas_no_delete
BEFORE DELETE ON github_tree_manifest_deltas
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest deltas are immutable');
END;

CREATE TRIGGER github_tree_manifest_deltas_no_update
BEFORE UPDATE ON github_tree_manifest_deltas
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest deltas are immutable');
END;

CREATE TRIGGER github_tree_manifest_entries_no_delete
BEFORE DELETE ON github_tree_manifest_entries
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
AND NOT EXISTS (
  SELECT 1 FROM github_tree_manifests AS manifest
  WHERE manifest.project_id = OLD.project_id
    AND manifest.manifest_id = OLD.manifest_id
    AND manifest.status = 'purging'
    AND manifest.purge_token IS NOT NULL
    AND julianday(manifest.purge_lease_until) > julianday('now')
    AND julianday('now') >= julianday(manifest.failed_at, '+30 days')
    AND EXISTS (
      SELECT 1 FROM github_tree_manifest_lifecycle_events AS event
      WHERE event.project_id = manifest.project_id
        AND event.manifest_id = manifest.manifest_id
        AND event.event_type = 'purge_chunk'
        AND event.retention_version = manifest.retention_version
    )
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_ref_heads AS head
      WHERE head.project_id = manifest.project_id
        AND head.manifest_id = manifest.manifest_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_manifest_deltas AS delta
      WHERE delta.project_id = manifest.project_id
        AND (
          delta.old_manifest_id = manifest.manifest_id
          OR delta.new_manifest_id = manifest.manifest_id
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest entries are immutable');
END;

CREATE TRIGGER github_tree_manifest_entries_no_update
BEFORE UPDATE ON github_tree_manifest_entries
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest entries are immutable');
END;

CREATE TRIGGER github_tree_manifest_entries_staging_insert_guard
BEFORE INSERT ON github_tree_manifest_entries
WHEN NOT EXISTS (
  SELECT 1 FROM github_tree_manifests AS manifest
  WHERE manifest.project_id = NEW.project_id
    AND manifest.manifest_id = NEW.manifest_id
    AND manifest.status = 'staging'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest entries require a staging manifest');
END;

CREATE TRIGGER github_tree_manifest_lifecycle_insert_guard
BEFORE INSERT ON github_tree_manifest_lifecycle_events
WHEN julianday(NEW.recorded_at) IS NULL
  OR julianday(NEW.recorded_at) < julianday('now', '-5 minutes')
  OR julianday(NEW.recorded_at) > julianday('now', '+5 minutes')
  OR NOT EXISTS (
    SELECT 1 FROM github_tree_manifests AS manifest
    WHERE manifest.project_id = NEW.project_id
      AND manifest.manifest_id = NEW.manifest_id
      AND manifest.failure_code = NEW.failure_code
      AND manifest.entry_count = NEW.entry_count
      AND manifest.entries_checksum = NEW.entries_checksum
      AND manifest.retention_version = NEW.retention_version
      AND (
        (NEW.event_type = 'failed' AND manifest.status = 'failed'
          AND NEW.recorded_at = manifest.failed_at)
        OR (NEW.event_type = 'purge_chunk' AND manifest.status = 'purging')
        OR (NEW.event_type = 'purged' AND manifest.status = 'purged'
          AND NEW.recorded_at = manifest.purged_at)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest lifecycle event is invalid');
END;

CREATE TRIGGER github_tree_manifest_lifecycle_no_delete
BEFORE DELETE ON github_tree_manifest_lifecycle_events
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest lifecycle events are immutable');
END;

CREATE TRIGGER github_tree_manifest_lifecycle_no_update
BEFORE UPDATE ON github_tree_manifest_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest lifecycle events are immutable');
END;

CREATE TRIGGER github_tree_manifest_retention_cursors_no_delete
BEFORE DELETE ON github_tree_manifest_retention_cursors
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest retention cursors are fixed');
END;

CREATE TRIGGER github_tree_manifest_retention_cursors_no_insert
BEFORE INSERT ON github_tree_manifest_retention_cursors
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest retention cursors are fixed');
END;

CREATE TRIGGER github_tree_manifest_retention_cursors_update_guard
BEFORE UPDATE ON github_tree_manifest_retention_cursors
WHEN NEW.lane <> OLD.lane
  OR NEW.cursor_version <> OLD.cursor_version + 1
  OR julianday(NEW.updated_at) IS NULL
  OR julianday(NEW.updated_at) < julianday('now', '-5 minutes')
  OR julianday(NEW.updated_at) > julianday('now', '+5 minutes')
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest retention cursor update is invalid');
END;

CREATE TRIGGER github_tree_manifests_identity_immutable
BEFORE UPDATE OF manifest_id, project_id, repository_id, ref, observed_sha, tree_sha,
  repository_authority, collection_key, created_at
ON github_tree_manifests
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest identity is immutable');
END;

CREATE TRIGGER github_tree_manifests_no_delete
BEFORE DELETE ON github_tree_manifests
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifests are immutable');
END;

CREATE TRIGGER github_tree_manifests_staging_insert_guard
BEFORE INSERT ON github_tree_manifests
WHEN NEW.status <> 'staging'
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifests must be inserted as staging');
END;

CREATE TRIGGER github_tree_manifests_state_transition_guard
BEFORE UPDATE OF status, entry_count, entries_checksum, completed_at,
  failed_at, failure_code, retention_version, retention_attempt,
  retention_next_attempt_at, purge_token, purge_lease_until, purged_at
ON github_tree_manifests
WHEN NOT (
    OLD.status = 'staging'
    AND NEW.status = 'complete'
    AND NEW.entry_count = (
      SELECT COUNT(*) FROM github_tree_manifest_entries AS entry
      WHERE entry.project_id = OLD.project_id
        AND entry.manifest_id = OLD.manifest_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_manifest_entries AS entry
      WHERE entry.project_id = OLD.project_id
        AND entry.manifest_id = OLD.manifest_id
        AND entry.disposition = 'partial'
    )
  )
  AND NOT (
    OLD.status = 'staging'
    AND NEW.status = 'failed'
    AND NEW.entry_count = (
      SELECT COUNT(*) FROM github_tree_manifest_entries AS entry
      WHERE entry.project_id = OLD.project_id
        AND entry.manifest_id = OLD.manifest_id
    )
    AND julianday(NEW.failed_at) >= julianday(OLD.created_at)
    AND julianday(NEW.failed_at) >= julianday('now', '-5 minutes')
    AND julianday(NEW.failed_at) <= julianday('now', '+5 minutes')
  )
  AND NOT (
    OLD.status = 'failed'
    AND NEW.status = 'purging'
    AND NEW.entry_count = OLD.entry_count
    AND NEW.entries_checksum = OLD.entries_checksum
    AND NEW.failed_at = OLD.failed_at
    AND NEW.failure_code = OLD.failure_code
    AND NEW.retention_version = OLD.retention_version + 1
    AND NEW.retention_attempt = OLD.retention_attempt + 1
    AND NEW.retention_next_attempt_at = NEW.purge_lease_until
    AND julianday('now') >= julianday(OLD.failed_at, '+30 days')
    AND julianday(NEW.purge_lease_until) > julianday('now')
    AND julianday(NEW.purge_lease_until) <= julianday('now', '+30 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_ref_heads AS head
      WHERE head.project_id = OLD.project_id
        AND head.manifest_id = OLD.manifest_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_manifest_deltas AS delta
      WHERE delta.project_id = OLD.project_id
        AND (
          delta.old_manifest_id = OLD.manifest_id
          OR delta.new_manifest_id = OLD.manifest_id
      )
    )
  )
  AND NOT (
    OLD.status = 'purging'
    AND NEW.status = 'purging'
    AND NEW.entry_count = OLD.entry_count
    AND NEW.entries_checksum = OLD.entries_checksum
    AND NEW.failed_at = OLD.failed_at
    AND NEW.failure_code = OLD.failure_code
    AND NEW.retention_version = OLD.retention_version + 1
    AND NEW.retention_attempt = OLD.retention_attempt + 1
    AND NEW.retention_next_attempt_at = NEW.purge_lease_until
    AND julianday(OLD.purge_lease_until) <= julianday('now')
    AND julianday(OLD.retention_next_attempt_at) <= julianday('now')
    AND julianday('now') >= julianday(OLD.failed_at, '+30 days')
    AND julianday(NEW.purge_lease_until) > julianday('now')
    AND julianday(NEW.purge_lease_until) <= julianday('now', '+30 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_ref_heads AS head
      WHERE head.project_id = OLD.project_id
        AND head.manifest_id = OLD.manifest_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_manifest_deltas AS delta
      WHERE delta.project_id = OLD.project_id
        AND (
          delta.old_manifest_id = OLD.manifest_id
          OR delta.new_manifest_id = OLD.manifest_id
        )
    )
  )
  AND NOT (
    OLD.status = 'purging'
    AND NEW.status = 'purging'
    AND NEW.entry_count = OLD.entry_count
    AND NEW.entries_checksum = OLD.entries_checksum
    AND NEW.failed_at = OLD.failed_at
    AND NEW.failure_code = OLD.failure_code
    AND NEW.retention_version = OLD.retention_version
    AND NEW.retention_attempt = OLD.retention_attempt
    AND NEW.purge_token = OLD.purge_token
    AND NEW.purge_lease_until = OLD.purge_lease_until
    AND julianday(NEW.retention_next_attempt_at) >
      julianday(OLD.retention_next_attempt_at)
    AND julianday(NEW.retention_next_attempt_at) > julianday('now')
    AND julianday(NEW.retention_next_attempt_at) <= julianday('now', '+7 days')
  )
  AND NOT (
    OLD.status = 'purging'
    AND NEW.status = 'purged'
    AND NEW.entry_count = OLD.entry_count
    AND NEW.entries_checksum = OLD.entries_checksum
    AND NEW.failed_at = OLD.failed_at
    AND NEW.failure_code = OLD.failure_code
    AND NEW.retention_version = OLD.retention_version + 1
    AND NEW.retention_attempt = OLD.retention_attempt
    AND julianday(OLD.purge_lease_until) > julianday('now')
    AND julianday('now') >= julianday(OLD.failed_at, '+30 days')
    AND julianday(NEW.purged_at) >= julianday(OLD.failed_at, '+30 days')
    AND julianday(NEW.purged_at) >= julianday('now', '-5 minutes')
    AND julianday(NEW.purged_at) <= julianday('now', '+5 minutes')
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_manifest_entries AS entry
      WHERE entry.project_id = OLD.project_id
        AND entry.manifest_id = OLD.manifest_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_ref_heads AS head
      WHERE head.project_id = OLD.project_id
        AND head.manifest_id = OLD.manifest_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM github_tree_manifest_deltas AS delta
      WHERE delta.project_id = OLD.project_id
        AND (
          delta.old_manifest_id = OLD.manifest_id
          OR delta.new_manifest_id = OLD.manifest_id
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest state transition is invalid');
END;

CREATE TRIGGER github_tree_ref_heads_manifest_insert_guard
BEFORE INSERT ON github_tree_ref_heads
WHEN NOT EXISTS (
  SELECT 1 FROM github_tree_manifests AS manifest
  WHERE manifest.project_id = NEW.project_id
    AND manifest.repository_id = NEW.repository_id
    AND manifest.ref = NEW.ref
    AND manifest.manifest_id = NEW.manifest_id
    AND manifest.status = 'complete'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree ref head requires a complete manifest');
END;

CREATE TRIGGER github_tree_ref_heads_no_delete
BEFORE DELETE ON github_tree_ref_heads
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree ref heads cannot be deleted');
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

CREATE TRIGGER github_tree_ref_heads_update_guard
BEFORE UPDATE ON github_tree_ref_heads
WHEN NEW.project_id <> OLD.project_id
  OR NEW.repository_id <> OLD.repository_id
  OR NEW.ref <> OLD.ref
  OR NEW.head_version <> OLD.head_version + 1
  OR NOT EXISTS (
    SELECT 1 FROM github_tree_manifests AS manifest
    WHERE manifest.project_id = NEW.project_id
      AND manifest.repository_id = NEW.repository_id
      AND manifest.ref = NEW.ref
      AND manifest.manifest_id = NEW.manifest_id
      AND manifest.status = 'complete'
  )
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree ref head update is invalid');
END;

CREATE TRIGGER memory_canonical_context_create
AFTER INSERT ON memories
WHEN NEW.scope <> 'project'
BEGIN
  INSERT INTO memory_repository_contexts
    (project_id, memory_id, repository_id, created_at)
  SELECT NEW.project_id, NEW.memory_id, ownership.repository_id, NEW.created_at
  FROM canonical_repository_scope_ownership AS ownership
  WHERE ownership.project_id = NEW.project_id
    AND ownership.scope_kind = NEW.scope
    AND ownership.scope_id = NEW.scope_id;
END;

CREATE TRIGGER memory_canonical_scope_insert_guard
BEFORE INSERT ON memories
WHEN (
    NEW.scope = 'project'
    AND NEW.scope_id <> NEW.project_id
  )
  OR (
    NEW.scope <> 'project'
    AND NOT EXISTS (
      SELECT 1
      FROM canonical_repository_scope_ownership AS ownership
      WHERE ownership.project_id = NEW.project_id
        AND ownership.scope_kind = NEW.scope
        AND ownership.scope_id = NEW.scope_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory scope is invalid');
END;

CREATE TRIGGER memory_repository_context_canonical_insert_guard
BEFORE INSERT ON memory_repository_contexts
WHEN NOT EXISTS (
  SELECT 1
  FROM memories AS memory_record
  JOIN canonical_repository_scope_ownership AS ownership
    ON ownership.project_id = memory_record.project_id
   AND ownership.scope_kind = memory_record.scope
   AND ownership.scope_id = memory_record.scope_id
  WHERE memory_record.project_id = NEW.project_id
    AND memory_record.memory_id = NEW.memory_id
    AND memory_record.scope <> 'project'
    AND ownership.repository_id = NEW.repository_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory repository context is invalid');
END;

CREATE TRIGGER memory_repository_context_duplicate_noop
BEFORE INSERT ON memory_repository_contexts
WHEN EXISTS (
  SELECT 1
  FROM memory_repository_contexts AS existing_context
  WHERE existing_context.project_id = NEW.project_id
    AND existing_context.memory_id = NEW.memory_id
    AND existing_context.repository_id = NEW.repository_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER memory_repository_context_insert_guard
BEFORE INSERT ON memory_repository_contexts
WHEN NOT EXISTS (
    SELECT 1 FROM memories AS memory_record
    WHERE memory_record.project_id = NEW.project_id
      AND memory_record.memory_id = NEW.memory_id
      AND memory_record.scope <> 'project'
  )
  OR NOT EXISTS (
    SELECT 1 FROM repositories AS repository
    WHERE repository.project_id = NEW.project_id
      AND repository.repository_id = NEW.repository_id
  )
  OR EXISTS (
    SELECT 1 FROM memories AS memory_record
    WHERE memory_record.project_id = NEW.project_id
      AND memory_record.memory_id = NEW.memory_id
      AND memory_record.scope = 'repository'
      AND memory_record.scope_id <> NEW.repository_id
  )
  OR EXISTS (
    SELECT 1 FROM memories AS memory_record
    WHERE memory_record.project_id = NEW.project_id
      AND memory_record.memory_id = NEW.memory_id
      AND memory_record.scope = 'session'
      AND NOT EXISTS (
        SELECT 1 FROM sessions AS session_record
        WHERE session_record.project_id = memory_record.project_id
          AND session_record.session_id = memory_record.scope_id
          AND session_record.repository_id = NEW.repository_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'memory repository context is invalid');
END;

CREATE TRIGGER memory_repository_context_no_delete
BEFORE DELETE ON memory_repository_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'memory repository context is immutable');
END;

CREATE TRIGGER memory_repository_context_no_update
BEFORE UPDATE ON memory_repository_contexts
BEGIN
  SELECT RAISE(ABORT, 'memory repository context is immutable');
END;

CREATE TRIGGER memory_scope_identity_immutable
BEFORE UPDATE OF memory_id, project_id, scope, scope_id ON memories
WHEN NEW.memory_id IS NOT OLD.memory_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.scope IS NOT OLD.scope
  OR NEW.scope_id IS NOT OLD.scope_id
BEGIN
  SELECT RAISE(ABORT, 'memory scope identity is immutable');
END;

CREATE TRIGGER memory_version_guard
BEFORE INSERT ON memory_versions
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memories
  WHERE project_id = NEW.project_id
    AND memory_id = NEW.memory_id
    AND memory_version = NEW.memory_version - 1
)
BEGIN
  SELECT RAISE(ABORT, 'stale memory head');
END;

CREATE TRIGGER memory_versions_no_delete
BEFORE DELETE ON memory_versions
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'memory versions are immutable');
END;

CREATE TRIGGER memory_versions_no_update
BEFORE UPDATE ON memory_versions
BEGIN
  SELECT RAISE(ABORT, 'memory versions are immutable');
END;

CREATE TRIGGER memory_versions_validity_guard_insert
BEFORE INSERT ON memory_versions
WHEN (NEW.valid_from IS NOT NULL AND (
    julianday(NEW.valid_from) IS NULL
    OR length(NEW.valid_from) < 20
    OR substr(NEW.valid_from, 11, 1) <> 'T'
    OR (
      substr(NEW.valid_from, -1, 1) <> 'Z'
      AND (
        substr(NEW.valid_from, -6, 1) NOT IN ('+', '-')
        OR substr(NEW.valid_from, -3, 1) <> ':'
      )
    )
  ))
  OR (NEW.valid_until IS NOT NULL AND (
    julianday(NEW.valid_until) IS NULL
    OR length(NEW.valid_until) < 20
    OR substr(NEW.valid_until, 11, 1) <> 'T'
    OR (
      substr(NEW.valid_until, -1, 1) <> 'Z'
      AND (
        substr(NEW.valid_until, -6, 1) NOT IN ('+', '-')
        OR substr(NEW.valid_until, -3, 1) <> ':'
      )
    )
  ))
  OR (
    NEW.valid_from IS NOT NULL
    AND NEW.valid_until IS NOT NULL
    AND julianday(NEW.valid_from) > julianday(NEW.valid_until)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid memory validity interval');
END;

CREATE TRIGGER observation_content_immutable
BEFORE UPDATE OF content, content_sha256, evidence_json, project_id, session_id, principal_id
ON observations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'candidate source is immutable');
END;

CREATE TRIGGER observation_evidence_no_delete
BEFORE DELETE ON observation_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'observation evidence is immutable');
END;

CREATE TRIGGER observation_evidence_no_update
BEFORE UPDATE ON observation_evidence
BEGIN
  SELECT RAISE(ABORT, 'observation evidence is immutable');
END;

CREATE TRIGGER observation_transition_guard
BEFORE UPDATE OF candidate_version, status ON observations
FOR EACH ROW
WHEN NOT (
  (
    OLD.status = 'queued'
    AND NEW.status IN ('pending_review', 'noop')
    AND NEW.candidate_version = OLD.candidate_version
  )
  OR (
    OLD.status IN ('pending_review', 'request_changes')
    AND NEW.status IN ('promoted', 'rejected', 'request_changes')
    AND NEW.candidate_version = OLD.candidate_version + 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'stale candidate head');
END;

CREATE TRIGGER observations_require_open_session
BEFORE INSERT ON observations
FOR EACH ROW
WHEN NEW.session_id IS NOT NULL
  AND NEW.source_consolidation_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE project_id = NEW.project_id
      AND session_id = NEW.session_id
      AND status = 'open'
  )
BEGIN
  SELECT RAISE(ABORT, 'session is not open');
END;

CREATE TRIGGER observations_validity_guard_insert
BEFORE INSERT ON observations
WHEN (NEW.valid_from IS NOT NULL AND (
    julianday(NEW.valid_from) IS NULL
    OR length(NEW.valid_from) < 20
    OR substr(NEW.valid_from, 11, 1) <> 'T'
    OR (
      substr(NEW.valid_from, -1, 1) <> 'Z'
      AND (
        substr(NEW.valid_from, -6, 1) NOT IN ('+', '-')
        OR substr(NEW.valid_from, -3, 1) <> ':'
      )
    )
  ))
  OR (NEW.valid_until IS NOT NULL AND (
    julianday(NEW.valid_until) IS NULL
    OR length(NEW.valid_until) < 20
    OR substr(NEW.valid_until, 11, 1) <> 'T'
    OR (
      substr(NEW.valid_until, -1, 1) <> 'Z'
      AND (
        substr(NEW.valid_until, -6, 1) NOT IN ('+', '-')
        OR substr(NEW.valid_until, -3, 1) <> ':'
      )
    )
  ))
  OR (
    NEW.valid_from IS NOT NULL
    AND NEW.valid_until IS NOT NULL
    AND julianday(NEW.valid_from) > julianday(NEW.valid_until)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid observation validity interval');
END;

CREATE TRIGGER observations_validity_guard_update
BEFORE UPDATE OF valid_from, valid_until ON observations
WHEN (NEW.valid_from IS NOT NULL AND (
    julianday(NEW.valid_from) IS NULL
    OR length(NEW.valid_from) < 20
    OR substr(NEW.valid_from, 11, 1) <> 'T'
    OR (
      substr(NEW.valid_from, -1, 1) <> 'Z'
      AND (
        substr(NEW.valid_from, -6, 1) NOT IN ('+', '-')
        OR substr(NEW.valid_from, -3, 1) <> ':'
      )
    )
  ))
  OR (NEW.valid_until IS NOT NULL AND (
    julianday(NEW.valid_until) IS NULL
    OR length(NEW.valid_until) < 20
    OR substr(NEW.valid_until, 11, 1) <> 'T'
    OR (
      substr(NEW.valid_until, -1, 1) <> 'Z'
      AND (
        substr(NEW.valid_until, -6, 1) NOT IN ('+', '-')
        OR substr(NEW.valid_until, -3, 1) <> ':'
      )
    )
  ))
  OR (
    NEW.valid_from IS NOT NULL
    AND NEW.valid_until IS NOT NULL
    AND julianday(NEW.valid_from) > julianday(NEW.valid_until)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid observation validity interval');
END;

CREATE TRIGGER project_grant_canonical_context_create
AFTER INSERT ON project_grants
WHEN NEW.scope_kind <> 'project'
BEGIN
  INSERT INTO project_grant_repository_contexts
    (project_id, grant_id, repository_id, created_at)
  SELECT NEW.project_id, NEW.grant_id, ownership.repository_id, NEW.created_at
  FROM canonical_repository_scope_ownership AS ownership
  WHERE ownership.project_id = NEW.project_id
    AND ownership.scope_kind = NEW.scope_kind
    AND ownership.scope_id = NEW.scope_id;
END;

CREATE TRIGGER project_grant_canonical_scope_insert_guard
BEFORE INSERT ON project_grants
WHEN (
    NEW.scope_kind = 'project'
    AND NEW.scope_id <> NEW.project_id
  )
  OR (
    NEW.scope_kind <> 'project'
    AND NOT EXISTS (
      SELECT 1
      FROM canonical_repository_scope_ownership AS ownership
      WHERE ownership.project_id = NEW.project_id
        AND ownership.scope_kind = NEW.scope_kind
        AND ownership.scope_id = NEW.scope_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project grant scope is invalid');
END;

CREATE TRIGGER project_grant_id_immutable
BEFORE UPDATE OF grant_id ON project_grants
WHEN NEW.grant_id IS NOT OLD.grant_id
BEGIN
  SELECT RAISE(ABORT, 'project grant identity is immutable');
END;

CREATE TRIGGER project_grant_identity_immutable
BEFORE UPDATE OF project_id, principal_id, scope_kind, scope_id ON project_grants
WHEN NEW.project_id <> OLD.project_id
  OR NEW.principal_id <> OLD.principal_id
  OR NEW.scope_kind <> OLD.scope_kind
  OR NEW.scope_id <> OLD.scope_id
BEGIN
  SELECT RAISE(ABORT, 'project grant identity is immutable');
END;

CREATE TRIGGER project_grant_project_scope_insert_guard
BEFORE INSERT ON project_grants
WHEN NEW.scope_kind = 'project' AND NEW.scope_id <> NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'project grant scope is invalid');
END;

CREATE TRIGGER project_grant_repository_context_canonical_insert_guard
BEFORE INSERT ON project_grant_repository_contexts
WHEN NOT EXISTS (
  SELECT 1
  FROM project_grants AS grant_record
  JOIN canonical_repository_scope_ownership AS ownership
    ON ownership.project_id = grant_record.project_id
   AND ownership.scope_kind = grant_record.scope_kind
   AND ownership.scope_id = grant_record.scope_id
  WHERE grant_record.project_id = NEW.project_id
    AND grant_record.grant_id = NEW.grant_id
    AND grant_record.scope_kind <> 'project'
    AND ownership.repository_id = NEW.repository_id
)
BEGIN
  SELECT RAISE(ABORT, 'grant repository context is invalid');
END;

CREATE TRIGGER project_grant_repository_context_duplicate_noop
BEFORE INSERT ON project_grant_repository_contexts
WHEN EXISTS (
  SELECT 1
  FROM project_grant_repository_contexts AS existing_context
  WHERE existing_context.project_id = NEW.project_id
    AND existing_context.grant_id = NEW.grant_id
    AND existing_context.repository_id = NEW.repository_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER project_grant_repository_context_insert_guard
BEFORE INSERT ON project_grant_repository_contexts
WHEN NOT EXISTS (
    SELECT 1 FROM project_grants AS grant_record
    WHERE grant_record.project_id = NEW.project_id
      AND grant_record.grant_id = NEW.grant_id
      AND grant_record.scope_kind <> 'project'
  )
  OR NOT EXISTS (
    SELECT 1 FROM repositories AS repository
    WHERE repository.project_id = NEW.project_id
      AND repository.repository_id = NEW.repository_id
  )
  OR EXISTS (
    SELECT 1 FROM project_grants AS grant_record
    WHERE grant_record.project_id = NEW.project_id
      AND grant_record.grant_id = NEW.grant_id
      AND grant_record.scope_kind = 'repository'
      AND grant_record.scope_id <> NEW.repository_id
  )
  OR EXISTS (
    SELECT 1 FROM project_grants AS grant_record
    WHERE grant_record.project_id = NEW.project_id
      AND grant_record.grant_id = NEW.grant_id
      AND grant_record.scope_kind = 'session'
      AND NOT EXISTS (
        SELECT 1 FROM sessions AS session_record
        WHERE session_record.project_id = grant_record.project_id
          AND session_record.session_id = grant_record.scope_id
          AND session_record.repository_id = NEW.repository_id
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'grant repository context is invalid');
END;

CREATE TRIGGER project_grant_repository_context_no_delete
BEFORE DELETE ON project_grant_repository_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'grant repository context is immutable');
END;

CREATE TRIGGER project_grant_repository_context_no_update
BEFORE UPDATE ON project_grant_repository_contexts
BEGIN
  SELECT RAISE(ABORT, 'grant repository context is immutable');
END;

CREATE TRIGGER project_grant_repository_scope_insert_guard
BEFORE INSERT ON project_grants
WHEN NEW.scope_kind = 'repository'
  AND NOT EXISTS (
    SELECT 1 FROM repositories
    WHERE project_id = NEW.project_id AND repository_id = NEW.scope_id
  )
BEGIN
  SELECT RAISE(ABORT, 'repository grant scope is invalid');
END;

CREATE TRIGGER project_grant_scope_update_guard
BEFORE UPDATE OF project_id, scope_kind, scope_id ON project_grants
WHEN (
    NEW.scope_kind = 'project'
    AND NEW.scope_id <> NEW.project_id
  )
  OR (
    NEW.scope_kind = 'repository'
    AND NOT EXISTS (
      SELECT 1 FROM repositories
      WHERE project_id = NEW.project_id AND repository_id = NEW.scope_id
    )
  )
  OR (
    NEW.scope_kind = 'session'
    AND NOT EXISTS (
      SELECT 1 FROM sessions
      WHERE project_id = NEW.project_id
        AND session_id = NEW.scope_id
        AND repository_id IS NOT NULL
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'project grant scope is invalid');
END;

CREATE TRIGGER project_grant_session_scope_insert_guard
BEFORE INSERT ON project_grants
WHEN NEW.scope_kind = 'session'
  AND NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE project_id = NEW.project_id
      AND session_id = NEW.scope_id
      AND repository_id IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'session grant scope is invalid');
END;

CREATE TRIGGER project_grant_single_project_insert
BEFORE INSERT ON project_grants
WHEN EXISTS (
  SELECT 1 FROM project_grants
  WHERE principal_id = NEW.principal_id AND project_id <> NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'principal grants must remain in one project');
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

CREATE TRIGGER repositories_github_sync_default_branch_insert_guard
BEFORE INSERT ON repositories
WHEN lower(NEW.provider) = 'github'
  AND NEW.sync_enabled = 1
  AND (
    NEW.default_branch IS NULL
    OR NEW.default_branch = ''
    OR instr(hex(NEW.default_branch), '00') > 0
    OR NEW.default_branch GLOB '*[^A-Za-z0-9._/-]*'
    OR instr(NEW.default_branch, '..') > 0
    OR instr(NEW.default_branch, '//') > 0
    OR substr(NEW.default_branch, 1, 1) = '/'
    OR substr(NEW.default_branch, -1) = '/'
  )
BEGIN
  SELECT RAISE(ABORT, 'github repository default branch is required');
END;

CREATE TRIGGER repositories_github_sync_default_branch_update_guard
BEFORE UPDATE OF provider, sync_enabled, default_branch ON repositories
WHEN lower(NEW.provider) = 'github'
  AND NEW.sync_enabled = 1
  AND (
    NEW.default_branch IS NULL
    OR NEW.default_branch = ''
    OR instr(hex(NEW.default_branch), '00') > 0
    OR NEW.default_branch GLOB '*[^A-Za-z0-9._/-]*'
    OR instr(NEW.default_branch, '..') > 0
    OR instr(NEW.default_branch, '//') > 0
    OR substr(NEW.default_branch, 1, 1) = '/'
    OR substr(NEW.default_branch, -1) = '/'
  )
BEGIN
  SELECT RAISE(ABORT, 'github repository default branch is required');
END;

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

CREATE TRIGGER repositories_scope_identity_immutable
BEFORE UPDATE OF repository_id, project_id, provider, external_id ON repositories
WHEN NEW.repository_id <> OLD.repository_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.provider <> OLD.provider
  OR NEW.external_id <> OLD.external_id
BEGIN
  SELECT RAISE(ABORT, 'repository scope identity is immutable');
END;

CREATE TRIGGER review_decisions_no_delete
BEFORE DELETE ON review_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'review decisions are immutable');
END;

CREATE TRIGGER review_decisions_no_update
BEFORE UPDATE ON review_decisions
BEGIN
  SELECT RAISE(ABORT, 'review decisions are immutable');
END;

CREATE TRIGGER session_close_cas_guard
BEFORE UPDATE OF session_version ON sessions
FOR EACH ROW
WHEN OLD.status != 'open' OR NEW.session_version != OLD.session_version + 1
BEGIN
  SELECT RAISE(ABORT, 'stale session head');
END;

CREATE TRIGGER session_consolidations_lease_insert_guard
BEFORE INSERT ON session_consolidations
WHEN (
    NEW.status = 'running'
    AND (
      NEW.lease_owner IS NULL
      OR NEW.lease_claim_id IS NULL
      OR NEW.lease_expires_at IS NULL
      OR NEW.lease_epoch < 1
    )
  )
  OR (
    NEW.status <> 'running'
    AND (
      NEW.lease_owner IS NOT NULL
      OR NEW.lease_claim_id IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.lease_operation_id IS NOT NULL
    )
  )
  OR (
    NEW.lease_owner IS NOT NULL
    AND (
      length(NEW.lease_owner) NOT BETWEEN 1 AND 512
      OR trim(NEW.lease_owner) <> NEW.lease_owner
    )
  )
  OR (
    NEW.lease_claim_id IS NOT NULL
    AND (
      length(NEW.lease_claim_id) <> 36
      OR lower(NEW.lease_claim_id) <> NEW.lease_claim_id
      OR NEW.lease_claim_id GLOB '*[^0-9a-f-]*'
      OR length(replace(NEW.lease_claim_id, '-', '')) <> 32
      OR substr(NEW.lease_claim_id, 9, 1) <> '-'
      OR substr(NEW.lease_claim_id, 14, 1) <> '-'
      OR substr(NEW.lease_claim_id, 15, 1) <> '4'
      OR substr(NEW.lease_claim_id, 19, 1) <> '-'
      OR substr(NEW.lease_claim_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
      OR substr(NEW.lease_claim_id, 24, 1) <> '-'
    )
  )
  OR (
    NEW.lease_expires_at IS NOT NULL
    AND (
      length(NEW.lease_expires_at) <> 24
      OR strftime(
        '%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at, '+0 seconds'
      ) IS NULL
      OR strftime(
        '%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at, '+0 seconds'
      ) <> NEW.lease_expires_at
    )
  )
  OR (
    NEW.lease_operation_id IS NOT NULL
    AND (
      length(NEW.lease_operation_id) <> 36
      OR lower(NEW.lease_operation_id) <> NEW.lease_operation_id
      OR NEW.lease_operation_id GLOB '*[^0-9a-f-]*'
      OR length(replace(NEW.lease_operation_id, '-', '')) <> 32
      OR substr(NEW.lease_operation_id, 9, 1) <> '-'
      OR substr(NEW.lease_operation_id, 14, 1) <> '-'
      OR substr(NEW.lease_operation_id, 15, 1) <> '4'
      OR substr(NEW.lease_operation_id, 19, 1) <> '-'
      OR substr(NEW.lease_operation_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
      OR substr(NEW.lease_operation_id, 24, 1) <> '-'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation lease state is invalid');
END;

CREATE TRIGGER session_consolidations_lease_update_guard
BEFORE UPDATE OF status, lease_owner, lease_claim_id, lease_expires_at,
  lease_operation_id, lease_epoch
ON session_consolidations
WHEN NEW.lease_epoch < OLD.lease_epoch
  OR (
    NEW.status = 'running'
    AND (
      NEW.lease_owner IS NULL
      OR NEW.lease_claim_id IS NULL
      OR NEW.lease_expires_at IS NULL
      OR NEW.lease_epoch < 1
    )
  )
  OR (
    NEW.status <> 'running'
    AND (
      NEW.lease_owner IS NOT NULL
      OR NEW.lease_claim_id IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.lease_operation_id IS NOT NULL
    )
  )
  OR (
    NEW.lease_owner IS NOT NULL
    AND (
      length(NEW.lease_owner) NOT BETWEEN 1 AND 512
      OR trim(NEW.lease_owner) <> NEW.lease_owner
    )
  )
  OR (
    NEW.lease_claim_id IS NOT NULL
    AND (
      length(NEW.lease_claim_id) <> 36
      OR lower(NEW.lease_claim_id) <> NEW.lease_claim_id
      OR NEW.lease_claim_id GLOB '*[^0-9a-f-]*'
      OR length(replace(NEW.lease_claim_id, '-', '')) <> 32
      OR substr(NEW.lease_claim_id, 9, 1) <> '-'
      OR substr(NEW.lease_claim_id, 14, 1) <> '-'
      OR substr(NEW.lease_claim_id, 15, 1) <> '4'
      OR substr(NEW.lease_claim_id, 19, 1) <> '-'
      OR substr(NEW.lease_claim_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
      OR substr(NEW.lease_claim_id, 24, 1) <> '-'
    )
  )
  OR (
    NEW.lease_expires_at IS NOT NULL
    AND (
      length(NEW.lease_expires_at) <> 24
      OR strftime(
        '%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at, '+0 seconds'
      ) IS NULL
      OR strftime(
        '%Y-%m-%dT%H:%M:%fZ', NEW.lease_expires_at, '+0 seconds'
      ) <> NEW.lease_expires_at
    )
  )
  OR (
    NEW.lease_operation_id IS NOT NULL
    AND (
      length(NEW.lease_operation_id) <> 36
      OR lower(NEW.lease_operation_id) <> NEW.lease_operation_id
      OR NEW.lease_operation_id GLOB '*[^0-9a-f-]*'
      OR length(replace(NEW.lease_operation_id, '-', '')) <> 32
      OR substr(NEW.lease_operation_id, 9, 1) <> '-'
      OR substr(NEW.lease_operation_id, 14, 1) <> '-'
      OR substr(NEW.lease_operation_id, 15, 1) <> '4'
      OR substr(NEW.lease_operation_id, 19, 1) <> '-'
      OR substr(NEW.lease_operation_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
      OR substr(NEW.lease_operation_id, 24, 1) <> '-'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation lease state is invalid');
END;

CREATE TRIGGER session_consolidations_receipt_validity_monotonic_guard
BEFORE UPDATE OF receipt_post_state_valid ON session_consolidations
WHEN OLD.receipt_post_state_valid = 0 AND NEW.receipt_post_state_valid <> 0
BEGIN
  SELECT RAISE(ABORT, 'consolidation receipt post-state cannot be revalidated');
END;

CREATE TRIGGER session_consolidations_terminal_receipt_guard
BEFORE UPDATE OF status ON session_consolidations
WHEN NEW.status IN ('complete', 'noop')
  AND (
    NEW.receipt_post_state_valid <> 1
    OR (NEW.status = 'complete' AND NOT EXISTS (
      SELECT 1 FROM consolidation_outputs AS output
      WHERE output.project_id = OLD.project_id
        AND output.consolidation_id = OLD.consolidation_id
    ))
    OR (NEW.status = 'noop' AND EXISTS (
      SELECT 1 FROM consolidation_outputs AS output
      WHERE output.project_id = OLD.project_id
        AND output.consolidation_id = OLD.consolidation_id
    ))
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT CAST(input_order / 50 AS INTEGER) AS batch_index
        FROM consolidation_inputs
        WHERE project_id = OLD.project_id
          AND consolidation_id = OLD.consolidation_id
        GROUP BY CAST(input_order / 50 AS INTEGER)
      ) AS expected_batch
      WHERE NOT EXISTS (
        SELECT 1 FROM consolidation_batch_receipts AS receipt
        WHERE receipt.project_id = OLD.project_id
          AND receipt.consolidation_id = OLD.consolidation_id
          AND receipt.batch_index = expected_batch.batch_index
      )
    )
    OR EXISTS (
      SELECT 1 FROM consolidation_batch_receipts AS receipt
      WHERE receipt.project_id = OLD.project_id
        AND receipt.consolidation_id = OLD.consolidation_id
        AND NOT EXISTS (
          SELECT 1 FROM consolidation_inputs AS input
          WHERE input.project_id = OLD.project_id
            AND input.consolidation_id = OLD.consolidation_id
            AND input.input_order BETWEEN receipt.batch_index * 50
                                      AND receipt.batch_index * 50 + 49
        )
    )
    OR EXISTS (
      SELECT 1
      FROM consolidation_batch_receipts AS receipt
      WHERE receipt.project_id = OLD.project_id
        AND receipt.consolidation_id = OLD.consolidation_id
        AND (
          typeof(receipt.batch_index) <> 'integer'
          OR receipt.batch_index < 0
          OR receipt.batch_index > 900719925474098
          OR length(receipt.lease_owner) NOT BETWEEN 1 AND 512
          OR trim(receipt.lease_owner) <> receipt.lease_owner
          OR length(receipt.lease_claim_id) <> 36
          OR lower(receipt.lease_claim_id) <> receipt.lease_claim_id
          OR receipt.lease_claim_id GLOB '*[^0-9a-f-]*'
          OR length(replace(receipt.lease_claim_id, '-', '')) <> 32
          OR substr(receipt.lease_claim_id, 9, 1) <> '-'
          OR substr(receipt.lease_claim_id, 14, 1) <> '-'
          OR substr(receipt.lease_claim_id, 15, 1) <> '4'
          OR substr(receipt.lease_claim_id, 19, 1) <> '-'
          OR substr(receipt.lease_claim_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
          OR substr(receipt.lease_claim_id, 24, 1) <> '-'
          OR length(receipt.lease_operation_id) <> 36
          OR lower(receipt.lease_operation_id) <> receipt.lease_operation_id
          OR receipt.lease_operation_id GLOB '*[^0-9a-f-]*'
          OR length(replace(receipt.lease_operation_id, '-', '')) <> 32
          OR substr(receipt.lease_operation_id, 9, 1) <> '-'
          OR substr(receipt.lease_operation_id, 14, 1) <> '-'
          OR substr(receipt.lease_operation_id, 15, 1) <> '4'
          OR substr(receipt.lease_operation_id, 19, 1) <> '-'
          OR substr(receipt.lease_operation_id, 20, 1) NOT IN ('8', '9', 'a', 'b')
          OR substr(receipt.lease_operation_id, 24, 1) <> '-'
          OR typeof(receipt.lease_epoch) <> 'integer'
          OR receipt.lease_epoch < 1
          OR receipt.lease_epoch > 9007199254740991
          OR length(receipt.batch_input_digest) <> 64
          OR receipt.batch_input_digest GLOB '*[^0-9a-f]*'
          OR length(receipt.model_result_digest) <> 64
          OR receipt.model_result_digest GLOB '*[^0-9a-f]*'
          OR length(receipt.output_manifest_digest) <> 64
          OR receipt.output_manifest_digest GLOB '*[^0-9a-f]*'
          OR typeof(receipt.suggestion_count) <> 'integer'
          OR receipt.suggestion_count NOT BETWEEN 0 AND 10
          OR length(receipt.completed_at) <> 24
          OR strftime(
            '%Y-%m-%dT%H:%M:%fZ', receipt.completed_at, '+0 seconds'
          ) IS NULL
          OR strftime(
            '%Y-%m-%dT%H:%M:%fZ', receipt.completed_at, '+0 seconds'
          ) <> receipt.completed_at
        )
    )
    OR (
      SELECT COUNT(*)
      FROM consolidation_outputs AS output
      WHERE output.project_id = OLD.project_id
        AND output.consolidation_id = OLD.consolidation_id
    ) <> COALESCE((
      SELECT SUM(receipt.suggestion_count)
      FROM consolidation_batch_receipts AS receipt
      WHERE receipt.project_id = OLD.project_id
        AND receipt.consolidation_id = OLD.consolidation_id
    ), 0)
    OR (
      SELECT COUNT(*)
      FROM consolidation_batch_receipts AS receipt
      WHERE receipt.project_id = OLD.project_id
        AND receipt.consolidation_id = OLD.consolidation_id
    ) <> (
      SELECT COUNT(*)
      FROM (
        SELECT CAST(input_order / 50 AS INTEGER) AS batch_index
        FROM consolidation_inputs
        WHERE project_id = OLD.project_id
          AND consolidation_id = OLD.consolidation_id
        GROUP BY CAST(input_order / 50 AS INTEGER)
      ) AS expected_batches
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'consolidation terminal receipt state is invalid');
END;

CREATE TRIGGER session_scope_ownership_delete_guard
BEFORE DELETE ON sessions
WHEN NOT EXISTS (
    SELECT 1 FROM projects
    WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
  )
  AND (
    EXISTS (
      SELECT 1
      FROM canonical_repository_scope_ownership AS ownership
      JOIN project_grants AS grant_record
        ON grant_record.project_id = ownership.project_id
       AND grant_record.scope_kind = ownership.scope_kind
       AND grant_record.scope_id = ownership.scope_id
      WHERE ownership.project_id = OLD.project_id
        AND ownership.scope_kind IN ('session', 'worktree')
        AND ownership.source_id = OLD.session_id
    )
    OR EXISTS (
      SELECT 1
      FROM canonical_repository_scope_ownership AS ownership
      JOIN memories AS memory_record
        ON memory_record.project_id = ownership.project_id
       AND memory_record.scope = ownership.scope_kind
       AND memory_record.scope_id = ownership.scope_id
      WHERE ownership.project_id = OLD.project_id
        AND ownership.scope_kind IN ('session', 'worktree')
        AND ownership.source_id = OLD.session_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'session scope ownership is referenced');
END;

CREATE TRIGGER sessions_identity_immutable
BEFORE UPDATE OF session_id, project_id, principal_id ON sessions
WHEN NEW.session_id IS NOT OLD.session_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.principal_id IS NOT OLD.principal_id
BEGIN
  SELECT RAISE(ABORT, 'session identity is immutable');
END;

CREATE TRIGGER sessions_repository_context_immutable
BEFORE UPDATE OF project_id, repository_id, repository_ref, worktree_id ON sessions
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.repository_id IS NOT OLD.repository_id
  OR NEW.repository_ref IS NOT OLD.repository_ref
  OR NEW.worktree_id IS NOT OLD.worktree_id
BEGIN
  SELECT RAISE(ABORT, 'session repository context is immutable');
END;

CREATE TRIGGER sessions_repository_context_insert_guard
BEFORE INSERT ON sessions
WHEN NEW.repository_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM repositories
    WHERE project_id = NEW.project_id AND repository_id = NEW.repository_id
  )
BEGIN
  SELECT RAISE(ABORT, 'session repository context is invalid');
END;

CREATE TRIGGER sessions_repository_context_update_guard
BEFORE UPDATE OF project_id, repository_id ON sessions
WHEN NEW.repository_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM repositories
    WHERE project_id = NEW.project_id AND repository_id = NEW.repository_id
  )
BEGIN
  SELECT RAISE(ABORT, 'session repository context is invalid');
END;

CREATE TRIGGER sessions_repository_metadata_insert_guard
AFTER INSERT ON sessions
WHEN EXISTS (
  SELECT 1
  FROM invalid_session_repository_metadata AS invalid_metadata
  WHERE invalid_metadata.project_id = NEW.project_id
    AND invalid_metadata.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'session repository metadata is invalid');
END;

CREATE TRIGGER sessions_repository_metadata_update_guard
AFTER UPDATE OF project_id, worktree_meta_json, repository_id, repository_ref, worktree_id
ON sessions
WHEN EXISTS (
  SELECT 1
  FROM invalid_session_repository_metadata AS invalid_metadata
  WHERE invalid_metadata.project_id = NEW.project_id
    AND invalid_metadata.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'session repository metadata is invalid');
END;

CREATE TRIGGER sessions_worktree_scope_insert_guard
BEFORE INSERT ON sessions
WHEN (
    NEW.worktree_id IS NULL
    AND NEW.worktree_scope_id IS NOT NULL
  )
  OR (
    NEW.worktree_id IS NOT NULL
    AND (
      length(NEW.session_id) = 0
      OR trim(NEW.session_id) <> NEW.session_id
      OR instr(NEW.session_id, char(0)) <> 0
      OR length(NEW.worktree_id) = 0
      OR trim(NEW.worktree_id) <> NEW.worktree_id
      OR instr(NEW.worktree_id, char(0)) <> 0
      OR (
        NEW.worktree_scope_id IS NOT NULL
        AND NEW.worktree_scope_id IS NOT (
          SELECT 'session:' || MAX(
            CASE WHEN component.component_kind = 'session' THEN component.encoded END
          ) || ':worktree:' || MAX(
            CASE WHEN component.component_kind = 'worktree' THEN component.encoded END
          )
          FROM (
            WITH RECURSIVE
            components(component_kind, component) AS (
              SELECT 'session', NEW.session_id
              UNION ALL
              SELECT 'worktree', NEW.worktree_id
            ),
            encoding(component_kind, source, byte_index, encoded) AS (
              SELECT component_kind, CAST(component AS BLOB), 1, ''
              FROM components
              UNION ALL
              SELECT component_kind, source, byte_index + 1,
                     encoded || CASE
                       WHEN (
                         hex(substr(source, byte_index, 1)) BETWEEN '30' AND '39'
                         OR hex(substr(source, byte_index, 1)) BETWEEN '41' AND '5A'
                         OR hex(substr(source, byte_index, 1)) BETWEEN '61' AND '7A'
                         OR hex(substr(source, byte_index, 1)) IN (
                           '2D', '5F', '2E', '21', '7E', '2A', '27', '28', '29'
                         )
                       ) THEN CAST(substr(source, byte_index, 1) AS TEXT)
                       ELSE '%' || hex(substr(source, byte_index, 1))
                     END
              FROM encoding
              WHERE byte_index <= length(source)
            )
            SELECT component_kind, encoded
            FROM encoding
            WHERE byte_index = length(source) + 1
          ) AS component
        )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'canonical worktree scope identity is invalid');
END;

CREATE TRIGGER sessions_worktree_scope_materialize
AFTER INSERT ON sessions
WHEN NEW.worktree_id IS NOT NULL
BEGIN
  UPDATE sessions
  SET worktree_scope_id = (
    SELECT 'session:' || MAX(
      CASE WHEN component.component_kind = 'session' THEN component.encoded END
    ) || ':worktree:' || MAX(
      CASE WHEN component.component_kind = 'worktree' THEN component.encoded END
    )
    FROM (
      WITH RECURSIVE
      components(component_kind, component) AS (
        SELECT 'session', NEW.session_id
        UNION ALL
        SELECT 'worktree', NEW.worktree_id
      ),
      encoding(component_kind, source, byte_index, encoded) AS (
        SELECT component_kind, CAST(component AS BLOB), 1, ''
        FROM components
        UNION ALL
        SELECT component_kind, source, byte_index + 1,
               encoded || CASE
                 WHEN (
                   hex(substr(source, byte_index, 1)) BETWEEN '30' AND '39'
                   OR hex(substr(source, byte_index, 1)) BETWEEN '41' AND '5A'
                   OR hex(substr(source, byte_index, 1)) BETWEEN '61' AND '7A'
                   OR hex(substr(source, byte_index, 1)) IN (
                     '2D', '5F', '2E', '21', '7E', '2A', '27', '28', '29'
                   )
                 ) THEN CAST(substr(source, byte_index, 1) AS TEXT)
                 ELSE '%' || hex(substr(source, byte_index, 1))
               END
        FROM encoding
        WHERE byte_index <= length(source)
      )
      SELECT component_kind, encoded
      FROM encoding
      WHERE byte_index = length(source) + 1
    ) AS component
  )
  WHERE project_id = NEW.project_id AND session_id = NEW.session_id;
END;

CREATE TRIGGER sessions_worktree_scope_update_guard
BEFORE UPDATE OF worktree_scope_id ON sessions
WHEN (
    NEW.worktree_id IS NULL
    AND NEW.worktree_scope_id IS NOT NULL
  )
  OR (
    NEW.worktree_id IS NOT NULL
    AND NEW.worktree_scope_id IS NOT (
      SELECT 'session:' || MAX(
        CASE WHEN component.component_kind = 'session' THEN component.encoded END
      ) || ':worktree:' || MAX(
        CASE WHEN component.component_kind = 'worktree' THEN component.encoded END
      )
      FROM (
        WITH RECURSIVE
        components(component_kind, component) AS (
          SELECT 'session', NEW.session_id
          UNION ALL
          SELECT 'worktree', NEW.worktree_id
        ),
        encoding(component_kind, source, byte_index, encoded) AS (
          SELECT component_kind, CAST(component AS BLOB), 1, ''
          FROM components
          UNION ALL
          SELECT component_kind, source, byte_index + 1,
                 encoded || CASE
                   WHEN (
                     hex(substr(source, byte_index, 1)) BETWEEN '30' AND '39'
                     OR hex(substr(source, byte_index, 1)) BETWEEN '41' AND '5A'
                     OR hex(substr(source, byte_index, 1)) BETWEEN '61' AND '7A'
                     OR hex(substr(source, byte_index, 1)) IN (
                       '2D', '5F', '2E', '21', '7E', '2A', '27', '28', '29'
                     )
                   ) THEN CAST(substr(source, byte_index, 1) AS TEXT)
                   ELSE '%' || hex(substr(source, byte_index, 1))
                 END
          FROM encoding
          WHERE byte_index <= length(source)
        )
        SELECT component_kind, encoded
        FROM encoding
        WHERE byte_index = length(source) + 1
      ) AS component
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'canonical worktree scope identity is invalid');
END;

CREATE TRIGGER sync_cursor_ref_scope_insert_guard
BEFORE INSERT ON sync_cursors
WHEN length(NEW.repository_id) = 0
  OR trim(NEW.repository_id) <> NEW.repository_id
  OR instr(NEW.repository_id, char(0)) <> 0
  OR length(NEW.ref) = 0
  OR trim(NEW.ref) <> NEW.ref
  OR instr(NEW.ref, char(0)) <> 0
  OR (
    NEW.ref_scope_id IS NOT NULL
    AND NEW.ref_scope_id IS NOT (
      SELECT 'repository:' || MAX(
        CASE WHEN component.component_kind = 'repository' THEN component.encoded END
      ) || ':ref:' || MAX(
        CASE WHEN component.component_kind = 'ref' THEN component.encoded END
      )
      FROM (
        WITH RECURSIVE
        components(component_kind, component) AS (
          SELECT 'repository', NEW.repository_id
          UNION ALL
          SELECT 'ref', NEW.ref
        ),
        encoding(component_kind, source, byte_index, encoded) AS (
          SELECT component_kind, CAST(component AS BLOB), 1, ''
          FROM components
          UNION ALL
          SELECT component_kind, source, byte_index + 1,
                 encoded || CASE
                   WHEN (
                     hex(substr(source, byte_index, 1)) BETWEEN '30' AND '39'
                     OR hex(substr(source, byte_index, 1)) BETWEEN '41' AND '5A'
                     OR hex(substr(source, byte_index, 1)) BETWEEN '61' AND '7A'
                     OR hex(substr(source, byte_index, 1)) IN (
                       '2D', '5F', '2E', '21', '7E', '2A', '27', '28', '29'
                     )
                   ) THEN CAST(substr(source, byte_index, 1) AS TEXT)
                   ELSE '%' || hex(substr(source, byte_index, 1))
                 END
          FROM encoding
          WHERE byte_index <= length(source)
        )
        SELECT component_kind, encoded
        FROM encoding
        WHERE byte_index = length(source) + 1
      ) AS component
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'canonical ref scope identity is invalid');
END;

CREATE TRIGGER sync_cursor_ref_scope_materialize
AFTER INSERT ON sync_cursors
BEGIN
  UPDATE sync_cursors
  SET ref_scope_id = (
    SELECT 'repository:' || MAX(
      CASE WHEN component.component_kind = 'repository' THEN component.encoded END
    ) || ':ref:' || MAX(
      CASE WHEN component.component_kind = 'ref' THEN component.encoded END
    )
    FROM (
      WITH RECURSIVE
      components(component_kind, component) AS (
        SELECT 'repository', NEW.repository_id
        UNION ALL
        SELECT 'ref', NEW.ref
      ),
      encoding(component_kind, source, byte_index, encoded) AS (
        SELECT component_kind, CAST(component AS BLOB), 1, ''
        FROM components
        UNION ALL
        SELECT component_kind, source, byte_index + 1,
               encoded || CASE
                 WHEN (
                   hex(substr(source, byte_index, 1)) BETWEEN '30' AND '39'
                   OR hex(substr(source, byte_index, 1)) BETWEEN '41' AND '5A'
                   OR hex(substr(source, byte_index, 1)) BETWEEN '61' AND '7A'
                   OR hex(substr(source, byte_index, 1)) IN (
                     '2D', '5F', '2E', '21', '7E', '2A', '27', '28', '29'
                   )
                 ) THEN CAST(substr(source, byte_index, 1) AS TEXT)
                 ELSE '%' || hex(substr(source, byte_index, 1))
               END
        FROM encoding
        WHERE byte_index <= length(source)
      )
      SELECT component_kind, encoded
      FROM encoding
      WHERE byte_index = length(source) + 1
    ) AS component
  )
  WHERE project_id = NEW.project_id
    AND repository_id = NEW.repository_id
    AND ref = NEW.ref;
END;

CREATE TRIGGER sync_cursor_ref_scope_update_guard
BEFORE UPDATE OF ref_scope_id ON sync_cursors
WHEN NEW.ref_scope_id IS NOT (
  SELECT 'repository:' || MAX(
    CASE WHEN component.component_kind = 'repository' THEN component.encoded END
  ) || ':ref:' || MAX(
    CASE WHEN component.component_kind = 'ref' THEN component.encoded END
  )
  FROM (
    WITH RECURSIVE
    components(component_kind, component) AS (
      SELECT 'repository', NEW.repository_id
      UNION ALL
      SELECT 'ref', NEW.ref
    ),
    encoding(component_kind, source, byte_index, encoded) AS (
      SELECT component_kind, CAST(component AS BLOB), 1, ''
      FROM components
      UNION ALL
      SELECT component_kind, source, byte_index + 1,
             encoded || CASE
               WHEN (
                 hex(substr(source, byte_index, 1)) BETWEEN '30' AND '39'
                 OR hex(substr(source, byte_index, 1)) BETWEEN '41' AND '5A'
                 OR hex(substr(source, byte_index, 1)) BETWEEN '61' AND '7A'
                 OR hex(substr(source, byte_index, 1)) IN (
                   '2D', '5F', '2E', '21', '7E', '2A', '27', '28', '29'
                 )
               ) THEN CAST(substr(source, byte_index, 1) AS TEXT)
               ELSE '%' || hex(substr(source, byte_index, 1))
             END
      FROM encoding
      WHERE byte_index <= length(source)
    )
    SELECT component_kind, encoded
    FROM encoding
    WHERE byte_index = length(source) + 1
  ) AS component
)
BEGIN
  SELECT RAISE(ABORT, 'canonical ref scope identity is invalid');
END;

CREATE TRIGGER sync_cursor_repository_ownership_insert_guard
BEFORE INSERT ON sync_cursors
WHEN NOT EXISTS (
  SELECT 1
  FROM repositories AS repository
  WHERE repository.project_id = NEW.project_id
    AND repository.repository_id = NEW.repository_id
)
BEGIN
  SELECT RAISE(ABORT, 'sync cursor repository ownership is invalid');
END;

CREATE TRIGGER sync_cursor_repository_ownership_update_guard
BEFORE UPDATE OF project_id, repository_id ON sync_cursors
WHEN NOT EXISTS (
  SELECT 1
  FROM repositories AS repository
  WHERE repository.project_id = NEW.project_id
    AND repository.repository_id = NEW.repository_id
)
BEGIN
  SELECT RAISE(ABORT, 'sync cursor repository ownership is invalid');
END;

CREATE TRIGGER sync_cursor_scope_identity_immutable
BEFORE UPDATE OF project_id, repository_id, ref ON sync_cursors
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.repository_id IS NOT OLD.repository_id
  OR NEW.ref IS NOT OLD.ref
BEGIN
  SELECT RAISE(
    ABORT,
    'sync cursor repository ownership is invalid; sync cursor scope identity is immutable'
  );
END;

CREATE TRIGGER sync_cursor_scope_ownership_delete_guard
BEFORE DELETE ON sync_cursors
WHEN NOT EXISTS (
    SELECT 1 FROM projects
    WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
  )
  AND (
    EXISTS (
      SELECT 1
      FROM canonical_repository_scope_ownership AS ownership
      JOIN project_grants AS grant_record
        ON grant_record.project_id = ownership.project_id
       AND grant_record.scope_kind = ownership.scope_kind
       AND grant_record.scope_id = ownership.scope_id
      WHERE ownership.project_id = OLD.project_id
        AND ownership.scope_kind = 'ref'
        AND ownership.repository_id = OLD.repository_id
        AND ownership.source_id = OLD.ref
    )
    OR EXISTS (
      SELECT 1
      FROM canonical_repository_scope_ownership AS ownership
      JOIN memories AS memory_record
        ON memory_record.project_id = ownership.project_id
       AND memory_record.scope = ownership.scope_kind
       AND memory_record.scope_id = ownership.scope_id
      WHERE ownership.project_id = OLD.project_id
        AND ownership.scope_kind = 'ref'
        AND ownership.repository_id = OLD.repository_id
        AND ownership.source_id = OLD.ref
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'ref scope ownership is referenced');
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

CREATE TRIGGER sync_cursors_version_monotonic
BEFORE UPDATE OF cursor_version ON sync_cursors
WHEN NEW.cursor_version < OLD.cursor_version
  OR NEW.cursor_version > OLD.cursor_version + 1
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync cursor version cannot decrease');
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

CREATE TRIGGER synthetic_cleanup_projects_update_fence
BEFORE UPDATE ON projects
WHEN EXISTS (
  SELECT 1 FROM synthetic_cleanup_registry
  WHERE project_id = OLD.project_id AND cleanup_fenced_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup is fenced');
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

CREATE TRIGGER synthetic_cleanup_registry_fence_immutable
BEFORE UPDATE OF cleanup_fenced_at ON synthetic_cleanup_registry
WHEN OLD.cleanup_fenced_at IS NOT NULL
  AND NEW.cleanup_fenced_at IS NOT OLD.cleanup_fenced_at
BEGIN
  SELECT RAISE(ABORT, 'synthetic cleanup fence is immutable');
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

CREATE TRIGGER version_evidence_clear_insert_guard
BEFORE INSERT ON version_evidence
WHEN NOT EXISTS (
  SELECT 1
  FROM evidence AS evidence_record
  WHERE evidence_record.project_id = NEW.project_id
    AND evidence_record.evidence_id = NEW.evidence_id
    AND evidence_record.sensitivity_status = 'clear'
)
BEGIN
  SELECT RAISE(ABORT, 'clear evidence is required for a memory version');
END;

CREATE TRIGGER version_evidence_no_delete
BEFORE DELETE ON version_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'version evidence is immutable');
END;

CREATE TRIGGER version_evidence_no_update
BEFORE UPDATE ON version_evidence
BEGIN
  SELECT RAISE(ABORT, 'version evidence is immutable');
END;
