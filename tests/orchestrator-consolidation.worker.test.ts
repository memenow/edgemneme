import { beforeEach, describe, expect, it, vi } from "vitest";

const qualityMocks = vi.hoisted(() => ({
  createClaimId: vi.fn(() => "00000000-0000-4000-8000-000000000001"),
  claimLease: vi.fn(),
  listBatches: vi.fn(),
  consolidateBatch: vi.fn(),
  finish: vi.fn(),
  fail: vi.fn()
}));

const admissionMock = vi.hoisted(() => vi.fn());

vi.mock("../src/workflows/quality", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workflows/quality")>()),
  createConsolidationClaimId: qualityMocks.createClaimId,
  claimConsolidationLease: qualityMocks.claimLease,
  listConsolidationBatchIndexes: qualityMocks.listBatches,
  consolidateSessionBatch: qualityMocks.consolidateBatch,
  finishConsolidation: qualityMocks.finish,
  failConsolidation: qualityMocks.fail
}));

vi.mock("../src/workflows/synthetic-cleanup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/workflows/synthetic-cleanup")>()),
  isProjectWorkAdmitted: admissionMock
}));

import { MemoryWorkflow } from "../workers/memory-orchestrator/index";

const PROJECT_ID = "project-1";
const CONSOLIDATION_ID = "consolidation-1";
const SESSION_ID = "session-1";
const WORKFLOW_ID = "workflow-1";
const LEASE = {
  owner: WORKFLOW_ID,
  claimId: "00000000-0000-4000-8000-000000000001",
  epoch: 1
};

describe("consolidation Workflow orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admissionMock.mockResolvedValue(true);
    qualityMocks.claimLease.mockResolvedValue(LEASE);
    qualityMocks.listBatches.mockResolvedValue([0, 1]);
    qualityMocks.consolidateBatch.mockResolvedValue(undefined);
    qualityMocks.finish.mockResolvedValue(undefined);
    qualityMocks.fail.mockResolvedValue(undefined);
  });

  it("persists the claim ID and gives every durable batch its own bounded step", async () => {
    const steps = workflowSteps();

    await MemoryWorkflow.prototype.run.call(
      { env: workflowEnvironment() },
      consolidationEvent() as never,
      steps.workflowStep as never
    );

    expect(steps.names).toEqual([
      "check workflow admission",
      "record workflow start",
      "create consolidation claim id",
      "claim consolidation lease",
      "list consolidation batches",
      "consolidate batch 0",
      "consolidate batch 1",
      "finish consolidation",
      "record workflow completion"
    ]);
    expect(steps.options.get("consolidate batch 0")).toMatchObject({
      timeout: "15 minutes",
      retries: { limit: 2 }
    });
    expect(steps.options.get("consolidate batch 1")).toEqual(
      steps.options.get("consolidate batch 0")
    );
    expect(steps.results.get("consolidate batch 0")).toBeUndefined();
    expect(steps.results.get("consolidate batch 1")).toBeUndefined();
    expect(qualityMocks.claimLease).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      WORKFLOW_ID,
      LEASE.claimId
    );
    expect(qualityMocks.consolidateBatch.mock.calls.map((call) => call[5])).toEqual([
      0,
      1
    ]);
    expect(qualityMocks.finish).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      CONSOLIDATION_ID,
      LEASE,
      [0, 1]
    );
  });

  it("stops before the next model batch when project admission is revoked", async () => {
    admissionMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const steps = workflowSteps();

    await expect(
      MemoryWorkflow.prototype.run.call(
        { env: workflowEnvironment() },
        consolidationEvent() as never,
        steps.workflowStep as never
      )
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });

    expect(steps.names).toEqual([
      "check workflow admission",
      "record workflow start",
      "create consolidation claim id",
      "claim consolidation lease",
      "list consolidation batches",
      "consolidate batch 0",
      "consolidate batch 1",
      "fail consolidation",
      "record workflow failure"
    ]);
    expect(qualityMocks.consolidateBatch).toHaveBeenCalledTimes(1);
    expect(qualityMocks.consolidateBatch).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE,
      0
    );
    expect(qualityMocks.finish).not.toHaveBeenCalled();
    expect(qualityMocks.fail).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      CONSOLIDATION_ID,
      LEASE
    );
  });

  it("fails before AI when a cached batch list exceeds the Workflow step budget", async () => {
    qualityMocks.listBatches.mockResolvedValue(
      Array.from({ length: 9_001 }, (_, batchIndex) => batchIndex)
    );
    const steps = workflowSteps();

    await expect(
      MemoryWorkflow.prototype.run.call(
        { env: workflowEnvironment() },
        consolidationEvent() as never,
        steps.workflowStep as never
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(steps.names).toEqual([
      "check workflow admission",
      "record workflow start",
      "create consolidation claim id",
      "claim consolidation lease",
      "list consolidation batches",
      "fail consolidation",
      "record workflow failure"
    ]);
    expect(qualityMocks.consolidateBatch).not.toHaveBeenCalled();
    expect(qualityMocks.finish).not.toHaveBeenCalled();
    expect(qualityMocks.fail).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      CONSOLIDATION_ID,
      LEASE
    );
  });
});

function consolidationEvent() {
  return {
    instanceId: WORKFLOW_ID,
    timestamp: new Date("2026-08-01T00:00:00.000Z"),
    payload: {
      eventId: CONSOLIDATION_ID,
      projectId: PROJECT_ID,
      type: "session.consolidation.requested",
      subjectId: SESSION_ID
    }
  };
}

function workflowEnvironment() {
  const prepare = () => {
    const statement = {
      bind() {
        return statement;
      },
      async run() {
        return {
          success: true,
          results: [],
          meta: { changes: 1 }
        };
      }
    };
    return statement;
  };
  return {
    MEMORY_DB: { prepare },
    SEARCH_DB: {},
    PROJECTIONS: {},
    MEMORY_VECTORS: {},
    AI: {},
    MEMORY_WORKFLOW: {},
    MEMORY_OUTBOX: {}
  };
}

function workflowSteps() {
  const names: string[] = [];
  const options = new Map<string, unknown>();
  const results = new Map<string, unknown>();
  return {
    names,
    options,
    results,
    workflowStep: {
      async do(name: string, ...args: unknown[]) {
        names.push(name);
        const callback = args.at(-1);
        if (args.length === 2) {
          options.set(name, args[0]);
        }
        if (typeof callback !== "function") {
          throw new TypeError(`Workflow step ${name} has no callback.`);
        }
        const result = await callback();
        results.set(name, result);
        return result;
      }
    }
  };
}
