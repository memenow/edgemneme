import type { WorkflowStep } from "cloudflare:workers";
import {
  createGitHubRequestPacer,
  GITHUB_SYNC_ERROR_CODES,
  GitHubSyncError,
  type GitHubRequestPacer,
  type GitHubRateLimit,
  type GitHubSyncErrorCode
} from "../../src/github/client";
import { deterministicLaneWaitMs } from "../../src/github/sync-scheduling";
import {
  credentialLaneClaimId,
  markGitHubDispatchStatus,
  tryAcquireGitHubCredentialLane,
  type GitHubCredentialLaneToken
} from "../../src/github/sync-workflow";
import { sha256 } from "../../src/security/crypto";
import {
  finishRepositorySyncRun,
  requireActiveGitHubSyncEnv,
  type ActiveGitHubSyncEnv,
  type Env,
  type GitHubRefSyncWorkflowPayload
} from "./index";
import {
  finishRejectedUnboundRepositoryRun,
  type OrphanRecoveryItem
} from "./workflow-orphan";

export const STEP_RETRY = {
  retries: { limit: 2, delay: "1 second", backoff: "exponential" },
  timeout: "15 minutes"
} as const;
export const SYNC_STEP = {
  retries: { limit: 0, delay: "1 second", backoff: "constant" },
  timeout: "13 minutes"
} as const;
export const LANE_LEASE_SAFETY_MARGIN_MS = 5_000;
export const MAX_PRIOR_RECONCILIATION_PAGES = 64;
export const MAX_PRIOR_RECONCILIATION_SUBREQUESTS = 7_200;
export const MAX_LIST_RECONCILIATION_SUBREQUESTS = 3;
export const MAX_PENDING_RECONCILIATION_SUBREQUESTS_PER_ROW = 9;
export const MAX_ORPHAN_RECONCILIATION_SUBREQUESTS_PER_ROW = 6;
export const MAX_RUNNING_RECONCILIATION_SUBREQUESTS_PER_ROW = 54;
export const MAX_DISPATCH_RECONCILIATION_SUBREQUESTS_PER_ROW = 6;
export const MAX_RUNNING_RECONCILIATION_ROWS = 40;
// D1 query quota counts both statements in finishDispatchItem's batch.
export const MAX_RUNNING_RECONCILIATION_QUERIES_PER_INVOCATION_ROW = 21;
const GITHUB_SYNC_ERROR_CODE_SET = new Set<string>(GITHUB_SYNC_ERROR_CODES);

export function createPriorReconciliationBudget(): {
  reservePage(): void;
  reserveSubrequests(count: number): void;
  readonly pageCount: number;
  readonly subrequestCount: number;
} {
  let pages = 0;
  let subrequests = 0;
  return {
    reservePage(): void {
      if (
        pages >= MAX_PRIOR_RECONCILIATION_PAGES ||
        subrequests + MAX_LIST_RECONCILIATION_SUBREQUESTS >
          MAX_PRIOR_RECONCILIATION_SUBREQUESTS
      ) {
        throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
      }
      pages += 1;
      subrequests += MAX_LIST_RECONCILIATION_SUBREQUESTS;
    },
    reserveSubrequests(count: number): void {
      if (
        count < 0 ||
        subrequests + count > MAX_PRIOR_RECONCILIATION_SUBREQUESTS
      ) {
        throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
      }
      subrequests += count;
    },
    get pageCount(): number {
      return pages;
    },
    get subrequestCount(): number {
      return subrequests;
    }
  };
}

export interface SerializedSyncAttempt {
  ok: boolean;
  code?: GitHubSyncErrorCode;
  retryable?: boolean;
  retryAfterMs?: number;
  rateLimit?: GitHubRateLimit;
}

export function workflowSyncError(error: unknown): GitHubSyncError {
  if (error instanceof GitHubSyncError) return error;
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : "";
  return GITHUB_SYNC_ERROR_CODE_SET.has(message)
    ? new GitHubSyncError(message as GitHubSyncErrorCode)
    : new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
}

