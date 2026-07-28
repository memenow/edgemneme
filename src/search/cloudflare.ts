import { normalizeLexicalQuery } from "./lexical";
import { SearchPipeline } from "./pipeline";
import { defineIndexGenerationMetadata } from "./ranking";
import { D1CurrentHeadValidator } from "./current-head";
import type {
  ExactReference,
  HardFilterPlan,
  IndexGenerationMetadata,
  RecallHit,
  RecallInput,
  RecallProvider,
  RerankedCandidate,
  Reranker,
  RerankInput,
  ValidatedSearchCandidate
} from "./types";

export { D1CurrentHeadValidator } from "./current-head";

export const QWEN_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const BGE_RERANKER_MODEL = "@cf/baai/bge-reranker-base";
export const QWEN_EMBEDDING_DIMENSIONS = 1024;

const QUERY_INSTRUCTION =
  "Represent this query for retrieval of evidence-backed project memory passages.";
const MAX_RECALL_RESULTS = 20;
const MAX_RERANK_CANDIDATES = 20;
const MAX_EMBEDDING_QUERY_CHARACTERS = 4_096;
const MAX_RERANK_CONTEXT_CHARACTERS = 16_384;

interface ActiveGenerationRow {
  generation_id: string;
  embedding_model: string;
  embedding_dimensions: number;
  distance_metric: string;
  instruction_version: string;
  chunk_schema_version: string;
  reranker_model: string;
  activated_at: string | null;
}

interface ProjectionRow {
  generation_id: string;
  project_id: string;
  memory_id: string;
  revision_id: string;
  chunk_id: string;
  source_score?: number;
}

export interface CloudflareSearchBindings {
  searchDatabase: D1Database;
  memoryDatabase: D1Database;
  vectors: VectorizeIndex;
  ai: Ai;
}

export interface CloudflareSearchRuntime {
  pipeline: SearchPipeline;
  generation: IndexGenerationMetadata;
}

export async function readActiveSearchGeneration(
  database: D1Database
): Promise<IndexGenerationMetadata> {
  const result = await database
    .prepare(
      `SELECT generation_id, embedding_model, embedding_dimensions, distance_metric,
              instruction_version, chunk_schema_version, reranker_model, activated_at
       FROM search_generations
       WHERE status = 'active'
       ORDER BY generation_id ASC
       LIMIT 2`
    )
    .all<ActiveGenerationRow>();
  if (result.results.length !== 1) {
    throw new Error("Exactly one active search generation is required.");
  }
  const row = result.results[0];
  if (
    row === undefined ||
    row.embedding_model !== QWEN_EMBEDDING_MODEL ||
    row.embedding_dimensions !== QWEN_EMBEDDING_DIMENSIONS ||
    row.distance_metric !== "cosine" ||
    row.reranker_model !== BGE_RERANKER_MODEL ||
    !isTimestamp(row.activated_at)
  ) {
    throw new Error("The active search generation is incompatible with this runtime.");
  }
  return defineIndexGenerationMetadata({
    id: requireIdentifier(row.generation_id, "generation ID"),
    embeddingModel: row.embedding_model,
    embeddingDimensions: row.embedding_dimensions,
    distanceMetric: "cosine",
    instructionVersion: requireIdentifier(row.instruction_version, "instruction version"),
    chunkSchemaVersion: requireIdentifier(row.chunk_schema_version, "chunk schema version"),
    rerankerModel: row.reranker_model
  });
}

export class SearchDbExactRecallProvider implements RecallProvider {
  constructor(private readonly database: D1Database) {}

  async recall(input: RecallInput): Promise<RecallHit[]> {
    if (input.exactReferences.length === 0) {
      return [];
    }
    const hardFilters = projectionFilters(input.filters);
    const exact = exactPredicates(input.exactReferences);
    const result = await this.database
      .prepare(
        `SELECT memory_fts.generation_id, memory_fts.project_id, memory_fts.memory_id,
                memory_fts.revision_id, memory_fts.chunk_id
         FROM memory_fts
         JOIN memory_projection_heads visibility
           ON visibility.generation_id = memory_fts.generation_id
          AND visibility.project_id = memory_fts.project_id
          AND visibility.memory_id = memory_fts.memory_id
          AND visibility.revision_id = memory_fts.revision_id
         WHERE ${hardFilters.sql} AND (${exact.sql})
         ORDER BY memory_fts.memory_id ASC, memory_fts.revision_id ASC,
                  memory_fts.chunk_id ASC
         LIMIT ?`
      )
      .bind(...hardFilters.bindings, ...exact.bindings, normalizeLimit(input.limit))
      .all<ProjectionRow>();
    return validateProjectionRows(result.results, input, "exact");
  }
}

