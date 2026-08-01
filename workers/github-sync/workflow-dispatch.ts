import type { WorkflowStep } from "cloudflare:workers";
import {
  GitHubReadOnlyClient,
  GitHubSyncError
} from "../../src/github/client";
import {
  chunkWorkflowBatch,
  GITHUB_SYNC_SLOT_MS,
  githubDispatchIdentity,
  githubRefWorkflowIdentity
} from "../../src/github/sync-scheduling";
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
  materializeAndSelectScheduledRefs,
  parseTrackedRefs,
  recordInvalidCredentialObservation,
  recordSyncFailure,
  requiresFullReconciliation,
  type ActiveGitHubSyncEnv,
  type ConfiguredRefRow,
  type Env,
  type GitHubDispatchWorkflowPayload,
  type GitHubRefSyncWorkflowPayload,
  type RepositoryRow,
  type ScheduledRefRow
} from "./index";
import {
  LANE_LEASE_SAFETY_MARGIN_MS,
  STEP_RETRY,
  SYNC_STEP,
  acquireCredentialLane,
  activeWorkflowEnv,
  createDurableWorkflowRequestPacer,
  failDispatchWorkflow,
  reconcilePriorDispatchState,
  workflowSyncError,
  type SerializedSyncAttempt
} from "./workflow-runtime";

const DISPATCH_EXECUTION_BUDGET_MS = 12 * 60 * 1_000;
const REPOSITORY_ID_PAGE_SIZE = 16;
const REPOSITORY_PROCESS_PAGE_SIZE = 16;
const REPOSITORY_FAILURE_PAGE_SIZE = 1;

interface PersistedDispatchItem {
  itemId: string;
  workflowInstanceId: string;
  selected: ScheduledRefRow;
  fullReconciliation: boolean;
}
interface RepositoryPageCursor {
  afterProjectId: string;
  afterRepositoryId: string;
  hasMore: boolean;
}

