import { createHash } from "node:crypto";
export const PROJECTION_REBUILD_SQL_BATCH_SIZE = 50;
export const PROJECTION_REBUILD_QUERY_BATCH_SIZE = 250;
export const PROJECTION_REBUILD_MAX_EXECUTION_ORDINAL = 9_999;
export const PROJECTION_REBUILD_DISPATCH_EVENTS_PER_MINUTE = 250;
export const PROJECTION_REBUILD_SETTLE_SECONDS = 600;
export const PROJECTION_REBUILD_EVENT_TYPE = "projection.rebuild.requested";
export const PROJECTION_REBUILD_STEP_ATTEMPTS = 3;
export const PROJECTION_REBUILD_WORKFLOW_SUBREQUEST_LIMIT = 50_000;
export const PROJECTION_REBUILD_SAFE_SUBREQUEST_LIMIT = 45_000;
export const PROJECTION_REBUILD_MAX_SNAPSHOT_CONTENT_BYTES = 16 * 1024 * 1024;
export const PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_WRITES = 29;
export const PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_SUBREQUESTS = 14;
export const PROJECTION_REBUILD_WORKFLOW_FIXED_RETRIED_SUBREQUESTS = 14;
const PROJECTION_MODES = new Set(["snapshot", "search", "delete"]);
const TERMINAL_WORKFLOW_STATUSES = new Set(["complete", "failed", "terminated"]);
const PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN =
  "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN";
const COMMON_DESCRIPTOR_KEYS = [
  "projectionMode", "projectId", "projectVersion", "searchGenerationId", "projectionTargetId"
];
const MODE_DESCRIPTOR_KEYS = {
  snapshot: ["contentBytes", "headDigest", "memoryCount", "revisionCount", "scopeCount"],
  search: ["memoryId", "repositoryPartition", "revisionId"],
  delete: ["memoryId", "revisionId", "searchProjectVersion"]
};

export function projectionRebuildDescriptors(target) {
  requireTarget(target);
  const headDigest = projectionRebuildHeadDigest(target.memory_heads);
  const descriptors = [
    createDescriptor({
      projectionMode: "snapshot",
      projectId: target.project_id,
      projectVersion: target.project_version,
      searchGenerationId: target.search_generation_id,
      memoryCount: target.memory_count,
      revisionCount: target.revision_count,
      scopeCount: target.scope_count,
      contentBytes: target.content_bytes,
      headDigest
    })
  ];
  const memoryIds = new Set();
  for (const head of target.memory_heads) {
    memoryIds.add(head.memory_id);
    descriptors.push(
      createDescriptor({
        projectionMode: "search",
        projectId: target.project_id,
        projectVersion: target.project_version,
        searchGenerationId: target.search_generation_id,
        memoryId: head.memory_id,
        revisionId: head.revision_id,
        repositoryPartition: head.repository_partition
      })
    );
  }
  for (const head of target.search_heads) {
    if (memoryIds.has(head.memory_id)) {
      continue;
    }
    descriptors.push(
      createDescriptor({
        projectionMode: "delete",
        projectId: target.project_id,
        projectVersion: target.project_version,
        searchGenerationId: target.search_generation_id,
        memoryId: head.memory_id,
        revisionId: head.revision_id,
        searchProjectVersion: head.project_version
      })
    );
  }
  return descriptors;
}
export function projectionRebuildEvent(descriptor, executionOrdinal = 0) {
  requireDescriptor(descriptor);
  requireExecutionOrdinal(executionOrdinal);
  const eventId = `projection-rebuild:${descriptor.projectionMode}:${sha256(
    `${descriptor.projectionTargetId}\n${executionOrdinal}`
  )}`;
  const payload = {
    type: PROJECTION_REBUILD_EVENT_TYPE,
    eventId,
    projectId: descriptor.projectId,
    projectVersion: descriptor.projectVersion,
    projectionMode: descriptor.projectionMode,
    searchGenerationId: descriptor.searchGenerationId,
    projectionTargetId: descriptor.projectionTargetId,
    executionOrdinal,
    ...modePayload(descriptor)
  };
  return {
    descriptor,
    executionOrdinal,
    eventId,
    payload,
    payloadDigest: sha256(JSON.stringify(payload))
  };
}
export function buildProjectionRebuildSql(events, options) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError("At least one projection rebuild event is required.");
  }
  const createdAt = requireIsoTimestamp(options?.createdAt);
  return events
    .map((candidate) => {
      const event = requireEvent(candidate);
      return `INSERT INTO outbox_events
        (event_id, project_id, project_version, event_type, payload_digest,
         payload_json, created_at)
        SELECT ${sqlLiteral(event.eventId)}, ${sqlLiteral(event.descriptor.projectId)},
               ${event.descriptor.projectVersion}, ${sqlLiteral(PROJECTION_REBUILD_EVENT_TYPE)},
               ${sqlLiteral(event.payloadDigest)}, ${sqlLiteral(JSON.stringify(event.payload))},
               ${sqlLiteral(createdAt)}
        WHERE ${eventAuthorityGuard(event.descriptor)}
        ON CONFLICT(event_id) DO NOTHING;`;
    })
    .join("\n");
}

