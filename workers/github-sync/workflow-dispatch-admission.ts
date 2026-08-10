// Owns pure dispatch admission and Workflow step-result budget enforcement.
import { GitHubSyncError } from "../../src/github/client";
import { MAX_GITHUB_ACCESS_BASELINE_REQUESTS } from "./index";
import {
  MAX_LIST_RECONCILIATION_SUBREQUESTS,
  MAX_PENDING_RECONCILIATION_SUBREQUESTS_PER_ROW,
  MAX_PRIOR_RECONCILIATION_PAGES,
  MAX_PRIOR_RECONCILIATION_STEPS,
  MAX_PRIOR_RECONCILIATION_SUBREQUESTS,
  STEP_RETRY,
  type PriorReconciliationUsage
} from "./workflow-runtime";

export const REPOSITORY_ID_PAGE_SIZE = 16;
export const REPOSITORY_SNAPSHOT_PAGE_SIZE = 1;
export const MATERIALIZATION_BATCH_SIZE = 100;
const FANOUT_BATCH_SIZE = 100;
const MAX_STEP_ATTEMPTS = STEP_RETRY.retries.limit + 1;
const MAX_BASELINE_ATTEMPTS = 3;
const REQUEST_RESERVATION_BLOCK_SIZE = 100;
// A lost lane-row insert adds one exact-recovery read before the normal four calls.
const MAX_D1_SUBREQUESTS_PER_LANE_ATTEMPT = 5 * MAX_STEP_ATTEMPTS;
// Nine successful request blocks plus at most two failed reservations and three
// approved-baseline/credential-state attempts (one read and up to two writes).
const MAX_D1_SUBREQUESTS_PER_BASELINE =
  (Math.ceil(
    MAX_GITHUB_ACCESS_BASELINE_REQUESTS / REQUEST_RESERVATION_BLOCK_SIZE
  ) + MAX_BASELINE_ATTEMPTS - 1) * 3 + MAX_BASELINE_ATTEMPTS * 3;

export const GITHUB_DISPATCH_SUBREQUEST_LIMIT = 10_000;
export const GITHUB_DISPATCH_WORKFLOW_STEP_LIMIT = 10_000;
export const GITHUB_DISPATCH_SUBREQUEST_RESERVE = 128;
export const GITHUB_DISPATCH_WORKFLOW_STEP_RESERVE = 128;
export const GITHUB_DISPATCH_LANE_MAX_ATTEMPTS = 32;
export const GITHUB_DISPATCH_STEP_RESULT_LIMIT_BYTES = 2 ** 20;
export const GITHUB_DISPATCH_STEP_RESULT_RESERVE_BYTES = 8 * 1024;
// Even with a fully consumed prior-reconciliation allowance, an oversized
// inventory is rejected with enough room to terminalize the empty dispatch.
export const MAX_REPOSITORY_ADMISSION_SUMMARY_PAGES = Math.floor(
  (
    GITHUB_DISPATCH_SUBREQUEST_LIMIT -
    MAX_PRIOR_RECONCILIATION_SUBREQUESTS -
    GITHUB_DISPATCH_SUBREQUEST_RESERVE -
    2 * MAX_STEP_ATTEMPTS -
    MAX_STEP_ATTEMPTS -
    (MAX_LIST_RECONCILIATION_SUBREQUESTS + 2 * MAX_STEP_ATTEMPTS)
  ) / MAX_STEP_ATTEMPTS
);

export interface GitHubDispatchAdmissionInventory {
  enabledRepositoryRows: number;
  validRepositoryRows: number;
  invalidRepositoryRows: number;
  parsedRefCount: number;
  materializationBatchCount: number;
  uniqueExternalRepositoryIds: number;
  summaryPageCount: number;
  snapshotPageCount: number;
}

export interface GitHubDispatchAdmissionEstimate {
  admitted: boolean;
  fanoutBatchCount: number;
  estimatedD1Subrequests: number;
  estimatedGitHubSubrequests: number;
  estimatedWorkflowBindingSubrequests: number;
  estimatedSubrequests: number;
  estimatedWorkflowSteps: number;
  subrequestHeadroom: number;
  workflowStepHeadroom: number;
  priorActualRemainingSubrequests: number;
  priorWorstCaseRemainingSubrequests: number;
  priorActualRemainingWorkflowSteps: number;
  priorWorstCaseRemainingWorkflowSteps: number;
}

function assertAdmissionCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`The GitHub dispatch ${name} is invalid.`);
  }
}

function fanoutBatchSize(parsedRefCount: number, batchIndex: number): number {
  return Math.min(
    FANOUT_BATCH_SIZE,
    parsedRefCount - batchIndex * FANOUT_BATCH_SIZE
  );
}

