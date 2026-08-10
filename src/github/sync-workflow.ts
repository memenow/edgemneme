import { sha256 } from "../security/crypto";
import { MAX_GITHUB_ANNOTATED_TAG_PEEL_REQUESTS } from "./client";

export const GITHUB_CREDENTIAL_LANE_LEASE_MS = 14 * 60 * 1_000;
export const GITHUB_CREDENTIAL_LANE_INTERVAL_MS = 80;

export interface GitHubCredentialLaneToken {
  credentialVersion: string;
  holderKind: "dispatch" | "ref";
  holderId: string;
  claimId: string;
  epoch: number;
  leaseUntil: string;
}

export type GitHubCredentialLaneClaim =
  | { acquired: true; token: GitHubCredentialLaneToken }
  | { acquired: false; availableAfter: string; leaseUntil: string | null };

interface LaneRow {
  holder_kind: "dispatch" | "ref" | null;
  holder_id: string | null;
  lease_claim_id: string | null;
  lease_epoch: number;
  lease_until: string | null;
  available_after: string;
}

export async function credentialLaneClaimId(input: {
  credentialVersion: string;
  holderKind: "dispatch" | "ref";
  holderId: string;
}): Promise<string> {
  return sha256(
    [
      "github.credential.lane.claim",
      input.credentialVersion,
      input.holderKind,
      input.holderId
    ].join("\n")
  );
}

