import { readActiveSearchGeneration, QWEN_EMBEDDING_MODEL } from "./cloudflare";
import { sha256 } from "../security/crypto";
import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES
} from "../contracts/taxonomy";
import {
  deriveVectorScopeKey,
  requireVectorizeIndexedString,
  vectorizeValidFromEpochMs,
  vectorizeValidUntilEpochMs
} from "./vector-metadata";

interface SearchProjectionEnv {
  memoryDb: D1Database;
  searchDb: D1Database;
  vectors: VectorizeIndex;
  ai: Ai;
}

interface MemoryProjectionRow {
  project_version: number;
  memory_id: string;
  revision_id: string;
  status: string;
  kind: string;
  memory_class: string;
  scope: string;
  scope_id: string;
  repository_id: string | null;
  valid_from: string | null;
  valid_until: string | null;
  content: string;
  locators: string | null;
  commit_shas: string | null;
}

interface PriorChunkRow {
  generation_id: string;
  project_id: string;
  memory_id: string;
  revision_id: string;
  chunk_id: string;
  vector_id: string;
}

interface AuthoritativeHeadRow {
  project_version: number;
  revision_id: string;
}

interface ProjectionHeadRow {
  project_version: number;
  revision_id: string;
  chunk_count: number;
}

interface ProjectionDeletionRow {
  generation_id: string;
  project_id: string;
  memory_id: string;
  revision_id: string;
  project_version: number;
  chunk_count: number;
}

interface ProjectionChunkLedgerRow {
  generation_id: string;
  project_id: string;
  memory_id: string;
  revision_id: string;
  chunk_id: string;
  vector_id: string;
}

interface ClaimedProjectionChunkRow extends ProjectionChunkLedgerRow {
  cleanup_claim_expires_at: string;
}

interface ExpectedVectorMetadata extends Record<string, VectorizeVectorMetadata> {
  project_id: string;
  memory_id: string;
  revision_id: string;
  chunk_id: string;
  model_generation: string;
  status: string;
  repository_partition: string;
  kind: string;
  memory_class: string;
  scope: string;
  scope_id: string;
  scope_key: string;
  valid_from_epoch_ms: number;
  valid_until_epoch_ms: number;
}

interface ExpectedVectorProjection {
  id: string;
  namespace: string;
  metadata: ExpectedVectorMetadata;
}

interface CandidateVector extends ExpectedVectorProjection {
  revisionId: string;
  chunkId: string;
}

interface VectorDeletionPollOptions {
  attempts?: number;
  delayMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface SearchVectorCleanupPageResult {
  examinedReceipts: number;
  pageIdentity: string;
}

const MAX_CHUNK_TOKEN_BUDGET = 4_000;
const EMBEDDING_DIMENSIONS = 1_024;
const MAX_INDEX_TOKENS = 512;
const MAX_INDEX_SYMBOLS = 256;
const MAX_SOURCE_LINE_LENGTH = 2_048;
const VECTOR_AVAILABILITY_ATTEMPTS = 60;
const VECTOR_AVAILABILITY_DELAY_MS = 5_000;
export const SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT = "15 minutes" as const;
export const SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT_MS = 15 * 60 * 1_000;
export const SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS = 2 * 60 * 60 * 1_000;
const GITHUB_LOCATOR =
  /^github:\/\/[1-9][0-9]{0,19}\/([a-f0-9]{7,64})\/(?:ref-sha256\/[a-f0-9]{64}\/)?((?:[A-Za-z0-9_.!~*'()@+-]|%[0-9A-F]{2})+(?:\/(?:[A-Za-z0-9_.!~*'()@+-]|%[0-9A-F]{2})+)*)$/iu;
const SAFE_COMMIT_SHA = /^[a-f0-9]{7,64}$/iu;
const INLINE_CANONICAL_SYMBOL =
  /`([A-Za-z_$][A-Za-z0-9_$]{0,127}(?:(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]{0,127})+)(?:\(\))?`/gu;
