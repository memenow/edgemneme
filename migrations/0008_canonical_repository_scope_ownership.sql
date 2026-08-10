CREATE VIEW invalid_sync_cursor_repository_ownership AS
SELECT cursor.project_id, cursor.repository_id, cursor.ref
FROM sync_cursors AS cursor
WHERE NOT EXISTS (
  SELECT 1
  FROM repositories AS repository
  WHERE repository.project_id = cursor.project_id
    AND repository.repository_id = cursor.repository_id
);

CREATE TABLE migration_0008_canonical_scope_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT canonical_scope_preflight_failed CHECK (must_be_zero = 0)
);

INSERT INTO migration_0008_canonical_scope_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (SELECT 1 FROM invalid_session_repository_metadata)
   OR EXISTS (SELECT 1 FROM invalid_sync_cursor_repository_ownership);

DROP TABLE migration_0008_canonical_scope_preflight;

ALTER TABLE sync_cursors ADD COLUMN ref_scope_id TEXT CHECK (
  ref_scope_id IS NULL OR (
    length(ref_scope_id) > 0
    AND trim(ref_scope_id) = ref_scope_id
    AND instr(ref_scope_id, char(0)) = 0
  )
);

ALTER TABLE sessions ADD COLUMN worktree_scope_id TEXT CHECK (
  worktree_scope_id IS NULL OR (
    length(worktree_scope_id) > 0
    AND trim(worktree_scope_id) = worktree_scope_id
    AND instr(worktree_scope_id, char(0)) = 0
  )
);

CREATE TABLE migration_0008_scope_component_encodings (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('ref', 'worktree')),
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  component_kind TEXT NOT NULL CHECK (
    component_kind IN ('repository', 'ref', 'session', 'worktree')
  ),
  encoded TEXT NOT NULL,
  PRIMARY KEY (
    source_kind, project_id, repository_id, source_id, component_kind
  )
);

INSERT INTO migration_0008_scope_component_encodings
  (source_kind, project_id, repository_id, source_id, component_kind, encoded)
WITH RECURSIVE
ref_sources(project_id, repository_id, source_id, repository_component, ref_component) AS (
  SELECT cursor.project_id, cursor.repository_id, cursor.ref,
         repository.repository_id, cursor.ref
  FROM sync_cursors AS cursor
  JOIN repositories AS repository
    ON repository.project_id = cursor.project_id
   AND repository.repository_id = cursor.repository_id
  WHERE length(repository.repository_id) > 0
    AND trim(repository.repository_id) = repository.repository_id
    AND instr(repository.repository_id, char(0)) = 0
    AND length(cursor.ref) > 0
    AND trim(cursor.ref) = cursor.ref
    AND instr(cursor.ref, char(0)) = 0
),
worktree_sources(project_id, repository_id, source_id, session_component,
                 worktree_component) AS (
  SELECT project_id, repository_id, session_id, session_id, worktree_id
  FROM sessions
  WHERE repository_id IS NOT NULL
    AND worktree_id IS NOT NULL
    AND length(session_id) > 0
    AND trim(session_id) = session_id
    AND instr(session_id, char(0)) = 0
    AND length(worktree_id) > 0
    AND trim(worktree_id) = worktree_id
    AND instr(worktree_id, char(0)) = 0
),
components(source_kind, project_id, repository_id, source_id, component_kind,
           component) AS (
  SELECT 'ref', project_id, repository_id, source_id, 'repository', repository_component
  FROM ref_sources
  UNION ALL
  SELECT 'ref', project_id, repository_id, source_id, 'ref', ref_component
  FROM ref_sources
  UNION ALL
  SELECT 'worktree', project_id, repository_id, source_id, 'session', session_component
  FROM worktree_sources
  UNION ALL
  SELECT 'worktree', project_id, repository_id, source_id, 'worktree', worktree_component
  FROM worktree_sources
),
encoding(source_kind, project_id, repository_id, source_id, component_kind,
         source, byte_index, encoded) AS (
  SELECT source_kind, project_id, repository_id, source_id, component_kind,
         CAST(component AS BLOB), 1, ''
  FROM components
  UNION ALL
  SELECT source_kind, project_id, repository_id, source_id, component_kind,
         source, byte_index + 1,
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
SELECT source_kind, project_id, repository_id, source_id, component_kind, encoded
FROM encoding
WHERE byte_index = length(source) + 1;

CREATE TABLE migration_0008_scope_ids (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('ref', 'worktree')),
  project_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  PRIMARY KEY (scope_kind, project_id, repository_id, source_id)
);

