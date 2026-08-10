import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { GatewayService, type GatewayEnv } from "../src/gateway/service";
import type { AuthenticatedPrincipal } from "../src/security/auth";

const PROJECT_ID = "synthetic-project";
const PRINCIPAL_ID = "synthetic-principal";
const SESSION_ID = "synthetic-session";
const PROJECT_REF = "system.synthetic.synthetic-project";
const NOW = "2026-07-27T12:00:00.000Z";

const principal: AuthenticatedPrincipal = {
  principalId: PRINCIPAL_ID,
  projectId: PROJECT_ID,
  role: "maintainer"
};

describe("GatewayService synthetic cleanup fence", () => {
  it.each([
    [
      "agent metadata containing a prompt transcript",
      {
        agentMeta: {
          transcript:
            "System: You are a coding agent.\nUser: Inspect the repository.\nAssistant: Starting."
        }
      }
    ],
    [
      "worktree metadata containing a raw log",
      {
        agentMeta: { name: "test" },
        worktreeMeta: {
          repository_id: "00000000-0000-4000-8000-000000000099",
          repository_ref:
            "2026-07-28T08:00:00.000Z INFO request started\n2026-07-28T08:00:01.000Z WARN retry scheduled"
        }
      }
    ]
  ])("rejects %s before opening a session", async (_label, metadata) => {
    const fixture = createFixture();
    const before = mutationCounts(fixture.database);

    await expect(
      fixture.service.openSession({
        projectRef: PROJECT_REF,
        ...metadata
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(mutationCounts(fixture.database)).toEqual(before);
    expect(fixture.coordinatorGet).not.toHaveBeenCalled();
  });

  it("continues to accept ordinary agent and empty worktree metadata", async () => {
    const fixture = createFixture();

    const opened = await fixture.service.openSession({
      projectRef: PROJECT_REF,
      agentMeta: { name: "codex", device: "development-machine" },
      worktreeMeta: {}
    });

    expect(opened).toMatchObject({ session_version: 1 });

    expect(mutationCounts(fixture.database)).toMatchObject({ sessions: 2 });
    expect(
      fixture.database
        .prepare(
          `SELECT agent_meta_json, worktree_meta_json FROM sessions
           WHERE session_id = ?`
        )
        .get(opened.session_id as string)
    ).toEqual({
      agent_meta_json: '{"name":"codex","device":"development-machine"}',
      worktree_meta_json: "null"
    });
  });

  it.each([
    [
      "a prompt-shaped source type",
      {
        source_type: "System: policy\nUser: request\nAssistant: response",
        locator: "src/example.ts"
      }
    ],
    [
      "a prompt-shaped locator",
      {
        source_type: "repository_file",
        locator: "System: policy\nUser: request\nAssistant: response"
      }
    ],
    [
      "raw-log metadata",
      {
        source_type: "repository_file",
        locator:
          "2026-07-28T08:00:00.000Z INFO request started\n2026-07-28T08:00:01.000Z WARN retry scheduled"
      }
    ]
  ])("rejects candidate evidence containing %s before D1 work", async (_label, evidence) => {
    const fixture = createFixture();
    const before = mutationCounts(fixture.database);

    await expect(
      fixture.service.submitCandidate({
        projectRef: PROJECT_REF,
        sessionId: SESSION_ID,
        content: "Use pnpm for dependency installation.",
        evidence: [evidence],
        idempotencyKey: `candidate-sensitive-evidence-${_label}`
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(mutationCounts(fixture.database)).toEqual(before);
    expect(fixture.memoryDb.prepareCount).toBe(0);
    expect(fixture.memoryDb.batchCount).toBe(0);
    expect(fixture.coordinatorGet).not.toHaveBeenCalled();
  });

  it("continues to reject agent-submitted GitHub blob evidence", async () => {
    const fixture = createFixture();
    const before = mutationCounts(fixture.database);

    await expect(
      fixture.service.submitCandidate({
        projectRef: PROJECT_REF,
        sessionId: SESSION_ID,
        content: "Use pnpm for dependency installation.",
        evidence: [
          {
            source_type: "github_blob",
            locator: "github://101/0123456789abcdef/src/example.ts"
          }
        ],
        idempotencyKey: "candidate-github-blob-evidence"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "GitHub evidence can only be created by the repository synchronizer."
    });

    expect(mutationCounts(fixture.database)).toEqual(before);
    expect(fixture.memoryDb.prepareCount).toBe(0);
    expect(fixture.memoryDb.batchCount).toBe(0);
    expect(fixture.coordinatorGet).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a prompt-shaped source type",
      {
        source_type: "System: policy\nUser: request\nAssistant: response",
        locator: "docs/decision.md"
      }
    ],
    [
      "a prompt-shaped locator",
      {
        source_type: "repository_file",
        locator: "System: policy\nUser: request\nAssistant: response"
      }
    ],
    [
      "raw-log metadata",
      {
        source_type: "repository_file",
        locator:
          "2026-07-28T08:00:00.000Z INFO request started\n2026-07-28T08:00:01.000Z ERROR request failed"
      }
    ]
  ])("rejects memory-change evidence containing %s before D1 writes or coordinator work", async (
    _label,
    evidence
  ) => {
    const fixture = createFixture();
    const before = mutationCounts(fixture.database);

    await expect(
      fixture.service.submitMemoryChange({
        operation: "invalidate",
        target_memory_id: "00000000-0000-4000-8000-000000000001",
        expected_memory_version: 1,
        expected_project_version: 0,
        payload: { reason: "The previous fact is no longer valid." },
        evidence: [evidence],
        idempotency_key: `change-sensitive-evidence-${_label}`
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(mutationCounts(fixture.database)).toEqual(before);
    expect(fixture.memoryDb.batchCount).toBe(0);
    expect(fixture.coordinatorGet).not.toHaveBeenCalled();
  });

  it("rejects GitHub blob evidence from memory-change submissions before D1 writes", async () => {
    const fixture = createFixture();
    const before = mutationCounts(fixture.database);

    await expect(
      fixture.service.submitMemoryChange({
        operation: "invalidate",
        target_memory_id: "00000000-0000-4000-8000-000000000001",
        expected_memory_version: 1,
        expected_project_version: 0,
        payload: { reason: "The previous fact is no longer valid." },
        evidence: [
          {
            source_type: "github_blob",
            locator: "github://101/0123456789abcdef/docs/decision.md"
          }
        ],
        idempotency_key: "change-github-blob-evidence"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "GitHub evidence can only be created by the repository synchronizer."
    });

    expect(mutationCounts(fixture.database)).toEqual(before);
    expect(fixture.memoryDb.batchCount).toBe(0);
    expect(fixture.coordinatorGet).not.toHaveBeenCalled();
  });

  it.each([
    [
      "session_open",
      (service: GatewayService) =>
        service.openSession({ projectRef: PROJECT_REF, agentMeta: { name: "test" } })
    ],
    [
      "candidate_submit rejected_sensitive",
      (service: GatewayService) =>
        service.submitCandidate({
          projectRef: PROJECT_REF,
          sessionId: SESSION_ID,
          content: "Contact operator@example.com before promotion.",
          evidence: [],
          idempotencyKey: "candidate-fenced"
        })
    ],
    [
      "memory_change_submit",
      (service: GatewayService) =>
        service.submitMemoryChange({ operation: "invalidate", payload: {}, evidence: [] })
    ],
    [
      "candidate_review",
      (service: GatewayService) =>
        service.reviewCandidate({
          candidateId: "00000000-0000-4000-8000-000000000001",
          expectedCandidateVersion: 1,
          decision: "reject",
          reason: "Not durable.",
          idempotencyKey: "review-fenced"
        })
    ],
    [
      "session_close without consolidation",
      (service: GatewayService) =>
        service.closeSession({
          sessionId: SESSION_ID,
          expectedSessionVersion: 1,
          triggerConsolidation: false,
          idempotencyKey: "close-fenced"
        })
    ]
  ])("fails closed for %s after cleanup fencing", async (_operation, invoke) => {
    const fixture = createFixture();
    fenceProject(fixture.database);
    const before = mutationCounts(fixture.database);

    await expect(invoke(fixture.service)).rejects.toMatchObject({
      code: "PROJECT_UNAVAILABLE",
      message: "The project is unavailable."
    });

    expect(mutationCounts(fixture.database)).toEqual(before);
    expect(fixture.coordinatorGet).not.toHaveBeenCalled();
    expect(
      fixture.database.prepare("SELECT status FROM sessions WHERE session_id = ?").get(SESSION_ID)
    ).toEqual({ status: "open" });
  });

  it("rolls back a rejected-sensitive candidate when cleanup wins after preflight", async () => {
    const fixture = createFixture();
    fixture.memoryDb.beforeBatch = (batchNumber) => {
      if (batchNumber === 2) {
        fenceProject(fixture.database);
      }
    };

    await expect(
      fixture.service.submitCandidate({
        projectRef: PROJECT_REF,
        sessionId: SESSION_ID,
        content: "Contact operator@example.com before promotion.",
        evidence: [],
        idempotencyKey: "candidate-race"
      })
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });

    expect(fixture.memoryDb.batchCount).toBe(2);
    expect(mutationCounts(fixture.database)).toMatchObject({
      observations: 0,
      idempotency_records: 0,
      outbox_events: 0
    });
  });

  it("maps authority deletion after open-session preflight to project unavailable", async () => {
    const fixture = createFixture();
    fixture.memoryDb.beforeBatch = (batchNumber) => {
      if (batchNumber === 1) {
        deleteProjectAuthority(fixture.database);
      }
    };

    await expect(
      fixture.service.openSession({
        projectRef: PROJECT_REF,
        agentMeta: { name: "late-open" }
      })
    ).rejects.toMatchObject({
      code: "PROJECT_UNAVAILABLE",
      message: "The project is unavailable."
    });

    expect(fixture.memoryDb.batchCount).toBe(1);
    expect(
      fixture.database.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(PROJECT_ID)
    ).toBeUndefined();
    expect(mutationCounts(fixture.database)).toMatchObject({
      sessions: 0,
      observations: 0,
      idempotency_records: 0,
      outbox_events: 0
    });
  });

  it("maps authority deletion after close-session admission to project unavailable", async () => {
    const fixture = createFixture();
    fixture.memoryDb.beforeBatch = (batchNumber) => {
      if (batchNumber === 2) {
        deleteProjectAuthority(fixture.database);
      }
    };

    await expect(
      fixture.service.closeSession({
        sessionId: SESSION_ID,
        expectedSessionVersion: 1,
        summary: "This close must not survive authority deletion.",
        triggerConsolidation: true,
        idempotencyKey: "close-after-authority-delete"
      })
    ).rejects.toMatchObject({
      code: "PROJECT_UNAVAILABLE",
      message: "The project is unavailable."
    });

    expect(fixture.memoryDb.batchCount).toBe(2);
    expect(
      fixture.database.prepare("SELECT project_id FROM projects WHERE project_id = ?").get(PROJECT_ID)
    ).toBeUndefined();
    expect(mutationCounts(fixture.database)).toMatchObject({
      sessions: 0,
      session_consolidations: 0,
      consolidation_inputs: 0,
      idempotency_records: 0,
      outbox_events: 0
    });
  });

  it("preserves unfenced candidate and close-session behavior", async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.submitCandidate({
        projectRef: PROJECT_REF,
        sessionId: SESSION_ID,
        content: "Contact operator@example.com before promotion.",
        evidence: [],
        idempotencyKey: "candidate-unfenced"
      })
    ).resolves.toMatchObject({ status: "rejected_sensitive", workflow_id: null });
    await expect(
      fixture.service.closeSession({
        sessionId: SESSION_ID,
        expectedSessionVersion: 1,
        triggerConsolidation: false,
        idempotencyKey: "close-unfenced"
      })
    ).resolves.toMatchObject({ status: "closed", workflow_id: null });

    expect(
      fixture.database
        .prepare("SELECT status, content FROM observations WHERE project_id = ?")
        .get(PROJECT_ID)
    ).toEqual({ status: "rejected_sensitive", content: null });
    expect(
      fixture.database.prepare("SELECT status FROM sessions WHERE session_id = ?").get(SESSION_ID)
    ).toEqual({ status: "closed" });
    expect(mutationCounts(fixture.database)).toMatchObject({
      observations: 1,
      idempotency_records: 2,
      outbox_events: 0
    });
  });

  it.each([
    [
      "a prompt transcript",
      "System: You are a coding agent.\nUser: Summarize all context.\nAssistant: Continuing."
    ],
    [
      "a raw log",
      "2026-07-28T08:00:00.000Z INFO request started\n2026-07-28T08:00:01.000Z ERROR request failed"
    ]
  ])("rejects a close summary containing %s without closing the session", async (_label, summary) => {
    const fixture = createFixture();
    const before = mutationCounts(fixture.database);

    await expect(
      fixture.service.closeSession({
        sessionId: SESSION_ID,
        expectedSessionVersion: 1,
        summary,
        triggerConsolidation: true,
        idempotencyKey: `close-sensitive-summary-${_label}`
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(mutationCounts(fixture.database)).toEqual(before);
    expect(
      fixture.database
        .prepare(
          `SELECT status, session_version, summary FROM sessions
           WHERE session_id = ?`
        )
        .get(SESSION_ID)
    ).toEqual({ status: "open", session_version: 1, summary: null });
    expect(fixture.coordinatorGet).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a complete prompt transcript",
      "System: You are a coding agent.\nUser: Inspect the repository.\nAssistant: I will inspect it."
    ],
    [
      "a raw log",
      "2026-07-28T08:00:00.000Z INFO request started\n2026-07-28T08:00:01.000Z WARN retry scheduled"
    ]
  ])("stores only a rejected-sensitive tombstone for %s", async (_label, content) => {
    const fixture = createFixture();

    await expect(
      fixture.service.submitCandidate({
        projectRef: PROJECT_REF,
        sessionId: SESSION_ID,
        content,
        evidence: [
          {
            source_type: "repository_file",
            locator: "src/example.ts"
          }
        ],
        idempotencyKey: `candidate-model-input-${_label}`
      })
    ).resolves.toMatchObject({
      status: "rejected_sensitive",
      workflow_id: null
    });

    const tombstone = fixture.database
      .prepare(
        `SELECT status, content, content_sha256, evidence_json
         FROM observations WHERE project_id = ?`
      )
      .get(PROJECT_ID);
    expect(tombstone).toEqual({
      status: "rejected_sensitive",
      content: null,
      content_sha256: null,
      evidence_json: "[]"
    });
    expect(JSON.stringify(tombstone)).not.toContain(content);
    const idempotency = fixture.database
      .prepare(
        `SELECT request_digest, response_json FROM idempotency_records
         WHERE project_id = ? AND operation = 'candidate_submit'`
      )
      .get(PROJECT_ID);
    expect(JSON.stringify(idempotency)).not.toContain(content);
    expect(mutationCounts(fixture.database)).toMatchObject({
      observations: 1,
      evidence: 0,
      observation_evidence: 0,
      outbox_events: 0
    });
  });

  it("returns one authoritative result for concurrent identical candidate submissions", async () => {
    const fixture = createFixture();
    fixture.memoryDb.enableIdempotencyPreflightBarrier(2);
    const input = {
      projectRef: PROJECT_REF,
      sessionId: SESSION_ID,
      content: "Use pnpm for dependency installation.",
      evidence: [
        {
          source_type: "repository_file",
          locator: "package.json",
          commit_sha: "0123456789abcdef0123456789abcdef01234567"
        }
      ],
      idempotencyKey: "candidate-concurrent-same"
    };
    const first = fixture.service.submitCandidate(input);
    await fixture.memoryDb.waitForIdempotencyPreflightArrivals(1);
    const second = fixture.service.submitCandidate(input);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toMatchObject({
      candidate_version: 1,
      status: "queued",
      workflow_id: firstResult.candidate_id
    });
    expect(mutationCounts(fixture.database)).toMatchObject({
      observations: 1,
      evidence: 1,
      observation_evidence: 1,
      idempotency_records: 1,
      outbox_events: 1
    });
  });

  it("returns an idempotency conflict for concurrent different candidate payloads", async () => {
    const fixture = createFixture();
    fixture.memoryDb.enableIdempotencyPreflightBarrier(2);
    const sharedInput = {
      projectRef: PROJECT_REF,
      sessionId: SESSION_ID,
      evidence: [
        {
          source_type: "repository_file",
          locator: "package.json",
          commit_sha: "0123456789abcdef0123456789abcdef01234567"
        }
      ],
      idempotencyKey: "candidate-concurrent-different"
    };
    const first = fixture.service.submitCandidate({
      ...sharedInput,
      content: "Use pnpm for dependency installation."
    });
    await fixture.memoryDb.waitForIdempotencyPreflightArrivals(1);
    const second = fixture.service.submitCandidate({
      ...sharedInput,
      content: "Use npm for dependency installation."
    });

    const settled = await Promise.allSettled([first, second]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "IDEMPOTENCY_CONFLICT" }
    });
    expect(mutationCounts(fixture.database)).toMatchObject({
      observations: 1,
      evidence: 1,
      observation_evidence: 1,
      idempotency_records: 1,
      outbox_events: 1
    });
  });

  it("replays the winner when an identical delayed candidate runs after close", async () => {
    const fixture = createFixture();
    fixture.memoryDb.enableIdempotencyPreflightBarrier(2);
    fixture.memoryDb.enableCandidateMutationBarrier(2);
    const input = {
      projectRef: PROJECT_REF,
      sessionId: SESSION_ID,
      content: "Use pnpm for dependency installation.",
      evidence: [
        {
          source_type: "repository_file",
          locator: "package.json",
          commit_sha: "0123456789abcdef0123456789abcdef01234567"
        }
      ],
      idempotencyKey: "candidate-delayed-same-after-close"
    };
    const first = fixture.service.submitCandidate(input);
    await fixture.memoryDb.waitForIdempotencyPreflightArrivals(1);
    const second = fixture.service.submitCandidate(input);
    await fixture.memoryDb.waitForCandidateMutationArrival();
    const winnerResult = await Promise.race([first, second]);

    try {
      await fixture.service.closeSession({
        sessionId: SESSION_ID,
        expectedSessionVersion: 1,
        triggerConsolidation: false,
        idempotencyKey: "close-before-delayed-same-candidate"
      });
    } finally {
      fixture.memoryDb.releaseCandidateMutationBarrier();
    }
    const afterClose = mutationCounts(fixture.database);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(winnerResult);
    expect(secondResult).toEqual(winnerResult);
    expect(mutationCounts(fixture.database)).toEqual(afterClose);
    expect(afterClose).toMatchObject({
      observations: 1,
      evidence: 1,
      observation_evidence: 1,
      idempotency_records: 2,
      outbox_events: 1
    });
  });

  it("conflicts a different delayed candidate that runs after close", async () => {
    const fixture = createFixture();
    fixture.memoryDb.enableIdempotencyPreflightBarrier(2);
    fixture.memoryDb.enableCandidateMutationBarrier(2);
    const sharedInput = {
      projectRef: PROJECT_REF,
      sessionId: SESSION_ID,
      evidence: [
        {
          source_type: "repository_file",
          locator: "package.json",
          commit_sha: "0123456789abcdef0123456789abcdef01234567"
        }
      ],
      idempotencyKey: "candidate-delayed-different-after-close"
    };
    const first = fixture.service.submitCandidate({
      ...sharedInput,
      content: "Use pnpm for dependency installation."
    });
    await fixture.memoryDb.waitForIdempotencyPreflightArrivals(1);
    const second = fixture.service.submitCandidate({
      ...sharedInput,
      content: "Use npm for dependency installation."
    });
    await fixture.memoryDb.waitForCandidateMutationArrival();
    const winnerResult = await Promise.race([first, second]);

    try {
      await fixture.service.closeSession({
        sessionId: SESSION_ID,
        expectedSessionVersion: 1,
        triggerConsolidation: false,
        idempotencyKey: "close-before-delayed-different-candidate"
      });
    } finally {
      fixture.memoryDb.releaseCandidateMutationBarrier();
    }
    const afterClose = mutationCounts(fixture.database);
    const settled = await Promise.allSettled([first, second]);

    expect(settled.filter((result) => result.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: winnerResult }
    ]);
    expect(settled.find((result) => result.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "IDEMPOTENCY_CONFLICT" }
    });
    expect(mutationCounts(fixture.database)).toEqual(afterClose);
    expect(afterClose).toMatchObject({
      observations: 1,
      evidence: 1,
      observation_evidence: 1,
      idempotency_records: 2,
      outbox_events: 1
    });
  });

  it("rejects a late candidate without side effects when close wins the batch race", async () => {
    const fixture = createFixture();
    fixture.memoryDb.enableCandidateMutationBarrier();
    const candidateInput = {
      projectRef: PROJECT_REF,
      sessionId: SESSION_ID,
      content: "Use pnpm for dependency installation.",
      evidence: [
        {
          source_type: "repository_file",
          locator: "package.json",
          commit_sha: "0123456789abcdef0123456789abcdef01234567"
        }
      ],
      idempotencyKey: "candidate-loses-to-close"
    };
    const candidate = fixture.service.submitCandidate(candidateInput);
    await fixture.memoryDb.waitForCandidateMutationArrival();

    let closeResult: Record<string, unknown>;
    try {
      closeResult = await fixture.service.closeSession({
        sessionId: SESSION_ID,
        expectedSessionVersion: 1,
        summary: "Close snapshot wins before the delayed candidate batch.",
        triggerConsolidation: true,
        idempotencyKey: "close-before-candidate-batch"
      });
    } finally {
      fixture.memoryDb.releaseCandidateMutationBarrier();
    }
    const afterClose = mutationCounts(fixture.database);

    await expect(candidate).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "The session is unavailable or closed."
    });

    expect(closeResult).toMatchObject({
      session_version: 2,
      status: "closed",
      workflow_id: expect.any(String)
    });
    expect(mutationCounts(fixture.database)).toEqual(afterClose);
    expect(afterClose).toMatchObject({
      observations: 0,
      evidence: 0,
      observation_evidence: 0,
      session_consolidations: 1,
      consolidation_inputs: 1,
      idempotency_records: 1,
      outbox_events: 1
    });
    expect(
      fixture.database
        .prepare(
          `SELECT input_kind, content FROM consolidation_inputs
           WHERE project_id = ? AND consolidation_id = ?`
        )
        .get(PROJECT_ID, closeResult.workflow_id as string)
    ).toEqual({
      input_kind: "summary",
      content: "Close snapshot wins before the delayed candidate batch."
    });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM idempotency_records
           WHERE project_id = ? AND principal_id = ? AND operation = 'candidate_submit'
             AND idempotency_key = ?`
        )
        .get(PROJECT_ID, PRINCIPAL_ID, candidateInput.idempotencyKey)
    ).toEqual({ count: 0 });
  });

  it("replays a successful candidate after its session closes", async () => {
    const fixture = createFixture();
    const input = {
      projectRef: PROJECT_REF,
      sessionId: SESSION_ID,
      content: "Use pnpm for dependency installation.",
      evidence: [
        {
          source_type: "repository_file",
          locator: "package.json",
          commit_sha: "0123456789abcdef0123456789abcdef01234567"
        }
      ],
      idempotencyKey: "candidate-replay-after-close"
    };
    const firstResult = await fixture.service.submitCandidate(input);
    await fixture.service.closeSession({
      sessionId: SESSION_ID,
      expectedSessionVersion: 1,
      triggerConsolidation: false,
      idempotencyKey: "close-before-candidate-replay"
    });
    const beforeReplay = mutationCounts(fixture.database);

    const replayResult = await fixture.service.submitCandidate(input);

    expect(replayResult).toEqual(firstResult);
    expect(mutationCounts(fixture.database)).toEqual(beforeReplay);
    expect(
      fixture.database
        .prepare("SELECT status, session_version FROM sessions WHERE session_id = ?")
        .get(SESSION_ID)
    ).toEqual({ status: "closed", session_version: 2 });
  });

  it.each([
    [
      "another principal's session",
      "other-session",
      1,
      (database: DatabaseSync) => seedOtherPrincipalSession(database),
      "VALIDATION_FAILED"
    ],
    ["a missing session", "missing-session", 1, () => {}, "VALIDATION_FAILED"],
    ["a stale session version", SESSION_ID, 2, () => {}, "VERSION_CONFLICT"]
  ])(
    "atomically rejects closing %s with consolidation enabled",
    async (_label, sessionId, expectedSessionVersion, arrange, expectedCode) => {
      const fixture = createFixture();
      arrange(fixture.database);
      const before = mutationCounts(fixture.database);

      await expect(
        fixture.service.closeSession({
          sessionId,
          expectedSessionVersion,
          summary: "This summary must roll back with the failed close.",
          triggerConsolidation: true,
          idempotencyKey: `close-${sessionId}-${expectedSessionVersion}`
        })
      ).rejects.toMatchObject({
        code: expectedCode
      });

      expect(mutationCounts(fixture.database)).toEqual(before);
      expect(
        fixture.database
          .prepare("SELECT status, session_version FROM sessions WHERE session_id = ?")
          .get(sessionId)
      ).toEqual(
        sessionId === "missing-session"
          ? undefined
          : { status: "open", session_version: 1 }
      );
    }
  );

  it("rejects a fresh-key close after a prior no-consolidation close", async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.closeSession({
        sessionId: SESSION_ID,
        expectedSessionVersion: 1,
        triggerConsolidation: false,
        idempotencyKey: "close-first-no-consolidation"
      })
    ).resolves.toMatchObject({
      session_version: 2,
      status: "closed",
      workflow_id: null
    });
    const afterFirstClose = mutationCounts(fixture.database);

    await expect(
      fixture.service.closeSession({
        sessionId: SESSION_ID,
        expectedSessionVersion: 1,
        summary: "This second close must not create consolidation work.",
        triggerConsolidation: true,
        idempotencyKey: "close-second-with-consolidation"
      })
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      message: "The session version is stale."
    });

    expect(mutationCounts(fixture.database)).toEqual(afterFirstClose);
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM idempotency_records
           WHERE project_id = ? AND principal_id = ? AND operation = 'session_close'
             AND idempotency_key = ?`
        )
        .get(PROJECT_ID, PRINCIPAL_ID, "close-second-with-consolidation")
    ).toEqual({ count: 0 });
    expect(
      fixture.database
        .prepare("SELECT status, session_version FROM sessions WHERE session_id = ?")
        .get(SESSION_ID)
    ).toEqual({ status: "closed", session_version: 2 });
  });

  it("returns one authoritative result for concurrent identical close requests", async () => {
    const fixture = createFixture();
    fixture.memoryDb.enableIdempotencyPreflightBarrier(2);
    const input = {
      sessionId: SESSION_ID,
      expectedSessionVersion: 1,
      summary: "Consolidate this session exactly once.",
      triggerConsolidation: true,
      idempotencyKey: "close-concurrent-same"
    } as const;
    const first = fixture.service.closeSession(input);
    await fixture.memoryDb.waitForIdempotencyPreflightArrivals(1);
    const second = fixture.service.closeSession(input);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    const replayResult = await fixture.service.closeSession(input);

    expect(firstResult).toEqual(secondResult);
    expect(replayResult).toEqual(firstResult);
    expect(firstResult.workflow_id).toEqual(expect.any(String));
    expect(mutationCounts(fixture.database)).toMatchObject({
      session_consolidations: 1,
      consolidation_inputs: 1,
      idempotency_records: 1,
      outbox_events: 1
    });
    const persisted = fixture.database.prepare(
      `SELECT response_json FROM idempotency_records
       WHERE project_id = ? AND principal_id = ? AND operation = 'session_close'
         AND idempotency_key = ?`
    ).get(PROJECT_ID, PRINCIPAL_ID, input.idempotencyKey) as { response_json: string };
    expect(JSON.parse(persisted.response_json)).toEqual({
      ...firstResult,
      _claim_event_id: firstResult.workflow_id
    });
  });

  it("returns one authoritative result for concurrent no-consolidation closes", async () => {
    const fixture = createFixture();
    fixture.memoryDb.enableIdempotencyPreflightBarrier(2);
    const input = {
      sessionId: SESSION_ID,
      expectedSessionVersion: 1,
      triggerConsolidation: false,
      idempotencyKey: "close-concurrent-no-consolidation"
    } as const;
    const first = fixture.service.closeSession(input);
    await fixture.memoryDb.waitForIdempotencyPreflightArrivals(1);
    const second = fixture.service.closeSession(input);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    const replayResult = await fixture.service.closeSession(input);

    expect(firstResult).toEqual(secondResult);
    expect(replayResult).toEqual(firstResult);
    expect(firstResult).toMatchObject({
      session_version: 2,
      status: "closed",
      workflow_id: null
    });
    expect(mutationCounts(fixture.database)).toMatchObject({
      session_consolidations: 0,
      consolidation_inputs: 0,
      idempotency_records: 1,
      outbox_events: 0
    });
    const persisted = fixture.database.prepare(
      `SELECT response_json FROM idempotency_records
       WHERE project_id = ? AND principal_id = ? AND operation = 'session_close'
         AND idempotency_key = ?`
    ).get(PROJECT_ID, PRINCIPAL_ID, input.idempotencyKey) as { response_json: string };
    expect(JSON.parse(persisted.response_json)).toMatchObject({
      ...firstResult,
      _claim_event_id: expect.any(String)
    });
  });

  it("returns an idempotency conflict for concurrent different close payloads", async () => {
    const fixture = createFixture();
    fixture.memoryDb.enableIdempotencyPreflightBarrier(2);
    const first = fixture.service.closeSession({
      sessionId: SESSION_ID,
      expectedSessionVersion: 1,
      summary: "First concurrent payload.",
      triggerConsolidation: true,
      idempotencyKey: "close-concurrent-different"
    });
    await fixture.memoryDb.waitForIdempotencyPreflightArrivals(1);
    const second = fixture.service.closeSession({
      sessionId: SESSION_ID,
      expectedSessionVersion: 1,
      summary: "Second concurrent payload.",
      triggerConsolidation: true,
      idempotencyKey: "close-concurrent-different"
    });

    const settled = await Promise.allSettled([first, second]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "IDEMPOTENCY_CONFLICT" }
    });
    expect(mutationCounts(fixture.database)).toMatchObject({
      session_consolidations: 1,
      consolidation_inputs: 1,
      idempotency_records: 1,
      outbox_events: 1
    });
  });
});