export interface DispatchItemIdentityRow {
  item_id: string;
  dispatch_id: string;
  credential_version: string;
  project_id: string;
  repository_id: string;
  ref: string;
  status: "pending" | "running" | "complete" | "failed";
  run_id: string | null;
}

interface PriorRunningDispatchItem extends DispatchItemIdentityRow {
  scheduled_for: string;
  run_status: "running" | "complete" | "failed";
  run_completed_at: string | null;
  run_error_code: string | null;
  lease_expires_at: string;
}

interface PriorUnboundRepositoryRun extends OrphanRecoveryItem {
  run_id: string;
}

export interface DispatchItemReceiptIdentity {
  item_id: string;
  project_id: string;
  repository_id: string;
  ref: string;
}

export function activeWorkflowEnv(env: Env): ActiveGitHubSyncEnv {
  const active = requireActiveGitHubSyncEnv(env);
  if (active === null) {
    throw new Error("GitHub sync was disabled after Workflow admission.");
  }
  if (active.GITHUB_REF_SYNC_WORKFLOW === undefined) {
    throw new Error("The GitHub ref sync Workflow binding is unavailable.");
  }
  return active;
}

export async function acquireCredentialLane(
  step: WorkflowStep,
  env: ActiveGitHubSyncEnv,
  holderKind: "dispatch" | "ref",
  holderId: string,
  absoluteDeadlineMs: number
): Promise<GitHubCredentialLaneToken> {
  const claimId = await credentialLaneClaimId({
    credentialVersion: env.GITHUB_CREDENTIAL_VERSION,
    holderKind,
    holderId
  });
  for (let attempt = 0; attempt < 1_024; attempt += 1) {
    const claimNowMs = await step.do(
      `establish credential lane clock ${attempt + 1}`,
      () => Promise.resolve(Date.now())
    );
    const claim = await step.do(
      `acquire credential lane ${attempt + 1}`,
      STEP_RETRY,
      () =>
        tryAcquireGitHubCredentialLane(env.MEMORY_DB, {
          credentialVersion: env.GITHUB_CREDENTIAL_VERSION,
          holderKind,
          holderId,
          claimId,
          nowMs: claimNowMs
        })
    );
    if (claim.acquired) {
      return claim.token;
    }
    const now = claimNowMs;
    if (now >= absoluteDeadlineMs) {
      throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
    }
    const boundary = Math.max(
      Date.parse(claim.availableAfter),
      claim.leaseUntil === null ? now : Date.parse(claim.leaseUntil)
    );
    const delay = Number.isFinite(boundary)
      ? Math.min(
          deterministicLaneWaitMs(holderId, attempt),
          Math.max(1, boundary - now)
        )
      : deterministicLaneWaitMs(holderId, attempt);
    await step.sleep(
      `wait for credential lane ${attempt + 1}`,
      Math.max(1, Math.min(delay, absoluteDeadlineMs - now))
    );
  }
  throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
}

export function createDurableWorkflowRequestPacer(input: {
  reserve(): Promise<number | null>;
}): GitHubRequestPacer {
  let reservedRequests = 0;
  const interval = createGitHubRequestPacer({ minimumIntervalMs: 80 });
  return {
    async wait(): Promise<void> {
      await interval.wait();
      if (reservedRequests === 0) {
        const reserved = await input.reserve();
        if (reserved === null) {
          throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
        }
        reservedRequests = reserved;
      }
      reservedRequests -= 1;
    }
  };
}

export async function readDispatchItemIdentity(
  database: D1Database,
  payload: GitHubRefSyncWorkflowPayload,
  instanceId: string
): Promise<DispatchItemIdentityRow | null> {
  return database.withSession("first-primary").prepare(
    `SELECT item.item_id, item.dispatch_id, dispatch.credential_version,
            item.project_id, item.repository_id, item.ref, item.status, item.run_id
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = item.dispatch_id
     WHERE item.item_id = ? AND item.dispatch_id = ?
       AND item.workflow_instance_id = ? AND item.scheduled_for = ?
       AND dispatch.credential_version = ?
       AND dispatch.status IN ('dispatching', 'complete')
     LIMIT 1`
  ).bind(
    payload.itemId,
    payload.dispatchId,
    instanceId,
    payload.scheduledFor,
    payload.credentialVersion
  ).first<DispatchItemIdentityRow>();
}