function maxFanoutBindingSubrequests(parsedRefCount: number): number {
  const batchCount = Math.ceil(parsedRefCount / FANOUT_BATCH_SIZE);
  let maximum = 0;
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const size = fanoutBatchSize(parsedRefCount, batchIndex);
    // Every fan-out page is an independent retryable Workflow step. A page can
    // consume one createBatch call plus five exact-recovery binding calls per
    // item on every attempt and still recover successfully, so all pages that
    // can run must be accumulated rather than treating only one page as the
    // retrying page.
    maximum += MAX_STEP_ATTEMPTS * (1 + 5 * size);
  }
  return maximum;
}

export function assertGitHubDispatchStepResult(value: unknown): void {
  const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (
    byteLength >
      GITHUB_DISPATCH_STEP_RESULT_LIMIT_BYTES -
        GITHUB_DISPATCH_STEP_RESULT_RESERVE_BYTES
  ) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
}

function validateAdmissionInput(
  inventory: GitHubDispatchAdmissionInventory,
  prior: PriorReconciliationUsage
): void {
  const inventoryCounts = [
    ["enabled repository rows", inventory.enabledRepositoryRows],
    ["valid repository rows", inventory.validRepositoryRows],
    ["invalid repository rows", inventory.invalidRepositoryRows],
    ["parsed ref count", inventory.parsedRefCount],
    ["materialization batch count", inventory.materializationBatchCount],
    ["unique external repository IDs", inventory.uniqueExternalRepositoryIds],
    ["summary page count", inventory.summaryPageCount],
    ["snapshot page count", inventory.snapshotPageCount]
  ] as const;
  for (const [name, value] of inventoryCounts) {
    assertAdmissionCount(name, value);
  }
  const priorCounts = [
    ["page count", prior.pageCount],
    ["mutation page count", prior.mutationPageCount],
    ["subrequest count", prior.subrequestCount],
    ["Workflow step count", prior.workflowStepCount]
  ] as const;
  for (const [name, value] of priorCounts) {
    assertAdmissionCount(`prior ${name}`, value);
  }
  if (
    inventory.validRepositoryRows + inventory.invalidRepositoryRows !==
      inventory.enabledRepositoryRows ||
    inventory.parsedRefCount < inventory.validRepositoryRows ||
    inventory.parsedRefCount > inventory.validRepositoryRows * 513 ||
    inventory.materializationBatchCount <
      Math.ceil(inventory.parsedRefCount / MATERIALIZATION_BATCH_SIZE) ||
    inventory.materializationBatchCount > inventory.parsedRefCount ||
    inventory.uniqueExternalRepositoryIds > inventory.validRepositoryRows ||
    inventory.summaryPageCount !==
      Math.floor(inventory.enabledRepositoryRows / REPOSITORY_ID_PAGE_SIZE) + 1 ||
    inventory.snapshotPageCount !==
      inventory.enabledRepositoryRows + 1
  ) {
    throw new TypeError("The GitHub dispatch admission inventory is inconsistent.");
  }
  if (
    prior.pageCount > MAX_PRIOR_RECONCILIATION_PAGES ||
    prior.mutationPageCount > prior.pageCount ||
    prior.subrequestCount > MAX_PRIOR_RECONCILIATION_SUBREQUESTS ||
    prior.subrequestCount % MAX_LIST_RECONCILIATION_SUBREQUESTS !== 0 ||
    prior.workflowStepCount > MAX_PRIOR_RECONCILIATION_STEPS ||
    prior.workflowStepCount !==
      1 + prior.pageCount + prior.mutationPageCount ||
    prior.subrequestCount <
      prior.pageCount * MAX_LIST_RECONCILIATION_SUBREQUESTS
  ) {
    throw new TypeError("The prior GitHub reconciliation usage is inconsistent.");
  }
}

