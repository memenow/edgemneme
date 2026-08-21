import {
  GitHubReadOnlyClient,
  GitHubSyncError,
  MAX_GITHUB_ANNOTATED_TAG_PEEL_REQUESTS,
  type GitComparison,
  type GitHubRateLimit,
  type GitHubRequestPacer,
  type GitHubSyncErrorCode
} from "../../src/github/client";
import { createRefScopeId } from "../../src/contracts/scope";
import type { MemoryEvent } from "../../src/gateway/service";
import {
  inspectMemoryModelInput,
  inspectSensitivePath
} from "../../src/quality/sensitive-content";
import { sha256 } from "../../src/security/crypto";
import {
  GITHUB_BLOB_TRANSPORT_LIMIT_BYTES,
  classifyGitHubBlobBytes,
  classifyGitHubBlobPath
} from "../../src/github/content-policy";
import {
  activateGitHubTreeManifest,
  beginGitHubTreeManifest,
  buildGitHubTreeManifestDescriptor,
  completeGitHubTreeManifest,
  createGitHubTreeManifestActivationAttempt,
  persistGitHubTreeManifestEntries,
  readActiveGitHubTreeHead,
  type GitHubTreeManifestDescriptor,
  type GitHubTreeManifestEntry
} from "../../src/github/tree-manifest";
import {
  failGitHubTreeManifest
} from "../../src/github/tree-manifest-retention";
import {
  buildGitHubBlobEvidenceId,
  buildGitHubClearEvidenceLocator,
  buildGitHubTombstoneEvidenceLocator,
  prepareGitHubCandidateStatements,
  type PersistableGitHubCandidate
} from "../../src/github/candidate-persistence";
import type { PendingGitHubSyncActivationFence } from "../../src/github/sync-activation-fence";
import {
  githubDispatchIdentity,
  githubRetentionIdentity
} from "../../src/github/sync-scheduling";

export interface GitHubDispatchWorkflowPayload {
  dispatchId: string;
  scheduledFor: string;
  utcDate: string;
  credentialVersion: string;
}

export interface GitHubRefSyncWorkflowPayload {
  dispatchId: string;
  itemId: string;
  credentialVersion: string;
  scheduledFor: string;
  absoluteDeadlineMs: number;
}

export interface GitHubRetentionWorkflowPayload {
  scheduledFor: string;
  utcDate: string;
}

export interface Env {
  MEMORY_DB: D1Database;
  GITHUB_SYNC_ENABLED: string;
  GITHUB_CLASSIC_TOKEN?: string;
  GITHUB_CREDENTIAL_VERSION?: string;
  GITHUB_DISPATCH_WORKFLOW?: Workflow<GitHubDispatchWorkflowPayload>;
  GITHUB_REF_SYNC_WORKFLOW?: Workflow<GitHubRefSyncWorkflowPayload>;
  GITHUB_RETENTION_WORKFLOW?: Workflow<GitHubRetentionWorkflowPayload>;
}

export interface RepositoryRow {
  repository_id: string;
  project_id: string;
  external_id: number;
  expected_owner_external_id: number | null;
  owner: string;
  name: string;
  default_branch: string | null;
  tracked_refs_json: string;
  repository_configuration_version: number;
  repository_updated_at: string;
}

interface CursorRow {
  observed_sha: string | null;
  etag: string | null;
}

export interface ConfiguredRefRow {
  project_id: string;
  repository_id: string;
  ref: string;
}

export interface ScheduledRefRow extends RepositoryRow {
  ref: string;
  cursor_status: string;
  cursor_updated_at: string;
  cursor_version: number;
  selected_head_manifest_id: string | null;
  selected_head_version: number;
  last_sync_at: string | null;
}

export interface GuardedScheduledRefRow extends ScheduledRefRow {
  materialization_cursor_state_json: string;
  materialization_head_state_json: string;
  materialization_active_item_count: number;
}

interface AccessBaselineRow {
  credential_version: string;
  user_id: number;
  scopes_json: string;
  repositories_json: string;
}

export interface CredentialExpirationClassification {
  status: "active" | "expiring" | "expired";
  warningThresholdDays: 14 | 7 | 1 | null;
}

const MAX_CANDIDATE_BYTES = GITHUB_BLOB_TRANSPORT_LIMIT_BYTES;
const MAX_RUN_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 2_000;
export const GITHUB_SYNC_REQUEST_BUDGET = {
  accessBaseline: 900,
  perRef: MAX_FILES + 5 + MAX_GITHUB_ANNOTATED_TAG_PEEL_REQUESTS,
  maxRefsPerSchedule: null,
  maxTotalPerWorkflow:
    MAX_FILES + 5 + MAX_GITHUB_ANNOTATED_TAG_PEEL_REQUESTS
} as const;
export const MAX_GITHUB_ACCESS_BASELINE_REQUESTS =
  GITHUB_SYNC_REQUEST_BUDGET.accessBaseline;
export const MAX_GITHUB_REQUESTS_PER_REF = GITHUB_SYNC_REQUEST_BUDGET.perRef;
export const GITHUB_SYNC_REQUEST_INTERVAL_MS = 80;
const SYNC_RUN_LEASE_MS = 60 * 60 * 1_000;

export type GitHubBlobCandidate = PersistableGitHubCandidate;


export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await scheduleGitHubSyncWorkflows(controller, env);
  }
} satisfies ExportedHandler<Env>;

const REUSABLE_WORKFLOW_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
  "complete"
]);

export async function ensureStableWorkflowInstance<Payload>(
  workflow: Workflow<Payload>,
  id: string,
  params: Payload
): Promise<void> {
  try {
    await workflow.create({ id, params });
    return;
  } catch (error) {
    let instance: WorkflowInstance;
    let status: Awaited<ReturnType<WorkflowInstance["status"]>>;
    try {
      instance = await workflow.get(id);
      status = await instance.status();
    } catch {
      throw error;
    }
    if (REUSABLE_WORKFLOW_STATUSES.has(status.status)) {
      return;
    }
    if (status.status === "errored" || status.status === "terminated") {
      await instance.restart();
      return;
    }
    throw error;
  }
}

export async function scheduleGitHubSyncWorkflows(
  controller: Pick<ScheduledController, "scheduledTime">,
  env: Env
): Promise<void> {
  const activeEnv = requireActiveGitHubSyncEnv(env);
  if (activeEnv === null) {
    return;
  }
  if (
    env.GITHUB_DISPATCH_WORKFLOW === undefined ||
    env.GITHUB_RETENTION_WORKFLOW === undefined
  ) {
    throw new Error("Enabled GitHub sync requires its Workflow bindings.");
  }
  const [dispatch, retention] = await Promise.all([
    githubDispatchIdentity(activeEnv.GITHUB_CREDENTIAL_VERSION, controller.scheduledTime),
    githubRetentionIdentity(controller.scheduledTime)
  ]);
  const results = await Promise.allSettled([
    ensureStableWorkflowInstance(env.GITHUB_DISPATCH_WORKFLOW, dispatch.instanceId, {
      dispatchId: dispatch.dispatchId,
      scheduledFor: dispatch.scheduledFor,
      utcDate: dispatch.utcDate,
      credentialVersion: activeEnv.GITHUB_CREDENTIAL_VERSION
    }),
    ensureStableWorkflowInstance(
      env.GITHUB_RETENTION_WORKFLOW,
      retention.instanceId,
      { scheduledFor: retention.scheduledFor, utcDate: retention.utcDate }
    )
  ]);
  if (results[1]?.status === "rejected") {
    console.warn("GitHub retention Workflow scheduling failed in isolation.");
  }
  if (results[0]?.status === "rejected") {
    throw results[0].reason;
  }
}

export interface ActiveGitHubSyncEnv extends Env {
  GITHUB_SYNC_ENABLED: "true";
  GITHUB_CLASSIC_TOKEN: string;
  GITHUB_CREDENTIAL_VERSION: string;
}

export function requireActiveGitHubSyncEnv(env: Env): ActiveGitHubSyncEnv | null {
  if (env.GITHUB_SYNC_ENABLED === "false") {
    return null;
  }
  if (env.GITHUB_SYNC_ENABLED !== "true") {
    throw new Error("GITHUB_SYNC_ENABLED must be exactly true or false.");
  }
  if (
    typeof env.GITHUB_CLASSIC_TOKEN !== "string" ||
    env.GITHUB_CLASSIC_TOKEN.trim() === ""
  ) {
    throw new Error("Enabled GitHub sync requires GITHUB_CLASSIC_TOKEN.");
  }
  if (
    typeof env.GITHUB_CREDENTIAL_VERSION !== "string" ||
    env.GITHUB_CREDENTIAL_VERSION.trim() === "" ||
    env.GITHUB_CREDENTIAL_VERSION === "unconfigured"
  ) {
    throw new Error("Enabled GitHub sync requires a configured credential version.");
  }
  return env as ActiveGitHubSyncEnv;
}


interface ScheduledRefMaterializationStateRow {
  ref: string;
  cursor_exists: number;
  cursor_state_json: string;
  head_state_json: string;
  active_item_count: number;
}

interface ExpectedScheduledRefMaterializationState {
  ref: string;
  pre_cursor_exists: number;
  post_cursor_exists: number;
  pre_cursor_state_json: string;
  post_cursor_state_json: string;
  head_state_json: string;
  active_item_count: number;
}

const MATERIALIZATION_CURRENT_STATE_SQL = `
  SELECT configured.ref,
         CASE WHEN cursor.ref IS NULL THEN 0 ELSE 1 END AS cursor_exists,
         json_array(
           cursor.observed_sha, cursor.status, cursor.etag,
           cursor.last_sync_at, cursor.next_sync_at,
           cursor.history_gap_possible, cursor.credential_status,
           cursor.last_error_code, cursor.updated_at, cursor.ref_scope_id,
           cursor.cursor_version
         ) AS cursor_state_json,
         json_array(
           head.manifest_id, head.head_version, head.activated_at,
           head.updated_at
         ) AS head_state_json,
         (
           SELECT COUNT(*)
           FROM github_sync_dispatch_items AS active_item
           WHERE active_item.project_id = expected_repository.project_id
             AND active_item.repository_id = expected_repository.repository_id
             AND active_item.ref = configured.ref
             AND active_item.status IN ('pending', 'running')
         ) AS active_item_count
  FROM configured
  CROSS JOIN expected_repository
  LEFT JOIN sync_cursors AS cursor
    ON cursor.project_id = expected_repository.project_id
   AND cursor.repository_id = expected_repository.repository_id
   AND cursor.ref = configured.ref
  LEFT JOIN github_tree_ref_heads AS head
    ON head.project_id = expected_repository.project_id
   AND head.repository_id = expected_repository.repository_id
   AND head.ref = configured.ref`;

