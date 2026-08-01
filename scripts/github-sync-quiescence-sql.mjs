import {
  batchWithVerification,
  boundItemIdentity,
  enumValue,
  finishReceiptId,
  hexValue,
  integerValue,
  itemIdentity,
  nullableHex,
  patternValue,
  rejectionReceiptId,
  runIdentity,
  statement,
  textValue,
  timestamp,
  verifyMatchBatch
} from "./github-sync-quiescence-contracts.mjs";

export const QUIESCENCE_BATCH_LIMIT = 20;
export const RECONCILIATION_ERROR = "GITHUB_RECONCILIATION_REQUIRED";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const WORKFLOW_INSTANCE = /^gh[dr]-[0-9a-f]{64}$/u;
export const QUIESCENCE_REQUIRED_TABLES = Object.freeze([
  "github_credential_sync_lane",
  "github_credential_sync_lane_release_receipts",
  "github_repository_sync_finish_receipts",
  "github_repository_sync_runs",
  "github_sync_dispatch_item_rejection_receipts",
  "github_sync_dispatch_items",
  "github_sync_dispatch_materialization_receipts",
  "github_sync_dispatches"
]);
export const QUIESCENCE_REQUIRED_TRIGGERS = Object.freeze([
  "github_credential_sync_lane_release_receipts_insert_guard",
  "github_credential_sync_lane_release_receipts_no_delete",
  "github_credential_sync_lane_release_receipts_no_update",
  "github_credential_sync_lane_no_delete",
  "github_credential_sync_lane_transition_guard",
  "github_credential_sync_lane_version_guard",
  "github_repository_sync_runs_claim_immutable",
  "github_repository_sync_runs_no_delete",
  "github_repository_sync_runs_terminal_immutable",
  "github_repository_sync_finish_receipts_insert_guard",
  "github_repository_sync_finish_receipts_no_delete",
  "github_repository_sync_finish_receipts_no_update",
  "github_sync_dispatch_item_rejection_receipts_insert_guard",
  "github_sync_dispatch_item_rejection_receipts_no_delete",
  "github_sync_dispatch_item_rejection_receipts_no_update",
  "github_sync_dispatch_items_identity_immutable",
  "github_sync_dispatch_items_no_delete",
  "github_sync_dispatch_items_terminal_immutable",
  "github_sync_dispatch_items_transition_guard",
  "github_sync_dispatch_materialization_receipts_insert_guard",
  "github_sync_dispatch_materialization_receipts_no_delete",
  "github_sync_dispatch_materialization_receipts_no_update",
  "github_sync_dispatches_identity_immutable",
  "github_sync_dispatches_no_delete",
  "github_sync_dispatches_terminal_immutable",
  "github_sync_dispatches_transition_guard"
]);
const WORKFLOW_SENTINELS = QUIESCENCE_REQUIRED_TABLES.filter(
  (name) => name !== "github_repository_sync_runs"
);

export async function verifyQuiescenceSchema(runtime) {
  const names = [...QUIESCENCE_REQUIRED_TABLES, ...QUIESCENCE_REQUIRED_TRIGGERS];
  const placeholders = names.map(() => "?").join(", ");
  const { results } = await runtime.query(
    `SELECT type, name FROM sqlite_master
     WHERE type IN ('table', 'trigger') AND name IN (${placeholders})
     ORDER BY type, name`,
    names,
    "Probe GitHub sync quiescence schema"
  );
  const observed = new Map();
  for (const row of results) {
    const type = enumValue(row, "type", ["table", "trigger"]);
    const name = textValue(row, "name", 1, 128);
    if (observed.has(name)) throw new Error("The quiescence schema has a duplicate object.");
    observed.set(name, type);
  }
  if (!WORKFLOW_SENTINELS.some((name) => observed.has(name))) return "absent";
  for (const name of QUIESCENCE_REQUIRED_TABLES) {
    if (observed.get(name) !== "table") {
      throw new Error(`The quiescence schema is missing table ${name}.`);
    }
  }
  for (const name of QUIESCENCE_REQUIRED_TRIGGERS) {
    if (observed.get(name) !== "trigger") {
      throw new Error(`The quiescence schema is missing trigger ${name}.`);
    }
  }
  return "ready";
}

