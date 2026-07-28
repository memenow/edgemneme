import { describe, expect, it, vi } from "vitest";
import orchestrator, {
  MemoryWorkflow,
  ProjectCoordinator
} from "../workers/memory-orchestrator/index";
import { sha256 } from "../src/security/crypto";

const PROJECT_ID = "synthetic-project";

describe("synthetic cleanup work admission", () => {
  it("acknowledges a fenced Queue message without creating a Workflow", async () => {
    const database = new FakeDatabase({ admissions: [0] });
    const workflowCreate = vi.fn();
    const ack = vi.fn();
    const retry = vi.fn();
    const env = environment(database, workflowCreate);

    await orchestrator.queue(
      {
        messages: [
          {
            body: {
              type: "candidate.submitted",
              eventId: "event-1",
              projectId: PROJECT_ID,
              candidateId: "candidate-1",
              idempotencyKey: "idempotency-1"
            },
            ack,
            retry
          }
        ]
      } as unknown as MessageBatch<never>,
      env as never
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("marks a raced fenced outbox row dispatched without sending it", async () => {
    const database = new FakeDatabase({
      admissions: [0],
      outboxRows: [
        {
          event_id: "event-1",
          project_id: PROJECT_ID,
          event_type: "candidate.submitted",
          payload_json: JSON.stringify({
            type: "candidate.submitted",
            eventId: "event-1",
            projectId: PROJECT_ID,
            candidateId: "candidate-1",
            idempotencyKey: "idempotency-1"
          }),
          attempt: 0
        }
      ]
    });
    const send = vi.fn();
    const env = environment(database, vi.fn(), send);

    await orchestrator.scheduled({} as ScheduledController, env as never);

    expect(send).not.toHaveBeenCalled();
    expect(database.runs.some((sql) => sql.includes("SYNTHETIC_CLEANUP_FENCED"))).toBe(true);
  });

  it("terminalizes a valid rebuild when its project is fenced or deleted before dispatch", async () => {
    const row = { ...(await projectionRebuildOutboxRow(0)), attempt: 4 };
    const database = new FakeDatabase({ admissions: [0], outboxRows: [row] });
    const workflowCreate = vi.fn();

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate) as never
    );

    expect(workflowCreate).not.toHaveBeenCalled();
    expect(database.runCalls.some(({ sql }) => sql.includes("SYNTHETIC_CLEANUP_FENCED"))).toBe(
      false
    );
    expect(database.runCalls).toContainEqual({
      sql: expect.stringContaining(
        "last_error_code = 'PROJECTION_REBUILD_PROJECT_UNAVAILABLE'"
      ),
      bindings: [
        expect.any(String),
        row.event_id,
        row.project_id,
        row.payload_digest,
        4
      ]
    });
    const failureWrite = database.runCalls.find(({ sql }) =>
      sql.includes("PROJECTION_REBUILD_PROJECT_UNAVAILABLE")
    );
    expect(failureWrite?.sql).toContain(
      "AND attempt = ? AND dispatched_at IS NULL AND failed_at IS NULL"
    );
    expect(failureWrite?.sql).not.toContain("SET dispatched_at");
  });

  it("keeps the normal project-version projection Workflow identity unchanged", async () => {
    const database = new FakeDatabase({
      admissions: [1, 1, 1, 1],
      outboxRows: [
        projectionOutboxRow("event-1", "memory-1"),
        projectionOutboxRow("event-2", "memory-2")
      ]
    });
    const workflowCreate = vi.fn();

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate) as never
    );

    expect(workflowCreate).toHaveBeenCalledTimes(2);
    expect(workflowCreate.mock.calls.map(([input]) => input.id)).toEqual([
      "projection-synthetic-project-1",
      "projection-synthetic-project-1"
    ]);
  });

  it("reuses one stable rebuild Workflow identity across dispatch attempts", async () => {
    const rebuildRow = await projectionRebuildOutboxRow(0);
    const workflowCreate = vi.fn();

    for (const attempt of [0, 1]) {
      const database = new FakeDatabase({
        admissions: [1, 1],
        outboxRows: [{ ...rebuildRow, attempt }]
      });
      await orchestrator.scheduled(
        {} as ScheduledController,
        environment(database, workflowCreate) as never
      );
    }

    const calls = workflowCreate.mock.calls.map(([input]) => input);
    expect(calls).toHaveLength(2);
    expect(calls.map((input) => input.id)).toEqual([
      expect.stringMatching(/^projection-rebuild-[a-f0-9]{64}$/u),
      expect.stringMatching(/^projection-rebuild-[a-f0-9]{64}$/u)
    ]);
    expect(calls[0]?.id).toBe(calls[1]?.id);
    expect(calls.map((input) => input.params.eventId)).toEqual([
      rebuildRow.event_id,
      rebuildRow.event_id
    ]);
    expect(calls.map((input) => input.params.projectionRebuild)).toEqual([
      {
        mode: "snapshot",
        searchGenerationId: "generation-1",
        memoryCount: 2,
        revisionCount: 2,
        scopeCount: 2,
        contentBytes: 9,
        headDigest: "b".repeat(64)
      },
      {
        mode: "snapshot",
        searchGenerationId: "generation-1",
        memoryCount: 2,
        revisionCount: 2,
        scopeCount: 2,
        contentBytes: 9,
        headDigest: "b".repeat(64)
      }
    ]);
  });

  it("uses a new event and Workflow identity for an explicit rebuild resume", async () => {
    const initial = await projectionRebuildOutboxRow(0);
    const resumed = await projectionRebuildOutboxRow(1);
    const workflowCreate = vi.fn();

    for (const row of [initial, resumed]) {
      const database = new FakeDatabase({ admissions: [1, 1], outboxRows: [row] });
      await orchestrator.scheduled(
        {} as ScheduledController,
        environment(database, workflowCreate) as never
      );
    }

    const calls = workflowCreate.mock.calls.map(([input]) => input);
    expect(resumed.event_id).not.toBe(initial.event_id);
    expect(calls.map((input) => input.id)).toHaveLength(2);
    expect(calls[1]?.id).not.toBe(calls[0]?.id);
  });

  it("rejects a malformed project rebuild payload before creating a Workflow", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const payloadJson = JSON.stringify({
      ...JSON.parse(row.payload_json),
      headDigest: "not-a-digest"
    });
    row.payload_json = payloadJson;
    row.payload_digest = await sha256(payloadJson);
    const database = new FakeDatabase({ admissions: [1], outboxRows: [row] });
    const workflowCreate = vi.fn();

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate) as never
    );

    expect(workflowCreate).not.toHaveBeenCalled();
    expect(database.runs).toHaveLength(1);
    expect(database.runs[0]).toContain("OUTBOX_RETRY_PENDING");
  });

  it("recovers a final-attempt dispatch write failure when the stable Workflow is running", async () => {
    const row = { ...(await projectionRebuildOutboxRow(0)), attempt: 9 };
    const baseId = `projection-rebuild-${await sha256(row.event_id)}`;
    const database = new FakeDatabase({
      admissions: [1, 1],
      outboxRows: [row],
      failRunOnceMatching:
        "SET dispatched_at = ?, next_attempt_at = NULL, attempt = attempt + 1"
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "running" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, vi.fn(), vi.fn(), workflowGet) as never
    );

    expect(workflowGet).toHaveBeenCalledWith(baseId);
    expect(database.runCalls.some(({ sql }) => sql.includes("OUTBOX_DISPATCH_FAILED"))).toBe(
      false
    );
    expect(database.runCalls).toContainEqual({
      sql: expect.stringContaining(
        "SET dispatched_at = ?, next_attempt_at = NULL, attempt = ?, last_error_code = NULL"
      ),
      bindings: [
        expect.any(String),
        10,
        row.event_id,
        row.project_id,
        row.payload_digest,
        9
      ]
    });
  });

  it("fails closed when the final-attempt Workflow control-plane result is uncertain", async () => {
    const row = { ...(await projectionRebuildOutboxRow(0)), attempt: 9 };
    const database = new FakeDatabase({
      admissions: [1, 1],
      outboxRows: [row],
      failRunOnceMatching:
        "SET dispatched_at = ?, next_attempt_at = NULL, attempt = attempt + 1"
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => {
        throw new Error("The Workflow status is temporarily unavailable.");
      })
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, vi.fn(), vi.fn(), workflowGet) as never
    );

    expect(database.runCalls.some(({ sql }) => sql.includes("OUTBOX_DISPATCH_FAILED"))).toBe(
      false
    );
    expect(database.runCalls).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining(
          "AND attempt = ? AND dispatched_at IS NULL AND failed_at IS NULL"
        ),
        bindings: expect.arrayContaining([row.event_id, row.payload_digest, 9])
      })
    );
  });

  it("terminalizes a final dispatch attempt only after every stable Workflow is terminal", async () => {
    const row = { ...(await projectionRebuildOutboxRow(0)), attempt: 9 };
    const database = new FakeDatabase({ admissions: [1, 1], outboxRows: [row] });
    const workflowCreate = vi.fn(async () => {
      throw new Error("The Workflow instance already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "errored" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(workflowCreate).toHaveBeenCalledTimes(4);
    expect(workflowGet).toHaveBeenCalledTimes(8);
    expect(database.runCalls).toContainEqual({
      sql: expect.stringContaining(
        "SET attempt = ?, failed_at = ?, last_error_code = 'OUTBOX_DISPATCH_FAILED'"
      ),
      bindings: [
        10,
        expect.any(String),
        row.event_id,
        row.project_id,
        row.payload_digest,
        9
      ]
    });
  });

  it("repairs a dispatched rebuild on the next Cron after failure recording exhausts", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const baseId = `projection-rebuild-${await sha256(row.event_id)}`;
    const event = projectionRebuildWorkflowEventFromOutbox(row, baseId);
    const database = new FakeDatabase({
      admissions: [1],
      reconciliationRows: [reconciliationRow(row, null)]
    });

    await expect(
      MemoryWorkflow.prototype.run.call(
        { env: environment(database, vi.fn()) },
        event as never,
        workflowStep([], {
          failOnceAt: ["check workflow admission", "record workflow failure"]
        })
      )
    ).rejects.toThrow("Forced record workflow failure failure.");
    expect(database.workflowRun).toBeNull();

    const workflowCreate = vi.fn(async ({ id }: { id: string }) => {
      if (id === baseId) {
        throw new Error("The base Workflow already exists.");
      }
    });
    const workflowGet = vi.fn((workflowId: string) => ({
      status: vi.fn(async () => ({
        status: workflowId === baseId ? "errored" : "complete"
      }))
    }));
    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(workflowCreate.mock.calls.map(([input]) => input.id)).toEqual([
      baseId,
      `${baseId}-repair-1`
    ]);
    expect(workflowGet).toHaveBeenCalledWith(baseId);
    expect(workflowGet).toHaveBeenCalledWith(`${baseId}-repair-1`);
    expect(database.workflowRun).toMatchObject({
      workflow_id: `${baseId}-repair-1`,
      root_workflow_id: row.event_id,
      project_id: row.project_id,
      workflow_type: "projection.rebuild.requested",
      status: "complete"
    });
    expect(database.runs.some((sql) => sql.includes("PROJECTION_REBUILD_COMPLETE"))).toBe(
      false
    );
    expect(database.runCalls).toContainEqual(
      expect.objectContaining({
        bindings: expect.arrayContaining(["PROJECTION_REBUILD_COMPLETE", row.event_id])
      })
    );
    const reconciliationQuery = database.allCalls.find(({ sql }) =>
      sql.includes("INDEXED BY outbox_projection_rebuild_reconcile")
    );
    expect(reconciliationQuery?.bindings.at(-1)).toBe(20);
    expect(reconciliationQuery?.sql).toContain(
      "COALESCE(e.next_attempt_at, ''),"
    );
  });

  it("terminalizes missing D1 state from a control-plane-complete rebuild", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const baseId = `projection-rebuild-${await sha256(row.event_id)}`;
    const database = new FakeDatabase({
      admissions: [1],
      reconciliationRows: [reconciliationRow(row, null)]
    });
    const workflowCreate = vi.fn(async () => {
      throw new Error("The completed Workflow already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "complete" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(workflowCreate).toHaveBeenCalledOnce();
    expect(workflowCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: baseId })
    );
    expect(database.workflowRun).toMatchObject({
      workflow_id: baseId,
      root_workflow_id: row.event_id,
      project_id: row.project_id,
      workflow_type: "projection.rebuild.requested",
      status: "complete"
    });
    expect(database.runCalls).toContainEqual(
      expect.objectContaining({
        bindings: expect.arrayContaining(["PROJECTION_REBUILD_COMPLETE", row.event_id])
      })
    );
  });

  it("does not restart a dispatched rebuild whose latest run is terminal", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const database = new FakeDatabase({
      admissions: [],
      reconciliationRows: [
        reconciliationRow(row, "complete", {
          last_error_code: "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN",
          projection_unknown_count: 12,
          projection_unknown_first_observed_at: "2026-07-26T00:05:00.000Z",
          projection_unknown_last_observed_at: "2026-07-26T01:00:00.000Z",
          projection_unknown_alerted_at: "2026-07-26T01:00:00.000Z"
        })
      ]
    });
    const workflowCreate = vi.fn();

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate) as never
    );

    expect(workflowCreate).not.toHaveBeenCalled();
    expect(database.runCalls).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining("SET next_attempt_at = NULL, last_error_code = ?"),
        bindings: expect.arrayContaining(["PROJECTION_REBUILD_COMPLETE", row.event_id])
      })
    );
    expect(database.reconciliationRows[0]).toMatchObject({
      failed_at: null,
      next_attempt_at: null,
      last_error_code: "PROJECTION_REBUILD_COMPLETE"
    });
  });

  it("marks a dispatched rebuild failed after every deterministic repair is terminal", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const database = new FakeDatabase({
      admissions: [1],
      reconciliationRows: [
        reconciliationRow(row, null, {
          last_error_code: "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN",
          projection_unknown_count: 12,
          projection_unknown_first_observed_at: "2026-07-26T00:05:00.000Z",
          projection_unknown_last_observed_at: "2026-07-26T01:00:00.000Z",
          projection_unknown_alerted_at: "2026-07-26T01:00:00.000Z"
        })
      ]
    });
    const workflowCreate = vi.fn(async () => {
      throw new Error("The Workflow instance already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "errored" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(workflowCreate).toHaveBeenCalledTimes(4);
    expect(database.runCalls).toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining("SET failed_at = ?, next_attempt_at = NULL"),
        bindings: expect.arrayContaining([
          "PROJECTION_REBUILD_REPAIR_EXHAUSTED",
          row.event_id
        ])
      })
    );
    expect(database.reconciliationRows[0]).toMatchObject({
      last_error_code: "PROJECTION_REBUILD_REPAIR_EXHAUSTED",
      next_attempt_at: null,
      failed_at: expect.any(String)
    });
  });

  it.each([
    "reported unknown",
    "ensure status lookup throws",
    "direct status lookup throws"
  ])(
    "alerts after 12 consecutive control-plane observations when %s",
    async (scenario) => {
      const row = await projectionRebuildOutboxRow(0);
      const reconciliation = reconciliationRow(row, null);
      const database = new FakeDatabase({
        admissions: Array.from({ length: 12 }, () => 1),
        reconciliationRows: [reconciliation]
      });
      const workflowCreate = vi.fn(async (_options: { id: string }) => {
        if (scenario !== "direct status lookup throws") {
          throw new Error("The Workflow already exists.");
        }
      });
      const workflowGet = vi.fn(() => ({
        status: vi.fn(async () => {
          if (scenario !== "reported unknown") {
            throw new Error("The Workflow status is temporarily unavailable.");
          }
          return { status: "unknown" };
        })
      }));
      const env = environment(database, workflowCreate, vi.fn(), workflowGet);

      for (let observation = 0; observation < 12; observation += 1) {
        await orchestrator.scheduled({} as ScheduledController, env as never);
      }

      expect(database.reconciliationRows[0]).toMatchObject({
        failed_at: null,
        last_error_code: "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN",
        projection_unknown_count: 12,
        projection_unknown_first_observed_at: expect.any(String),
        projection_unknown_last_observed_at: expect.any(String),
        projection_unknown_alerted_at: expect.any(String)
      });
      expect(
        new Set(workflowCreate.mock.calls.map(([input]) => input.id))
      ).toEqual(new Set([`projection-rebuild-${await sha256(row.event_id)}`]));
      expect(
        database.runCalls.some(({ sql }) =>
          sql.includes("SET failed_at = ?, next_attempt_at = NULL")
        )
      ).toBe(false);
    }
  );

  it("treats an unrecognized Workflow status as unknown instead of clearing evidence", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const database = new FakeDatabase({
      admissions: [1],
      reconciliationRows: [reconciliationRow(row, null)]
    });
    const workflowCreate = vi.fn(async () => {
      throw new Error("The Workflow already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "future-platform-status" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(database.reconciliationRows[0]).toMatchObject({
      failed_at: null,
      last_error_code: null,
      projection_unknown_count: 1,
      projection_unknown_first_observed_at: expect.any(String),
      projection_unknown_last_observed_at: expect.any(String),
      projection_unknown_alerted_at: null
    });
  });

  it("clears a recovered alert and permits a later unknown episode to alert again", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const database = new FakeDatabase({
      admissions: Array.from({ length: 13 }, () => 1),
      reconciliationRows: [
        reconciliationRow(row, null, {
          last_error_code: "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN",
          projection_unknown_count: 12,
          projection_unknown_first_observed_at: "2026-07-26T00:05:00.000Z",
          projection_unknown_last_observed_at: "2026-07-26T01:00:00.000Z",
          projection_unknown_alerted_at: "2026-07-26T01:00:00.000Z"
        })
      ]
    });
    const workflowCreate = vi.fn(async () => {
      throw new Error("The Workflow already exists.");
    });
    const runningGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "waitingForPause" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), runningGet) as never
    );

    expect(database.reconciliationRows[0]).toMatchObject({
      failed_at: null,
      last_error_code: null,
      projection_unknown_count: 0,
      projection_unknown_first_observed_at: null,
      projection_unknown_last_observed_at: null,
      projection_unknown_alerted_at: null
    });

    const unknownGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "unknown" }))
    }));
    const unknownEnv = environment(database, workflowCreate, vi.fn(), unknownGet);
    for (let observation = 0; observation < 12; observation += 1) {
      await orchestrator.scheduled({} as ScheduledController, unknownEnv as never);
    }

    expect(database.reconciliationRows[0]).toMatchObject({
      failed_at: null,
      last_error_code: "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN",
      projection_unknown_count: 12,
      projection_unknown_first_observed_at: expect.any(String),
      projection_unknown_last_observed_at: expect.any(String),
      projection_unknown_alerted_at: expect.any(String)
    });
  });

  it("does not count a generic non-status reconciliation error as control-plane unknown", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const database = new FakeDatabase({
      admissions: [1],
      reconciliationRows: [
        reconciliationRow(row, null, {
          projection_unknown_count: 5,
          projection_unknown_first_observed_at: "2026-07-26T00:05:00.000Z",
          projection_unknown_last_observed_at: "2026-07-26T00:25:00.000Z"
        })
      ],
      failRunOnceMatching: "INSERT INTO workflow_runs"
    });
    const workflowCreate = vi.fn(async () => {
      throw new Error("The Workflow already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "complete" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(database.reconciliationRows[0]).toMatchObject({
      failed_at: null,
      last_error_code: null,
      projection_unknown_count: 5,
      projection_unknown_first_observed_at: "2026-07-26T00:05:00.000Z",
      projection_unknown_last_observed_at: "2026-07-26T00:25:00.000Z",
      projection_unknown_alerted_at: null
    });
  });

  it("counts one unknown observation when overlapping reconcilers read the same state", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const stale = reconciliationRow(row, null);
    const database = new FakeDatabase({
      admissions: [1, 1],
      reconciliationRows: [{ ...stale }],
      reconciliationReads: [[{ ...stale }], [{ ...stale }]]
    });
    const workflowCreate = vi.fn(async () => {
      throw new Error("The Workflow already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "unknown" }))
    }));
    const env = environment(database, workflowCreate, vi.fn(), workflowGet);

    await orchestrator.scheduled({} as ScheduledController, env as never);
    await orchestrator.scheduled({} as ScheduledController, env as never);

    expect(database.reconciliationRows[0]).toMatchObject({
      failed_at: null,
      last_error_code: null,
      projection_unknown_count: 1
    });
    const updates = database.runCalls.filter(({ sql }) =>
      sql.includes("projection_unknown_count = CASE")
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]?.bindings.slice(-3)).toEqual([0, null, null]);
    expect(updates[1]?.bindings.slice(-3)).toEqual([0, null, null]);
  });

  it("does not let a stale known observation clear a concurrent unknown alert", async () => {
    const row = await projectionRebuildOutboxRow(0);
    const stale = reconciliationRow(row, null, {
      projection_unknown_count: 11,
      projection_unknown_first_observed_at: "2026-07-26T00:05:00.000Z",
      projection_unknown_last_observed_at: "2026-07-26T00:55:00.000Z"
    });
    const database = new FakeDatabase({
      admissions: [1, 1],
      reconciliationRows: [{ ...stale }],
      reconciliationReads: [[{ ...stale }], [{ ...stale }]]
    });
    const workflowCreate = vi.fn(async () => {
      throw new Error("The Workflow already exists.");
    });
    const unknownGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "unknown" }))
    }));
    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), unknownGet) as never
    );

    const knownGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "running" }))
    }));
    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), knownGet) as never
    );

    expect(database.reconciliationRows[0]).toMatchObject({
      failed_at: null,
      last_error_code: "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN",
      projection_unknown_count: 12,
      projection_unknown_first_observed_at: "2026-07-26T00:05:00.000Z",
      projection_unknown_last_observed_at: expect.any(String),
      projection_unknown_alerted_at: expect.any(String)
    });
  });

  it("no-ops Workflow entry when the project is already fenced", async () => {
    const database = new FakeDatabase({ admissions: [0] });
    const steps: string[] = [];

    await MemoryWorkflow.prototype.run.call(
      { env: environment(database, vi.fn()) },
      workflowEvent(),
      workflowStep(steps)
    );

    expect(steps).toEqual(["check workflow admission"]);
    expect(database.runs).toEqual([]);
  });

  it.each([
    ["check workflow admission", "projection-rebuild-base"],
    ["record workflow start", "projection-rebuild-base-repair-1"]
  ])(
    "upserts a failed repair-aware run when %s fails before the start row",
    async (failedStep, instanceId) => {
      const database = new FakeDatabase({ admissions: [1] });
      const steps: string[] = [];
      const event = projectionRebuildWorkflowEvent(instanceId);

      await expect(
        MemoryWorkflow.prototype.run.call(
          { env: environment(database, vi.fn()) },
          event as never,
          workflowStep(steps, { failOnceAt: failedStep })
        )
      ).rejects.toThrow(`Forced ${failedStep} failure.`);

      expect(database.workflowRun).toMatchObject({
        workflow_id: instanceId,
        root_workflow_id: event.payload.eventId,
        project_id: PROJECT_ID,
        workflow_type: "projection.rebuild.requested",
        status: "failed",
        attempt: 1,
        last_error_code: "INTERNAL"
      });
      const failureWrite = database.runCalls.find(({ sql }) =>
        sql.includes("VALUES (?, ?, ?, ?, 'failed', 1")
      );
      expect(failureWrite?.sql).toContain(
        "workflow_runs.root_workflow_id = excluded.root_workflow_id"
      );
      expect(failureWrite?.sql).toContain(
        "workflow_runs.project_id = excluded.project_id"
      );
      expect(failureWrite?.sql).toContain(
        "workflow_runs.workflow_type = excluded.workflow_type"
      );
      expect(failureWrite?.sql).toContain(
        "workflow_runs.status NOT IN ('complete', 'terminated')"
      );
    }
  );

  it("records an unavailable rebuild as failed when admission returns false", async () => {
    const database = new FakeDatabase({ admissions: [0] });
    const steps: string[] = [];
    const event = projectionRebuildWorkflowEvent("projection-rebuild-fenced");

    await expect(
      MemoryWorkflow.prototype.run.call(
        { env: environment(database, vi.fn()) },
        event as never,
        workflowStep(steps)
      )
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });

    expect(steps).toEqual(["check workflow admission", "record workflow failure"]);
    expect(database.workflowRun).toMatchObject({
      workflow_id: event.instanceId,
      root_workflow_id: event.payload.eventId,
      status: "failed",
      last_error_code: "PROJECT_UNAVAILABLE"
    });
  });

  it("records a rebuild as failed when admission is revoked before the start write", async () => {
    const database = new FakeDatabase({ admissions: [1, 0] });
    const steps: string[] = [];
    const event = projectionRebuildWorkflowEvent("projection-rebuild-raced-fence");

    await expect(
      MemoryWorkflow.prototype.run.call(
        { env: environment(database, vi.fn()) },
        event as never,
        workflowStep(steps)
      )
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });

    expect(steps).toEqual([
      "check workflow admission",
      "record workflow start",
      "record workflow failure"
    ]);
    expect(database.workflowRun).toMatchObject({
      workflow_id: event.instanceId,
      root_workflow_id: event.payload.eventId,
      status: "failed",
      last_error_code: "PROJECT_UNAVAILABLE"
    });
  });

  it("does not overwrite a complete run while recording an earlier step failure", async () => {
    const event = projectionRebuildWorkflowEvent("projection-rebuild-complete");
    const complete = workflowRun(event, "complete", null);
    const database = new FakeDatabase({ admissions: [], workflowRun: complete });

    await expect(
      MemoryWorkflow.prototype.run.call(
        { env: environment(database, vi.fn()) },
        event as never,
        workflowStep([], { failOnceAt: "check workflow admission" })
      )
    ).rejects.toThrow("Forced check workflow admission failure.");

    expect(database.workflowRun).toEqual(complete);
  });

  it("fails closed instead of crossing an existing event identity", async () => {
    const event = projectionRebuildWorkflowEvent("projection-rebuild-collision");
    const database = new FakeDatabase({
      admissions: [],
      workflowRun: {
        ...workflowRun(event, "running", null),
        root_workflow_id: "projection-rebuild:snapshot:another-event"
      }
    });

    await expect(
      MemoryWorkflow.prototype.run.call(
        { env: environment(database, vi.fn()) },
        event as never,
        workflowStep([], { failOnceAt: "check workflow admission" })
      )
    ).rejects.toThrow("The Workflow run identity conflicts with an existing record.");

    expect(database.workflowRun?.root_workflow_id).toBe(
      "projection-rebuild:snapshot:another-event"
    );
    expect(database.workflowRun?.status).toBe("running");
  });

  it("rechecks admission at execution and writes no projection after a raced fence", async () => {
    const database = new FakeDatabase({ admissions: [1, 1, 0] });
    const steps: string[] = [];
    const stepOptions = new Map<string, unknown>();
    const env = environment(database, vi.fn());

    await MemoryWorkflow.prototype.run.call(
      { env },
      workflowEvent(),
      workflowStep(steps, { capturedOptions: stepOptions })
    );

    expect(steps).toEqual([
      "check workflow admission",
      "record workflow start",
      "apply quality policy",
      "record workflow completion"
    ]);
    expect(database.runs).toHaveLength(2);
    expect(database.runs[0]).toContain("INSERT INTO workflow_runs");
    expect(database.runs[1]).toContain("status = 'complete'");
    expect(stepOptions.get("apply quality policy")).toMatchObject({
      timeout: "15 minutes"
    });
    expect(database.workflowRun).toMatchObject({
      status: "complete",
      last_error_code: null
    });
  });

  it("completes a deferred candidate workflow with only the fixed model stage code", async () => {
    const fakeSecret = "fake-secret-from-workers-ai-error";
    const database = new FakeDatabase({
      admissions: [1, 1, 1],
      candidateRows: [
        {
          content: "D1 remains the authoritative memory store.",
          session_id: "session-1",
          evidence_id: "evidence-1",
          repository_id: "repository-1",
          repository_ref: "refs/heads/main",
          repository_authority: "agent_supplied",
          source_type: "agent_submission"
        }
      ],
      repositoryIds: ["repository-1"]
    });
    const aiRun = vi.fn(async () => {
      throw new Error(fakeSecret);
    });
    const event = candidateWorkflowEvent();

    await MemoryWorkflow.prototype.run.call(
      { env: environment(database, vi.fn(), vi.fn(), vi.fn(), { run: aiRun }) },
      event as never,
      workflowStep([])
    );

    expect(
      database.allCalls.some(({ sql }) => sql.includes("FROM observations AS candidate"))
    ).toBe(true);
    expect(
      database.allCalls.some(({ sql }) => sql.includes("SELECT repository_id FROM repositories"))
    ).toBe(true);
    expect(database.workflowRun).toMatchObject({
      workflow_id: event.instanceId,
      status: "complete",
      last_error_code: "AI_ANALYSIS_DEFERRED_MODEL_CALL"
    });
    expect(aiRun).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(database.workflowRun)).not.toContain(fakeSecret);
  });

  it("rejects coordinator mutation admission for a fenced project", async () => {
    const database = new FakeDatabase({ admissions: [] });
    const response = await ProjectCoordinator.prototype.fetch.call(
      { env: environment(database, vi.fn()) },
      new Request("https://project-coordinator/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "correct",
          target_memory_id: "00000000-0000-4000-8000-000000000001",
          expected_memory_version: 1,
          expected_project_version: 1,
          project_id: PROJECT_ID,
          actor_principal_id: "synthetic-principal",
          payload: { content: "corrected" },
          evidence: [{ source_type: "test", locator: "memory://test" }],
          target_repository_context: {
            scope: "project",
            scope_id: PROJECT_ID,
            repository_id: null,
            repository_ref: null,
            session_id: null,
            worktree_id: null
          },
          idempotency_key: "idempotency-1"
        })
      })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
  });
});