export function requireActiveSearchGeneration(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("SEARCH_DB must contain exactly one active search generation.");
  }
  return requireIdentifier(rows[0]?.generation_id, "active search generation ID");
}
export function calculateProjectionRebuildSnapshotCapacity(input) {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("The projection rebuild snapshot capacity input is invalid.");
  }
  const memoryCount = requireNonNegativeCount(input.memoryCount, "snapshot memory");
  const revisionCount = requireNonNegativeCount(input.revisionCount, "snapshot revision");
  const scopeCount = requireNonNegativeCount(input.scopeCount, "snapshot scope");
  const contentBytes = requireNonNegativeCount(input.contentBytes, "snapshot content byte");
  if (revisionCount < memoryCount || scopeCount > memoryCount) {
    throw new TypeError("The projection rebuild snapshot capacity authority is invalid.");
  }
  const writeCount = memoryCount + revisionCount + scopeCount +
    PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_WRITES;
  const estimatedSubrequests =
    PROJECTION_REBUILD_WORKFLOW_FIXED_RETRIED_SUBREQUESTS +
    PROJECTION_REBUILD_STEP_ATTEMPTS *
      (PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_SUBREQUESTS + writeCount * 2);
  if (!Number.isSafeInteger(writeCount) || !Number.isSafeInteger(estimatedSubrequests)) {
    throw new RangeError("The projection rebuild snapshot capacity exceeds the safe integer range.");
  }
  const contentWithinLimit = contentBytes <= PROJECTION_REBUILD_MAX_SNAPSHOT_CONTENT_BYTES;
  const subrequestsWithinLimit = estimatedSubrequests <= PROJECTION_REBUILD_SAFE_SUBREQUEST_LIMIT;
  return {
    writeCount,
    estimatedSubrequests,
    contentWithinLimit,
    subrequestsWithinLimit,
    accepted: contentWithinLimit && subrequestsWithinLimit
  };
}
export function sameProjectionRebuildTargets(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((target, index) => {
    const candidate = right[index];
    try {
      requireTarget(target);
      requireTarget(candidate);
    } catch {
      return false;
    }
    return (
      target.project_id === candidate.project_id &&
      target.project_version === candidate.project_version &&
      target.search_generation_id === candidate.search_generation_id &&
      target.memory_count === candidate.memory_count &&
      target.revision_count === candidate.revision_count &&
      target.scope_count === candidate.scope_count &&
      target.content_bytes === candidate.content_bytes &&
      projectionRebuildHeadDigest(target.memory_heads) ===
        projectionRebuildHeadDigest(candidate.memory_heads)
    );
  });
}
export function selectProjectionRebuildEvents(descriptors, historyRows, options = {}) {
  const history = normalizeHistory(descriptors, historyRows);
  const resume = options.resume === true;
  const events = [];
  let pendingCount = 0;
  for (const descriptor of descriptors) {
    const rows = history.get(descriptor.projectionTargetId) ?? [];
    if (!resume) {
      const event = projectionRebuildEvent(descriptor, 0);
      const existing = rows.find((row) => row.event.executionOrdinal === 0);
      events.push(event);
      if (existing === undefined || !isSuccessfulExecution(existing.row)) {
        pendingCount += 1;
      }
      continue;
    }
    const latest = rows.at(-1);
    if (latest === undefined) {
      events.push(projectionRebuildEvent(descriptor, 0));
      pendingCount += 1;
      continue;
    }
    if (!isTerminalExecution(latest.row)) {
      const status = latest.row.workflow_status ?? "pending";
      throw new Error(
        `${descriptor.projectionTargetId}: latest projection rebuild execution is ${status}; ` +
          "resume is not safe while work is pending."
      );
    }
    if (latest.event.executionOrdinal >= PROJECTION_REBUILD_MAX_EXECUTION_ORDINAL) {
      throw new Error(`${descriptor.projectionTargetId}: execution ordinal capacity is exhausted.`);
    }
    events.push(projectionRebuildEvent(descriptor, latest.event.executionOrdinal + 1));
    pendingCount += 1;
  }
  return { events, pendingCount };
}
export function selectLatestProjectionRebuildEvents(descriptors, historyRows) {
  const history = normalizeHistory(descriptors, historyRows);
  const events = [];
  let pendingCount = 0;
  for (const descriptor of descriptors) {
    const latest = (history.get(descriptor.projectionTargetId) ?? []).at(-1);
    if (latest === undefined) {
      events.push(projectionRebuildEvent(descriptor, 0));
      pendingCount += 1;
    } else {
      events.push(latest.event);
      if (!isSuccessfulExecution(latest.row)) {
        pendingCount += 1;
      }
    }
  }
  return { events, pendingCount };
}
export function summarizeProjectionRebuildPlan(targets, selection) {
  requireTargets(targets);
  if (typeof selection !== "object" || selection === null || !Array.isArray(selection.events)) {
    throw new TypeError("The projection rebuild event selection is invalid.");
  }
  const counts = descriptorCounts(selection.events.map((event) => requireEvent(event).descriptor));
  if (!Number.isSafeInteger(selection.pendingCount) || selection.pendingCount < 0) {
    throw new TypeError("The projection rebuild pending count is invalid.");
  }
  return {
    ...counts,
    pendingCount: selection.pendingCount,
    etaSeconds: estimateProjectionRebuildEtaSeconds(selection.pendingCount)
  };
}
export function estimateProjectionRebuildEtaSeconds(total) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new TypeError("The projection rebuild event total is invalid.");
  }
  return total === 0 ? 0 : (
    Math.ceil(total / PROJECTION_REBUILD_DISPATCH_EVENTS_PER_MINUTE) * 60 +
    PROJECTION_REBUILD_SETTLE_SECONDS
  );
}

