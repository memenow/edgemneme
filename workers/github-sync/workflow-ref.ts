import type { WorkflowStep } from "cloudflare:workers";
import { GitHubSyncError } from "../../src/github/client";
import { GITHUB_SYNC_SLOT_MS } from "../../src/github/sync-scheduling";
import {
  releaseGitHubCredentialLane,
  reserveGitHubRefRequest,
  type GitHubCredentialLaneToken
} from "../../src/github/sync-workflow";
import {
  MAX_GITHUB_REQUESTS_PER_REF,
  claimRepositorySync,
  failStagedManifestsForScheduledRef,
  finishRepositorySyncRun,
  recordSyncFailure,
  syncScheduledRef,
  type Env,
  type GitHubRefSyncWorkflowPayload,
  type ScheduledRefRow
} from "./index";
import {
  LANE_LEASE_SAFETY_MARGIN_MS,
  STEP_RETRY,
  SYNC_STEP,
  acquireCredentialLane,
  activeWorkflowEnv,
  createDurableWorkflowRequestPacer,
  finishDispatchItem,
  hasExactTerminalDispatchItem,
  readDispatchItemIdentity,
  rejectPendingDispatchItem,
  workflowSyncError,
  type SerializedSyncAttempt
} from "./workflow-runtime";
import {
  finishRejectedUnboundRepositoryRun
} from "./workflow-orphan";

const REF_EXECUTION_BUDGET_MS = 12 * 60 * 1_000;

interface DispatchItemRow extends ScheduledRefRow {
  item_id: string;
  dispatch_id: string;
  workflow_instance_id: string;
  full_reconciliation: number;
  item_status: "pending" | "running" | "complete" | "failed";
  run_id: string | null;
  scheduled_for: string;
}

interface RecoverableBoundRun {
  item_id: string;
  project_id: string;
  repository_id: string;
  ref: string;
  run_id: string;
  run_status: "running" | "complete" | "failed";
  run_completed_at: string | null;
  run_error_code: string | null;
  lease_expires_at: string;
  scheduled_for: string;
  original_cursor_version: number;
  current_cursor_version: number;
  cursor_status: string;
  cursor_last_sync_at: string | null;
  cursor_updated_at: string;
  cursor_error_code: string | null;
}

async function readDispatchItem(
  database: D1Database,
  payload: GitHubRefSyncWorkflowPayload,
  instanceId: string
): Promise<DispatchItemRow | null> {
  return database.withSession("first-primary").prepare(
    `SELECT item.item_id, item.dispatch_id, item.workflow_instance_id,
            item.full_reconciliation, item.status AS item_status, item.run_id,
            item.scheduled_for,
            repository.repository_id, repository.project_id,
            repository.external_id, repository.expected_owner_external_id,
            repository.owner, repository.name, repository.default_branch,
            repository.tracked_refs_json,
            repository.github_sync_configuration_version AS
              repository_configuration_version,
            repository.updated_at AS repository_updated_at,
            item.ref, cursor.status AS cursor_status,
            cursor.updated_at AS cursor_updated_at, cursor.cursor_version,
            item.selected_head_manifest_id, item.selected_head_version,
            cursor.last_sync_at
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = item.dispatch_id
     JOIN repositories AS repository
       ON repository.project_id = item.project_id
      AND repository.repository_id = item.repository_id
     JOIN sync_cursors AS cursor
       ON cursor.project_id = item.project_id
      AND cursor.repository_id = item.repository_id
      AND cursor.ref = item.ref
     LEFT JOIN github_tree_ref_heads AS head
       ON head.project_id = item.project_id
      AND head.repository_id = item.repository_id AND head.ref = item.ref
     WHERE item.item_id = ? AND item.dispatch_id = ?
       AND item.workflow_instance_id = ?
       AND item.scheduled_for = ?
       AND dispatch.credential_version = ?
       AND dispatch.status IN ('dispatching', 'complete')
       AND item.repository_configuration_version =
           repository.github_sync_configuration_version
       AND item.repository_updated_at = repository.updated_at
       AND item.cursor_status = cursor.status AND cursor.status <> 'paused'
       AND item.cursor_updated_at = cursor.updated_at
       AND item.cursor_version = cursor.cursor_version
       AND item.selected_head_manifest_id IS head.manifest_id
       AND item.selected_head_version = COALESCE(head.head_version, 0)
       AND lower(repository.provider) = 'github' AND repository.sync_enabled = 1`
  ).bind(
    payload.itemId,
    payload.dispatchId,
    instanceId,
    payload.scheduledFor,
    payload.credentialVersion
  ).first<DispatchItemRow>();
}