export async function hasExactTerminalDispatchItem(
  database: D1Database,
  payload: GitHubRefSyncWorkflowPayload,
  instanceId: string
): Promise<boolean> {
  const exact = await database.withSession("first-primary").prepare(
    `SELECT 1 AS matches
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = item.dispatch_id
     JOIN github_repository_sync_finish_receipts AS receipt
       ON receipt.dispatch_item_id = item.item_id AND receipt.run_id = item.run_id
     JOIN github_repository_sync_runs AS run ON run.run_id = item.run_id
     WHERE item.item_id = ? AND item.dispatch_id = ?
       AND item.workflow_instance_id = ? AND item.scheduled_for = ?
       AND dispatch.credential_version = ?
       AND item.status IN ('complete', 'failed')
       AND receipt.project_id = item.project_id
       AND receipt.repository_id = item.repository_id AND receipt.ref = item.ref
       AND receipt.status = item.status
       AND receipt.last_error_code IS item.last_error_code
       AND receipt.completed_at = item.completed_at
       AND run.status = item.status
       AND run.last_error_code IS item.last_error_code
       AND run.completed_at = item.completed_at
     LIMIT 1`
  ).bind(
    payload.itemId,
    payload.dispatchId,
    instanceId,
    payload.scheduledFor,
    payload.credentialVersion
  ).first<{ matches: number }>();
  if (exact?.matches === 1) {
    return true;
  }
  const rejected = await database.withSession("first-primary").prepare(
    `SELECT 1 AS matches
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = item.dispatch_id
     JOIN github_sync_dispatch_item_rejection_receipts AS receipt
       ON receipt.dispatch_item_id = item.item_id
     WHERE item.item_id = ? AND item.dispatch_id = ?
       AND item.workflow_instance_id = ? AND item.scheduled_for = ?
       AND dispatch.credential_version = ?
       AND item.status = 'failed' AND item.run_id IS NULL
       AND receipt.dispatch_id = item.dispatch_id
       AND receipt.credential_version = dispatch.credential_version
       AND receipt.project_id = item.project_id
       AND receipt.repository_id = item.repository_id
       AND receipt.ref = item.ref
       AND receipt.last_error_code = item.last_error_code
       AND receipt.completed_at = item.completed_at
     LIMIT 1`
  ).bind(
    payload.itemId,
    payload.dispatchId,
    instanceId,
    payload.scheduledFor,
    payload.credentialVersion
  ).first<{ matches: number }>();
  return rejected?.matches === 1;
}

