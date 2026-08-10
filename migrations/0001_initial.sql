PRAGMA foreign_keys = ON;

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
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, provider, external_id),
  UNIQUE (project_id, repository_id)
);

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

CREATE TRIGGER project_grant_single_project_insert
BEFORE INSERT ON project_grants
WHEN EXISTS (
  SELECT 1 FROM project_grants
  WHERE principal_id = NEW.principal_id AND project_id <> NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'principal grants must remain in one project');
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
  closed_at TEXT,
  UNIQUE (project_id, session_id)
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
  recorded_at TEXT NOT NULL,
  UNIQUE (project_id, source_type, locator, excerpt_hash),
  UNIQUE (project_id, evidence_id),
  FOREIGN KEY (project_id, repository_id) REFERENCES repositories(project_id, repository_id)
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

CREATE INDEX workflow_runs_root_lookup
  ON workflow_runs(project_id, root_workflow_id, updated_at);

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
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, consolidation_id),
  UNIQUE (project_id, session_id, session_version),
  FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, session_id)
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
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, repository_id, ref)
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

CREATE INDEX memories_search_filter
  ON memories(project_id, status, kind, memory_class, scope, updated_at);
CREATE INDEX memory_versions_by_memory
  ON memory_versions(project_id, memory_id, memory_version DESC);
CREATE INDEX observations_review_queue
  ON observations(project_id, status, created_at);
CREATE INDEX outbox_pending
  ON outbox_events(project_id, dispatched_at, created_at);
CREATE INDEX evidence_by_repository
  ON evidence(project_id, repository_id, commit_sha);
CREATE INDEX observation_evidence_by_evidence
  ON observation_evidence(project_id, evidence_id, observation_id);
CREATE INDEX review_requests_pending
  ON review_requests(project_id, status, created_at);
CREATE INDEX consolidations_pending
  ON session_consolidations(project_id, status, created_at);
CREATE INDEX github_rate_by_credential
  ON github_rate_observations(credential_version, observed_at DESC);

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

CREATE TRIGGER observation_content_immutable
BEFORE UPDATE OF content, content_sha256, evidence_json, project_id, session_id, principal_id
ON observations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'candidate source is immutable');
END;

CREATE TRIGGER session_close_cas_guard
BEFORE UPDATE OF session_version ON sessions
FOR EACH ROW
WHEN OLD.status != 'open' OR NEW.session_version != OLD.session_version + 1
BEGIN
  SELECT RAISE(ABORT, 'stale session head');
END;

CREATE TRIGGER memory_versions_no_update
BEFORE UPDATE ON memory_versions
BEGIN
  SELECT RAISE(ABORT, 'memory versions are immutable');
END;

CREATE TRIGGER memory_versions_no_delete
BEFORE DELETE ON memory_versions
BEGIN
  SELECT RAISE(ABORT, 'memory versions are immutable');
END;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER version_evidence_no_update
BEFORE UPDATE ON version_evidence
BEGIN
  SELECT RAISE(ABORT, 'version evidence is immutable');
END;

CREATE TRIGGER version_evidence_no_delete
BEFORE DELETE ON version_evidence
BEGIN
  SELECT RAISE(ABORT, 'version evidence is immutable');
END;

CREATE TRIGGER observation_evidence_no_update
BEFORE UPDATE ON observation_evidence
BEGIN
  SELECT RAISE(ABORT, 'observation evidence is immutable');
END;

CREATE TRIGGER observation_evidence_no_delete
BEFORE DELETE ON observation_evidence
BEGIN
  SELECT RAISE(ABORT, 'observation evidence is immutable');
END;

CREATE TRIGGER review_decisions_no_update
BEFORE UPDATE ON review_decisions
BEGIN
  SELECT RAISE(ABORT, 'review decisions are immutable');
END;

CREATE TRIGGER review_decisions_no_delete
BEFORE DELETE ON review_decisions
BEGIN
  SELECT RAISE(ABORT, 'review decisions are immutable');
END;

CREATE TRIGGER consolidation_inputs_no_update
BEFORE UPDATE ON consolidation_inputs
BEGIN
  SELECT RAISE(ABORT, 'consolidation inputs are immutable');
END;

CREATE TRIGGER consolidation_inputs_no_delete
BEFORE DELETE ON consolidation_inputs
BEGIN
  SELECT RAISE(ABORT, 'consolidation inputs are immutable');
END;

CREATE TRIGGER consolidation_outputs_no_update
BEFORE UPDATE ON consolidation_outputs
BEGIN
  SELECT RAISE(ABORT, 'consolidation outputs are immutable');
END;

CREATE TRIGGER consolidation_outputs_no_delete
BEFORE DELETE ON consolidation_outputs
BEGIN
  SELECT RAISE(ABORT, 'consolidation outputs are immutable');
END;

CREATE TRIGGER github_access_baselines_no_update
BEFORE UPDATE ON github_access_baselines
BEGIN
  SELECT RAISE(ABORT, 'GitHub access baselines are immutable');
END;

CREATE TRIGGER github_access_baselines_no_delete
BEFORE DELETE ON github_access_baselines
BEGIN
  SELECT RAISE(ABORT, 'GitHub access baselines are immutable');
END;