export async function verifyD1ParameterCompatibility(runtime) {
  const { results } = await runtime.query(
    "SELECT typeof(?) AS number_type, typeof(?) AS null_type",
    [1, null],
    "Verify GitHub sync D1 parameter compatibility"
  );
  if (
    results.length !== 1 ||
    results[0]?.number_type !== "integer" ||
    results[0]?.null_type !== "null"
  ) {
    throw new Error("Cloudflare D1 scalar parameter semantics are incompatible.");
  }
}

export async function rejectUnboundDispatchItems(runtime, quiescenceNow) {
  timestamp(quiescenceNow, "quiescence time");
  const { results } = await runtime.query(
    `SELECT item.item_id, item.dispatch_id, dispatch.credential_version,
            item.project_id, item.repository_id, item.ref, item.scheduled_for,
            item.full_reconciliation, item.repository_configuration_version,
            item.cursor_version, item.selected_head_manifest_id,
            item.selected_head_version, item.repository_updated_at,
            item.cursor_status, item.cursor_updated_at, item.workflow_instance_id,
            item.created_at, item.status, item.completed_at
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch ON dispatch.dispatch_id = item.dispatch_id
     WHERE item.run_id IS NULL
       AND (
         (item.status = 'pending' AND item.completed_at IS NULL
           AND item.last_error_code IS NULL)
         OR
         (item.status = 'failed' AND item.completed_at IS NOT NULL
           AND item.last_error_code = ?
           AND NOT EXISTS (
             SELECT 1 FROM github_sync_dispatch_item_rejection_receipts AS receipt
             WHERE receipt.dispatch_item_id = item.item_id
               AND receipt.dispatch_id = item.dispatch_id
               AND receipt.credential_version = dispatch.credential_version
               AND receipt.project_id = item.project_id
               AND receipt.repository_id = item.repository_id
               AND receipt.ref = item.ref
               AND receipt.last_error_code = item.last_error_code
               AND receipt.completed_at = item.completed_at
           ))
       )
     ORDER BY CASE item.status WHEN 'failed' THEN 0 ELSE 1 END,
              item.scheduled_for, item.item_id
     LIMIT ${QUIESCENCE_BATCH_LIMIT}`,
    [RECONCILIATION_ERROR],
    "Load disabled GitHub sync unbound items"
  );
  const candidates = results.map((row) => parseItem(row, quiescenceNow));
  if (candidates.length === 0) return 0;
  const statements = candidates.flatMap(rejectItemStatements);
  await batchWithVerification(
    runtime,
    statements,
    "Reject disabled GitHub sync unbound items",
    () => verifyRejectedItems(runtime, candidates)
  );
  return candidates.length;
}

function parseItem(row, quiescenceNow) {
  const status = enumValue(row, "status", ["pending", "failed"]);
  const candidate = {
    itemId: hexValue(row, "item_id"),
    dispatchId: hexValue(row, "dispatch_id"),
    credentialVersion: textValue(row, "credential_version", 1, 128),
    projectId: textValue(row, "project_id", 1, 128),
    repositoryId: textValue(row, "repository_id", 1, 128),
    ref: textValue(row, "ref", 1, 1024),
    scheduledFor: timestamp(row.scheduled_for, "item scheduled time"),
    fullReconciliation: integerValue(row, "full_reconciliation", 0, 1),
    configurationVersion: integerValue(
      row,
      "repository_configuration_version",
      1,
      Number.MAX_SAFE_INTEGER
    ),
    cursorVersion: integerValue(row, "cursor_version", 1, Number.MAX_SAFE_INTEGER - 1),
    headManifestId: nullableHex(row.selected_head_manifest_id, "selected manifest ID"),
    headVersion: integerValue(row, "selected_head_version", 0, Number.MAX_SAFE_INTEGER - 1),
    repositoryUpdatedAt: timestamp(row.repository_updated_at, "repository update time"),
    cursorStatus: textValue(row, "cursor_status", 1, 64),
    cursorUpdatedAt: timestamp(row.cursor_updated_at, "cursor update time"),
    workflowInstanceId: patternValue(
      row,
      "workflow_instance_id",
      WORKFLOW_INSTANCE,
      "item Workflow instance ID"
    ),
    createdAt: timestamp(row.created_at, "item creation time"),
    completedAt: status === "pending"
      ? quiescenceNow
      : timestamp(row.completed_at, "item recovery time")
  };
  if ((candidate.headVersion === 0) !== (candidate.headManifestId === null)) {
    throw new Error("The unbound item head contract is invalid.");
  }
  if (
    Date.parse(candidate.completedAt) < Date.parse(candidate.createdAt) ||
    Date.parse(candidate.completedAt) > Date.parse(quiescenceNow)
  ) {
    throw new Error("The item recovery completion time is outside the quiescence window.");
  }
  return candidate;
}

