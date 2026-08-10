import {
  batchWithVerification,
  enumValue,
  hexValue,
  integerValue,
  laneReleaseReceiptId,
  patternValue,
  statement,
  textValue,
  timestamp,
  verifyMatchBatch
} from "./github-sync-quiescence-contracts.mjs";
import { QUIESCENCE_BATCH_LIMIT, RECONCILIATION_ERROR } from "./github-sync-quiescence-sql.mjs";

const WORKFLOW_INSTANCE = /^gh[dr]-[0-9a-f]{64}$/u;

export async function closeInactiveDispatches(runtime, quiescenceNow) {
  timestamp(quiescenceNow, "quiescence time");
  const drift = await runtime.query(
    `SELECT dispatch.dispatch_id
     FROM github_sync_dispatches AS dispatch
     LEFT JOIN github_sync_dispatch_materialization_receipts AS receipt
       ON receipt.dispatch_id = dispatch.dispatch_id
     WHERE dispatch.status IN ('materialized', 'dispatching')
       AND (
         (receipt.dispatch_id IS NOT NULL AND (
           receipt.item_count <> (
             SELECT COUNT(*) FROM github_sync_dispatch_items AS item
             WHERE item.dispatch_id = dispatch.dispatch_id
           )
           OR receipt.completed_at < dispatch.created_at
           OR receipt.completed_at > ?
         ))
         OR EXISTS (
           SELECT 1 FROM github_sync_dispatch_items AS terminal
           WHERE terminal.dispatch_id = dispatch.dispatch_id
             AND terminal.status IN ('complete', 'failed')
             AND (terminal.completed_at < dispatch.created_at
               OR terminal.completed_at < terminal.created_at
               OR terminal.completed_at > ?
               OR (receipt.dispatch_id IS NOT NULL
                 AND terminal.completed_at < receipt.completed_at)
               OR (terminal.run_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM github_repository_sync_runs AS run
                 WHERE run.run_id = terminal.run_id
                   AND (run.status IS NOT terminal.status
                     OR run.completed_at IS NOT terminal.completed_at
                     OR run.last_error_code IS NOT terminal.last_error_code
                     OR run.completed_at < run.started_at
                     OR run.completed_at > ?)
               )))
         )
       )
     ORDER BY dispatch.dispatch_id LIMIT 1`,
    [quiescenceNow, quiescenceNow, quiescenceNow],
    "Verify disabled GitHub sync materialization receipts"
  );
  if (drift.results.length !== 0) {
    throw new Error("A GitHub sync materialization receipt does not match its dispatch ledger.");
  }
  const { results } = await runtime.query(
    `SELECT dispatch.dispatch_id, dispatch.credential_version,
            dispatch.workflow_instance_id, dispatch.scheduled_for,
            dispatch.created_at, dispatch.status,
            CASE
              WHEN materialized.dispatch_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM github_sync_dispatch_items AS failed
                 WHERE failed.dispatch_id = dispatch.dispatch_id
                   AND failed.status = 'failed'
               )
              THEN 'complete' ELSE 'failed'
            END AS target_status,
            COALESCE((
              SELECT MAX(item.completed_at)
              FROM github_sync_dispatch_items AS item
              WHERE item.dispatch_id = dispatch.dispatch_id
            ), ?) AS completed_at
     FROM github_sync_dispatches AS dispatch
     LEFT JOIN github_sync_dispatch_materialization_receipts AS materialized
       ON materialized.dispatch_id = dispatch.dispatch_id
     WHERE dispatch.status IN ('materialized', 'dispatching')
       AND dispatch.created_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM github_sync_dispatch_items AS active
         WHERE active.dispatch_id = dispatch.dispatch_id
           AND active.status IN ('pending', 'running')
       )
       AND NOT EXISTS (
         SELECT 1 FROM github_sync_dispatch_items AS terminal
         WHERE terminal.dispatch_id = dispatch.dispatch_id
           AND terminal.status IN ('complete', 'failed')
           AND NOT (
             (terminal.status = 'failed' AND terminal.run_id IS NULL AND EXISTS (
               SELECT 1 FROM github_sync_dispatch_item_rejection_receipts AS rejection
               WHERE rejection.dispatch_item_id = terminal.item_id
                 AND rejection.dispatch_id = terminal.dispatch_id
                 AND rejection.credential_version = dispatch.credential_version
                 AND rejection.project_id = terminal.project_id
                 AND rejection.repository_id = terminal.repository_id
                 AND rejection.ref = terminal.ref
                 AND rejection.last_error_code = terminal.last_error_code
                 AND rejection.completed_at = terminal.completed_at
             ))
             OR
             (terminal.run_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM github_repository_sync_finish_receipts AS finish
               WHERE finish.dispatch_item_id = terminal.item_id
                 AND finish.run_id = terminal.run_id
                 AND finish.project_id = terminal.project_id
                 AND finish.repository_id = terminal.repository_id
                 AND finish.ref = terminal.ref AND finish.status = terminal.status
                 AND finish.last_error_code IS terminal.last_error_code
                 AND finish.completed_at = terminal.completed_at
             ))
           )
       )
     ORDER BY dispatch.scheduled_for, dispatch.dispatch_id
     LIMIT ${QUIESCENCE_BATCH_LIMIT}`,
    [quiescenceNow, quiescenceNow],
    "Load closable disabled GitHub sync dispatches"
  );
  const candidates = results.map((row) => parseDispatch(row, quiescenceNow));
  if (candidates.length === 0) return 0;
  const statements = candidates.map(closeDispatchStatement);
  await batchWithVerification(
    runtime,
    statements,
    "Close disabled GitHub sync dispatches",
    () => verifyDispatches(runtime, candidates)
  );
  return candidates.length;
}