describe("ordinary Workflow outbox reconciliation", () => {
  it("recovers a dispatched Queue event with no Workflow run and defers duplicate Cron work", async () => {
    const row = ordinaryReconciliationRow("candidate.submitted", null);
    const database = new FakeDatabase({
      admissions: [1],
      ordinaryReconciliationRows: [row]
    });
    const workflowCreate = vi.fn();
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "running" }))
    }));
    const env = environment(database, workflowCreate, vi.fn(), workflowGet);

    await orchestrator.scheduled({} as ScheduledController, env as never);
    await orchestrator.scheduled({} as ScheduledController, env as never);

    expect(workflowCreate).toHaveBeenCalledOnce();
    expect(workflowCreate).toHaveBeenCalledWith({
      id: row.event_id,
      params: {
        eventId: row.event_id,
        projectId: PROJECT_ID,
        type: "candidate.submitted",
        subjectId: "candidate-1"
      }
    });
    expect(row).toMatchObject({
      failed_at: null,
      next_attempt_at: expect.any(String),
      last_error_code: "WORKFLOW_RECONCILIATION_PENDING"
    });
    const query = database.allCalls.find(({ sql }) =>
      sql.includes("ordinary_workflow_reconcile")
    );
    expect(query?.bindings.at(-1)).toBe(20);
    expect(query?.sql).toContain("e.event_type <> 'projection.rebuild.requested'");
  });

  it("recreates a missing ordinary project-version Workflow with its stable identity", async () => {
    const row = ordinaryReconciliationRow("memory.changed", null);
    const database = new FakeDatabase({
      admissions: [1],
      ordinaryReconciliationRows: [row]
    });
    const workflowCreate = vi.fn();
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "running" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(workflowCreate).toHaveBeenCalledWith({
      id: `projection-${PROJECT_ID}-1`,
      params: {
        eventId: `${PROJECT_ID}:1`,
        projectId: PROJECT_ID,
        type: "memory.changed",
        subjectId: "memory-1",
        projectVersion: 1
      }
    });
  });

  it.each(["errored", "terminated"])(
    "starts one deterministic repair after a D1 failure and control-plane %s status",
    async (terminalStatus) => {
      const row = ordinaryReconciliationRow("candidate.submitted", "failed", {
        latest_workflow_id: "candidate-event-repair-1"
      });
      const database = new FakeDatabase({
        admissions: [1],
        ordinaryReconciliationRows: [row]
      });
      const workflowCreate = vi.fn(async ({ id }: { id: string }) => {
        if (id === row.event_id || id === `${row.event_id}-repair-1`) {
          throw new Error("The prior Workflow already exists.");
        }
      });
      const workflowGet = vi.fn((id: string) => ({
        status: vi.fn(async () => ({
          status: id === row.event_id ? "errored" : terminalStatus
        }))
      }));

      await orchestrator.scheduled(
        {} as ScheduledController,
        environment(database, workflowCreate, vi.fn(), workflowGet) as never
      );

      expect(workflowCreate.mock.calls.map(([input]) => input.id)).toEqual([
        row.event_id,
        `${row.event_id}-repair-1`,
        `${row.event_id}-repair-2`
      ]);
      expect(row).toMatchObject({
        failed_at: null,
        last_error_code: "WORKFLOW_RECONCILIATION_PENDING"
      });
    }
  );

  it("does not repair from D1 failed state while the control plane is still running", async () => {
    const row = ordinaryReconciliationRow("candidate.submitted", "failed");
    const database = new FakeDatabase({
      admissions: [1],
      ordinaryReconciliationRows: [row]
    });
    const workflowCreate = vi.fn(async (_options: { id: string }) => {
      throw new Error("The Workflow already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "running" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(workflowCreate.mock.calls.map(([input]) => input.id)).toEqual([row.event_id]);
    expect(row).toMatchObject({
      failed_at: null,
      last_error_code: "WORKFLOW_RECONCILIATION_PENDING"
    });
  });

  it("defers an unknown control-plane result without creating a repair", async () => {
    const row = ordinaryReconciliationRow("candidate.submitted", "failed");
    const database = new FakeDatabase({
      admissions: [1],
      ordinaryReconciliationRows: [row]
    });
    const workflowCreate = vi.fn(async (_options: { id: string }) => {
      throw new Error("The Workflow already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => {
        throw new Error("The Workflow status is temporarily unavailable.");
      })
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(workflowCreate.mock.calls.map(([input]) => input.id)).toEqual([row.event_id]);
    expect(row).toMatchObject({
      failed_at: null,
      next_attempt_at: expect.any(String),
      last_error_code: "WORKFLOW_CONTROL_PLANE_UNKNOWN"
    });
  });

  it("terminalizes an ordinary outbox row after every bounded repair is exhausted", async () => {
    const row = ordinaryReconciliationRow("candidate.submitted", "failed");
    const database = new FakeDatabase({
      admissions: [1],
      ordinaryReconciliationRows: [row]
    });
    const workflowCreate = vi.fn(async (_options: { id: string }) => {
      throw new Error("The Workflow already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "errored" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(workflowCreate.mock.calls.map(([input]) => input.id)).toEqual([
      row.event_id,
      `${row.event_id}-repair-1`,
      `${row.event_id}-repair-2`,
      `${row.event_id}-repair-3`
    ]);
    expect(row).toMatchObject({
      failed_at: expect.any(String),
      next_attempt_at: null,
      last_error_code: "WORKFLOW_REPAIR_EXHAUSTED"
    });
  });

  it("restores missing D1 completion state from a control-plane-complete Workflow", async () => {
    const row = ordinaryReconciliationRow("candidate.submitted", null);
    const database = new FakeDatabase({
      admissions: [1],
      ordinaryReconciliationRows: [row]
    });
    const workflowCreate = vi.fn(async () => {
      throw new Error("The completed Workflow already exists.");
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "complete" }))
    }));

    await orchestrator.scheduled(
      {} as ScheduledController,
      environment(database, workflowCreate, vi.fn(), workflowGet) as never
    );

    expect(database.workflowRun).toMatchObject({
      workflow_id: row.event_id,
      root_workflow_id: row.event_id,
      workflow_type: "candidate.submitted",
      status: "complete"
    });
    expect(row).toMatchObject({
      failed_at: null,
      next_attempt_at: null,
      last_error_code: "WORKFLOW_COMPLETE"
    });
  });

  it("keeps overlapping stale Cron reads on one stable Workflow identity", async () => {
    const row = ordinaryReconciliationRow("candidate.submitted", null);
    const stale = { ...row };
    const database = new FakeDatabase({
      admissions: [1, 1],
      ordinaryReconciliationRows: [row],
      ordinaryReconciliationReads: [[stale], [stale]]
    });
    let created = false;
    const workflowCreate = vi.fn(async (_options: { id: string }) => {
      if (created) {
        throw new Error("The Workflow already exists.");
      }
      created = true;
    });
    const workflowGet = vi.fn(() => ({
      status: vi.fn(async () => ({ status: "running" }))
    }));
    const env = environment(database, workflowCreate, vi.fn(), workflowGet);

    await orchestrator.scheduled({} as ScheduledController, env as never);
    await orchestrator.scheduled({} as ScheduledController, env as never);

    expect(workflowCreate.mock.calls.map(([input]) => input.id)).toEqual([
      row.event_id,
      row.event_id
    ]);
    expect(
      database.runCalls
        .filter(({ sql }) => sql.includes("ordinary_workflow_defer"))
        .every(({ sql }) =>
          sql.includes("AND next_attempt_at IS ? AND last_error_code IS ?")
        )
    ).toBe(true);
    expect(row).toMatchObject({
      failed_at: null,
      last_error_code: "WORKFLOW_RECONCILIATION_PENDING"
    });
  });
});