export class SearchDbLexicalRecallProvider implements RecallProvider {
  constructor(private readonly database: D1Database) {}

  async recall(input: RecallInput): Promise<RecallHit[]> {
    if (input.lexicalQuery === null) {
      return [];
    }
    const lexicalQuery = requireIdentifier(input.lexicalQuery, "FTS query");
    if (normalizeLexicalQuery(input.query).ftsQuery !== lexicalQuery) {
      throw new TypeError("The FTS expression must match the normalized lexical query.");
    }
    const hardFilters = projectionFilters(input.filters);
    const result = await this.database
      .prepare(
        `SELECT memory_fts.generation_id, memory_fts.project_id, memory_fts.memory_id,
                memory_fts.revision_id, memory_fts.chunk_id,
                bm25(memory_fts) AS source_score
         FROM memory_fts
         JOIN memory_projection_heads visibility
           ON visibility.generation_id = memory_fts.generation_id
          AND visibility.project_id = memory_fts.project_id
          AND visibility.memory_id = memory_fts.memory_id
          AND visibility.revision_id = memory_fts.revision_id
         WHERE memory_fts MATCH ? AND ${hardFilters.sql}
         ORDER BY bm25(memory_fts), memory_fts.memory_id ASC,
                  memory_fts.revision_id ASC, memory_fts.chunk_id ASC
         LIMIT ?`
      )
      .bind(lexicalQuery, ...hardFilters.bindings, normalizeLimit(input.limit))
      .all<ProjectionRow>();
    return validateProjectionRows(result.results, input, "lexical");
  }
}

export class QwenVectorRecallProvider implements RecallProvider {
  constructor(
    private readonly ai: Ai,
    private readonly vectors: VectorizeIndex,
    private readonly searchDatabase: D1Database
  ) {}

  async recall(input: RecallInput): Promise<RecallHit[]> {
    const query = requireModelText(
      input.query,
      "semantic query",
      MAX_EMBEDDING_QUERY_CHARACTERS
    );
    const rawEmbedding = await runAi(this.ai, QWEN_EMBEDDING_MODEL, {
      queries: [query],
      instruction: QUERY_INSTRUCTION
    });
    const embedding = parseEmbedding(rawEmbedding);
    const rawMatches: unknown = await this.vectors.query(embedding, {
      topK: normalizeLimit(input.limit),
      namespace: input.filters.projectId,
      returnValues: false,
      returnMetadata: "all",
      filter: {
        project_id: input.filters.projectId,
        model_generation: input.filters.indexGeneration,
        ...(input.filters.authorizedRepositoryIds === undefined
          ? {}
          : {
              repository_partition: {
                $in: ["*", ...input.filters.authorizedRepositoryIds]
              }
            })
      }
    });
    const matches = parseVectorMatches(rawMatches, input);
    return validateSemanticProjectionTuples(this.searchDatabase, matches, input);
  }
}

export class WorkersAiBgeReranker implements Reranker {
  constructor(private readonly ai: Ai) {}

  async rerank(input: RerankInput): Promise<RerankedCandidate[]> {
    if (input.candidates.length === 0) {
      return [];
    }
    if (input.candidates.length > MAX_RERANK_CANDIDATES) {
      throw new TypeError(`The reranker accepts at most ${MAX_RERANK_CANDIDATES} candidates.`);
    }
    const query = requireModelText(
      input.query,
      "reranker query",
      MAX_EMBEDDING_QUERY_CHARACTERS
    );
    const contexts = input.candidates.map((candidate) => ({
      text: requireModelText(
        candidate.content,
        "reranker context",
        MAX_RERANK_CONTEXT_CHARACTERS
      )
    }));
    const raw = await runAi(this.ai, BGE_RERANKER_MODEL, {
      query,
      top_k: input.candidates.length,
      contexts
    });
    return parseRerankerOutput(raw, input.candidates);
  }
}

