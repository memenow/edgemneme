import type { WorkflowStep } from "cloudflare:workers";
import { GitHubReadOnlyClient, GitHubSyncError } from "../../src/github/client";
import {
  chunkWorkflowBatch,
  GITHUB_SYNC_SLOT_MS,
  githubDispatchIdentity
} from "../../src/github/sync-scheduling";
import { sha256 } from "../../src/security/crypto";
import {
  completeGitHubDispatchMaterialization,
  establishGitHubDispatch,
  hasGitHubDispatchMaterializationReceipt,
  markGitHubDispatchStatus,
  releaseGitHubCredentialLane,
  reserveGitHubDispatchRequest,
  type GitHubCredentialLaneToken
} from "../../src/github/sync-workflow";
import {
  MAX_GITHUB_ACCESS_BASELINE_REQUESTS,
  enforceApprovedAccessBaseline,
  materializeAndSelectScheduledRefsGuarded,
  parseTrackedRefs,
  recordInvalidCredentialObservation,
  recordSyncFailure,
  type ActiveGitHubSyncEnv,
  type ConfiguredRefRow,
  type Env,
  type GitHubDispatchWorkflowPayload,
  type GitHubRefSyncWorkflowPayload,
  type RepositoryRow
} from "./index";
import {
  LANE_LEASE_SAFETY_MARGIN_MS,
  STEP_RETRY,
  SYNC_STEP,
  acquireCredentialLane,
  activeWorkflowEnv,
  createDurableWorkflowRequestPacer,
  failDispatchWorkflow,
  reconcilePriorDispatchStateWithUsage,
  workflowSyncError,
  type SerializedSyncAttempt
} from "./workflow-runtime";
import {
  GITHUB_DISPATCH_LANE_MAX_ATTEMPTS,
  MATERIALIZATION_BATCH_SIZE,
  MAX_REPOSITORY_ADMISSION_SUMMARY_PAGES,
  REPOSITORY_ID_PAGE_SIZE,
  REPOSITORY_SNAPSHOT_PAGE_SIZE,
  assertGitHubDispatchAdmission,
  assertGitHubDispatchStepResult,
  type GitHubDispatchAdmissionInventory
} from "./workflow-dispatch-admission";
import { persistDispatchItems } from "./workflow-dispatch-item-persistence";

export {
  GITHUB_DISPATCH_LANE_MAX_ATTEMPTS,
  GITHUB_DISPATCH_STEP_RESULT_LIMIT_BYTES,
  GITHUB_DISPATCH_STEP_RESULT_RESERVE_BYTES,
  GITHUB_DISPATCH_SUBREQUEST_LIMIT,
  GITHUB_DISPATCH_SUBREQUEST_RESERVE,
  GITHUB_DISPATCH_WORKFLOW_STEP_LIMIT,
  GITHUB_DISPATCH_WORKFLOW_STEP_RESERVE,
  assertGitHubDispatchStepResult,
  estimateGitHubDispatchAdmission
} from "./workflow-dispatch-admission";
export type {
  GitHubDispatchAdmissionEstimate,
  GitHubDispatchAdmissionInventory
} from "./workflow-dispatch-admission";
export { persistDispatchItems } from "./workflow-dispatch-item-persistence";

const DISPATCH_EXECUTION_BUDGET_MS = 12 * 60 * 1_000;

interface RepositoryPageCursor {
  afterProjectId: string;
  afterRepositoryId: string;
  hasMore: boolean;
}

interface RepositoryAdmissionSummaryPage extends RepositoryPageCursor {
  repositoryIds: number[];
  repositoryFingerprints: string[];
  enabledRepositoryRows: number;
  validRepositoryRows: number;
  invalidRepositoryRows: number;
  parsedRefCount: number;
  materializationBatchCount: number;
}

type RepositoryAdmissionSnapshot =
  | {
      valid: true;
      fingerprint: string;
      externalRepositoryId: number;
      projectId: string;
      repositoryId: string;
      refs: string[];
    }
  | {
      valid: false;
      fingerprint: string;
      projectId: string;
      repositoryId: string;
    };