function workflowEvent() {
  return {
    instanceId: "projection-synthetic-project-1",
    timestamp: new Date("2026-07-26T00:00:00.000Z"),
    payload: {
      eventId: "synthetic-project:1",
      projectId: PROJECT_ID,
      type: "memory.changed" as const,
      subjectId: "memory-1",
      projectVersion: 1
    }
  } as never;
}

function candidateWorkflowEvent() {
  return {
    instanceId: "candidate-workflow-instance",
    timestamp: new Date("2026-07-28T00:00:00.000Z"),
    payload: {
      eventId: "candidate-event",
      projectId: PROJECT_ID,
      type: "candidate.submitted" as const,
      subjectId: "candidate-1"
    }
  };
}

function projectionRebuildWorkflowEvent(instanceId: string) {
  return {
    instanceId,
    timestamp: new Date("2026-07-26T00:00:00.000Z"),
    payload: {
      eventId: "projection-rebuild:snapshot:root-event",
      projectId: PROJECT_ID,
      type: "projection.rebuild.requested" as const,
      subjectId: PROJECT_ID,
      projectVersion: 1,
      projectionRebuild: {
        mode: "snapshot" as const,
        searchGenerationId: "generation-1",
        memoryCount: 2,
        revisionCount: 2,
        scopeCount: 2,
        contentBytes: 9,
        headDigest: "b".repeat(64)
      }
    }
  };
}

