import type { WorkflowStep } from "cloudflare:workers";
import { sha256 } from "../security/crypto";
import { readActiveSearchGeneration } from "../search/cloudflare";
import {
  deleteMemorySearchProjection,
  publishMemorySearchProjection,
  SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT
} from "../search/indexing";
import { isProjectWorkAdmitted } from "../workflows/synthetic-cleanup";
import { publishProjectProjection } from "./cloudflare";

export const PROJECTION_REBUILD_STEP_ATTEMPTS = 3;
export const PROJECTION_REBUILD_WORKFLOW_SUBREQUEST_LIMIT = 50_000;
export const PROJECTION_REBUILD_SAFE_SUBREQUEST_LIMIT = 45_000;
export const PROJECTION_REBUILD_MAX_SNAPSHOT_CONTENT_BYTES = 16 * 1024 * 1024;
export const PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_WRITES = 29;
export const PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_SUBREQUESTS = 14;
export const PROJECTION_REBUILD_WORKFLOW_FIXED_RETRIED_SUBREQUESTS = 14;

export interface ProjectionRebuildSnapshotCapacityInput {
  memoryCount: number;
  revisionCount: number;
  scopeCount: number;
  contentBytes: number;
}

export interface ProjectionRebuildSnapshotCapacity {
  writeCount: number;
  estimatedSubrequests: number;
  contentWithinLimit: boolean;
  subrequestsWithinLimit: boolean;
  accepted: boolean;
}

export type ProjectionRebuildRequest =
  | {
      mode: "snapshot";
      searchGenerationId: string;
      memoryCount: number;
      revisionCount: number;
      scopeCount: number;
      contentBytes: number;
      headDigest: string;
    }
  | {
      mode: "search";
      searchGenerationId: string;
      memoryId: string;
      revisionId: string;
      repositoryPartition: string;
    }
  | {
      mode: "delete";
      searchGenerationId: string;
      memoryId: string;
      revisionId: string;
      searchProjectVersion: number;
    };

interface ProjectionRebuildPayload {
  projectId: string;
  projectVersion?: number;
  projectionRebuild?: ProjectionRebuildRequest;
}

interface ProjectionRebuildEnvironment {
  MEMORY_DB: D1Database;
  SEARCH_DB: D1Database;
  PROJECTIONS: R2Bucket;
  MEMORY_VECTORS: VectorizeIndex;
  AI: Ai;
}

export interface ProjectionSnapshotAuthority {
  project_version: number;
  memory_count: number;
  revision_count: number;
  scope_count: number;
  content_bytes: number;
  scope_exists: number;
}

export interface ProjectionSnapshotCapacityDelta {
  memoryCount: number;
  revisionCount: number;
  scopeCount: number;
  contentBytes: number;
}

interface SnapshotHeadRow {
  memory_id: string;
  revision_id: string;
  scope: string;
  scope_id: string;
  repository_id: string | null;
}

interface SearchAuthorityRow {
  project_version: number;
  revision_id: string | null;
  scope: string | null;
  scope_id: string | null;
  repository_id: string | null;
}

const STEP_RETRY = {
  timeout: SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT,
  retries: {
    limit: PROJECTION_REBUILD_STEP_ATTEMPTS,
    delay: "2 seconds" as const,
    backoff: "exponential" as const
  }
};

export async function runProjectionRebuild(
  env: ProjectionRebuildEnvironment,
  payload: ProjectionRebuildPayload,
  step: WorkflowStep
): Promise<void> {
  if (!isIdentifier(payload.projectId)) {
    throw new TypeError("The projection rebuild project ID is invalid.");
  }
  const request = requireProjectionRebuildRequest(payload.projectionRebuild);
  const projectVersion = requireProjectVersion(payload.projectVersion);
  if (request.mode === "snapshot") {
    await rebuildProjectSnapshot(env, payload.projectId, projectVersion, request, step);
    return;
  }
  if (request.mode === "search") {
    await rebuildMemorySearchHead(env, payload.projectId, projectVersion, request, step);
    return;
  }
  await deleteOrphanSearchHead(env, payload.projectId, projectVersion, request, step);
}

async function rebuildProjectSnapshot(
  env: ProjectionRebuildEnvironment,
  projectId: string,
  projectVersion: number,
  request: Extract<ProjectionRebuildRequest, { mode: "snapshot" }>,
  step: WorkflowStep
): Promise<void> {
  await step.do("rebuild project snapshot", STEP_RETRY, async () => {
    await requireSnapshotAuthority(env, projectId, projectVersion, request);
    const result = await publishProjectProjection({
      memoryDb: env.MEMORY_DB,
      projections: env.PROJECTIONS,
      projectId,
      projectVersion
    });
    if (result.status !== "activated") {
      throw new Error("The projection rebuild project version became stale.");
    }
    await requireSnapshotAuthority(env, projectId, projectVersion, request);
  });
}

