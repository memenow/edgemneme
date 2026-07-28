UPDATE search_generations
SET status = 'retired'
WHERE status = 'active';

INSERT INTO search_generations (
  generation_id,
  embedding_model,
  embedding_dimensions,
  distance_metric,
  instruction_version,
  chunk_schema_version,
  reranker_model,
  status,
  created_at,
  activated_at
) VALUES (
  'qwen3-embedding-0.6b-chunk-2026-07-25',
  '@cf/qwen/qwen3-embedding-0.6b',
  1024,
  'cosine',
  'query-schema-2026-07-25',
  'chunk-schema-2026-07-25',
  '@cf/baai/bge-reranker-base',
  'active',
  '2026-07-25T00:00:00.000Z',
  '2026-07-25T00:00:00.000Z'
);