function projectionRebuildWorkflowEventFromOutbox(
  row: Awaited<ReturnType<typeof projectionRebuildOutboxRow>>,
  instanceId: string
) {
  const payload = JSON.parse(row.payload_json) as {
    eventId: string;
    projectId: string;
    projectVersion: number;
    projectionMode: "snapshot";
    searchGenerationId: string;
    memoryCount: number;
    revisionCount: number;
    scopeCount: number;
    contentBytes: number;
    headDigest: string;
  };
  return {
    instanceId,
    timestamp: new Date("2026-07-26T00:00:00.000Z"),
    payload: {
      eventId: payload.eventId,
      projectId: payload.projectId,
      type: "projection.rebuild.requested" as const,
      subjectId: payload.projectId,
      projectVersion: payload.projectVersion,
      projectionRebuild: {
        mode: payload.projectionMode,
        searchGenerationId: payload.searchGenerationId,
        memoryCount: payload.memoryCount,
        revisionCount: payload.revisionCount,
        scopeCount: payload.scopeCount,
        contentBytes: payload.contentBytes,
        headDigest: payload.headDigest
      }
    }
  };
}

function reconciliationRow(
  row: Awaited<ReturnType<typeof projectionRebuildOutboxRow>>,
  latestWorkflowStatus: string | null,
  overrides: Record<string, unknown> = {}
) {
  return {
    ...row,
    dispatched_at: "2026-07-26T00:01:00.000Z",
    failed_at: null,
    next_attempt_at: null,
    last_error_code: null,
    projection_unknown_count: 0,
    projection_unknown_first_observed_at: null,
    projection_unknown_last_observed_at: null,
    projection_unknown_alerted_at: null,
    latest_workflow_id:
      latestWorkflowStatus === null ? null : "projection-rebuild-existing",
    latest_workflow_status: latestWorkflowStatus,
    ...overrides
  };
}