export function assertProjectionRebuildWaitBudget(plan, maximumWaitSeconds) {
  if (maximumWaitSeconds === undefined) {
    return;
  }
  if (!Number.isSafeInteger(maximumWaitSeconds) || maximumWaitSeconds < 0) {
    throw new TypeError("The maximum wait must be a non-negative safe integer.");
  }
  if (
    typeof plan !== "object" ||
    plan === null ||
    !Number.isSafeInteger(plan.etaSeconds) ||
    plan.etaSeconds < 0
  ) {
    throw new TypeError("The projection rebuild plan ETA is invalid.");
  }
  if (plan.etaSeconds > maximumWaitSeconds) {
    throw new Error(
      `Projection rebuild ETA ${plan.etaSeconds}s exceeds --max-wait-seconds ` +
        `${maximumWaitSeconds}; no events were enqueued.`
    );
  }
}

export function splitProjectionRebuildBatches(values) {
  return splitProjectionRebuildBatchesAt(values, PROJECTION_REBUILD_SQL_BATCH_SIZE);
}

export function splitProjectionRebuildQueryBatches(values) {
  return splitProjectionRebuildBatchesAt(values, PROJECTION_REBUILD_QUERY_BATCH_SIZE);
}

function splitProjectionRebuildBatchesAt(values, batchSize) {
  if (!Array.isArray(values)) {
    throw new TypeError("Projection rebuild batch input must be an array.");
  }
  const result = [];
  for (let index = 0; index < values.length; index += batchSize) {
    result.push(values.slice(index, index + batchSize));
  }
  return result;
}

export function projectionRebuildEnqueueIssues(events, outboxRows) {
  const outboxById = uniqueRows(outboxRows, "event_id", "outbox event");
  return events.flatMap((candidate) => {
    const event = requireEvent(candidate);
    return outboxIssues(event, outboxById.get(event.eventId), false);
  });
}

