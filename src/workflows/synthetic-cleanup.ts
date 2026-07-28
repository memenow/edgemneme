import { pathSegment } from "../projection/markdown";
import { deriveMemorySearchVectorId } from "../search/indexing";

interface SyntheticWorkflowInstance {
  status(): Promise<{ status: string }>;
  terminate(): Promise<void>;
}

interface SyntheticWorkflowBinding {
  get(id: string): Promise<SyntheticWorkflowInstance> | SyntheticWorkflowInstance;
}

export interface SyntheticCleanupEnvironment {
  memoryDb: D1Database;
  searchDb: D1Database;
  projections: R2Bucket;
  vectors: VectorizeIndex;
  workflow: SyntheticWorkflowBinding;
}

export interface SyntheticCleanupOptions {
  now?: () => string;
  delay?: (milliseconds: number) => Promise<void>;
  projectLimit?: number;
  vectorVerificationAttempts?: number;
  workflowVerificationAttempts?: number;
}

export interface SyntheticCleanupResult {
  attempted: number;
  cleaned: number;
  failed: number;
}

interface RegistryRow {
  project_id: string;
  principal_id: string;
}

interface WorkflowRow {
  workflow_id: string;
}

interface VectorProjectionRow {
  generation_id: string;
  project_id: string;
  memory_id: string;
  revision_id: string;
  chunk_id: string;
  vector_id: string;
}

interface ProjectionDeletionRow {
  generation_id: string;
  project_id: string;
  memory_id: string;
  revision_id: string;
  chunk_count: number;
}

const SYNTHETIC_PROJECT_SCOPED_TABLES = [
  "consolidation_outputs",
  "consolidation_inputs",
  "session_consolidations",
  "review_decisions",
  "review_requests",
  "version_evidence",
  "conflicts",
  "memory_versions",
  "memory_repository_contexts",
  "observation_evidence",
  "memories",
  "evidence",
  "observations",
  "workflow_runs",
  "idempotency_records",
  "taxonomy_policies",
  "github_repository_sync_runs",
  "github_tree_ref_heads",
  "github_tree_manifest_deltas",
  "github_tree_manifest_lifecycle_events",
  "github_tree_manifest_entries",
  "github_tree_manifests",
  "sync_cursors",
  "project_grant_repository_contexts",
  "project_grants",
  "sessions",
  "repositories",
  "outbox_events",
  "projection_snapshots",
  "audit_events",
  "synthetic_cleanup_registry"
] as const;
const CONTROL_PLANE_TERMINAL_STATUSES = new Set(["complete", "errored", "terminated"]);
const MAX_VECTOR_IDS = 1_000;
const VECTOR_DELETE_BATCH_SIZE = 1_000;
const VECTOR_READ_BATCH_SIZE = 100;
const R2_BATCH_SIZE = 1_000;
const CLEANUP_CLAIM_MILLISECONDS = 30 * 60 * 1_000;

export async function isProjectWorkAdmitted(
  memoryDb: D1Database,
  projectId: string
): Promise<boolean> {
  requireIdentifier(projectId, "project ID");
  const row = await memoryDb.withSession("first-primary").prepare(
    `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM projects p
       WHERE p.project_id = ?
         AND (
           p.project_ref NOT GLOB 'system.synthetic.*'
           OR EXISTS (
             SELECT 1 FROM synthetic_cleanup_registry r
             WHERE r.project_id = p.project_id AND r.cleanup_fenced_at IS NULL
           )
         )
     ) THEN 1 ELSE 0 END AS admitted`
  )
    .bind(projectId)
    .first<{ admitted: number }>();
  return row?.admitted === 1;
}

export async function reapExpiredSyntheticProjects(
  environment: SyntheticCleanupEnvironment,
  options: SyntheticCleanupOptions = {}
): Promise<SyntheticCleanupResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const observedAt = now();
  requireUtcIsoTimestamp(observedAt, "cleanup time");
  const projectLimit = requireBoundedInteger(options.projectLimit ?? 10, 1, 50, "project limit");
  const rows = await environment.memoryDb.withSession("first-primary").prepare(
    `SELECT r.project_id, r.principal_id
     FROM synthetic_cleanup_registry r
     JOIN projects p ON p.project_id = r.project_id
     JOIN principals principal ON principal.principal_id = r.principal_id
     WHERE julianday(r.expires_at) <= julianday(?)
       AND (
         r.cleanup_claim_id IS NULL
         OR julianday(r.cleanup_claim_expires_at) <= julianday(?)
       )
       AND p.project_ref GLOB 'system.synthetic.*'
       AND principal.issuer = 'system.synthetic'
       AND principal.subject = r.principal_id
     ORDER BY julianday(r.expires_at) ASC, r.project_id ASC
     LIMIT ?`
  )
    .bind(observedAt, observedAt, projectLimit)
    .all<RegistryRow>();
  const result: SyntheticCleanupResult = {
    attempted: 0,
    cleaned: 0,
    failed: 0
  };
  for (const row of rows.results) {
    requireIdentifier(row.project_id, "synthetic project ID");
    requireIdentifier(row.principal_id, "synthetic principal ID");
    const claimId = await claimSyntheticCleanup(environment.memoryDb, row, observedAt);
    if (claimId === null) {
      continue;
    }
    result.attempted += 1;
    try {
      await cleanupSyntheticProject(environment, row, claimId, options);
      result.cleaned += 1;
    } catch {
      result.failed += 1;
      await recordCleanupFailure(environment.memoryDb, row, claimId, now());
    }
  }
  return result;
}