const CLASS_DECLARATION =
  /^\s*(?:(?:export|default|abstract|public|private|protected)\s+)*class\s+([A-Za-z_$][A-Za-z0-9_$]{0,127})\b[^\n{]*\{/u;
const CLASS_METHOD_DECLARATION =
  /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]{0,127})\s*\([^\n()]{0,1024}\)\s*(?::[^\n{=;]{0,512})?\s*\{/u;
const SCOPED_DECLARATION =
  /^\s*(?:(?:export|async|function|fn|func)\s+)*([A-Za-z_$][A-Za-z0-9_$]{0,127}(?:::[A-Za-z_$][A-Za-z0-9_$]{0,127})+)\s*\(/u;
const CONTROL_FLOW_NAMES = new Set(["catch", "for", "if", "switch", "while", "with"]);

export async function publishMemorySearchProjection(
  env: SearchProjectionEnv & {
    projectId: string;
    memoryId: string;
    projectVersion: number;
  }
): Promise<boolean> {
  requireVectorizeIndexedString(env.projectId, "project namespace");
  if (!Number.isSafeInteger(env.projectVersion) || env.projectVersion < 0) {
    throw new TypeError("The project version must be a nonnegative safe integer.");
  }
  const generation = await readActiveSearchGeneration(env.searchDb);
  requireVectorizeIndexedString(generation.id, "model generation");
  await cleanupRetiredProjectionVectors(
    env,
    generation.id,
    env.projectId,
    env.memoryId
  );
  const head = await env.memoryDb.withSession("first-primary")
    .prepare(
      `SELECT p.project_version, m.memory_id, v.revision_id,
              m.status, m.kind, m.memory_class,
              m.scope, m.scope_id, memory_context.repository_id,
              v.valid_from, v.valid_until, v.content,
              group_concat(e.locator, '\n') AS locators,
              group_concat(e.commit_sha, '\n') AS commit_shas
       FROM projects p
       JOIN memories m ON m.project_id = p.project_id
       JOIN memory_versions v
          ON v.project_id = m.project_id AND v.revision_id = m.current_revision_id
       LEFT JOIN memory_repository_contexts memory_context
         ON memory_context.project_id = m.project_id
        AND memory_context.memory_id = m.memory_id
       LEFT JOIN version_evidence ve
         ON ve.project_id = v.project_id AND ve.revision_id = v.revision_id
       LEFT JOIN evidence e
         ON e.project_id = ve.project_id
        AND e.evidence_id = ve.evidence_id
        AND e.sensitivity_status = 'clear'
       WHERE p.project_id = ? AND m.memory_id = ?
       GROUP BY p.project_version, m.memory_id, v.revision_id, m.status, m.kind,
                m.memory_class, m.scope, m.scope_id, memory_context.repository_id,
                v.valid_from, v.valid_until, v.content`
    )
    .bind(env.projectId, env.memoryId)
    .first<MemoryProjectionRow>();
  if (head === null) {
    return false;
  }
  if (!Number.isSafeInteger(head.project_version) || head.project_version < 0) {
    throw new Error("The authoritative project version is invalid.");
  }
  const repositoryPartition =
    head.scope === "project" && head.scope_id === env.projectId
      ? "*"
      : requireRepositoryPartition(head.repository_id);
  const status = requireTaxonomyValue(head.status, MEMORY_STATUSES, "memory status");
  const kind = requireTaxonomyValue(head.kind, MEMORY_KINDS, "memory kind");
  const memoryClass = requireTaxonomyValue(
    head.memory_class,
    MEMORY_CLASSES,
    "memory class"
  );
  const scope = requireTaxonomyValue(head.scope, MEMORY_SCOPES, "memory scope");
  const scopeKey = await deriveVectorScopeKey(scope, head.scope_id);
  const validFromEpochMilliseconds = vectorizeValidFromEpochMs(head.valid_from);
  const validUntilEpochMilliseconds = vectorizeValidUntilEpochMs(head.valid_until);
  const chunks = chunkMemoryContent(head.content);
  const locatorIndex = buildLocatorIndex(head.locators, head.commit_shas);
  const symbolIndex = buildSymbolIndex(head.content);
  const vectors: VectorizeVector[] = [];
  const candidateVectors: CandidateVector[] = [];
  for (const [index, content] of chunks.entries()) {
    const chunkId = `chunk-${index}`;
    const raw = await env.ai.run(QWEN_EMBEDDING_MODEL, {
      documents: [content]
    });
    const id = await deriveMemorySearchVectorId(
      generation.id,
      env.projectId,
      head.revision_id,
      chunkId
    );
    const metadata: ExpectedVectorMetadata = {
      project_id: env.projectId,
      memory_id: head.memory_id,
      revision_id: head.revision_id,
      chunk_id: chunkId,
      model_generation: generation.id,
      status,
      repository_partition: repositoryPartition,
      kind,
      memory_class: memoryClass,
      scope,
      scope_id: head.scope_id,
      scope_key: scopeKey,
      valid_from_epoch_ms: validFromEpochMilliseconds,
      valid_until_epoch_ms: validUntilEpochMilliseconds
    };
    candidateVectors.push({
      id,
      namespace: env.projectId,
      metadata,
      revisionId: head.revision_id,
      chunkId
    });
    vectors.push({
      id,
      namespace: env.projectId,
      values: parseQwenEmbedding(raw),
      metadata
    });
  }
  await env.vectors.upsert(vectors);
  await waitForVectorAvailability(env.vectors, candidateVectors);

  const refreshedGeneration = await readActiveSearchGeneration(env.searchDb);
  if (refreshedGeneration.id !== generation.id) {
    await deleteUnpublishedCandidateVectors(env, generation.id, candidateVectors);
    return false;
  }
  const current = await env.memoryDb.withSession("first-primary")
    .prepare(
       `SELECT p.project_version, m.current_revision_id AS revision_id
       FROM projects p JOIN memories m ON m.project_id = p.project_id
       WHERE p.project_id = ? AND m.memory_id = ?`
    )
    .bind(env.projectId, env.memoryId)
    .first<AuthoritativeHeadRow>();
  if (current === null || current.revision_id !== head.revision_id) {
    await deleteUnpublishedCandidateVectors(env, generation.id, candidateVectors);
    return false;
  }
  if (
    !Number.isSafeInteger(current.project_version) ||
    current.project_version < head.project_version
  ) {
    throw new Error("The authoritative project version moved backward.");
  }
  const prior = await env.searchDb.prepare(
    `SELECT generation_id, project_id, memory_id, revision_id, chunk_id, vector_id
     FROM memory_fts_chunk_ledger INDEXED BY memory_fts_chunk_ledger_by_owner
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  )
    .bind(generation.id, env.projectId, env.memoryId)
    .all<PriorChunkRow>();
  for (const row of prior.results) {
    const expectedVectorId = await deriveMemorySearchVectorId(
      generation.id,
      env.projectId,
      row.revision_id,
      row.chunk_id
    );
    if (
      row.generation_id !== generation.id ||
      row.project_id !== env.projectId ||
      row.memory_id !== env.memoryId ||
      row.vector_id !== expectedVectorId
    ) {
      throw new Error("A prior search projection crossed its ownership boundary.");
    }
  }
  let accepted: boolean;
  try {
    accepted = await commitFtsProjection(
      env,
      generation.id,
      head,
      chunks,
      locatorIndex,
      symbolIndex,
      repositoryPartition,
      candidateVectors
    );
  } catch (error) {
    await deleteUnpublishedCandidateVectors(env, generation.id, candidateVectors);
    throw error;
  }
  if (!accepted) {
    await deleteUnpublishedCandidateVectors(env, generation.id, candidateVectors);
    return false;
  }
  await env.vectors.upsert(vectors);
  await waitForVectorAvailability(env.vectors, candidateVectors);
  await cleanupRetiredProjectionVectors(
    env,
    generation.id,
    env.projectId,
    env.memoryId
  );
  return true;
}

async function commitFtsProjection(
  env: SearchProjectionEnv & { projectId: string; memoryId: string },
  generationId: string,
  head: MemoryProjectionRow,
  chunks: readonly string[],
  locatorIndex: string,
  symbolIndex: string,
  repositoryPartition: string,
  candidateVectors: readonly CandidateVector[]
): Promise<boolean> {
  const projectionWriteAllowed =
    `NOT EXISTS (
       SELECT 1 FROM memory_search_projection_deletions
       WHERE generation_id = ? AND project_id = ? AND memory_id = ?
         AND revision_id = ?
     ) AND NOT EXISTS (
       SELECT 1
       FROM memory_search_vector_cleanup_receipts
       INDEXED BY memory_search_vector_cleanup_by_revision
       WHERE generation_id = ? AND project_id = ? AND revision_id = ?
     )`;
  const exactWriteLease =
    `SELECT 1 FROM memory_search_projection_write_leases
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?
       AND revision_id = ? AND project_version = ?
       AND repository_partition = ? AND chunk_count = ?`;
  const statements: D1PreparedStatement[] = [
    env.searchDb.prepare(
      `INSERT INTO memory_search_projection_write_leases
       (generation_id, project_id, memory_id, revision_id, project_version,
        repository_partition, chunk_count)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE ${projectionWriteAllowed}
         AND COALESCE(
           (SELECT (
              ? > project_version
              OR (? = project_version AND ? = revision_id)
            )
            FROM memory_projection_heads
            WHERE generation_id = ? AND project_id = ? AND memory_id = ?),
           1
         ) = 1`
    ).bind(
      generationId,
      env.projectId,
      env.memoryId,
      head.revision_id,
      head.project_version,
      repositoryPartition,
      chunks.length,
      generationId,
      env.projectId,
      env.memoryId,
      head.revision_id,
      generationId,
      env.projectId,
      head.revision_id,
      head.project_version,
      head.project_version,
      head.revision_id,
      generationId,
      env.projectId,
      env.memoryId
    ),
    env.searchDb.prepare(
      `INSERT INTO memory_projection_heads
       (generation_id, project_id, memory_id, project_version, revision_id,
        repository_partition, chunk_count)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (${exactWriteLease})
       ON CONFLICT(generation_id, project_id, memory_id) DO UPDATE SET
         project_version = excluded.project_version,
         revision_id = excluded.revision_id,
         repository_partition = excluded.repository_partition,
         chunk_count = excluded.chunk_count
       WHERE (
         excluded.project_version > memory_projection_heads.project_version
         OR (
           excluded.project_version = memory_projection_heads.project_version
           AND excluded.revision_id = memory_projection_heads.revision_id
         )
       )`
    ).bind(
      generationId,
      env.projectId,
      env.memoryId,
      head.project_version,
      head.revision_id,
      repositoryPartition,
      chunks.length,
      generationId,
      env.projectId,
      env.memoryId,
      head.revision_id,
      head.project_version,
      repositoryPartition,
      chunks.length
    ),
    env.searchDb.prepare(
      `INSERT INTO memory_search_vector_cleanup_receipts
       (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
       SELECT generation_id, project_id, memory_id, revision_id, chunk_id, vector_id
       FROM memory_fts_chunk_ledger INDEXED BY memory_fts_chunk_ledger_by_owner
       WHERE generation_id = ? AND project_id = ? AND memory_id = ?
         AND EXISTS (${exactWriteLease})
       ON CONFLICT(generation_id, project_id, memory_id, vector_id) DO NOTHING`
    ).bind(
      generationId,
      env.projectId,
      env.memoryId,
      generationId,
      env.projectId,
      env.memoryId,
      head.revision_id,
      head.project_version,
      repositoryPartition,
      chunks.length
    ),
    env.searchDb.prepare(
      `DELETE FROM memory_fts_chunk_ledger
       INDEXED BY memory_fts_chunk_ledger_by_owner
       WHERE generation_id = ? AND project_id = ? AND memory_id = ?
         AND EXISTS (${exactWriteLease})`
    ).bind(
      generationId,
      env.projectId,
      env.memoryId,
      generationId,
      env.projectId,
      env.memoryId,
      head.revision_id,
      head.project_version,
      repositoryPartition,
      chunks.length
    )
  ];
  for (const [index, content] of chunks.entries()) {
    const candidate = candidateVectors[index];
    if (
      candidate === undefined ||
      candidate.revisionId !== head.revision_id ||
      candidate.chunkId !== `chunk-${index}`
    ) {
      throw new Error("The Vectorize and FTS chunk projections diverged.");
    }
    statements.push(
      env.searchDb.prepare(
        `INSERT INTO memory_fts_chunk_ledger
         (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (${exactWriteLease})`
      ).bind(
        generationId,
        env.projectId,
        head.memory_id,
        head.revision_id,
        candidate.chunkId,
        candidate.id,
        generationId,
        env.projectId,
        env.memoryId,
        head.revision_id,
        head.project_version,
        repositoryPartition,
        chunks.length
      )
    );
    statements.push(
      env.searchDb.prepare(
        `INSERT INTO memory_fts
         (rowid, generation_id, project_id, memory_id, revision_id, chunk_id, status,
          kind, memory_class, scope, scope_id, valid_from, valid_until, content, locator,
          symbols)
         SELECT ledger.fts_rowid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM memory_fts_chunk_ledger AS ledger
         INDEXED BY memory_fts_chunk_ledger_by_owner
         WHERE ledger.generation_id = ? AND ledger.project_id = ?
           AND ledger.memory_id = ? AND ledger.revision_id = ?
           AND ledger.chunk_id = ? AND ledger.vector_id = ?
           AND EXISTS (${exactWriteLease})`
      ).bind(
        generationId,
        env.projectId,
        head.memory_id,
        head.revision_id,
        `chunk-${index}`,
        head.status,
        head.kind,
        head.memory_class,
        head.scope,
        head.scope_id,
        head.valid_from,
        head.valid_until,
        content,
        locatorIndex,
        symbolIndex,
        generationId,
        env.projectId,
        env.memoryId,
        head.revision_id,
        candidate.chunkId,
        candidate.id,
        generationId,
        env.projectId,
        env.memoryId,
        head.revision_id,
        head.project_version,
        repositoryPartition,
        chunks.length
      )
    );
  }
  statements.push(
    env.searchDb.prepare(
      `INSERT INTO memory_fts_chunk_ledger_assertions (invalid)
       SELECT 1
       WHERE EXISTS (${exactWriteLease})
         AND (
           (SELECT COUNT(*)
            FROM memory_fts_chunk_ledger INDEXED BY memory_fts_chunk_ledger_by_owner
            WHERE generation_id = ? AND project_id = ? AND memory_id = ?) <> ?
           OR EXISTS (
             SELECT 1
             FROM memory_fts_chunk_ledger AS ledger
             INDEXED BY memory_fts_chunk_ledger_by_owner
             WHERE ledger.generation_id = ? AND ledger.project_id = ?
               AND ledger.memory_id = ?
               AND (
                 ledger.revision_id <> ?
                 OR NOT EXISTS (
                   SELECT 1 FROM memory_fts
                   WHERE rowid = ledger.fts_rowid
                     AND generation_id = ledger.generation_id
                     AND project_id = ledger.project_id
                     AND memory_id = ledger.memory_id
                     AND revision_id = ledger.revision_id
                     AND chunk_id = ledger.chunk_id
                 )
               )
           )
         )`
    ).bind(
      generationId,
      env.projectId,
      env.memoryId,
      head.revision_id,
      head.project_version,
      repositoryPartition,
      chunks.length,
      generationId,
      env.projectId,
      env.memoryId,
      chunks.length,
      generationId,
      env.projectId,
      env.memoryId,
      head.revision_id
    )
  );
  statements.push(
    env.searchDb.prepare(
      `DELETE FROM memory_search_projection_write_leases
       WHERE generation_id = ? AND project_id = ? AND memory_id = ?
         AND revision_id = ? AND project_version = ?
         AND repository_partition = ? AND chunk_count = ?`
    ).bind(
      generationId,
      env.projectId,
      env.memoryId,
      head.revision_id,
      head.project_version,
      repositoryPartition,
      chunks.length
    )
  );
  statements.push(
    env.searchDb.prepare(
      `INSERT INTO memory_fts_chunk_ledger_assertions (invalid)
       SELECT 1
       WHERE EXISTS (
         SELECT 1 FROM memory_search_projection_write_leases
         WHERE generation_id = ? AND project_id = ? AND memory_id = ?
       )`
    ).bind(generationId, env.projectId, env.memoryId)
  );
  const results = await env.searchDb.batch(statements);
  return results[1]?.meta.changes === 1;
}

async function cleanupRetiredProjectionVectors(
  env: Pick<SearchProjectionEnv, "searchDb" | "vectors">,
  generationId: string,
  projectId: string,
  memoryId: string
): Promise<void> {
  let previousPage = "";
  for (let page = 0; page < 1_000; page += 1) {
    const result = await cleanupMemorySearchVectorReceiptPage(
      env,
      { generationId, projectId, memoryId },
      { receiptLimit: 50 }
    );
    if (result.examinedReceipts === 0) {
      return;
    }
    if (result.pageIdentity === previousPage) {
      throw new Error("The search vector cleanup receipt did not advance.");
    }
    previousPage = result.pageIdentity;
  }
  throw new Error("The search vector cleanup receipt limit was exceeded.");
}

export async function cleanupMemorySearchVectorReceiptPage(
  env: Pick<SearchProjectionEnv, "searchDb" | "vectors">,
  owner: {
    generationId: string;
    projectId: string;
    memoryId: string;
  },
  options: VectorDeletionPollOptions & {
    receiptLimit?: number;
    now?: () => number;
  } = {}
): Promise<SearchVectorCleanupPageResult> {
  const generationId = requireProjectionIdentifier(owner.generationId, "generation");
  const projectId = requireProjectionIdentifier(owner.projectId, "project");
  const memoryId = requireProjectionIdentifier(owner.memoryId, "memory");
  const receiptLimit = options.receiptLimit ?? 50;
  if (!Number.isSafeInteger(receiptLimit) || receiptLimit < 1 || receiptLimit > 50) {
    throw new TypeError("The search vector cleanup receipt limit is invalid.");
  }
  const now = options.now ?? Date.now;
  const nowMs = now();
  const deletionAttempts = options.attempts ?? VECTOR_AVAILABILITY_ATTEMPTS;
  const deletionDelayMs = options.delayMs ?? VECTOR_AVAILABILITY_DELAY_MS;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("The search vector cleanup claim time is invalid.");
  }
  if (
    !Number.isSafeInteger(deletionAttempts) ||
    deletionAttempts < 1 ||
    deletionAttempts > 120 ||
    !Number.isSafeInteger(deletionDelayMs) ||
    deletionDelayMs < 0 ||
    deletionDelayMs > 30_000 ||
    SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS <=
      Math.max(
        SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT_MS,
        (deletionAttempts - 1) * deletionDelayMs
      ) + 60 * 60 * 1_000
  ) {
    throw new TypeError(
      "The search vector cleanup claim lifetime does not cover its bounded holder window."
    );
  }
  const receipts = await env.searchDb.prepare(
    `SELECT generation_id, project_id, memory_id, revision_id, chunk_id, vector_id
     FROM memory_search_vector_cleanup_receipts
     INDEXED BY memory_search_vector_cleanup_by_owner
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?
     ORDER BY vector_id
     LIMIT ?`
  ).bind(generationId, projectId, memoryId, receiptLimit).all<ProjectionChunkLedgerRow>();
  const pageIdentity = receipts.results.map((row) => row.vector_id).join("\n");
  if (receipts.results.length === 0) {
    return { examinedReceipts: 0, pageIdentity };
  }
  for (const row of receipts.results) {
    const expectedVectorId = await deriveMemorySearchVectorId(
      generationId,
      projectId,
      row.revision_id,
      row.chunk_id
    );
    if (
      row.generation_id !== generationId ||
      row.project_id !== projectId ||
      row.memory_id !== memoryId ||
      !isProjectionIdentifier(row.revision_id) ||
      !isProjectionIdentifier(row.chunk_id) ||
      row.vector_id !== expectedVectorId
    ) {
      throw new Error("A search vector cleanup receipt crossed its ownership boundary.");
    }
  }
  const placeholders = receipts.results.map(() => "?").join(", ");
  const published = await env.searchDb.prepare(
    `SELECT generation_id, project_id, memory_id, revision_id, chunk_id, vector_id
     FROM memory_fts_chunk_ledger INDEXED BY memory_fts_chunk_ledger_by_vector_id
     WHERE vector_id IN (${placeholders})`
  ).bind(...receipts.results.map((row) => row.vector_id)).all<ProjectionChunkLedgerRow>();
  const publishedIds = new Set<string>();
  for (const row of published.results) {
    const expectedVectorId = await deriveMemorySearchVectorId(
      generationId,
      projectId,
      row.revision_id,
      row.chunk_id
    );
    if (
      row.generation_id !== generationId ||
      row.project_id !== projectId ||
      row.memory_id !== memoryId ||
      row.vector_id !== expectedVectorId
    ) {
      throw new Error("A published search vector crossed its cleanup boundary.");
    }
    publishedIds.add(row.vector_id);
  }
  const claimToken = await sha256(
    `edgemneme.search-vector-cleanup\n${crypto.randomUUID()}\n${nowMs}`
  );
  const claimExpiresAt = new Date(
    nowMs + SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS
  ).toISOString();
  const claimedAt = new Date(nowMs).toISOString();
  const deletableRows = receipts.results.filter(
    (row) => !publishedIds.has(row.vector_id)
  );
  const claimResults = deletableRows.length === 0
    ? []
    : await env.searchDb.batch(
        deletableRows.map((row) =>
          env.searchDb.prepare(
            `UPDATE memory_search_vector_cleanup_receipts
             SET cleanup_claim_token = ?, cleanup_claim_started_at = ?,
                 cleanup_claim_expires_at = ?
             WHERE generation_id = ? AND project_id = ? AND memory_id = ?
               AND revision_id = ? AND chunk_id = ? AND vector_id = ?
               AND (
                 cleanup_claim_token IS NULL
                 OR cleanup_claim_expires_at <= ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM memory_fts_chunk_ledger
                 INDEXED BY memory_fts_chunk_ledger_by_vector_id
                 WHERE vector_id = ?
               )`
          ).bind(
            claimToken,
            claimedAt,
            claimExpiresAt,
            generationId,
            projectId,
            memoryId,
            row.revision_id,
            row.chunk_id,
            row.vector_id,
            claimedAt,
            row.vector_id
          )
        )
      );
  if (claimResults.length !== deletableRows.length) {
    throw new Error("The search vector cleanup claim result is incomplete.");
  }
  const claimedRows = deletableRows.filter(
    (_row, index) => claimResults[index]?.meta.changes === 1
  );
  const deletableIds = claimedRows.map((row) => row.vector_id);
  if (deletableIds.length > 0) {
    try {
      await requireCurrentSearchVectorCleanupClaims(
        env.searchDb,
        generationId,
        projectId,
        memoryId,
        claimedRows,
        claimToken,
        now
      );
      await env.vectors.deleteByIds(deletableIds);
      await requireCurrentSearchVectorCleanupClaims(
        env.searchDb,
        generationId,
        projectId,
        memoryId,
        claimedRows,
        claimToken,
        now
      );
      await waitForVectorDeletion(env.vectors, deletableIds, options);
      await requireCurrentSearchVectorCleanupClaims(
        env.searchDb,
        generationId,
        projectId,
        memoryId,
        claimedRows,
        claimToken,
        now
      );
    } catch (error) {
      await releaseSearchVectorCleanupClaims(
        env.searchDb,
        generationId,
        projectId,
        memoryId,
        claimToken
      );
      throw error;
    }
  }
  const finalizedRows = receipts.results.filter(
    (row) => publishedIds.has(row.vector_id) || claimedRows.includes(row)
  );
  if (finalizedRows.length === 0) {
    return { examinedReceipts: receipts.results.length, pageIdentity };
  }
  try {
    const finalizedAt = new Date(requireCleanupClock(now)).toISOString();
    await env.searchDb.batch([
      ...finalizedRows.map((row) => {
        const published = publishedIds.has(row.vector_id);
        const publicationGuard = published
          ? `cleanup_claim_token IS NULL
             AND EXISTS (
             SELECT 1 FROM memory_fts_chunk_ledger
             INDEXED BY memory_fts_chunk_ledger_by_vector_id
             WHERE vector_id = ? AND generation_id = ? AND project_id = ?
               AND memory_id = ?
           )`
          : `cleanup_claim_token = ?
             AND cleanup_claim_expires_at > ?
             AND NOT EXISTS (
             SELECT 1 FROM memory_fts_chunk_ledger
             INDEXED BY memory_fts_chunk_ledger_by_vector_id
             WHERE vector_id = ?
           )
             AND NOT EXISTS (
               SELECT 1 FROM memory_projection_heads
               WHERE generation_id = ? AND project_id = ? AND memory_id = ?
                 AND revision_id = memory_search_vector_cleanup_receipts.revision_id
             )`;
        const publicationBindings = published
          ? [row.vector_id, generationId, projectId, memoryId]
          : [
              claimToken,
              finalizedAt,
              row.vector_id,
              generationId,
              projectId,
              memoryId
            ];
        return env.searchDb.prepare(
          `DELETE FROM memory_search_vector_cleanup_receipts
           WHERE generation_id = ? AND project_id = ? AND memory_id = ?
             AND revision_id = ? AND chunk_id = ? AND vector_id = ?
             AND ${publicationGuard}`
        ).bind(
          generationId,
          projectId,
          memoryId,
          row.revision_id,
          row.chunk_id,
          row.vector_id,
          ...publicationBindings
        );
      }),
      env.searchDb.prepare(
        `UPDATE memory_search_vector_cleanup_receipts
         SET cleanup_claim_token = NULL, cleanup_claim_started_at = NULL,
             cleanup_claim_expires_at = NULL
         WHERE generation_id = ? AND project_id = ? AND memory_id = ?
           AND cleanup_claim_token = ?`
      ).bind(generationId, projectId, memoryId, claimToken)
    ]);
  } catch (error) {
    await releaseSearchVectorCleanupClaims(
      env.searchDb,
      generationId,
      projectId,
      memoryId,
      claimToken
    );
    throw error;
  }
  return { examinedReceipts: receipts.results.length, pageIdentity };
}

async function releaseSearchVectorCleanupClaims(
  searchDb: D1Database,
  generationId: string,
  projectId: string,
  memoryId: string,
  claimToken: string
): Promise<void> {
  await searchDb.prepare(
    `UPDATE memory_search_vector_cleanup_receipts
     SET cleanup_claim_token = NULL, cleanup_claim_started_at = NULL,
         cleanup_claim_expires_at = NULL
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?
       AND cleanup_claim_token = ?`
  ).bind(generationId, projectId, memoryId, claimToken).run();
}

async function requireCurrentSearchVectorCleanupClaims(
  searchDb: D1Database,
  generationId: string,
  projectId: string,
  memoryId: string,
  rows: readonly ProjectionChunkLedgerRow[],
  claimToken: string,
  now: () => number
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const checkedAt = new Date(requireCleanupClock(now)).toISOString();
  const placeholders = rows.map(() => "?").join(", ");
  const current = await searchDb.prepare(
    `SELECT receipt.generation_id, receipt.project_id, receipt.memory_id,
            receipt.revision_id, receipt.chunk_id, receipt.vector_id,
            receipt.cleanup_claim_expires_at
     FROM memory_search_vector_cleanup_receipts AS receipt
     INDEXED BY memory_search_vector_cleanup_by_owner
     WHERE receipt.generation_id = ? AND receipt.project_id = ?
       AND receipt.memory_id = ? AND receipt.cleanup_claim_token = ?
       AND receipt.cleanup_claim_expires_at > ?
       AND receipt.vector_id IN (${placeholders})
       AND NOT EXISTS (
         SELECT 1 FROM memory_fts_chunk_ledger
         INDEXED BY memory_fts_chunk_ledger_by_vector_id
         WHERE vector_id = receipt.vector_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM memory_projection_heads
         WHERE generation_id = receipt.generation_id
           AND project_id = receipt.project_id
           AND memory_id = receipt.memory_id
           AND revision_id = receipt.revision_id
       )`
  ).bind(
    generationId,
    projectId,
    memoryId,
    claimToken,
    checkedAt,
    ...rows.map((row) => row.vector_id)
  ).all<ClaimedProjectionChunkRow>();
  const currentIds = new Set(current.results.map((row) => row.vector_id));
  if (
    current.results.length !== rows.length ||
    rows.some((row) => !currentIds.has(row.vector_id))
  ) {
    throw new SearchVectorCleanupClaimError();
  }
}

function requireCleanupClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("The search vector cleanup claim time is invalid.");
  }
  return value;
}

export class SearchVectorCleanupClaimError extends Error {
  constructor() {
    super("The search vector cleanup claim is no longer current.");
    this.name = "SearchVectorCleanupClaimError";
  }
}

async function deleteUnpublishedCandidateVectors(
  env: Pick<SearchProjectionEnv, "searchDb" | "vectors"> & {
    projectId: string;
    memoryId: string;
  },
  generationId: string,
  candidates: readonly CandidateVector[]
): Promise<void> {
  if (candidates.length === 0) {
    return;
  }
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    const expectedVectorId = await deriveMemorySearchVectorId(
      generationId,
      env.projectId,
      candidate.revisionId,
      candidate.chunkId
    );
    if (
      candidate.namespace !== env.projectId ||
      candidate.metadata.project_id !== env.projectId ||
      candidate.metadata.memory_id !== env.memoryId ||
      candidate.metadata.revision_id !== candidate.revisionId ||
      candidate.metadata.chunk_id !== candidate.chunkId ||
      candidate.metadata.model_generation !== generationId ||
      candidate.id !== expectedVectorId ||
      candidateIds.has(candidate.id)
    ) {
      throw new Error("A stale projection cleanup crossed its ownership boundary.");
    }
    candidateIds.add(candidate.id);
  }
  await env.searchDb.batch(
    candidates.map((candidate) =>
      env.searchDb.prepare(
        `INSERT INTO memory_search_vector_cleanup_receipts
         (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM memory_fts_chunk_ledger
           INDEXED BY memory_fts_chunk_ledger_by_vector_id
           WHERE vector_id = ? AND generation_id = ? AND project_id = ?
             AND memory_id = ? AND revision_id = ? AND chunk_id = ?
         )
         ON CONFLICT(generation_id, project_id, memory_id, vector_id) DO NOTHING`
      ).bind(
        generationId,
        env.projectId,
        env.memoryId,
        candidate.revisionId,
        candidate.chunkId,
        candidate.id,
        candidate.id,
        generationId,
        env.projectId,
        env.memoryId,
        candidate.revisionId,
        candidate.chunkId
      )
    )
  );
  await cleanupRetiredProjectionVectors(
    env,
    generationId,
    env.projectId,
    env.memoryId
  );
}

export async function deleteMemorySearchProjection(
  env: Pick<SearchProjectionEnv, "searchDb" | "vectors"> & {
    generationId: string;
    projectId: string;
    memoryId: string;
    revisionId: string;
    projectVersion: number;
  },
  options: {
    attempts?: number;
    delayMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<boolean> {
  const generationId = requireProjectionIdentifier(env.generationId, "generation");
  const projectId = requireProjectionIdentifier(env.projectId, "project");
  const memoryId = requireProjectionIdentifier(env.memoryId, "memory");
  const revisionId = requireProjectionIdentifier(env.revisionId, "revision");
  if (!Number.isSafeInteger(env.projectVersion) || env.projectVersion < 0) {
    throw new TypeError("The search projection project version is invalid.");
  }

  await cleanupRetiredProjectionVectors(env, generationId, projectId, memoryId);

  let receipt = await readProjectionDeletion(env.searchDb, generationId, projectId, memoryId);
  const head = await readProjectionHead(env.searchDb, generationId, projectId, memoryId);
  if (receipt === null) {
    if (head === null) {
      return true;
    }
    if (
      head.project_version !== env.projectVersion ||
      head.revision_id !== revisionId
    ) {
      return false;
    }
    requireProjectionChunkCount(head.chunk_count);
    const ledger = await readProjectionChunks(
      env.searchDb,
      generationId,
      projectId,
      memoryId
    );
    await validateProjectionChunks(
      ledger,
      generationId,
      projectId,
      memoryId,
      revisionId,
      head.chunk_count
    );
    await env.searchDb.batch([
      env.searchDb.prepare(
        `INSERT INTO memory_search_projection_deletions
         (generation_id, project_id, memory_id, revision_id, project_version,
          chunk_count)
         SELECT generation_id, project_id, memory_id, revision_id, project_version,
                chunk_count
         FROM memory_projection_heads
         WHERE generation_id = ? AND project_id = ? AND memory_id = ?
           AND revision_id = ? AND project_version = ? AND chunk_count = ?
           AND (SELECT COUNT(*)
                FROM memory_fts_chunk_ledger
                INDEXED BY memory_fts_chunk_ledger_by_owner
                WHERE generation_id = ? AND project_id = ? AND memory_id = ?) = ?
           AND NOT EXISTS (
             SELECT 1
             FROM memory_fts_chunk_ledger AS ledger
             INDEXED BY memory_fts_chunk_ledger_by_owner
             WHERE ledger.generation_id = ? AND ledger.project_id = ?
               AND ledger.memory_id = ?
               AND (
                 ledger.revision_id <> ?
                 OR NOT EXISTS (
                   SELECT 1 FROM memory_fts
                   WHERE rowid = ledger.fts_rowid
                     AND generation_id = ledger.generation_id
                     AND project_id = ledger.project_id
                     AND memory_id = ledger.memory_id
                     AND revision_id = ledger.revision_id
                     AND chunk_id = ledger.chunk_id
                 )
               )
           )
         ON CONFLICT(generation_id, project_id, memory_id) DO NOTHING`
      ).bind(
        generationId,
        projectId,
        memoryId,
        revisionId,
        env.projectVersion,
        head.chunk_count,
        generationId,
        projectId,
        memoryId,
        head.chunk_count,
        generationId,
        projectId,
        memoryId,
        revisionId
      )
    ]);
    receipt = await readProjectionDeletion(env.searchDb, generationId, projectId, memoryId);
  }
  if (
    receipt === null ||
    receipt.generation_id !== generationId ||
    receipt.project_id !== projectId ||
    receipt.memory_id !== memoryId ||
    receipt.revision_id !== revisionId ||
    receipt.project_version !== env.projectVersion
  ) {
    return false;
  }
  requireProjectionChunkCount(receipt.chunk_count);
  const vectorIds = await Promise.all(
    Array.from({ length: receipt.chunk_count }, (_, index) =>
      deriveMemorySearchVectorId(generationId, projectId, revisionId, `chunk-${index}`)
    )
  );
  if (vectorIds.length > 0) {
    await env.vectors.deleteByIds(vectorIds);
    await waitForVectorDeletion(env.vectors, vectorIds, options);
  }

  const exactReceipt =
    `SELECT 1 FROM memory_search_projection_deletions
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?
       AND revision_id = ? AND project_version = ? AND chunk_count = ?`;
  await env.searchDb.batch([
    env.searchDb.prepare(
      `DELETE FROM memory_projection_heads
       WHERE generation_id = ? AND project_id = ? AND memory_id = ?
         AND revision_id = ? AND project_version = ? AND chunk_count = ?
         AND EXISTS (${exactReceipt})`
    ).bind(
      generationId,
      projectId,
      memoryId,
      revisionId,
      env.projectVersion,
      receipt.chunk_count,
      generationId,
      projectId,
      memoryId,
      revisionId,
      env.projectVersion,
      receipt.chunk_count
    ),
    env.searchDb.prepare(
      `DELETE FROM memory_search_projection_deletions
       WHERE generation_id = ? AND project_id = ? AND memory_id = ?
         AND revision_id = ? AND project_version = ? AND chunk_count = ?
         AND NOT EXISTS (
           SELECT 1 FROM memory_projection_heads
           WHERE generation_id = ? AND project_id = ? AND memory_id = ?
             AND revision_id = ? AND project_version = ?
         )`
    ).bind(
      generationId,
      projectId,
      memoryId,
      revisionId,
      env.projectVersion,
      receipt.chunk_count,
      generationId,
      projectId,
      memoryId,
      revisionId,
      env.projectVersion
    ),
    env.searchDb.prepare(
      `INSERT INTO memory_fts_chunk_ledger_assertions (invalid)
       SELECT 1
       WHERE EXISTS (${exactReceipt})
          OR EXISTS (
            SELECT 1 FROM memory_projection_heads
            WHERE generation_id = ? AND project_id = ? AND memory_id = ?
              AND revision_id = ? AND project_version = ?
          )
          OR EXISTS (
            SELECT 1
            FROM memory_fts_chunk_ledger INDEXED BY memory_fts_chunk_ledger_by_owner
            WHERE generation_id = ? AND project_id = ? AND memory_id = ?
              AND revision_id = ?
          )`
    ).bind(
      generationId,
      projectId,
      memoryId,
      revisionId,
      env.projectVersion,
      receipt.chunk_count,
      generationId,
      projectId,
      memoryId,
      revisionId,
      env.projectVersion,
      generationId,
      projectId,
      memoryId,
      revisionId
    )
  ]);

  await cleanupRetiredProjectionVectors(env, generationId, projectId, memoryId);

  const [remainingReceipt, remainingHead] = await Promise.all([
    readProjectionDeletion(env.searchDb, generationId, projectId, memoryId),
    readProjectionHead(env.searchDb, generationId, projectId, memoryId)
  ]);
  return (
    remainingReceipt === null &&
    (remainingHead === null ||
      remainingHead.project_version !== env.projectVersion ||
      remainingHead.revision_id !== revisionId)
  );
}

async function readProjectionHead(
  searchDb: D1Database,
  generationId: string,
  projectId: string,
  memoryId: string
): Promise<ProjectionHeadRow | null> {
  return searchDb.prepare(
    `SELECT project_version, revision_id, chunk_count
     FROM memory_projection_heads
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  ).bind(generationId, projectId, memoryId).first<ProjectionHeadRow>();
}

async function readProjectionDeletion(
  searchDb: D1Database,
  generationId: string,
  projectId: string,
  memoryId: string
): Promise<ProjectionDeletionRow | null> {
  return searchDb.prepare(
    `SELECT generation_id, project_id, memory_id, revision_id, project_version,
            chunk_count
     FROM memory_search_projection_deletions
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  ).bind(generationId, projectId, memoryId).first<ProjectionDeletionRow>();
}

async function readProjectionChunks(
  searchDb: D1Database,
  generationId: string,
  projectId: string,
  memoryId: string
): Promise<ProjectionChunkLedgerRow[]> {
  const result = await searchDb.prepare(
    `SELECT generation_id, project_id, memory_id, revision_id, chunk_id, vector_id
     FROM memory_fts_chunk_ledger INDEXED BY memory_fts_chunk_ledger_by_owner
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?
     ORDER BY revision_id, chunk_id`
  ).bind(generationId, projectId, memoryId).all<ProjectionChunkLedgerRow>();
  return result.results;
}

async function validateProjectionChunks(
  chunks: readonly ProjectionChunkLedgerRow[],
  generationId: string,
  projectId: string,
  memoryId: string,
  revisionId: string,
  expectedCount: number
): Promise<void> {
  if (chunks.length !== expectedCount) {
    throw new Error("The search projection chunk ledger is incomplete.");
  }
  const chunksById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
  if (chunksById.size !== chunks.length) {
    throw new Error("The search projection chunk ledger is incomplete.");
  }
  for (let index = 0; index < expectedCount; index += 1) {
    const chunkId = `chunk-${index}`;
    const chunk = chunksById.get(chunkId);
    if (chunk === undefined) {
      throw new Error("The search projection chunk ledger is incomplete.");
    }
    const expectedVectorId = await deriveMemorySearchVectorId(
      generationId,
      projectId,
      revisionId,
      chunkId
    );
    if (
      chunk.generation_id !== generationId ||
      chunk.project_id !== projectId ||
      chunk.memory_id !== memoryId ||
      chunk.revision_id !== revisionId ||
      chunk.chunk_id !== chunkId ||
      chunk.vector_id !== expectedVectorId
    ) {
      throw new Error("The search projection chunk ledger crossed its ownership boundary.");
    }
  }
}

async function waitForVectorDeletion(
  vectors: VectorizeIndex,
  vectorIds: readonly string[],
  options: {
    attempts?: number;
    delayMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
  }
): Promise<void> {
  const attempts = options.attempts ?? VECTOR_AVAILABILITY_ATTEMPTS;
  const delayMs = options.delayMs ?? VECTOR_AVAILABILITY_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120) {
    throw new TypeError("The Vectorize deletion attempt limit is invalid.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
    throw new TypeError("The Vectorize deletion delay is invalid.");
  }
  const expected = new Set(vectorIds);
  if (expected.size !== vectorIds.length || vectorIds.some((id) => !isSha256(id))) {
    throw new TypeError("The Vectorize deletion identifiers are invalid.");
  }
  const delay = options.delay ?? defaultDelay;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remaining = await vectors.getByIds([...vectorIds]);
    const observed = new Set<string>();
    for (const vector of remaining) {
      if (!expected.has(vector.id) || observed.has(vector.id)) {
        throw new Error("Vectorize returned an invalid deletion result.");
      }
      observed.add(vector.id);
    }
    if (observed.size === 0) {
      return;
    }
    if (attempt + 1 < attempts) {
      await delay(delayMs);
    }
  }
  throw new Error("The Vectorize projection did not become deleted.");
}

export async function waitForVectorAvailability(
  vectors: VectorizeIndex,
  expectedVectors: readonly ExpectedVectorProjection[],
  options: {
    attempts?: number;
    delayMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<void> {
  const attempts = options.attempts ?? VECTOR_AVAILABILITY_ATTEMPTS;
  const delayMs = options.delayMs ?? VECTOR_AVAILABILITY_DELAY_MS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120) {
    throw new TypeError("The Vectorize availability attempt limit is invalid.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
    throw new TypeError("The Vectorize availability delay is invalid.");
  }
  if (expectedVectors.some((vector) => !isValidExpectedVector(vector))) {
    throw new TypeError("The expected Vectorize projections are invalid.");
  }
  const vectorIds = expectedVectors.map((vector) => vector.id);
  const expected = new Map(expectedVectors.map((vector) => [vector.id, vector]));
  if (expected.size !== vectorIds.length) {
    throw new TypeError("The expected Vectorize projections are invalid.");
  }
  const delay = options.delay ?? defaultDelay;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const available = await vectors.getByIds(vectorIds);
    const availableIds = new Set<string>();
    let authoritative = true;
    for (const vector of available) {
      if (!expected.has(vector.id)) {
        throw new Error("Vectorize returned an unexpected projection identifier.");
      }
      if (availableIds.has(vector.id)) {
        throw new Error("Vectorize returned a duplicate projection identifier.");
      }
      availableIds.add(vector.id);
      const expectedVector = expected.get(vector.id);
      if (expectedVector === undefined || !hasAuthoritativeVectorMetadata(vector, expectedVector)) {
        authoritative = false;
      }
    }
    if (authoritative && availableIds.size === expected.size) {
      return;
    }
    if (attempt + 1 < attempts) {
      await delay(delayMs);
    }
  }
  throw new Error("The Vectorize projection did not become readable.");
}

function isValidExpectedVector(vector: ExpectedVectorProjection): boolean {
  if (
    typeof vector !== "object" ||
    vector === null ||
    typeof vector.metadata !== "object" ||
    vector.metadata === null
  ) {
    return false;
  }
  const values = [
    vector.id,
    vector.namespace,
    vector.metadata.project_id,
    vector.metadata.memory_id,
    vector.metadata.revision_id,
    vector.metadata.chunk_id,
    vector.metadata.model_generation,
    vector.metadata.status,
    vector.metadata.repository_partition,
    vector.metadata.kind,
    vector.metadata.memory_class,
    vector.metadata.scope,
    vector.metadata.scope_id,
    vector.metadata.scope_key
  ];
  return (
    vector.namespace === vector.metadata.project_id &&
    values.every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.trim() === value &&
        !value.includes("\0")
    ) &&
    Number.isSafeInteger(vector.metadata.valid_from_epoch_ms) &&
    Number.isSafeInteger(vector.metadata.valid_until_epoch_ms)
  );
}

function hasAuthoritativeVectorMetadata(
  vector: VectorizeVector,
  expected: ExpectedVectorProjection
): boolean {
  if (vector.namespace !== expected.namespace) {
    return false;
  }
  const metadata = vector.metadata;
  if (typeof metadata !== "object" || metadata === null) {
    return false;
  }
  return (
    metadata.project_id === expected.metadata.project_id &&
    metadata.memory_id === expected.metadata.memory_id &&
    metadata.revision_id === expected.metadata.revision_id &&
    metadata.chunk_id === expected.metadata.chunk_id &&
    metadata.model_generation === expected.metadata.model_generation &&
    metadata.status === expected.metadata.status &&
    metadata.repository_partition === expected.metadata.repository_partition &&
    metadata.kind === expected.metadata.kind &&
    metadata.memory_class === expected.metadata.memory_class &&
    metadata.scope === expected.metadata.scope &&
    metadata.scope_id === expected.metadata.scope_id &&
    metadata.scope_key === expected.metadata.scope_key &&
    metadata.valid_from_epoch_ms === expected.metadata.valid_from_epoch_ms &&
    metadata.valid_until_epoch_ms === expected.metadata.valid_until_epoch_ms
  );
}

export function chunkMemoryContent(content: string): string[] {
  if (content.length === 0) {
    throw new TypeError("Memory content cannot be empty.");
  }
  const chunks: string[] = [];
  let chunk = "";
  let estimatedTokens = 0;
  for (const codePoint of content) {
    const tokenCost = utf8ByteLength(codePoint);
    if (chunk !== "" && estimatedTokens + tokenCost > MAX_CHUNK_TOKEN_BUDGET) {
      chunks.push(chunk);
      chunk = "";
      estimatedTokens = 0;
    }
    chunk += codePoint;
    estimatedTokens += tokenCost;
  }
  if (chunk !== "") {
    chunks.push(chunk);
  }
  return chunks;
}

export function parseQwenEmbedding(value: unknown): number[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("data" in value) ||
    !Array.isArray(value.data) ||
    value.data.length !== 1 ||
    !Array.isArray(value.data[0]) ||
    value.data[0].length !== EMBEDDING_DIMENSIONS
  ) {
    throw new Error("The embedding response must contain one 1024-dimensional vector.");
  }
  if (value.data[0].some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new Error("The embedding response must contain only finite numbers.");
  }
  return value.data[0] as number[];
}

function requireTaxonomyValue<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string
): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value as T;
}

function requireRepositoryPartition(value: string | null): string {
  if (value === null || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error("A non-project memory requires a trusted repository partition.");
  }
  return requireVectorizeIndexedString(value, "repository partition");
}

export async function deriveMemorySearchVectorId(
  generationId: string,
  projectId: string,
  revisionId: string,
  chunkId: string
): Promise<string> {
  requireProjectionIdentifier(generationId, "generation");
  requireProjectionIdentifier(projectId, "project");
  requireProjectionIdentifier(revisionId, "revision");
  requireProjectionIdentifier(chunkId, "chunk");
  return sha256(`${generationId}\n${projectId}\n${revisionId}\n${chunkId}`);
}

function requireProjectionIdentifier(value: string, label: string): string {
  if (!isProjectionIdentifier(value)) {
    throw new TypeError(`The search projection ${label} identifier is invalid.`);
  }
  return value;
}

function isProjectionIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

function requireProjectionChunkCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("The search projection chunk count is invalid.");
  }
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function buildLocatorIndex(locators: string | null, commitShas: string | null): string {
  const tokens = new Set<string>();
  for (const locator of splitIndexValues(locators)) {
    if (!isSafeIndexToken(locator)) {
      continue;
    }
    tokens.add(locator);
    const github = GITHUB_LOCATOR.exec(locator);
    if (github !== null) {
      const commitSha = github[1];
      const path = github[2];
      if (commitSha !== undefined && path !== undefined && !hasUnsafePathSegment(path)) {
        tokens.add(commitSha.toLowerCase());
        tokens.add(path);
      }
    }
  }
  for (const commitSha of splitIndexValues(commitShas)) {
    if (SAFE_COMMIT_SHA.test(commitSha)) {
      tokens.add(commitSha.toLowerCase());
    }
  }
  return [...tokens].sort(compareText).slice(0, MAX_INDEX_TOKENS).join("\n");
}

function buildSymbolIndex(content: string): string {
  const symbols = new Set<string>();
  for (const match of content.matchAll(INLINE_CANONICAL_SYMBOL)) {
    addCanonicalSymbol(symbols, match[1]);
  }
  let className: string | null = null;
  let classBraceDepth = 0;
  for (const line of content.split("\n")) {
    if (line.length > MAX_SOURCE_LINE_LENGTH) {
      continue;
    }
    const scoped = SCOPED_DECLARATION.exec(line);
    addCanonicalSymbol(symbols, scoped?.[1]);
    if (className === null) {
      const declaration = CLASS_DECLARATION.exec(line);
      if (declaration?.[1] !== undefined) {
        className = declaration[1];
        classBraceDepth = braceDelta(line);
      }
      continue;
    }
    const method = CLASS_METHOD_DECLARATION.exec(line)?.[1];
    if (method !== undefined && !CONTROL_FLOW_NAMES.has(method)) {
      addCanonicalSymbol(symbols, `${className}.${method}`);
    }
    classBraceDepth += braceDelta(line);
    if (classBraceDepth <= 0) {
      className = null;
      classBraceDepth = 0;
    }
  }
  return [...symbols].sort(compareText).slice(0, MAX_INDEX_SYMBOLS).join("\n");
}

function splitIndexValues(value: string | null): string[] {
  if (value === null) {
    return [];
  }
  return value
    .split("\n")
    .map((entry) => entry.normalize("NFKC").trim())
    .filter((entry) => entry !== "");
}

function isSafeIndexToken(value: string): boolean {
  return value.length <= 2_048 && !/[\u0000-\u001f\u007f\s]/u.test(value);
}

function hasUnsafePathSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function addCanonicalSymbol(symbols: Set<string>, value: string | undefined): void {
  if (
    value !== undefined &&
    value.length <= 256 &&
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(value)
  ) {
    symbols.add(value);
  }
}

function braceDelta(value: string): number {
  let delta = 0;
  for (const character of value) {
    if (character === "{") {
      delta += 1;
    } else if (character === "}") {
      delta -= 1;
    }
  }
  return delta;
}

function utf8ByteLength(codePoint: string): number {
  const value = codePoint.codePointAt(0);
  if (value === undefined) {
    return 0;
  }
  if (value <= 0x7f) {
    return 1;
  }
  if (value <= 0x7ff) {
    return 2;
  }
  if (value <= 0xffff) {
    return 3;
  }
  return 4;
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
