import { sha256 } from "../security/crypto";
import {
  calculateProjectionRebuildSnapshotCapacity,
  type ProjectionRebuildRequest
} from "./rebuild";

// A rebuild row consumes up to three D1 queries in the scheduler. Keep a wide
// margin below D1's 1,000-query invocation limit for janitor and error paths.
export const PROJECTION_REBUILD_OUTBOX_DISPATCH_LIMIT = 250;
export const PROJECTION_REBUILD_WORKFLOW_STARTS_PER_SECOND = 40;
const PROJECTION_REBUILD_MAX_EXECUTION_ORDINAL = 9_999;

export interface ProjectionRebuildOutboxRow {
  event_id: string;
  project_id: string;
  project_version: number;
  event_type: string;
  payload_digest: string;
  payload_json: string;
}

export async function parseProjectionRebuildDispatch(
  row: ProjectionRebuildOutboxRow,
  payload: Record<string, unknown>
): Promise<{ projectVersion: number; request: ProjectionRebuildRequest } | null> {
  const hasPrefix = row.event_id.startsWith("projection-rebuild:");
  const mode = payload.projectionMode;
  const hasMode = mode === "snapshot" || mode === "search" || mode === "delete";
  if (!hasPrefix && !hasMode) {
    return null;
  }
  if (
    !hasPrefix ||
    !hasMode ||
    !isProjectionIdentifier(row.project_id) ||
    payload.type !== "projection.rebuild.requested" ||
    payload.eventId !== row.event_id ||
    payload.projectId !== row.project_id ||
    !Number.isSafeInteger(payload.projectVersion) ||
    (payload.projectVersion as number) < 0 ||
    payload.projectVersion !== row.project_version ||
    !isProjectionIdentifier(payload.searchGenerationId) ||
    typeof payload.projectionTargetId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload.projectionTargetId) ||
    !Number.isSafeInteger(payload.executionOrdinal) ||
    (payload.executionOrdinal as number) < 0 ||
    (payload.executionOrdinal as number) > PROJECTION_REBUILD_MAX_EXECUTION_ORDINAL ||
    row.event_type !== "projection.rebuild.requested" ||
    !/^[a-f0-9]{64}$/u.test(row.payload_digest) ||
    (await sha256(row.payload_json)) !== row.payload_digest ||
    JSON.stringify(payload) !== row.payload_json
  ) {
    throw new Error("The projection rebuild outbox payload is invalid.");
  }

  const commonKeys = [
    "eventId",
    "executionOrdinal",
    "projectId",
    "projectVersion",
    "projectionMode",
    "projectionTargetId",
    "searchGenerationId",
    "type"
  ];
  let request: ProjectionRebuildRequest;
  let identityFields: Array<string | number>;
  let modeKeys: string[];
  if (mode === "snapshot") {
    let capacity;
    try {
      capacity = calculateProjectionRebuildSnapshotCapacity({
        memoryCount: payload.memoryCount as number,
        revisionCount: payload.revisionCount as number,
        scopeCount: payload.scopeCount as number,
        contentBytes: payload.contentBytes as number
      });
    } catch {
      throw new Error("The projection rebuild outbox payload is invalid.");
    }
    if (!capacity.accepted ||
      typeof payload.headDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(payload.headDigest)
    ) {
      throw new Error("The projection rebuild outbox payload is invalid.");
    }
    request = {
      mode,
      searchGenerationId: payload.searchGenerationId,
      memoryCount: payload.memoryCount as number,
      revisionCount: payload.revisionCount as number,
      scopeCount: payload.scopeCount as number,
      contentBytes: payload.contentBytes as number,
      headDigest: payload.headDigest
    };
    identityFields = [
      request.memoryCount,
      request.revisionCount,
      request.scopeCount,
      request.contentBytes,
      request.headDigest
    ];
    modeKeys = [
      "contentBytes",
      "headDigest",
      "memoryCount",
      "revisionCount",
      "scopeCount"
    ];
  } else if (mode === "search") {
    if (
      !isProjectionIdentifier(payload.memoryId) ||
      !isProjectionIdentifier(payload.revisionId) ||
      !isProjectionIdentifier(payload.repositoryPartition)
    ) {
      throw new Error("The projection rebuild outbox payload is invalid.");
    }
    request = {
      mode,
      searchGenerationId: payload.searchGenerationId,
      memoryId: payload.memoryId,
      revisionId: payload.revisionId,
      repositoryPartition: payload.repositoryPartition
    };
    identityFields = [request.memoryId, request.revisionId, request.repositoryPartition];
    modeKeys = ["memoryId", "repositoryPartition", "revisionId"];
  } else {
    if (
      !isProjectionIdentifier(payload.memoryId) ||
      !isProjectionIdentifier(payload.revisionId) ||
      !Number.isSafeInteger(payload.searchProjectVersion) ||
      (payload.searchProjectVersion as number) < 0
    ) {
      throw new Error("The projection rebuild outbox payload is invalid.");
    }
    request = {
      mode,
      searchGenerationId: payload.searchGenerationId,
      memoryId: payload.memoryId,
      revisionId: payload.revisionId,
      searchProjectVersion: payload.searchProjectVersion as number
    };
    identityFields = [request.memoryId, request.revisionId, request.searchProjectVersion];
    modeKeys = ["memoryId", "revisionId", "searchProjectVersion"];
  }
  if (!hasExactProjectionPayloadKeys(payload, [...commonKeys, ...modeKeys])) {
    throw new Error("The projection rebuild outbox payload is invalid.");
  }
  const targetId = await sha256(
    [
      "edgemneme.projection-rebuild",
      mode,
      row.project_id,
      String(row.project_version),
      request.searchGenerationId,
      ...identityFields.map(String)
    ].join("\n")
  );
  const expectedEventId =
    `projection-rebuild:${mode}:` +
    (await sha256(`${targetId}\n${payload.executionOrdinal as number}`));
  if (payload.projectionTargetId !== targetId || row.event_id !== expectedEventId) {
    throw new Error("The projection rebuild outbox identity is invalid.");
  }
  return { projectVersion: row.project_version, request };
}

export async function throttleProjectionWorkflowStart(
  windowStartedAt: number,
  startsInWindow: number,
  options: {
    now?: () => number;
    delay?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<{ workflowWindowStartedAt: number; workflowStartsInWindow: number }> {
  if (startsInWindow < PROJECTION_REBUILD_WORKFLOW_STARTS_PER_SECOND) {
    return {
      workflowWindowStartedAt: windowStartedAt,
      workflowStartsInWindow: startsInWindow + 1
    };
  }
  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const remaining = 1_000 - (now() - windowStartedAt);
  if (remaining > 0) {
    await delay(remaining);
  }
  return { workflowWindowStartedAt: now(), workflowStartsInWindow: 1 };
}

function hasExactProjectionPayloadKeys(
  payload: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actual = Object.keys(payload).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isProjectionIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