export function summarizeProjectionRebuildVerification(input) {
  requireTargets(input.targets);
  const cleanupDebt = assertProjectionRebuildCleanupDebtClear(input.cleanupDebt);
  const descriptors = input.targets.flatMap(projectionRebuildDescriptors);
  const expectedByTarget = new Map(
    descriptors.map((descriptor) => [descriptor.projectionTargetId, descriptor])
  );
  const events = input.events.map((event) => requireEvent(event));
  if (
    events.length !== descriptors.length ||
    events.some((event) => !expectedByTarget.has(event.descriptor.projectionTargetId)) ||
    new Set(events.map((event) => event.descriptor.projectionTargetId)).size !== descriptors.length
  ) {
    throw new Error("Projection rebuild verification events do not match the logical targets.");
  }
  const outboxById = uniqueRows(input.outboxRows, "event_id", "outbox event");
  const snapshotsByProject = uniqueRows(input.snapshotRows, "project_id", "project snapshot");
  const searchByMemory = uniqueRows(
    input.searchRows,
    (row) => `${row.generation_id}\n${row.project_id}\n${row.memory_id}`,
    "search projection head"
  );
  const searchRowsByProjectGeneration = new Map();
  for (const row of input.searchRows) {
    const key = `${row.generation_id}\n${row.project_id}`;
    const rows = searchRowsByProjectGeneration.get(key);
    if (rows === undefined) {
      searchRowsByProjectGeneration.set(key, [row]);
    } else {
      rows.push(row);
    }
  }
  const issues = [];
  const pending = new Set();
  for (const event of events) {
    const dispatchIssues = outboxIssues(event, outboxById.get(event.eventId), true);
    if (dispatchIssues.length !== 0) {
      issues.push(...dispatchIssues);
      pending.add(event.descriptor.projectionTargetId);
    }
    const projectionIssue = descriptorProjectionIssue(
      event.descriptor,
      snapshotsByProject,
      searchByMemory
    );
    if (projectionIssue !== null) {
      issues.push(projectionIssue);
      pending.add(event.descriptor.projectionTargetId);
    }
  }
  const deleteTargets = new Set(
    descriptors
      .filter((descriptor) => descriptor.projectionMode === "delete")
      .map((descriptor) => searchKey(descriptor))
  );
  for (const target of input.targets) {
    const expectedMemoryIds = new Set(target.memory_heads.map((head) => head.memory_id));
    const projectSearchRows = searchRowsByProjectGeneration.get(
      `${target.search_generation_id}\n${target.project_id}`
    ) ?? [];
    for (const row of projectSearchRows) {
      if (
        expectedMemoryIds.has(row.memory_id) ||
        deleteTargets.has(
          `${target.search_generation_id}\n${target.project_id}\n${row.memory_id}`
        )
      ) {
        continue;
      }
      issues.push(
        `${target.project_id}/${row.memory_id}: unexpected active search projection head.`
      );
      pending.add(`unexpected:${target.project_id}:${row.memory_id}`);
    }
  }
  const counts = descriptorCounts(descriptors);
  return {
    complete: issues.length === 0,
    ...counts,
    vectorCleanupDebtCount: cleanupDebt.vectorCleanupCount,
    projectionDeletionDebtCount: cleanupDebt.projectionDeletionCount,
    pendingCount: pending.size,
    issues
  };
}

export function requireProjectionRebuildCleanupDebt(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("SEARCH_DB must return exactly one projection cleanup debt row.");
  }
  const vectorCleanupCount = requireNonNegativeCount(
    rows[0]?.vector_cleanup_count,
    "vector cleanup debt"
  );
  const projectionDeletionCount = requireNonNegativeCount(
    rows[0]?.projection_deletion_count,
    "projection deletion debt"
  );
  return { vectorCleanupCount, projectionDeletionCount };
}

export function assertProjectionRebuildCleanupDebtClear(value) {
  const cleanupDebt = requireCleanupDebtCounts(value);
  const recovery = [];
  if (cleanupDebt.vectorCleanupCount > 0) {
    recovery.push(
      `Active search generation has ${cleanupDebt.vectorCleanupCount} headless ` +
        "vector-cleanup receipt(s). This debt cannot be assigned a reliable ETA; wait for " +
        "the scheduled vector cleanup janitor, inspect receipt backoff if it stalls, and rerun."
    );
  }
  if (cleanupDebt.projectionDeletionCount > 0) {
    recovery.push(
      `Active search generation has ${cleanupDebt.projectionDeletionCount} headless ` +
        "projection-deletion receipt(s). No automated owner can repair this debt; complete a " +
        "reviewed exact-owner recovery before rerunning projection rebuild."
    );
  }
  if (recovery.length > 0) {
    throw new Error(
      `Projection rebuild is blocked by headless cleanup debt:\n${recovery.join("\n")}`
    );
  }
  return cleanupDebt;
}

function requireCleanupDebtCounts(value) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("The projection rebuild cleanup debt summary is invalid.");
  }
  return {
    vectorCleanupCount: requireNonNegativeCount(
      value.vectorCleanupCount,
      "vector cleanup debt"
    ),
    projectionDeletionCount: requireNonNegativeCount(
      value.projectionDeletionCount,
      "projection deletion debt"
    )
  };
}

export function decodeD1Rows(output) {
  let statements;
  try {
    statements = JSON.parse(output);
  } catch {
    throw new Error("The remote query did not return valid D1 JSON.");
  }
  if (
    !Array.isArray(statements) ||
    statements.length === 0 ||
    statements.some(
      (statement) =>
        typeof statement !== "object" ||
        statement === null ||
        statement.success !== true ||
        !Array.isArray(statement.results)
    )
  ) {
    throw new Error("The remote D1 query failed.");
  }
  return statements.flatMap((statement) => statement.results);
}

