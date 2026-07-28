CREATE TABLE migration_0006_repository_scope_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT repository_scope_preflight_failed CHECK (must_be_zero = 0)
);

INSERT INTO migration_0006_repository_scope_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (
  SELECT 1
  FROM repositories
  GROUP BY lower(provider), external_id
  HAVING COUNT(*) > 1
)
OR EXISTS (
  SELECT 1
  FROM project_grants AS grant_record
  WHERE (
      grant_record.scope_kind = 'project'
      AND grant_record.scope_id <> grant_record.project_id
    )
    OR (
      grant_record.scope_kind = 'repository'
      AND NOT EXISTS (
        SELECT 1 FROM repositories AS repository
        WHERE repository.project_id = grant_record.project_id
          AND repository.repository_id = grant_record.scope_id
      )
    )
    OR (
      grant_record.scope_kind = 'session'
      AND NOT EXISTS (
        SELECT 1 FROM sessions AS session_record
        JOIN repositories AS repository
          ON repository.project_id = session_record.project_id
         AND repository.repository_id = json_extract(
           session_record.worktree_meta_json,
           '$.repository_id'
         )
        WHERE session_record.project_id = grant_record.project_id
          AND session_record.session_id = grant_record.scope_id
          AND json_type(session_record.worktree_meta_json, '$.repository_id') = 'text'
      )
    )
    OR grant_record.scope_kind IN ('ref', 'worktree')
)
OR EXISTS (
  SELECT 1
  FROM sessions AS session_record
  WHERE (
      json_type(session_record.worktree_meta_json, '$.repository_id') IS NOT NULL
      AND json_type(session_record.worktree_meta_json, '$.repository_id') <> 'text'
    )
    OR (
      json_type(session_record.worktree_meta_json, '$.repository_ref') IS NOT NULL
      AND json_type(session_record.worktree_meta_json, '$.repository_ref') <> 'text'
    )
    OR (
      json_type(session_record.worktree_meta_json, '$.ref') IS NOT NULL
      AND json_type(session_record.worktree_meta_json, '$.ref') <> 'text'
    )
    OR (
      json_type(session_record.worktree_meta_json, '$.worktree_id') IS NOT NULL
      AND json_type(session_record.worktree_meta_json, '$.worktree_id') <> 'text'
    )
    OR (
      json_type(session_record.worktree_meta_json, '$.repository_id') = 'text'
      AND NOT EXISTS (
        SELECT 1 FROM repositories AS repository
        WHERE repository.project_id = session_record.project_id
          AND repository.repository_id = json_extract(
            session_record.worktree_meta_json,
            '$.repository_id'
          )
      )
    )
)
OR EXISTS (
  SELECT 1
  FROM evidence AS evidence_record
  WHERE evidence_record.repository_id IS NOT NULL
)
OR EXISTS (
  SELECT 1
  FROM memories AS memory_record
  WHERE (
      memory_record.scope = 'project'
      AND memory_record.scope_id <> memory_record.project_id
    )
    OR (
      memory_record.scope = 'repository'
      AND NOT EXISTS (
        SELECT 1 FROM repositories AS repository
        WHERE repository.project_id = memory_record.project_id
          AND repository.repository_id = memory_record.scope_id
      )
    )
    OR (
      memory_record.scope = 'session'
      AND NOT EXISTS (
        SELECT 1 FROM sessions AS session_record
        JOIN repositories AS repository
          ON repository.project_id = session_record.project_id
         AND repository.repository_id = json_extract(
           session_record.worktree_meta_json,
           '$.repository_id'
         )
        WHERE session_record.project_id = memory_record.project_id
          AND session_record.session_id = memory_record.scope_id
          AND json_type(session_record.worktree_meta_json, '$.repository_id') = 'text'
      )
    )
    OR memory_record.scope IN ('ref', 'worktree')
);

DROP TABLE migration_0006_repository_scope_preflight;

CREATE UNIQUE INDEX repositories_global_provider_external
  ON repositories(lower(provider), external_id);

CREATE UNIQUE INDEX project_grants_project_identity
  ON project_grants(project_id, grant_id);

ALTER TABLE sessions ADD COLUMN repository_id TEXT REFERENCES repositories(repository_id);
ALTER TABLE sessions ADD COLUMN repository_ref TEXT CHECK (
  repository_ref IS NULL OR (
    length(repository_ref) > 0
    AND trim(repository_ref) = repository_ref
    AND instr(repository_ref, char(0)) = 0
  )
);
ALTER TABLE sessions ADD COLUMN worktree_id TEXT CHECK (
  worktree_id IS NULL OR (
    length(worktree_id) > 0
    AND trim(worktree_id) = worktree_id
    AND instr(worktree_id, char(0)) = 0
  )
);

