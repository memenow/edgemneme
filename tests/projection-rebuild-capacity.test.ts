import { describe, expect, it } from "vitest";
import {
  calculateProjectionRebuildSnapshotCapacity as calculateWorkflowCapacity,
  PROJECTION_REBUILD_MAX_SNAPSHOT_CONTENT_BYTES as WORKFLOW_CONTENT_LIMIT,
  PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_SUBREQUESTS as WORKFLOW_FIXED_SUBREQUESTS,
  PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_WRITES as WORKFLOW_FIXED_WRITES,
  PROJECTION_REBUILD_SAFE_SUBREQUEST_LIMIT as WORKFLOW_SAFE_SUBREQUEST_LIMIT,
  PROJECTION_REBUILD_STEP_ATTEMPTS as WORKFLOW_STEP_ATTEMPTS,
  PROJECTION_REBUILD_WORKFLOW_FIXED_RETRIED_SUBREQUESTS as WORKFLOW_RETRIED_SUBREQUESTS,
  PROJECTION_REBUILD_WORKFLOW_SUBREQUEST_LIMIT as WORKFLOW_SUBREQUEST_LIMIT
} from "../src/projection/rebuild";

// The deploy-side preflight is plain ESM so it can run without a TypeScript runtime.
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as projectionRebuildSupport from "../scripts/projection-rebuild-support.mjs";
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as projectionRebuildCli from "../scripts/enqueue-projection-rebuild.mjs";

const {
  calculateProjectionRebuildSnapshotCapacity: calculateCliCapacity,
  projectionRebuildDescriptors,
  PROJECTION_REBUILD_MAX_SNAPSHOT_CONTENT_BYTES: CLI_CONTENT_LIMIT,
  PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_SUBREQUESTS: CLI_FIXED_SUBREQUESTS,
  PROJECTION_REBUILD_PROJECT_SNAPSHOT_FIXED_WRITES: CLI_FIXED_WRITES,
  PROJECTION_REBUILD_QUERY_BATCH_SIZE,
  PROJECTION_REBUILD_SAFE_SUBREQUEST_LIMIT: CLI_SAFE_SUBREQUEST_LIMIT,
  PROJECTION_REBUILD_STEP_ATTEMPTS: CLI_STEP_ATTEMPTS,
  PROJECTION_REBUILD_WORKFLOW_FIXED_RETRIED_SUBREQUESTS: CLI_RETRIED_SUBREQUESTS,
  PROJECTION_REBUILD_WORKFLOW_SUBREQUEST_LIMIT: CLI_SUBREQUEST_LIMIT
} = projectionRebuildSupport;
const { loadRebuildTargets, PROJECTION_REBUILD_PAGE_SIZE } = projectionRebuildCli;