async function claimSyntheticCleanup(
  memoryDb: D1Database,
  row: RegistryRow,
  observedAt: string
): Promise<string | null> {
  const claimId = crypto.randomUUID();
  const claimExpiresAt = new Date(
    Date.parse(observedAt) + CLEANUP_CLAIM_MILLISECONDS
  ).toISOString();
  const result = await memoryDb.prepare(
    `UPDATE synthetic_cleanup_registry
     SET cleanup_fenced_at = COALESCE(cleanup_fenced_at, ?),
         cleanup_claim_id = ?, cleanup_claim_expires_at = ?,
         last_attempt_at = ?, last_error_code = NULL
     WHERE project_id = ? AND principal_id = ?
       AND julianday(expires_at) <= julianday(?)
       AND (
         cleanup_claim_id IS NULL
         OR julianday(cleanup_claim_expires_at) <= julianday(?)
       )`
  )
    .bind(
      observedAt,
      claimId,
      claimExpiresAt,
      observedAt,
      row.project_id,
      row.principal_id,
      observedAt,
      observedAt
    )
    .run();
  return (result.meta.changes ?? 0) === 1 ? claimId : null;
}

async function cleanupSyntheticProject(
  environment: SyntheticCleanupEnvironment,
  row: RegistryRow,
  claimId: string,
  options: SyntheticCleanupOptions
): Promise<void> {
  const claim = await environment.memoryDb.withSession("first-primary").prepare(
    `SELECT cleanup_claim_id FROM synthetic_cleanup_registry
     WHERE project_id = ? AND principal_id = ? AND cleanup_fenced_at IS NOT NULL`
  )
    .bind(row.project_id, row.principal_id)
    .first<{ cleanup_claim_id: string | null }>();
  if (claim?.cleanup_claim_id !== claimId) {
    throw new Error("Synthetic cleanup does not hold an admission-fence claim.");
  }
  await terminateProjectWorkflows(environment, row.project_id, options);
  const vectorIds = await discoverVectorIds(environment, row.project_id);
  await deleteAndVerifyVectors(environment.vectors, vectorIds, options);
  await deleteAndVerifySearch(environment.searchDb, row.project_id);
  await deleteAndVerifyR2(environment.projections, row.project_id);
  await verifyNoNonterminalWorkflowRows(environment.memoryDb, row.project_id);
  await deleteAuthority(environment.memoryDb, row);
}

async function terminateProjectWorkflows(
  environment: SyntheticCleanupEnvironment,
  projectId: string,
  options: SyntheticCleanupOptions
): Promise<void> {
  const workflows = await environment.memoryDb.withSession("first-primary").prepare(
    `SELECT workflow_id FROM workflow_runs
     WHERE project_id = ? AND status NOT IN ('complete', 'failed', 'terminated')
     ORDER BY workflow_id ASC`
  )
    .bind(projectId)
    .all<WorkflowRow>();
  for (const row of workflows.results) {
    requireIdentifier(row.workflow_id, "synthetic workflow ID");
    const instance = await environment.workflow.get(row.workflow_id);
    let controlPlaneStatus = (await instance.status()).status;
    if (!CONTROL_PLANE_TERMINAL_STATUSES.has(controlPlaneStatus)) {
      await instance.terminate();
      controlPlaneStatus = await waitForTerminalWorkflowStatus(instance, options);
    }
    await environment.memoryDb.prepare(
      `UPDATE workflow_runs SET status = ?, updated_at = ?
       WHERE workflow_id = ? AND project_id = ?`
    )
      .bind(
        persistedWorkflowStatus(controlPlaneStatus),
        (options.now ?? (() => new Date().toISOString()))(),
        row.workflow_id,
        projectId
      )
      .run();
  }
}