export async function createCloudflareSearchPipeline(
  bindings: CloudflareSearchBindings
): Promise<CloudflareSearchRuntime> {
  const generation = await readActiveSearchGeneration(bindings.searchDatabase);
  return {
    generation,
    pipeline: new SearchPipeline({
      exact: new SearchDbExactRecallProvider(bindings.searchDatabase),
      lexical: new SearchDbLexicalRecallProvider(bindings.searchDatabase),
      semantic: new QwenVectorRecallProvider(
        bindings.ai,
        bindings.vectors,
        bindings.searchDatabase
      ),
      headValidator: new D1CurrentHeadValidator(bindings.memoryDatabase),
      reranker: new WorkersAiBgeReranker(bindings.ai)
    })
  };
}

function projectionFilters(filters: HardFilterPlan): {
  sql: string;
  bindings: unknown[];
} {
  const conditions = ["memory_fts.generation_id = ?", "memory_fts.project_id = ?"];
  const bindings: unknown[] = [filters.indexGeneration, filters.projectId];
  appendInFilter(conditions, bindings, "memory_fts.status", filters.statuses);
  appendInFilter(conditions, bindings, "memory_fts.kind", filters.kinds);
  appendInFilter(conditions, bindings, "memory_fts.memory_class", filters.memoryClasses);
  if (filters.authorizedRepositoryIds !== undefined) {
    appendInFilter(conditions, bindings, "visibility.repository_partition", [
      "*",
      ...filters.authorizedRepositoryIds
    ]);
  }
  if (filters.scope !== undefined) {
    conditions.push("memory_fts.scope = ?");
    bindings.push(filters.scope.type);
    appendInFilter(conditions, bindings, "memory_fts.scope_id", filters.scope.ids);
  }
  conditions.push(
    "(memory_fts.valid_from IS NULL OR julianday(memory_fts.valid_from) <= julianday(?))"
  );
  conditions.push(
    "(memory_fts.valid_until IS NULL OR julianday(memory_fts.valid_until) > julianday(?))"
  );
  bindings.push(filters.validAt, filters.validAt);
  return { sql: conditions.join(" AND "), bindings };
}

function appendInFilter(
  conditions: string[],
  bindings: unknown[],
  column: string,
  values: readonly string[] | undefined
): void {
  if (values === undefined) {
    return;
  }
  if (values.length === 0) {
    throw new TypeError(`${column} requires at least one filter value.`);
  }
  conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  bindings.push(...values);
}

function exactPredicates(references: readonly ExactReference[]): {
  sql: string;
  bindings: unknown[];
} {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  for (const reference of references) {
    const value = requireIdentifier(reference.value, `exact ${reference.type}`);
    if (reference.type === "memory_id") {
      conditions.push("memory_fts.memory_id = ?");
      bindings.push(value);
    } else if (reference.type === "path") {
      conditions.push(
        "(memory_fts.locator = ? OR " +
          "instr(char(10) || memory_fts.locator || char(10), char(10) || ? || char(10)) > 0 OR " +
          "memory_fts.locator LIKE ('%/' || ?) ESCAPE '\\')"
      );
      bindings.push(value, value, escapeLike(value));
    } else if (reference.type === "sha") {
      conditions.push(
        "(memory_fts.locator = ? OR " +
          "instr(char(10) || memory_fts.locator || char(10), char(10) || ? || char(10)) > 0 OR " +
          "memory_fts.locator LIKE '%/' || ? || '/%')"
      );
      bindings.push(value, value, value);
    } else {
      conditions.push(
        "(memory_fts.symbols = ? OR instr(char(10) || memory_fts.symbols || char(10), char(10) || ? || char(10)) > 0)"
      );
      bindings.push(value, value);
    }
  }
  if (conditions.length === 0) {
    throw new TypeError("At least one exact reference is required.");
  }
  return { sql: conditions.join(" OR "), bindings };
}