export async function rejectPendingDispatchItem(
  database: D1Database,
  item: DispatchItemIdentityRow,
  errorCode: string,
  completedAt: string
): Promise<boolean> {
  const receiptId = await sha256(
    [
      "github.sync.dispatch.item.rejection",
      item.item_id,
      errorCode,
      completedAt
    ].join("\n")
  );
  const statements = [
    database.prepare(
      `UPDATE github_sync_dispatch_items
       SET status = 'failed', completed_at = ?, last_error_code = ?
       WHERE item_id = ? AND status = 'pending' AND run_id IS NULL`
    ).bind(completedAt, errorCode, item.item_id),
    database.prepare(
      `INSERT INTO github_sync_dispatch_item_rejection_receipts
       (receipt_id, dispatch_item_id, dispatch_id, credential_version,
        project_id, repository_id, ref, last_error_code, completed_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM github_sync_dispatch_items
         WHERE item_id = ? AND status = 'failed' AND run_id IS NULL
           AND last_error_code = ? AND completed_at = ?
       )
       ON CONFLICT(receipt_id) DO NOTHING`
    ).bind(
      receiptId,
      item.item_id,
      item.dispatch_id,
      item.credential_version,
      item.project_id,
      item.repository_id,
      item.ref,
      errorCode,
      completedAt,
      item.item_id,
      errorCode,
      completedAt
    )
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    if (await hasExactDispatchItemRejection(
      database,
      item,
      receiptId,
      errorCode,
      completedAt
    )) {
      return true;
    }
    const current = await database.withSession("first-primary").prepare(
      `SELECT status, run_id FROM github_sync_dispatch_items WHERE item_id = ?`
    ).bind(item.item_id).first<{ status: string; run_id: string | null }>();
    if (current !== null && (current.status !== "pending" || current.run_id !== null)) {
      return false;
    }
    throw error;
  }
  if (!(await hasExactDispatchItemRejection(
    database,
    item,
    receiptId,
    errorCode,
    completedAt
  ))) {
    const current = await database.withSession("first-primary").prepare(
      `SELECT status, run_id FROM github_sync_dispatch_items WHERE item_id = ?`
    ).bind(item.item_id).first<{ status: string; run_id: string | null }>();
    if (current !== null && (current.status !== "pending" || current.run_id !== null)) {
      return false;
    }
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  return true;
}

async function hasExactDispatchItemRejection(
  database: D1Database,
  item: DispatchItemIdentityRow,
  receiptId: string,
  errorCode: string,
  completedAt: string
): Promise<boolean> {
  const exact = await database.withSession("first-primary").prepare(
    `SELECT 1 AS matches
     FROM github_sync_dispatch_item_rejection_receipts AS receipt
     JOIN github_sync_dispatch_items AS item
       ON item.item_id = receipt.dispatch_item_id
     WHERE receipt.receipt_id = ? AND receipt.dispatch_item_id = ?
       AND receipt.dispatch_id = ? AND receipt.credential_version = ?
       AND receipt.project_id = ? AND receipt.repository_id = ?
       AND receipt.ref = ? AND receipt.last_error_code = ?
       AND receipt.completed_at = ?
       AND item.status = 'failed' AND item.run_id IS NULL
       AND item.last_error_code = receipt.last_error_code
       AND item.completed_at = receipt.completed_at
     LIMIT 1`
  ).bind(
    receiptId,
    item.item_id,
    item.dispatch_id,
    item.credential_version,
    item.project_id,
    item.repository_id,
    item.ref,
    errorCode,
    completedAt
  ).first<{ matches: number }>();
  return exact?.matches === 1;
}

export async function finishDispatchItem(
  database: D1Database,
  input: {
    item: DispatchItemReceiptIdentity;
    runId: string;
    status: "complete" | "failed";
    errorCode: string | null;
    completedAt: string;
  }
): Promise<void> {
  const receiptId = await sha256([
    "github.repository.sync.finish",
    input.item.item_id,
    input.runId,
    input.status,
    input.errorCode ?? "",
    input.completedAt
  ].join("\n"));
  const statements = [
    database.prepare(
      `UPDATE github_sync_dispatch_items
       SET status = ?, completed_at = ?, last_error_code = ?
       WHERE item_id = ? AND status = 'running' AND run_id = ?`
    ).bind(
      input.status,
      input.completedAt,
      input.errorCode,
      input.item.item_id,
      input.runId
    ),
    database.prepare(
      `INSERT INTO github_repository_sync_finish_receipts
       (receipt_id, run_id, dispatch_item_id, project_id, repository_id, ref,
        status, last_error_code, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(receipt_id) DO NOTHING`
    ).bind(
      receiptId,
      input.runId,
      input.item.item_id,
      input.item.project_id,
      input.item.repository_id,
      input.item.ref,
      input.status,
      input.errorCode,
      input.completedAt
    )
  ];
  try {
    const results = await database.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error("The GitHub dispatch item terminal transition was rejected.");
    }
  } catch (error) {
    const exact = await database.withSession("first-primary").prepare(
      `SELECT 1 AS matches
       FROM github_repository_sync_finish_receipts AS receipt
       JOIN github_sync_dispatch_items AS item
         ON item.item_id = receipt.dispatch_item_id
       WHERE receipt.receipt_id = ? AND receipt.run_id = ?
         AND receipt.dispatch_item_id = ? AND receipt.project_id = ?
         AND receipt.repository_id = ? AND receipt.ref = ?
         AND receipt.status = ? AND receipt.last_error_code IS ?
         AND receipt.completed_at = ?
         AND item.status = receipt.status
         AND item.last_error_code IS receipt.last_error_code
         AND item.completed_at = receipt.completed_at`
    ).bind(
      receiptId,
      input.runId,
      input.item.item_id,
      input.item.project_id,
      input.item.repository_id,
      input.item.ref,
      input.status,
      input.errorCode,
      input.completedAt
    ).first<{ matches: number }>();
    if (exact?.matches === 1) return;
    throw error;
  }
}

