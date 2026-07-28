ALTER TABLE memory_projection_heads
  ADD COLUMN repository_partition TEXT;

CREATE TRIGGER memory_projection_heads_repository_partition_insert
BEFORE INSERT ON memory_projection_heads
WHEN NEW.repository_partition IS NULL OR trim(NEW.repository_partition) = ''
BEGIN
  SELECT RAISE(ABORT, 'repository partition is required');
END;

CREATE TRIGGER memory_projection_heads_repository_partition_update
BEFORE UPDATE OF repository_partition ON memory_projection_heads
WHEN NEW.repository_partition IS NULL OR trim(NEW.repository_partition) = ''
BEGIN
  SELECT RAISE(ABORT, 'repository partition is required');
END;

CREATE INDEX memory_projection_heads_by_repository
  ON memory_projection_heads(generation_id, project_id, repository_partition, memory_id);