interface RepositoryAdmissionSnapshotPage extends RepositoryPageCursor {
  snapshot: RepositoryAdmissionSnapshot | null;
}

interface CollectedAdmissionSummary {
  inventory: GitHubDispatchAdmissionInventory;
  repositoryFingerprints: string[];
}

interface CollectedAdmissionSnapshots {
  inventory: GitHubDispatchAdmissionInventory;
  allowedRepositoryIds: Set<number>;
  snapshots: RepositoryAdmissionSnapshot[];
}

async function loadRepositoryPage(
  database: D1Database,
  afterProjectId: string,
  afterRepositoryId: string,
  limit: number
): Promise<RepositoryRow[]> {
  const rows = await database.withSession("first-primary").prepare(
    `SELECT repository_id, project_id, external_id, expected_owner_external_id,
            owner, name, default_branch, tracked_refs_json,
            github_sync_configuration_version AS repository_configuration_version,
            updated_at AS repository_updated_at
     FROM repositories
     WHERE lower(provider) = 'github' AND sync_enabled = 1
       AND (project_id > ? OR (project_id = ? AND repository_id > ?))
     ORDER BY project_id, repository_id LIMIT ?`
  ).bind(
    afterProjectId,
    afterProjectId,
    afterRepositoryId,
    limit
  ).all<RepositoryRow>();
  return rows.results;
}

function configuredRefsForRepository(
  repository: RepositoryRow
): ConfiguredRefRow[] | null {
  if (
    !Number.isSafeInteger(repository.expected_owner_external_id) ||
    (repository.expected_owner_external_id ?? 0) <= 0 ||
    repository.default_branch === null
  ) {
    return null;
  }
  try {
    return parseTrackedRefs(
      repository.tracked_refs_json,
      repository.default_branch
    ).map((ref) => ({
      project_id: repository.project_id,
      repository_id: repository.repository_id,
      ref
    }));
  } catch {
    return null;
  }
}

async function repositoryFingerprint(
  repository: RepositoryRow
): Promise<string> {
  return sha256(JSON.stringify(
    [
      repository.project_id,
      repository.repository_id,
      repository.external_id,
      repository.expected_owner_external_id,
      repository.owner,
      repository.name,
      repository.default_branch,
      repository.tracked_refs_json,
      repository.repository_configuration_version,
      repository.repository_updated_at
    ]
  ));
}

async function loadRepositoryAdmissionSummaryPage(
  database: D1Database,
  afterProjectId: string,
  afterRepositoryId: string
): Promise<RepositoryAdmissionSummaryPage> {
  const repositories = await loadRepositoryPage(
    database,
    afterProjectId,
    afterRepositoryId,
    REPOSITORY_ID_PAGE_SIZE
  );
  const repositoryIds: number[] = [];
  const repositoryFingerprints: string[] = [];
  let validRepositoryRows = 0;
  let invalidRepositoryRows = 0;
  let parsedRefCount = 0;
  let materializationBatchCount = 0;
  for (const repository of repositories) {
    repositoryFingerprints.push(await repositoryFingerprint(repository));
    const refs = configuredRefsForRepository(repository);
    if (refs !== null) {
      repositoryIds.push(repository.external_id);
      validRepositoryRows += 1;
      parsedRefCount += refs.length;
      materializationBatchCount += Math.ceil(
        refs.length / MATERIALIZATION_BATCH_SIZE
      );
    } else {
      invalidRepositoryRows += 1;
    }
  }
  const last = repositories.at(-1);
  const result = {
    repositoryIds,
    repositoryFingerprints,
    enabledRepositoryRows: repositories.length,
    validRepositoryRows,
    invalidRepositoryRows,
    parsedRefCount,
    materializationBatchCount,
    afterProjectId: last?.project_id ?? afterProjectId,
    afterRepositoryId: last?.repository_id ?? afterRepositoryId,
    hasMore: repositories.length === REPOSITORY_ID_PAGE_SIZE
  };
  assertGitHubDispatchStepResult(result);
  return result;
}