async function listPendingDispatchItems(
  database: D1Database,
  dispatchId: string
): Promise<DispatchItemIdentityRow[]> {
  const rows = await database.withSession("first-primary").prepare(
    `SELECT item.item_id, item.dispatch_id, dispatch.credential_version,
            item.project_id, item.repository_id, item.ref, item.status, item.run_id
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = item.dispatch_id
     WHERE item.dispatch_id = ? AND item.status = 'pending'
       AND item.run_id IS NULL
     ORDER BY item.item_id LIMIT 100`
  ).bind(dispatchId).all<DispatchItemIdentityRow>();
  return rows.results;
}

async function rejectPendingDispatchItems(
  step: WorkflowStep,
  database: D1Database,
  dispatchId: string,
  errorCode: string,
  completedAt: string,
  stepPrefix: string
): Promise<void> {
  for (let page = 0; ; page += 1) {
    const items = await step.do(
      `${stepPrefix} list ${page + 1}`,
      STEP_RETRY,
      () => listPendingDispatchItems(database, dispatchId)
    );
    if (items.length === 0) return;
    await step.do(`${stepPrefix} reject ${page + 1}`, STEP_RETRY, async () => {
      for (const item of items) {
        await rejectPendingDispatchItem(
          database,
          item,
          errorCode,
          completedAt
        );
      }
    });
  }
}

export async function failDispatchWorkflow(
  step: WorkflowStep,
  database: D1Database,
  dispatchId: string,
  error: unknown,
  stepPrefix: string
): Promise<void> {
  const errorCode = workflowSyncError(error).code;
  const failedAt = await step.do(`${stepPrefix} establish failure time`, () =>
    Promise.resolve(new Date().toISOString())
  );
  await rejectPendingDispatchItems(
    step,
    database,
    dispatchId,
    errorCode,
    failedAt,
    `${stepPrefix} reject pending items`
  );
  await step.do(`${stepPrefix} record dispatch failure`, STEP_RETRY, () =>
    markGitHubDispatchStatus(
      database,
      dispatchId,
      "failed",
      errorCode,
      failedAt
    )
  );
}

async function listPriorPendingDispatchItems(
  database: D1Database,
  scheduledFor: string,
  credentialVersion: string
): Promise<DispatchItemIdentityRow[]> {
  const rows = await database.withSession("first-primary").prepare(
    `SELECT item.item_id, item.dispatch_id, dispatch.credential_version,
            item.project_id, item.repository_id, item.ref, item.status, item.run_id
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = item.dispatch_id
     WHERE item.status = 'pending' AND item.run_id IS NULL
       AND (item.scheduled_for < ? OR dispatch.credential_version <> ?)
     ORDER BY item.scheduled_for, item.item_id LIMIT 100`
  ).bind(scheduledFor, credentialVersion).all<DispatchItemIdentityRow>();
  return rows.results;
}