describe("projection rebuild snapshot capacity preflight", () => {
  it("keeps deploy preflight constants and calculations identical to the Workflow", () => {
    expect({
      content: CLI_CONTENT_LIMIT,
      fixedSubrequests: CLI_FIXED_SUBREQUESTS,
      fixedWrites: CLI_FIXED_WRITES,
      retriedSubrequests: CLI_RETRIED_SUBREQUESTS,
      safeSubrequests: CLI_SAFE_SUBREQUEST_LIMIT,
      stepAttempts: CLI_STEP_ATTEMPTS,
      workflowSubrequests: CLI_SUBREQUEST_LIMIT
    }).toEqual({
      content: WORKFLOW_CONTENT_LIMIT,
      fixedSubrequests: WORKFLOW_FIXED_SUBREQUESTS,
      fixedWrites: WORKFLOW_FIXED_WRITES,
      retriedSubrequests: WORKFLOW_RETRIED_SUBREQUESTS,
      safeSubrequests: WORKFLOW_SAFE_SUBREQUEST_LIMIT,
      stepAttempts: WORKFLOW_STEP_ATTEMPTS,
      workflowSubrequests: WORKFLOW_SUBREQUEST_LIMIT
    });
    expect(WORKFLOW_FIXED_SUBREQUESTS).toBe(14);
    for (const input of [
      { memoryCount: 0, revisionCount: 0, scopeCount: 0, contentBytes: 0 },
      {
        memoryCount: 3_730,
        revisionCount: 3_730,
        scopeCount: 1,
        contentBytes: WORKFLOW_CONTENT_LIMIT
      },
      {
        memoryCount: 3_730,
        revisionCount: 3_730,
        scopeCount: 2,
        contentBytes: WORKFLOW_CONTENT_LIMIT
      }
    ]) {
      expect(calculateCliCapacity(input)).toEqual(calculateWorkflowCapacity(input));
    }
  });

  it("accepts the exact safe boundaries and rejects the next content or workload unit", () => {
    expect(calculateCliCapacity({
      memoryCount: 3_730,
      revisionCount: 3_730,
      scopeCount: 1,
      contentBytes: CLI_CONTENT_LIMIT
    })).toEqual({
      writeCount: 7_490,
      estimatedSubrequests: 44_996,
      contentWithinLimit: true,
      subrequestsWithinLimit: true,
      accepted: true
    });
    expect(calculateCliCapacity({
      memoryCount: 3_730,
      revisionCount: 3_730,
      scopeCount: 2,
      contentBytes: CLI_CONTENT_LIMIT
    })).toMatchObject({
      estimatedSubrequests: 45_002,
      contentWithinLimit: true,
      subrequestsWithinLimit: false,
      accepted: false
    });
    expect(calculateCliCapacity({
      memoryCount: 3_730,
      revisionCount: 3_730,
      scopeCount: 1,
      contentBytes: CLI_CONTENT_LIMIT + 1
    })).toMatchObject({
      estimatedSubrequests: 44_996,
      contentWithinLimit: false,
      subrequestsWithinLimit: true,
      accepted: false
    });
  });

  it("rejects a 10,000-memory project after bounded enumeration and before history", () => {
    const project = {
      project_id: "project:oversized",
      project_version: 9,
      memory_count: 10_000,
      revision_count: 10_000,
      scope_count: 1,
      content_bytes: 0
    };
    const memoryRows = Array.from({ length: 10_000 }, (_, index) => ({
      project_id: project.project_id,
      project_version: project.project_version,
      memory_id: `memory-${String(index).padStart(5, "0")}`,
      revision_id: `revision-${String(index).padStart(5, "0")}`,
      scope: "project",
      scope_id: project.project_id,
      repository_id: null
    }));
    const searchRows = memoryRows.map((row) => ({
      generation_id: "generation-capacity",
      project_id: row.project_id,
      memory_id: row.memory_id,
      project_version: project.project_version,
      revision_id: row.revision_id,
      repository_partition: "*",
      chunk_count: 1
    }));
    const pageSize = PROJECTION_REBUILD_PAGE_SIZE;
    const memoryPages = pages(memoryRows, pageSize);
    const searchPages = pages(searchRows, pageSize);
    let projectCalls = 0;
    let memoryCalls = 0;
    let searchCalls = 0;
    const labels: string[] = [];

    expect(() => loadRebuildTargets("config.jsonc", project.project_id, {
      pageSize,
      runQuery: (_database: string, _sql: string, _config: string, label: string) => {
        labels.push(label);
        if (label === "Load active search generation") {
          return [{ generation_id: "generation-capacity" }];
        }
        if (label === "Load authoritative projection rebuild targets") {
          projectCalls += 1;
          return [project];
        }
        if (label === "Load authoritative projection rebuild memory heads") {
          const page = memoryPages[memoryCalls];
          memoryCalls += 1;
          return page;
        }
        if (label === "Load active search projection ledger heads") {
          const page = searchPages[searchCalls];
          searchCalls += 1;
          return page;
        }
        throw new Error(`Unexpected projection rebuild query: ${label}`);
      }
    })).toThrow(/120236 subrequests|120,236 subrequests/iu);

    expect(PROJECTION_REBUILD_PAGE_SIZE).toBe(500);
    expect(projectCalls).toBe(2);
    expect(memoryCalls).toBe(21);
    expect(searchCalls).toBe(21);
    expect(labels).toHaveLength(46);
    expect(labels.some((label) => label.includes("history"))).toBe(false);
    const hypotheticalHistoryQueries = Math.ceil(10_001 / PROJECTION_REBUILD_QUERY_BATCH_SIZE);
    expect(labels.length + hypotheticalHistoryQueries).toBe(87);
    expect(() => projectionRebuildDescriptors({
      ...project,
      search_generation_id: "generation-capacity",
      memory_heads: memoryRows.map((row) => ({
        memory_id: row.memory_id,
        revision_id: row.revision_id,
        repository_partition: "*"
      })),
      search_heads: []
    })).toThrow(/120236 subrequests|120,236 subrequests/iu);
  });
});

function pages<T>(rows: T[], pageSize: number): T[][] {
  return Array.from({ length: Math.ceil(rows.length / pageSize) + 1 }, (_, index) =>
    rows.slice(index * pageSize, (index + 1) * pageSize));
}