async function readRecoverableBoundRun(
  database: D1Database,
  payload: GitHubRefSyncWorkflowPayload,
  instanceId: string
): Promise<RecoverableBoundRun | null> {
  return database.withSession("first-primary").prepare(
    `SELECT item.item_id, item.project_id, item.repository_id, item.ref,
            run.run_id, run.status AS run_status,
            run.completed_at AS run_completed_at,
            run.last_error_code AS run_error_code, run.lease_expires_at,
            item.scheduled_for,
            item.cursor_version AS original_cursor_version,
            cursor.cursor_version AS current_cursor_version,
            cursor.status AS cursor_status,
            cursor.last_sync_at AS cursor_last_sync_at,
            cursor.updated_at AS cursor_updated_at,
            cursor.last_error_code AS cursor_error_code
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = item.dispatch_id
     JOIN github_repository_sync_runs AS run ON run.run_id = item.run_id
     JOIN sync_cursors AS cursor
       ON cursor.project_id = item.project_id
      AND cursor.repository_id = item.repository_id AND cursor.ref = item.ref
     WHERE item.item_id = ? AND item.dispatch_id = ?
       AND item.workflow_instance_id = ? AND item.scheduled_for = ?
       AND dispatch.credential_version = ? AND item.status = 'running'
       AND run.project_id = item.project_id
       AND run.repository_id = item.repository_id AND run.claimed_ref = item.ref
       AND run.scheduled_for = item.scheduled_for
       AND run.full_reconciliation = item.full_reconciliation
       AND run.repository_configuration_version =
           item.repository_configuration_version
       AND run.cursor_version = item.cursor_version
       AND run.claimed_head_manifest_id IS item.selected_head_manifest_id
       AND run.claimed_head_version = item.selected_head_version
       AND run.claim_contract_version = 1
     LIMIT 1`
  ).bind(
    payload.itemId,
    payload.dispatchId,
    instanceId,
    payload.scheduledFor,
    payload.credentialVersion
  ).first<RecoverableBoundRun>();
}

async function recoverBoundRunIfNeeded(
  database: D1Database,
  bound: RecoverableBoundRun
): Promise<boolean> {
  let status: "complete" | "failed";
  let errorCode: string | null;
  let completedAt: string;
  if (bound.run_status !== "running") {
    status = bound.run_status;
    errorCode = bound.run_error_code;
    if (bound.run_completed_at === null) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    completedAt = bound.run_completed_at;
  } else if (
    bound.current_cursor_version === bound.original_cursor_version + 1 &&
    bound.cursor_status === "complete" &&
    bound.cursor_last_sync_at === bound.scheduled_for &&
    bound.cursor_error_code === null
  ) {
    status = "complete";
    errorCode = null;
    completedAt = await finishRepositorySyncRun(
      database,
      bound.run_id,
      null,
      bound.cursor_updated_at
    );
  } else if (
    bound.current_cursor_version === bound.original_cursor_version + 1 &&
    bound.cursor_status === "failed" &&
    bound.cursor_error_code !== null
  ) {
    status = "failed";
    errorCode = bound.cursor_error_code;
    completedAt = await finishRepositorySyncRun(
      database,
      bound.run_id,
      errorCode,
      bound.cursor_updated_at
    );
  } else if (bound.lease_expires_at <= new Date().toISOString()) {
    status = "failed";
    errorCode = "GITHUB_RECONCILIATION_REQUIRED";
    completedAt = await finishRepositorySyncRun(database, bound.run_id, errorCode);
  } else {
    return false;
  }
  await finishDispatchItem(database, {
    item: bound,
    runId: bound.run_id,
    status,
    errorCode,
    completedAt
  });
  return true;
}