export async function tryAcquireGitHubCredentialLane(
  database: D1Database,
  input: {
    credentialVersion: string;
    holderKind: "dispatch" | "ref";
    holderId: string;
    claimId: string;
    nowMs?: number;
    leaseMs?: number;
  }
): Promise<GitHubCredentialLaneClaim> {
  const nowMs = input.nowMs ?? Date.now();
  const leaseMs = input.leaseMs ?? GITHUB_CREDENTIAL_LANE_LEASE_MS;
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) {
    throw new TypeError("The GitHub credential lane timing is invalid.");
  }
  const now = new Date(nowMs).toISOString();
  const leaseUntil = new Date(nowMs + leaseMs).toISOString();
  let session = database.withSession("first-primary");
  try {
    await session.prepare(
    `INSERT INTO github_credential_sync_lane
     (credential_version, holder_kind, holder_id, lease_claim_id, lease_epoch,
      lease_until, available_after, updated_at)
     VALUES (?, NULL, NULL, NULL, 0, NULL, ?, ?)
     ON CONFLICT(credential_version) DO NOTHING`
    )
      .bind(input.credentialVersion, now, now)
      .run();
  } catch (error) {
    session = database.withSession("first-primary");
    const recovered = await session.prepare(
      `SELECT credential_version FROM github_credential_sync_lane
       WHERE credential_version = ?`
    ).bind(input.credentialVersion).first<{ credential_version: string }>();
    if (recovered?.credential_version !== input.credentialVersion) {
      throw error;
    }
  }
  const before = await session.prepare(
    `SELECT holder_kind, holder_id, lease_claim_id, lease_epoch,
            lease_until, available_after
     FROM github_credential_sync_lane WHERE credential_version = ?`
  )
    .bind(input.credentialVersion)
    .first<LaneRow>();
  if (before === null) {
    throw new Error("The GitHub credential lane disappeared.");
  }
  if (
    before.holder_kind === input.holderKind &&
    before.holder_id === input.holderId &&
    before.lease_claim_id === input.claimId &&
    before.lease_until !== null &&
    before.lease_until > now
  ) {
    return {
      acquired: true,
      token: {
        credentialVersion: input.credentialVersion,
        holderKind: input.holderKind,
        holderId: input.holderId,
        claimId: input.claimId,
        epoch: before.lease_epoch,
        leaseUntil: before.lease_until
      }
    };
  }
  if (
    before.available_after > now ||
    (before.holder_id !== null && (before.lease_until ?? now) > now)
  ) {
    return {
      acquired: false,
      availableAfter: before.available_after,
      leaseUntil: before.lease_until
    };
  }
  const statement = session.prepare(
    `UPDATE github_credential_sync_lane
     SET holder_kind = ?, holder_id = ?, lease_claim_id = ?,
         lease_epoch = lease_epoch + 1, lease_until = ?, updated_at = ?
     WHERE credential_version = ?
       AND lease_epoch = ?
       AND lease_epoch < 9007199254740990
       AND available_after <= ?
       AND (
         holder_id IS NULL
         OR lease_until <= ?
         OR (holder_kind = ? AND holder_id = ? AND lease_claim_id = ?)
       )`
  ).bind(
      input.holderKind,
      input.holderId,
      input.claimId,
      leaseUntil,
      now,
      input.credentialVersion,
      before.lease_epoch,
      now,
      now,
      input.holderKind,
      input.holderId,
      input.claimId
    );
  let result: D1Result;
  try {
    result = await statement.run();
  } catch (error) {
    const recovered = await readGitHubCredentialLane(
      database,
      input.credentialVersion
    );
    if (
      recovered !== null &&
      recovered.holder_kind === input.holderKind &&
      recovered.holder_id === input.holderId &&
      recovered.lease_claim_id === input.claimId &&
      recovered.lease_epoch === before.lease_epoch + 1 &&
      recovered.lease_until === leaseUntil
    ) {
      return {
        acquired: true,
        token: {
          credentialVersion: input.credentialVersion,
          holderKind: input.holderKind,
          holderId: input.holderId,
          claimId: input.claimId,
          epoch: recovered.lease_epoch,
          leaseUntil
        }
      };
    }
    throw error;
  }
  const row = await session.prepare(
    `SELECT holder_kind, holder_id, lease_claim_id, lease_epoch,
            lease_until, available_after
     FROM github_credential_sync_lane WHERE credential_version = ?`
  )
    .bind(input.credentialVersion)
    .first<LaneRow>();
  if (row === null) {
    throw new Error("The GitHub credential lane disappeared.");
  }
  if (
    (result.meta.changes ?? 0) === 1 &&
    row.holder_kind === input.holderKind &&
    row.holder_id === input.holderId &&
    row.lease_claim_id === input.claimId &&
    row.lease_until === leaseUntil &&
    Number.isSafeInteger(row.lease_epoch) &&
    row.lease_epoch > 0
  ) {
    return {
      acquired: true,
      token: {
        credentialVersion: input.credentialVersion,
        holderKind: input.holderKind,
        holderId: input.holderId,
        claimId: input.claimId,
        epoch: row.lease_epoch,
        leaseUntil
      }
    };
  }
  if (
    row.holder_kind === input.holderKind &&
    row.holder_id === input.holderId &&
    row.lease_claim_id === input.claimId &&
    row.lease_until !== null &&
    row.lease_until > now
  ) {
    return {
      acquired: true,
      token: {
        credentialVersion: input.credentialVersion,
        holderKind: input.holderKind,
        holderId: input.holderId,
        claimId: input.claimId,
        epoch: row.lease_epoch,
        leaseUntil: row.lease_until
      }
    };
  }
  return {
    acquired: false,
    availableAfter: row.available_after,
    leaseUntil: row.lease_until
  };
}

async function readGitHubCredentialLane(
  database: D1Database,
  credentialVersion: string
): Promise<LaneRow | null> {
  try {
    return await database.withSession("first-primary").prepare(
      `SELECT holder_kind, holder_id, lease_claim_id, lease_epoch,
              lease_until, available_after
       FROM github_credential_sync_lane WHERE credential_version = ?`
    )
      .bind(credentialVersion)
      .first<LaneRow>();
  } catch {
    return null;
  }
}