function parseDispatch(row, quiescenceNow) {
  const dispatch = {
    dispatchId: hexValue(row, "dispatch_id"),
    credentialVersion: textValue(row, "credential_version", 1, 128),
    workflowInstanceId: patternValue(
      row,
      "workflow_instance_id",
      WORKFLOW_INSTANCE,
      "dispatch Workflow instance ID"
    ),
    scheduledFor: timestamp(row.scheduled_for, "dispatch scheduled time"),
    createdAt: timestamp(row.created_at, "dispatch creation time"),
    currentStatus: enumValue(row, "status", ["materialized", "dispatching"]),
    targetStatus: enumValue(row, "target_status", ["complete", "failed"]),
    completedAt: timestamp(row.completed_at, "dispatch completion time"),
    quiescenceNow
  };
  if (
    Date.parse(dispatch.completedAt) < Date.parse(dispatch.createdAt) ||
    Date.parse(dispatch.completedAt) > Date.parse(quiescenceNow)
  ) {
    throw new Error("The dispatch completion time is outside the quiescence window.");
  }
  return dispatch;
}

function closeDispatchStatement(dispatch) {
  return statement(
    `UPDATE github_sync_dispatches AS dispatch
     SET status = ?, completed_at = ?, last_error_code = ?
     WHERE dispatch.dispatch_id = ? AND dispatch.credential_version = ?
       AND dispatch.workflow_instance_id = ? AND dispatch.scheduled_for = ?
       AND dispatch.created_at = ? AND dispatch.status = ?
       AND NOT EXISTS (
         SELECT 1 FROM github_sync_dispatch_items AS active
         WHERE active.dispatch_id = dispatch.dispatch_id
           AND active.status IN ('pending', 'running')
       )
       AND (CASE
         WHEN EXISTS (
           SELECT 1 FROM github_sync_dispatch_materialization_receipts AS materialized
           WHERE materialized.dispatch_id = dispatch.dispatch_id
             AND materialized.item_count = (
               SELECT COUNT(*) FROM github_sync_dispatch_items AS counted
               WHERE counted.dispatch_id = dispatch.dispatch_id
             )
             AND materialized.completed_at >= dispatch.created_at
             AND materialized.completed_at <= ?
         ) AND NOT EXISTS (
           SELECT 1 FROM github_sync_dispatch_items AS failed
           WHERE failed.dispatch_id = dispatch.dispatch_id AND failed.status = 'failed'
         ) THEN 'complete' ELSE 'failed' END) = ?`,
    [
      dispatch.targetStatus,
      dispatch.completedAt,
      dispatch.targetStatus === "failed" ? RECONCILIATION_ERROR : null,
      dispatch.dispatchId,
      dispatch.credentialVersion,
      dispatch.workflowInstanceId,
      dispatch.scheduledFor,
      dispatch.createdAt,
      dispatch.currentStatus,
      dispatch.quiescenceNow,
      dispatch.targetStatus
    ]
  );
}

async function verifyDispatches(runtime, candidates) {
  const statements = candidates.map((dispatch) =>
    statement(
      `SELECT 1 AS matches FROM github_sync_dispatches
       WHERE dispatch_id = ? AND credential_version = ?
         AND workflow_instance_id = ? AND scheduled_for = ? AND created_at = ?
         AND status = ? AND completed_at = ? AND last_error_code IS ?
       LIMIT 1`,
      [
        dispatch.dispatchId,
        dispatch.credentialVersion,
        dispatch.workflowInstanceId,
        dispatch.scheduledFor,
        dispatch.createdAt,
        dispatch.targetStatus,
        dispatch.completedAt,
        dispatch.targetStatus === "failed" ? RECONCILIATION_ERROR : null
      ]
    )
  );
  return verifyMatchBatch(
    runtime,
    statements,
    "Verify disabled GitHub sync dispatch closures"
  );
}

export async function releaseInactiveCredentialLanes(runtime, quiescenceNow) {
  timestamp(quiescenceNow, "quiescence time");
  const { results } = await runtime.query(
    `SELECT lane.credential_version, lane.holder_kind, lane.holder_id,
            lane.lease_claim_id, lane.lease_epoch, lane.lease_until,
            lane.updated_at
     FROM github_credential_sync_lane AS lane
     WHERE lane.holder_kind IS NOT NULL AND lane.holder_id IS NOT NULL
       AND lane.lease_claim_id IS NOT NULL AND lane.lease_until IS NOT NULL
       AND lane.updated_at <= ?
     ORDER BY lane.updated_at, lane.credential_version
     LIMIT ${QUIESCENCE_BATCH_LIMIT}`,
    [quiescenceNow],
    "Load releasable disabled GitHub sync credential lanes"
  );
  const candidates = results.map((row) => parseLane(row, quiescenceNow));
  if (candidates.length === 0) return 0;
  const statements = candidates.flatMap(releaseLaneStatements);
  await batchWithVerification(
    runtime,
    statements,
    "Release disabled GitHub sync credential lanes",
    () => verifyLanes(runtime, candidates)
  );
  return candidates.length;
}