function ordinaryReconciliationRow(
  eventType: "candidate.submitted" | "memory.changed",
  latestWorkflowStatus: string | null,
  overrides: Record<string, unknown> = {}
) {
  const eventId = eventType === "memory.changed" ? "memory-event" : "candidate-event";
  const payload =
    eventType === "memory.changed"
      ? {
          type: eventType,
          eventId,
          projectId: PROJECT_ID,
          memoryId: "memory-1",
          projectVersion: 1
        }
      : {
          type: eventType,
          eventId,
          projectId: PROJECT_ID,
          candidateId: "candidate-1",
          idempotencyKey: "candidate-idempotency"
        };
  return {
    event_id: eventId,
    project_id: PROJECT_ID,
    project_version: 1,
    event_type: eventType,
    payload_digest: `${eventType}-digest`,
    payload_json: JSON.stringify(payload),
    created_at: "2026-07-26T00:00:00.000Z",
    dispatched_at: "2026-07-26T00:01:00.000Z",
    failed_at: null,
    next_attempt_at: null,
    last_error_code: null,
    latest_workflow_id:
      latestWorkflowStatus === null
        ? null
        : eventType === "memory.changed"
          ? `projection-${PROJECT_ID}-1`
          : eventId,
    latest_workflow_status: latestWorkflowStatus,
    ...overrides
  };
}