export async function releaseGitHubCredentialLane(
  database: D1Database,
  token: GitHubCredentialLaneToken,
  nowMs = Date.now()
): Promise<void> {
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("The GitHub credential lane release time is invalid.");
  }
  const now = new Date(nowMs).toISOString();
  const availableAfter = new Date(
    nowMs + GITHUB_CREDENTIAL_LANE_INTERVAL_MS
  ).toISOString();
  const receiptId = await githubCredentialLaneReleaseReceiptId(token);
  const statements = [
    database.prepare(
      `INSERT INTO github_credential_sync_lane_release_receipts
       (receipt_id, credential_version, holder_kind, holder_id,
        lease_claim_id, lease_epoch, lease_until, released_at, available_after)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM github_credential_sync_lane
         WHERE credential_version = ? AND holder_kind = ? AND holder_id = ?
           AND lease_claim_id = ? AND lease_epoch = ? AND lease_until = ?
       )
       ON CONFLICT(receipt_id) DO NOTHING`
    ).bind(
      receiptId,
      token.credentialVersion,
      token.holderKind,
      token.holderId,
      token.claimId,
      token.epoch,
      token.leaseUntil,
      now,
      availableAfter,
      token.credentialVersion,
      token.holderKind,
      token.holderId,
      token.claimId,
      token.epoch,
      token.leaseUntil
    ),
    database.prepare(
      `UPDATE github_credential_sync_lane
       SET holder_kind = NULL, holder_id = NULL, lease_claim_id = NULL,
           lease_until = NULL, available_after = ?, updated_at = ?
       WHERE credential_version = ? AND holder_kind = ? AND holder_id = ?
         AND lease_claim_id = ? AND lease_epoch = ? AND lease_until = ?`
    ).bind(
      availableAfter,
      now,
      token.credentialVersion,
      token.holderKind,
      token.holderId,
      token.claimId,
      token.epoch,
      token.leaseUntil
    )
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    if (
      await hasExactGitHubCredentialLaneReleaseReceipt(
        database,
        token,
        receiptId
      )
    ) {
      return;
    }
    throw error;
  }
  if (!(await hasExactGitHubCredentialLaneReleaseReceipt(database, token, receiptId))) {
    throw new Error("The GitHub credential lane lease was lost.");
  }
}

async function githubCredentialLaneReleaseReceiptId(
  token: GitHubCredentialLaneToken
): Promise<string> {
  return sha256(
    [
      "github.credential.lane.release",
      token.credentialVersion,
      token.holderKind,
      token.holderId,
      token.claimId,
      String(token.epoch),
      token.leaseUntil
    ].join("\n")
  );
}

async function hasExactGitHubCredentialLaneReleaseReceipt(
  database: D1Database,
  token: GitHubCredentialLaneToken,
  receiptId: string
): Promise<boolean> {
  try {
    const exact = await database.withSession("first-primary").prepare(
      `SELECT 1 AS matches
       FROM github_credential_sync_lane_release_receipts
       WHERE receipt_id = ? AND credential_version = ?
         AND holder_kind = ? AND holder_id = ? AND lease_claim_id = ?
         AND lease_epoch = ? AND lease_until = ?`
    ).bind(
      receiptId,
      token.credentialVersion,
      token.holderKind,
      token.holderId,
      token.claimId,
      token.epoch,
      token.leaseUntil
    ).first<{ matches: number }>();
    return exact?.matches === 1;
  } catch {
    return false;
  }
}

export async function reserveGitHubDispatchRequest(
  database: D1Database,
  dispatchId: string,
  token: GitHubCredentialLaneToken,
  maxRequests: number,
  blockSize = 100
): Promise<number | null> {
  return reserveGitHubWorkflowRequest(database, {
    table: "github_sync_dispatches",
    idColumn: "dispatch_id",
    id: dispatchId,
    requiredStatus: "materialized",
    token,
    maxRequests,
    blockSize
  });
}

export async function reserveGitHubRefRequest(
  database: D1Database,
  itemId: string,
  token: GitHubCredentialLaneToken,
  maxRequests: number,
  blockSize = 100
): Promise<number | null> {
  return reserveGitHubWorkflowRequest(database, {
    table: "github_sync_dispatch_items",
    idColumn: "item_id",
    id: itemId,
    requiredStatus: "running",
    token,
    maxRequests,
    blockSize,
    overflow: {
      column: "github_request_overflow_count",
      primaryLimit: 2_005,
      overflowLimit: MAX_GITHUB_ANNOTATED_TAG_PEEL_REQUESTS
    }
  });
}