async function rebuildMemorySearchHead(
  env: ProjectionRebuildEnvironment,
  projectId: string,
  projectVersion: number,
  request: Extract<ProjectionRebuildRequest, { mode: "search" }>,
  step: WorkflowStep
): Promise<void> {
  await step.do("rebuild memory search projection", STEP_RETRY, async () => {
    await requireSearchAuthority(env, projectId, projectVersion, request, true);
    const published = await publishMemorySearchProjection({
      memoryDb: env.MEMORY_DB,
      searchDb: env.SEARCH_DB,
      vectors: env.MEMORY_VECTORS,
      ai: env.AI,
      projectId,
      memoryId: request.memoryId,
      projectVersion
    });
    if (!published) {
      throw new Error("The projection rebuild search head became stale.");
    }
    await requireSearchAuthority(env, projectId, projectVersion, request, true);
  });
}

async function deleteOrphanSearchHead(
  env: ProjectionRebuildEnvironment,
  projectId: string,
  projectVersion: number,
  request: Extract<ProjectionRebuildRequest, { mode: "delete" }>,
  step: WorkflowStep
): Promise<void> {
  await step.do("delete orphan search projection", STEP_RETRY, async () => {
    await requireSearchAuthority(env, projectId, projectVersion, request, false);
    const deleted = await deleteMemorySearchProjection({
      searchDb: env.SEARCH_DB,
      vectors: env.MEMORY_VECTORS,
      generationId: request.searchGenerationId,
      projectId,
      memoryId: request.memoryId,
      revisionId: request.revisionId,
      projectVersion: request.searchProjectVersion
    });
    if (!deleted) {
      throw new Error("The orphan search projection changed before deletion.");
    }
    await requireSearchAuthority(env, projectId, projectVersion, request, false);
  });
}

async function requireSnapshotAuthority(
  env: Pick<ProjectionRebuildEnvironment, "MEMORY_DB" | "SEARCH_DB">,
  projectId: string,
  projectVersion: number,
  request: Extract<ProjectionRebuildRequest, { mode: "snapshot" }>
): Promise<void> {
  await requireProjectAdmission(env.MEMORY_DB, projectId);
  const session = env.MEMORY_DB.withSession("first-primary");
  const authority = await readProjectionSnapshotAuthority(
    session,
    projectId,
    projectVersion
  );
  const heads = await session
    .prepare(
      `SELECT m.memory_id, m.current_revision_id AS revision_id,
              m.scope, m.scope_id, memory_context.repository_id
       FROM memories m
       LEFT JOIN memory_repository_contexts memory_context
         ON memory_context.project_id = m.project_id
        AND memory_context.memory_id = m.memory_id
       WHERE m.project_id = ? AND m.current_revision_id IS NOT NULL
         AND m.status IN ('active', 'contested')
       ORDER BY m.memory_id ASC`
    )
    .bind(projectId)
    .all<SnapshotHeadRow>();
  const exactHeadSet =
    heads.results.length === request.memoryCount &&
    heads.results.every(
      (head) => isIdentifier(head.memory_id) && isIdentifier(head.revision_id)
    ) &&
    (await sha256(
      JSON.stringify(heads.results.map((head) => [
        head.memory_id,
        head.revision_id,
        authoritativeRepositoryPartition(projectId, head)
      ]))
    )) === request.headDigest;
  if (
    authority === null ||
    authority.project_version !== projectVersion ||
    authority.memory_count !== request.memoryCount ||
    authority.revision_count !== request.revisionCount ||
    authority.scope_count !== request.scopeCount ||
    authority.content_bytes !== request.contentBytes ||
    !exactHeadSet ||
    !Number.isSafeInteger(authority.revision_count) ||
    authority.revision_count !== authority.memory_count ||
    !Number.isSafeInteger(authority.scope_count) ||
    authority.scope_count < 0 ||
    authority.scope_count > authority.memory_count ||
    !Number.isSafeInteger(authority.content_bytes) ||
    authority.content_bytes < 0
  ) {
    throw new Error("The projection rebuild authority changed.");
  }
  requireSnapshotCapacityAuthority(authority);
  await requireActiveGeneration(env.SEARCH_DB, request.searchGenerationId);
}