interface EligibleRepositoryIdPage extends RepositoryPageCursor {
  repositoryIds: number[];
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

async function configuredRefsForRepository(
  database: D1Database,
  repository: RepositoryRow,
  scheduledTime: number
): Promise<ConfiguredRefRow[] | null> {
  if (
    !Number.isSafeInteger(repository.expected_owner_external_id) ||
    (repository.expected_owner_external_id ?? 0) <= 0 ||
    repository.default_branch === null
  ) {
    await recordSyncFailure(
      database,
      repository,
      "refs/heads/unknown",
      new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE"),
      scheduledTime
    );
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
  } catch (error) {
    await recordSyncFailure(
      database,
      repository,
      "refs/heads/unknown",
      error instanceof GitHubSyncError
        ? error
        : new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE"),
      scheduledTime
    );
    return null;
  }
}

async function loadEligibleRepositoryIdPage(
  database: D1Database,
  scheduledTime: number,
  afterProjectId: string,
  afterRepositoryId: string
): Promise<EligibleRepositoryIdPage> {
  const repositories = await loadRepositoryPage(
    database,
    afterProjectId,
    afterRepositoryId,
    REPOSITORY_ID_PAGE_SIZE
  );
  const repositoryIds: number[] = [];
  for (const repository of repositories) {
    const refs = await configuredRefsForRepository(
      database,
      repository,
      scheduledTime
    );
    if (refs !== null) {
      repositoryIds.push(repository.external_id);
    }
  }
  const last = repositories.at(-1);
  return {
    repositoryIds,
    afterProjectId: last?.project_id ?? afterProjectId,
    afterRepositoryId: last?.repository_id ?? afterRepositoryId,
    hasMore: repositories.length === REPOSITORY_ID_PAGE_SIZE
  };
}

async function processRepositoryPage(
  database: D1Database,
  payload: GitHubDispatchWorkflowPayload,
  allowedRepositoryIds: ReadonlySet<number>,
  afterProjectId: string,
  afterRepositoryId: string,
  baselineError: GitHubSyncError | null
): Promise<RepositoryPageCursor> {
  const scheduledTime = Date.parse(payload.scheduledFor);
  const repositories = await loadRepositoryPage(
    database,
    afterProjectId,
    afterRepositoryId,
    baselineError === null
      ? REPOSITORY_PROCESS_PAGE_SIZE
      : REPOSITORY_FAILURE_PAGE_SIZE
  );
  for (const repository of repositories) {
    if (!allowedRepositoryIds.has(repository.external_id)) continue;
    const configuredRefs = await configuredRefsForRepository(
      database,
      repository,
      scheduledTime
    );
    if (configuredRefs === null) continue;
    for (const configuredBatch of chunkWorkflowBatch(configuredRefs, 100)) {
      const selected = await materializeAndSelectScheduledRefs(
        database,
        configuredBatch,
        scheduledTime
      );
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
  const last = repositories.at(-1);
  return {
    afterProjectId: last?.project_id ?? afterProjectId,
    afterRepositoryId: last?.repository_id ?? afterRepositoryId,
    hasMore: repositories.length === (
      baselineError === null
        ? REPOSITORY_PROCESS_PAGE_SIZE
        : REPOSITORY_FAILURE_PAGE_SIZE
    )
  };
}

async function collectEligibleRepositoryIds(
  step: WorkflowStep,
  database: D1Database,
  scheduledTime: number
): Promise<Set<number>> {
  const repositoryIds = new Set<number>();
  let afterProjectId = "";
  let afterRepositoryId = "";
  for (let page = 0; ; page += 1) {
    const result = await step.do(
      `load eligible GitHub repository ids ${page + 1}`,
      STEP_RETRY,
      () => loadEligibleRepositoryIdPage(
        database,
        scheduledTime,
        afterProjectId,
        afterRepositoryId
      )
    );
    for (const repositoryId of result.repositoryIds) {
      repositoryIds.add(repositoryId);
    }
    afterProjectId = result.afterProjectId;
    afterRepositoryId = result.afterRepositoryId;
    if (!result.hasMore) break;
  }
  return repositoryIds;
}

async function processEligibleRepositories(
  step: WorkflowStep,
  database: D1Database,
  payload: GitHubDispatchWorkflowPayload,
  allowedRepositoryIds: ReadonlySet<number>,
  baselineError: GitHubSyncError | null
): Promise<void> {
  let afterProjectId = "";
  let afterRepositoryId = "";
  for (let page = 0; ; page += 1) {
    const result = await step.do(
      `${baselineError === null ? "materialize" : "record baseline failure for"} GitHub repository page ${page + 1}`,
      STEP_RETRY,
      () => processRepositoryPage(
        database,
        payload,
        allowedRepositoryIds,
        afterProjectId,
        afterRepositoryId,
        baselineError
      )
    );
    afterProjectId = result.afterProjectId;
    afterRepositoryId = result.afterRepositoryId;
    if (!result.hasMore) break;
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

async function persistDispatchItems(
  database: D1Database,
  payload: GitHubDispatchWorkflowPayload,
  selectedRefs: ScheduledRefRow[]
): Promise<number> {
  const items: PersistedDispatchItem[] = [];
  for (const selected of selectedRefs) {
    const fullReconciliation = requiresFullReconciliation(
      Date.parse(payload.scheduledFor),
      selected.last_sync_at
    );
    const identity = await githubRefWorkflowIdentity({
      dispatchId: payload.dispatchId,
      projectId: selected.project_id,
      repositoryId: selected.repository_id,
      ref: selected.ref,
      scheduledFor: payload.scheduledFor,
      fullReconciliation
    });
    items.push({
      itemId: identity.itemId,
      workflowInstanceId: identity.instanceId,
      selected,
      fullReconciliation
    });
  }
  const session = database.withSession("first-primary");
  for (const batch of chunkWorkflowBatch(items, 100)) {
    const serialized = JSON.stringify(
      batch.map((item) => ({
        item_id: item.itemId,
        dispatch_id: payload.dispatchId,
        project_id: item.selected.project_id,
        repository_id: item.selected.repository_id,
        ref: item.selected.ref,
        scheduled_for: payload.scheduledFor,
        full_reconciliation: item.fullReconciliation ? 1 : 0,
        repository_configuration_version:
          item.selected.repository_configuration_version,
        cursor_version: item.selected.cursor_version,
        selected_head_manifest_id: item.selected.selected_head_manifest_id,
        selected_head_version: item.selected.selected_head_version,
        repository_updated_at: item.selected.repository_updated_at,
        cursor_status: item.selected.cursor_status,
        cursor_updated_at: item.selected.cursor_updated_at,
        workflow_instance_id: item.workflowInstanceId,
        created_at: payload.scheduledFor
      }))
    );
    await session.prepare(
      `INSERT INTO github_sync_dispatch_items
       (item_id, dispatch_id, project_id, repository_id, ref, scheduled_for,
        full_reconciliation, repository_configuration_version, cursor_version,
        selected_head_manifest_id, selected_head_version, repository_updated_at,
        cursor_status, cursor_updated_at, workflow_instance_id, status, created_at)
       SELECT json_extract(value, '$.item_id'),
              json_extract(value, '$.dispatch_id'),
              json_extract(value, '$.project_id'),
              json_extract(value, '$.repository_id'),
              json_extract(value, '$.ref'),
              json_extract(value, '$.scheduled_for'),
              json_extract(value, '$.full_reconciliation'),
              json_extract(value, '$.repository_configuration_version'),
              json_extract(value, '$.cursor_version'),
              json_extract(value, '$.selected_head_manifest_id'),
              json_extract(value, '$.selected_head_version'),
              json_extract(value, '$.repository_updated_at'),
              json_extract(value, '$.cursor_status'),
              json_extract(value, '$.cursor_updated_at'),
              json_extract(value, '$.workflow_instance_id'), 'pending',
              json_extract(value, '$.created_at')
       FROM json_each(?) WHERE 1
       ON CONFLICT(item_id) DO NOTHING`
    ).bind(serialized).run();
    const mismatch = await session.prepare(
      `WITH expected AS (SELECT value FROM json_each(?))
       SELECT COUNT(*) AS mismatch_count
       FROM expected
       LEFT JOIN github_sync_dispatch_items AS item
         ON item.item_id = json_extract(expected.value, '$.item_id')
       WHERE item.item_id IS NULL
          OR item.dispatch_id <> json_extract(expected.value, '$.dispatch_id')
          OR item.project_id <> json_extract(expected.value, '$.project_id')
          OR item.repository_id <> json_extract(expected.value, '$.repository_id')
          OR item.ref <> json_extract(expected.value, '$.ref')
          OR item.scheduled_for <> json_extract(expected.value, '$.scheduled_for')
          OR item.full_reconciliation <> json_extract(expected.value, '$.full_reconciliation')
          OR item.repository_configuration_version <>
             json_extract(expected.value, '$.repository_configuration_version')
          OR item.cursor_version <> json_extract(expected.value, '$.cursor_version')
          OR item.selected_head_manifest_id IS NOT
             json_extract(expected.value, '$.selected_head_manifest_id')
          OR item.selected_head_version <>
             json_extract(expected.value, '$.selected_head_version')
          OR item.repository_updated_at <>
             json_extract(expected.value, '$.repository_updated_at')
          OR item.cursor_status <> json_extract(expected.value, '$.cursor_status')
          OR item.cursor_updated_at <> json_extract(expected.value, '$.cursor_updated_at')
          OR item.workflow_instance_id <>
             json_extract(expected.value, '$.workflow_instance_id')`
    ).bind(serialized).first<{ mismatch_count: number }>();
    if (mismatch?.mismatch_count !== 0) {
      throw new Error("GitHub dispatch items conflict with stored state.");
    }
  }
  return items.length;
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
  return rows.results.map((row) => ({
    itemId: row.item_id,
    instanceId: row.workflow_instance_id
  }));
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
  await reconcilePriorDispatchState(
    step,
    active.MEMORY_DB,
    payload.scheduledFor,
    payload.credentialVersion
  );
  let lane: GitHubCredentialLaneToken | null = null;
  try {
    lane = await acquireCredentialLane(
      step,
      active,
      "dispatch",
      payload.dispatchId,
      admissionDeadlineMs
    );
    const dispatchStartedAtMs = await step.do(
      "establish dispatch execution start",
      () => Promise.resolve(Date.now())
    );
    const absoluteDeadlineMs = Math.min(
      admissionDeadlineMs,
      dispatchStartedAtMs + DISPATCH_EXECUTION_BUDGET_MS,
      Date.parse(lane.leaseUntil) - LANE_LEASE_SAFETY_MARGIN_MS
    );
    if (absoluteDeadlineMs <= dispatchStartedAtMs) {
      throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
    }
    const materialized = await step.do(
      "check dispatch materialization receipt",
      STEP_RETRY,
      () => hasGitHubDispatchMaterializationReceipt(
        active.MEMORY_DB,
        payload.dispatchId
      )
    );
    if (!materialized) {
      const allowedRepositoryIds = await collectEligibleRepositoryIds(
        step,
        active.MEMORY_DB,
        Date.parse(payload.scheduledFor)
      );
      if (allowedRepositoryIds.size === 0) {
        await step.do("complete empty dispatch materialization", STEP_RETRY, () =>
          completeGitHubDispatchMaterialization(active.MEMORY_DB, {
            dispatchId: payload.dispatchId,
            itemCount: 0,
            completedAt: payload.scheduledFor
          })
        );
      } else {
        try {
          await verifyApprovedAccessBaseline(
            step,
            active,
            payload,
            lane,
            allowedRepositoryIds,
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
          await processEligibleRepositories(
            step,
            active.MEMORY_DB,
            payload,
            allowedRepositoryIds,
            baselineError
          );
          throw baselineError;
        }
        await processEligibleRepositories(
          step,
          active.MEMORY_DB,
          payload,
          allowedRepositoryIds,
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