UPDATE sessions
SET repository_id = json_extract(worktree_meta_json, '$.repository_id'),
    repository_ref = COALESCE(
      json_extract(worktree_meta_json, '$.repository_ref'),
      json_extract(worktree_meta_json, '$.ref')
    ),
    worktree_id = json_extract(worktree_meta_json, '$.worktree_id');

CREATE INDEX sessions_by_repository
  ON sessions(project_id, repository_id, status, opened_at);

ALTER TABLE evidence ADD COLUMN repository_ref TEXT CHECK (
  repository_ref IS NULL OR (
    length(repository_ref) > 0
    AND trim(repository_ref) = repository_ref
    AND instr(repository_ref, char(0)) = 0
  )
);
ALTER TABLE evidence ADD COLUMN repository_path TEXT CHECK (
  repository_path IS NULL OR (
    length(repository_path) > 0
    AND substr(repository_path, 1, 1) <> '/'
    AND instr(repository_path, char(0)) = 0
    AND instr(repository_path, char(92)) = 0
  )
);
ALTER TABLE evidence ADD COLUMN repository_authority TEXT CHECK (
  repository_authority IS NULL OR repository_authority IN (
    'default_branch', 'tracked_ref', 'agent_supplied'
  )
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

INSERT INTO project_grant_repository_contexts
  (project_id, grant_id, repository_id, created_at)
SELECT project_id, grant_id, scope_id, created_at
FROM project_grants
WHERE scope_kind = 'repository';

INSERT INTO project_grant_repository_contexts
  (project_id, grant_id, repository_id, created_at)
SELECT grant_record.project_id, grant_record.grant_id, session_record.repository_id,
       grant_record.created_at
FROM project_grants AS grant_record
JOIN sessions AS session_record
  ON session_record.project_id = grant_record.project_id
 AND session_record.session_id = grant_record.scope_id
WHERE grant_record.scope_kind = 'session';

CREATE INDEX project_grant_contexts_by_repository
  ON project_grant_repository_contexts(project_id, repository_id, grant_id);

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

INSERT INTO memory_repository_contexts
  (project_id, memory_id, repository_id, created_at)
SELECT project_id, memory_id, scope_id, created_at
FROM memories
WHERE scope = 'repository';

INSERT INTO memory_repository_contexts
  (project_id, memory_id, repository_id, created_at)
SELECT memory_record.project_id, memory_record.memory_id, session_record.repository_id,
       memory_record.created_at
FROM memories AS memory_record
JOIN sessions AS session_record
  ON session_record.project_id = memory_record.project_id
 AND session_record.session_id = memory_record.scope_id
WHERE memory_record.scope = 'session';

CREATE INDEX memory_contexts_by_repository
  ON memory_repository_contexts(project_id, repository_id, memory_id);

CREATE TRIGGER repositories_scope_identity_immutable
BEFORE UPDATE OF repository_id, project_id, provider, external_id ON repositories
WHEN NEW.repository_id <> OLD.repository_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.provider <> OLD.provider
  OR NEW.external_id <> OLD.external_id
BEGIN
  SELECT RAISE(ABORT, 'repository scope identity is immutable');
END;

CREATE TRIGGER project_grant_project_scope_insert_guard
BEFORE INSERT ON project_grants
WHEN NEW.scope_kind = 'project' AND NEW.scope_id <> NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'project grant scope is invalid');
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

CREATE TRIGGER sessions_repository_context_immutable
BEFORE UPDATE OF project_id, repository_id, repository_ref, worktree_id ON sessions
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.repository_id IS NOT OLD.repository_id
  OR NEW.repository_ref IS NOT OLD.repository_ref
  OR NEW.worktree_id IS NOT OLD.worktree_id
BEGIN
  SELECT RAISE(ABORT, 'session repository context is immutable');
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
      OR NEW.repository_path IS NULL
      OR NEW.repository_authority NOT IN ('default_branch', 'tracked_ref')
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

CREATE TRIGGER project_grant_repository_context_no_update
BEFORE UPDATE ON project_grant_repository_contexts
BEGIN
  SELECT RAISE(ABORT, 'grant repository context is immutable');
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

CREATE TRIGGER memory_repository_context_no_update
BEFORE UPDATE ON memory_repository_contexts
BEGIN
  SELECT RAISE(ABORT, 'memory repository context is immutable');
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
