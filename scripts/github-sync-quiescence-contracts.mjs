import { createHash } from "node:crypto";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;

export function statement(sql, params) {
  return { sql, params };
}

export async function batchWithVerification(runtime, statements, label, verify) {
  try {
    await runtime.batch(statements, label);
  } catch (error) {
    if (await verify()) return;
    throw error;
  }
  if (!(await verify())) {
    throw new Error(`${label} did not produce the exact durable state.`);
  }
}

export async function verifyMatchBatch(runtime, statements, label) {
  const results = await runtime.batch(statements, label);
  if (!Array.isArray(results) || results.length !== statements.length) {
    throw new Error(`${label} returned an invalid verification batch.`);
  }
  return results.every(
    (result) =>
      Array.isArray(result?.results) &&
      result.results.length === 1 &&
      result.results[0]?.matches === 1
  );
}

export function itemIdentity(item, alias) {
  return {
    sql: `${alias}.item_id = ? AND ${alias}.dispatch_id = ?
      AND ${alias}.project_id = ? AND ${alias}.repository_id = ?
      AND ${alias}.ref = ? AND ${alias}.scheduled_for = ?
      AND ${alias}.full_reconciliation = ?
      AND ${alias}.repository_configuration_version = ?
      AND ${alias}.cursor_version = ?
      AND ${alias}.selected_head_manifest_id IS ?
      AND ${alias}.selected_head_version = ?
      AND ${alias}.repository_updated_at = ?
      AND ${alias}.cursor_status = ? AND ${alias}.cursor_updated_at = ?
      AND ${alias}.workflow_instance_id = ? AND ${alias}.created_at = ?`,
    params: [
      item.itemId,
      item.dispatchId,
      item.projectId,
      item.repositoryId,
      item.ref,
      item.scheduledFor,
      item.fullReconciliation,
      item.configurationVersion,
      item.cursorVersion,
      item.headManifestId,
      item.headVersion,
      item.repositoryUpdatedAt,
      item.cursorStatus,
      item.cursorUpdatedAt,
      item.workflowInstanceId,
      item.createdAt ?? item.itemCreatedAt
    ]
  };
}

export function boundItemIdentity(item, alias) {
  return itemIdentity(
    {
      ...item,
      createdAt: item.itemCreatedAt
    },
    alias
  );
}

export function runIdentity(run, alias) {
  return {
    sql: `${alias}.run_id = ? AND ${alias}.project_id = ?
      AND ${alias}.repository_id = ? AND ${alias}.scheduled_for = ?
      AND ${alias}.full_reconciliation = ? AND ${alias}.started_at = ?
      AND ${alias}.lease_expires_at = ? AND ${alias}.claimed_ref = ?
      AND ${alias}.claimed_head_manifest_id IS ?
      AND ${alias}.claimed_head_version = ?
      AND ${alias}.repository_configuration_version = ?
      AND ${alias}.cursor_version = ?`,
    params: [
      run.runId,
      run.projectId,
      run.repositoryId,
      run.scheduledFor,
      run.fullReconciliation,
      run.startedAt,
      run.leaseExpiresAt,
      run.ref,
      run.headManifestId,
      run.headVersion,
      run.configurationVersion,
      run.cursorVersion
    ]
  };
}

export function rejectionReceiptId(item) {
  return sha256([
    "github.sync.dispatch.item.rejection",
    item.itemId,
    item.errorCode ?? item.lastErrorCode ?? "GITHUB_RECONCILIATION_REQUIRED",
    item.completedAt
  ].join("\n"));
}

export function finishReceiptId(item) {
  return sha256([
    "github.repository.sync.finish",
    item.itemId,
    item.runId,
    item.targetStatus ?? "failed",
    item.errorCode ?? "",
    item.completedAt
  ].join("\n"));
}

export function laneReleaseReceiptId(lane) {
  return sha256([
    "github.credential.lane.release",
    lane.credentialVersion,
    lane.holderKind,
    lane.holderId,
    lane.claimId,
    String(lane.epoch),
    lane.leaseUntil
  ].join("\n"));
}

export function textValue(row, name, minimum, maximum) {
  const value = row?.[name];
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum ||
    value.trim() !== value || value.includes("\0")
  ) {
    throw new Error(`The GitHub sync quiescence ${name} is invalid.`);
  }
  return value;
}

export function patternValue(row, name, pattern, label) {
  const value = textValue(row, name, 1, 128);
  if (!pattern.test(value)) throw new Error(`The ${label} is invalid.`);
  return value;
}

export function hexValue(row, name) {
  return patternValue(row, name, HEX_64, `GitHub sync quiescence ${name}`);
}

export function nullableHex(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`The GitHub sync quiescence ${label} is invalid.`);
  }
  return value;
}

export function enumValue(row, name, allowed) {
  const value = row?.[name];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`The GitHub sync quiescence ${name} is invalid.`);
  }
  return value;
}

export function integerValue(row, name, minimum, maximum) {
  const value = row?.[name];
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`The GitHub sync quiescence ${name} is invalid.`);
  }
  return value;
}

export function timestamp(value, label) {
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (
    typeof value !== "string" || !ISO_TIMESTAMP.test(value) ||
    parsed === null || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value
  ) {
    throw new Error(`The GitHub sync ${label} is invalid.`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