function createDescriptor(fields) {
  const targetId = projectionTargetId(fields);
  return { ...fields, projectionTargetId: targetId };
}
function projectionTargetId(descriptor) {
  const fields = [
    "edgemneme.projection-rebuild",
    descriptor.projectionMode,
    descriptor.projectId,
    String(descriptor.projectVersion),
    descriptor.searchGenerationId
  ];
  if (descriptor.projectionMode === "snapshot") {
    fields.push(
      String(descriptor.memoryCount),
      String(descriptor.revisionCount),
      String(descriptor.scopeCount),
      String(descriptor.contentBytes),
      descriptor.headDigest
    );
  } else if (descriptor.projectionMode === "search") {
    fields.push(descriptor.memoryId, descriptor.revisionId, descriptor.repositoryPartition);
  } else if (descriptor.projectionMode === "delete") {
    fields.push(
      descriptor.memoryId,
      descriptor.revisionId,
      String(descriptor.searchProjectVersion)
    );
  } else {
    throw new TypeError("The projection rebuild mode is invalid.");
  }
  return sha256(fields.join("\n"));
}

function modePayload(descriptor) {
  if (descriptor.projectionMode === "snapshot") {
    return {
      memoryCount: descriptor.memoryCount,
      revisionCount: descriptor.revisionCount,
      scopeCount: descriptor.scopeCount,
      contentBytes: descriptor.contentBytes,
      headDigest: descriptor.headDigest
    };
  }
  if (descriptor.projectionMode === "search") {
    return {
      memoryId: descriptor.memoryId,
      revisionId: descriptor.revisionId,
      repositoryPartition: descriptor.repositoryPartition
    };
  }
  return {
    memoryId: descriptor.memoryId,
    revisionId: descriptor.revisionId,
    searchProjectVersion: descriptor.searchProjectVersion
  };
}

function eventAuthorityGuard(descriptor) {
  const project = `EXISTS (
          SELECT 1 FROM projects p
          WHERE p.project_id = ${sqlLiteral(descriptor.projectId)}
            AND p.project_version = ${descriptor.projectVersion}
            AND ${admittedProjectPredicate("p")}`;
  if (descriptor.projectionMode === "snapshot") {
    return `${project}
            AND (
              SELECT COUNT(*) FROM memories m
              WHERE m.project_id = p.project_id
                AND m.current_revision_id IS NOT NULL
            ) = ${descriptor.memoryCount}
            AND (
              SELECT COUNT(*) FROM memory_versions v
              WHERE v.project_id = p.project_id
            ) = ${descriptor.revisionCount}
            AND (
              SELECT COUNT(DISTINCT m.scope_id) FROM memories m
              WHERE m.project_id = p.project_id
                AND m.current_revision_id IS NOT NULL
            ) = ${descriptor.scopeCount}
            AND COALESCE((
              SELECT SUM(length(CAST(v.content AS BLOB)))
              FROM memory_versions v
              WHERE v.project_id = p.project_id
            ), 0) = ${descriptor.contentBytes}
        )`;
  }
  if (descriptor.projectionMode === "search") {
    return `${project}
            AND EXISTS (
              SELECT 1 FROM memories m
              WHERE m.project_id = p.project_id
                AND m.memory_id = ${sqlLiteral(descriptor.memoryId)}
                AND m.current_revision_id = ${sqlLiteral(descriptor.revisionId)}
                AND (
                  (
                    m.scope = 'project'
                    AND m.scope_id = p.project_id
                    AND ${sqlLiteral(descriptor.repositoryPartition)} = '*'
                  )
                  OR (
                    NOT (m.scope = 'project' AND m.scope_id = p.project_id)
                    AND EXISTS (
                      SELECT 1 FROM memory_repository_contexts memory_context
                      WHERE memory_context.project_id = m.project_id
                        AND memory_context.memory_id = m.memory_id
                        AND memory_context.repository_id =
                            ${sqlLiteral(descriptor.repositoryPartition)}
                    )
                  )
                )
            )
        )`;
  }
  return `${project}
            AND NOT EXISTS (
              SELECT 1 FROM memories m
              WHERE m.project_id = p.project_id
                AND m.memory_id = ${sqlLiteral(descriptor.memoryId)}
                AND m.current_revision_id IS NOT NULL
            )
        )`;
}

