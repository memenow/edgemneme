ALTER TABLE github_sync_dispatch_items
  ADD COLUMN github_request_overflow_count INTEGER NOT NULL DEFAULT 0
    CHECK (
      typeof(github_request_overflow_count) = 'integer'
      AND github_request_overflow_count BETWEEN 0 AND 8
    );

CREATE TRIGGER github_sync_dispatch_items_request_overflow_initial_guard
BEFORE INSERT ON github_sync_dispatch_items
WHEN NEW.github_request_overflow_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'GitHub sync dispatch item request overflow must start at zero');
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