function guardedMaterializationCtes(
  expectedCursorStateColumn: "pre_cursor_state_json" | "post_cursor_state_json"
): string {
  const expectedCursorExistsColumn = expectedCursorStateColumn ===
      "pre_cursor_state_json"
    ? "pre_cursor_exists"
    : "post_cursor_exists";
  return `WITH configured AS (
     SELECT CAST(value AS TEXT) AS ref FROM json_each(?)
   ), expected_state AS (
     SELECT CAST(json_extract(value, '$.ref') AS TEXT) AS ref,
            CAST(json_extract(value, '$.${expectedCursorExistsColumn}') AS INTEGER)
              AS cursor_exists,
            CAST(json_extract(value, '$.${expectedCursorStateColumn}') AS TEXT)
              AS cursor_state_json,
            CAST(json_extract(value, '$.head_state_json') AS TEXT)
              AS head_state_json,
            CAST(json_extract(value, '$.active_item_count') AS INTEGER)
              AS active_item_count
     FROM json_each(?)
   ), expected_repository(
     project_id, repository_id, external_id, expected_owner_external_id,
     owner, name, default_branch, tracked_refs_json,
     repository_configuration_version, repository_updated_at
   ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)),
   repository_guard AS (
     SELECT expected_repository.project_id,
            expected_repository.repository_id
     FROM expected_repository
     JOIN repositories AS repository
       ON repository.project_id = expected_repository.project_id
      AND repository.repository_id = expected_repository.repository_id
      AND lower(repository.provider) = 'github'
      AND repository.sync_enabled = 1
      AND repository.external_id = expected_repository.external_id
      AND repository.expected_owner_external_id
            IS expected_repository.expected_owner_external_id
      AND repository.owner = expected_repository.owner
      AND repository.name = expected_repository.name
      AND repository.default_branch IS expected_repository.default_branch
      AND repository.tracked_refs_json = expected_repository.tracked_refs_json
      AND repository.github_sync_configuration_version =
            expected_repository.repository_configuration_version
      AND repository.updated_at = expected_repository.repository_updated_at
   ), current_state AS (
     ${MATERIALIZATION_CURRENT_STATE_SQL}
   ), state_guard AS (
     SELECT 1 AS admitted
     WHERE (SELECT COUNT(*) FROM configured) =
           (SELECT COUNT(*) FROM expected_state)
       AND NOT EXISTS (
         SELECT 1
         FROM expected_state
         LEFT JOIN current_state
           ON current_state.ref = expected_state.ref
         WHERE current_state.ref IS NULL
            OR current_state.cursor_exists <> expected_state.cursor_exists
            OR current_state.cursor_state_json
                 IS NOT expected_state.cursor_state_json
            OR current_state.head_state_json IS NOT expected_state.head_state_json
            OR current_state.active_item_count <>
                 expected_state.active_item_count
       )
   )`;
}

function guardedMaterializationBindings(
  configuredRefsJson: string,
  expectedStateJson: string,
  expectedRepository: RepositoryRow
): unknown[] {
  return [
    configuredRefsJson,
    expectedStateJson,
    expectedRepository.project_id,
    expectedRepository.repository_id,
    expectedRepository.external_id,
    expectedRepository.expected_owner_external_id,
    expectedRepository.owner,
    expectedRepository.name,
    expectedRepository.default_branch,
    expectedRepository.tracked_refs_json,
    expectedRepository.repository_configuration_version,
    expectedRepository.repository_updated_at
  ];
}

export async function materializeAndSelectScheduledRefsGuarded(
  database: D1Database,
  configuredRefs: ConfiguredRefRow[],
  expectedRepository: RepositoryRow,
  scheduledTime: number
): Promise<GuardedScheduledRefRow[]> {
  if (configuredRefs.length === 0) {
    return [];
  }
  if (
    configuredRefs.some(
      (configuredRef) =>
        configuredRef.project_id !== expectedRepository.project_id ||
        configuredRef.repository_id !== expectedRepository.repository_id
    )
  ) {
    throw new TypeError(
      "Guarded GitHub ref materialization requires one expected repository."
    );
  }

  const scheduledAt = scheduledIso(scheduledTime);
  const configuredRefsJson = JSON.stringify(
    configuredRefs.map((configuredRef) => configuredRef.ref)
  );
  const session = database.withSession("first-primary");
  const expectedRepositoryBindings = [
    expectedRepository.project_id,
    expectedRepository.repository_id
  ];
  const observedState = await session.prepare(
    `WITH configured AS (
       SELECT CAST(value AS TEXT) AS ref FROM json_each(?)
     ), expected_repository(project_id, repository_id) AS (VALUES (?, ?))
     ${MATERIALIZATION_CURRENT_STATE_SQL}`
  ).bind(
    configuredRefsJson,
    ...expectedRepositoryBindings
  ).all<ScheduledRefMaterializationStateRow>();
  if (observedState.results.length !== configuredRefs.length) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const expectedState: ExpectedScheduledRefMaterializationState[] =
    observedState.results.map((state) => ({
      ref: state.ref,
      pre_cursor_exists: state.cursor_exists,
      post_cursor_exists: 1,
      pre_cursor_state_json: state.cursor_state_json,
      post_cursor_state_json: state.cursor_exists === 1
        ? state.cursor_state_json
        : JSON.stringify([
            null,
            "idle",
            null,
            null,
            scheduledAt,
            0,
            "unknown",
            null,
            scheduledAt,
            createRefScopeId(expectedRepository.repository_id, state.ref),
            1
          ]),
      head_state_json: state.head_state_json,
      active_item_count: state.active_item_count
    }));
  const expectedStateJson = JSON.stringify(expectedState);
  const guardBindings = guardedMaterializationBindings(
    configuredRefsJson,
    expectedStateJson,
    expectedRepository
  );
  const insertStatement = session.prepare(
    `${guardedMaterializationCtes("pre_cursor_state_json")}
     INSERT INTO sync_cursors
     (project_id, repository_id, ref, status, next_sync_at,
      history_gap_possible, credential_status, updated_at)
     SELECT repository_guard.project_id, repository_guard.repository_id,
            configured.ref, 'idle', ?, 0, 'unknown', ?
     FROM configured
     CROSS JOIN repository_guard
     CROSS JOIN state_guard
     WHERE 1
     ON CONFLICT(project_id, repository_id, ref) DO NOTHING`
  ).bind(...guardBindings, scheduledAt, scheduledAt);
  const selectedStatement = session.prepare(
    `${guardedMaterializationCtes("post_cursor_state_json")}, due AS (
       SELECT repository.repository_id, repository.project_id,
              repository.external_id, repository.expected_owner_external_id,
              repository.owner, repository.name, repository.default_branch,
              repository.tracked_refs_json, cursor.ref,
              cursor.status AS cursor_status,
              cursor.updated_at AS cursor_updated_at, cursor.cursor_version,
              repository.github_sync_configuration_version AS
                repository_configuration_version,
              repository.updated_at AS repository_updated_at,
              head.manifest_id AS selected_head_manifest_id,
              COALESCE(head.head_version, 0) AS selected_head_version,
              cursor.last_sync_at,
              current_state.cursor_state_json AS
                materialization_cursor_state_json,
              current_state.head_state_json AS
                materialization_head_state_json,
              current_state.active_item_count AS
                materialization_active_item_count
       FROM configured
       CROSS JOIN repository_guard
       CROSS JOIN state_guard
       JOIN current_state ON current_state.ref = configured.ref
       JOIN sync_cursors AS cursor
         ON cursor.project_id = repository_guard.project_id
        AND cursor.repository_id = repository_guard.repository_id
        AND cursor.ref = configured.ref
       JOIN repositories AS repository
         ON repository.project_id = cursor.project_id
        AND repository.repository_id = cursor.repository_id
       LEFT JOIN github_tree_ref_heads AS head
         ON head.project_id = cursor.project_id
        AND head.repository_id = cursor.repository_id
        AND head.ref = cursor.ref
       WHERE cursor.status <> 'paused'
         AND (cursor.next_sync_at IS NULL OR cursor.next_sync_at <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM github_sync_dispatch_items AS active_item
           WHERE active_item.project_id = cursor.project_id
             AND active_item.repository_id = cursor.repository_id
             AND active_item.ref = cursor.ref
             AND active_item.status IN ('pending', 'running')
         )
     )
     SELECT repository_id, project_id, external_id,
            expected_owner_external_id, owner, name, default_branch,
            tracked_refs_json, repository_configuration_version,
            repository_updated_at, ref, cursor_status, cursor_updated_at,
            cursor_version, selected_head_manifest_id, selected_head_version,
            last_sync_at, materialization_cursor_state_json,
            materialization_head_state_json,
            materialization_active_item_count
     FROM due
     ORDER BY cursor_updated_at, project_id, repository_id, ref
     LIMIT ?`
  ).bind(...guardBindings, scheduledAt, configuredRefs.length);
  const fenceStatement = session.prepare(
    `${guardedMaterializationCtes("post_cursor_state_json")}
     SELECT COUNT(*) AS guard_count
     FROM repository_guard CROSS JOIN state_guard`
  ).bind(...guardBindings);
  const results = await session.batch<
    GuardedScheduledRefRow | { guard_count: number }
  >(
    [insertStatement, selectedStatement, fenceStatement]
  );
  const fence = results[2]?.results[0] as { guard_count?: number } | undefined;
  if (fence?.guard_count !== 1) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  return (results[1]?.results as GuardedScheduledRefRow[] | undefined) ?? [];
}

export async function syncScheduledRef(
  selected: ScheduledRefRow,
  env: ActiveGitHubSyncEnv,
  scheduledTime: number,
  fullReconciliation: boolean,
  credentialStatus: "active" | "expiring",
  beforeRequest: GitHubRequestPacer,
  runId: string,
  absoluteDeadlineMs?: number
): Promise<void> {
  const client = createRefClient(
    selected,
    env.GITHUB_CLASSIC_TOKEN,
    beforeRequest,
    absoluteDeadlineMs
  );
  const verifiedDefaultBranch = await verifyRepositoryForRef(
    selected,
    client
  );
  const configuredRefs = parseTrackedRefs(
    selected.tracked_refs_json,
    verifiedDefaultBranch
  );
  if (!configuredRefs.includes(selected.ref)) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  await syncRef(
    selected,
    client,
    env,
    scheduledTime,
    selected.ref,
    verifiedDefaultBranch,
    fullReconciliation,
    credentialStatus,
    runId
  );
}