export function estimateGitHubDispatchAdmission(
  inventory: GitHubDispatchAdmissionInventory,
  prior: PriorReconciliationUsage
): GitHubDispatchAdmissionEstimate {
  validateAdmissionInput(inventory, prior);
  const hasValidRepositories = inventory.validRepositoryRows > 0;
  const fanoutBatchCount = Math.ceil(
    inventory.parsedRefCount / FANOUT_BATCH_SIZE
  );
  const commonD1Subrequests =
    2 * MAX_STEP_ATTEMPTS +
    prior.subrequestCount +
    MAX_STEP_ATTEMPTS +
    inventory.summaryPageCount * MAX_STEP_ATTEMPTS +
    inventory.snapshotPageCount * MAX_STEP_ATTEMPTS +
    (hasValidRepositories
      ? GITHUB_DISPATCH_LANE_MAX_ATTEMPTS *
        MAX_D1_SUBREQUESTS_PER_LANE_ATTEMPT +
        MAX_D1_SUBREQUESTS_PER_BASELINE +
        3 * MAX_STEP_ATTEMPTS
      : 0);
  const pendingFailureCleanupD1Subrequests =
    (fanoutBatchCount + 1) * MAX_LIST_RECONCILIATION_SUBREQUESTS +
    inventory.parsedRefCount *
      MAX_PENDING_RECONCILIATION_SUBREQUESTS_PER_ROW +
    2 * MAX_STEP_ATTEMPTS;
  const successfulPathD1Subrequests =
    MAX_STEP_ATTEMPTS *
      (7 * inventory.materializationBatchCount +
        inventory.validRepositoryRows +
        2 * inventory.invalidRepositoryRows) +
    MAX_STEP_ATTEMPTS +
    3 * MAX_STEP_ATTEMPTS +
    (fanoutBatchCount + 1) * MAX_LIST_RECONCILIATION_SUBREQUESTS +
    2 * MAX_STEP_ATTEMPTS +
    pendingFailureCleanupD1Subrequests;
  const baselineFailureD1Subrequests = hasValidRepositories
    ? MAX_STEP_ATTEMPTS *
        (4 * inventory.materializationBatchCount +
          inventory.validRepositoryRows +
          inventory.parsedRefCount +
          2 * inventory.invalidRepositoryRows) +
      MAX_STEP_ATTEMPTS +
      MAX_LIST_RECONCILIATION_SUBREQUESTS +
      2 * MAX_STEP_ATTEMPTS
    : 0;
  const estimatedD1Subrequests =
    commonD1Subrequests +
    Math.max(successfulPathD1Subrequests, baselineFailureD1Subrequests);
  const estimatedGitHubSubrequests = hasValidRepositories
    ? MAX_GITHUB_ACCESS_BASELINE_REQUESTS
    : 0;
  const estimatedWorkflowBindingSubrequests =
    maxFanoutBindingSubrequests(inventory.parsedRefCount);
  const estimatedSubrequests =
    estimatedD1Subrequests +
    estimatedGitHubSubrequests +
    estimatedWorkflowBindingSubrequests +
    GITHUB_DISPATCH_SUBREQUEST_RESERVE;

  const commonWorkflowSteps =
    1 +
    prior.workflowStepCount +
    1 +
    inventory.summaryPageCount +
    inventory.snapshotPageCount +
    (hasValidRepositories
      ? GITHUB_DISPATCH_LANE_MAX_ATTEMPTS * 3 +
        1 +
        (MAX_BASELINE_ATTEMPTS * 3 - 2) +
        1
      : 0);
  const successfulPathWorkflowSteps =
    inventory.enabledRepositoryRows +
    1 +
    1 +
    fanoutBatchCount + 1 +
    fanoutBatchCount +
    1 +
    (2 * fanoutBatchCount + 3);
  const baselineFailureWorkflowSteps = hasValidRepositories
    ? inventory.enabledRepositoryRows + 1 + 3
    : 0;
  const estimatedWorkflowSteps =
    commonWorkflowSteps +
    Math.max(successfulPathWorkflowSteps, baselineFailureWorkflowSteps) +
    GITHUB_DISPATCH_WORKFLOW_STEP_RESERVE;
  const subrequestHeadroom =
    GITHUB_DISPATCH_SUBREQUEST_LIMIT - estimatedSubrequests;
  const workflowStepHeadroom =
    GITHUB_DISPATCH_WORKFLOW_STEP_LIMIT - estimatedWorkflowSteps;
  return {
    admitted: subrequestHeadroom >= 0 && workflowStepHeadroom >= 0,
    fanoutBatchCount,
    estimatedD1Subrequests,
    estimatedGitHubSubrequests,
    estimatedWorkflowBindingSubrequests,
    estimatedSubrequests,
    estimatedWorkflowSteps,
    subrequestHeadroom,
    workflowStepHeadroom,
    priorActualRemainingSubrequests:
      GITHUB_DISPATCH_SUBREQUEST_LIMIT - prior.subrequestCount,
    priorWorstCaseRemainingSubrequests:
      GITHUB_DISPATCH_SUBREQUEST_LIMIT -
        MAX_PRIOR_RECONCILIATION_SUBREQUESTS,
    priorActualRemainingWorkflowSteps:
      GITHUB_DISPATCH_WORKFLOW_STEP_LIMIT - prior.workflowStepCount,
    priorWorstCaseRemainingWorkflowSteps:
      GITHUB_DISPATCH_WORKFLOW_STEP_LIMIT - MAX_PRIOR_RECONCILIATION_STEPS
  };
}

export function assertGitHubDispatchAdmission(
  inventory: GitHubDispatchAdmissionInventory,
  prior: PriorReconciliationUsage
): GitHubDispatchAdmissionEstimate {
  const estimate = estimateGitHubDispatchAdmission(inventory, prior);
  if (!estimate.admitted) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  return estimate;
}
