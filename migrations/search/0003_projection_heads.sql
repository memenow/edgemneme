CREATE TABLE memory_projection_heads (
  generation_id TEXT NOT NULL
    REFERENCES search_generations(generation_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL CHECK (length(project_id) > 0),
  memory_id TEXT NOT NULL CHECK (length(memory_id) > 0),
  project_version INTEGER NOT NULL CHECK (project_version >= 0),
  revision_id TEXT NOT NULL CHECK (length(revision_id) > 0),
  PRIMARY KEY (generation_id, project_id, memory_id)
) WITHOUT ROWID;