async function waitForTerminalWorkflowStatus(
  instance: SyntheticWorkflowInstance,
  options: SyntheticCleanupOptions
): Promise<string> {
  const attempts = requireBoundedInteger(
    options.workflowVerificationAttempts ?? 6,
    1,
    30,
    "workflow verification attempts"
  );
  const delay = options.delay ?? defaultDelay;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = (await instance.status()).status;
    if (CONTROL_PLANE_TERMINAL_STATUSES.has(status)) {
      return status;
    }
    if (attempt + 1 < attempts) {
      await delay(1_000);
    }
  }
  throw new Error("Synthetic workflow termination could not be verified.");
}

function persistedWorkflowStatus(controlPlaneStatus: string): "complete" | "failed" | "terminated" {
  if (controlPlaneStatus === "complete") {
    return "complete";
  }
  if (controlPlaneStatus === "errored") {
    return "failed";
  }
  if (controlPlaneStatus === "terminated") {
    return "terminated";
  }
  throw new Error("Synthetic workflow has an invalid terminal status.");
}

async function discoverVectorIds(
  environment: SyntheticCleanupEnvironment,
  projectId: string
): Promise<string[]> {
  const [projected, cleanupReceipts, deletionReceipts] = await Promise.all([
    environment.searchDb.prepare(
      `SELECT generation_id, project_id, memory_id, revision_id, chunk_id, vector_id
       FROM memory_fts_chunk_ledger
       WHERE project_id = ?
       ORDER BY generation_id, memory_id, revision_id, chunk_id`
    )
      .bind(projectId)
      .all<VectorProjectionRow>(),
    environment.searchDb.prepare(
      `SELECT generation_id, project_id, memory_id, revision_id, chunk_id, vector_id
       FROM memory_search_vector_cleanup_receipts
       WHERE project_id = ?
       ORDER BY generation_id, memory_id, revision_id, chunk_id`
    )
      .bind(projectId)
      .all<VectorProjectionRow>(),
    environment.searchDb.prepare(
      `SELECT generation_id, project_id, memory_id, revision_id, chunk_count
       FROM memory_search_projection_deletions
       WHERE project_id = ?
       ORDER BY generation_id, memory_id, revision_id`
    )
      .bind(projectId)
      .all<ProjectionDeletionRow>()
  ]);
  const vectorIds = new Set<string>();
  for (const row of [...projected.results, ...cleanupReceipts.results]) {
    addExactVectorId(vectorIds, await validateVectorProjectionRow(row, projectId));
  }
  for (const row of deletionReceipts.results) {
    validateProjectionDeletionRow(row, projectId);
    for (let index = 0; index < row.chunk_count; index += 1) {
      addExactVectorId(
        vectorIds,
        await deriveMemorySearchVectorId(
          row.generation_id,
          projectId,
          row.revision_id,
          `chunk-${index}`
        )
      );
    }
  }
  return [...vectorIds].sort();
}

function addExactVectorId(vectorIds: Set<string>, vectorId: string): void {
  vectorIds.add(vectorId);
  if (vectorIds.size > MAX_VECTOR_IDS) {
    throw new Error("Synthetic cleanup exceeded its exact Vectorize identifier bound.");
  }
}

async function validateVectorProjectionRow(
  row: VectorProjectionRow,
  projectId: string
): Promise<string> {
  requireIdentifier(row.generation_id, "search generation ID");
  requireIdentifier(row.project_id, "search project ID");
  requireIdentifier(row.memory_id, "search memory ID");
  requireIdentifier(row.revision_id, "synthetic revision ID");
  requireIdentifier(row.chunk_id, "synthetic chunk ID");
  if (row.project_id !== projectId) {
    throw new Error("Synthetic vector discovery crossed its project boundary.");
  }
  const expectedVectorId = await deriveMemorySearchVectorId(
    row.generation_id,
    projectId,
    row.revision_id,
    row.chunk_id
  );
  if (row.vector_id !== expectedVectorId) {
    throw new Error("Synthetic vector discovery found an invalid projection identifier.");
  }
  return row.vector_id;
}

function validateProjectionDeletionRow(
  row: ProjectionDeletionRow,
  projectId: string
): void {
  requireIdentifier(row.generation_id, "search generation ID");
  requireIdentifier(row.project_id, "search project ID");
  requireIdentifier(row.memory_id, "search memory ID");
  requireIdentifier(row.revision_id, "synthetic revision ID");
  requireBoundedInteger(
    row.chunk_count,
    0,
    MAX_VECTOR_IDS,
    "search projection deletion chunk count"
  );
  if (row.project_id !== projectId) {
    throw new Error("Synthetic vector discovery crossed its project boundary.");
  }
}