export async function failStagedManifestsForScheduledRef(
  database: D1Database,
  repository: Pick<ScheduledRefRow, "project_id" | "repository_id" | "ref">,
  scheduledTime: number,
  errorCode: GitHubSyncErrorCode
): Promise<void> {
  const staged = await database.withSession("first-primary").prepare(
    `SELECT manifest_id, project_id, repository_id, ref, observed_sha, tree_sha,
            repository_authority, collection_key, created_at
     FROM github_tree_manifests
     WHERE project_id = ? AND repository_id = ? AND ref = ?
       AND collection_key = ? AND status = 'staging'
     ORDER BY manifest_id LIMIT 10`
  ).bind(
    repository.project_id,
    repository.repository_id,
    repository.ref,
    scheduledIso(scheduledTime)
  ).all<{
    manifest_id: string;
    project_id: string;
    repository_id: string;
    ref: string;
    observed_sha: string;
    tree_sha: string;
    repository_authority: "default_branch" | "tracked_ref";
    collection_key: string;
    created_at: string;
  }>();
  for (const manifest of staged.results) {
    await failGitHubTreeManifest(
      database,
      {
        manifestId: manifest.manifest_id,
        projectId: manifest.project_id,
        repositoryId: manifest.repository_id,
        ref: manifest.ref,
        observedSha: manifest.observed_sha,
        treeSha: manifest.tree_sha,
        repositoryAuthority: manifest.repository_authority,
        collectionKey: manifest.collection_key,
        createdAt: manifest.created_at
      },
      errorCode
    );
  }
}

function createRefClient(
  repository: RepositoryRow,
  token: string,
  beforeRequest: GitHubRequestPacer,
  absoluteDeadlineMs?: number
): GitHubReadOnlyClient {
  return new GitHubReadOnlyClient({
    token,
    allowedRepositoryIds: new Set([repository.external_id]),
    maxRequests: MAX_GITHUB_REQUESTS_PER_REF,
    beforeRequest,
    requestTimeoutMs: 30_000,
    ...(absoluteDeadlineMs === undefined ? {} : { absoluteDeadlineMs })
  });
}

async function verifyRepositoryForRef(
  repository: RepositoryRow,
  client: GitHubReadOnlyClient,
  expectedDefaultBranch?: string
): Promise<string> {
  const metadata = await client.getRepository(
    repository.owner,
    repository.name,
    repository.external_id,
    repository.expected_owner_external_id as number
  );
  const verifiedDefaultBranch = metadata.default_branch;
  if (verifiedDefaultBranch === undefined || verifiedDefaultBranch === "") {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  if (
    (repository.default_branch !== null &&
      repository.default_branch !== verifiedDefaultBranch) ||
    (expectedDefaultBranch !== undefined &&
      expectedDefaultBranch !== verifiedDefaultBranch)
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  return verifiedDefaultBranch;
}

async function readWithdrawnSensitivePathDigests(
  database: D1Database,
  projectId: string,
  manifestId: string | null,
  sensitivePathDigests: readonly string[]
): Promise<Set<string>> {
  if (manifestId === null || sensitivePathDigests.length === 0) {
    return new Set();
  }
  const requestedPathDigests = [...new Set(sensitivePathDigests)];
  if (
    requestedPathDigests.length > MAX_FILES ||
    requestedPathDigests.some(
      (pathDigest) => !/^[0-9a-f]{64}$/u.test(pathDigest)
    )
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const result = await database
    .withSession("first-primary")
    .prepare(
      `WITH requested(path_digest) AS (
         SELECT value FROM json_each(?) WHERE type = 'text'
       )
       SELECT entry.path_digest
       FROM requested
       JOIN github_tree_manifest_entries AS entry
         ON entry.path_digest = requested.path_digest
       WHERE entry.project_id = ? AND entry.manifest_id = ?
         AND entry.disposition = 'text'
       ORDER BY entry.path_digest`
    )
    .bind(JSON.stringify(requestedPathDigests), projectId, manifestId)
    .all<{ path_digest: string }>();
  const pathDigests = new Set<string>();
  for (const row of result.results) {
    if (!/^[0-9a-f]{64}$/u.test(row.path_digest)) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    pathDigests.add(row.path_digest);
  }
  return pathDigests;
}

async function syncRef(
  repository: ScheduledRefRow,
  client: GitHubReadOnlyClient,
  env: Env,
  scheduledTime: number,
  ref: string,
  verifiedDefaultBranch: string,
  fullReconciliation: boolean,
  credentialStatus: "active" | "expiring",
  runId: string
): Promise<void> {
  let stagedManifest: GitHubTreeManifestDescriptor | null = null;
  try {
    await syncRefAttempt(
      repository,
      client,
      env,
      scheduledTime,
      ref,
      verifiedDefaultBranch,
      fullReconciliation,
      credentialStatus,
      runId,
      (manifest) => {
        stagedManifest = manifest;
      }
    );
  } catch (error) {
    const syncError = toSyncError(error);
    if (stagedManifest !== null && !syncError.retryable) {
      await failGitHubTreeManifest(
        env.MEMORY_DB,
        stagedManifest,
        syncError.code
      );
    }
    throw syncError;
  }
}

async function syncRefAttempt(
  repository: ScheduledRefRow,
  client: GitHubReadOnlyClient,
  env: Env,
  scheduledTime: number,
  ref: string,
  verifiedDefaultBranch: string,
  fullReconciliation: boolean,
  credentialStatus: "active" | "expiring",
  runId: string,
  onManifestStaged: (manifest: GitHubTreeManifestDescriptor) => void
): Promise<void> {
  const activeHead = await readActiveGitHubTreeHead(
    env.MEMORY_DB,
    repository.project_id,
    repository.repository_id,
    ref
  );
  if (
    (activeHead?.manifestId ?? null) !== repository.selected_head_manifest_id ||
    (activeHead?.headVersion ?? 0) !== repository.selected_head_version
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const cursor = await env.MEMORY_DB.prepare(
    `SELECT observed_sha, etag FROM sync_cursors
     WHERE project_id = ? AND repository_id = ? AND ref = ?`
  )
    .bind(repository.project_id, repository.repository_id, ref)
    .first<CursorRow>();
  const result = await client.getRefConditional(
    repository.owner,
    repository.name,
    repository.external_id,
    ref.slice("refs/".length),
    fullReconciliation || activeHead === null
      ? undefined
      : (cursor?.etag ?? undefined)
  );
  if (result.status === "not_modified") {
    if (
      cursor?.observed_sha === null ||
      cursor === null ||
      activeHead === null ||
      activeHead.observedSha !== cursor.observed_sha
    ) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    await markUnchanged(
      env.MEMORY_DB,
      repository,
      ref,
      scheduledTime,
      result.etag,
      result.rateLimit,
      credentialStatus,
      runId
    );
    return;
  }
  const reference = result.value;
  const observedSha = await client.peelReferenceToCommit(
    repository.owner,
    repository.name,
    repository.external_id,
    ref,
    reference
  );
  if (
    !fullReconciliation &&
    cursor?.observed_sha === observedSha &&
    activeHead?.observedSha === observedSha
  ) {
    await markUnchanged(
      env.MEMORY_DB,
      repository,
      ref,
      scheduledTime,
      result.etag,
      result.rateLimit,
      credentialStatus,
      runId
    );
    return;
  }
  let comparison: GitComparison | undefined;
  if (
    cursor?.observed_sha !== null &&
    cursor !== null &&
    cursor.observed_sha !== observedSha
  ) {
    try {
      comparison = await client.compareCommits(
        repository.owner,
        repository.name,
        repository.external_id,
        cursor.observed_sha,
        observedSha
      );
    } catch (error) {
      if (
        !(error instanceof GitHubSyncError) ||
        error.code !== "GITHUB_REPOSITORY_UNAVAILABLE"
      ) {
        throw error;
      }
    }
  }
  const change = classifyRefChange(cursor?.observed_sha ?? null, observedSha, comparison);

  const commit = await client.getCommit(
    repository.owner,
    repository.name,
    repository.external_id,
    observedSha
  );
  if (commit.sha !== observedSha) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const tree = await client.getTree(
    repository.owner,
    repository.name,
    repository.external_id,
    commit.tree.sha
  );
  if (tree.truncated) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  if (tree.sha !== commit.tree.sha) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const manifest = await buildGitHubTreeManifestDescriptor({
    projectId: repository.project_id,
    repositoryId: repository.repository_id,
    ref,
    observedSha,
    treeSha: tree.sha,
    repositoryAuthority: classifyRepositoryAuthority(ref, verifiedDefaultBranch),
    collectionKey: scheduledIso(scheduledTime),
    createdAt: new Date().toISOString()
  });
  await beginGitHubTreeManifest(env.MEMORY_DB, manifest);
  onManifestStaged(manifest);
  let runBytes = 0;
  let fileCount = 0;
  let partialDetected = false;
  const manifestEntries: GitHubTreeManifestEntry[] = [];
  const candidates: GitHubBlobCandidate[] = [];
  const tombstonePathDigestByEvidenceId = new Map<string, string>();
  for (const entry of tree.tree) {
    if (entry.type !== "blob") {
      continue;
    }
    const repositoryPath = validateRepositoryPath(entry.path);
    const pathDigest = await sha256(repositoryPath);
    const pathInspection = inspectSensitivePath(repositoryPath);
    const sensitivePath =
      !pathInspection.accepted || isSensitiveGitHubPath(repositoryPath);
    const safePath = sensitivePath ? null : repositoryPath;
    if (!Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0) {
      partialDetected = true;
      continue;
    }
    const byteSize = entry.size as number;
    const pathDecision = classifyGitHubBlobPath({
      path: repositoryPath,
      byteLength: byteSize
    });
    if (pathDecision.action === "exclude") {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: pathDecision.result.disposition
      });
      continue;
    }
    if (
      pathDecision.action === "partial" ||
      fileCount >= MAX_FILES ||
      runBytes + byteSize > MAX_RUN_BYTES
    ) {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: "partial"
      });
      partialDetected = true;
      continue;
    }
    fileCount += 1;
    const blob = await client.getBlob(
      repository.owner,
      repository.name,
      repository.external_id,
      entry.sha
    );
    if (blob.sha !== entry.sha || blob.size !== byteSize) {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: "partial"
      });
      partialDetected = true;
      continue;
    }
    const bytes = decodeBlobBytes(blob.encoding, blob.content);
    const classification = classifyGitHubBlobBytes({
      path: repositoryPath,
      bytes,
      declaredByteLength: blob.size
    });
    runBytes += bytes.byteLength;
    if (classification.disposition === "partial") {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: "partial"
      });
      partialDetected = true;
      continue;
    }
    if (
      classification.disposition === "binary_excluded" ||
      classification.disposition === "generated_excluded"
    ) {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: classification.disposition
      });
      continue;
    }
    const modelInspection = inspectMemoryModelInput(classification.text);
    if (!modelInspection.accepted && modelInspection.reason === "CONTENT_TOO_LARGE") {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: "partial"
      });
      partialDetected = true;
      continue;
    }
    const candidate = await buildGitHubBlobCandidate({
      projectId: repository.project_id,
      repositoryId: repository.repository_id,
      externalRepositoryId: repository.external_id,
      defaultBranch: verifiedDefaultBranch,
      ref,
      observedSha,
      path: repositoryPath,
      blobSha: entry.sha,
      content: classification.text
    });
    manifestEntries.push({
      pathDigest,
      safePath: candidate.sensitivityStatus === "tombstone" ? null : safePath,
      blobSha: entry.sha,
      byteSize,
      disposition:
        candidate.sensitivityStatus === "tombstone"
          ? "sensitive_tombstone"
          : "text"
    });
    candidates.push(candidate);
    if (candidate.sensitivityStatus === "tombstone") {
      tombstonePathDigestByEvidenceId.set(candidate.evidenceId, pathDigest);
    }
  }
  const withdrawnSensitivePathDigests = await readWithdrawnSensitivePathDigests(
    env.MEMORY_DB,
    repository.project_id,
    activeHead?.manifestId ?? null,
    [...tombstonePathDigestByEvidenceId.values()]
  );
  const persistableCandidates = candidates.filter((candidate) => {
    const pathDigest = tombstonePathDigestByEvidenceId.get(candidate.evidenceId);
    return (
      pathDigest === undefined || !withdrawnSensitivePathDigests.has(pathDigest)
    );
  });
  await persistGitHubTreeManifestEntries(env.MEMORY_DB, manifest, manifestEntries);
  if (partialDetected) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  await completeGitHubTreeManifest(
    env.MEMORY_DB,
    manifest,
    manifestEntries,
    new Date().toISOString()
  );
  const activationAttempt = await createGitHubTreeManifestActivationAttempt({
    runId,
    projectId: repository.project_id,
    repositoryId: repository.repository_id,
    ref,
    manifestId: manifest.manifestId
  });
  const activationFence: PendingGitHubSyncActivationFence = {
    projectId: repository.project_id,
    repositoryId: repository.repository_id,
    ref,
    manifestId: manifest.manifestId,
    repositoryAuthority: manifest.repositoryAuthority,
    runId,
    receiptId: activationAttempt.receiptId,
    activationToken: activationAttempt.activationToken,
    scheduledFor: new Date(scheduledTime).toISOString(),
    fullReconciliation,
    expectedHeadManifestId: activeHead?.manifestId ?? null,
    expectedHeadVersion: activeHead?.headVersion ?? 0,
    expectedExternalId: repository.external_id,
    expectedOwnerExternalId: repository.expected_owner_external_id as number,
    expectedOwner: repository.owner,
    expectedName: repository.name,
    expectedDefaultBranch: verifiedDefaultBranch,
    expectedTrackedRefsJson: repository.tracked_refs_json,
    expectedRepositoryConfigurationVersion:
      repository.repository_configuration_version,
    expectedRepositoryUpdatedAt: repository.repository_updated_at,
    expectedCursorObservedSha: cursor?.observed_sha ?? null,
    expectedCursorStatus: repository.cursor_status,
    expectedCursorUpdatedAt: repository.cursor_updated_at,
    expectedCursorVersion: repository.cursor_version
  };
  const candidateStatements = await prepareGitHubCandidateStatements({
    database: env.MEMORY_DB,
    projectId: repository.project_id,
    repositoryId: repository.repository_id,
    repositoryRef: ref,
    externalRepositoryId: repository.external_id,
    manifestId: manifest.manifestId,
    observedSha,
    activationFence,
    candidates: persistableCandidates
  });
  const syncEvent = await buildStableSyncEvent({
    projectId: repository.project_id,
    repositoryId: repository.repository_id,
    externalRepositoryId: repository.external_id,
    ref,
    observedSha,
    manifestId: manifest.manifestId
  });
  const syncPayload = JSON.stringify(syncEvent);
  await activateGitHubTreeManifest({
    database: env.MEMORY_DB,
    descriptor: manifest,
    expectedHead: activeHead,
    activationClaim: {
      runId,
      ...activationAttempt,
      expectedExternalId: repository.external_id,
      expectedOwnerExternalId: repository.expected_owner_external_id as number,
      expectedOwner: repository.owner,
      expectedName: repository.name,
      expectedDefaultBranch: verifiedDefaultBranch,
      expectedTrackedRefsJson: repository.tracked_refs_json,
      expectedRepositoryConfigurationVersion:
        repository.repository_configuration_version,
      expectedRepositoryUpdatedAt: repository.repository_updated_at,
      expectedCursorStatus: repository.cursor_status,
      expectedCursorUpdatedAt: repository.cursor_updated_at,
      expectedCursorVersion: repository.cursor_version,
      expectedCursorObservedSha: cursor?.observed_sha ?? null,
      fullReconciliation
    },
    scheduledTime,
    nextSyncAt: computeNextSyncAt(scheduledTime, result.rateLimit),
    historyGapPossible: change.historyGapPossible,
    credentialStatus,
    etag: result.etag ?? null,
    syncEvent: {
      eventId: syncEvent.eventId,
      payloadDigest: await sha256(syncPayload),
      payloadJson: syncPayload
    },
    candidateStatements
  });
}

