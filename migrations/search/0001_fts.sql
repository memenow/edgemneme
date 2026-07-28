CREATE TABLE search_generations (
  generation_id TEXT PRIMARY KEY,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL CHECK (embedding_dimensions > 0),
  distance_metric TEXT NOT NULL CHECK (distance_metric = 'cosine'),
  instruction_version TEXT NOT NULL,
  chunk_schema_version TEXT NOT NULL,
  reranker_model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'active', 'retired')),
  created_at TEXT NOT NULL,
  activated_at TEXT
);

CREATE UNIQUE INDEX one_active_search_generation
  ON search_generations(status)
  WHERE status = 'active';

CREATE VIRTUAL TABLE memory_fts USING fts5(
  generation_id UNINDEXED,
  project_id UNINDEXED,
  memory_id UNINDEXED,
  revision_id UNINDEXED,
  chunk_id UNINDEXED,
  status UNINDEXED,
  kind UNINDEXED,
  memory_class UNINDEXED,
  scope UNINDEXED,
  scope_id UNINDEXED,
  valid_from UNINDEXED,
  valid_until UNINDEXED,
  content,
  locator,
  symbols,
  tokenize = 'unicode61'
);