async function markDispatchItemRunning(
  database: D1Database,
  item: DispatchItemRow,
  runId: string
): Promise<void> {
  let result: D1Result;
  try {
    result = await database.withSession("first-primary").prepare(
      `UPDATE github_sync_dispatch_items SET status = 'running', run_id = ?
       WHERE item_id = ? AND status = 'pending' AND run_id IS NULL
         AND EXISTS (
           SELECT 1 FROM github_repository_sync_runs AS run
           WHERE run.run_id = ? AND run.project_id = ?
             AND run.repository_id = ? AND run.claimed_ref = ?
             AND run.scheduled_for = ? AND run.status = 'running'
             AND run.completed_at IS NULL
             AND run.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             AND run.full_reconciliation = ?
             AND run.repository_configuration_version = ?
             AND run.cursor_version = ?
             AND run.claimed_head_manifest_id IS ?
             AND run.claimed_head_version = ?
             AND run.claim_contract_version = 1
         )`
    ).bind(
      runId,
      item.item_id,
      runId,
      item.project_id,
      item.repository_id,
      item.ref,
      item.scheduled_for,
      item.full_reconciliation,
      item.repository_configuration_version,
      item.cursor_version,
      item.selected_head_manifest_id,
      item.selected_head_version
    ).run();
  } catch (error) {
    const exact = await database.withSession("first-primary").prepare(
      `SELECT 1 AS matches FROM github_sync_dispatch_items
       WHERE item_id = ? AND status = 'running' AND run_id = ?`
    ).bind(item.item_id, runId).first<{ matches: number }>();
    if (exact?.matches === 1) return;
    throw error;
  }
  if ((result.meta.changes ?? 0) === 1) return;
  const exact = await database.withSession("first-primary").prepare(
    `SELECT 1 AS matches FROM github_sync_dispatch_items
     WHERE item_id = ? AND status = 'running' AND run_id = ?`
  ).bind(item.item_id, runId).first<{ matches: number }>();
  if (exact?.matches !== 1) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
}

async function credentialStatus(
  database: D1Database,
  version: string
): Promise<"active" | "expiring"> {
  const state = await database.withSession("first-primary").prepare(
    `SELECT credential_status FROM github_credential_states
     WHERE credential_version = ?`
  ).bind(version).first<{ credential_status: string }>();
  return state?.credential_status === "expiring" ? "expiring" : "active";
}

async function hasExactSuccessfulRefOutcome(
  database: D1Database,
  item: DispatchItemRow,
  runId: string
): Promise<boolean> {
  const session = database.withSession("first-primary");
  const unchanged = await session.prepare(
    `SELECT 1 AS matches
     FROM github_repository_sync_runs AS run
     JOIN sync_cursors AS cursor
       ON cursor.project_id = run.project_id
      AND cursor.repository_id = run.repository_id
      AND cursor.ref = run.claimed_ref
     WHERE run.run_id = ? AND run.project_id = ? AND run.repository_id = ?
       AND run.claimed_ref = ? AND run.scheduled_for = ?
       AND run.cursor_version = ? AND run.status IN ('running', 'complete')
       AND cursor.cursor_version = run.cursor_version + 1
       AND cursor.status = 'complete' AND cursor.last_error_code IS NULL
       AND cursor.last_sync_at = run.scheduled_for
     LIMIT 1`
  ).bind(
    runId,
    item.project_id,
    item.repository_id,
    item.ref,
    item.scheduled_for,
    item.cursor_version
  ).first<{ matches: number }>();
  if (unchanged?.matches === 1) {
    return true;
  }
  const activated = await session.prepare(
    `SELECT 1 AS matches
     FROM github_tree_activation_receipts AS receipt
     JOIN github_repository_sync_runs AS run ON run.run_id = receipt.run_id
     JOIN sync_cursors AS cursor
       ON cursor.project_id = receipt.project_id
      AND cursor.repository_id = receipt.repository_id
      AND cursor.ref = receipt.ref
     JOIN github_tree_ref_heads AS head
       ON head.project_id = receipt.project_id
      AND head.repository_id = receipt.repository_id
      AND head.ref = receipt.ref
     WHERE receipt.run_id = ? AND receipt.project_id = ?
       AND receipt.repository_id = ? AND receipt.ref = ?
       AND receipt.scheduled_for = ?
       AND receipt.expected_cursor_version = ?
       AND receipt.expected_head_manifest_id IS ?
       AND receipt.expected_head_version = ?
       AND receipt.expected_repository_configuration_version = ?
       AND receipt.full_reconciliation = ?
       AND run.status = 'complete' AND run.last_error_code IS NULL
       AND run.completed_at = receipt.activated_at
       AND cursor.observed_sha = receipt.observed_sha
       AND cursor.status = 'observed'
       AND cursor.cursor_version = receipt.activated_cursor_version
       AND cursor.last_sync_at = receipt.scheduled_for
       AND cursor.last_error_code IS NULL
       AND head.manifest_id = receipt.manifest_id
       AND head.head_version = receipt.activated_head_version
     LIMIT 1`
  ).bind(
    runId,
    item.project_id,
    item.repository_id,
    item.ref,
    item.scheduled_for,
    item.cursor_version,
    item.selected_head_manifest_id,
    item.selected_head_version,
    item.repository_configuration_version,
    item.full_reconciliation
  ).first<{ matches: number }>();
  return activated?.matches === 1;
}

