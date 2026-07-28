CREATE TABLE IF NOT EXISTS _memory_fts_chunk_ledger_migration_guard (
  invalid INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS _memory_fts_chunk_ledger_migration_guard_reject
BEFORE INSERT ON _memory_fts_chunk_ledger_migration_guard
WHEN NEW.invalid <> 0
BEGIN
  SELECT RAISE(ABORT, 'legacy search projection must be cleared before chunk ledger migration');
END;

DELETE FROM _memory_fts_chunk_ledger_migration_guard;

INSERT INTO _memory_fts_chunk_ledger_migration_guard (invalid)
SELECT 1
WHERE EXISTS (SELECT 1 FROM memory_fts LIMIT 1)
   OR EXISTS (SELECT 1 FROM memory_projection_heads LIMIT 1);

DROP TRIGGER _memory_fts_chunk_ledger_migration_guard_reject;
DROP TABLE _memory_fts_chunk_ledger_migration_guard;

ALTER TABLE memory_projection_heads
  ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(chunk_count) = 'integer' AND chunk_count >= 0);

CREATE TABLE memory_search_projection_write_leases (
  generation_id TEXT NOT NULL
    REFERENCES search_generations(generation_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    CHECK (length(project_id) > 0 AND trim(project_id) = project_id),
  memory_id TEXT NOT NULL
    CHECK (length(memory_id) > 0 AND trim(memory_id) = memory_id),
  revision_id TEXT NOT NULL
    CHECK (length(revision_id) > 0 AND trim(revision_id) = revision_id),
  project_version INTEGER NOT NULL
    CHECK (typeof(project_version) = 'integer' AND project_version >= 0),
  repository_partition TEXT NOT NULL
    CHECK (
      length(repository_partition) > 0
      AND trim(repository_partition) = repository_partition
    ),
  chunk_count INTEGER NOT NULL
    CHECK (typeof(chunk_count) = 'integer' AND chunk_count >= 0),
  PRIMARY KEY (generation_id, project_id, memory_id)
) WITHOUT ROWID;

CREATE TABLE memory_fts_chunk_ledger (
  fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  generation_id TEXT NOT NULL
    REFERENCES search_generations(generation_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    CHECK (length(project_id) > 0 AND trim(project_id) = project_id),
  memory_id TEXT NOT NULL
    CHECK (length(memory_id) > 0 AND trim(memory_id) = memory_id),
  revision_id TEXT NOT NULL
    CHECK (length(revision_id) > 0 AND trim(revision_id) = revision_id),
  chunk_id TEXT NOT NULL
    CHECK (length(chunk_id) > 0 AND trim(chunk_id) = chunk_id),
  vector_id TEXT NOT NULL
    CHECK (
      length(vector_id) = 64
      AND vector_id NOT GLOB '*[^0-9a-f]*'
    ),
  CHECK (fts_rowid > 0),
  FOREIGN KEY (generation_id, project_id, memory_id)
    REFERENCES memory_projection_heads(generation_id, project_id, memory_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX memory_fts_chunk_ledger_by_owner
  ON memory_fts_chunk_ledger(
    generation_id,
    project_id,
    memory_id,
    revision_id,
    chunk_id
  );

CREATE INDEX memory_fts_chunk_ledger_by_revision
  ON memory_fts_chunk_ledger(
    generation_id,
    project_id,
    revision_id,
    memory_id,
    chunk_id
  );

CREATE UNIQUE INDEX memory_fts_chunk_ledger_by_vector_id
  ON memory_fts_chunk_ledger(vector_id);

CREATE TABLE memory_search_projection_deletions (
  generation_id TEXT NOT NULL
    REFERENCES search_generations(generation_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    CHECK (length(project_id) > 0 AND trim(project_id) = project_id),
  memory_id TEXT NOT NULL
    CHECK (length(memory_id) > 0 AND trim(memory_id) = memory_id),
  revision_id TEXT NOT NULL
    CHECK (length(revision_id) > 0 AND trim(revision_id) = revision_id),
  project_version INTEGER NOT NULL
    CHECK (typeof(project_version) = 'integer' AND project_version >= 0),
  chunk_count INTEGER NOT NULL
    CHECK (typeof(chunk_count) = 'integer' AND chunk_count >= 0),
  PRIMARY KEY (generation_id, project_id, memory_id)
) WITHOUT ROWID;

CREATE TABLE memory_search_vector_cleanup_receipts (
  generation_id TEXT NOT NULL
    REFERENCES search_generations(generation_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL
    CHECK (length(project_id) > 0 AND trim(project_id) = project_id),
  memory_id TEXT NOT NULL
    CHECK (length(memory_id) > 0 AND trim(memory_id) = memory_id),
  revision_id TEXT NOT NULL
    CHECK (length(revision_id) > 0 AND trim(revision_id) = revision_id),
  chunk_id TEXT NOT NULL
    CHECK (length(chunk_id) > 0 AND trim(chunk_id) = chunk_id),
  vector_id TEXT NOT NULL
    CHECK (
      length(vector_id) = 64
      AND vector_id NOT GLOB '*[^0-9a-f]*'
    ),
  cleanup_claim_token TEXT
    CHECK (
      cleanup_claim_token IS NULL
      OR (
        length(cleanup_claim_token) = 64
        AND cleanup_claim_token NOT GLOB '*[^0-9a-f]*'
      )
    ),
  cleanup_claim_started_at TEXT,
  cleanup_claim_expires_at TEXT,
  cleanup_attempt INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(cleanup_attempt) = 'integer'
      AND cleanup_attempt BETWEEN 0 AND 8
    ),
  cleanup_next_attempt_at TEXT,
  cleanup_last_error_code TEXT
    CHECK (
      cleanup_last_error_code IS NULL
      OR cleanup_last_error_code IN (
        'OWNERSHIP_BOUNDARY',
        'CLAIM_INVALID',
        'VECTORIZE_FAILURE',
        'INTERNAL'
      )
    ),
  CHECK (
    (cleanup_claim_token IS NULL AND cleanup_claim_started_at IS NULL
      AND cleanup_claim_expires_at IS NULL)
    OR (
      cleanup_claim_token IS NOT NULL
      AND cleanup_claim_started_at IS NOT NULL
      AND cleanup_claim_expires_at IS NOT NULL
      AND unixepoch(cleanup_claim_started_at) IS NOT NULL
      AND unixepoch(cleanup_claim_expires_at) IS NOT NULL
      AND unixepoch(cleanup_claim_expires_at)
          - unixepoch(cleanup_claim_started_at) = 7200
    )
  ),
  CHECK (
    (cleanup_attempt = 0 AND cleanup_next_attempt_at IS NULL
      AND cleanup_last_error_code IS NULL)
    OR (cleanup_attempt > 0 AND cleanup_next_attempt_at IS NOT NULL
      AND cleanup_last_error_code IS NOT NULL)
  ),
  PRIMARY KEY (generation_id, project_id, memory_id, vector_id)
) WITHOUT ROWID;

CREATE INDEX memory_search_vector_cleanup_by_revision
  ON memory_search_vector_cleanup_receipts(
    generation_id,
    project_id,
    revision_id,
    memory_id,
    chunk_id
  );

CREATE INDEX memory_search_vector_cleanup_by_owner
  ON memory_search_vector_cleanup_receipts(
    generation_id,
    project_id,
    memory_id,
    vector_id
  );

CREATE TABLE memory_search_vector_cleanup_janitor_state (
  state_id INTEGER PRIMARY KEY CHECK (state_id = 1),
  cursor_version INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(cursor_version) = 'integer' AND cursor_version >= 0),
  cursor_generation_id TEXT,
  cursor_project_id TEXT,
  cursor_memory_id TEXT,
  updated_at TEXT,
  CHECK (
    (cursor_generation_id IS NULL AND cursor_project_id IS NULL
      AND cursor_memory_id IS NULL AND updated_at IS NULL)
    OR (cursor_generation_id IS NOT NULL AND cursor_project_id IS NOT NULL
      AND cursor_memory_id IS NOT NULL AND updated_at IS NOT NULL)
  )
);

INSERT INTO memory_search_vector_cleanup_janitor_state (state_id) VALUES (1);

CREATE TABLE memory_fts_chunk_ledger_assertions (
  invalid INTEGER NOT NULL CHECK (invalid = 0)
);

CREATE TRIGGER memory_projection_heads_write_lease_insert
BEFORE INSERT ON memory_projection_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM memory_search_projection_write_leases
  WHERE generation_id = NEW.generation_id
    AND project_id = NEW.project_id
    AND memory_id = NEW.memory_id
    AND revision_id = NEW.revision_id
    AND project_version = NEW.project_version
    AND repository_partition = NEW.repository_partition
    AND chunk_count = NEW.chunk_count
)
BEGIN
  SELECT RAISE(ABORT, 'projection head write requires the chunk ledger protocol');
END;

CREATE TRIGGER memory_projection_heads_write_lease_update
BEFORE UPDATE ON memory_projection_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM memory_search_projection_write_leases
  WHERE generation_id = NEW.generation_id
    AND project_id = NEW.project_id
    AND memory_id = NEW.memory_id
    AND revision_id = NEW.revision_id
    AND project_version = NEW.project_version
    AND repository_partition = NEW.repository_partition
    AND chunk_count = NEW.chunk_count
)
BEGIN
  SELECT RAISE(ABORT, 'projection head write requires the chunk ledger protocol');
END;

CREATE TRIGGER memory_search_projection_write_leases_immutable
BEFORE UPDATE ON memory_search_projection_write_leases
BEGIN
  SELECT RAISE(ABORT, 'search projection write leases are immutable');
END;

CREATE TRIGGER memory_fts_chunk_ledger_insert_head_guard
BEFORE INSERT ON memory_fts_chunk_ledger
WHEN NOT EXISTS (
  SELECT 1
  FROM memory_projection_heads
  WHERE generation_id = NEW.generation_id
    AND project_id = NEW.project_id
    AND memory_id = NEW.memory_id
    AND revision_id = NEW.revision_id
)
BEGIN
  SELECT RAISE(ABORT, 'chunk ledger must reference the exact projection head');
END;

CREATE TRIGGER memory_fts_chunk_ledger_immutable
BEFORE UPDATE ON memory_fts_chunk_ledger
BEGIN
  SELECT RAISE(ABORT, 'chunk ledger rows are immutable');
END;

CREATE TRIGGER memory_fts_chunk_ledger_delete_ownership_guard
BEFORE DELETE ON memory_fts_chunk_ledger
WHEN EXISTS (
       SELECT 1 FROM memory_fts WHERE rowid = OLD.fts_rowid
     )
  AND NOT EXISTS (
       SELECT 1
       FROM memory_fts
       WHERE rowid = OLD.fts_rowid
         AND generation_id = OLD.generation_id
         AND project_id = OLD.project_id
         AND memory_id = OLD.memory_id
         AND revision_id = OLD.revision_id
         AND chunk_id = OLD.chunk_id
     )
BEGIN
  SELECT RAISE(ABORT, 'chunk ledger does not own its FTS row');
END;

CREATE TRIGGER memory_fts_chunk_ledger_delete_fts
BEFORE DELETE ON memory_fts_chunk_ledger
BEGIN
  DELETE FROM memory_fts
  WHERE rowid = OLD.fts_rowid
    AND generation_id = OLD.generation_id
    AND project_id = OLD.project_id
    AND memory_id = OLD.memory_id
    AND revision_id = OLD.revision_id
    AND chunk_id = OLD.chunk_id;
END;

CREATE TRIGGER memory_projection_heads_chunk_ledger_delete_guard
BEFORE DELETE ON memory_projection_heads
WHEN OLD.chunk_count <> (
       SELECT COUNT(*)
       FROM memory_fts_chunk_ledger
       WHERE generation_id = OLD.generation_id
         AND project_id = OLD.project_id
         AND memory_id = OLD.memory_id
     )
  OR EXISTS (
       SELECT 1
       FROM memory_fts_chunk_ledger
       WHERE generation_id = OLD.generation_id
         AND project_id = OLD.project_id
         AND memory_id = OLD.memory_id
         AND revision_id <> OLD.revision_id
     )
BEGIN
  SELECT RAISE(ABORT, 'projection head chunk ledger is inconsistent');
END;

CREATE TRIGGER memory_projection_heads_cleanup_receipts
AFTER DELETE ON memory_projection_heads
BEGIN
  DELETE FROM memory_search_projection_deletions
  WHERE generation_id = OLD.generation_id
    AND project_id = OLD.project_id
    AND memory_id = OLD.memory_id;

  DELETE FROM memory_search_projection_write_leases
  WHERE generation_id = OLD.generation_id
    AND project_id = OLD.project_id
    AND memory_id = OLD.memory_id;
END;

CREATE TRIGGER memory_search_projection_deletions_immutable
BEFORE UPDATE ON memory_search_projection_deletions
BEGIN
  SELECT RAISE(ABORT, 'search projection deletion receipts are immutable');
END;

CREATE TRIGGER memory_search_vector_cleanup_receipts_immutable
BEFORE UPDATE ON memory_search_vector_cleanup_receipts
WHEN NEW.generation_id <> OLD.generation_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.memory_id <> OLD.memory_id
  OR NEW.revision_id <> OLD.revision_id
  OR NEW.chunk_id <> OLD.chunk_id
  OR NEW.vector_id <> OLD.vector_id
BEGIN
  SELECT RAISE(ABORT, 'search vector cleanup receipt ownership is immutable');
END;