function projectionOutboxRow(eventId: string, memoryId: string, attempt = 0) {
  return {
    event_id: eventId,
    project_id: PROJECT_ID,
    event_type: "memory.changed",
    payload_json: JSON.stringify({
      type: "memory.changed",
      eventId,
      projectId: PROJECT_ID,
      memoryId,
      projectVersion: 1
    }),
    attempt
  };
}

async function projectionRebuildOutboxRow(executionOrdinal: number) {
  const projectionTargetId = await sha256(
    [
      "edgemneme.projection-rebuild",
      "snapshot",
      PROJECT_ID,
      "1",
      "generation-1",
      "2",
      "2",
      "2",
      "9",
      "b".repeat(64)
    ].join("\n")
  );
  const eventId =
    "projection-rebuild:snapshot:" +
    (await sha256(`${projectionTargetId}\n${executionOrdinal}`));
  const payloadJson = JSON.stringify({
    type: "projection.rebuild.requested",
    eventId,
    projectId: PROJECT_ID,
    projectVersion: 1,
    projectionMode: "snapshot",
    searchGenerationId: "generation-1",
    projectionTargetId,
    executionOrdinal,
    memoryCount: 2,
    revisionCount: 2,
    scopeCount: 2,
    contentBytes: 9,
    headDigest: "b".repeat(64)
  });
  return {
    event_id: eventId,
    project_id: PROJECT_ID,
    project_version: 1,
    event_type: "projection.rebuild.requested",
    payload_digest: await sha256(payloadJson),
    payload_json: payloadJson,
    attempt: 0
  };
}

function workflowStep(
  names: string[],
  options: {
    failOnceAt?: string | readonly string[];
    capturedOptions?: Map<string, unknown>;
  } = {}
) {
  const failures = new Set(
    options.failOnceAt === undefined
      ? []
      : typeof options.failOnceAt === "string"
        ? [options.failOnceAt]
        : options.failOnceAt
  );
  return {
    async do(name: string, ...values: unknown[]) {
      names.push(name);
      if (values.length > 1) {
        options.capturedOptions?.set(name, values[0]);
      }
      if (failures.delete(name)) {
        throw new Error(`Forced ${name} failure.`);
      }
      const callback = values.at(-1);
      if (typeof callback !== "function") {
        throw new Error("The Workflow test step has no callback.");
      }
      return callback();
    }
  } as never;
}