function admittedProjectPredicate(projectAlias) {
  return `(${projectAlias}.project_ref NOT GLOB 'system.synthetic.*'
            OR EXISTS (
              SELECT 1 FROM synthetic_cleanup_registry registry
              WHERE registry.project_id = ${projectAlias}.project_id
                AND registry.cleanup_fenced_at IS NULL
            ))`;
}

function normalizeHistory(descriptors, rows) {
  if (!Array.isArray(descriptors)) {
    throw new TypeError("Projection rebuild descriptors must be an array.");
  }
  const descriptorById = new Map();
  for (const descriptor of descriptors) {
    requireDescriptor(descriptor);
    if (descriptorById.has(descriptor.projectionTargetId)) {
      throw new Error("Projection rebuild descriptors contain a duplicate target identity.");
    }
    descriptorById.set(descriptor.projectionTargetId, descriptor);
  }
  if (!Array.isArray(rows)) {
    throw new TypeError("Projection rebuild history rows must be an array.");
  }
  const grouped = new Map([...descriptorById.keys()].map((id) => [id, []]));
  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      throw new TypeError("Projection rebuild history row is invalid.");
    }
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      throw new Error("Projection rebuild history contains invalid payload JSON.");
    }
    const descriptor = descriptorById.get(payload?.projectionTargetId);
    if (descriptor === undefined) {
      throw new Error("Projection rebuild history contains an unexpected target identity.");
    }
    const event = projectionRebuildEvent(descriptor, payload.executionOrdinal);
    if (!matchesOutbox(row, event)) {
      throw new Error(`${row.event_id ?? "unknown"}: outbox event does not match its stable payload.`);
    }
    if (
      row.projection_target_id !== undefined &&
      row.projection_target_id !== descriptor.projectionTargetId
    ) {
      throw new Error("Projection rebuild history target identity is inconsistent.");
    }
    if (
      row.execution_ordinal !== undefined &&
      row.execution_ordinal !== event.executionOrdinal
    ) {
      throw new Error("Projection rebuild history execution ordinal is inconsistent.");
    }
    const entries = grouped.get(descriptor.projectionTargetId);
    if (entries.some((entry) => entry.event.executionOrdinal === event.executionOrdinal)) {
      throw new Error("Projection rebuild history contains a duplicate execution ordinal.");
    }
    entries.push({ row, event });
  }
  for (const entries of grouped.values()) {
    entries.sort((left, right) => left.event.executionOrdinal - right.event.executionOrdinal);
  }
  return grouped;
}

function isTerminalExecution(row) {
  return (
    presentString(row.failed_at) ||
    (presentString(row.dispatched_at) && TERMINAL_WORKFLOW_STATUSES.has(row.workflow_status))
  );
}

function isSuccessfulExecution(row) {
  return (
    !presentString(row.failed_at) &&
    presentString(row.dispatched_at) &&
    row.workflow_status === "complete"
  );
}

function descriptorProjectionIssue(descriptor, snapshotsByProject, searchByMemory) {
  if (descriptor.projectionMode === "snapshot") {
    const snapshot = snapshotsByProject.get(descriptor.projectId);
    if (
      snapshot?.project_version === descriptor.projectVersion &&
      snapshot.status === "active" &&
      snapshot.active_snapshot_id === `${descriptor.projectId}:${descriptor.projectVersion}` &&
      snapshot.snapshot_id === snapshot.active_snapshot_id &&
      presentString(snapshot.manifest_key) &&
      typeof snapshot.manifest_sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(snapshot.manifest_sha256)
    ) {
      return null;
    }
    return `${descriptor.projectId}: project snapshot is not active at the target version.`;
  }
  const search = searchByMemory.get(searchKey(descriptor));
  if (descriptor.projectionMode === "delete") {
    return search === undefined
      ? null
      : `${descriptor.projectId}/${descriptor.memoryId}: orphan search projection head still exists.`;
  }
  if (
    search?.project_version === descriptor.projectVersion &&
    search.revision_id === descriptor.revisionId &&
    search.repository_partition === descriptor.repositoryPartition &&
    Number.isSafeInteger(search.chunk_count) &&
    search.chunk_count > 0
  ) {
    return null;
  }
  return `${descriptor.projectId}/${descriptor.memoryId}: search projection head is not current.`;
}