async function deleteAndVerifyVectors(
  vectors: VectorizeIndex,
  vectorIds: string[],
  options: SyntheticCleanupOptions
): Promise<void> {
  for (const batch of batches(vectorIds, VECTOR_DELETE_BATCH_SIZE)) {
    await vectors.deleteByIds(batch);
  }
  if (vectorIds.length === 0) {
    return;
  }
  const attempts = requireBoundedInteger(
    options.vectorVerificationAttempts ?? 12,
    1,
    30,
    "Vectorize verification attempts"
  );
  const delay = options.delay ?? defaultDelay;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let remaining = 0;
    for (const batch of batches(vectorIds, VECTOR_READ_BATCH_SIZE)) {
      remaining += (await vectors.getByIds(batch)).length;
    }
    if (remaining === 0) {
      return;
    }
    if (attempt + 1 < attempts) {
      await delay(5_000);
    }
  }
  throw new Error("Synthetic Vectorize cleanup could not be verified.");
}

async function deleteAndVerifySearch(searchDb: D1Database, projectId: string): Promise<void> {
  await searchDb.batch([
    searchDb.prepare("DELETE FROM memory_projection_heads WHERE project_id = ?")
      .bind(projectId),
    searchDb.prepare("DELETE FROM memory_fts_chunk_ledger WHERE project_id = ?")
      .bind(projectId),
    searchDb.prepare("DELETE FROM memory_search_projection_write_leases WHERE project_id = ?")
      .bind(projectId),
    searchDb.prepare("DELETE FROM memory_search_projection_deletions WHERE project_id = ?")
      .bind(projectId),
    searchDb.prepare(
      "DELETE FROM memory_search_vector_cleanup_receipts WHERE project_id = ?"
    ).bind(projectId),
    searchDb.prepare(
      `UPDATE memory_search_vector_cleanup_janitor_state
       SET cursor_generation_id = NULL, cursor_project_id = NULL,
           cursor_memory_id = NULL, updated_at = NULL
       WHERE state_id = 1 AND cursor_project_id = ?`
    ).bind(projectId)
  ]);
  const remaining = await searchDb.prepare(
    `SELECT
       (SELECT COUNT(*) FROM memory_fts WHERE project_id = ?) AS fts_count,
       (SELECT COUNT(*) FROM memory_projection_heads WHERE project_id = ?) AS head_count,
       (SELECT COUNT(*) FROM memory_fts_chunk_ledger WHERE project_id = ?) AS ledger_count,
       (SELECT COUNT(*) FROM memory_search_projection_write_leases
        WHERE project_id = ?) AS write_lease_count,
       (SELECT COUNT(*) FROM memory_search_projection_deletions
        WHERE project_id = ?) AS projection_deletion_count,
       (SELECT COUNT(*) FROM memory_search_vector_cleanup_receipts
        WHERE project_id = ?) AS vector_cleanup_count,
       (SELECT COUNT(*) FROM memory_search_vector_cleanup_janitor_state
        WHERE cursor_project_id = ?) AS janitor_cursor_count`
  )
    .bind(projectId, projectId, projectId, projectId, projectId, projectId, projectId)
    .first<{
      fts_count: number;
      head_count: number;
      ledger_count: number;
      write_lease_count: number;
      projection_deletion_count: number;
      vector_cleanup_count: number;
      janitor_cursor_count: number;
    }>();
  if (
    remaining === null ||
    remaining.fts_count !== 0 ||
    remaining.head_count !== 0 ||
    remaining.ledger_count !== 0 ||
    remaining.write_lease_count !== 0 ||
    remaining.projection_deletion_count !== 0 ||
    remaining.vector_cleanup_count !== 0 ||
    remaining.janitor_cursor_count !== 0
  ) {
    throw new Error("Synthetic search cleanup could not be verified.");
  }
}

async function deleteAndVerifyR2(projections: R2Bucket, projectId: string): Promise<void> {
  const prefix = `projects/${pathSegment(projectId)}/projections/`;
  const keys = await listExactR2Keys(projections, prefix);
  for (const batch of batches(keys, R2_BATCH_SIZE)) {
    await projections.delete(batch);
  }
  const remaining = await projections.list({ prefix, limit: 1 });
  if (remaining.objects.length !== 0 || remaining.truncated) {
    throw new Error("Synthetic R2 cleanup could not be verified.");
  }
}

