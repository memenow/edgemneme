import { describe, expect, it } from "vitest";
import {
  ensureWorkflowWithRepair,
  WorkflowControlPlaneStatusError,
  WorkflowRepairExhaustedError
} from "../src/workflows/recovery";

describe("workflow recovery", () => {
  it("creates the stable base instance first", async () => {
    const created: string[] = [];
    const workflow = fakeWorkflow(created, {});

    await expect(
      ensureWorkflowWithRepair(workflow, "event-1", { eventId: "event-1" })
    ).resolves.toBe("event-1");
    expect(created).toEqual(["event-1"]);
  });

  it("accepts a duplicate instance that is not terminally failed", async () => {
    const created: string[] = [];
    const workflow = fakeWorkflow(created, { "event-1": "running" });

    await expect(
      ensureWorkflowWithRepair(workflow, "event-1", { eventId: "event-1" })
    ).resolves.toBe("event-1");
    expect(created).toEqual(["event-1"]);
  });

  it("uses deterministic bounded repair IDs after terminal failures", async () => {
    const created: string[] = [];
    const workflow = fakeWorkflow(created, {
      "event-1": "errored",
      "event-1-repair-1": "terminated"
    });

    await expect(
      ensureWorkflowWithRepair(workflow, "event-1", { eventId: "event-1" })
    ).resolves.toBe("event-1-repair-2");
    expect(created).toEqual(["event-1", "event-1-repair-1", "event-1-repair-2"]);
  });

  it("fails after the configured repair budget is exhausted", async () => {
    const created: string[] = [];
    const workflow = fakeWorkflow(created, {
      "event-1": "errored",
      "event-1-repair-1": "errored"
    });

    const result = ensureWorkflowWithRepair(
      workflow,
      "event-1",
      { eventId: "event-1" },
      1
    );
    await expect(result).rejects.toBeInstanceOf(WorkflowRepairExhaustedError);
    await expect(result).rejects.toThrow("synthetic create failure");
    expect(created).toEqual(["event-1", "event-1-repair-1"]);
  });

  it.each(["get", "status"] as const)(
    "classifies a duplicate Workflow %s lookup failure as control-plane uncertainty",
    async (failurePoint) => {
      const workflow = {
        async create() {
          throw new Error("synthetic create failure");
        },
        get() {
          if (failurePoint === "get") {
            throw new Error("synthetic get failure");
          }
          return {
            async status() {
              throw new Error("synthetic status failure");
            }
          };
        }
      };

      await expect(
        ensureWorkflowWithRepair(workflow, "event-1", { eventId: "event-1" })
      ).rejects.toBeInstanceOf(WorkflowControlPlaneStatusError);
    }
  );

  it.each(["unknown", "future-platform-status"])(
    "classifies an unrecognized duplicate Workflow status %s as control-plane uncertainty",
    async (status) => {
      const created: string[] = [];
      const workflow = fakeWorkflow(created, { "event-1": status });

      await expect(
        ensureWorkflowWithRepair(workflow, "event-1", { eventId: "event-1" })
      ).rejects.toBeInstanceOf(WorkflowControlPlaneStatusError);
      expect(created).toEqual(["event-1"]);
    }
  );

  it.each(["queued", "running", "waiting", "waitingForPause", "paused", "complete"])(
    "reuses a duplicate Workflow in the known %s state",
    async (status) => {
      const created: string[] = [];
      const workflow = fakeWorkflow(created, { "event-1": status });

      await expect(
        ensureWorkflowWithRepair(workflow, "event-1", { eventId: "event-1" })
      ).resolves.toBe("event-1");
      expect(created).toEqual(["event-1"]);
    }
  );

  it("rejects an invalid repair budget", async () => {
    const workflow = fakeWorkflow([], {});
    await expect(
      ensureWorkflowWithRepair(workflow, "event-1", { eventId: "event-1" }, 11)
    ).rejects.toThrow("repair limit");
  });
});

function fakeWorkflow(created: string[], existing: Record<string, string>) {
  return {
    async create(options: { id: string }) {
      created.push(options.id);
      if (options.id in existing) {
        throw new Error("synthetic create failure");
      }
    },
    get(id: string) {
      return {
        async status() {
          return { status: existing[id] ?? "running" };
        }
      };
    }
  };
}