interface WorkflowRunRow {
  workflow_id: string;
  root_workflow_id: string;
  project_id: string;
  workflow_type: string;
  status: string;
  attempt: number;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

function workflowRun(
  event: ReturnType<typeof projectionRebuildWorkflowEvent>,
  status: string,
  lastErrorCode: string | null
): WorkflowRunRow {
  return {
    workflow_id: event.instanceId,
    root_workflow_id: event.payload.eventId,
    project_id: event.payload.projectId,
    workflow_type: event.payload.type,
    status,
    attempt: 1,
    last_error_code: lastErrorCode,
    created_at: event.timestamp.toISOString(),
    updated_at: event.timestamp.toISOString()
  };
}

function environment(
  database: FakeDatabase,
  workflowCreate: ReturnType<typeof vi.fn>,
  send = vi.fn(),
  workflowGet = vi.fn(),
  ai: unknown = {}
) {
  const emptySearchStatement = {
    bind() {
      return this;
    },
    async first() {
      return {
        cursor_version: 0,
        cursor_generation_id: null,
        cursor_project_id: null,
        cursor_memory_id: null
      };
    },
    async all() {
      return { results: [] };
    },
    async run() {
      return { meta: { changes: 1 } };
    }
  };
  return {
    MEMORY_DB: database,
    SEARCH_DB: { prepare: vi.fn(() => ({ ...emptySearchStatement })) },
    PROJECTIONS: {
      put: vi.fn(() => {
        throw new Error("A fenced Workflow attempted an R2 projection.");
      })
    },
    MEMORY_VECTORS: { deleteByIds: vi.fn(), getByIds: vi.fn(async () => []) },
    AI: ai,
    MEMORY_WORKFLOW: {
      create: workflowCreate,
      get: workflowGet
    },
    MEMORY_OUTBOX: { send }
  };
}

class FakeDatabase {
  readonly runs: string[] = [];
  readonly runCalls: Array<{ sql: string; bindings: unknown[] }> = [];
  readonly allCalls: Array<{ sql: string; bindings: unknown[] }> = [];
  readonly admissions: number[];
  readonly outboxRows: Array<Record<string, unknown>>;
  readonly reconciliationRows: Array<Record<string, unknown>>;
  readonly ordinaryReconciliationRows: Array<Record<string, unknown>>;
  readonly candidateRows: Array<Record<string, unknown>>;
  readonly repositoryIds: string[];
  private readonly reconciliationReads: Array<Array<Record<string, unknown>>>;
  private readonly ordinaryReconciliationReads: Array<Array<Record<string, unknown>>>;
  private failRunOnceMatching: string | null;
  workflowRun: WorkflowRunRow | null;

  constructor(options: {
    admissions: number[];
    outboxRows?: Array<Record<string, unknown>>;
    reconciliationRows?: Array<Record<string, unknown>>;
    reconciliationReads?: Array<Array<Record<string, unknown>>>;
    ordinaryReconciliationRows?: Array<Record<string, unknown>>;
    ordinaryReconciliationReads?: Array<Array<Record<string, unknown>>>;
    workflowRun?: WorkflowRunRow;
    failRunOnceMatching?: string;
    candidateRows?: Array<Record<string, unknown>>;
    repositoryIds?: string[];
  }) {
    this.admissions = [...options.admissions];
    this.outboxRows = options.outboxRows ?? [];
    this.reconciliationRows = options.reconciliationRows ?? [];
    this.reconciliationReads = (options.reconciliationReads ?? []).map((rows) =>
      rows.map((row) => ({ ...row }))
    );
    this.ordinaryReconciliationRows = options.ordinaryReconciliationRows ?? [];
    this.ordinaryReconciliationReads = (options.ordinaryReconciliationReads ?? []).map(
      (rows) => rows.map((row) => ({ ...row }))
    );
    this.failRunOnceMatching = options.failRunOnceMatching ?? null;
    this.workflowRun = options.workflowRun === undefined ? null : { ...options.workflowRun };
    this.candidateRows = (options.candidateRows ?? []).map((row) => ({ ...row }));
    this.repositoryIds = [...(options.repositoryIds ?? [])];
  }

  withSession(_constraint: "first-primary"): FakeDatabase {
    return this;
  }

