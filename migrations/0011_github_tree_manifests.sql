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

INSERT INTO github_tree_manifest_retention_cursors
  (lane, after_project_id, after_manifest_id, cursor_version, updated_at)
VALUES
  ('staging', '', '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('failed', '', '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

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

CREATE INDEX github_tree_manifests_by_ref
  ON github_tree_manifests(project_id, repository_id, ref, created_at DESC);

CREATE INDEX github_tree_manifests_staging_keyset
  ON github_tree_manifests(project_id, manifest_id)
  WHERE status = 'staging';

CREATE INDEX github_tree_manifests_failed_keyset
  ON github_tree_manifests(project_id, manifest_id)
  WHERE status IN ('failed', 'purging');

CREATE INDEX github_tree_manifest_deltas_by_new_manifest
  ON github_tree_manifest_deltas(
    project_id, repository_id, ref, new_manifest_id, change_kind, path_digest
  );

CREATE INDEX github_tree_manifest_deltas_by_old_manifest
  ON github_tree_manifest_deltas(project_id, old_manifest_id);

CREATE INDEX github_tree_manifest_deltas_by_manifest
  ON github_tree_manifest_deltas(project_id, new_manifest_id);

CREATE INDEX github_tree_ref_heads_by_manifest
  ON github_tree_ref_heads(project_id, manifest_id);

CREATE INDEX github_tree_manifest_lifecycle_by_manifest
  ON github_tree_manifest_lifecycle_events(
    project_id, manifest_id, recorded_at, event_id
  );

CREATE UNIQUE INDEX github_tree_manifest_lifecycle_terminal_once
  ON github_tree_manifest_lifecycle_events(
    project_id, manifest_id, event_type, retention_version
  )
  WHERE event_type IN ('failed', 'purged');

CREATE UNIQUE INDEX github_tree_manifest_lifecycle_chunk_once
  ON github_tree_manifest_lifecycle_events(
    project_id, manifest_id, retention_version, chunk_digest
  )
  WHERE event_type = 'purge_chunk';

CREATE INDEX github_tree_manifest_entries_by_path
  ON github_tree_manifest_entries(
    project_id, path_digest, safe_path, manifest_id
  );

CREATE INDEX evidence_by_repository_ref_path
  ON evidence(
    project_id, repository_id, repository_ref, repository_path, evidence_id
  );

DROP TRIGGER evidence_repository_context_insert_guard;
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

CREATE TRIGGER github_tree_manifests_staging_insert_guard
BEFORE INSERT ON github_tree_manifests
WHEN NEW.status <> 'staging'
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifests must be inserted as staging');
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

CREATE TRIGGER github_tree_manifest_retention_cursors_no_delete
BEFORE DELETE ON github_tree_manifest_retention_cursors
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest retention cursors are fixed');
END;

CREATE TRIGGER github_tree_manifests_identity_immutable
BEFORE UPDATE OF manifest_id, project_id, repository_id, ref, observed_sha, tree_sha,
  repository_authority, collection_key, created_at
ON github_tree_manifests
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest identity is immutable');
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

CREATE TRIGGER github_tree_manifests_no_delete
BEFORE DELETE ON github_tree_manifests
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifests are immutable');
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

CREATE TRIGGER github_tree_manifest_lifecycle_no_update
BEFORE UPDATE ON github_tree_manifest_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest lifecycle events are immutable');
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

CREATE TRIGGER github_tree_manifest_entries_no_update
BEFORE UPDATE ON github_tree_manifest_entries
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest entries are immutable');
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

CREATE TRIGGER github_tree_manifest_deltas_no_update
BEFORE UPDATE ON github_tree_manifest_deltas
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree manifest deltas are immutable');
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

CREATE TRIGGER github_tree_ref_heads_no_delete
BEFORE DELETE ON github_tree_ref_heads
WHEN NOT EXISTS (
  SELECT 1 FROM projects
  WHERE project_id = OLD.project_id AND project_ref GLOB 'system.synthetic.*'
)
BEGIN
  SELECT RAISE(ABORT, 'GitHub tree ref heads cannot be deleted');
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
  OR EXISTS (SELECT 1 FROM memory_repository_contexts WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM observation_evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM memories WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM evidence WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM observations WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM workflow_runs WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM idempotency_records WHERE project_id = OLD.project_id)
  OR EXISTS (SELECT 1 FROM taxonomy_policies WHERE project_id = OLD.project_id)
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
