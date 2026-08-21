export interface GatewayEnv {
  MEMORY_DB: D1Database;
  SEARCH_DB: D1Database;
  PROJECT_COORDINATOR: DurableObjectNamespace;
  PROJECTIONS: R2Bucket;
  MEMORY_VECTORS: VectorizeIndex;
  AI: Ai;
}