function rejectItemStatements(item) {
  const identity = itemIdentity(item, "item");
  const receiptId = rejectionReceiptId(item);
  return [
    statement(
      `UPDATE github_sync_dispatch_items AS item
       SET status = 'failed', completed_at = ?, last_error_code = ?
       WHERE ${identity.sql} AND item.status = 'pending' AND item.run_id IS NULL
         AND EXISTS (
           SELECT 1 FROM github_sync_dispatches AS dispatch
           WHERE dispatch.dispatch_id = item.dispatch_id
             AND dispatch.credential_version = ?
         )`,
      [item.completedAt, RECONCILIATION_ERROR, ...identity.params, item.credentialVersion]
    ),
    statement(
      `INSERT INTO github_sync_dispatch_item_rejection_receipts
         (receipt_id, dispatch_item_id, dispatch_id, credential_version,
          project_id, repository_id, ref, last_error_code, completed_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM github_sync_dispatch_items AS item
         JOIN github_sync_dispatches AS dispatch ON dispatch.dispatch_id = item.dispatch_id
         WHERE ${identity.sql} AND dispatch.credential_version = ?
           AND item.status = 'failed' AND item.run_id IS NULL
           AND item.last_error_code = ? AND item.completed_at = ?
       )
       ON CONFLICT(receipt_id) DO NOTHING`,
      [
        receiptId,
        item.itemId,
        item.dispatchId,
        item.credentialVersion,
        item.projectId,
        item.repositoryId,
        item.ref,
        RECONCILIATION_ERROR,
        item.completedAt,
        ...identity.params,
        item.credentialVersion,
        RECONCILIATION_ERROR,
        item.completedAt
      ]
    )
  ];
}

async function verifyRejectedItems(runtime, candidates) {
  const statements = candidates.map((item) => {
    const identity = itemIdentity(item, "item");
    return statement(
      `SELECT 1 AS matches
       FROM github_sync_dispatch_items AS item
       JOIN github_sync_dispatches AS dispatch ON dispatch.dispatch_id = item.dispatch_id
       JOIN github_sync_dispatch_item_rejection_receipts AS receipt
         ON receipt.dispatch_item_id = item.item_id
       WHERE ${identity.sql} AND dispatch.credential_version = ?
         AND item.status = 'failed' AND item.run_id IS NULL
         AND item.last_error_code = ? AND item.completed_at = ?
         AND receipt.receipt_id = ? AND receipt.dispatch_id = item.dispatch_id
         AND receipt.credential_version = dispatch.credential_version
         AND receipt.project_id = item.project_id
         AND receipt.repository_id = item.repository_id AND receipt.ref = item.ref
         AND receipt.last_error_code = item.last_error_code
         AND receipt.completed_at = item.completed_at
       LIMIT 1`,
      [
        ...identity.params,
        item.credentialVersion,
        RECONCILIATION_ERROR,
        item.completedAt,
        rejectionReceiptId(item)
      ]
    );
  });
  return verifyMatchBatch(
    runtime,
    statements,
    "Verify disabled GitHub sync item rejections"
  );
}

