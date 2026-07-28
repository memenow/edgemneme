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

CREATE TABLE migration_0007_repository_scope_hardening_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT repository_scope_hardening_preflight_failed CHECK (must_be_zero = 0)
);

INSERT INTO migration_0007_repository_scope_hardening_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (SELECT 1 FROM invalid_session_repository_metadata);

DROP TABLE migration_0007_repository_scope_hardening_preflight;

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