async function collectRepositoryAdmissionSummary(
  step: WorkflowStep,
  database: D1Database
): Promise<CollectedAdmissionSummary> {
  const allowedRepositoryIds = new Set<number>();
  const repositoryFingerprints: string[] = [];
  let enabledRepositoryRows = 0;
  let validRepositoryRows = 0;
  let invalidRepositoryRows = 0;
  let parsedRefCount = 0;
  let materializationBatchCount = 0;
  let afterProjectId = "";
  let afterRepositoryId = "";
  let summaryPageCount = 0;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_REPOSITORY_ADMISSION_SUMMARY_PAGES) {
      throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
    }
    const result = await step.do(
      `summarize GitHub repository admission page ${page + 1}`,
      STEP_RETRY,
      () => loadRepositoryAdmissionSummaryPage(
        database,
        afterProjectId,
        afterRepositoryId
      )
    );
    summaryPageCount += 1;
    for (const repositoryId of result.repositoryIds) {
      allowedRepositoryIds.add(repositoryId);
    }
    repositoryFingerprints.push(...result.repositoryFingerprints);
    enabledRepositoryRows += result.enabledRepositoryRows;
    validRepositoryRows += result.validRepositoryRows;
    invalidRepositoryRows += result.invalidRepositoryRows;
    parsedRefCount += result.parsedRefCount;
    materializationBatchCount += result.materializationBatchCount;
    afterProjectId = result.afterProjectId;
    afterRepositoryId = result.afterRepositoryId;
    if (!result.hasMore) break;
  }
  return {
    inventory: {
      enabledRepositoryRows,
      validRepositoryRows,
      invalidRepositoryRows,
      parsedRefCount,
      materializationBatchCount,
      uniqueExternalRepositoryIds: allowedRepositoryIds.size,
      summaryPageCount,
      snapshotPageCount: enabledRepositoryRows + 1
    },
    repositoryFingerprints
  };
}

async function loadRepositoryAdmissionSnapshotPage(
  database: D1Database,
  afterProjectId: string,
  afterRepositoryId: string
): Promise<RepositoryAdmissionSnapshotPage> {
  const repositories = await loadRepositoryPage(
    database,
    afterProjectId,
    afterRepositoryId,
    REPOSITORY_SNAPSHOT_PAGE_SIZE
  );
  const repository = repositories[0];
  const fingerprint = repository === undefined
    ? null
    : await repositoryFingerprint(repository);
  const configuredRefs = repository === undefined
    ? null
    : configuredRefsForRepository(repository);
  const snapshot: RepositoryAdmissionSnapshot | null =
    repository === undefined || fingerprint === null
      ? null
      : configuredRefs === null
        ? {
            valid: false,
            fingerprint,
            projectId: repository.project_id,
            repositoryId: repository.repository_id
          }
        : {
            valid: true,
            fingerprint,
            externalRepositoryId: repository.external_id,
            projectId: repository.project_id,
            repositoryId: repository.repository_id,
            refs: configuredRefs.map((configured) => configured.ref)
          };
  const last = repositories.at(-1);
  const result = {
    snapshot,
    afterProjectId: last?.project_id ?? afterProjectId,
    afterRepositoryId: last?.repository_id ?? afterRepositoryId,
    hasMore: repositories.length === REPOSITORY_SNAPSHOT_PAGE_SIZE
  };
  assertGitHubDispatchStepResult(result);
  return result;
}

function inventoriesMatch(
  left: GitHubDispatchAdmissionInventory,
  right: GitHubDispatchAdmissionInventory
): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof GitHubDispatchAdmissionInventory] ===
      right[key as keyof GitHubDispatchAdmissionInventory]
  );
}