function parseLane(row, quiescenceNow) {
  const lane = {
    credentialVersion: textValue(row, "credential_version", 1, 128),
    holderKind: enumValue(row, "holder_kind", ["dispatch", "ref"]),
    holderId: textValue(row, "holder_id", 1, 128),
    claimId: hexValue(row, "lease_claim_id"),
    epoch: integerValue(row, "lease_epoch", 1, Number.MAX_SAFE_INTEGER - 1),
    leaseUntil: timestamp(row.lease_until, "credential lane lease expiry"),
    updatedAt: timestamp(row.updated_at, "credential lane update time"),
    releasedAt: quiescenceNow,
    availableAfter: new Date(Date.parse(quiescenceNow) + 80).toISOString()
  };
  if (Date.parse(lane.releasedAt) < Date.parse(lane.updatedAt)) {
    throw new Error("The credential lane release precedes its active token.");
  }
  return lane;
}

function releaseLaneStatements(lane) {
  const receiptId = laneReleaseReceiptId(lane);
  const tokenParams = [
    lane.credentialVersion,
    lane.holderKind,
    lane.holderId,
    lane.claimId,
    lane.epoch,
    lane.leaseUntil
  ];
  return [
    statement(
      `INSERT INTO github_credential_sync_lane_release_receipts
         (receipt_id, credential_version, holder_kind, holder_id,
          lease_claim_id, lease_epoch, lease_until, released_at, available_after)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM github_credential_sync_lane
         WHERE credential_version = ? AND holder_kind = ? AND holder_id = ?
           AND lease_claim_id = ? AND lease_epoch = ? AND lease_until = ?
       )
       ON CONFLICT(receipt_id) DO NOTHING`,
      [
        receiptId,
        ...tokenParams,
        lane.releasedAt,
        lane.availableAfter,
        ...tokenParams
      ]
    ),
    statement(
      `UPDATE github_credential_sync_lane AS lane
       SET holder_kind = NULL, holder_id = NULL, lease_claim_id = NULL,
           lease_until = NULL,
           available_after = (
             SELECT receipt.available_after
             FROM github_credential_sync_lane_release_receipts AS receipt
             WHERE receipt.receipt_id = ? AND receipt.credential_version = ?
               AND receipt.holder_kind = ? AND receipt.holder_id = ?
               AND receipt.lease_claim_id = ? AND receipt.lease_epoch = ?
               AND receipt.lease_until = ?
           ),
           updated_at = (
             SELECT receipt.released_at
             FROM github_credential_sync_lane_release_receipts AS receipt
             WHERE receipt.receipt_id = ? AND receipt.credential_version = ?
               AND receipt.holder_kind = ? AND receipt.holder_id = ?
               AND receipt.lease_claim_id = ? AND receipt.lease_epoch = ?
               AND receipt.lease_until = ?
           )
       WHERE lane.credential_version = ? AND lane.holder_kind = ?
         AND lane.holder_id = ? AND lane.lease_claim_id = ?
         AND lane.lease_epoch = ? AND lane.lease_until = ?`,
      [receiptId, ...tokenParams, receiptId, ...tokenParams, ...tokenParams]
    )
  ];
}

async function verifyLanes(runtime, candidates) {
  const statements = candidates.map((lane) =>
    statement(
      `SELECT 1 AS matches
       FROM github_credential_sync_lane_release_receipts AS receipt
       JOIN github_credential_sync_lane AS current
         ON current.credential_version = receipt.credential_version
       WHERE receipt.receipt_id = ? AND receipt.credential_version = ?
         AND receipt.holder_kind = ? AND receipt.holder_id = ?
         AND receipt.lease_claim_id = ? AND receipt.lease_epoch = ?
         AND receipt.lease_until = ?
         AND receipt.released_at = ? AND receipt.available_after = ?
         AND current.holder_kind IS NULL AND current.holder_id IS NULL
         AND current.lease_claim_id IS NULL AND current.lease_until IS NULL
         AND current.lease_epoch = receipt.lease_epoch
         AND current.updated_at = receipt.released_at
         AND current.available_after = receipt.available_after
       LIMIT 1`,
      [
        laneReleaseReceiptId(lane),
        lane.credentialVersion,
        lane.holderKind,
        lane.holderId,
        lane.claimId,
        lane.epoch,
        lane.leaseUntil,
        lane.releasedAt,
        lane.availableAfter
      ]
    )
  );
  return verifyMatchBatch(
    runtime,
    statements,
    "Verify disabled GitHub sync credential lane releases"
  );
}