function createFixture() {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0001_initial.sql",
    "migrations/0002_allow_synthetic_cleanup.sql",
    "migrations/0003_validity_interval_guard.sql",
    "migrations/0004_synthetic_cleanup_registry_and_validity_preflight.sql",
    "migrations/0005_synthetic_cleanup_fence.sql",
    "migrations/0006_repository_scope_context.sql"
  ]) {
    database.exec(readFileSync(migration, "utf8"));
  }
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
    VALUES ('${PROJECT_ID}', '${PROJECT_REF}', '${PROJECT_REF}', 'Synthetic Project',
            0, '${NOW}', '${NOW}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES ('${PRINCIPAL_ID}', 'system.synthetic', '${PRINCIPAL_ID}',
            'synthetic-digest', '${NOW}');
    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES ('synthetic-grant', '${PROJECT_ID}', '${PRINCIPAL_ID}', 'maintainer',
            'project', '${PROJECT_ID}', '${NOW}');
    INSERT INTO sessions
      (session_id, project_id, principal_id, session_version, status, agent_meta_json,
       worktree_meta_json, opened_at)
    VALUES ('${SESSION_ID}', '${PROJECT_ID}', '${PRINCIPAL_ID}', 1, 'open', '{}', NULL, '${NOW}');
    INSERT INTO synthetic_cleanup_registry
      (project_id, principal_id, expires_at, created_at)
    VALUES ('${PROJECT_ID}', '${PRINCIPAL_ID}', '2026-07-28T12:00:00.000Z', '${NOW}');
  `);
  const memoryDb = new SqliteD1(database);
  const coordinatorGet = vi.fn(() => {
    throw new Error("The coordinator must not be reached after cleanup fencing.");
  });
  const service = new GatewayService(
    {
      MEMORY_DB: memoryDb as unknown as D1Database,
      PROJECT_COORDINATOR: {
        idFromName: vi.fn(() => ({ toString: () => PROJECT_ID })),
        get: coordinatorGet
      } as unknown as DurableObjectNamespace
    } as unknown as GatewayEnv,
    principal
  );
  return { coordinatorGet, database, memoryDb, service };
}

function fenceProject(database: DatabaseSync): void {
  database.prepare(
    `UPDATE synthetic_cleanup_registry
     SET cleanup_fenced_at = ?, cleanup_claim_id = ?, cleanup_claim_expires_at = ?
     WHERE project_id = ?`
  ).run(NOW, "cleanup-claim", "2026-07-27T12:30:00.000Z", PROJECT_ID);
}

function deleteProjectAuthority(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM sessions WHERE project_id = '${PROJECT_ID}';
    DELETE FROM project_grants WHERE project_id = '${PROJECT_ID}';
    DELETE FROM synthetic_cleanup_registry WHERE project_id = '${PROJECT_ID}';
    DELETE FROM projects WHERE project_id = '${PROJECT_ID}';
  `);
}

