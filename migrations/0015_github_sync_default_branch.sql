CREATE TABLE migration_0015_github_default_branch_preflight (
  must_be_zero INTEGER NOT NULL
    CONSTRAINT github_default_branch_preflight_failed CHECK (must_be_zero = 0)
);

INSERT INTO migration_0015_github_default_branch_preflight (must_be_zero)
SELECT 1
WHERE EXISTS (
  SELECT 1
  FROM repositories
  WHERE lower(provider) = 'github'
    AND sync_enabled = 1
    AND (
      default_branch IS NULL
      OR default_branch = ''
      OR instr(hex(default_branch), '00') > 0
      OR default_branch GLOB '*[^A-Za-z0-9._/-]*'
      OR instr(default_branch, '..') > 0
      OR instr(default_branch, '//') > 0
      OR substr(default_branch, 1, 1) = '/'
      OR substr(default_branch, -1) = '/'
    )
);

DROP TABLE migration_0015_github_default_branch_preflight;

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