function outboxIssues(event, outbox, requireDispatch) {
  if (outbox === undefined) {
    return [`${event.eventId}: outbox event is missing.`];
  }
  if (!matchesOutbox(outbox, event)) {
    return [`${event.eventId}: outbox event does not match its stable payload.`];
  }
  if (!requireDispatch) {
    return [];
  }
  if (presentString(outbox.failed_at)) {
    return [`${event.eventId}: outbox event failed; rerun enqueue with --resume.`];
  }
  if (!presentString(outbox.dispatched_at)) {
    return [`${event.eventId}: outbox event has not been dispatched.`];
  }
  if (outbox.last_error_code === PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN) {
    const count = Number.isSafeInteger(outbox.projection_unknown_count)
      ? outbox.projection_unknown_count
      : 12;
    return [
      `${event.eventId}: Workflow control-plane status remained unknown after ${count} ` +
        "consecutive reconciliation observations; reconciliation remains active, --resume " +
        "is unsafe, and the Workflow instance plus D1 unknown-status timestamps require inspection."
    ];
  }
  if (outbox.workflow_status !== "complete") {
    const status = presentString(outbox.workflow_status)
      ? outbox.workflow_status
      : "missing";
    return [`${event.eventId}: projection workflow is ${status}, not complete.`];
  }
  return [];
}

function matchesOutbox(row, event) {
  return (
    row.event_id === event.eventId &&
    row.project_id === event.descriptor.projectId &&
    row.project_version === event.descriptor.projectVersion &&
    row.event_type === PROJECTION_REBUILD_EVENT_TYPE &&
    row.payload_digest === event.payloadDigest &&
    row.payload_json === JSON.stringify(event.payload)
  );
}

function descriptorCounts(descriptors) {
  const projectIds = new Set();
  let searchCount = 0;
  let deleteCount = 0;
  for (const descriptor of descriptors) {
    requireDescriptor(descriptor);
    projectIds.add(descriptor.projectId);
    if (descriptor.projectionMode === "search") {
      searchCount += 1;
    } else if (descriptor.projectionMode === "delete") {
      deleteCount += 1;
    }
  }
  return {
    totalCount: descriptors.length,
    projectCount: projectIds.size,
    searchCount,
    deleteCount
  };
}

function requireEvent(candidate) {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("The projection rebuild event is invalid.");
  }
  const expected = projectionRebuildEvent(candidate.descriptor, candidate.executionOrdinal);
  if (
    candidate.eventId !== expected.eventId ||
    candidate.payloadDigest !== expected.payloadDigest ||
    JSON.stringify(candidate.payload) !== JSON.stringify(expected.payload)
  ) {
    throw new Error("The projection rebuild event does not match its stable identity.");
  }
  return expected;
}

function requireTargets(targets) {
  if (!Array.isArray(targets)) {
    throw new TypeError("Projection rebuild targets must be an array.");
  }
  let priorProjectId;
  for (const target of targets) {
    requireTarget(target);
    if (priorProjectId !== undefined && target.project_id <= priorProjectId) {
      throw new TypeError("Projection rebuild targets must be unique and sorted.");
    }
    priorProjectId = target.project_id;
  }
}

function requireTarget(target) {
  if (typeof target !== "object" || target === null) {
    throw new TypeError("The projection rebuild target is invalid.");
  }
  requireIdentifier(target.project_id, "project ID");
  requireIdentifier(target.search_generation_id, "search generation ID");
  requireProjectVersion(target.project_version);
  requireHeadList(target.memory_heads, "memory", (head) => {
    requireIdentifier(head.revision_id, "revision ID");
    requireIdentifier(head.repository_partition, "repository partition");
  });
  requireHeadList(target.search_heads, "search", (head) => {
    if (head.generation_id !== target.search_generation_id) {
      throw new TypeError("The projection rebuild search head generation is invalid.");
    }
    requireIdentifier(head.revision_id, "revision ID");
    requireProjectVersion(head.project_version);
    if (
      head.chunk_count !== null &&
      (!Number.isSafeInteger(head.chunk_count) || head.chunk_count < 0)
    ) {
      throw new TypeError("The projection rebuild search head chunk count is invalid.");
    }
    if (
      head.repository_partition !== null &&
      head.repository_partition !== undefined &&
      typeof head.repository_partition !== "string"
    ) {
      throw new TypeError("The projection rebuild repository partition is invalid.");
    }
  });
  const capacity = requireSnapshotCapacityAuthority({
    memoryCount: target.memory_count,
    revisionCount: target.revision_count,
    scopeCount: target.scope_count,
    contentBytes: target.content_bytes
  });
  if (target.memory_count !== target.memory_heads.length) {
    throw new Error("The projection rebuild active memory count does not match its exact head set.");
  }
  if (!capacity.contentWithinLimit) {
    throw new Error(
      `${target.project_id}: projection snapshot contains ${target.content_bytes} content bytes, ` +
        "exceeding the 16 MiB safety limit."
    );
  }
  if (!capacity.subrequestsWithinLimit) {
    throw new Error(
      `${target.project_id}: projection snapshot estimated ${capacity.estimatedSubrequests} ` +
        "subrequests, exceeding the 45,000-subrequest safety budget."
    );
  }
}