async function collectRepositoryAdmissionSnapshots(
  step: WorkflowStep,
  database: D1Database,
  summary: CollectedAdmissionSummary
): Promise<CollectedAdmissionSnapshots> {
  const snapshots: RepositoryAdmissionSnapshot[] = [];
  const allowedRepositoryIds = new Set<number>();
  const repositoryFingerprints: string[] = [];
  let validRepositoryRows = 0;
  let invalidRepositoryRows = 0;
  let parsedRefCount = 0;
  let materializationBatchCount = 0;
  let afterProjectId = "";
  let afterRepositoryId = "";
  let snapshotPageCount = 0;
  for (let page = 0; ; page += 1) {
    if (page >= summary.inventory.snapshotPageCount) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    const result = await step.do(
      `snapshot GitHub repository admission row ${page + 1}`,
      STEP_RETRY,
      () => loadRepositoryAdmissionSnapshotPage(
        database,
        afterProjectId,
        afterRepositoryId
      )
    );
    snapshotPageCount += 1;
    if (result.snapshot !== null) {
      snapshots.push(result.snapshot);
      repositoryFingerprints.push(result.snapshot.fingerprint);
      if (result.snapshot.valid) {
        validRepositoryRows += 1;
        allowedRepositoryIds.add(result.snapshot.externalRepositoryId);
        parsedRefCount += result.snapshot.refs.length;
        materializationBatchCount += Math.ceil(
          result.snapshot.refs.length / MATERIALIZATION_BATCH_SIZE
        );
      } else {
        invalidRepositoryRows += 1;
      }
    }
    afterProjectId = result.afterProjectId;
    afterRepositoryId = result.afterRepositoryId;
    if (!result.hasMore) break;
  }
  const inventory: GitHubDispatchAdmissionInventory = {
    enabledRepositoryRows: snapshots.length,
    validRepositoryRows,
    invalidRepositoryRows,
    parsedRefCount,
    materializationBatchCount,
    uniqueExternalRepositoryIds: allowedRepositoryIds.size,
    summaryPageCount: summary.inventory.summaryPageCount,
    snapshotPageCount
  };
  if (
    !inventoriesMatch(summary.inventory, inventory) ||
    repositoryFingerprints.length !== summary.repositoryFingerprints.length ||
    repositoryFingerprints.some(
      (fingerprint, index) =>
        fingerprint !== summary.repositoryFingerprints[index]
    )
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  return { inventory, allowedRepositoryIds, snapshots };
}

async function loadRepositoryByIdentity(
  database: D1Database,
  projectId: string,
  repositoryId: string
): Promise<RepositoryRow | null> {
  return database.withSession("first-primary").prepare(
    `SELECT repository_id, project_id, external_id, expected_owner_external_id,
            owner, name, default_branch, tracked_refs_json,
            github_sync_configuration_version AS repository_configuration_version,
            updated_at AS repository_updated_at
     FROM repositories
     WHERE project_id = ? AND repository_id = ?
       AND lower(provider) = 'github' AND sync_enabled = 1`
  ).bind(projectId, repositoryId).first<RepositoryRow>();
}

async function processRepositoryAdmissionSnapshot(
  database: D1Database,
  payload: GitHubDispatchWorkflowPayload,
  snapshot: RepositoryAdmissionSnapshot,
  baselineError: GitHubSyncError | null
): Promise<void> {
  const scheduledTime = Date.parse(payload.scheduledFor);
  if (!snapshot.valid) {
    const repository = await loadRepositoryByIdentity(
      database,
      snapshot.projectId,
      snapshot.repositoryId
    );
    if (
      repository !== null &&
      await repositoryFingerprint(repository) === snapshot.fingerprint &&
      configuredRefsForRepository(repository) === null
    ) {
      await recordSyncFailure(
        database,
        repository,
        "refs/heads/unknown",
        new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE"),
        scheduledTime
      );
    }
    return;
  }
  const repository = await loadRepositoryByIdentity(
    database,
    snapshot.projectId,
    snapshot.repositoryId
  );
  if (
    repository === null ||
    await repositoryFingerprint(repository) !== snapshot.fingerprint
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const configuredRefs = snapshot.refs.map((ref) => ({
    project_id: snapshot.projectId,
    repository_id: snapshot.repositoryId,
    ref
  }));
  for (const configuredBatch of chunkWorkflowBatch(
    configuredRefs,
    MATERIALIZATION_BATCH_SIZE
  )) {
    const selected = await materializeAndSelectScheduledRefsGuarded(
      database,
      configuredBatch,
      repository,
      scheduledTime
    );
    for (const ref of selected) {
      if (await repositoryFingerprint(ref) !== snapshot.fingerprint) {
        throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
      }
    }
    if (baselineError === null) {
      await persistDispatchItems(database, payload, selected);
      continue;
    }
    for (const ref of selected) {
      await recordSyncFailure(
        database,
        ref,
        ref.ref,
        baselineError,
        scheduledTime,
        "active",
        ref
      );
    }
  }
}

async function processRepositoryAdmissionSnapshots(
  step: WorkflowStep,
  database: D1Database,
  payload: GitHubDispatchWorkflowPayload,
  snapshots: RepositoryAdmissionSnapshot[],
  baselineError: GitHubSyncError | null
): Promise<void> {
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    if (snapshot === undefined) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    const action = baselineError === null
      ? "materialize"
      : "record baseline failure for";
    await step.do(
      `${action} GitHub repository ${index + 1}`,
      STEP_RETRY,
      () => processRepositoryAdmissionSnapshot(
        database,
        payload,
        snapshot,
        baselineError
      )
    );
  }
}

function serializedSyncError(error: unknown): SerializedSyncAttempt {
  const normalized = workflowSyncError(error);
  return {
    ok: false,
    code: normalized.code,
    retryable: normalized.retryable,
    ...(normalized.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: normalized.retryAfterMs }),
    ...(normalized.rateLimit === undefined
      ? {}
      : { rateLimit: normalized.rateLimit })
  };
}