async function listPriorRecoverableRunningItems(
  database: D1Database,
  scheduledFor: string,
  credentialVersion: string,
  reconciliationNow: string
): Promise<PriorRunningDispatchItem[]> {
  const rows = await database.withSession("first-primary").prepare(
    `SELECT item.item_id, item.dispatch_id, dispatch.credential_version,
            item.project_id, item.repository_id, item.ref, item.status, item.run_id,
            item.scheduled_for,
            run.status AS run_status,
            run.completed_at AS run_completed_at,
            run.last_error_code AS run_error_code,
            run.lease_expires_at
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = item.dispatch_id
     JOIN github_repository_sync_runs AS run ON run.run_id = item.run_id
     WHERE item.status = 'running'
       AND (
         dispatch.credential_version <> ?
         OR (
           item.scheduled_for < ?
           AND (run.status <> 'running'
             OR run.lease_expires_at <= ?)
         )
       )
     ORDER BY item.scheduled_for, item.item_id
     LIMIT ${MAX_RUNNING_RECONCILIATION_ROWS}`
  ).bind(
    credentialVersion,
    scheduledFor,
    reconciliationNow
  ).all<PriorRunningDispatchItem>();
  return rows.results;
}

async function listPriorRecoverableUnboundRuns(
  database: D1Database,
  scheduledFor: string,
  credentialVersion: string,
  reconciliationNow: string,
  afterRunId: string,
  afterItemId: string
): Promise<PriorUnboundRepositoryRun[]> {
  const rows = await database.withSession("first-primary").prepare(
    `SELECT run.run_id, rejected.item_id, rejected.project_id,
            rejected.repository_id, rejected.ref, rejected.scheduled_for
     FROM github_repository_sync_runs AS run
     JOIN github_sync_dispatch_items AS rejected
       ON rejected.project_id = run.project_id
      AND rejected.repository_id = run.repository_id
      AND rejected.ref = run.claimed_ref
      AND rejected.scheduled_for = run.scheduled_for
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = rejected.dispatch_id
     JOIN github_sync_dispatch_item_rejection_receipts AS receipt
       ON receipt.dispatch_item_id = rejected.item_id
      AND receipt.dispatch_id = rejected.dispatch_id
      AND receipt.credential_version = dispatch.credential_version
      AND receipt.project_id = rejected.project_id
      AND receipt.repository_id = rejected.repository_id
      AND receipt.ref = rejected.ref
      AND receipt.last_error_code = rejected.last_error_code
      AND receipt.completed_at = rejected.completed_at
     WHERE run.status = 'running' AND run.completed_at IS NULL
       AND rejected.status = 'failed' AND rejected.run_id IS NULL
       AND run.full_reconciliation = rejected.full_reconciliation
       AND run.repository_configuration_version =
           rejected.repository_configuration_version
       AND run.cursor_version = rejected.cursor_version
       AND run.claimed_head_manifest_id IS rejected.selected_head_manifest_id
       AND run.claimed_head_version = rejected.selected_head_version
       AND run.claim_contract_version = 1
       AND NOT EXISTS (
         SELECT 1 FROM github_sync_dispatch_items AS bound
         WHERE bound.run_id = run.run_id
       )
       AND (
         dispatch.credential_version <> ?
         OR (run.scheduled_for < ? AND run.lease_expires_at <= ?)
       )
       AND (run.run_id > ? OR (run.run_id = ? AND rejected.item_id > ?))
     ORDER BY run.run_id, rejected.item_id LIMIT 100`
  ).bind(
    credentialVersion,
    scheduledFor,
    reconciliationNow,
    afterRunId,
    afterRunId,
    afterItemId
  ).all<PriorUnboundRepositoryRun>();
  return rows.results;
}