function requireSnapshotCapacityAuthority(input) {
  return calculateProjectionRebuildSnapshotCapacity(input);
}

function requireHeadList(heads, label, validate) {
  if (!Array.isArray(heads)) {
    throw new TypeError(`The projection rebuild ${label} heads are invalid.`);
  }
  let priorMemoryId;
  for (const head of heads) {
    if (typeof head !== "object" || head === null) {
      throw new TypeError(`The projection rebuild ${label} head is invalid.`);
    }
    const memoryId = requireIdentifier(head.memory_id, "memory ID");
    validate(head);
    if (priorMemoryId !== undefined && memoryId <= priorMemoryId) {
      throw new TypeError(`Projection rebuild ${label} heads must be unique and sorted.`);
    }
    priorMemoryId = memoryId;
  }
}

function requireDescriptor(descriptor) {
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new TypeError("The projection rebuild descriptor is invalid.");
  }
  if (!PROJECTION_MODES.has(descriptor.projectionMode)) {
    throw new TypeError("The projection rebuild mode is invalid.");
  }
  const expectedKeys = [
    ...COMMON_DESCRIPTOR_KEYS,
    ...MODE_DESCRIPTOR_KEYS[descriptor.projectionMode]
  ].sort();
  if (Object.keys(descriptor).sort().join("\n") !== expectedKeys.join("\n")) {
    throw new TypeError("The projection rebuild descriptor fields are invalid.");
  }
  requireIdentifier(descriptor.projectId, "project ID");
  requireProjectVersion(descriptor.projectVersion);
  requireIdentifier(descriptor.searchGenerationId, "search generation ID");
  requireSha256(descriptor.projectionTargetId, "projection target ID");
  if (descriptor.projectionMode === "snapshot") {
    const capacity = requireSnapshotCapacityAuthority({
      memoryCount: descriptor.memoryCount,
      revisionCount: descriptor.revisionCount,
      scopeCount: descriptor.scopeCount,
      contentBytes: descriptor.contentBytes
    });
    if (!capacity.accepted) {
      throw new Error("The projection rebuild snapshot descriptor exceeds capacity.");
    }
    requireSha256(descriptor.headDigest, "head digest");
  } else {
    requireIdentifier(descriptor.memoryId, "memory ID");
    requireIdentifier(descriptor.revisionId, "revision ID");
    if (descriptor.projectionMode === "search") {
      requireIdentifier(descriptor.repositoryPartition, "repository partition");
    }
    if (descriptor.projectionMode === "delete") {
      requireProjectVersion(descriptor.searchProjectVersion);
    }
  }
  if (descriptor.projectionTargetId !== projectionTargetId(descriptor)) {
    throw new Error("The projection rebuild descriptor identity is invalid.");
  }
}

function requireProjectVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("The projection rebuild project version is invalid.");
  }
  return value;
}

function requireNonNegativeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`The projection rebuild ${label} count is invalid.`);
  }
  return value;
}

function requireExecutionOrdinal(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > PROJECTION_REBUILD_MAX_EXECUTION_ORDINAL
  ) {
    throw new TypeError("The projection rebuild execution ordinal is invalid.");
  }
  return value;
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`The ${label} is invalid.`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`The ${label} is invalid.`);
  }
  return value;
}

function requireIsoTimestamp(value) {
  if (typeof value !== "string") {
    throw new TypeError("The projection rebuild timestamp is invalid.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError("The projection rebuild timestamp is invalid.");
  }
  return value;
}

function uniqueRows(rows, key, label) {
  if (!Array.isArray(rows)) {
    throw new TypeError(`${label} rows must be an array.`);
  }
  const map = new Map();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      throw new TypeError(`${label} row is invalid.`);
    }
    const value = typeof key === "function" ? key(row) : row[key];
    if (typeof value !== "string" || value === "" || map.has(value)) {
      throw new Error(`${label} rows contain an invalid or duplicate identity.`);
    }
    map.set(value, row);
  }
  return map;
}

function projectionRebuildHeadDigest(heads) {
  return sha256(JSON.stringify(heads.map((head) => [
    head.memory_id,
    head.revision_id,
    head.repository_partition
  ])));
}

function searchKey(descriptor) {
  return `${descriptor.searchGenerationId}\n${descriptor.projectId}\n${descriptor.memoryId}`;
}

function presentString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
