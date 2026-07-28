CREATE TABLE migration_0009_repository_scope_runtime_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT repository_scope_runtime_preflight_failed CHECK (must_be_zero = 0)
);

INSERT INTO migration_0009_repository_scope_runtime_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (SELECT 1 FROM invalid_session_repository_metadata)
   OR EXISTS (SELECT 1 FROM invalid_sync_cursor_repository_ownership)
   OR EXISTS (SELECT 1 FROM invalid_canonical_repository_scope_ownership)
   OR EXISTS (
     SELECT 1 FROM sync_cursors WHERE ref_scope_id IS NULL
   )
   OR EXISTS (
     SELECT 1
     FROM sessions
     WHERE (worktree_id IS NULL AND worktree_scope_id IS NOT NULL)
        OR (worktree_id IS NOT NULL AND worktree_scope_id IS NULL)
   );

DROP TABLE migration_0009_repository_scope_runtime_preflight;

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

CREATE TRIGGER project_grant_id_immutable
BEFORE UPDATE OF grant_id ON project_grants
WHEN NEW.grant_id IS NOT OLD.grant_id
BEGIN
  SELECT RAISE(ABORT, 'project grant identity is immutable');
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

CREATE TRIGGER memory_scope_identity_immutable
BEFORE UPDATE OF memory_id, project_id, scope, scope_id ON memories
WHEN NEW.memory_id IS NOT OLD.memory_id
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.scope IS NOT OLD.scope
  OR NEW.scope_id IS NOT OLD.scope_id
BEGIN
  SELECT RAISE(ABORT, 'memory scope identity is immutable');
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