async function listPriorClosableDispatches(
  database: D1Database,
  scheduledFor: string,
  credentialVersion: string
): Promise<Array<{ dispatch_id: string; status: "complete" | "failed" }>> {
  const rows = await database.withSession("first-primary").prepare(
    `SELECT dispatch.dispatch_id,
            CASE
              WHEN receipt.dispatch_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM github_sync_dispatch_items AS failed_item
                 WHERE failed_item.dispatch_id = dispatch.dispatch_id
                   AND failed_item.status = 'failed'
               )
              THEN 'complete' ELSE 'failed'
            END AS status
     FROM github_sync_dispatches AS dispatch
     LEFT JOIN github_sync_dispatch_materialization_receipts AS receipt
       ON receipt.dispatch_id = dispatch.dispatch_id
     WHERE dispatch.status IN ('materialized', 'dispatching')
       AND (dispatch.scheduled_for < ? OR dispatch.credential_version <> ?)
       AND NOT EXISTS (
         SELECT 1 FROM github_sync_dispatch_items AS active_item
         WHERE active_item.dispatch_id = dispatch.dispatch_id
           AND active_item.status IN ('pending', 'running')
       )
     ORDER BY dispatch.scheduled_for, dispatch.dispatch_id LIMIT 100`
  ).bind(scheduledFor, credentialVersion).all<{
    dispatch_id: string;
    status: "complete" | "failed";
  }>();
  return rows.results;
}

async function readCurrentPriorRunningItem(
  database: D1Database,
  itemId: string
): Promise<PriorRunningDispatchItem | null> {
  return database.withSession("first-primary").prepare(
    `SELECT item.item_id, item.dispatch_id, dispatch.credential_version,
            item.project_id, item.repository_id, item.ref, item.status,
            item.run_id, item.scheduled_for, run.status AS run_status,
            run.completed_at AS run_completed_at,
            run.last_error_code AS run_error_code, run.lease_expires_at
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = item.dispatch_id
     JOIN github_repository_sync_runs AS run ON run.run_id = item.run_id
     WHERE item.item_id = ? AND item.status = 'running'
     LIMIT 1`
  ).bind(itemId).first<PriorRunningDispatchItem>();
}

async function hasExactFinishedDispatchItem(
  database: D1Database,
  itemId: string
): Promise<boolean> {
  const exact = await database.withSession("first-primary").prepare(
    `SELECT 1 AS matches
     FROM github_sync_dispatch_items AS item
     JOIN github_repository_sync_finish_receipts AS receipt
       ON receipt.dispatch_item_id = item.item_id AND receipt.run_id = item.run_id
     WHERE item.item_id = ? AND item.status IN ('complete', 'failed')
       AND receipt.status = item.status
       AND receipt.last_error_code IS item.last_error_code
       AND receipt.completed_at = item.completed_at
     LIMIT 1`
  ).bind(itemId).first<{ matches: number }>();
  return exact?.matches === 1;
}

async function settlePriorRunningDispatchItem(
  database: D1Database,
  itemId: string,
  scheduledFor: string,
  credentialVersion: string,
  reconciliationNow: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = await readCurrentPriorRunningItem(database, itemId);
    if (item === null) {
      if (await hasExactFinishedDispatchItem(database, itemId)) return;
      return;
    }
    const forcedByRotation = item.credential_version !== credentialVersion;
    const expiredPriorRun =
      item.scheduled_for < scheduledFor &&
      (item.run_status !== "running" || item.lease_expires_at <= reconciliationNow);
    if (!forcedByRotation && !expiredPriorRun) return;
    let errorCode: string | null;
    let completedAt: string;
    if (item.run_status === "running") {
      errorCode = "GITHUB_RECONCILIATION_REQUIRED";
      try {
        completedAt = await finishRepositorySyncRun(
          database,
          item.run_id as string,
          errorCode,
          reconciliationNow
        );
      } catch {
        continue;
      }
    } else {
      errorCode = item.run_status === "complete"
        ? null
        : (item.run_error_code ?? "GITHUB_RECONCILIATION_REQUIRED");
      if (item.run_completed_at === null) continue;
      completedAt = item.run_completed_at;
    }
    try {
      await finishDispatchItem(database, {
        item,
        runId: item.run_id as string,
        status: errorCode === null ? "complete" : "failed",
        errorCode,
        completedAt
      });
      return;
    } catch {
      if (await hasExactFinishedDispatchItem(database, itemId)) return;
    }
  }
  throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
}