export async function finishUnboundRepositoryRuns(runtime, quiescenceNow) {
  timestamp(quiescenceNow, "quiescence time");
  const { results } = await runtime.query(
    `SELECT run.run_id, run.project_id, run.repository_id, run.scheduled_for,
            run.full_reconciliation, run.started_at, run.lease_expires_at,
            run.claimed_ref, run.claimed_head_manifest_id,
            run.claimed_head_version, run.repository_configuration_version,
            run.cursor_version, MIN(item.completed_at) AS earliest_completed_at,
            MAX(item.completed_at) AS completed_at
     FROM github_repository_sync_runs AS run
     JOIN github_sync_dispatch_items AS item
       ON item.project_id = run.project_id
      AND item.repository_id = run.repository_id
      AND item.ref = run.claimed_ref
      AND item.scheduled_for = run.scheduled_for
      AND item.full_reconciliation = run.full_reconciliation
      AND item.repository_configuration_version = run.repository_configuration_version
      AND item.cursor_version = run.cursor_version
      AND item.selected_head_manifest_id IS run.claimed_head_manifest_id
      AND item.selected_head_version = run.claimed_head_version
     JOIN github_sync_dispatches AS dispatch ON dispatch.dispatch_id = item.dispatch_id
     WHERE run.status = 'running' AND run.completed_at IS NULL
       AND run.last_error_code IS NULL AND run.claim_contract_version = 1
       AND NOT EXISTS (
         SELECT 1 FROM github_sync_dispatch_items AS bound
         WHERE bound.run_id = run.run_id
       )
       AND item.status = 'failed' AND item.run_id IS NULL
       AND item.last_error_code = ?
       AND EXISTS (
         SELECT 1 FROM github_sync_dispatch_item_rejection_receipts AS receipt
         WHERE receipt.dispatch_item_id = item.item_id
           AND receipt.dispatch_id = item.dispatch_id
           AND receipt.credential_version = dispatch.credential_version
           AND receipt.project_id = item.project_id
           AND receipt.repository_id = item.repository_id
           AND receipt.ref = item.ref
           AND receipt.last_error_code = item.last_error_code
           AND receipt.completed_at = item.completed_at
       )
       AND NOT EXISTS (
         SELECT 1
         FROM github_sync_dispatch_items AS missing
         JOIN github_sync_dispatches AS missing_dispatch
           ON missing_dispatch.dispatch_id = missing.dispatch_id
         WHERE missing.project_id = run.project_id
           AND missing.repository_id = run.repository_id
           AND missing.ref = run.claimed_ref
           AND missing.scheduled_for = run.scheduled_for
           AND missing.full_reconciliation = run.full_reconciliation
           AND missing.repository_configuration_version = run.repository_configuration_version
           AND missing.cursor_version = run.cursor_version
           AND missing.selected_head_manifest_id IS run.claimed_head_manifest_id
           AND missing.selected_head_version = run.claimed_head_version
           AND (
             missing.status <> 'failed' OR missing.run_id IS NOT NULL
             OR missing.last_error_code <> ?
             OR NOT EXISTS (
               SELECT 1
               FROM github_sync_dispatch_item_rejection_receipts AS missing_receipt
               WHERE missing_receipt.dispatch_item_id = missing.item_id
                 AND missing_receipt.dispatch_id = missing.dispatch_id
                 AND missing_receipt.credential_version = missing_dispatch.credential_version
                 AND missing_receipt.project_id = missing.project_id
                 AND missing_receipt.repository_id = missing.repository_id
                 AND missing_receipt.ref = missing.ref
                 AND missing_receipt.last_error_code = missing.last_error_code
                 AND missing_receipt.completed_at = missing.completed_at
             )
           )
       )
     GROUP BY run.run_id
     ORDER BY run.scheduled_for, run.run_id
     LIMIT ${QUIESCENCE_BATCH_LIMIT}`,
    [RECONCILIATION_ERROR, RECONCILIATION_ERROR],
    "Load disabled GitHub sync unbound runs"
  );
  const candidates = results.map((row) => parseUnboundRun(row, quiescenceNow));
  if (candidates.length === 0) return 0;
  const statements = candidates.map((run) => {
    const identity = runIdentity(run, "run");
    return statement(
      `UPDATE github_repository_sync_runs AS run
       SET status = 'failed', completed_at = ?, last_error_code = ?
       WHERE ${identity.sql} AND run.status = 'running'
         AND run.completed_at IS NULL AND run.last_error_code IS NULL
         AND run.claim_contract_version = 1
         AND NOT EXISTS (
           SELECT 1 FROM github_sync_dispatch_items AS bound
           WHERE bound.run_id = run.run_id
         )
         AND EXISTS (${exactRejectedRunItemsSql("run")})
         AND NOT EXISTS (${missingRejectedRunItemsSql("run")})`,
      [
        run.completedAt,
        RECONCILIATION_ERROR,
        ...identity.params,
        RECONCILIATION_ERROR,
        run.completedAt,
        RECONCILIATION_ERROR,
        run.completedAt
      ]
    );
  });
  await batchWithVerification(
    runtime,
    statements,
    "Finish disabled GitHub sync unbound runs",
    () => verifyUnboundRuns(runtime, candidates)
  );
  return candidates.length;
}