async function reserveGitHubWorkflowRequest(
  database: D1Database,
  input: {
    table: "github_sync_dispatches" | "github_sync_dispatch_items";
    idColumn: "dispatch_id" | "item_id";
    id: string;
    requiredStatus: "materialized" | "running";
    token: GitHubCredentialLaneToken;
    maxRequests: number;
    blockSize: number;
    overflow?: {
      column: "github_request_overflow_count";
      primaryLimit: number;
      overflowLimit: number;
    };
  }
): Promise<number | null> {
  if (
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests < 1 ||
    !Number.isSafeInteger(input.blockSize) ||
    input.blockSize < 1 ||
    input.blockSize > 100 ||
    (input.overflow !== undefined &&
      input.maxRequests >
        input.overflow.primaryLimit + input.overflow.overflowLimit)
  ) {
    throw new TypeError("The GitHub Workflow request budget is invalid.");
  }
  const current = await readGitHubWorkflowRequestCount(database, input);
  if (current === null) {
    throw new Error("The GitHub Workflow request budget holder is unavailable.");
  }
  if (current >= input.maxRequests) {
    return null;
  }
  const usesOverflow =
    input.overflow !== undefined && current >= input.overflow.primaryLimit;
  const countColumn = usesOverflow
    ? input.overflow?.column ?? "github_request_count"
    : "github_request_count";
  const currentSegmentCount = usesOverflow
    ? current - (input.overflow?.primaryLimit ?? 0)
    : current;
  const segmentLimit = usesOverflow
    ? Math.min(
        input.maxRequests - (input.overflow?.primaryLimit ?? 0),
        input.overflow?.overflowLimit ?? 0
      )
    : Math.min(input.maxRequests, input.overflow?.primaryLimit ?? input.maxRequests);
  const reserved = Math.min(
    input.blockSize,
    input.maxRequests - current,
    segmentLimit - currentSegmentCount
  );
  if (reserved < 1) {
    throw new Error("The GitHub Workflow request budget segment is invalid.");
  }
  const segmentBoundary =
    input.overflow === undefined
      ? ""
      : usesOverflow
        ? `AND github_request_count = ${input.overflow.primaryLimit}`
        : `AND ${input.overflow.column} = 0`;
  const statement = database.withSession("first-primary").prepare(
    `UPDATE ${input.table}
     SET ${countColumn} = ${countColumn} + ?
     WHERE ${input.idColumn} = ? AND status = ?
       AND ${countColumn} = ? AND ${countColumn} < ?
       ${segmentBoundary}
       AND EXISTS (
         SELECT 1 FROM github_credential_sync_lane AS lane
         WHERE lane.credential_version = ? AND lane.holder_kind = ?
           AND lane.holder_id = ? AND lane.lease_claim_id = ?
           AND lane.lease_epoch = ? AND lane.lease_until = ?
           AND lane.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       )`
  ).bind(
    reserved,
    input.id,
    input.requiredStatus,
    currentSegmentCount,
    segmentLimit,
    input.token.credentialVersion,
    input.token.holderKind,
    input.token.holderId,
    input.token.claimId,
    input.token.epoch,
    input.token.leaseUntil
  );
  try {
    await statement.run();
  } catch (error) {
    const recovered = await readGitHubWorkflowRequestCount(database, input);
    if (recovered === current + reserved) {
      return reserved;
    }
    throw error;
  }
  const after = await readGitHubWorkflowRequestCount(database, input);
  if (after === current + reserved) {
    return reserved;
  }
  if (after !== null && after >= input.maxRequests) {
    return null;
  }
  throw new Error("The GitHub Workflow request budget changed unexpectedly.");
}

async function readGitHubWorkflowRequestCount(
  database: D1Database,
  input: {
    table: "github_sync_dispatches" | "github_sync_dispatch_items";
    idColumn: "dispatch_id" | "item_id";
    id: string;
    requiredStatus: "materialized" | "running";
    token: GitHubCredentialLaneToken;
    overflow?: {
      column: "github_request_overflow_count";
      primaryLimit: number;
      overflowLimit: number;
    };
  }
): Promise<number | null> {
  const countExpression =
    input.overflow === undefined
      ? "github_request_count"
      : `github_request_count + ${input.overflow.column}`;
  const row = await database.withSession("first-primary").prepare(
    `SELECT ${countExpression} AS github_request_count
     FROM ${input.table}
     WHERE ${input.idColumn} = ? AND status = ?
       AND EXISTS (
         SELECT 1 FROM github_credential_sync_lane AS lane
         WHERE lane.credential_version = ? AND lane.holder_kind = ?
           AND lane.holder_id = ? AND lane.lease_claim_id = ?
           AND lane.lease_epoch = ? AND lane.lease_until = ?
           AND lane.lease_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       )`
  ).bind(
    input.id,
    input.requiredStatus,
    input.token.credentialVersion,
    input.token.holderKind,
    input.token.holderId,
    input.token.claimId,
    input.token.epoch,
    input.token.leaseUntil
  ).first<{ github_request_count: number }>();
  return row?.github_request_count ?? null;
}