function seedOtherPrincipalSession(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES ('other-principal', 'test', 'other-principal', 'other-digest', '${NOW}');
    INSERT INTO sessions
      (session_id, project_id, principal_id, session_version, status, agent_meta_json,
       worktree_meta_json, opened_at)
    VALUES ('other-session', '${PROJECT_ID}', 'other-principal', 1, 'open', '{}', NULL, '${NOW}');
    INSERT INTO observations
      (observation_id, project_id, session_id, principal_id, candidate_version, status,
       content, content_sha256, evidence_json, created_at)
    VALUES ('other-observation', '${PROJECT_ID}', 'other-session', 'other-principal',
            1, 'queued', 'Other principal content.', 'other-sha', '[]', '${NOW}');
  `);
}

function mutationCounts(database: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    [
      "sessions",
      "observations",
      "evidence",
      "observation_evidence",
      "session_consolidations",
      "consolidation_inputs",
      "idempotency_records",
      "outbox_events"
    ].map((table) => [
        table,
        (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
          .count
      ])
  );
}

class SqliteStatement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly afterFirst: (sql: string) => Promise<void>
  ) {}

  bind(...bindings: unknown[]): SqliteStatement {
    this.bindings = bindings as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    const result = (this.statement().get(...this.bindings) as T | undefined) ?? null;
    await this.afterFirst(this.sql);
    return result;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement().all(...this.bindings) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return {
      meta: { changes: Number(this.statement().run(...this.bindings).changes) }
    };
  }

  contains(fragment: string): boolean {
    return this.sql.includes(fragment);
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

class SqliteD1 {
  batchCount = 0;
  prepareCount = 0;
  beforeBatch: ((batchNumber: number) => void) | undefined;
  private batchTail: Promise<void> = Promise.resolve();
  private candidateMutationBarrier:
    | {
      arrival: Promise<void>;
        arrivals: number;
        signalArrival: () => void;
        release: Promise<void>;
        signalRelease: () => void;
        target: number;
      }
    | undefined;
  private idempotencyPreflightArrivals = 0;
  private idempotencyPreflightBarrier:
    | { target: number; promise: Promise<void>; release: () => void }
    | undefined;
  private readonly arrivalWaiters: Array<{ target: number; release: () => void }> = [];

  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    this.prepareCount += 1;
    return new SqliteStatement(this.database, sql, (statementSql) =>
      this.afterFirst(statementSql)
    );
  }

  withSession(_constraint: "first-primary"): SqliteD1 {
    return this;
  }

  enableIdempotencyPreflightBarrier(target: number): void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.idempotencyPreflightArrivals = 0;
    this.idempotencyPreflightBarrier = { target, promise, release };
  }

  waitForIdempotencyPreflightArrivals(target: number): Promise<void> {
    if (this.idempotencyPreflightArrivals >= target) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.arrivalWaiters.push({ target, release: resolve });
    });
  }

  enableCandidateMutationBarrier(target = 1): void {
    let signalArrival = () => {};
    let signalRelease = () => {};
    const arrival = new Promise<void>((resolve) => {
      signalArrival = resolve;
    });
    const release = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    this.candidateMutationBarrier = {
      arrival,
      arrivals: 0,
      signalArrival,
      release,
      signalRelease,
      target
    };
  }

  waitForCandidateMutationArrival(): Promise<void> {
    if (this.candidateMutationBarrier === undefined) {
      throw new Error("The candidate mutation barrier is not enabled.");
    }
    return this.candidateMutationBarrier.arrival;
  }

  releaseCandidateMutationBarrier(): void {
    this.candidateMutationBarrier?.signalRelease();
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const candidateBarrier = this.candidateMutationBarrier;
    if (
      candidateBarrier !== undefined &&
      statements.some((statement) => statement.contains("INSERT INTO observations"))
    ) {
      candidateBarrier.arrivals += 1;
      if (candidateBarrier.arrivals === candidateBarrier.target) {
        candidateBarrier.signalArrival();
        await candidateBarrier.release;
        if (this.candidateMutationBarrier === candidateBarrier) {
          this.candidateMutationBarrier = undefined;
        }
      }
    }
    const previousBatch = this.batchTail;
    let releaseBatch = () => {};
    this.batchTail = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    await previousBatch;
    try {
      this.batchCount += 1;
      this.beforeBatch?.(this.batchCount);
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const results: Array<{ meta: { changes: number } }> = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        this.database.exec("COMMIT");
        return results;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      releaseBatch();
    }
  }

  private async afterFirst(sql: string): Promise<void> {
    const barrier = this.idempotencyPreflightBarrier;
    if (
      barrier === undefined ||
      !sql.includes("SELECT request_digest, response_json FROM idempotency_records")
    ) {
      return;
    }
    this.idempotencyPreflightArrivals += 1;
    for (const waiter of this.arrivalWaiters.splice(0)) {
      if (this.idempotencyPreflightArrivals >= waiter.target) {
        waiter.release();
      } else {
        this.arrivalWaiters.push(waiter);
      }
    }
    if (this.idempotencyPreflightArrivals >= barrier.target) {
      this.idempotencyPreflightBarrier = undefined;
      barrier.release();
    }
    await barrier.promise;
  }
}