  prepare(sql: string) {
    const database = this;
    let bindings: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        bindings = values;
        return this;
      },
      async all() {
        database.allCalls.push({ sql, bindings: [...bindings] });
        if (sql.includes("FROM synthetic_cleanup_registry r")) {
          return { results: [] };
        }
        if (sql.includes("INDEXED BY outbox_projection_rebuild_reconcile")) {
          const rows =
            database.reconciliationReads.shift() ?? database.reconciliationRows;
          return { results: rows.map((row) => ({ ...row })) };
        }
        if (sql.includes("ordinary_workflow_reconcile")) {
          const staleRows = database.ordinaryReconciliationReads.shift();
          const rows =
            staleRows ??
            database.ordinaryReconciliationRows.filter((row) =>
              database.isOrdinaryReconciliationReady(row, String(bindings[0]))
            );
          return {
            results: rows
              .slice(0, Number(bindings.at(-1)))
              .map((row) => ({ ...row }))
          };
        }
        if (sql.includes("FROM outbox_events")) {
          return { results: database.outboxRows };
        }
        if (sql.includes("FROM observations AS candidate")) {
          return { results: database.candidateRows.map((row) => ({ ...row })) };
        }
        if (sql.includes("SELECT repository_id FROM repositories")) {
          return {
            results: database.repositoryIds.map((repository_id) => ({ repository_id }))
          };
        }
        return { results: [] };
      },
      async first() {
        if (sql.includes("AS admitted")) {
          return { admitted: database.admissions.shift() ?? 0 };
        }
        if (sql.includes("FROM workflow_runs") && sql.includes("WHERE workflow_id = ?")) {
          return database.workflowRun?.workflow_id === bindings[0]
            ? { ...database.workflowRun }
            : null;
        }
        return null;
      },
      async run() {
        database.runs.push(sql);
        database.runCalls.push({ sql, bindings: [...bindings] });
        if (
          database.failRunOnceMatching !== null &&
          sql.includes(database.failRunOnceMatching)
        ) {
          database.failRunOnceMatching = null;
          throw new Error("Forced D1 outbox dispatch write failure.");
        }
        if (sql.includes("INSERT INTO workflow_runs")) {
          return { meta: { changes: database.upsertWorkflowRun(sql, bindings) } };
        }
        if (
          sql.includes("UPDATE workflow_runs") &&
          sql.includes("SET status = 'complete', last_error_code = ?")
        ) {
          return { meta: { changes: database.completeWorkflowRun(bindings) } };
        }
        const ordinaryReconciliationChanges =
          database.applyOrdinaryReconciliationMutation(sql, bindings);
        if (ordinaryReconciliationChanges !== null) {
          return { meta: { changes: ordinaryReconciliationChanges } };
        }
        const reconciliationChanges = database.applyProjectionReconciliationMutation(
          sql,
          bindings
        );
        if (reconciliationChanges !== null) {
          return { meta: { changes: reconciliationChanges } };
        }
        return { meta: { changes: 1 } };
      }
    };
  }

  async batch(statements: unknown[]) {
    return statements.map(() => ({ meta: { changes: 1 } }));
  }

  private applyOrdinaryReconciliationMutation(
    sql: string,
    bindings: unknown[]
  ): number | null {
    let eventIndex: number;
    let observedNextIndex: number;
    let observedErrorIndex: number;
    let nextAttemptAt: unknown;
    let errorCode: unknown;
    let failedAt: unknown = null;

    if (sql.includes("ordinary_workflow_defer")) {
      nextAttemptAt = bindings[0];
      errorCode = bindings[1];
      eventIndex = 2;
      observedNextIndex = 5;
      observedErrorIndex = 6;
    } else if (sql.includes("ordinary_workflow_terminal")) {
      nextAttemptAt = null;
      errorCode = bindings[0];
      eventIndex = 1;
      observedNextIndex = 4;
      observedErrorIndex = 5;
    } else if (sql.includes("ordinary_workflow_fail")) {
      failedAt = bindings[0];
      nextAttemptAt = null;
      errorCode = bindings[1];
      eventIndex = 2;
      observedNextIndex = 5;
      observedErrorIndex = 6;
    } else {
      return null;
    }

    const row = this.ordinaryReconciliationRows.find(
      (candidate) =>
        candidate.event_id === bindings[eventIndex] &&
        candidate.project_id === bindings[eventIndex + 1] &&
        candidate.payload_digest === bindings[eventIndex + 2]
    );
    if (
      row === undefined ||
      !this.isOrdinaryReconciliationActive(row) ||
      (row.next_attempt_at ?? null) !== bindings[observedNextIndex] ||
      (row.last_error_code ?? null) !== bindings[observedErrorIndex]
    ) {
      return 0;
    }
    row.next_attempt_at = nextAttemptAt;
    row.last_error_code = errorCode;
    if (sql.includes("ordinary_workflow_fail")) {
      row.failed_at = failedAt;
    }
    return 1;
  }

  private isOrdinaryReconciliationReady(
    row: Record<string, unknown>,
    observedAt: string
  ): boolean {
    return (
      this.isOrdinaryReconciliationActive(row) &&
      (row.next_attempt_at == null || String(row.next_attempt_at) <= observedAt)
    );
  }

  private isOrdinaryReconciliationActive(row: Record<string, unknown>): boolean {
    return (
      row.dispatched_at != null &&
      row.failed_at == null &&
      (row.last_error_code == null ||
        row.last_error_code === "WORKFLOW_RECONCILIATION_PENDING" ||
        row.last_error_code === "WORKFLOW_CONTROL_PLANE_UNKNOWN")
    );
  }

  private applyProjectionReconciliationMutation(
    sql: string,
    bindings: unknown[]
  ): number | null {
    if (sql.includes("projection_unknown_count = CASE")) {
      const row = this.findReconciliationRow(bindings[10], bindings[11], bindings[12]);
      if (
        row === undefined ||
        Number(row.projection_unknown_count ?? 0) !== Number(bindings[14]) ||
        (row.next_attempt_at ?? null) !== bindings[15] ||
        (row.last_error_code ?? null) !== bindings[16]
      ) {
        return 0;
      }
      const threshold = Number(bindings[1]);
      const oldCount = Number(row.projection_unknown_count ?? 0);
      const newCount = Math.min(oldCount + 1, threshold);
      row.next_attempt_at = bindings[0];
      row.projection_unknown_count = newCount;
      row.projection_unknown_first_observed_at =
        oldCount === 0
          ? bindings[2]
          : (row.projection_unknown_first_observed_at ?? bindings[3]);
      row.projection_unknown_last_observed_at = bindings[4];
      if (newCount >= threshold && row.projection_unknown_alerted_at == null) {
        row.projection_unknown_alerted_at = bindings[6];
      }
      row.last_error_code =
        newCount >= threshold || row.last_error_code === bindings[8]
          ? bindings[9]
          : null;
      return 1;
    }

    if (sql.includes("projection_unknown_count = 0")) {
      const row = this.findReconciliationRow(bindings[1], bindings[2], bindings[3]);
      if (
        row === undefined ||
        Number(row.projection_unknown_count ?? 0) !== Number(bindings[4]) ||
        (row.next_attempt_at ?? null) !== bindings[5] ||
        (row.last_error_code ?? null) !== bindings[6]
      ) {
        return 0;
      }
      row.next_attempt_at = bindings[0];
      row.last_error_code = null;
      row.projection_unknown_count = 0;
      row.projection_unknown_first_observed_at = null;
      row.projection_unknown_last_observed_at = null;
      row.projection_unknown_alerted_at = null;
      return 1;
    }

    if (
      sql.includes("SET next_attempt_at = NULL, last_error_code = ?") &&
      sql.includes("PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN")
    ) {
      const row = this.findReconciliationRow(bindings[1], bindings[2], bindings[3]);
      if (row === undefined || !this.isReconciliationPending(row)) {
        return 0;
      }
      row.next_attempt_at = null;
      row.last_error_code = bindings[0];
      return 1;
    }

    if (
      sql.includes("SET failed_at = ?, next_attempt_at = NULL, last_error_code = ?") &&
      sql.includes("PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN")
    ) {
      const row = this.findReconciliationRow(bindings[2], bindings[3], bindings[4]);
      if (row === undefined || !this.isReconciliationPending(row)) {
        return 0;
      }
      row.failed_at = bindings[0];
      row.next_attempt_at = null;
      row.last_error_code = bindings[1];
      return 1;
    }

    if (
      sql.includes("SET next_attempt_at = ?") &&
      sql.includes("PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN")
    ) {
      const row = this.findReconciliationRow(bindings[1], bindings[2], bindings[3]);
      if (row === undefined || !this.isReconciliationPending(row)) {
        return 0;
      }
      row.next_attempt_at = bindings[0];
      return 1;
    }

    return null;
  }

  private findReconciliationRow(
    eventId: unknown,
    projectId: unknown,
    payloadDigest: unknown
  ): Record<string, unknown> | undefined {
    return this.reconciliationRows.find(
      (row) =>
        row.event_id === eventId &&
        row.project_id === projectId &&
        row.payload_digest === payloadDigest
    );
  }

  private isReconciliationPending(row: Record<string, unknown>): boolean {
    return (
      row.dispatched_at != null &&
      row.failed_at == null &&
      (row.last_error_code == null ||
        row.last_error_code === "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN")
    );
  }

  private upsertWorkflowRun(sql: string, bindings: unknown[]): number {
    const failed = sql.includes("VALUES (?, ?, ?, ?, 'failed', 1");
    const projectionComplete = sql.includes(
      "VALUES (?, ?, ?, 'projection.rebuild.requested', 'complete', 1"
    );
    const ordinaryComplete = sql.includes("VALUES (?, ?, ?, ?, 'complete', 1");
    const complete = projectionComplete || ordinaryComplete;
    const candidate: WorkflowRunRow = {
      workflow_id: String(bindings[0]),
      root_workflow_id: String(bindings[1]),
      project_id: String(bindings[2]),
      workflow_type: projectionComplete
        ? "projection.rebuild.requested"
        : String(bindings[3]),
      status: failed ? "failed" : complete ? "complete" : "running",
      attempt: 1,
      last_error_code: failed ? String(bindings[4]) : null,
      created_at: String(
        bindings[projectionComplete ? 3 : ordinaryComplete ? 4 : failed ? 5 : 4]
      ),
      updated_at: String(
        bindings[projectionComplete ? 4 : ordinaryComplete ? 5 : failed ? 6 : 5]
      )
    };
    if (this.workflowRun === null) {
      this.workflowRun = candidate;
      return 1;
    }
    if (
      this.workflowRun.workflow_id !== candidate.workflow_id ||
      this.workflowRun.root_workflow_id !== candidate.root_workflow_id ||
      this.workflowRun.project_id !== candidate.project_id ||
      this.workflowRun.workflow_type !== candidate.workflow_type ||
      (complete
        ? this.workflowRun.status === "failed"
        : this.workflowRun.status === "complete") ||
      this.workflowRun.status === "terminated"
    ) {
      return 0;
    }
    this.workflowRun = {
      ...this.workflowRun,
      status: candidate.status,
      attempt: failed ? this.workflowRun.attempt : this.workflowRun.attempt + 1,
      last_error_code: candidate.last_error_code,
      updated_at: candidate.updated_at
    };
    return 1;
  }

  private completeWorkflowRun(bindings: unknown[]): number {
    if (
      this.workflowRun === null ||
      this.workflowRun.workflow_id !== bindings[2] ||
      this.workflowRun.project_id !== bindings[3]
    ) {
      return 0;
    }
    this.workflowRun = {
      ...this.workflowRun,
      status: "complete",
      last_error_code:
        typeof bindings[0] === "string" ? bindings[0] : null,
      updated_at: String(bindings[1])
    };
    return 1;
  }
}