export async function establishGitHubDispatch(
  database: D1Database,
  input: {
    dispatchId: string;
    credentialVersion: string;
    workflowInstanceId: string;
    scheduledFor: string;
    utcDate: string;
    createdAt: string;
  }
): Promise<"materialized" | "dispatching" | "complete" | "failed"> {
  const session = database.withSession("first-primary");
  const statement = session.prepare(
    `INSERT INTO github_sync_dispatches
     (dispatch_id, credential_version, workflow_instance_id, scheduled_for,
      utc_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'materialized', ?)
     ON CONFLICT(dispatch_id) DO NOTHING`
  ).bind(
      input.dispatchId,
      input.credentialVersion,
      input.workflowInstanceId,
      input.scheduledFor,
      input.utcDate,
      input.createdAt
    );
  try {
    await statement.run();
  } catch (error) {
    const exact = await readExactGitHubDispatch(database, input);
    if (exact === null) {
      throw error;
    }
    return exact;
  }
  const exact = await readExactGitHubDispatch(database, input);
  if (exact === null) {
    throw new Error("The GitHub sync dispatch identity conflicts with stored state.");
  }
  return exact;
}

async function readExactGitHubDispatch(
  database: D1Database,
  input: {
    dispatchId: string;
    credentialVersion: string;
    workflowInstanceId: string;
    scheduledFor: string;
    utcDate: string;
    createdAt: string;
  }
): Promise<"materialized" | "dispatching" | "complete" | "failed" | null> {
  const session = database.withSession("first-primary");
  const exact = await session.prepare(
    `SELECT status FROM github_sync_dispatches
     WHERE dispatch_id = ? AND credential_version = ?
       AND workflow_instance_id = ? AND scheduled_for = ? AND utc_date = ?
       AND created_at = ?
       AND status IN ('materialized', 'dispatching', 'complete', 'failed')`
  )
    .bind(
      input.dispatchId,
      input.credentialVersion,
      input.workflowInstanceId,
      input.scheduledFor,
      input.utcDate,
      input.createdAt
    )
    .first<{ status: "materialized" | "dispatching" | "complete" | "failed" }>();
  return exact?.status ?? null;
}

export async function completeGitHubDispatchMaterialization(
  database: D1Database,
  input: { dispatchId: string; itemCount: number; completedAt: string }
): Promise<void> {
  if (!Number.isSafeInteger(input.itemCount) || input.itemCount < 0) {
    throw new TypeError("The GitHub dispatch item count is invalid.");
  }
  const receiptId = await sha256(
    [
      "github.sync.dispatch.materialization",
      input.dispatchId,
      String(input.itemCount),
      input.completedAt
    ].join("\n")
  );
  const statements = [
    database.prepare(
      `UPDATE github_sync_dispatches
       SET status = 'dispatching'
       WHERE dispatch_id = ? AND status = 'materialized'`
    ).bind(input.dispatchId),
    database.prepare(
      `INSERT INTO github_sync_dispatch_materialization_receipts
       (receipt_id, dispatch_id, item_count, completed_at)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM github_sync_dispatches AS dispatch
         WHERE dispatch.dispatch_id = ?
           AND dispatch.status IN ('dispatching', 'complete')
           AND (
             SELECT COUNT(*) FROM github_sync_dispatch_items AS item
             WHERE item.dispatch_id = dispatch.dispatch_id
           ) = ?
       )
       ON CONFLICT(receipt_id) DO NOTHING`
    ).bind(
      receiptId,
      input.dispatchId,
      input.itemCount,
      input.completedAt,
      input.dispatchId,
      input.itemCount
    )
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    if (
      await hasExactGitHubDispatchMaterialization(
        database,
        input.dispatchId,
        input.itemCount,
        receiptId,
        input.completedAt
      )
    ) {
      return;
    }
    throw error;
  }
  if (
    !(await hasExactGitHubDispatchMaterialization(
      database,
      input.dispatchId,
      input.itemCount,
      receiptId,
      input.completedAt
    ))
  ) {
    throw new Error("The GitHub dispatch materialization was not committed.");
  }
}