export interface AccessBaseline {
  credentialVersion: string;
  userId: number;
  scopes: string[];
  repositories: Array<{
    id: number;
    permissions: {
      pull: boolean;
      push: boolean;
      admin: boolean;
    };
  }>;
}

export interface RefChangeClassification {
  kind: "initial" | "unchanged" | "fast_forward" | "force_push" | "reconciliation";
  historyGapPossible: boolean;
  reconciliationRequired: boolean;
}

export async function enforceApprovedAccessBaseline(
  database: D1Database,
  client: GitHubReadOnlyClient,
  credentialVersion: string,
  configuredRepositoryIds: ReadonlySet<number>,
  observedAt: number = Date.now()
): Promise<CredentialExpirationClassification> {
  const row = await database.prepare(
    `SELECT credential_version, user_id, scopes_json, repositories_json
     FROM github_access_baselines WHERE credential_version = ?`
  )
    .bind(credentialVersion)
    .first<AccessBaselineRow>();
  const approved = parseApprovedAccessBaseline(row, credentialVersion);
  if (!hasExactClassicPatScope(approved.scopes)) {
    throw new GitHubSyncError("GITHUB_PERMISSION_INSUFFICIENT");
  }
  const identity = await client.getAuthenticatedUser();
  if (identity.status !== "modified") {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const credentialExpiration = await recordCredentialExpirationObservation(
    database,
    credentialVersion,
    identity.credentialExpiresAt,
    observedAt
  );
  if (credentialExpiration.status === "expired") {
    throw new GitHubSyncError("GITHUB_CREDENTIAL_EXPIRED");
  }
  const observed = await collectAccessBaseline(client, credentialVersion, identity);
  if (!hasExactClassicPatScope(observed.scopes)) {
    throw new GitHubSyncError("GITHUB_PERMISSION_INSUFFICIENT");
  }
  const evaluation = evaluateAccessBaseline(approved, observed);
  const approvedIds = new Set(
    approved.repositories
      .filter((repository) => repository.permissions.pull)
      .map((repository) => repository.id)
  );
  const observedIds = new Set(
    observed.repositories
      .filter((repository) => repository.permissions.pull)
      .map((repository) => repository.id)
  );
  const configuredAccessValid = [...configuredRepositoryIds].every(
    (id) => approvedIds.has(id) && observedIds.has(id)
  );
  if (!evaluation.accepted || !configuredAccessValid) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  return credentialExpiration;
}

export function parseApprovedAccessBaseline(
  row: AccessBaselineRow | null,
  credentialVersion: string
): AccessBaseline {
  if (
    row === null ||
    credentialVersion === "" ||
    row.credential_version !== credentialVersion ||
    !Number.isSafeInteger(row.user_id) ||
    row.user_id <= 0
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  let scopes: unknown;
  let repositories: unknown;
  try {
    scopes = JSON.parse(row.scopes_json);
    repositories = JSON.parse(row.repositories_json);
  } catch {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  if (
    !Array.isArray(scopes) ||
    scopes.some(
      (scope) =>
        typeof scope !== "string" ||
        !/^[a-z0-9:_-]+$/iu.test(scope.trim())
    ) ||
    !Array.isArray(repositories)
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const parsedRepositories: AccessBaseline["repositories"] = [];
  const repositoryIds = new Set<number>();
  for (const repository of repositories) {
    if (!isApprovedRepository(repository) || repositoryIds.has(repository.id)) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    repositoryIds.add(repository.id);
    parsedRepositories.push({
      id: repository.id,
      permissions: {
        pull: repository.permissions.pull,
        push: repository.permissions.push,
        admin: repository.permissions.admin
      }
    });
  }
  return {
    credentialVersion,
    userId: row.user_id,
    scopes: normalizeClassicPatScopes(scopes),
    repositories: parsedRepositories.sort((left, right) => left.id - right.id)
  };
}

export async function collectAccessBaseline(
  client: GitHubReadOnlyClient,
  credentialVersion: string,
  prefetchedIdentity?: Awaited<ReturnType<GitHubReadOnlyClient["getAuthenticatedUser"]>>
): Promise<AccessBaseline> {
  const identity = prefetchedIdentity ?? (await client.getAuthenticatedUser());
  if (identity.status !== "modified") {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const access = await client.listAuthenticatedRepositories();
  const repositories = new Map<
    number,
    { pull: boolean; push: boolean; admin: boolean }
  >();
  for (const repository of access.repositories) {
    const prior = repositories.get(repository.id);
    repositories.set(repository.id, {
      pull: (prior?.pull ?? false) || repository.permissions.pull,
      push: (prior?.push ?? false) || repository.permissions.push,
      admin: (prior?.admin ?? false) || repository.permissions.admin
    });
  }
  return {
    credentialVersion,
    userId: identity.value.id,
    scopes: normalizeClassicPatScopes([...identity.scopes, ...access.scopes]),
    repositories: [...repositories.entries()]
      .map(([id, permissions]) => ({ id, permissions }))
      .sort((left, right) => left.id - right.id)
  };
}

export function classifyCredentialExpiration(
  expiresAt: string,
  observedAt: number
): CredentialExpirationClassification {
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== expiresAt ||
    !Number.isFinite(observedAt)
  ) {
    throw new GitHubSyncError("GITHUB_CREDENTIAL_EXPIRED");
  }
  const remainingMs = expiresAtMs - observedAt;
  if (remainingMs <= 0) {
    return { status: "expired", warningThresholdDays: null };
  }
  const dayMs = 24 * 60 * 60 * 1_000;
  for (const threshold of [1, 7, 14] as const) {
    if (remainingMs <= threshold * dayMs) {
      return { status: "expiring", warningThresholdDays: threshold };
    }
  }
  return { status: "active", warningThresholdDays: null };
}

export async function recordCredentialExpirationObservation(
  database: D1Database,
  credentialVersion: string,
  expiresAt: string,
  observedAt: number
): Promise<CredentialExpirationClassification> {
  const classification = classifyCredentialExpiration(expiresAt, observedAt);
  const observedAtIso = scheduledIso(observedAt);
  const lastErrorCode =
    classification.status === "expired" ? "GITHUB_CREDENTIAL_EXPIRED" : null;
  const stateStatement = database.prepare(
    `INSERT INTO github_credential_states
     (credential_version, expires_at, last_observed_at, credential_status,
      warning_threshold_days, last_error_code, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(credential_version) DO UPDATE SET
       expires_at = excluded.expires_at,
       last_observed_at = excluded.last_observed_at,
       credential_status = excluded.credential_status,
       warning_threshold_days = excluded.warning_threshold_days,
       last_error_code = excluded.last_error_code,
       updated_at = excluded.updated_at`
  ).bind(
    credentialVersion,
    expiresAt,
    observedAtIso,
    classification.status,
    classification.warningThresholdDays,
    lastErrorCode,
    observedAtIso
  );
  if (classification.warningThresholdDays === null) {
    await stateStatement.run();
    return classification;
  }
  const eventDigest = await sha256(
    [
      "github.credential.expiry.warning",
      credentialVersion,
      String(classification.warningThresholdDays),
      expiresAt
    ].join("\n")
  );
  const warningStatement = database.prepare(
    `INSERT INTO github_credential_expiry_warnings
     (event_id, credential_version, threshold_days, expires_at, observed_at,
      event_digest)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(credential_version, threshold_days) DO NOTHING`
  ).bind(
    eventDigest,
    credentialVersion,
    classification.warningThresholdDays,
    expiresAt,
    observedAtIso,
    eventDigest
  );
  await database.batch([stateStatement, warningStatement]);
  return classification;
}

export function parseTrackedRefs(
  trackedRefsJson: string,
  defaultBranch: string
): string[] {
  if (new TextEncoder().encode(trackedRefsJson).byteLength > 256 * 1024) {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trackedRefsJson);
  } catch {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 512 ||
    parsed.some((value) => typeof value !== "string")
  ) {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  const refs = [`refs/heads/${defaultBranch}`, ...parsed];
  for (const ref of refs) {
    if (
      typeof ref !== "string" ||
      !/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(ref) ||
      ref.includes("..") ||
      ref.includes("//") ||
      ref.endsWith("/") ||
      ref.includes("@{") ||
      new TextEncoder().encode(ref).byteLength > 1_024
    ) {
      throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
    }
  }
  return [...new Set(refs)].sort();
}

export function classifyRefChange(
  previousSha: string | null,
  observedSha: string,
  comparison?: GitComparison
): RefChangeClassification {
  if (previousSha === null) {
    return {
      kind: "initial",
      historyGapPossible: false,
      reconciliationRequired: false
    };
  }
  if (previousSha === observedSha) {
    return {
      kind: "unchanged",
      historyGapPossible: false,
      reconciliationRequired: false
    };
  }
  if (
    comparison?.status === "ahead" &&
    comparison.merge_base_commit.sha === previousSha &&
    comparison.behind_by === 0
  ) {
    return {
      kind: "fast_forward",
      historyGapPossible: false,
      reconciliationRequired: false
    };
  }
  if (comparison === undefined) {
    return {
      kind: "reconciliation",
      historyGapPossible: true,
      reconciliationRequired: true
    };
  }
  return {
    kind: "force_push",
    historyGapPossible: true,
    reconciliationRequired: true
  };
}

export function evaluateAccessBaseline(
  approved: AccessBaseline,
  observed: AccessBaseline
): {
  accepted: boolean;
  addedRepositoryIds: number[];
  elevatedRepositoryIds: number[];
  addedScopes: string[];
  identityChanged: boolean;
  credentialVersionChanged: boolean;
} {
  const approvedRepositories = new Map(
    approved.repositories.map((repository) => [repository.id, repository.permissions])
  );
  const observedRepositories = new Map(
    observed.repositories.map((repository) => [repository.id, repository.permissions])
  );
  const addedRepositoryIds = [...observedRepositories.keys()]
    .filter((id) => !approvedRepositories.has(id))
    .sort((left, right) => left - right);
  const elevatedRepositoryIds = [...observedRepositories.entries()]
    .filter(([id, permissions]) => {
      const prior = approvedRepositories.get(id);
      return (
        prior !== undefined &&
        ((!prior.pull && permissions.pull) ||
          (!prior.push && permissions.push) ||
          (!prior.admin && permissions.admin))
      );
    })
    .map(([id]) => id)
    .sort((left, right) => left - right);
  const normalizedApprovedScopes = normalizeClassicPatScopes(approved.scopes);
  const normalizedObservedScopes = normalizeClassicPatScopes(observed.scopes);
  const approvedScopes = new Set(normalizedApprovedScopes);
  const addedScopes = normalizedObservedScopes
    .filter((scope) => !approvedScopes.has(scope))
    .sort();
  const identityChanged = approved.userId !== observed.userId;
  const credentialVersionChanged =
    approved.credentialVersion !== observed.credentialVersion;
  return {
    accepted:
      addedRepositoryIds.length === 0 &&
      elevatedRepositoryIds.length === 0 &&
      addedScopes.length === 0 &&
      hasExactClassicPatScope(normalizedApprovedScopes) &&
      hasExactClassicPatScope(normalizedObservedScopes) &&
      !identityChanged &&
      !credentialVersionChanged,
    addedRepositoryIds,
    elevatedRepositoryIds,
    addedScopes,
    identityChanged,
    credentialVersionChanged
  };
}

function normalizeClassicPatScopes(scopes: readonly string[]): string[] {
  return [
    ...new Set(
      scopes
        .map((scope) => scope.trim().toLowerCase())
        .filter((scope) => scope !== "")
    )
  ].sort();
}

function hasExactClassicPatScope(scopes: readonly string[]): boolean {
  const normalized = normalizeClassicPatScopes(scopes);
  return normalized.length === 1 && normalized[0] === "repo";
}

export async function buildStableSyncEvent(input: {
  projectId: string;
  repositoryId: string;
  externalRepositoryId: number;
  ref: string;
  observedSha: string;
  manifestId: string;
}): Promise<Extract<MemoryEvent, { type: "github.sync.requested" }>> {
  const idempotencyKey = `github:${input.externalRepositoryId}:${input.manifestId}`;
  const eventId = await sha256(
    [
      "github.sync.requested",
      input.projectId,
      input.repositoryId,
      String(input.externalRepositoryId),
      input.ref,
      input.observedSha,
      input.manifestId
    ].join("\n")
  );
  return {
    type: "github.sync.requested",
    eventId,
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    externalRepositoryId: input.externalRepositoryId,
    ref: input.ref,
    observedSha: input.observedSha,
    manifestId: input.manifestId,
    idempotencyKey
  };
}

export async function buildGitHubBlobCandidate(input: {
  projectId: string;
  repositoryId: string;
  externalRepositoryId: number;
  defaultBranch: string;
  ref: string;
  observedSha: string;
  path: string;
  blobSha: string;
  content: string;
}): Promise<GitHubBlobCandidate> {
  if (new TextEncoder().encode(input.content).byteLength > MAX_CANDIDATE_BYTES) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  const contentInspection = inspectMemoryModelInput(input.content);
  if (!contentInspection.accepted && contentInspection.reason === "CONTENT_TOO_LARGE") {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  const repositoryPath = validateRepositoryPath(input.path);
  const repositoryAuthority = classifyRepositoryAuthority(
    input.ref,
    input.defaultBranch
  );
  const pathInspection = inspectSensitivePath(input.path);
  const pathAccepted = pathInspection.accepted && !isSensitiveGitHubPath(input.path);
  const pathHash = await sha256(input.path);
  const sensitivityStatus =
    !contentInspection.accepted || !pathAccepted ? "tombstone" : "clear";
  const evidenceId = await buildGitHubBlobEvidenceId({
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    externalRepositoryId: input.externalRepositoryId,
    repositoryRef: input.ref,
    observedSha: input.observedSha,
    repositoryPath,
    blobSha: input.blobSha,
    sensitivityStatus
  });
  if (sensitivityStatus === "tombstone") {
    return {
      evidenceId,
      locator: await buildGitHubTombstoneEvidenceLocator({
        externalRepositoryId: input.externalRepositoryId,
        repositoryRef: input.ref,
        observedSha: input.observedSha,
        repositoryPath
      }),
      repositoryId: input.repositoryId,
      repositoryRef: input.ref,
      repositoryPath: null,
      repositoryAuthority,
      excerptHash: await sha256("github-sensitive-tombstone"),
      sensitivityStatus: "tombstone"
    };
  }
  const contentSha256 = await sha256(input.content);
  const locator = await buildGitHubClearEvidenceLocator({
    externalRepositoryId: input.externalRepositoryId,
    repositoryRef: input.ref,
    observedSha: input.observedSha,
    repositoryPath
  });
  const observationId = await stableUuid(
    [
      "github.candidate",
      input.projectId,
      input.repositoryId,
      String(input.externalRepositoryId),
      input.ref,
      input.observedSha,
      input.path,
      input.blobSha
    ].join("\n")
  );
  const idempotencyDigest = await sha256(
    [input.ref, input.observedSha, pathHash, input.blobSha].join("\n")
  );
  const idempotencyKey =
    `github-candidate:${input.externalRepositoryId}:${idempotencyDigest}`;
  const event: Extract<MemoryEvent, { type: "candidate.submitted" }> = {
    type: "candidate.submitted",
    eventId: observationId,
    projectId: input.projectId,
    candidateId: observationId,
    idempotencyKey
  };
  return {
    evidenceId,
    locator,
    repositoryId: input.repositoryId,
    repositoryRef: input.ref,
    repositoryPath,
    repositoryAuthority,
    excerptHash: contentSha256,
    sensitivityStatus: "clear",
    observation: {
      observationId,
      content: input.content,
      contentSha256,
      evidenceJson: JSON.stringify([
        {
          source_type: "github_blob",
          locator,
          commit_sha: input.observedSha,
          excerpt_hash: contentSha256
        }
      ]),
      event
    }
  };
}

function classifyRepositoryAuthority(
  ref: string,
  verifiedDefaultBranch: string
): "default_branch" | "tracked_ref" {
  const [defaultRef] = parseTrackedRefs("[]", verifiedDefaultBranch);
  const validatedRefs = parseTrackedRefs(JSON.stringify([ref]), verifiedDefaultBranch);
  if (defaultRef === undefined || !validatedRefs.includes(ref)) {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  return ref === defaultRef ? "default_branch" : "tracked_ref";
}

function validateRepositoryPath(path: string): string {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    new TextEncoder().encode(path).byteLength > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  return path;
}


async function stableUuid(value: string): Promise<string> {
  const digest = await sha256(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function computeNextSyncAt(
  scheduledTime: number,
  rateLimit?: GitHubRateLimit,
  retryAfterMs?: number
): string {
  const normalNext =
    retryAfterMs === undefined ? scheduledTime + 6 * 60 * 60 * 1000 : scheduledTime;
  const retryNext =
    retryAfterMs === undefined ? scheduledTime : scheduledTime + retryAfterMs;
  const resetNext =
    rateLimit?.remaining === 0 && rateLimit.resetAt !== undefined
      ? rateLimit.resetAt + 1_000
      : scheduledTime;
  return new Date(Math.max(normalNext, retryNext, resetNext)).toISOString();
}

function decodeBlobBytes(
  encoding: "base64" | "utf-8",
  content: string
): Uint8Array {
  if (encoding === "utf-8") {
    return new TextEncoder().encode(content);
  }
  const normalized = content.replaceAll("\n", "");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isSensitiveGitHubPath(path: string): boolean {
  return /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/iu.test(
    path
  );
}

function isApprovedRepository(value: unknown): value is {
  id: number;
  permissions: { pull: boolean; push: boolean; admin: boolean };
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    permissions?: unknown;
  };
  if (
    Object.keys(value).sort().join(",") !== "id,permissions" ||
    !Number.isSafeInteger(candidate.id) ||
    (candidate.id as number) <= 0 ||
    typeof candidate.permissions !== "object" ||
    candidate.permissions === null ||
    Object.keys(candidate.permissions).sort().join(",") !== "admin,pull,push"
  ) {
    return false;
  }
  const permissions = candidate.permissions as Record<string, unknown>;
  return (
    typeof permissions.pull === "boolean" &&
    typeof permissions.push === "boolean" &&
    typeof permissions.admin === "boolean"
  );
}

export function isDailyFullReconciliation(scheduledTime: number): boolean {
  if (!Number.isFinite(scheduledTime)) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const scheduled = new Date(scheduledTime);
  return scheduled.getUTCHours() === 0 && scheduled.getUTCMinutes() === 0;
}

export function requiresFullReconciliation(
  scheduledTime: number,
  lastSyncAt: string | null
): boolean {
  if (isDailyFullReconciliation(scheduledTime) || lastSyncAt === null) {
    return true;
  }
  const lastSyncAtMs = Date.parse(lastSyncAt);
  if (!Number.isFinite(lastSyncAtMs) || lastSyncAtMs > scheduledTime) {
    return true;
  }
  const scheduled = new Date(scheduledTime);
  const utcDayStart = Date.UTC(
    scheduled.getUTCFullYear(),
    scheduled.getUTCMonth(),
    scheduled.getUTCDate()
  );
  return lastSyncAtMs < utcDayStart;
}

export async function recordInvalidCredentialObservation(
  database: D1Database,
  credentialVersion: string,
  observedAt: number
): Promise<void> {
  const observedAtIso = scheduledIso(observedAt);
  await database.prepare(
    `INSERT INTO github_credential_states
     (credential_version, expires_at, last_observed_at, credential_status,
      warning_threshold_days, last_error_code, updated_at)
     VALUES (?, NULL, ?, 'invalid', NULL, 'GITHUB_CREDENTIAL_EXPIRED', ?)
     ON CONFLICT(credential_version) DO UPDATE SET
       last_observed_at = excluded.last_observed_at,
       credential_status = CASE
         WHEN github_credential_states.credential_status = 'expired' THEN 'expired'
         ELSE 'invalid'
       END,
       warning_threshold_days = NULL,
       last_error_code = 'GITHUB_CREDENTIAL_EXPIRED',
       updated_at = excluded.updated_at`
  )
    .bind(credentialVersion, observedAtIso, observedAtIso)
    .run();
}

type D1PrimarySession = ReturnType<D1Database["withSession"]>;

async function expireStaleRepositorySyncRuns(
  session: D1PrimarySession,
  repository: ScheduledRefRow,
  claimedAt: string
): Promise<void> {
  await session.prepare(
    `UPDATE github_repository_sync_runs
     SET status = 'failed', completed_at = ?,
         last_error_code = 'GITHUB_RECONCILIATION_REQUIRED'
     WHERE project_id = ? AND repository_id = ? AND status = 'running'
       AND claimed_ref = ? AND lease_expires_at <= ?`
  )
    .bind(
      claimedAt,
      repository.project_id,
      repository.repository_id,
      repository.ref,
      claimedAt
    )
    .run();
}

async function hasExactRecoveredRepositorySyncClaim(
  database: D1Database,
  input: {
    repository: ScheduledRefRow;
    runId: string;
    scheduledFor: string;
    fullReconciliation: boolean;
    claimedAt: string;
    leaseExpiresAt: string;
  }
): Promise<boolean> {
  try {
    const observedAt = new Date().toISOString();
    const result = await database.withSession("first-primary").prepare(
      `SELECT 1 AS matches
       FROM github_repository_sync_runs AS claimed_run
       JOIN repositories AS repository
         ON repository.project_id = claimed_run.project_id
        AND repository.repository_id = claimed_run.repository_id
       JOIN sync_cursors AS cursor
         ON cursor.project_id = claimed_run.project_id
        AND cursor.repository_id = claimed_run.repository_id
        AND cursor.ref = claimed_run.claimed_ref
       LEFT JOIN github_tree_ref_heads AS head
         ON head.project_id = claimed_run.project_id
        AND head.repository_id = claimed_run.repository_id
        AND head.ref = claimed_run.claimed_ref
       WHERE claimed_run.run_id = ?
         AND claimed_run.project_id = ?
         AND claimed_run.repository_id = ?
         AND claimed_run.scheduled_for = ?
         AND claimed_run.full_reconciliation = ?
         AND claimed_run.status = 'running'
         AND claimed_run.started_at = ?
         AND claimed_run.lease_expires_at = ?
         AND claimed_run.lease_expires_at > ?
         AND claimed_run.claimed_ref = ?
         AND claimed_run.claimed_head_manifest_id IS ?
         AND claimed_run.claimed_head_version = ?
         AND claimed_run.repository_configuration_version = ?
         AND claimed_run.cursor_version = ?
         AND claimed_run.claim_contract_version = 1
         AND claimed_run.completed_at IS NULL
         AND claimed_run.last_error_code IS NULL
         AND lower(repository.provider) = 'github'
         AND repository.sync_enabled = 1
         AND repository.external_id = ?
         AND repository.expected_owner_external_id IS ?
         AND repository.owner = ?
         AND repository.name = ?
         AND repository.default_branch IS ?
         AND repository.tracked_refs_json = ?
         AND repository.github_sync_configuration_version = ?
         AND repository.updated_at = ?
         AND cursor.status = ?
         AND cursor.status <> 'paused'
         AND cursor.updated_at = ?
         AND cursor.cursor_version = ?
         AND head.manifest_id IS ?
         AND COALESCE(head.head_version, 0) = ?
       LIMIT 1`
    )
      .bind(
        input.runId,
        input.repository.project_id,
        input.repository.repository_id,
        input.scheduledFor,
        input.fullReconciliation ? 1 : 0,
        input.claimedAt,
        input.leaseExpiresAt,
        observedAt,
        input.repository.ref,
        input.repository.selected_head_manifest_id,
        input.repository.selected_head_version,
        input.repository.repository_configuration_version,
        input.repository.cursor_version,
        input.repository.external_id,
        input.repository.expected_owner_external_id,
        input.repository.owner,
        input.repository.name,
        input.repository.default_branch,
        input.repository.tracked_refs_json,
        input.repository.repository_configuration_version,
        input.repository.repository_updated_at,
        input.repository.cursor_status,
        input.repository.cursor_updated_at,
        input.repository.cursor_version,
        input.repository.selected_head_manifest_id,
        input.repository.selected_head_version
      )
      .all<{ matches: number }>();
    return result.results.length === 1 && result.results[0]?.matches === 1;
  } catch {
    return false;
  }
}

export async function claimRepositorySync(
  database: D1Database,
  repository: ScheduledRefRow,
  scheduledTime: number,
  fullReconciliation: boolean,
  claimStartedAtMs = Date.now()
): Promise<string | null> {
  const scheduledFor = scheduledIso(scheduledTime);
  const claimedAtMs = claimStartedAtMs;
  if (!Number.isFinite(claimedAtMs)) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const claimedAt = new Date(claimedAtMs).toISOString();
  const leaseExpiresAt = new Date(claimedAtMs + SYNC_RUN_LEASE_MS).toISOString();
  const runId = await sha256(
    [
      "github.repository.sync.run",
      repository.project_id,
      repository.repository_id,
      repository.ref,
      scheduledFor
    ].join("\n")
  );
  let session = database.withSession("first-primary");
  try {
    await expireStaleRepositorySyncRuns(session, repository, claimedAt);
  } catch (error) {
    session = database.withSession("first-primary");
    try {
      await expireStaleRepositorySyncRuns(session, repository, claimedAt);
    } catch {
      throw error;
    }
  }
  const claimStatement = session.prepare(
    `INSERT INTO github_repository_sync_runs
     (run_id, project_id, repository_id, scheduled_for, full_reconciliation,
      status, started_at, lease_expires_at, claimed_ref,
      claimed_head_manifest_id, claimed_head_version,
      repository_configuration_version, cursor_version, claim_contract_version)
     SELECT ?, repository.project_id, repository.repository_id, ?, ?,
            'running', ?, ?, cursor.ref,
            head.manifest_id, COALESCE(head.head_version, 0),
            repository.github_sync_configuration_version,
            cursor.cursor_version, 1
     FROM repositories AS repository
     JOIN sync_cursors AS cursor
       ON cursor.project_id = repository.project_id
      AND cursor.repository_id = repository.repository_id
      AND cursor.ref = ?
     LEFT JOIN github_tree_ref_heads AS head
       ON head.project_id = cursor.project_id
      AND head.repository_id = cursor.repository_id
      AND head.ref = cursor.ref
     WHERE repository.project_id = ? AND repository.repository_id = ?
       AND lower(repository.provider) = 'github'
       AND repository.sync_enabled = 1
       AND repository.external_id = ?
       AND repository.expected_owner_external_id IS ?
       AND repository.owner = ? AND repository.name = ?
       AND repository.default_branch IS ?
       AND repository.tracked_refs_json = ?
       AND repository.github_sync_configuration_version = ?
       AND repository.updated_at = ?
       AND cursor.status = ? AND cursor.status <> 'paused'
       AND cursor.updated_at = ?
       AND cursor.cursor_version = ?
       AND head.manifest_id IS ?
       AND COALESCE(head.head_version, 0) = ?
       AND NOT EXISTS (
         SELECT 1 FROM github_repository_sync_runs
         WHERE project_id = repository.project_id
           AND repository_id = repository.repository_id
           AND claimed_ref = cursor.ref
           AND status = 'running' AND lease_expires_at > ?
       )
     ON CONFLICT(project_id, repository_id, claimed_ref, scheduled_for)
     DO NOTHING`
  ).bind(
    runId,
    scheduledFor,
    fullReconciliation ? 1 : 0,
    claimedAt,
    leaseExpiresAt,
    repository.ref,
    repository.project_id,
    repository.repository_id,
    repository.external_id,
    repository.expected_owner_external_id,
    repository.owner,
    repository.name,
    repository.default_branch,
    repository.tracked_refs_json,
    repository.repository_configuration_version,
    repository.repository_updated_at,
    repository.cursor_status,
    repository.cursor_updated_at,
    repository.cursor_version,
    repository.selected_head_manifest_id,
    repository.selected_head_version,
    claimedAt
  );
  let result: D1Result;
  try {
    result = await claimStatement.run();
  } catch (error) {
    if (
      await hasExactRecoveredRepositorySyncClaim(database, {
        repository,
        runId,
        scheduledFor,
        fullReconciliation,
        claimedAt,
        leaseExpiresAt
      })
    ) {
      return runId;
    }
    throw error;
  }
  if ((result.meta.changes ?? 0) === 1) {
    return runId;
  }
  return (await hasExactRecoveredRepositorySyncClaim(database, {
    repository,
    runId,
    scheduledFor,
    fullReconciliation,
    claimedAt,
    leaseExpiresAt
  }))
    ? runId
    : null;
}

export async function finishRepositorySyncRun(
  database: D1Database,
  runId: string,
  errorCode: string | null,
  completedAt = new Date().toISOString()
): Promise<string> {
  const status = errorCode === null ? "complete" : "failed";
  let result: D1Result;
  try {
    result = await database.withSession("first-primary").prepare(
    `UPDATE github_repository_sync_runs
     SET status = ?, completed_at = ?, last_error_code = ?
     WHERE run_id = ? AND status = 'running'`
    )
      .bind(status, completedAt, errorCode, runId)
      .run();
  } catch (error) {
    const recovered = await readFinishedRepositorySyncRun(
      database,
      runId,
      status,
      errorCode
    );
    if (recovered !== null) {
      return recovered;
    }
    throw error;
  }
  if ((result.meta.changes ?? 0) !== 1) {
    const recovered = await readFinishedRepositorySyncRun(
      database,
      runId,
      status,
      errorCode
    );
    if (recovered === null) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    return recovered;
  }
  return completedAt;
}

async function readFinishedRepositorySyncRun(
  database: D1Database,
  runId: string,
  status: "complete" | "failed",
  errorCode: string | null
): Promise<string | null> {
  try {
    const exact = await database.withSession("first-primary").prepare(
      `SELECT completed_at FROM github_repository_sync_runs
       WHERE run_id = ? AND status = ? AND completed_at IS NOT NULL
         AND last_error_code IS ? LIMIT 1`
    )
      .bind(runId, status, errorCode)
      .first<{ completed_at: string }>();
    return exact?.completed_at ?? null;
  } catch {
    return null;
  }
}

function scheduledIso(scheduledTime: number): string {
  if (!Number.isFinite(scheduledTime)) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  return new Date(scheduledTime).toISOString();
}

export async function recordSyncFailure(
  database: D1Database,
  repository: RepositoryRow,
  ref: string,
  error: GitHubSyncError,
  scheduledTime: number,
  knownCredentialStatus: "active" | "expiring" = "active",
  expectedSelection?: ScheduledRefRow,
  expectedRunId: string | null = null
): Promise<void> {
  if (
    expectedRunId !== null &&
    (expectedSelection === undefined ||
      expectedSelection.project_id !== repository.project_id ||
      expectedSelection.repository_id !== repository.repository_id ||
      expectedSelection.ref !== ref)
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const historyGapPossible =
    error.code === "GITHUB_RECONCILIATION_REQUIRED" ? 1 : 0;
  const credentialStatus = [
    "GITHUB_AUTHORIZATION_REQUIRED",
    "GITHUB_CREDENTIAL_EXPIRED",
    "GITHUB_SSO_REQUIRED",
    "GITHUB_CLASSIC_PAT_BLOCKED",
    "GITHUB_PERMISSION_INSUFFICIENT"
  ].includes(error.code)
    ? "blocked"
    : knownCredentialStatus;
  const expectedCursorUpdatedAt = expectedSelection?.cursor_updated_at ?? null;
  const expectedCursorStatus = expectedSelection?.cursor_status ?? null;
  const expectedCursorVersion = expectedSelection?.cursor_version ?? null;
  const expectedHeadManifestId =
    expectedSelection?.selected_head_manifest_id ?? null;
  const expectedHeadVersion = expectedSelection?.selected_head_version ?? null;
  const expectedFullReconciliation =
    expectedSelection === undefined
      ? null
      : requiresFullReconciliation(scheduledTime, expectedSelection.last_sync_at)
        ? 1
        : 0;
  const expectedScheduledFor = scheduledIso(scheduledTime);
  const terminalAt = new Date().toISOString();
  await database.withSession("first-primary").prepare(
    `INSERT INTO sync_cursors
     (project_id, repository_id, ref, status, next_sync_at, history_gap_possible,
      last_error_code, credential_status, updated_at)
     SELECT ?, ?, ?, 'failed', ?, ?, ?, ?, ?
     FROM repositories AS repository
     WHERE repository.project_id = ? AND repository.repository_id = ?
       AND lower(repository.provider) = 'github'
       AND repository.sync_enabled = 1
       AND repository.external_id = ?
       AND repository.expected_owner_external_id IS ?
       AND repository.owner = ? AND repository.name = ?
       AND repository.default_branch IS ?
       AND repository.tracked_refs_json = ?
       AND repository.github_sync_configuration_version = ?
       AND repository.updated_at = ?
       AND (
         (? IS NULL AND NOT EXISTS (
           SELECT 1 FROM github_repository_sync_runs AS active_run
           WHERE active_run.project_id = repository.project_id
             AND active_run.repository_id = repository.repository_id
             AND active_run.status = 'running'
             AND active_run.lease_expires_at > ?
         ))
         OR EXISTS (
           SELECT 1 FROM github_repository_sync_runs AS claimed_run
           WHERE claimed_run.run_id IS ?
             AND claimed_run.project_id = repository.project_id
             AND claimed_run.repository_id = repository.repository_id
             AND claimed_run.status = 'running'
             AND claimed_run.lease_expires_at > ?
             AND claimed_run.scheduled_for = ?
             AND claimed_run.full_reconciliation = ?
             AND claimed_run.claimed_ref = ?
             AND claimed_run.claimed_head_manifest_id IS ?
             AND claimed_run.claimed_head_version = ?
             AND claimed_run.repository_configuration_version = ?
             AND claimed_run.cursor_version = ?
             AND claimed_run.claim_contract_version = 1
         )
       )
       AND (
         ? IS NULL OR EXISTS (
           SELECT 1 FROM sync_cursors AS selected_cursor
           LEFT JOIN github_tree_ref_heads AS selected_head
             ON selected_head.project_id = selected_cursor.project_id
            AND selected_head.repository_id = selected_cursor.repository_id
            AND selected_head.ref = selected_cursor.ref
           WHERE selected_cursor.project_id = repository.project_id
             AND selected_cursor.repository_id = repository.repository_id
             AND selected_cursor.ref = ?
             AND selected_cursor.status = ?
             AND selected_cursor.status <> 'paused'
             AND selected_cursor.updated_at = ?
             AND selected_cursor.cursor_version = ?
             AND selected_head.manifest_id IS ?
             AND COALESCE(selected_head.head_version, 0) = ?
         )
       )
     ON CONFLICT(project_id, repository_id, ref) DO UPDATE SET
       status = excluded.status, next_sync_at = excluded.next_sync_at,
       history_gap_possible = excluded.history_gap_possible,
       last_error_code = excluded.last_error_code,
       credential_status = excluded.credential_status, updated_at = excluded.updated_at
     WHERE sync_cursors.status <> 'paused'
       AND EXISTS (
         SELECT 1 FROM repositories AS current_repository
         WHERE current_repository.project_id = excluded.project_id
           AND current_repository.repository_id = excluded.repository_id
           AND lower(current_repository.provider) = 'github'
           AND current_repository.sync_enabled = 1
           AND current_repository.external_id = ?
           AND current_repository.expected_owner_external_id IS ?
           AND current_repository.owner = ? AND current_repository.name = ?
           AND current_repository.default_branch IS ?
           AND current_repository.tracked_refs_json = ?
           AND current_repository.github_sync_configuration_version = ?
           AND current_repository.updated_at = ?
       )
       AND (
         (? IS NULL AND NOT EXISTS (
           SELECT 1 FROM github_repository_sync_runs AS active_run
           WHERE active_run.project_id = excluded.project_id
             AND active_run.repository_id = excluded.repository_id
             AND active_run.status = 'running'
             AND active_run.lease_expires_at > ?
         ))
         OR EXISTS (
           SELECT 1 FROM github_repository_sync_runs AS claimed_run
           WHERE claimed_run.run_id IS ?
             AND claimed_run.project_id = excluded.project_id
             AND claimed_run.repository_id = excluded.repository_id
             AND claimed_run.status = 'running'
             AND claimed_run.lease_expires_at > ?
             AND claimed_run.scheduled_for = ?
             AND claimed_run.full_reconciliation = ?
             AND claimed_run.claimed_ref = ?
             AND claimed_run.claimed_head_manifest_id IS ?
             AND claimed_run.claimed_head_version = ?
             AND claimed_run.repository_configuration_version = ?
             AND claimed_run.cursor_version = ?
             AND claimed_run.claim_contract_version = 1
         )
       )
       AND (
         ? IS NULL OR (
           sync_cursors.status = ? AND sync_cursors.updated_at = ?
           AND sync_cursors.cursor_version = ?
           AND (
             SELECT current_head.manifest_id
             FROM github_tree_ref_heads AS current_head
             WHERE current_head.project_id = sync_cursors.project_id
               AND current_head.repository_id = sync_cursors.repository_id
               AND current_head.ref = sync_cursors.ref
           ) IS ?
           AND COALESCE((
             SELECT current_head.head_version
             FROM github_tree_ref_heads AS current_head
             WHERE current_head.project_id = sync_cursors.project_id
               AND current_head.repository_id = sync_cursors.repository_id
               AND current_head.ref = sync_cursors.ref
           ), 0) = ?
         )
       )`
  )
    .bind(
      repository.project_id,
      repository.repository_id,
      ref,
      computeNextSyncAt(
        scheduledTime,
        error.rateLimit,
        error.retryable ? error.retryAfterMs : undefined
      ),
      historyGapPossible,
      error.code,
      credentialStatus,
      terminalAt,
      repository.project_id,
      repository.repository_id,
      repository.external_id,
      repository.expected_owner_external_id,
      repository.owner,
      repository.name,
      repository.default_branch,
      repository.tracked_refs_json,
      repository.repository_configuration_version,
      repository.repository_updated_at,
      expectedRunId,
      terminalAt,
      expectedRunId,
      terminalAt,
      expectedScheduledFor,
      expectedFullReconciliation,
      ref,
      expectedHeadManifestId,
      expectedHeadVersion,
      repository.repository_configuration_version,
      expectedCursorVersion,
      expectedCursorUpdatedAt,
      ref,
      expectedCursorStatus,
      expectedCursorUpdatedAt,
      expectedCursorVersion,
      expectedHeadManifestId,
      expectedHeadVersion,
      repository.external_id,
      repository.expected_owner_external_id,
      repository.owner,
      repository.name,
      repository.default_branch,
      repository.tracked_refs_json,
      repository.repository_configuration_version,
      repository.repository_updated_at,
      expectedRunId,
      terminalAt,
      expectedRunId,
      terminalAt,
      expectedScheduledFor,
      expectedFullReconciliation,
      ref,
      expectedHeadManifestId,
      expectedHeadVersion,
      repository.repository_configuration_version,
      expectedCursorVersion,
      expectedCursorUpdatedAt,
      expectedCursorStatus,
      expectedCursorUpdatedAt,
      expectedCursorVersion,
      expectedHeadManifestId,
      expectedHeadVersion
    )
    .run();
}

interface CursorObservedShaSnapshot {
  observed_sha: string | null;
}

async function readExactCursorObservedSha(
  session: D1PrimarySession,
  repository: ScheduledRefRow,
  ref: string
): Promise<CursorObservedShaSnapshot | null> {
  const result = await session.prepare(
    `SELECT observed_sha
     FROM sync_cursors
     WHERE project_id = ? AND repository_id = ? AND ref = ?
       AND status = ? AND status <> 'paused'
       AND updated_at = ? AND cursor_version = ?
     LIMIT 1`
  )
    .bind(
      repository.project_id,
      repository.repository_id,
      ref,
      repository.cursor_status,
      repository.cursor_updated_at,
      repository.cursor_version
    )
    .all<CursorObservedShaSnapshot>();
  return result.results.length === 1 ? (result.results[0] ?? null) : null;
}

async function hasExactRecoveredUnchangedCursor(
  database: D1Database,
  input: {
    repository: ScheduledRefRow;
    ref: string;
    expectedRunId: string;
    scheduledFor: string;
    nextSyncAt: string;
    etag: string | null;
    credentialStatus: "active" | "expiring";
    terminalAt: string;
    observedSha: string | null;
    expectedCursorVersion: number;
  }
): Promise<boolean> {
  try {
    const observedAt = new Date().toISOString();
    const result = await database.withSession("first-primary").prepare(
      `SELECT 1 AS matches
       FROM github_repository_sync_runs AS claimed_run
       JOIN repositories AS repository
         ON repository.project_id = claimed_run.project_id
        AND repository.repository_id = claimed_run.repository_id
       JOIN sync_cursors AS cursor
         ON cursor.project_id = claimed_run.project_id
        AND cursor.repository_id = claimed_run.repository_id
        AND cursor.ref = claimed_run.claimed_ref
       LEFT JOIN github_tree_ref_heads AS head
         ON head.project_id = claimed_run.project_id
        AND head.repository_id = claimed_run.repository_id
        AND head.ref = claimed_run.claimed_ref
       WHERE claimed_run.run_id = ?
         AND claimed_run.project_id = ?
         AND claimed_run.repository_id = ?
         AND claimed_run.scheduled_for = ?
         AND claimed_run.full_reconciliation = ?
         AND claimed_run.claimed_ref = ?
         AND claimed_run.claimed_head_manifest_id IS ?
         AND claimed_run.claimed_head_version = ?
         AND claimed_run.repository_configuration_version = ?
         AND claimed_run.cursor_version = ?
         AND claimed_run.claim_contract_version = 1
         AND claimed_run.status = 'running'
         AND claimed_run.lease_expires_at > ?
         AND claimed_run.completed_at IS NULL
         AND claimed_run.last_error_code IS NULL
         AND cursor.observed_sha IS ?
         AND cursor.status = 'complete'
         AND cursor.last_sync_at = ?
         AND cursor.next_sync_at = ?
         AND cursor.history_gap_possible = 0
         AND cursor.credential_status = ?
         AND cursor.etag IS ?
         AND cursor.last_error_code IS NULL
         AND cursor.updated_at = ?
         AND cursor.cursor_version = ?
         AND lower(repository.provider) = 'github'
         AND repository.sync_enabled = 1
         AND repository.external_id = ?
         AND repository.expected_owner_external_id IS ?
         AND repository.owner = ?
         AND repository.name = ?
         AND repository.default_branch IS ?
         AND repository.tracked_refs_json = ?
         AND repository.github_sync_configuration_version = ?
         AND repository.updated_at = ?
         AND head.manifest_id IS ?
         AND COALESCE(head.head_version, 0) = ?
       LIMIT 1`
    )
      .bind(
        input.expectedRunId,
        input.repository.project_id,
        input.repository.repository_id,
        input.scheduledFor,
        requiresFullReconciliation(
          Date.parse(input.scheduledFor),
          input.repository.last_sync_at
        )
          ? 1
          : 0,
        input.ref,
        input.repository.selected_head_manifest_id,
        input.repository.selected_head_version,
        input.repository.repository_configuration_version,
        input.repository.cursor_version,
        observedAt,
        input.observedSha,
        input.scheduledFor,
        input.nextSyncAt,
        input.credentialStatus,
        input.etag,
        input.terminalAt,
        input.expectedCursorVersion,
        input.repository.external_id,
        input.repository.expected_owner_external_id,
        input.repository.owner,
        input.repository.name,
        input.repository.default_branch,
        input.repository.tracked_refs_json,
        input.repository.repository_configuration_version,
        input.repository.repository_updated_at,
        input.repository.selected_head_manifest_id,
        input.repository.selected_head_version
      )
      .all<{ matches: number }>();
    return result.results.length === 1 && result.results[0]?.matches === 1;
  } catch {
    return false;
  }
}

export async function markUnchanged(
  database: D1Database,
  repository: ScheduledRefRow,
  ref: string,
  scheduledTime: number,
  etag: string | undefined,
  rateLimit: GitHubRateLimit | undefined,
  credentialStatus: "active" | "expiring",
  expectedRunId: string
): Promise<void> {
  if (
    !Number.isSafeInteger(repository.cursor_version) ||
    repository.cursor_version < 1 ||
    repository.cursor_version >= Number.MAX_SAFE_INTEGER
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const scheduledFor = scheduledIso(scheduledTime);
  const nextSyncAt = computeNextSyncAt(scheduledTime, rateLimit);
  const normalizedEtag = etag ?? null;
  const terminalAt = new Date().toISOString();
  const expectedCursorVersion = repository.cursor_version + 1;
  const session = database.withSession("first-primary");
  const cursorSnapshot = await readExactCursorObservedSha(
    session,
    repository,
    ref
  );
  if (cursorSnapshot === null) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const statement = session.prepare(
    `UPDATE sync_cursors
     SET status = 'complete', last_sync_at = ?, next_sync_at = ?, etag = ?,
         history_gap_possible = 0, credential_status = ?,
         last_error_code = NULL, updated_at = ?, cursor_version = cursor_version + 1
     WHERE project_id = ? AND repository_id = ? AND ref = ?
       AND status = ? AND status <> 'paused' AND updated_at = ?
       AND cursor_version = ? AND observed_sha IS ?
       AND EXISTS (
         SELECT 1 FROM repositories AS repository
         WHERE repository.project_id = sync_cursors.project_id
           AND repository.repository_id = sync_cursors.repository_id
           AND lower(repository.provider) = 'github'
           AND repository.sync_enabled = 1
           AND repository.external_id = ?
           AND repository.expected_owner_external_id IS ?
           AND repository.owner = ? AND repository.name = ?
           AND repository.default_branch IS ?
           AND repository.tracked_refs_json = ?
           AND repository.github_sync_configuration_version = ?
           AND repository.updated_at = ?
       )
       AND EXISTS (
         SELECT 1 FROM github_repository_sync_runs AS claimed_run
         WHERE claimed_run.run_id IS ?
           AND claimed_run.project_id = sync_cursors.project_id
           AND claimed_run.repository_id = sync_cursors.repository_id
           AND claimed_run.scheduled_for = ?
           AND claimed_run.full_reconciliation = ?
           AND claimed_run.claimed_ref = ?
           AND claimed_run.claimed_head_manifest_id IS ?
           AND claimed_run.claimed_head_version = ?
           AND claimed_run.repository_configuration_version = ?
           AND claimed_run.cursor_version = ?
           AND claimed_run.claim_contract_version = 1
           AND claimed_run.status = 'running'
           AND claimed_run.lease_expires_at > ?
           AND (
             (
               claimed_run.claimed_head_version = 0
               AND claimed_run.claimed_head_manifest_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM github_tree_ref_heads AS current_head
                 WHERE current_head.project_id = claimed_run.project_id
                   AND current_head.repository_id = claimed_run.repository_id
                   AND current_head.ref = claimed_run.claimed_ref
               )
             )
             OR EXISTS (
               SELECT 1 FROM github_tree_ref_heads AS current_head
               WHERE current_head.project_id = claimed_run.project_id
                 AND current_head.repository_id = claimed_run.repository_id
                 AND current_head.ref = claimed_run.claimed_ref
                 AND current_head.manifest_id IS
                   claimed_run.claimed_head_manifest_id
                 AND current_head.head_version =
                   claimed_run.claimed_head_version
             )
           )
       )`
  )
    .bind(
      scheduledFor,
      nextSyncAt,
      normalizedEtag,
      credentialStatus,
      terminalAt,
      repository.project_id,
      repository.repository_id,
      ref,
      repository.cursor_status,
      repository.cursor_updated_at,
      repository.cursor_version,
      cursorSnapshot.observed_sha,
      repository.external_id,
      repository.expected_owner_external_id,
      repository.owner,
      repository.name,
      repository.default_branch,
      repository.tracked_refs_json,
      repository.repository_configuration_version,
      repository.repository_updated_at,
      expectedRunId,
      scheduledFor,
      requiresFullReconciliation(scheduledTime, repository.last_sync_at) ? 1 : 0,
      ref,
      repository.selected_head_manifest_id,
      repository.selected_head_version,
      repository.repository_configuration_version,
      repository.cursor_version,
      terminalAt
    );
  let result: D1Result;
  try {
    result = await statement.run();
  } catch (error) {
    if (
      await hasExactRecoveredUnchangedCursor(database, {
        repository,
        ref,
        expectedRunId,
        scheduledFor,
        nextSyncAt,
        etag: normalizedEtag,
        credentialStatus,
        terminalAt,
        observedSha: cursorSnapshot.observed_sha,
        expectedCursorVersion
      })
    ) {
      return;
    }
    throw error;
  }
  if ((result.meta.changes ?? 0) !== 1) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
}

function toSyncError(error: unknown): GitHubSyncError {
  return error instanceof GitHubSyncError
    ? error
    : new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
}