export async function runGitHubRefSyncWorkflow(
  payload: GitHubRefSyncWorkflowPayload,
  instanceId: string,
  step: WorkflowStep,
  env: Env
): Promise<void> {
  const active = activeWorkflowEnv(env);
  const expectedDeadline =
    Date.parse(payload.scheduledFor) + GITHUB_SYNC_SLOT_MS - 60_000;
  if (
    payload.credentialVersion !== active.GITHUB_CREDENTIAL_VERSION ||
    instanceId !== `ghr-${payload.itemId}` ||
    payload.absoluteDeadlineMs !== expectedDeadline
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const terminal = await step.do("check terminal dispatch item", STEP_RETRY, () =>
    hasExactTerminalDispatchItem(active.MEMORY_DB, payload, instanceId)
  );
  if (terminal) {
    return;
  }
  const identity = await step.do("validate dispatch item identity", STEP_RETRY, () =>
    readDispatchItemIdentity(active.MEMORY_DB, payload, instanceId)
  );
  if (identity === null) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  if (identity.status === "complete" || identity.status === "failed") {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const bound = await step.do("recover bound repository run", STEP_RETRY, () =>
    readRecoverableBoundRun(active.MEMORY_DB, payload, instanceId)
  );
  if (
    bound !== null &&
    (await step.do("reconcile bound repository run", STEP_RETRY, () =>
      recoverBoundRunIfNeeded(active.MEMORY_DB, bound)
    ))
  ) {
    return;
  }
  const item = await step.do("validate dispatch item", STEP_RETRY, () =>
    readDispatchItem(active.MEMORY_DB, payload, instanceId)
  );
  if (item === null) {
    if (identity.status === "pending" && identity.run_id === null) {
      const rejectedAt = await step.do("establish stale item rejection time", () =>
        Promise.resolve(new Date().toISOString())
      );
      await step.do("reject stale dispatch item", STEP_RETRY, () =>
        rejectPendingDispatchItem(
          active.MEMORY_DB,
          identity,
          "GITHUB_RECONCILIATION_REQUIRED",
          rejectedAt
        )
      );
      return;
    }
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  if (item.item_status === "complete" || item.item_status === "failed") {
    return;
  }
  let lane: GitHubCredentialLaneToken;
  try {
    lane = await acquireCredentialLane(
      step,
      active,
      "ref",
      item.item_id,
      payload.absoluteDeadlineMs
    );
  } catch (error) {
    const admissionError = workflowSyncError(error);
    const failedAt = await step.do("establish lane admission failure time", () =>
      Promise.resolve(new Date().toISOString())
    );
    if (item.item_status === "pending" && item.run_id === null) {
      await step.do("reject lane admission dispatch item", STEP_RETRY, () =>
        rejectPendingDispatchItem(
          active.MEMORY_DB,
          identity,
          admissionError.code,
          failedAt
        )
      );
      return;
    }
    if (item.run_id !== null) {
      await step.do("record lane admission run failure", STEP_RETRY, () =>
        recordSyncFailure(
          active.MEMORY_DB,
          item,
          item.ref,
          admissionError,
          Date.parse(item.scheduled_for),
          "active",
          item,
          item.run_id
        )
      );
      const completedAt = await step.do(
        "finish lane admission repository run",
        STEP_RETRY,
        () => finishRepositorySyncRun(
          active.MEMORY_DB,
          item.run_id as string,
          admissionError.code,
          failedAt
        )
      );
      await step.do("finish lane admission dispatch item", STEP_RETRY, () =>
        finishDispatchItem(active.MEMORY_DB, {
          item,
          runId: item.run_id as string,
          status: "failed",
          errorCode: admissionError.code,
          completedAt
        })
      );
      return;
    }
    throw admissionError;
  }
  try {
    const startedAtMs = await step.do("establish ref execution start", () =>
      Promise.resolve(Date.now())
    );
    const absoluteDeadlineMs = Math.min(
      payload.absoluteDeadlineMs,
      startedAtMs + REF_EXECUTION_BUDGET_MS,
      Date.parse(lane.leaseUntil) - LANE_LEASE_SAFETY_MARGIN_MS
    );
    if (absoluteDeadlineMs <= startedAtMs) {
      const rejectedAt = await step.do("establish expired lane rejection time", () =>
        Promise.resolve(new Date().toISOString())
      );
      if (item.item_status === "pending" && item.run_id === null) {
        await step.do("reject expired lane dispatch item", STEP_RETRY, () =>
          rejectPendingDispatchItem(
            active.MEMORY_DB,
            identity,
            "GITHUB_PARTIAL_SYNC",
            rejectedAt
          )
        );
      } else {
        const existingRunId = bound?.run_id ?? item.run_id;
        if (existingRunId === null) {
          throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
        }
        await step.do("record expired lane run failure", STEP_RETRY, () =>
          recordSyncFailure(
            active.MEMORY_DB,
            item,
            item.ref,
            new GitHubSyncError("GITHUB_PARTIAL_SYNC"),
            Date.parse(item.scheduled_for),
            "active",
            item,
            existingRunId
          )
        );
        const completedAt = await step.do(
          "finish expired lane repository run",
          STEP_RETRY,
          () => finishRepositorySyncRun(
            active.MEMORY_DB,
            existingRunId,
            "GITHUB_PARTIAL_SYNC",
            rejectedAt
          )
        );
        await step.do("finish expired lane dispatch item", STEP_RETRY, () =>
          finishDispatchItem(active.MEMORY_DB, {
            item,
            runId: existingRunId,
            status: "failed",
            errorCode: "GITHUB_PARTIAL_SYNC",
            completedAt
          })
        );
      }
      return;
    }
    let runId =
      bound?.run_id ??
      (await step.do("claim repository ref run", STEP_RETRY, () =>
        claimRepositorySync(
          active.MEMORY_DB,
          item,
          Date.parse(item.scheduled_for),
          item.full_reconciliation === 1,
          startedAtMs
        )
      ));
    if (runId === null) {
      const recoveredAt = await step.do("establish orphan recovery time", () =>
        Promise.resolve(new Date().toISOString())
      );
      await step.do(
        "finish rejected unbound repository run",
        STEP_RETRY,
        () => finishRejectedUnboundRepositoryRun(
          active.MEMORY_DB,
          item,
          null,
          recoveredAt
        )
      );
      runId = await step.do("retry repository ref claim", STEP_RETRY, () =>
        claimRepositorySync(
          active.MEMORY_DB,
          item,
          Date.parse(item.scheduled_for),
          item.full_reconciliation === 1,
          startedAtMs
        )
      );
    }
    if (runId === null) {
      const rejectedAt = await step.do("establish claim rejection time", () =>
        Promise.resolve(new Date().toISOString())
      );
      await step.do("reject unclaimable dispatch item", STEP_RETRY, () =>
        rejectPendingDispatchItem(
          active.MEMORY_DB,
          identity,
          "GITHUB_RECONCILIATION_REQUIRED",
          rejectedAt
        )
      );
      return;
    }
    if (item.item_status === "pending") {
      try {
        await step.do("bind dispatch item to run", STEP_RETRY, () =>
          markDispatchItemRunning(active.MEMORY_DB, item, runId)
        );
      } catch {
        const rejectedAt = await step.do("establish bind rejection time", () =>
          Promise.resolve(new Date().toISOString())
        );
        await step.do("reject unbindable dispatch item", STEP_RETRY, () =>
          rejectPendingDispatchItem(
            active.MEMORY_DB,
            identity,
            "GITHUB_RECONCILIATION_REQUIRED",
            rejectedAt
          )
        );
        await step.do("finish unbindable repository run", STEP_RETRY, () =>
          finishRejectedUnboundRepositoryRun(
            active.MEMORY_DB,
            item,
            runId,
            rejectedAt
          )
        );
        return;
      }
    } else if (item.run_id !== runId) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    const pacer = createDurableWorkflowRequestPacer({
      reserve: () =>
        reserveGitHubRefRequest(
          active.MEMORY_DB,
          item.item_id,
          lane,
          MAX_GITHUB_REQUESTS_PER_REF
        )
    });
    const currentCredentialStatus = await step.do(
      "read ref credential status",
      STEP_RETRY,
      () => credentialStatus(active.MEMORY_DB, payload.credentialVersion)
    );
    let syncError: GitHubSyncError | null = null;
    try {
      let synchronized = false;
      for (let attempt = 0; attempt < 3 && !synchronized; attempt += 1) {
        const outcome = await step.do(
          `synchronize repository ref ${attempt + 1}`,
          SYNC_STEP,
          async (): Promise<SerializedSyncAttempt> => {
            try {
              if (Date.now() >= absoluteDeadlineMs) {
                throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
              }
              if (
                await hasExactSuccessfulRefOutcome(active.MEMORY_DB, item, runId)
              ) {
                return { ok: true };
              }
              await syncScheduledRef(
                item,
                active,
                Date.parse(item.scheduled_for),
                item.full_reconciliation === 1,
                currentCredentialStatus,
                pacer,
                runId,
                absoluteDeadlineMs
              );
              return { ok: true };
            } catch (error) {
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
          }
        );
        if (outcome.ok) {
          synchronized = true;
          continue;
        }
        const attemptError = new GitHubSyncError(
          outcome.code ?? "GITHUB_RECONCILIATION_REQUIRED",
          {
            retryable: outcome.retryable ?? false,
            ...(outcome.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: outcome.retryAfterMs }),
            ...(outcome.rateLimit === undefined
              ? {}
              : { rateLimit: outcome.rateLimit })
          }
        );
        if (!attemptError.retryable || attempt === 2) {
          throw attemptError;
        }
        const now = await step.do(`observe retry clock ${attempt + 1}`, () =>
          Promise.resolve(Date.now())
        );
        const delay = Math.max(
          1,
          attemptError.retryAfterMs ?? Math.min(60_000, 1_000 * 2 ** attempt)
        );
        if (now + delay >= absoluteDeadlineMs) {
          throw attemptError;
        }
        await step.sleep(`wait for GitHub retry ${attempt + 1}`, delay);
      }
    } catch (error) {
      syncError = workflowSyncError(error);
      await step.do("fail terminal staged manifests", STEP_RETRY, () =>
        failStagedManifestsForScheduledRef(
          active.MEMORY_DB,
          item,
          Date.parse(item.scheduled_for),
          (syncError as GitHubSyncError).code
        )
      );
      await step.do("record repository ref failure", STEP_RETRY, () =>
        recordSyncFailure(
          active.MEMORY_DB,
          item,
          item.ref,
          syncError as GitHubSyncError,
          Date.parse(item.scheduled_for),
          currentCredentialStatus,
          item,
          runId
        )
      );
    }
    const completedAt = await step.do("finish repository ref run", STEP_RETRY, () =>
      finishRepositorySyncRun(active.MEMORY_DB, runId, syncError?.code ?? null)
    );
    await step.do("record repository ref finish receipt", STEP_RETRY, () =>
      finishDispatchItem(active.MEMORY_DB, {
        item,
        runId,
        status: syncError === null ? "complete" : "failed",
        errorCode: syncError?.code ?? null,
        completedAt
      })
    );
  } finally {
    await step.do("release ref credential lane", STEP_RETRY, () =>
      releaseGitHubCredentialLane(active.MEMORY_DB, lane)
    );
  }
}