export async function hasGitHubDispatchMaterializationReceipt(
  database: D1Database,
  dispatchId: string
): Promise<boolean> {
  const exact = await database.withSession("first-primary").prepare(
    `SELECT 1 AS matches
     FROM github_sync_dispatch_materialization_receipts AS receipt
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = receipt.dispatch_id
     WHERE receipt.dispatch_id = ?
       AND dispatch.status IN ('dispatching', 'complete')
       AND (
         SELECT COUNT(*) FROM github_sync_dispatch_items AS item
         WHERE item.dispatch_id = receipt.dispatch_id
       ) = receipt.item_count
     LIMIT 1`
  ).bind(dispatchId).first<{ matches: number }>();
  return exact?.matches === 1;
}

async function hasExactGitHubDispatchMaterialization(
  database: D1Database,
  dispatchId: string,
  itemCount: number,
  receiptId: string,
  completedAt: string
): Promise<boolean> {
  const exact = await database.withSession("first-primary").prepare(
    `SELECT 1 AS matches
     FROM github_sync_dispatch_materialization_receipts AS receipt
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = receipt.dispatch_id
     WHERE receipt.receipt_id = ? AND receipt.dispatch_id = ?
       AND receipt.item_count = ? AND receipt.completed_at = ?
       AND dispatch.status IN ('dispatching', 'complete')
       AND (
         SELECT COUNT(*) FROM github_sync_dispatch_items AS item
         WHERE item.dispatch_id = receipt.dispatch_id
       ) = receipt.item_count
     LIMIT 1`
  ).bind(
    receiptId,
    dispatchId,
    itemCount,
    completedAt
  ).first<{ matches: number }>();
  return exact?.matches === 1;
}

export async function markGitHubDispatchStatus(
  database: D1Database,
  dispatchId: string,
  status: "dispatching" | "complete" | "failed",
  errorCode: string | null = null,
  completedAt = new Date().toISOString()
): Promise<void> {
  const terminal = status === "complete" || status === "failed";
  const statement = database.withSession("first-primary").prepare(
    `UPDATE github_sync_dispatches
     SET status = ?, completed_at = ?, last_error_code = ?
     WHERE dispatch_id = ? AND status IN ('materialized', 'dispatching')`
  ).bind(status, terminal ? completedAt : null, errorCode, dispatchId);
  let result: D1Result;
  try {
    result = await statement.run();
  } catch (error) {
    if (await hasCompatibleGitHubDispatchStatus(
      database,
      dispatchId,
      status,
      errorCode
    )) {
      return;
    }
    throw error;
  }
  if ((result.meta.changes ?? 0) === 1) {
    return;
  }
  if (!(await hasCompatibleGitHubDispatchStatus(
    database,
    dispatchId,
    status,
    errorCode
  ))) {
    throw new Error("The GitHub sync dispatch status conflicts with stored state.");
  }
}

async function hasCompatibleGitHubDispatchStatus(
  database: D1Database,
  dispatchId: string,
  expectedStatus: "dispatching" | "complete" | "failed",
  errorCode: string | null
): Promise<boolean> {
  try {
    const row = await database.withSession("first-primary").prepare(
      `SELECT status, last_error_code FROM github_sync_dispatches
       WHERE dispatch_id = ?`
    ).bind(dispatchId).first<{ status: string; last_error_code: string | null }>();
    if (row === null) return false;
    if (expectedStatus === "dispatching" && row.status === "complete") return true;
    return row.status === expectedStatus && row.last_error_code === errorCode;
  } catch {
    return false;
  }
}