async function requireSearchAuthority(
  env: Pick<ProjectionRebuildEnvironment, "MEMORY_DB" | "SEARCH_DB">,
  projectId: string,
  projectVersion: number,
  request: Extract<ProjectionRebuildRequest, { mode: "search" | "delete" }>,
  requireExactHead: boolean
): Promise<void> {
  await requireProjectAdmission(env.MEMORY_DB, projectId);
  const authority = await env.MEMORY_DB.withSession("first-primary")
    .prepare(
      `SELECT p.project_version, m.current_revision_id AS revision_id,
              m.scope, m.scope_id, memory_context.repository_id
       FROM projects p
       LEFT JOIN memories m
         ON m.project_id = p.project_id AND m.memory_id = ?
        AND m.status IN ('active', 'contested')
       LEFT JOIN memory_repository_contexts memory_context
         ON memory_context.project_id = m.project_id
        AND memory_context.memory_id = m.memory_id
       WHERE p.project_id = ?`
    )
    .bind(request.memoryId, projectId)
    .first<SearchAuthorityRow>();
  const exactHead = authority?.revision_id === request.revisionId;
  const exactRepositoryPartition =
    request.mode !== "search" ||
    (
      exactHead &&
      authoritativeRepositoryPartition(projectId, authority) === request.repositoryPartition
    );
  if (
    authority === null ||
    authority.project_version !== projectVersion ||
    (requireExactHead ? !exactHead || !exactRepositoryPartition : authority.revision_id !== null)
  ) {
    throw new Error("The projection rebuild authority changed.");
  }
  await requireActiveGeneration(env.SEARCH_DB, request.searchGenerationId);
}

async function requireProjectAdmission(memoryDb: D1Database, projectId: string): Promise<void> {
  if (!(await isProjectWorkAdmitted(memoryDb, projectId))) {
    throw new Error("The projection rebuild project is unavailable.");
  }
}

async function requireActiveGeneration(
  searchDb: D1Database,
  expectedGenerationId: string
): Promise<void> {
  const generation = await readActiveSearchGeneration(searchDb);
  if (generation.id !== expectedGenerationId) {
    throw new Error("The active search generation changed during projection rebuild.");
  }
}

export function calculateProjectionRebuildSnapshotCapacity(
  input: ProjectionRebuildSnapshotCapacityInput
): ProjectionRebuildSnapshotCapacity {
  requireCapacityCount(input.memoryCount, "memory");
  requireCapacityCount(input.revisionCount, "revision");
  requireCapacityCount(input.scopeCount, "scope");
  requireCapacityCount(input.contentBytes, "content byte");
  if (input.revisionCount !== input.memoryCount || input.scopeCount > input.memoryCount) {
    throw new TypeError("The projection rebuild snapshot capacity authority is invalid.");
  }
  const writeCount =
    input.memoryCount +
    input.revisionCount +
    input.scopeCount +
    PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_WRITES;
  const estimatedSubrequests =
    PROJECTION_REBUILD_WORKFLOW_FIXED_RETRIED_SUBREQUESTS +
    PROJECTION_REBUILD_STEP_ATTEMPTS *
      (PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_SUBREQUESTS + writeCount * 2);
  if (!Number.isSafeInteger(writeCount) || !Number.isSafeInteger(estimatedSubrequests)) {
    throw new RangeError("The projection rebuild snapshot capacity exceeds the safe integer range.");
  }
  const contentWithinLimit =
    input.contentBytes <= PROJECTION_REBUILD_MAX_SNAPSHOT_CONTENT_BYTES;
  const subrequestsWithinLimit =
    estimatedSubrequests <= PROJECTION_REBUILD_SAFE_SUBREQUEST_LIMIT;
  return {
    writeCount,
    estimatedSubrequests,
    contentWithinLimit,
    subrequestsWithinLimit,
    accepted: contentWithinLimit && subrequestsWithinLimit
  };
}

export function calculateProjectionSnapshotCapacityAfterChange(
  authority: ProjectionSnapshotAuthority,
  delta: ProjectionSnapshotCapacityDelta
): ProjectionRebuildSnapshotCapacity {
  return calculateProjectionRebuildSnapshotCapacity({
    memoryCount: authority.memory_count + delta.memoryCount,
    revisionCount: authority.revision_count + delta.revisionCount,
    scopeCount: authority.scope_count + delta.scopeCount,
    contentBytes: authority.content_bytes + delta.contentBytes
  });
}

