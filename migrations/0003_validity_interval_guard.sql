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
