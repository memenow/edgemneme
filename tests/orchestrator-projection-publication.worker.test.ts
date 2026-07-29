import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publishMemorySearchProjection: vi.fn(),
  publishProjectProjection: vi.fn()
}));

vi.mock("../src/projection/cloudflare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/projection/cloudflare")>()),
  publishProjectProjection: mocks.publishProjectProjection
}));

vi.mock("../src/search/indexing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/search/indexing")>()),
  publishMemorySearchProjection: mocks.publishMemorySearchProjection
}));

import { MemoryWorkflow } from "../workers/memory-orchestrator/index";

const PROJECT_ID = "project-1";
const MEMORY_ID = "memory-1";
const PROJECT_VERSION = 7;

describe("ordinary memory projection publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishProjectProjection.mockResolvedValue({
      status: "activated",
      snapshotId: `${PROJECT_ID}:${PROJECT_VERSION}`
    });
    mocks.publishMemorySearchProjection.mockResolvedValue(true);
  });

  it("publishes the current within-budget project and search projections", async () => {
    const database = new ProjectionPublicationDatabase();
    const projections = {} as R2Bucket;
    const searchDatabase = {} as D1Database;
    const vectors = {} as VectorizeIndex;
    const ai = {} as Ai;
    const steps: string[] = [];

    await MemoryWorkflow.prototype.run.call(
      {
        env: {
          MEMORY_DB: database,
          SEARCH_DB: searchDatabase,
          PROJECTIONS: projections,
          MEMORY_VECTORS: vectors,
          AI: ai,
          MEMORY_WORKFLOW: {},
          MEMORY_OUTBOX: {}
        }
      },
      workflowEvent() as never,
      workflowStep(steps)
    );

    expect(database.reads).toContainEqual({
      sql: expect.stringContaining("AS memory_count"),
      bindings: ["", PROJECT_ID, PROJECT_VERSION]
    });
    expect(mocks.publishProjectProjection).toHaveBeenCalledWith({
      memoryDb: database,
      projections,
      projectId: PROJECT_ID,
      projectVersion: PROJECT_VERSION
    });
    expect(mocks.publishMemorySearchProjection).toHaveBeenCalledWith({
      memoryDb: database,
      searchDb: searchDatabase,
      vectors,
      ai,
      projectId: PROJECT_ID,
      memoryId: MEMORY_ID,
      projectVersion: PROJECT_VERSION
    });
    expect(mocks.publishProjectProjection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publishMemorySearchProjection.mock.invocationCallOrder[0] as number
    );
    expect(steps).toEqual([
      "check workflow admission",
      "record workflow start",
      "apply quality policy",
      "record workflow completion"
    ]);
    expect(database.workflowStatus).toBe("complete");
  });
});

function workflowEvent() {
  return {
    instanceId: `projection-${PROJECT_ID}-${PROJECT_VERSION}`,
    timestamp: new Date("2026-07-29T00:00:00.000Z"),
    payload: {
      eventId: `${PROJECT_ID}:${PROJECT_VERSION}`,
      projectId: PROJECT_ID,
      type: "memory.changed" as const,
      subjectId: MEMORY_ID,
      projectVersion: PROJECT_VERSION
    }
  };
}

function workflowStep(names: string[]) {
  return {
    async do(name: string, ...values: unknown[]) {
      names.push(name);
      const callback = values.at(-1);
      if (typeof callback !== "function") {
        throw new TypeError("The Workflow test step has no callback.");
      }
      return callback();
    }
  } as never;
}

interface CapturedStatement {
  sql: string;
  bindings: unknown[];
}

class ProjectionPublicationDatabase {
  readonly reads: CapturedStatement[] = [];
  workflowStatus: "idle" | "running" | "complete" = "idle";

  withSession(_constraint: "first-primary"): ProjectionPublicationDatabase {
    return this;
  }

  prepare(sql: string) {
    const database = this;
    const statement: CapturedStatement = { sql, bindings: [] };
    return {
      bind(...bindings: unknown[]) {
        statement.bindings = bindings;
        return this;
      },
      async first() {
        database.reads.push({ sql, bindings: [...statement.bindings] });
        if (sql.includes("AS admitted")) {
          return { admitted: 1 };
        }
        if (sql.includes("AS memory_count")) {
          return {
            project_version: PROJECT_VERSION,
            memory_count: 1,
            revision_count: 1,
            scope_count: 1,
            content_bytes: 128,
            scope_exists: 0
          };
        }
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO workflow_runs")) {
          database.workflowStatus = "running";
        } else if (sql.includes("SET status = 'complete'")) {
          database.workflowStatus = "complete";
        }
        return { meta: { changes: 1 } };
      }
    };
  }
}