function exactRejectedRunItemsSql(runAlias) {
  return `SELECT 1
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch ON dispatch.dispatch_id = item.dispatch_id
     JOIN github_sync_dispatch_item_rejection_receipts AS receipt
       ON receipt.dispatch_item_id = item.item_id
     WHERE item.project_id = ${runAlias}.project_id
       AND item.repository_id = ${runAlias}.repository_id
       AND item.ref = ${runAlias}.claimed_ref
       AND item.scheduled_for = ${runAlias}.scheduled_for
       AND item.full_reconciliation = ${runAlias}.full_reconciliation
       AND item.repository_configuration_version = ${runAlias}.repository_configuration_version
       AND item.cursor_version = ${runAlias}.cursor_version
       AND item.selected_head_manifest_id IS ${runAlias}.claimed_head_manifest_id
       AND item.selected_head_version = ${runAlias}.claimed_head_version
       AND item.status = 'failed' AND item.run_id IS NULL
       AND item.last_error_code = ?
       AND item.completed_at >= ${runAlias}.started_at AND item.completed_at <= ?
       AND receipt.dispatch_id = item.dispatch_id
       AND receipt.credential_version = dispatch.credential_version
       AND receipt.project_id = item.project_id
       AND receipt.repository_id = item.repository_id AND receipt.ref = item.ref
       AND receipt.last_error_code = item.last_error_code
       AND receipt.completed_at = item.completed_at`;
}

function missingRejectedRunItemsSql(runAlias) {
  return `SELECT 1
     FROM github_sync_dispatch_items AS item
     JOIN github_sync_dispatches AS dispatch ON dispatch.dispatch_id = item.dispatch_id
     WHERE item.project_id = ${runAlias}.project_id
       AND item.repository_id = ${runAlias}.repository_id
       AND item.ref = ${runAlias}.claimed_ref
       AND item.scheduled_for = ${runAlias}.scheduled_for
       AND item.full_reconciliation = ${runAlias}.full_reconciliation
       AND item.repository_configuration_version = ${runAlias}.repository_configuration_version
       AND item.cursor_version = ${runAlias}.cursor_version
       AND item.selected_head_manifest_id IS ${runAlias}.claimed_head_manifest_id
       AND item.selected_head_version = ${runAlias}.claimed_head_version
       AND (
         item.status <> 'failed' OR item.run_id IS NOT NULL
         OR item.last_error_code <> ?
         OR item.completed_at < ${runAlias}.started_at OR item.completed_at > ?
         OR NOT EXISTS (
           SELECT 1 FROM github_sync_dispatch_item_rejection_receipts AS receipt
           WHERE receipt.dispatch_item_id = item.item_id
             AND receipt.dispatch_id = item.dispatch_id
             AND receipt.credential_version = dispatch.credential_version
             AND receipt.project_id = item.project_id
             AND receipt.repository_id = item.repository_id AND receipt.ref = item.ref
             AND receipt.last_error_code = item.last_error_code
             AND receipt.completed_at = item.completed_at
         )
       )`;
}