INSERT INTO migration_0008_scope_ids
  (scope_kind, project_id, repository_id, source_id, scope_id)
SELECT component.source_kind, component.project_id, component.repository_id,
       component.source_id,
       CASE component.source_kind
         WHEN 'ref' THEN
           'repository:' || MAX(
             CASE WHEN component.component_kind = 'repository' THEN component.encoded END
           ) || ':ref:' || MAX(
             CASE WHEN component.component_kind = 'ref' THEN component.encoded END
           )
         ELSE
           'session:' || MAX(
             CASE WHEN component.component_kind = 'session' THEN component.encoded END
           ) || ':worktree:' || MAX(
             CASE WHEN component.component_kind = 'worktree' THEN component.encoded END
           )
       END
FROM migration_0008_scope_component_encodings AS component
GROUP BY component.source_kind, component.project_id,
         component.repository_id, component.source_id
HAVING COUNT(*) = 2;

UPDATE sync_cursors
SET ref_scope_id = (
  SELECT scope.scope_id
  FROM migration_0008_scope_ids AS scope
  WHERE scope.scope_kind = 'ref'
    AND scope.project_id = sync_cursors.project_id
    AND scope.repository_id = sync_cursors.repository_id
    AND scope.source_id = sync_cursors.ref
);

UPDATE sessions
SET worktree_scope_id = (
  SELECT scope.scope_id
  FROM migration_0008_scope_ids AS scope
  WHERE scope.scope_kind = 'worktree'
    AND scope.project_id = sessions.project_id
    AND scope.repository_id = sessions.repository_id
    AND scope.source_id = sessions.session_id
)
WHERE worktree_id IS NOT NULL;

CREATE TABLE migration_0008_materialized_scope_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT canonical_scope_preflight_failed CHECK (must_be_zero = 0)
);

INSERT INTO migration_0008_materialized_scope_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (
  SELECT 1
  FROM sync_cursors AS cursor
  LEFT JOIN migration_0008_scope_ids AS scope
    ON scope.scope_kind = 'ref'
   AND scope.project_id = cursor.project_id
   AND scope.repository_id = cursor.repository_id
   AND scope.source_id = cursor.ref
  WHERE cursor.ref_scope_id IS NULL
     OR cursor.ref_scope_id IS NOT scope.scope_id
)
OR EXISTS (
  SELECT 1
  FROM sessions AS session_record
  LEFT JOIN migration_0008_scope_ids AS scope
    ON scope.scope_kind = 'worktree'
   AND scope.project_id = session_record.project_id
   AND scope.repository_id = session_record.repository_id
   AND scope.source_id = session_record.session_id
  WHERE (
      session_record.worktree_id IS NULL
      AND session_record.worktree_scope_id IS NOT NULL
    )
    OR (
      session_record.worktree_id IS NOT NULL
      AND (
        session_record.worktree_scope_id IS NULL
        OR session_record.worktree_scope_id IS NOT scope.scope_id
      )
    )
);

DROP TABLE migration_0008_materialized_scope_preflight;

CREATE UNIQUE INDEX sync_cursors_by_ref_scope
  ON sync_cursors(project_id, ref_scope_id)
  WHERE ref_scope_id IS NOT NULL;

CREATE UNIQUE INDEX sessions_by_worktree_scope
  ON sessions(project_id, worktree_scope_id)
  WHERE worktree_scope_id IS NOT NULL;

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

CREATE TABLE migration_0008_canonical_scope_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT canonical_scope_preflight_failed CHECK (must_be_zero = 0)
);

INSERT INTO migration_0008_canonical_scope_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (SELECT 1 FROM invalid_canonical_repository_scope_ownership);

DROP TABLE migration_0008_canonical_scope_preflight;
DROP TABLE migration_0008_scope_ids;
DROP TABLE migration_0008_scope_component_encodings;