async function listExactR2Keys(projections: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await projections.list({
      prefix,
      limit: R2_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor })
    });
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix) || object.key.includes("\0")) {
        throw new Error("Synthetic R2 listing escaped its exact project prefix.");
      }
      keys.push(object.key);
    }
    if (!page.truncated) {
      cursor = undefined;
      break;
    }
    if (page.cursor.length === 0 || cursors.has(page.cursor)) {
      throw new Error("Synthetic R2 listing returned an invalid cursor.");
    }
    cursors.add(page.cursor);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return [...new Set(keys)];
}

async function verifyNoNonterminalWorkflowRows(
  memoryDb: D1Database,
  projectId: string
): Promise<void> {
  const remaining = await memoryDb.withSession("first-primary").prepare(
    `SELECT COUNT(*) AS count FROM workflow_runs
     WHERE project_id = ? AND status NOT IN ('complete', 'failed', 'terminated')`
  )
    .bind(projectId)
    .first<{ count: number }>();
  if (remaining?.count !== 0) {
    throw new Error("Synthetic workflow cleanup could not be verified.");
  }
}

async function deleteAuthority(memoryDb: D1Database, row: RegistryRow): Promise<void> {
  const statements: D1PreparedStatement[] = [
    memoryDb.prepare(
      `DELETE FROM github_credential_expiry_warnings
       WHERE credential_version IN (
         SELECT credential_version FROM github_access_baselines
         WHERE approved_by_principal_id = ?
           AND credential_version = 'system.synthetic.' || ?
       )`
    ).bind(row.principal_id, row.project_id),
    memoryDb.prepare(
      `DELETE FROM github_credential_states
       WHERE credential_version IN (
         SELECT credential_version FROM github_access_baselines
         WHERE approved_by_principal_id = ?
           AND credential_version = 'system.synthetic.' || ?
       )`
    ).bind(row.principal_id, row.project_id),
    memoryDb.prepare(
      `DELETE FROM github_rate_observations
       WHERE credential_version IN (
         SELECT credential_version FROM github_access_baselines
         WHERE approved_by_principal_id = ?
           AND credential_version = 'system.synthetic.' || ?
       )`
    ).bind(row.principal_id, row.project_id),
    memoryDb.prepare(
      `DELETE FROM github_access_baselines
       WHERE approved_by_principal_id = ?
         AND credential_version = 'system.synthetic.' || ?`
    ).bind(row.principal_id, row.project_id),
    ...SYNTHETIC_PROJECT_SCOPED_TABLES.map((table) =>
      memoryDb.prepare(`DELETE FROM ${table} WHERE project_id = ?`).bind(row.project_id)
    )
  ];
  statements.push(
    memoryDb.prepare(
      `DELETE FROM principals
       WHERE principal_id = ? AND issuer = 'system.synthetic' AND subject = ?
         AND NOT EXISTS (
           SELECT 1 FROM project_grants WHERE principal_id = ?
         )`
    ).bind(row.principal_id, row.principal_id, row.principal_id),
    memoryDb.prepare(
      `DELETE FROM projects
       WHERE project_id = ? AND project_ref GLOB 'system.synthetic.*'`
    ).bind(row.project_id)
  );
  const results = await memoryDb.batch(statements);
  const principalResult = results.at(-2);
  const projectResult = results.at(-1);
  if (
    (principalResult?.meta.changes ?? 0) !== 1 ||
    (projectResult?.meta.changes ?? 0) !== 1
  ) {
    throw new Error("Synthetic D1 cleanup could not be verified.");
  }
}

async function recordCleanupFailure(
  memoryDb: D1Database,
  row: RegistryRow,
  claimId: string | null,
  attemptedAt: string
): Promise<void> {
  try {
    requireUtcIsoTimestamp(attemptedAt, "cleanup attempt time");
    await memoryDb.prepare(
      `UPDATE synthetic_cleanup_registry
       SET last_attempt_at = ?, last_error_code = 'SYNTHETIC_CLEANUP_FAILED',
           cleanup_claim_id = NULL, cleanup_claim_expires_at = NULL
       WHERE project_id = ? AND principal_id = ?
         AND cleanup_claim_id IS ?
         AND EXISTS (
           SELECT 1 FROM projects
           WHERE project_id = ? AND project_ref GLOB 'system.synthetic.*'
         )`
    )
      .bind(
        attemptedAt,
        row.project_id,
        row.principal_id,
        claimId,
        row.project_id
      )
      .run();
  } catch {
    // A completed authority deletion can race with a failed response; no sensitive error is persisted.
  }
}

function batches<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    output.push(values.slice(offset, offset + size));
  }
  return output;
}

function requireIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`The ${label} is invalid.`);
  }
}

function requireUtcIsoTimestamp(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`The ${label} is invalid.`);
  }
}

function requireBoundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