function parseRun(row) {
  const run = {
    runId: textValue(row, "run_id", 1, 128),
    projectId: textValue(row, "project_id", 1, 128),
    repositoryId: textValue(row, "repository_id", 1, 128),
    scheduledFor: timestamp(row.scheduled_for, "run scheduled time"),
    fullReconciliation: integerValue(row, "full_reconciliation", 0, 1),
    startedAt: timestamp(row.started_at, "run start time"),
    leaseExpiresAt: timestamp(row.lease_expires_at, "run lease expiry"),
    ref: textValue(row, "claimed_ref", 1, 1024),
    headManifestId: nullableHex(row.claimed_head_manifest_id, "claimed manifest ID"),
    headVersion: integerValue(row, "claimed_head_version", 0, Number.MAX_SAFE_INTEGER - 1),
    configurationVersion: integerValue(
      row,
      "repository_configuration_version",
      1,
      Number.MAX_SAFE_INTEGER
    ),
    cursorVersion: integerValue(row, "cursor_version", 1, Number.MAX_SAFE_INTEGER - 1),
    completedAt: timestamp(row.completed_at, "run recovery time")
  };
  if ((run.headVersion === 0) !== (run.headManifestId === null)) {
    throw new Error("The repository run head contract is invalid.");
  }
  return run;
}

function parseUnboundRun(row, quiescenceNow) {
  const run = parseRun(row);
  const earliestCompletedAt = timestamp(
    row.earliest_completed_at,
    "earliest run recovery time"
  );
  if (
    Date.parse(earliestCompletedAt) < Date.parse(run.startedAt) ||
    Date.parse(run.completedAt) > Date.parse(quiescenceNow)
  ) {
    throw new Error("The unbound recovery completion time is outside the quiescence window.");
  }
  return run;
}

async function verifyUnboundRuns(runtime, candidates) {
  const statements = candidates.map((run) => {
    const identity = runIdentity(run, "run");
    return statement(
      `SELECT 1 AS matches FROM github_repository_sync_runs AS run
       WHERE ${identity.sql} AND run.claim_contract_version = 1
         AND run.status = 'failed' AND run.completed_at = ?
         AND run.last_error_code = ?
         AND NOT EXISTS (
           SELECT 1 FROM github_sync_dispatch_items AS bound
           WHERE bound.run_id = run.run_id
         )
       LIMIT 1`,
      [...identity.params, run.completedAt, RECONCILIATION_ERROR]
    );
  });
  return verifyMatchBatch(
    runtime,
    statements,
    "Verify disabled GitHub sync unbound runs"
  );
}

export async function finishBoundRepositoryRuns(runtime, quiescenceNow) {
  timestamp(quiescenceNow, "quiescence time");
  const { results } = await runtime.query(
    `SELECT run.run_id, run.project_id, run.repository_id, run.scheduled_for,
            run.full_reconciliation, run.started_at, run.lease_expires_at,
            run.claimed_ref, run.claimed_head_manifest_id,
            run.claimed_head_version, run.repository_configuration_version,
            run.cursor_version, run.status AS run_status,
            run.completed_at AS run_completed_at,
            run.last_error_code AS run_error_code,
            item.item_id, item.dispatch_id, dispatch.credential_version,
            item.repository_updated_at, item.cursor_status, item.cursor_updated_at,
            item.workflow_instance_id, item.created_at AS item_created_at,
            item.status AS item_status, item.completed_at AS item_completed_at,
            item.last_error_code AS item_error_code
     FROM github_repository_sync_runs AS run
     JOIN github_sync_dispatch_items AS item ON item.run_id = run.run_id
     JOIN github_sync_dispatches AS dispatch ON dispatch.dispatch_id = item.dispatch_id
     WHERE run.claim_contract_version = 1
       AND run.status IN ('running', 'complete', 'failed')
       AND item.status IN ('running', 'complete', 'failed')
       AND item.project_id = run.project_id
       AND item.repository_id = run.repository_id
       AND item.ref = run.claimed_ref
       AND item.scheduled_for = run.scheduled_for
       AND item.full_reconciliation = run.full_reconciliation
       AND item.repository_configuration_version = run.repository_configuration_version
       AND item.cursor_version = run.cursor_version
       AND item.selected_head_manifest_id IS run.claimed_head_manifest_id
       AND item.selected_head_version = run.claimed_head_version
       AND NOT EXISTS (
         SELECT 1 FROM github_repository_sync_finish_receipts AS receipt
         WHERE receipt.run_id = run.run_id AND receipt.dispatch_item_id = item.item_id
           AND receipt.project_id = item.project_id
           AND receipt.repository_id = item.repository_id AND receipt.ref = item.ref
           AND receipt.status = item.status
           AND receipt.last_error_code IS item.last_error_code
           AND receipt.completed_at = item.completed_at
       )
     ORDER BY run.scheduled_for, run.run_id
     LIMIT ${QUIESCENCE_BATCH_LIMIT}`,
    [],
    "Load disabled GitHub sync bound runs"
  );
  const candidates = results.map((row) => parseBoundCandidate(row, quiescenceNow));
  if (candidates.length === 0) return 0;
  const statements = candidates.flatMap(finishBoundStatements);
  await batchWithVerification(
    runtime,
    statements,
    "Finish disabled GitHub sync bound runs",
    () => verifyBoundCandidates(runtime, candidates)
  );
  return candidates.length;
}