function validateProjectionRows(
  rows: readonly ProjectionRow[],
  input: RecallInput,
  channel: "exact" | "lexical"
): RecallHit[] {
  return rows.map((row) => {
    if (
      row.project_id !== input.filters.projectId ||
      row.generation_id !== input.filters.indexGeneration
    ) {
      throw new Error("A search projection row crossed its project or generation boundary.");
    }
    const sourceScore = row.source_score;
    if (sourceScore !== undefined && !Number.isFinite(sourceScore)) {
      throw new Error("A search projection row contained an invalid score.");
    }
    return {
      projectId: row.project_id,
      memoryId: requireIdentifier(row.memory_id, "memory ID"),
      revisionId: requireIdentifier(row.revision_id, "revision ID"),
      chunkId: requireIdentifier(row.chunk_id, "chunk ID"),
      indexGeneration: input.filters.indexGeneration,
      ...(sourceScore === undefined ? {} : { sourceScore }),
      channel
    };
  });
}

function parseEmbedding(raw: unknown): number[] {
  const record = requireRecord(raw, "embedding output");
  if (!Array.isArray(record.data) || record.data.length !== 1) {
    throw new Error("The embedding output must contain exactly one vector.");
  }
  const vector = record.data[0];
  if (
    !Array.isArray(vector) ||
    vector.length !== QWEN_EMBEDDING_DIMENSIONS ||
    !vector.every((value) => typeof value === "number" && Number.isFinite(value)) ||
    vector.every((value) => value === 0)
  ) {
    throw new Error(`The embedding output must contain ${QWEN_EMBEDDING_DIMENSIONS} finite values.`);
  }
  if (
    record.shape !== undefined &&
    (!Array.isArray(record.shape) ||
      record.shape.length !== 2 ||
      record.shape[0] !== 1 ||
      record.shape[1] !== QWEN_EMBEDDING_DIMENSIONS)
  ) {
    throw new Error("The embedding output shape is invalid.");
  }
  return vector;
}

function parseVectorMatches(raw: unknown, input: RecallInput): RecallHit[] {
  const record = requireRecord(raw, "Vectorize output");
  if (!Array.isArray(record.matches) || record.count !== record.matches.length) {
    throw new Error("The Vectorize output is invalid.");
  }
  return record.matches.map((value) => {
    const match = requireRecord(value, "Vectorize match");
    const metadata = requireRecord(match.metadata, "Vectorize metadata");
    if (match.namespace !== input.filters.projectId) {
      throw new Error("A Vectorize match crossed its project namespace.");
    }
    if (
      metadata.project_id !== input.filters.projectId ||
      metadata.model_generation !== input.filters.indexGeneration
    ) {
      throw new Error("A Vectorize match crossed its project or generation boundary.");
    }
    if (
      input.filters.authorizedRepositoryIds !== undefined &&
      metadata.repository_partition !== "*" &&
      !input.filters.authorizedRepositoryIds.includes(
        requireIdentifier(metadata.repository_partition, "repository partition")
      )
    ) {
      throw new Error("A Vectorize match crossed its repository boundary.");
    }
    if (
      typeof match.score !== "number" ||
      !Number.isFinite(match.score) ||
      match.score < -1 ||
      match.score > 1
    ) {
      throw new Error("A Vectorize match contained an invalid cosine score.");
    }
    requireIdentifier(match.id, "vector ID");
    return {
      projectId: input.filters.projectId,
      memoryId: requireIdentifier(metadata.memory_id, "memory ID"),
      revisionId: requireIdentifier(metadata.revision_id, "revision ID"),
      chunkId: requireIdentifier(metadata.chunk_id, "chunk ID"),
      indexGeneration: input.filters.indexGeneration,
      sourceScore: match.score,
      channel: "semantic" as const
    };
  });
}

