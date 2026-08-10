import { sha256 } from "../security/crypto";

export const GITHUB_SYNC_SLOT_MS = 6 * 60 * 60 * 1_000;
export const GITHUB_WORKFLOW_ID_PATTERN = /^(?:ghd|ghr|ghc)-[0-9a-f]{64}$/u;

export interface GitHubDispatchIdentity {
  dispatchId: string;
  instanceId: string;
  scheduledFor: string;
  utcDate: string;
}

export interface GitHubRetentionIdentity {
  instanceId: string;
  scheduledFor: string;
  utcDate: string;
}

export function canonicalGitHubSyncSlot(scheduledTime: number): number {
  if (!Number.isFinite(scheduledTime) || scheduledTime < 0) {
    throw new TypeError("The GitHub sync schedule time is invalid.");
  }
  return Math.floor(scheduledTime / GITHUB_SYNC_SLOT_MS) * GITHUB_SYNC_SLOT_MS;
}

export async function githubDispatchIdentity(
  credentialVersion: string,
  scheduledTime: number
): Promise<GitHubDispatchIdentity> {
  const scheduledFor = new Date(canonicalGitHubSyncSlot(scheduledTime)).toISOString();
  const utcDate = scheduledFor.slice(0, 10);
  const dispatchId = await sha256(
    ["github.sync.dispatch", credentialVersion, scheduledFor].join("\n")
  );
  return {
    dispatchId,
    instanceId: `ghd-${dispatchId}`,
    scheduledFor,
    utcDate
  };
}

export async function githubRetentionIdentity(
  scheduledTime: number
): Promise<GitHubRetentionIdentity> {
  const scheduledFor = new Date(canonicalGitHubSyncSlot(scheduledTime)).toISOString();
  const utcDate = scheduledFor.slice(0, 10);
  const digest = await sha256(["github.sync.retention", scheduledFor].join("\n"));
  return { instanceId: `ghc-${digest}`, scheduledFor, utcDate };
}

export async function githubRefWorkflowIdentity(input: {
  dispatchId: string;
  projectId: string;
  repositoryId: string;
  ref: string;
  scheduledFor: string;
  fullReconciliation: boolean;
}): Promise<{ itemId: string; instanceId: string }> {
  const itemId = await sha256(
    [
      "github.sync.dispatch.item",
      input.dispatchId,
      input.projectId,
      input.repositoryId,
      input.ref,
      input.scheduledFor,
      input.fullReconciliation ? "full" : "incremental"
    ].join("\n")
  );
  return { itemId, instanceId: `ghr-${itemId}` };
}

export function deterministicLaneWaitMs(ownerId: string, attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new TypeError("The GitHub credential lane attempt is invalid.");
  }
  let hash = 2166136261;
  for (const character of ownerId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const exponential = Math.min(30_000, 250 * 2 ** Math.min(attempt, 7));
  return exponential + ((hash >>> 0) % 401);
}

export function chunkWorkflowBatch<T>(items: readonly T[], size = 100): T[][] {
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) {
    throw new TypeError("The Workflow batch size must be between one and 100.");
  }
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
}