function parseBoundCandidate(row, quiescenceNow) {
  const runStatus = enumValue(row, "run_status", ["running", "complete", "failed"]);
  const itemStatus = enumValue(row, "item_status", ["running", "complete", "failed"]);
  const runCompletedAt = terminalCompletion(
    runStatus,
    row.run_completed_at,
    "run completion time"
  );
  const itemCompletedAt = terminalCompletion(
    itemStatus,
    row.item_completed_at,
    "item completion time"
  );
  const runErrorCode = terminalErrorCode(runStatus, row.run_error_code, "run_error_code");
  const itemErrorCode = terminalErrorCode(itemStatus, row.item_error_code, "item_error_code");
  const itemCreatedAt = timestamp(row.item_created_at, "bound item creation time");
  const run = parseRun({
    ...row,
    completed_at:
      row.run_status !== "running"
        ? runCompletedAt
        : row.item_status !== "running"
          ? itemCompletedAt
          : quiescenceNow
  });
  const targetStatus = runStatus !== "running"
    ? runStatus
    : itemStatus !== "running"
      ? itemStatus
      : "failed";
  const errorCode = targetStatus === "complete"
    ? null
    : runStatus === "failed"
      ? runErrorCode
      : itemStatus === "failed"
        ? itemErrorCode
        : RECONCILIATION_ERROR;
  for (const completedAt of [runCompletedAt, itemCompletedAt]) {
    if (
      completedAt !== null &&
      (Date.parse(completedAt) < Math.max(
        Date.parse(run.startedAt),
        Date.parse(itemCreatedAt)
      ) ||
        Date.parse(completedAt) > Date.parse(quiescenceNow))
    ) {
      throw new Error("A bound terminal completion time is outside the quiescence window.");
    }
  }
  if (
    Date.parse(run.completedAt) < Math.max(
      Date.parse(run.startedAt),
      Date.parse(itemCreatedAt)
    ) ||
    Date.parse(run.completedAt) > Date.parse(quiescenceNow)
  ) {
    throw new Error("The bound recovery completion time is outside the quiescence window.");
  }
  return {
    ...run,
    errorCode,
    targetStatus,
    runStatus,
    itemStatus,
    itemId: hexValue(row, "item_id"),
    dispatchId: hexValue(row, "dispatch_id"),
    credentialVersion: textValue(row, "credential_version", 1, 128),
    repositoryUpdatedAt: timestamp(row.repository_updated_at, "repository update time"),
    cursorStatus: textValue(row, "cursor_status", 1, 64),
    cursorUpdatedAt: timestamp(row.cursor_updated_at, "cursor update time"),
    workflowInstanceId: patternValue(
      row,
      "workflow_instance_id",
      WORKFLOW_INSTANCE,
      "bound item Workflow instance ID"
    ),
    itemCreatedAt
  };
}

function terminalCompletion(status, value, label) {
  if (status === "running") {
    if (value !== null) throw new Error(`The running ${label} must be empty.`);
    return null;
  }
  return timestamp(value, label);
}

function terminalErrorCode(status, value, name) {
  if (status === "failed") return textValue({ [name]: value }, name, 1, 128);
  if (value !== null) throw new Error(`The non-failed ${name} must be empty.`);
  return null;
}