export async function reconcilePriorDispatchState(
  step: WorkflowStep,
  database: D1Database,
  scheduledFor: string,
  credentialVersion: string
): Promise<void> {
  const reconciliationNow = await step.do(
    "establish prior dispatch reconciliation time",
    () => Promise.resolve(new Date().toISOString())
  );
  const budget = createPriorReconciliationBudget();
  for (let page = 0; ; page += 1) {
    budget.reservePage();
    const pending = await step.do(
      `list prior pending dispatch items ${page + 1}`,
      STEP_RETRY,
      () => listPriorPendingDispatchItems(database, scheduledFor, credentialVersion)
    );
    if (pending.length === 0) break;
    budget.reserveSubrequests(
      pending.length * MAX_PENDING_RECONCILIATION_SUBREQUESTS_PER_ROW
    );
    await step.do(`reject prior pending dispatch items ${page + 1}`, STEP_RETRY, async () => {
      for (const item of pending) {
        await rejectPendingDispatchItem(
          database,
          item,
          "GITHUB_RECONCILIATION_REQUIRED",
          reconciliationNow
        );
      }
    });
  }
  let orphanRunCursor = "";
  let orphanItemCursor = "";
  for (let page = 0; ; page += 1) {
    budget.reservePage();
    const orphanRuns = await step.do(
      `list prior unbound repository runs ${page + 1}`,
      STEP_RETRY,
      () => listPriorRecoverableUnboundRuns(
        database,
        scheduledFor,
        credentialVersion,
        reconciliationNow,
        orphanRunCursor,
        orphanItemCursor
      )
    );
    if (orphanRuns.length === 0) break;
    budget.reserveSubrequests(
      orphanRuns.length * MAX_ORPHAN_RECONCILIATION_SUBREQUESTS_PER_ROW
    );
    await step.do(
      `finish prior unbound repository runs ${page + 1}`,
      STEP_RETRY,
      async () => {
        for (const orphan of orphanRuns) {
          await finishRejectedUnboundRepositoryRun(
            database,
            orphan,
            orphan.run_id,
            reconciliationNow
          );
        }
      }
    );
    const last = orphanRuns.at(-1);
    if (last === undefined) break;
    orphanRunCursor = last.run_id;
    orphanItemCursor = last.item_id;
  }
  for (let page = 0; ; page += 1) {
    budget.reservePage();
    const running = await step.do(
      `list prior running dispatch items ${page + 1}`,
      STEP_RETRY,
      () => listPriorRecoverableRunningItems(
        database,
        scheduledFor,
        credentialVersion,
        reconciliationNow
      )
    );
    if (running.length === 0) break;
    budget.reserveSubrequests(
      running.length * MAX_RUNNING_RECONCILIATION_SUBREQUESTS_PER_ROW
    );
    await step.do(`finish prior running dispatch items ${page + 1}`, STEP_RETRY, async () => {
      for (const item of running) {
        await settlePriorRunningDispatchItem(
          database,
          item.item_id,
          scheduledFor,
          credentialVersion,
          reconciliationNow
        );
      }
    });
  }
  for (let page = 0; ; page += 1) {
    budget.reservePage();
    const dispatches = await step.do(
      `list prior closable dispatches ${page + 1}`,
      STEP_RETRY,
      () => listPriorClosableDispatches(database, scheduledFor, credentialVersion)
    );
    if (dispatches.length === 0) break;
    budget.reserveSubrequests(
      dispatches.length * MAX_DISPATCH_RECONCILIATION_SUBREQUESTS_PER_ROW
    );
    await step.do(`close prior dispatches ${page + 1}`, STEP_RETRY, async () => {
      for (const dispatch of dispatches) {
        await markGitHubDispatchStatus(
          database,
          dispatch.dispatch_id,
          dispatch.status,
          dispatch.status === "failed" ? "GITHUB_RECONCILIATION_REQUIRED" : null,
          reconciliationNow
        );
      }
    });
  }
}