async function validateSemanticProjectionTuples(
  database: D1Database,
  hits: readonly RecallHit[],
  input: RecallInput
): Promise<RecallHit[]> {
  if (hits.length === 0) {
    return [];
  }
  const requested = new Set(hits.map(projectionTupleKey));
  const tuplePredicates = hits.map(
    () =>
      "(memory_fts.memory_id = ? AND memory_fts.revision_id = ? " +
      "AND memory_fts.chunk_id = ?)"
  );
  const tupleBindings = hits.flatMap((hit) => [hit.memoryId, hit.revisionId, hit.chunkId]);
  const visibility =
    input.filters.authorizedRepositoryIds === undefined
      ? { sql: "", bindings: [] as unknown[] }
      : {
          sql:
            `AND visibility.repository_partition IN (` +
            ["*", ...input.filters.authorizedRepositoryIds].map(() => "?").join(", ") +
            ")",
          bindings: ["*", ...input.filters.authorizedRepositoryIds] as unknown[]
        };
  const result = await database
    .prepare(
      `SELECT memory_fts.generation_id, memory_fts.project_id, memory_fts.memory_id,
              memory_fts.revision_id, memory_fts.chunk_id
       FROM memory_fts
       JOIN memory_projection_heads visibility
         ON visibility.generation_id = memory_fts.generation_id
        AND visibility.project_id = memory_fts.project_id
        AND visibility.memory_id = memory_fts.memory_id
        AND visibility.revision_id = memory_fts.revision_id
       WHERE memory_fts.generation_id = ? AND memory_fts.project_id = ?
         ${visibility.sql}
         AND (${tuplePredicates.join(" OR ")})`
    )
    .bind(
      input.filters.indexGeneration,
      input.filters.projectId,
      ...visibility.bindings,
      ...tupleBindings
    )
    .all<ProjectionRow>();
  const observed = new Set<string>();
  for (const row of result.results) {
    if (
      row.project_id !== input.filters.projectId ||
      row.generation_id !== input.filters.indexGeneration
    ) {
      throw new Error("A semantic projection row crossed its project or generation boundary.");
    }
    const key = projectionTupleKey({
      memoryId: requireIdentifier(row.memory_id, "memory ID"),
      revisionId: requireIdentifier(row.revision_id, "revision ID"),
      chunkId: requireIdentifier(row.chunk_id, "chunk ID")
    });
    if (!requested.has(key)) {
      throw new Error("A semantic projection row returned an unrequested projected tuple.");
    }
    observed.add(key);
  }
  return hits.filter((hit) => observed.has(projectionTupleKey(hit)));
}

function parseRerankerOutput(
  raw: unknown,
  candidates: readonly ValidatedSearchCandidate[]
): RerankedCandidate[] {
  const record = requireRecord(raw, "reranker output");
  if (!Array.isArray(record.response) || record.response.length !== candidates.length) {
    throw new Error("The reranker output did not cover every candidate.");
  }
  const seen = new Set<number>();
  return record.response.map((value) => {
    const item = requireRecord(value, "reranker output item");
    if (
      !Number.isSafeInteger(item.id) ||
      typeof item.id !== "number" ||
      item.id < 0 ||
      item.id >= candidates.length ||
      seen.has(item.id) ||
      typeof item.score !== "number" ||
      !Number.isFinite(item.score)
    ) {
      throw new Error("The reranker output is invalid.");
    }
    seen.add(item.id);
    const candidate = candidates[item.id];
    if (candidate === undefined) {
      throw new Error("The reranker output referenced an unavailable candidate.");
    }
    return { candidate, relevance: sigmoid(item.score) };
  });
}

function projectionTupleKey(value: {
  memoryId: string;
  revisionId: string;
  chunkId: string;
}): string {
  return `${value.memoryId}\u0000${value.revisionId}\u0000${value.chunkId}`;
}

function normalizeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("The recall limit must be a positive safe integer.");
  }
  return Math.min(value, MAX_RECALL_RESULTS);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 65_536) {
    throw new TypeError(`The ${label} must be a non-empty string.`);
  }
  return value;
}

function requireModelText(value: unknown, label: string, maximumCharacters: number): string {
  const text = requireIdentifier(value, label);
  if ([...text].length > maximumCharacters) {
    throw new TypeError(`The ${label} exceeds the model input limit.`);
  }
  return text;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/iu.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function sigmoid(value: number): number {
  if (value >= 0) {
    return 1 / (1 + Math.exp(-value));
  }
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

function runAi(
  ai: Ai,
  model: string,
  input: Record<string, unknown>
): Promise<unknown> {
  return (ai as unknown as AiRunner).run(model, input);
}