function finishBoundStatements(candidate) {
  const run = runIdentity(candidate, "run");
  const item = boundItemIdentity(candidate, "item");
  const receiptId = finishReceiptId(candidate);
  return [
    statement(
      `UPDATE github_repository_sync_runs AS run
       SET status = ?, completed_at = ?, last_error_code = ?
       WHERE ${run.sql} AND run.claim_contract_version = 1
         AND run.status = 'running' AND run.completed_at IS NULL
         AND run.last_error_code IS NULL
         AND EXISTS (
           SELECT 1 FROM github_sync_dispatch_items AS item
           WHERE ${item.sql} AND item.run_id = run.run_id
             AND item.status IN ('running', 'complete', 'failed')
         )`,
      [
        candidate.targetStatus,
        candidate.completedAt,
        candidate.errorCode,
        ...run.params,
        ...item.params
      ]
    ),
    statement(
      `UPDATE github_sync_dispatch_items AS item
       SET status = ?, completed_at = ?, last_error_code = ?
       WHERE ${item.sql} AND item.status = 'running' AND item.run_id = ?
         AND EXISTS (
           SELECT 1 FROM github_repository_sync_runs AS run
           WHERE ${run.sql} AND run.claim_contract_version = 1
             AND run.status = ? AND run.completed_at = ?
             AND run.last_error_code IS ?
         )`,
      [
        candidate.targetStatus,
        candidate.completedAt,
        candidate.errorCode,
        ...item.params,
        candidate.runId,
        ...run.params,
        candidate.targetStatus,
        candidate.completedAt,
        candidate.errorCode
      ]
    ),
    statement(
      `INSERT INTO github_repository_sync_finish_receipts
         (receipt_id, run_id, dispatch_item_id, project_id, repository_id, ref,
          status, last_error_code, completed_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1
         FROM github_repository_sync_runs AS run
         JOIN github_sync_dispatch_items AS item ON item.run_id = run.run_id
         WHERE ${run.sql} AND ${item.sql}
           AND run.claim_contract_version = 1
           AND run.status = ? AND item.status = run.status
           AND run.completed_at = ? AND item.completed_at = run.completed_at
           AND run.last_error_code IS ?
           AND item.last_error_code IS run.last_error_code
       )
       ON CONFLICT(receipt_id) DO NOTHING`,
      [
        receiptId,
        candidate.runId,
        candidate.itemId,
        candidate.projectId,
        candidate.repositoryId,
        candidate.ref,
        candidate.targetStatus,
        candidate.errorCode,
        candidate.completedAt,
        ...run.params,
        ...item.params,
        candidate.targetStatus,
        candidate.completedAt,
        candidate.errorCode
      ]
    )
  ];
}

async function verifyBoundCandidates(runtime, candidates) {
  const statements = candidates.map((candidate) => {
    const run = runIdentity(candidate, "run");
    const item = boundItemIdentity(candidate, "item");
    return statement(
      `SELECT 1 AS matches
       FROM github_repository_sync_runs AS run
       JOIN github_sync_dispatch_items AS item ON item.run_id = run.run_id
       JOIN github_repository_sync_finish_receipts AS receipt
         ON receipt.run_id = run.run_id AND receipt.dispatch_item_id = item.item_id
       WHERE ${run.sql} AND ${item.sql}
         AND run.claim_contract_version = 1
         AND run.status = ? AND item.status = run.status
         AND run.completed_at = ? AND item.completed_at = run.completed_at
         AND run.last_error_code IS ? AND item.last_error_code IS run.last_error_code
         AND receipt.receipt_id = ? AND receipt.project_id = item.project_id
         AND receipt.repository_id = item.repository_id AND receipt.ref = item.ref
         AND receipt.status = item.status
         AND receipt.last_error_code IS item.last_error_code
         AND receipt.completed_at = item.completed_at
       LIMIT 1`,
      [
        ...run.params,
        ...item.params,
        candidate.targetStatus,
        candidate.completedAt,
        candidate.errorCode,
        finishReceiptId(candidate)
      ]
    );
  });
  return verifyMatchBatch(
    runtime,
    statements,
    "Verify disabled GitHub sync bound finishes"
  );
}