function syncErrorFromAttempt(attempt: SerializedSyncAttempt): GitHubSyncError {
  return new GitHubSyncError(
    attempt.code ?? "GITHUB_RECONCILIATION_REQUIRED",
    {
      retryable: attempt.retryable ?? false,
      ...(attempt.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: attempt.retryAfterMs }),
      ...(attempt.rateLimit === undefined
        ? {}
        : { rateLimit: attempt.rateLimit })
    }
  );
}

async function verifyApprovedAccessBaseline(
  step: WorkflowStep,
  active: ActiveGitHubSyncEnv,
  payload: GitHubDispatchWorkflowPayload,
  lane: GitHubCredentialLaneToken,
  allowedRepositoryIds: ReadonlySet<number>,
  absoluteDeadlineMs: number
): Promise<void> {
  const pacer = createDurableWorkflowRequestPacer({
    reserve: () =>
      reserveGitHubDispatchRequest(
        active.MEMORY_DB,
        payload.dispatchId,
        lane,
        MAX_GITHUB_ACCESS_BASELINE_REQUESTS
      )
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outcome = await step.do(
      `verify approved GitHub access baseline ${attempt + 1}`,
      SYNC_STEP,
      async (): Promise<SerializedSyncAttempt> => {
        try {
          if (Date.now() >= absoluteDeadlineMs) {
            throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
          }
          const client = new GitHubReadOnlyClient({
            token: active.GITHUB_CLASSIC_TOKEN,
            allowedRepositoryIds,
            maxRequests: MAX_GITHUB_ACCESS_BASELINE_REQUESTS,
            requestTimeoutMs: 30_000,
            absoluteDeadlineMs,
            beforeRequest: pacer
          });
          await enforceApprovedAccessBaseline(
            active.MEMORY_DB,
            client,
            payload.credentialVersion,
            allowedRepositoryIds,
            Date.parse(payload.scheduledFor)
          );
          return { ok: true };
        } catch (error) {
          return serializedSyncError(error);
        }
      }
    );
    if (outcome.ok) return;
    const error = syncErrorFromAttempt(outcome);
    if (!error.retryable || attempt === 2) throw error;
    const now = await step.do(`observe baseline retry clock ${attempt + 1}`, () =>
      Promise.resolve(Date.now())
    );
    const delay = Math.max(
      1,
      error.retryAfterMs ?? Math.min(60_000, 1_000 * 2 ** attempt)
    );
    if (now + delay >= absoluteDeadlineMs) throw error;
    await step.sleep(`wait for baseline retry ${attempt + 1}`, delay);
  }
}

async function listDispatchItems(
  database: D1Database,
  dispatchId: string,
  afterItemId: string
): Promise<Array<{ itemId: string; instanceId: string }>> {
  const rows = await database.withSession("first-primary").prepare(
    `SELECT item_id, workflow_instance_id
     FROM github_sync_dispatch_items
     WHERE dispatch_id = ? AND item_id > ?
     ORDER BY item_id LIMIT 100`
  ).bind(dispatchId, afterItemId).all<{
    item_id: string;
    workflow_instance_id: string;
  }>();
  const result = rows.results.map((row) => ({
    itemId: row.item_id,
    instanceId: row.workflow_instance_id
  }));
  assertGitHubDispatchStepResult(result);
  return result;
}

async function countDispatchItems(
  database: D1Database,
  dispatchId: string
): Promise<number> {
  const row = await database.withSession("first-primary").prepare(
    `SELECT COUNT(*) AS item_count FROM github_sync_dispatch_items
     WHERE dispatch_id = ?`
  ).bind(dispatchId).first<{ item_count: number }>();
  if (row === null || !Number.isSafeInteger(row.item_count) || row.item_count < 0) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  return row.item_count;
}

export async function ensureGitHubRefWorkflowBatch(
  workflow: Workflow<GitHubRefSyncWorkflowPayload>,
  inputs: Array<{ id: string; params: GitHubRefSyncWorkflowPayload }>
): Promise<void> {
  try {
    await workflow.createBatch(inputs);
    return;
  } catch (batchError) {
    for (const input of inputs) {
      try {
        const instance = await workflow.get(input.id);
        const status = await instance.status();
        if (["queued", "running", "waiting", "waitingForPause", "paused", "complete"].includes(status.status)) {
          continue;
        }
        if (status.status === "errored" || status.status === "terminated") {
          await instance.restart();
          continue;
        }
      } catch {
        try {
          await workflow.create(input);
          continue;
        } catch (createError) {
          try {
            const instance = await workflow.get(input.id);
            const status = await instance.status();
            if (["queued", "running", "waiting", "waitingForPause", "paused", "complete"].includes(status.status)) {
              continue;
            }
          } catch {
            throw createError;
          }
          throw createError;
        }
      }
      throw batchError;
    }
  }
}

export async function runGitHubDispatchWorkflow(
  payload: GitHubDispatchWorkflowPayload,
  instanceId: string,
  step: WorkflowStep,
  env: Env
): Promise<void> {
  const active = activeWorkflowEnv(env);
  const expectedIdentity = await githubDispatchIdentity(
    active.GITHUB_CREDENTIAL_VERSION,
    Date.parse(payload.scheduledFor)
  );
  if (
    payload.credentialVersion !== active.GITHUB_CREDENTIAL_VERSION ||
    payload.dispatchId !== expectedIdentity.dispatchId ||
    payload.scheduledFor !== expectedIdentity.scheduledFor ||
    payload.utcDate !== expectedIdentity.utcDate ||
    instanceId !== expectedIdentity.instanceId
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const admissionDeadlineMs =
    Date.parse(payload.scheduledFor) + GITHUB_SYNC_SLOT_MS - 60_000;
  const existingStatus = await step.do("establish dispatch ledger", STEP_RETRY, () =>
    establishGitHubDispatch(active.MEMORY_DB, {
      dispatchId: payload.dispatchId,
      credentialVersion: payload.credentialVersion,
      workflowInstanceId: instanceId,
      scheduledFor: payload.scheduledFor,
      utcDate: payload.utcDate,
      createdAt: payload.scheduledFor
    })
  );
  if (existingStatus === "complete" || existingStatus === "failed") return;
  const priorUsage = await reconcilePriorDispatchStateWithUsage(
    step,
    active.MEMORY_DB,
    payload.scheduledFor,
    payload.credentialVersion
  );
  let lane: GitHubCredentialLaneToken | null = null;
  try {
    const materialized = await step.do(
      "check dispatch materialization receipt",
      STEP_RETRY,
      () => hasGitHubDispatchMaterializationReceipt(
        active.MEMORY_DB,
        payload.dispatchId
      )
    );
    if (!materialized) {
      const summary = await collectRepositoryAdmissionSummary(
        step,
        active.MEMORY_DB
      );
      assertGitHubDispatchAdmission(summary.inventory, priorUsage);
      const admission = await collectRepositoryAdmissionSnapshots(
        step,
        active.MEMORY_DB,
        summary
      );
      assertGitHubDispatchAdmission(admission.inventory, priorUsage);
      if (admission.allowedRepositoryIds.size > 0) {
        const acquiredLane = await acquireCredentialLane(
          step,
          active,
          "dispatch",
          payload.dispatchId,
          admissionDeadlineMs,
          { maxAttempts: GITHUB_DISPATCH_LANE_MAX_ATTEMPTS }
        );
        lane = acquiredLane;
        const dispatchStartedAtMs = await step.do(
          "establish dispatch execution start",
          () => Promise.resolve(Date.now())
        );
        const absoluteDeadlineMs = Math.min(
          admissionDeadlineMs,
          dispatchStartedAtMs + DISPATCH_EXECUTION_BUDGET_MS,
          Date.parse(acquiredLane.leaseUntil) - LANE_LEASE_SAFETY_MARGIN_MS
        );
        if (absoluteDeadlineMs <= dispatchStartedAtMs) {
          throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
        }
        try {
          await verifyApprovedAccessBaseline(
            step,
            active,
            payload,
            acquiredLane,
            admission.allowedRepositoryIds,
            absoluteDeadlineMs
          );
        } catch (error) {
          const baselineError = workflowSyncError(error);
          if (baselineError.code === "GITHUB_CREDENTIAL_EXPIRED") {
            await step.do("record invalid GitHub credential", STEP_RETRY, () =>
              recordInvalidCredentialObservation(
                active.MEMORY_DB,
                payload.credentialVersion,
                Date.parse(payload.scheduledFor)
              )
            );
          }
          await processRepositoryAdmissionSnapshots(
            step,
            active.MEMORY_DB,
            payload,
            admission.snapshots,
            baselineError
          );
          throw baselineError;
        }
      }
      await processRepositoryAdmissionSnapshots(
        step,
        active.MEMORY_DB,
        payload,
        admission.snapshots,
        null
      );
      const itemCount = await step.do(
        "count materialized dispatch items",
        STEP_RETRY,
        () => countDispatchItems(active.MEMORY_DB, payload.dispatchId)
      );
      await step.do("complete dispatch materialization", STEP_RETRY, () =>
        completeGitHubDispatchMaterialization(active.MEMORY_DB, {
          dispatchId: payload.dispatchId,
          itemCount,
          completedAt: payload.scheduledFor
        })
      );
    }
  } catch (error) {
    await failDispatchWorkflow(
      step,
      active.MEMORY_DB,
      payload.dispatchId,
      error,
      "materialization failure"
    );
    throw error;
  } finally {
    if (lane !== null) {
      await step.do("release dispatch credential lane", STEP_RETRY, () =>
        releaseGitHubCredentialLane(active.MEMORY_DB, lane as GitHubCredentialLaneToken)
      );
    }
  }

  try {
    let afterItemId = "";
    for (let page = 0; ; page += 1) {
      const batch = await step.do(`list dispatch batch ${page + 1}`, STEP_RETRY, () =>
        listDispatchItems(active.MEMORY_DB, payload.dispatchId, afterItemId)
      );
      if (batch.length === 0) break;
      const deadline =
        Date.parse(payload.scheduledFor) + GITHUB_SYNC_SLOT_MS - 60_000;
      await step.do(`start ref workflows ${page + 1}`, STEP_RETRY, () =>
        ensureGitHubRefWorkflowBatch(
          active.GITHUB_REF_SYNC_WORKFLOW as Workflow<GitHubRefSyncWorkflowPayload>,
          batch.map((item) => ({
            id: item.instanceId,
            params: {
              dispatchId: payload.dispatchId,
              itemId: item.itemId,
              credentialVersion: payload.credentialVersion,
              scheduledFor: payload.scheduledFor,
              absoluteDeadlineMs: deadline
            }
          }))
        )
      );
      afterItemId = batch.at(-1)?.itemId ?? afterItemId;
    }
    await step.do("complete dispatch", STEP_RETRY, () =>
      markGitHubDispatchStatus(active.MEMORY_DB, payload.dispatchId, "complete")
    );
  } catch (error) {
    await failDispatchWorkflow(
      step,
      active.MEMORY_DB,
      payload.dispatchId,
      error,
      "fanout failure"
    );
    throw error;
  }
}