export async function readProjectionSnapshotAuthority(
  database: Pick<D1Database, "prepare">,
  projectId: string,
  expectedProjectVersion: number,
  scopeId: string | null = null,
  excludedMemoryId: string | null = null
): Promise<ProjectionSnapshotAuthority | null> {
  const excludedId = excludedMemoryId ?? "";
  return database
    .prepare(
      `WITH projected_memories AS (
         SELECT m.project_id, m.memory_id, m.current_revision_id, m.scope_id
         FROM memories m
         WHERE m.project_id = ?
           AND m.current_revision_id IS NOT NULL
           AND m.status IN ('active', 'contested')
           AND (? = '' OR m.memory_id <> ?)
       )
       SELECT p.project_version,
              (SELECT COUNT(*) FROM projected_memories) AS memory_count,
              (SELECT COUNT(*)
               FROM memory_versions v
               JOIN projected_memories m
                 ON m.project_id = v.project_id
                AND m.memory_id = v.memory_id
                AND m.current_revision_id = v.revision_id
              ) AS revision_count,
              (SELECT COUNT(DISTINCT m.scope_id)
               FROM projected_memories m) AS scope_count,
              COALESCE((
                SELECT SUM(length(CAST(v.content AS BLOB)))
                FROM memory_versions v
                JOIN projected_memories m
                  ON m.project_id = v.project_id
                 AND m.memory_id = v.memory_id
                 AND m.current_revision_id = v.revision_id
              ), 0) AS content_bytes,
              EXISTS(
                SELECT 1 FROM projected_memories m
                WHERE m.scope_id = ?
              ) AS scope_exists
       FROM projects p
       WHERE p.project_id = ? AND p.project_version = ?`
    )
    .bind(
      projectId,
      excludedId,
      excludedId,
      scopeId ?? "",
      projectId,
      expectedProjectVersion
    )
    .first<ProjectionSnapshotAuthority>();
}

export async function checkProjectionSnapshotCapacity(
  database: D1Database,
  projectId: string,
  expectedProjectVersion: number
): Promise<boolean> {
  const authority = await readProjectionSnapshotAuthority(
    database.withSession("first-primary"),
    projectId,
    expectedProjectVersion
  );
  if (authority === null) {
    return false;
  }
  requireSnapshotCapacityAuthority(authority);
  return true;
}

function requireSnapshotCapacityAuthority(authority: ProjectionSnapshotAuthority): void {
  const capacity = calculateProjectionRebuildSnapshotCapacity({
    memoryCount: authority.memory_count,
    revisionCount: authority.revision_count,
    scopeCount: authority.scope_count,
    contentBytes: authority.content_bytes
  });
  if (!capacity.contentWithinLimit) {
    throw new Error(
      `The projection rebuild snapshot contains ${authority.content_bytes} content bytes, ` +
        "exceeding the memory safety limit."
    );
  }
  if (!capacity.subrequestsWithinLimit) {
    throw new Error(
      `The projection rebuild snapshot estimated ${capacity.estimatedSubrequests} subrequests, ` +
        "exceeding the configured safety budget."
    );
  }
}

function requireCapacityCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`The projection rebuild snapshot ${label} count is invalid.`);
  }
}

function requireProjectionRebuildRequest(
  request: ProjectionRebuildRequest | undefined
): ProjectionRebuildRequest {
  if (
    request === undefined ||
    !["snapshot", "search", "delete"].includes(request.mode) ||
    !isIdentifier(request.searchGenerationId)
  ) {
    throw new TypeError("The projection rebuild request is invalid.");
  }
  if (request.mode === "snapshot") {
    try {
      calculateProjectionRebuildSnapshotCapacity({
        memoryCount: request.memoryCount,
        revisionCount: request.revisionCount,
        scopeCount: request.scopeCount,
        contentBytes: request.contentBytes
      });
    } catch {
      throw new TypeError("The projection rebuild request is invalid.");
    }
    if (!/^[a-f0-9]{64}$/u.test(request.headDigest)) {
      throw new TypeError("The projection rebuild request is invalid.");
    }
    return request;
  }
  if (
    !isIdentifier(request.memoryId) ||
    !isIdentifier(request.revisionId) ||
    (request.mode === "search" && !isIdentifier(request.repositoryPartition))
  ) {
    throw new TypeError("The projection rebuild request is invalid.");
  }
  if (
    request.mode === "delete" &&
    (!Number.isSafeInteger(request.searchProjectVersion) ||
      request.searchProjectVersion < 0)
  ) {
    throw new TypeError("The projection rebuild request is invalid.");
  }
  return request;
}

function requireProjectVersion(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
    throw new TypeError("The projection rebuild project version is invalid.");
  }
  return value as number;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function authoritativeRepositoryPartition(
  projectId: string,
  row: Pick<SearchAuthorityRow, "scope" | "scope_id" | "repository_id">
): string {
  if (row.scope === "project" && row.scope_id === projectId) {
    return "*";
  }
  if (!isIdentifier(row.repository_id)) {
    throw new Error("The projection rebuild repository partition is invalid.");
  }
  return row.repository_id;
}
