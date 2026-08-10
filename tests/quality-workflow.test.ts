import { describe, expect, it } from "vitest";
import {
  consolidateSession,
  processCandidateSubmission
} from "../src/workflows/quality";

const PROJECT_ID = "project-1";
const REPOSITORY_ID = "repository-1";
const CONSOLIDATION_ID = "consolidation-1";
const SESSION_ID = "session-1";
const LEASE_OWNER = "workflow-instance-1";

type ModelAttempt =
  | { kind: "default" }
  | { kind: "throw" }
  | { kind: "raw"; response: unknown }
  | { kind: "analysis"; response: unknown };

describe("quality workflow consolidation", () => {
  it("preserves the first committed output when retry analysis changes", async () => {
    const fixture = createConsolidationFixture({
      failFinishOnce: true,
      suggestionContents: [
        "D1 remains the authoritative memory store.",
        "A retry returned different model content."
      ]
    });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.state.status).toBe("failed");
    expect(fixture.state.outputs).toHaveLength(1);
    expect(fixture.state.observations).toHaveLength(1);
    const persistedCandidateId = fixture.state.outputs[0]?.candidateId;

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).resolves.toBeUndefined();

    expect(fixture.state.status).toBe("complete");
    expect(fixture.state.outputs).toEqual([
      { outputOrder: 0, candidateId: persistedCandidateId }
    ]);
    expect(fixture.state.observations).toEqual([
      expect.objectContaining({
        observationId: persistedCandidateId,
        content: "D1 remains the authoritative memory store."
      })
    ]);
    expect(fixture.state.reviewRequests).toEqual([persistedCandidateId]);
    expect(fixture.state.persistAttempts).toBe(1);
    expect(fixture.state.duplicateExclusions).toEqual([persistedCandidateId]);
    expect(fixture.aiInputs).toHaveLength(1);
    expect(fixture.aiModels).toEqual(["@cf/zai-org/glm-5.2"]);
    expect(fixture.aiInputs.every((input) => isCanonicalJsonPrompt(input))).toBe(true);
    for (const input of fixture.aiInputs) {
      expectModelRequestContract(input, "consolidation_suggestions");
      expect(modelPrompt(input)).not.toContain(PROJECT_ID);
      expect(modelPrompt(input)).not.toContain(REPOSITORY_ID);
    }
    expect(
      fixture.aiInputs.some((input) => modelPrompt(input).includes("/no_think"))
    ).toBe(false);
  });

  it("does not let the same owner reclaim an unexpired lease", async () => {
    const fixture = createConsolidationFixture({
      blockFirstAiCall: true,
      suggestionContents: ["The first active owner keeps the lease."]
    });

    const first = consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );
    await fixture.waitForFirstAiCall();
    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });
    expect(fixture.state).toMatchObject({
      status: "running",
      leaseOwner: LEASE_OWNER,
      leaseEpoch: 1,
      outputs: []
    });

    fixture.releaseFirstAiCall();
    await first;

    expect(fixture.state.status).toBe("complete");
    expect(fixture.state.leaseEpoch).toBe(1);
    expect(fixture.state.outputs).toHaveLength(1);
    expect(fixture.state.observations).toHaveLength(1);
  });

  it("does not let a concurrent owner finish a slow valid owner's consolidation as noop", async () => {
    const fixture = createConsolidationFixture({
      blockFirstAiCall: true,
      suggestionContents: [
        "The valid owner keeps its exclusive consolidation lease."
      ]
    });

    const validOwner = consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      "workflow-instance-valid"
    );
    await fixture.waitForFirstAiCall();

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        "workflow-instance-noop"
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });
    expect(fixture.state).toMatchObject({
      status: "running",
      leaseOwner: "workflow-instance-valid",
      outputs: []
    });

    fixture.releaseFirstAiCall();
    await validOwner;

    expect(fixture.state.status).toBe("complete");
    expect(fixture.state.leaseOwner).toBeNull();
    expect(fixture.state.outputs).toHaveLength(1);
    expect(fixture.aiCalls).toBe(1);
  });

  it.each([
    {
      label: "a failed run",
      status: "failed" as const,
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseOperationId: "stale-failed-operation"
    },
    {
      label: "an expired lease",
      status: "running" as const,
      leaseOwner: "workflow-instance-abandoned",
      leaseExpiresAt: "1970-01-01T00:00:00.000Z",
      leaseOperationId: "stale-expired-operation"
    }
  ])("allows a new workflow owner to take over $label", async ({
    status,
    leaseOwner,
    leaseExpiresAt,
    leaseOperationId
  }) => {
    const fixture = createConsolidationFixture();
    fixture.state.status = status;
    fixture.state.leaseOwner = leaseOwner;
    fixture.state.leaseExpiresAt = leaseExpiresAt;
    fixture.state.leaseOperationId = leaseOperationId;

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      "workflow-instance-recovery"
    );

    expect(fixture.state).toMatchObject({
      status: "complete",
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseOperationId: null
    });
    expect(fixture.state.outputs).toHaveLength(1);
  });

  it("fences every late side effect after an expired-lease takeover", async () => {
    const fixture = createConsolidationFixture({
      blockFirstAiCall: true,
      modelAttempts: [
        { kind: "default" },
        { kind: "analysis", response: { suggestions: [] } }
      ]
    });

    const staleOwner = consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      "workflow-instance-stale"
    );
    await fixture.waitForFirstAiCall();
    fixture.state.leaseExpiresAt = "1970-01-01T00:00:00.000Z";

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      "workflow-instance-takeover"
    );
    expect(fixture.state).toMatchObject({
      status: "noop",
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseEpoch: 2,
      observations: [],
      outputs: [],
      reviewRequests: []
    });

    fixture.releaseFirstAiCall();
    await expect(staleOwner).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.state).toMatchObject({
      status: "noop",
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseEpoch: 2,
      observations: [],
      outputs: [],
      evidence: [],
      evidenceLinks: [],
      reviewRequests: []
    });
  });

  it("fences a stale invocation after the same owner reacquires at a new epoch", async () => {
    const fixture = createConsolidationFixture({
      blockFirstAiCall: true,
      modelAttempts: [
        { kind: "default" },
        { kind: "analysis", response: { suggestions: [] } }
      ]
    });

    const staleInvocation = consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );
    await fixture.waitForFirstAiCall();
    fixture.state.leaseExpiresAt = "1970-01-01T00:00:00.000Z";

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );
    expect(fixture.state).toMatchObject({
      status: "noop",
      leaseOwner: null,
      leaseOperationId: null,
      leaseEpoch: 2,
      outputs: []
    });

    fixture.releaseFirstAiCall();
    await expect(staleInvocation).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.state).toMatchObject({
      status: "noop",
      leaseOwner: null,
      leaseOperationId: null,
      leaseEpoch: 2,
      observations: [],
      outputs: [],
      evidence: [],
      evidenceLinks: [],
      reviewRequests: []
    });
  });

  it("commits no side effects when the operation witness cannot be acquired", async () => {
    const fixture = createConsolidationFixture({
      expireLeaseBeforeFirstPersist: true
    });

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.state).toMatchObject({
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseOperationId: null,
      observations: [],
      outputs: [],
      evidence: [],
      evidenceLinks: [],
      reviewRequests: []
    });
    expect(fixture.state.persistAttempts).toBe(1);
    expect(fixture.state.operationIds).toEqual([]);
  });

  it("fails closed instead of incrementing an exhausted lease epoch", async () => {
    const fixture = createConsolidationFixture();
    fixture.state.leaseEpoch = Number.MAX_SAFE_INTEGER;

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.state.status).toBe("queued");
    expect(fixture.state.leaseEpoch).toBe(Number.MAX_SAFE_INTEGER);
    expect(fixture.aiCalls).toBe(0);
  });

  it("allows the final safe fencing epoch exactly once", async () => {
    const fixture = createConsolidationFixture();
    fixture.state.leaseEpoch = Number.MAX_SAFE_INTEGER - 1;

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expect(fixture.state.status).toBe("complete");
    expect(fixture.state.leaseEpoch).toBe(Number.MAX_SAFE_INTEGER);
    expect(fixture.state.leaseOperationId).toBeNull();
  });

  it("uses a fresh unpredictable witness for every persisted batch", async () => {
    const fixture = createConsolidationFixture({
      inputs: Array.from({ length: 51 }, (_, inputOrder) => ({
        input_order: inputOrder,
        input_kind: "candidate",
        source_id: `source-${String(inputOrder).padStart(2, "0")}`,
        content: `Trusted durable source ${inputOrder}.`,
        content_sha256: `source-sha-${inputOrder}`
      })),
      suggestionContents: ["First batch winner.", "Second batch winner."]
    });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expect(fixture.state.operationIds).toHaveLength(2);
    expect(new Set(fixture.state.operationIds).size).toBe(2);
    expect(fixture.state.operationIds.every(isConsolidationOperationId)).toBe(true);
    expect(fixture.state.leaseOperationId).toBeNull();
  });

  it("finishes with an exact receipt set committed by mixed historical claims", async () => {
    const fixture = createConsolidationFixture({
      inputs: Array.from({ length: 51 }, (_, inputOrder) => ({
        input_order: inputOrder,
        input_kind: "candidate",
        source_id: `source-${String(inputOrder).padStart(2, "0")}`,
        content: `Trusted durable source ${inputOrder}.`,
        content_sha256: `source-sha-${inputOrder}`
      })),
      suggestionContents: [
        "The first claim commits batch zero.",
        "The first claim loses batch one.",
        "The repair claim commits batch one."
      ],
      expireLeaseBeforePersistAttempt: 2
    });

    await expect(
      consolidateSession(
        fixture.env,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE_OWNER
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.state.receipts).toHaveLength(1);
    expect(fixture.state.receipts[0]).toMatchObject({ batchIndex: 0, leaseEpoch: 1 });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expect(fixture.state.status).toBe("complete");
    expect(fixture.state.leaseEpoch).toBe(2);
    expect(fixture.state.receipts.map((receipt) => receipt.batchIndex)).toEqual([0, 1]);
    expect(fixture.state.receipts.map((receipt) => receipt.leaseEpoch)).toEqual([1, 2]);
    expect(new Set(fixture.state.receipts.map((receipt) => receipt.leaseClaimId)).size).toBe(2);
    expect(fixture.state.outputs.map((output) => output.outputOrder)).toEqual([0, 10]);
    expect(fixture.aiCalls).toBe(3);
  });

  it("derives the candidate identity from the immutable output slot", async () => {
    const first = createConsolidationFixture({
      suggestionContents: ["The first model result."]
    });
    const second = createConsolidationFixture({
      suggestionContents: ["A different model result for the same slot."]
    });

    await consolidateSession(first.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);
    await consolidateSession(second.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(first.state.outputs[0]?.candidateId).toBe(second.state.outputs[0]?.candidateId);
    expect(first.state.observations[0]?.content).not.toBe(
      second.state.observations[0]?.content
    );
  });

  it("finishes as noop when the only matching content belongs to another candidate", async () => {
    const fixture = createConsolidationFixture({
      existingDuplicate: {
        observationId: "existing-candidate",
        contentSha256:
          "838d54e794447323673a423327cee51d3cacc902d28597a41a05c2d9a924d93a"
      }
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.state.status).toBe("noop");
    expect(fixture.state.outputs).toEqual([]);
    expect(fixture.state.persistAttempts).toBe(1);
    expect(fixture.state.receipts).toHaveLength(1);
  });

  it("finishes an empty frozen consolidation as noop without calling AI", async () => {
    const fixture = createConsolidationFixture({ inputs: [] });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.state.status).toBe("noop");
    expect(fixture.aiCalls).toBe(0);
  });

  it("does not call the model when consolidation has no trusted scope option", async () => {
    const fixture = createConsolidationFixture({
      inputs: [
        {
          input_order: 0,
          input_kind: "summary",
          source_id: "session-summary",
          content: "D1 is authoritative.",
          content_sha256: "source-sha"
        }
      ],
      sessionRepositoryId: null
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(0);
    expect(fixture.aiInputs).toEqual([]);
    expect(fixture.state.status).toBe("noop");
  });

  it("does not model a candidate backed only by session repository fallback", async () => {
    const fixture = createConsolidationFixture({
      clearEvidenceUnavailableSourceIds: ["source-candidate"]
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(0);
    expect(fixture.aiInputs).toEqual([]);
    expect(fixture.state.status).toBe("noop");
  });

  it("accepts the third consolidation analysis after two model failures", async () => {
    const fixture = createConsolidationFixture({
      modelAttempts: [
        { kind: "throw" },
        {
          kind: "raw",
          response: modelFunctionArgumentsResponse(
            "consolidation_suggestions",
            "not-json"
          )
        }
      ]
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(3);
    expect(fixture.aiModels).toEqual([
      "@cf/zai-org/glm-5.2",
      "@cf/zai-org/glm-5.2",
      "@cf/zai-org/glm-5.2"
    ]);
    expect(fixture.state.status).toBe("complete");
    expect(fixture.state.outputs).toHaveLength(1);
  });

  it("fails the workflow after three invalid model analyses", async () => {
    const fixture = createConsolidationFixture({
      modelAttempts: [
        {
          kind: "raw",
          response: modelFunctionResponse("wrong_function", { suggestions: [] })
        },
        {
          kind: "raw",
          response: modelFunctionArgumentsResponse(
            "consolidation_suggestions",
            "not-json"
          )
        },
        {
          kind: "raw",
          response: modelFunctionResponse("consolidation_suggestions", {
            suggestions: [{ content: "Missing required fields." }]
          })
        }
      ]
    });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.aiCalls).toBe(3);
    expect(fixture.state.status).toBe("failed");
    expect(fixture.state.outputs).toEqual([]);
    expect(fixture.state.observations).toEqual([]);
  });

  it("accepts an explicit empty suggestion list as a permanent noop", async () => {
    const fixture = createConsolidationFixture({
      modelAttempts: [{ kind: "analysis", response: { suggestions: [] } }]
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(1);
    expect(fixture.state.status).toBe("noop");
    expect(fixture.state.outputs).toEqual([]);
  });

  it("fails closed when the frozen session principal is unavailable", async () => {
    const fixture = createConsolidationFixture({ principalAvailable: false });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });
    expect(fixture.state.status).toBe("failed");
  });

  it("drops a consolidation validity timestamp absent from cited input", async () => {
    const fixture = createConsolidationFixture({
      suggestionValidFrom: "2023-10-01T00:00:00Z"
    });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.aiCalls).toBe(3);
    expect(fixture.state.status).toBe("failed");
    expect(fixture.state.outputs).toEqual([]);
  });

  it("accepts GLM forced-function string nulls for consolidation validity", async () => {
    const fixture = createConsolidationFixture({
      suggestionValidFrom: "null",
      suggestionValidUntil: "null"
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(1);
    expect(fixture.state.status).toBe("complete");
    expect(fixture.state.outputs).toHaveLength(1);
    expect(JSON.parse(fixture.state.observations[0]?.analysisJson ?? "null")).toMatchObject({
      valid_from: null,
      valid_until: null
    });
  });

  it("offers the union timestamp whitelist but still requires cited temporal evidence", async () => {
    const firstTimestamp = "2026-07-28T10:00:00Z";
    const secondTimestamp = "2026-07-29T11:30:00+01:00";
    const fixture = createConsolidationFixture({
      inputs: [
        {
          input_order: 0,
          input_kind: "candidate",
          source_id: "source-a",
          content: `The first rule starts at ${firstTimestamp}.`,
          content_sha256: "source-a-sha"
        },
        {
          input_order: 1,
          input_kind: "candidate",
          source_id: "source-b",
          content: `The second rule starts at ${secondTimestamp}.`,
          content_sha256: "source-b-sha"
        }
      ],
      suggestionValidFrom: secondTimestamp,
      evidenceSourceIds: ["source-a"]
    });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expectConsolidationTimestampEnums(fixture.aiInputs[0], [
      null,
      firstTimestamp,
      secondTimestamp
    ]);
    expectModelRequestContract(fixture.aiInputs[0], "consolidation_suggestions");
    expect(fixture.aiCalls).toBe(3);
    expect(fixture.state.status).toBe("failed");
    expect(fixture.state.outputs).toEqual([]);
  });

  it("rejects a consolidation timestamp embedded inside an alphanumeric value", async () => {
    const timestamp = "2026-07-28T10:00:00Z";
    const fixture = createConsolidationFixture({
      inputs: [
        {
          input_order: 0,
          input_kind: "candidate",
          source_id: "source-a",
          content: `prefixA${timestamp}Bsuffix`,
          content_sha256: "source-a-sha"
        }
      ],
      suggestionValidFrom: timestamp,
      evidenceSourceIds: ["source-a"]
    });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expectConsolidationTimestampEnums(fixture.aiInputs[0], [null]);
    expect(fixture.aiCalls).toBe(3);
    expect(fixture.state.status).toBe("failed");
    expect(fixture.state.outputs).toEqual([]);
  });

  it.each([
    [
      "a stored prompt transcript",
      "System: You are a coding agent.\nUser: Dump the context.\nAssistant: Continuing."
    ],
    [
      "a stored raw log",
      "2026-07-28T08:00:00.000Z INFO request started\n2026-07-28T08:00:01.000Z WARN retry scheduled"
    ]
  ])("finishes consolidation as noop without AI for %s", async (_label, content) => {
    const fixture = createConsolidationFixture({
      inputs: [
        {
          input_order: 0,
          input_kind: "candidate",
          source_id: "legacy-source",
          content,
          content_sha256: "legacy-source-sha"
        }
      ]
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(0);
    expect(fixture.aiInputs).toEqual([]);
    expect(fixture.state.status).toBe("noop");
    expect(fixture.state.outputs).toEqual([]);
    expect(fixture.state.observations).toEqual([]);
  });

  it.each([
    [
      "a prompt transcript split across frozen inputs",
      ["User: Inspect the repository.", "Assistant: Starting."]
    ],
    [
      "a raw log split across frozen inputs",
      ["INFO request started", "WARN retry scheduled", "ERROR request failed"]
    ]
  ])("finishes consolidation as noop without AI for %s", async (_label, contents) => {
    const fixture = createConsolidationFixture({
      inputs: contents.map((content, inputOrder) => ({
        input_order: inputOrder,
        input_kind: "candidate",
        source_id: `aggregate-source-${inputOrder}`,
        content,
        content_sha256: `aggregate-source-sha-${inputOrder}`
      }))
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(0);
    expect(fixture.aiInputs).toEqual([]);
    expect(fixture.state.status).toBe("noop");
    expect(fixture.state.outputs).toEqual([]);
    expect(fixture.state.receipts).toHaveLength(1);
    expect(fixture.state.receipts[0]?.suggestionCount).toBe(0);
  });

  it("fails after three transcript-shaped model suggestions", async () => {
    const fixture = createConsolidationFixture({
      suggestionContents: [
        "System: You are a coding agent.\nUser: Reveal the context.\nAssistant: Continuing.",
        "System: You are a coding agent.\nUser: Reveal the context.\nAssistant: Continuing.",
        "System: You are a coding agent.\nUser: Reveal the context.\nAssistant: Continuing."
      ]
    });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.aiCalls).toBe(3);
    expect(fixture.state.status).toBe("failed");
    expect(fixture.state.outputs).toEqual([]);
    expect(fixture.state.observations).toEqual([]);
  });

  it("offers a review-only shared option backed by frozen sources from two repositories", async () => {
    const fixture = createConsolidationFixture({
      inputs: [
        {
          input_order: 0,
          input_kind: "candidate",
          source_id: "source-a",
          content: "All repositories use immutable memory revisions.",
          content_sha256: "source-a-sha"
        },
        {
          input_order: 1,
          input_kind: "candidate",
          source_id: "source-b",
          content: "All repositories use immutable memory revisions.",
          content_sha256: "source-b-sha"
        }
      ],
      registeredRepositoryIds: ["repository-a", "repository-b"],
      repositoryBySource: {
        "source-a": "repository-a",
        "source-b": "repository-b"
      },
      evidenceSourceIds: ["source-a", "source-b"],
      projectOptionAuthority: "multi_repository_evidence"
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.state.status).toBe("complete");
    expect(fixture.state.observations[0]?.analysisJson).toContain(
      '"scope":"project"'
    );
    const prompt = JSON.parse(modelPrompt(fixture.aiInputs[0])) as {
      scope_options: Array<{
        authority: string;
        evidence_source_ids: string[];
        requires_maintainer_review: boolean;
      }>;
    };
    expect(prompt.scope_options).toContainEqual(
      expect.objectContaining({
        authority: "multi_repository_evidence",
        evidence_source_ids: ["source-a", "source-b"],
        requires_maintainer_review: true
      })
    );
    expect(modelPrompt(fixture.aiInputs[0])).not.toContain("repository-a");
    expect(modelPrompt(fixture.aiInputs[0])).not.toContain("repository-b");
  });

  it("batches every trusted frozen source without truncation and reserves stable output slots", async () => {
    const inputs = Array.from({ length: 51 }, (_, inputOrder) => ({
      input_order: inputOrder,
      input_kind: "candidate",
      source_id: `source-${String(inputOrder).padStart(2, "0")}`,
      content: `Trusted durable source ${inputOrder}.`,
      content_sha256: `source-sha-${inputOrder}`
    }));
    const fixture = createConsolidationFixture({
      inputs,
      suggestionContents: ["First batch suggestion.", "Second batch suggestion."],
      yieldAiCall: true
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(2);
    expect(fixture.maximumConcurrentAiCalls).toBe(1);
    expect(
      fixture.aiInputs.map((input) =>
        (JSON.parse(modelPrompt(input)) as { inputs: unknown[] }).inputs.length
      )
    ).toEqual([50, 1]);
    expect(
      fixture.aiInputs.map((input) =>
        (JSON.parse(modelPrompt(input)) as { inputs: Array<{ source_id: string }> })
          .inputs[0]?.source_id
      )
    ).toEqual(["source-00", "source-50"]);
    expect(fixture.aiInputs[0]).toHaveProperty(
      [
        "tools",
        0,
        "function",
        "parameters",
        "properties",
        "suggestions",
        "items",
        "properties",
        "evidence_source_ids",
        "items",
        "enum"
      ],
      inputs.slice(0, 50).map((input) => input.source_id)
    );
    expect(fixture.aiInputs[1]).toHaveProperty(
      [
        "tools",
        0,
        "function",
        "parameters",
        "properties",
        "suggestions",
        "items",
        "properties",
        "evidence_source_ids",
        "items",
        "enum"
      ],
      ["source-50"]
    );
    expect(fixture.state.outputs.map((output) => output.outputOrder)).toEqual([0, 10]);
  });

  it("does not rewrite occupied batch slots when a consolidation workflow retries", async () => {
    const inputs = Array.from({ length: 51 }, (_, inputOrder) => ({
      input_order: inputOrder,
      input_kind: "candidate",
      source_id: `source-${String(inputOrder).padStart(2, "0")}`,
      content: `Trusted durable source ${inputOrder}.`,
      content_sha256: `source-sha-${inputOrder}`
    }));
    const fixture = createConsolidationFixture({
      failFinishOnce: true,
      inputs,
      suggestionContents: [
        "First batch winner.",
        "Second batch winner.",
        "First batch retry replacement.",
        "Second batch retry replacement."
      ]
    });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });
    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.state.outputs.map((output) => output.outputOrder)).toEqual([0, 10]);
    expect(fixture.state.observations.map((observation) => observation.content)).toEqual([
      "First batch winner.",
      "Second batch winner."
    ]);
    expect(fixture.state.persistAttempts).toBe(2);
    expect(fixture.aiCalls).toBe(2);
  });

  it("keeps zero-output batch receipts immutable across retries", async () => {
    const temporarilyUntrusted = ["source-zero"];
    const fixture = createConsolidationFixture({
      failFinishOnce: true,
      inputs: [
        {
          input_order: 0,
          input_kind: "candidate",
          source_id: "source-zero",
          content: "The first immutable bucket source.",
          content_sha256: "source-zero-sha"
        },
        {
          input_order: 50,
          input_kind: "candidate",
          source_id: "source-fifty",
          content: "The second immutable bucket source.",
          content_sha256: "source-fifty-sha"
        }
      ],
      untrustedSourceIds: temporarilyUntrusted,
      suggestionContents: [
        "The second bucket committed first.",
        "The first bucket became eligible on retry.",
        "The occupied second bucket retry result."
      ]
    });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });
    expect(fixture.state.outputs.map((output) => output.outputOrder)).toEqual([10]);

    temporarilyUntrusted.splice(0);
    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.state.outputs.map((output) => output.outputOrder)).toEqual([10]);
    expect(fixture.state.observations.map((observation) => observation.content)).toEqual([
      "The second bucket committed first."
    ]);
    expect(fixture.state.persistAttempts).toBe(2);
    expect(fixture.aiCalls).toBe(1);
  });

  it("keeps untrusted frozen sources outside prompts and batch quotas", async () => {
    const inputs = Array.from({ length: 51 }, (_, inputOrder) => ({
      input_order: inputOrder,
      input_kind: "candidate",
      source_id: `source-${String(inputOrder).padStart(2, "0")}`,
      content: `Frozen source ${inputOrder}.`,
      content_sha256: `source-sha-${inputOrder}`
    }));
    const fixture = createConsolidationFixture({
      inputs,
      untrustedSourceIds: ["source-00"],
      suggestionContents: ["First immutable bucket.", "Second immutable bucket."]
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(2);
    const prompts = fixture.aiInputs.map((input) => JSON.parse(modelPrompt(input))) as Array<{
      inputs: Array<{ source_id: string }>;
      scope_options: Array<{ evidence_source_ids: string[] }>;
    }>;
    expect(prompts.map((prompt) => prompt.inputs.length)).toEqual([49, 1]);
    expect(prompts.map((prompt) => prompt.inputs[0]?.source_id)).toEqual([
      "source-01",
      "source-50"
    ]);
    expect(
      prompts.some((prompt) =>
        prompt.inputs.some((input) => input.source_id === "source-00")
      )
    ).toBe(false);
    expect(
      prompts.some((prompt) =>
        prompt.scope_options.some((option) =>
          option.evidence_source_ids.includes("source-00")
        )
      )
    ).toBe(false);
    expect(fixture.state.outputs.map((output) => output.outputOrder)).toEqual([0, 10]);
  });

  it("rejects a cross-batch citation within its batch before continuing serially", async () => {
    const inputs = Array.from({ length: 51 }, (_, inputOrder) => ({
      input_order: inputOrder,
      input_kind: "candidate",
      source_id: `source-${String(inputOrder).padStart(2, "0")}`,
      content: `Trusted durable source ${inputOrder}.`,
      content_sha256: `source-sha-${inputOrder}`
    }));
    const fixture = createConsolidationFixture({
      inputs,
      crossBatchCitationOnce: true,
      suggestionContents: [
        "Rejected cross-batch suggestion.",
        "First batch accepted suggestion.",
        "Second batch accepted suggestion."
      ]
    });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.aiCalls).toBe(3);
    expect(
      fixture.aiInputs.map((input) =>
        (JSON.parse(modelPrompt(input)) as { inputs: Array<{ source_id: string }> })
          .inputs.map((item) => item.source_id)
      )
    ).toEqual([
      inputs.slice(0, 50).map((input) => input.source_id),
      inputs.slice(0, 50).map((input) => input.source_id),
      ["source-50"]
    ]);
    expect(fixture.state.outputs.map((output) => output.outputOrder)).toEqual([0, 10]);
  });

  it("keeps the original proposal index when an earlier suggestion is rejected", async () => {
    const fixture = createConsolidationFixture({ prependInvalidSuggestion: true });

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER);

    expect(fixture.state.outputs.map((output) => output.outputOrder)).toEqual([1]);
  });

  it("treats a terminal consolidation as an idempotent no-op", async () => {
    const fixture = createConsolidationFixture({
      modelAttempts: [{ kind: "analysis", response: { suggestions: [] } }]
    });

    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );
    await consolidateSession(
      fixture.env,
      PROJECT_ID,
      CONSOLIDATION_ID,
      SESSION_ID,
      LEASE_OWNER
    );

    expect(fixture.state.status).toBe("noop");
    expect(fixture.state.leaseEpoch).toBe(1);
    expect(fixture.aiCalls).toBe(1);
    expect(fixture.state.outputs).toEqual([]);
  });

  it("enforces the aggregate model-input byte gate before batching", async () => {
    const inputs = Array.from({ length: 51 }, (_, inputOrder) => ({
      input_order: inputOrder,
      input_kind: "candidate",
      source_id: `source-${String(inputOrder).padStart(2, "0")}`,
      content: `Durable source ${inputOrder}: ${"x".repeat(320)}`,
      content_sha256: `source-sha-${inputOrder}`
    }));
    const fixture = createConsolidationFixture({ inputs });

    await expect(
      consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID, LEASE_OWNER)
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.aiCalls).toBe(0);
    expect(fixture.state.outputs).toEqual([]);
  });
});

describe("quality workflow candidate analysis", () => {
  it("persists a complete durable proposal and opens review", async () => {
    const fixture = createCandidateFixture({
      response: {
        persistent_value: true,
        kind: "decision",
        memory_class: "semantic",
        scope: "project",
        confidence: 0.99
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBeNull();

    expect(fixture.batch).toHaveLength(2);
    expect(fixture.batch[0]?.bindings.slice(0, 5)).toEqual([
      "pending_review",
      "decision",
      "semantic",
      "project",
      PROJECT_ID
    ]);
    expect(fixture.batch[1]?.sql).toContain("INSERT INTO review_requests");
    expect(JSON.parse(String(fixture.batch[0]?.bindings[7]))).toMatchObject({
      evidence_source_ids: ["evidence-1"],
      requires_maintainer_review: true,
      scope_option_authority: "advisory_generalization"
    });
    expect(fixture.aiInputs).toHaveLength(1);
    expect(fixture.aiModels).toEqual(["@cf/zai-org/glm-5.2"]);
    expect(isCanonicalJsonPrompt(fixture.aiInputs[0])).toBe(true);
    expectModelRequestContract(fixture.aiInputs[0], "candidate_analysis");
    expect(modelPrompt(fixture.aiInputs[0])).not.toContain("/no_think");
    expect(modelPrompt(fixture.aiInputs[0])).not.toContain(PROJECT_ID);
    expect(modelPrompt(fixture.aiInputs[0])).not.toContain(REPOSITORY_ID);
  });

  it("maps a repository option locally without exposing its identifier to the model", async () => {
    const fixture = createCandidateFixture({
      response: {
        persistent_value: true,
        kind: "fact",
        memory_class: "semantic",
        scope: "repository",
        confidence: 0.98
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBeNull();

    expect(fixture.batch[0]?.bindings.slice(0, 5)).toEqual([
      "pending_review",
      "fact",
      "semantic",
      "repository",
      REPOSITORY_ID
    ]);
    expect(modelPrompt(fixture.aiInputs[0])).not.toContain(REPOSITORY_ID);
  });

  it("accepts the third candidate analysis after forged scope and evidence", async () => {
    const fixture = createCandidateFixture({
      response: {
        persistent_value: true,
        kind: "fact",
        memory_class: "semantic",
        scope: "repository",
        confidence: 0.98
      },
      modelAttempts: [
        {
          kind: "analysis",
          response: {
            persistent_value: true,
            kind: "fact",
            memory_class: "semantic",
            scope_option_id: "scope-option-invented",
            evidence_source_ids: ["evidence-1"],
            valid_from: null,
            valid_until: null,
            confidence: 0.98
          }
        },
        {
          kind: "analysis",
          response: {
            persistent_value: true,
            kind: "fact",
            memory_class: "semantic",
            scope: "repository",
            evidence_source_ids: ["evidence-invented"],
            valid_from: null,
            valid_until: null,
            confidence: 0.98
          }
        }
      ]
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBeNull();

    expect(fixture.aiInputs).toHaveLength(3);
    expect(fixture.aiModels).toEqual([
      "@cf/zai-org/glm-5.2",
      "@cf/zai-org/glm-5.2",
      "@cf/zai-org/glm-5.2"
    ]);
    expect(fixture.batch[0]?.bindings.slice(0, 5)).toEqual([
      "pending_review",
      "fact",
      "semantic",
      "repository",
      REPOSITORY_ID
    ]);
  });

  it("retries a candidate timestamp that is absent from its evidence", async () => {
    const fixture = createCandidateFixture({
      response: { persistent_value: false, confidence: 0.8 },
      modelAttempts: [
        {
          kind: "analysis",
          response: {
            persistent_value: true,
            kind: "decision",
            memory_class: "semantic",
            scope: "repository",
            valid_from: "2023-10-01T00:00:00Z",
            valid_until: null,
            confidence: 0.99
          }
        }
      ]
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBeNull();

    expect(fixture.aiInputs).toHaveLength(2);
    expect(fixture.batch[0]?.bindings.slice(0, 5)).toEqual([
      "noop",
      null,
      null,
      null,
      null
    ]);
  });

  it("does not call the model when no trusted scope option is available", async () => {
    const fixture = createCandidateFixture({
      hasTrustedEvidence: false,
      response: { persistent_value: false, confidence: 0.8 }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBe("AI_ANALYSIS_DEFERRED_SCOPE_EVIDENCE");

    expect(fixture.aiInputs).toEqual([]);
    expect(fixture.aiModels).toEqual([]);
    expect(fixture.batch[0]?.bindings.slice(0, 5)).toEqual([
      "pending_review",
      null,
      null,
      null,
      null
    ]);
  });

  it("omits sensitive repository refs from the candidate model payload", async () => {
    const sensitiveRef = `refs/heads/sk-${"A".repeat(32)}`;
    const fixture = createCandidateFixture({
      repositoryRef: sensitiveRef,
      response: { persistent_value: false, confidence: 0.8 }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBeNull();

    expect(fixture.aiInputs).toHaveLength(1);
    const prompt = modelPrompt(fixture.aiInputs[0]);
    expect(prompt).not.toContain(sensitiveRef);
    expect(JSON.parse(prompt)).not.toHaveProperty(
      ["evidence_sources", 0, "repository_ref"]
    );
  });

  it("rejects sensitive aggregate model metadata before the AI call", async () => {
    const fixture = createCandidateFixture({
      sourceType: `sk-${"B".repeat(32)}`,
      response: { persistent_value: false, confidence: 0.8 }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBe("AI_ANALYSIS_DEFERRED_SCOPE_EVIDENCE");

    expect(fixture.aiInputs).toEqual([]);
    expect(fixture.aiModels).toEqual([]);
    expect(fixture.batch[0]?.bindings.slice(0, 5)).toEqual([
      "pending_review",
      null,
      null,
      null,
      null
    ]);
  });

  it("stores non-durable analysis as noop without proposed taxonomy", async () => {
    const fixture = createCandidateFixture({
      response: {
        persistent_value: false,
        kind: null,
        memory_class: null,
        scope_option_id: null,
        evidence_source_ids: null,
        valid_from: null,
        valid_until: null,
        confidence: 0.9
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBeNull();

    expect(fixture.batch[0]?.bindings.slice(0, 5)).toEqual([
      "noop",
      null,
      null,
      null,
      null
    ]);
    expectCandidateTimestampEnums(fixture.aiInputs[0], [null]);
    expectCandidateScopeEvidenceEnums(fixture.aiInputs[0]);
  });

  it("accepts GLM forced-function string nulls for non-durable analysis", async () => {
    const fixture = createCandidateFixture({
      response: {
        persistent_value: false,
        kind: "null",
        memory_class: "null",
        scope_option_id: "null",
        evidence_source_ids: "null",
        valid_from: "null",
        valid_until: "null",
        confidence: 0.9
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBeNull();

    expect(fixture.aiInputs).toHaveLength(1);
    expect(fixture.batch[0]?.bindings.slice(0, 8)).toEqual([
      "noop",
      null,
      null,
      null,
      null,
      null,
      null,
      '{"confidence":0.9,"persistent_value":false}'
    ]);
  });

  it("retries a contradictory non-durable analysis before storing noop", async () => {
    const fixture = createCandidateFixture({
      response: { persistent_value: false, confidence: 0.2 },
      modelAttempts: [
        {
          kind: "analysis",
          response: {
            persistent_value: false,
            kind: "decision",
            memory_class: "semantic",
            scope_option_id: "scope-option-invented",
            evidence_source_ids: ["evidence-1"],
            valid_from: "2026-07-28T10:00:00Z",
            valid_until: null,
            confidence: 0.9
          }
        }
      ]
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBeNull();

    expect(fixture.aiInputs).toHaveLength(2);
    expect(fixture.batch[0]?.bindings.slice(0, 8)).toEqual([
      "noop",
      null,
      null,
      null,
      null,
      null,
      null,
      '{"confidence":0.2,"persistent_value":false}'
    ]);
  });

  it("rejects a candidate timestamp outside the current 32-value tool whitelist", async () => {
    const timestamps = Array.from(
      { length: 33 },
      (_, index) => `2026-07-28T10:00:${String(index).padStart(2, "0")}Z`
    );
    const excludedTimestamp = timestamps[32];
    if (excludedTimestamp === undefined) {
      throw new Error("The timestamp fixture is incomplete.");
    }
    const fixture = createCandidateFixture({
      content: timestamps.join(" "),
      response: {
        persistent_value: true,
        kind: "decision",
        memory_class: "semantic",
        scope: "repository",
        valid_from: excludedTimestamp,
        valid_until: null,
        confidence: 0.99
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBe("AI_ANALYSIS_DEFERRED_TEMPORAL");

    expectCandidateTimestampEnums(fixture.aiInputs[0], [null, ...timestamps.slice(0, 32)]);
    expect(fixture.aiInputs).toHaveLength(3);
    expect(fixture.batch[0]?.bindings.slice(0, 8)).toEqual([
      "pending_review",
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ]);
  });

  it("defers a persistent candidate with null required fields as a schema failure", async () => {
    const fixture = createCandidateFixture({
      response: {
        persistent_value: true,
        kind: null,
        memory_class: null,
        scope_option_id: null,
        evidence_source_ids: null,
        valid_from: null,
        valid_until: null,
        confidence: 0.9
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBe("AI_ANALYSIS_DEFERRED_SCHEMA");

    expect(fixture.aiInputs).toHaveLength(3);
    expect(fixture.batch[0]?.bindings.slice(0, 8)).toEqual([
      "pending_review",
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ]);
  });

  it("allows only verbatim candidate timestamps in the dynamic tool schema", async () => {
    const timestamp = "2026-07-28T12:30:00+05:30";
    const fixture = createCandidateFixture({
      content: `The repository policy starts at ${timestamp}.`,
      response: {
        persistent_value: true,
        kind: "decision",
        memory_class: "semantic",
        scope: "repository",
        valid_from: timestamp,
        valid_until: null,
        confidence: 0.99
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBeNull();

    expectCandidateTimestampEnums(fixture.aiInputs[0], [null, timestamp]);
    expectModelRequestContract(fixture.aiInputs[0], "candidate_analysis");
    expect(fixture.batch[0]?.bindings[5]).toBe(timestamp);
    expect(fixture.batch[0]?.bindings[6]).toBeNull();
  });

  it("budgets the GLM completion against UTF-8 prompt bytes", async () => {
    const fixture = createCandidateFixture({
      content: "跨仓库约定使用不可变修订 🧠",
      response: { persistent_value: false, confidence: 0.9 }
    });

    await processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1");

    const input = fixture.aiInputs[0];
    expectModelRequestContract(input, "candidate_analysis");
    if (
      typeof input !== "object" ||
      input === null ||
      !("messages" in input) ||
      !Array.isArray(input.messages) ||
      !("max_completion_tokens" in input) ||
      typeof input.max_completion_tokens !== "number"
    ) {
      throw new Error("The AI request contract is incomplete.");
    }
    const contents = input.messages.map((message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("content" in message) ||
        typeof message.content !== "string"
      ) {
        throw new Error("The AI input message is invalid.");
      }
      return message.content;
    });
    const promptBytes = contents.reduce(
      (total, content) => total + new TextEncoder().encode(content).byteLength,
      0
    );
    const promptCodeUnits = contents.reduce((total, content) => total + content.length, 0);
    const toolContractBytes = modelToolContractBytes(input);

    expect(promptBytes).toBeGreaterThan(promptCodeUnits);
    expect(input.max_completion_tokens).toBe(
      262_144 - 1_024 - promptBytes - toolContractBytes
    );
    expect(input.max_completion_tokens).not.toBe(
      262_144 - 1_024 - promptCodeUnits - toolContractBytes
    );
  });

  it("keeps invalid model scope pending for review without a proposal", async () => {
    const fixture = createCandidateFixture({
      response: {
        persistent_value: true,
        kind: "decision",
        memory_class: "semantic",
        scope_option_id: "scope-option-invented",
        evidence_source_ids: ["evidence-1"],
        confidence: 0.99
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBe("AI_ANALYSIS_DEFERRED_SCOPE_EVIDENCE");

    expect(fixture.batch[0]?.bindings.slice(0, 8)).toEqual([
      "pending_review",
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ]);
  });

  it("rejects a validity timestamp that is absent from the candidate", async () => {
    const fixture = createCandidateFixture({
      response: {
        persistent_value: true,
        kind: "decision",
        memory_class: "semantic",
        scope: "project",
        valid_from: "2023-10-01T00:00:00Z",
        valid_until: null,
        confidence: 0.99
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBe("AI_ANALYSIS_DEFERRED_TEMPORAL");

    expectCandidateTimestampEnums(fixture.aiInputs[0], [null]);
    expect(fixture.batch[0]?.bindings.slice(0, 8)).toEqual([
      "pending_review",
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ]);
  });

  it("keeps forged evidence pending without taxonomy", async () => {
    const fixture = createCandidateFixture({
      response: {
        persistent_value: true,
        kind: "decision",
        memory_class: "semantic",
        scope: "repository",
        evidence_source_ids: ["evidence-invented"],
        confidence: 0.99
      }
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBe("AI_ANALYSIS_DEFERRED_SCOPE_EVIDENCE");

    expect(fixture.batch[0]?.bindings.slice(0, 8)).toEqual([
      "pending_review",
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ]);
  });

  it("keeps a candidate pending with only a fixed failure-stage diagnostic", async () => {
    const fakeSecret = "fake-secret-must-never-be-persisted-or-returned";
    const fixtures = [
      {
        fixture: createCandidateFixture({ aiError: new Error(fakeSecret) }),
        diagnosticCode: "AI_ANALYSIS_DEFERRED_MODEL_CALL"
      },
      {
        fixture: createCandidateFixture({ response: "not-json", rawResponse: true }),
        diagnosticCode: "AI_ANALYSIS_DEFERRED_RESPONSE_DECODE"
      },
      {
        fixture: createCandidateFixture({
          response: modelFunctionResponse("candidate_analysis", {
            persistent_value: "not-a-boolean",
            confidence: 0.9
          }),
          rawResponse: true
        }),
        diagnosticCode: "AI_ANALYSIS_DEFERRED_SCHEMA"
      }
    ] as const;
    for (const { fixture, diagnosticCode } of fixtures) {
      const resultCode = await processCandidateSubmission(
        fixture.env,
        PROJECT_ID,
        "candidate-1"
      );
      expect(resultCode).toBe(diagnosticCode);
      expect(fixture.aiInputs).toHaveLength(3);
      expect(fixture.batch[0]?.bindings.slice(0, 8)).toEqual([
        "pending_review",
        null,
        null,
        null,
        null,
        null,
        null,
        null
      ]);
      expect(JSON.stringify({ resultCode, batch: fixture.batch })).not.toContain(
        fakeSecret
      );
    }
  });

  it("reports the last failure stage after three bounded attempts", async () => {
    const fixture = createCandidateFixture({
      modelAttempts: [
        { kind: "throw" },
        { kind: "raw", response: "not-a-function-response" },
        {
          kind: "raw",
          response: modelFunctionResponse("candidate_analysis", {
            persistent_value: "not-a-boolean",
            confidence: 0.9
          })
        }
      ]
    });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).resolves.toBe("AI_ANALYSIS_DEFERRED_SCHEMA");
    expect(fixture.aiInputs).toHaveLength(3);
  });

  it("fails an oversized legacy candidate without sending it to the model", async () => {
    const fixture = createCandidateFixture({ content: "x".repeat(16 * 1024 + 1) });

    await expect(
      processCandidateSubmission(fixture.env, PROJECT_ID, "candidate-1")
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(fixture.aiInputs).toEqual([]);
    expect(fixture.batch).toEqual([]);
  });
});

interface ObservationState {
  observationId: string;
  contentSha256: string;
  content: string;
  analysisJson: string;
  status: string;
}

interface ConsolidationState {
  status: "queued" | "running" | "complete" | "failed" | "noop";
  leaseOwner: string | null;
  leaseClaimId: string | null;
  leaseExpiresAt: string | null;
  leaseOperationId: string | null;
  leaseEpoch: number;
  operationIds: string[];
  observations: ObservationState[];
  outputs: Array<{ outputOrder: number; candidateId: string }>;
  failFinishOnce: boolean;
  persistAttempts: number;
  duplicateExclusions: unknown[];
  evidence: string[];
  evidenceLinks: Array<{ candidateId: string; evidenceId: string }>;
  reviewRequests: string[];
  receipts: Array<{
    batchIndex: number;
    leaseOwner: string;
    leaseClaimId: string;
    leaseEpoch: number;
    leaseOperationId: string;
    batchInputDigest: string;
    modelResultDigest: string;
    outputManifestJson: string;
    outputManifestDigest: string;
    suggestionCount: number;
    completedAt: string;
  }>;
}

interface FakeStatement {
  sql: string;
  bindings: unknown[];
  bind(...bindings: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run<T>(): Promise<T>;
}

function createConsolidationFixture(options: {
  failFinishOnce?: boolean;
  existingDuplicate?: Pick<ObservationState, "observationId" | "contentSha256">;
  inputs?: unknown[];
  principalAvailable?: boolean;
  suggestionValidFrom?: string | null;
  suggestionValidUntil?: string | null;
  suggestionContents?: string[];
  registeredRepositoryIds?: string[];
  repositoryBySource?: Record<string, string>;
  evidenceSourceIds?: string[];
  projectOptionAuthority?: string;
  modelAttempts?: readonly ModelAttempt[];
  sessionRepositoryId?: string | null;
  untrustedSourceIds?: string[];
  clearEvidenceUnavailableSourceIds?: string[];
  prependInvalidSuggestion?: boolean;
  yieldAiCall?: boolean;
  crossBatchCitationOnce?: boolean;
  blockFirstAiCall?: boolean;
  expireLeaseBeforeFirstPersist?: boolean;
  expireLeaseBeforePersistAttempt?: number;
} = {}) {
  const inputs = options.inputs ?? [
    {
      input_order: 0,
      input_kind: "candidate",
      source_id: "source-candidate",
      content: "D1 is the authoritative memory store.",
      content_sha256: "source-sha"
    }
  ];
  const state: ConsolidationState = {
    status: "queued",
    leaseOwner: null,
    leaseClaimId: null,
    leaseExpiresAt: null,
    leaseOperationId: null,
    leaseEpoch: 0,
    operationIds: [],
    observations:
      options.existingDuplicate === undefined
        ? []
        : [
            {
              ...options.existingDuplicate,
              content: "Existing duplicate content.",
              analysisJson: "{}",
              status: "pending_review"
            }
          ],
    outputs: [],
    failFinishOnce: options.failFinishOnce ?? false,
    persistAttempts: 0,
    duplicateExclusions: [],
    evidence: [],
    evidenceLinks: [],
    reviewRequests: [],
    receipts: []
  };
  let aiCalls = 0;
  const aiInputs: unknown[] = [];
  const aiModels: unknown[] = [];
  let activeAiCalls = 0;
  let maximumConcurrentAiCalls = 0;
  let firstAiStartedResolve: (() => void) | undefined;
  const firstAiStarted = new Promise<void>((resolve) => {
    firstAiStartedResolve = resolve;
  });
  let releaseFirstAiResolve: (() => void) | undefined;
  const releaseFirstAi = new Promise<void>((resolve) => {
    releaseFirstAiResolve = resolve;
  });
  let expireLeaseBeforePersistAttempt =
    options.expireLeaseBeforePersistAttempt ??
    (options.expireLeaseBeforeFirstPersist === true ? 1 : null);
  const prepare = (sql: string): FakeStatement => {
    const statement: FakeStatement = {
      sql,
      bindings: [],
      bind(...bindings: unknown[]) {
        statement.bindings = bindings;
        return statement;
      },
      async first<T>() {
        if (sql.includes("AS invalid_receipt_count")) {
          const expectedBatchIndexes = new Set(
            inputs.map((input) =>
              Math.floor(Number((input as { input_order: number }).input_order) / 50)
            )
          );
          const receiptBatchIndexes = new Set(
            state.receipts.map((receipt) => receipt.batchIndex)
          );
          return {
            receipt_post_state_valid: 1,
            expected_batch_count: expectedBatchIndexes.size,
            receipt_count: state.receipts.length,
            distinct_receipt_count: receiptBatchIndexes.size,
            suggestion_count: state.receipts.reduce(
              (total, receipt) => total + receipt.suggestionCount,
              0
            ),
            output_count: state.outputs.length,
            missing_receipt_count: [...expectedBatchIndexes].filter(
              (batchIndex) => !receiptBatchIndexes.has(batchIndex)
            ).length,
            orphan_receipt_count: [...receiptBatchIndexes].filter(
              (batchIndex) => !expectedBatchIndexes.has(batchIndex)
            ).length,
            invalid_receipt_count: 0
          } as T;
        }
        if (
          sql.includes("SELECT lease_expires_at") &&
          sql.includes("lease_expires_at > strftime")
        ) {
          const [, , leaseOwner, leaseClaimId, leaseEpoch] = statement.bindings;
          return (leaseIsActive(
            state,
            leaseOwner,
            leaseClaimId,
            leaseEpoch
          )
            ? { lease_expires_at: state.leaseExpiresAt }
            : null) as T | null;
        }
        if (sql.includes("FROM consolidation_batch_receipts")) {
          const batchIndex = statement.bindings[2];
          const receipt = state.receipts.find(
            (item) => item.batchIndex === batchIndex
          );
          return (receipt === undefined
            ? null
            : {
                lease_owner: receipt.leaseOwner,
                lease_claim_id: receipt.leaseClaimId,
                lease_epoch: receipt.leaseEpoch,
                lease_operation_id: receipt.leaseOperationId,
                batch_input_digest: receipt.batchInputDigest,
                model_result_digest: receipt.modelResultDigest,
                output_manifest_json: receipt.outputManifestJson,
                output_manifest_digest: receipt.outputManifestDigest,
                suggestion_count: receipt.suggestionCount,
                completed_at: receipt.completedAt
              }) as T | null;
        }
        if (
          sql.includes("FROM consolidation_outputs AS output") &&
          sql.includes("JOIN observations AS candidate")
        ) {
          const [, , outputOrder, candidateId, , , , contentSha256] =
            statement.bindings;
          const output = state.outputs.find(
            (item) =>
              item.outputOrder === outputOrder && item.candidateId === candidateId
          );
          const observation = state.observations.find(
            (item) => item.observationId === candidateId
          );
          return (output !== undefined &&
            observation?.contentSha256 === contentSha256
            ? { observation_id: candidateId }
            : null) as T | null;
        }
        if (
          sql.includes("FROM review_requests") &&
          sql.includes("review_request_id = ?")
        ) {
          const candidateId = statement.bindings[1];
          const reviewRequestId = statement.bindings[2];
          return (candidateId === reviewRequestId &&
            typeof candidateId === "string" &&
            state.reviewRequests.includes(candidateId)
            ? { review_request_id: reviewRequestId }
            : null) as T | null;
        }
        if (sql.includes("SELECT status, lease_owner")) {
          return {
            status: state.status,
            lease_owner: state.leaseOwner,
            lease_claim_id: state.leaseClaimId,
            lease_expires_at: state.leaseExpiresAt,
            lease_operation_id: state.leaseOperationId,
            lease_epoch: state.leaseEpoch,
            has_outputs: state.outputs.length > 0 ? 1 : 0,
            lease_active:
              state.leaseExpiresAt !== null &&
              state.leaseExpiresAt > new Date().toISOString()
                ? 1
                : 0
          } as T;
        }
        if (sql.includes("SELECT principal_id, repository_id, repository_ref FROM sessions")) {
          return (options.principalAvailable === false
            ? null
            : {
                principal_id: "principal-1",
                repository_id:
                  options.sessionRepositoryId === undefined
                    ? REPOSITORY_ID
                    : options.sessionRepositoryId,
                repository_ref:
                  options.sessionRepositoryId === null ? null : "refs/heads/main"
              }) as T | null;
        }
        if (
          sql.includes("FROM observations") &&
          sql.includes("content_sha256 = ?") &&
          sql.includes("observation_id <> ?")
        ) {
          const [, contentSha256, excludedObservationId] = statement.bindings;
          state.duplicateExclusions.push(excludedObservationId);
          const duplicate = state.observations.some(
            (observation) =>
              observation.contentSha256 === contentSha256 &&
              observation.observationId !== excludedObservationId &&
              !["rejected_sensitive", "rejected"].includes(observation.status)
          );
          return (duplicate ? { duplicate: 1 } : null) as T | null;
        }
        if (sql.includes("SELECT candidate_id FROM consolidation_outputs")) {
          const outputOrder = statement.bindings[2];
          const output = state.outputs.find((item) => item.outputOrder === outputOrder);
          return (output === undefined ? null : { candidate_id: output.candidateId }) as T | null;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("SELECT batch_index, lease_owner, lease_claim_id")) {
          return {
            results: [...state.receipts]
              .sort((left, right) => left.batchIndex - right.batchIndex)
              .map((receipt) => ({
                batch_index: receipt.batchIndex,
                lease_owner: receipt.leaseOwner,
                lease_claim_id: receipt.leaseClaimId,
                lease_epoch: receipt.leaseEpoch,
                lease_operation_id: receipt.leaseOperationId,
                batch_input_digest: receipt.batchInputDigest,
                model_result_digest: receipt.modelResultDigest,
                output_manifest_json: receipt.outputManifestJson,
                output_manifest_digest: receipt.outputManifestDigest,
                suggestion_count: receipt.suggestionCount,
                completed_at: receipt.completedAt
              })) as T[]
          };
        }
        if (
          sql.includes("FROM observation_evidence") &&
          (sql.includes("ORDER BY evidence_id ASC") ||
            sql.includes("ORDER BY linked.evidence_id ASC"))
        ) {
          const candidateId = statement.bindings[1];
          return {
            results: state.evidenceLinks
              .filter((link) => link.candidateId === candidateId)
              .map((link) => ({
                evidence_id: link.evidenceId,
                sensitivity_status: "clear"
              }))
              .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)) as T[]
          };
        }
        if (sql.includes("FROM consolidation_inputs AS frozen_input")) {
          return {
            results: inputs.map((input) => {
              const source = input as {
                input_kind?: unknown;
                source_id?: unknown;
              };
              const trusted =
                typeof source.source_id === "string" &&
                !options.untrustedSourceIds?.includes(source.source_id);
              const hasClearEvidence =
                trusted &&
                typeof source.source_id === "string" &&
                !options.clearEvidenceUnavailableSourceIds?.includes(source.source_id);
              return {
                source_id: source.source_id,
                evidence_id:
                  source.input_kind === "candidate" && hasClearEvidence
                    ? "evidence-1"
                    : null,
                evidence_repository_id:
                  source.input_kind === "candidate" &&
                  hasClearEvidence &&
                  typeof source.source_id === "string"
                    ? options.repositoryBySource?.[source.source_id] ?? REPOSITORY_ID
                    : null,
                evidence_repository_ref:
                  source.input_kind === "candidate" && hasClearEvidence
                    ? "refs/heads/main"
                    : null,
                evidence_repository_authority:
                  source.input_kind === "candidate" && hasClearEvidence
                    ? "agent_supplied"
                    : null,
                evidence_source_type:
                  source.input_kind === "candidate" && hasClearEvidence
                    ? "agent_submission"
                    : null,
                session_repository_id:
                  source.input_kind === "candidate" &&
                  trusted &&
                  typeof source.source_id === "string"
                    ? options.repositoryBySource?.[source.source_id] ?? REPOSITORY_ID
                    : null,
                session_repository_ref:
                  source.input_kind === "candidate" && trusted
                    ? "refs/heads/main"
                    : null
              };
            }) as T[]
          };
        }
        if (sql.includes("FROM consolidation_inputs")) {
          if (sql.includes("AS batch_index")) {
            const batchIndexes = new Set<number | null>();
            for (const input of inputs) {
              const inputOrder = (input as { input_order?: unknown }).input_order;
              batchIndexes.add(
                typeof inputOrder === "number" && Number.isSafeInteger(inputOrder) && inputOrder >= 0
                  ? Math.floor(inputOrder / 50)
                  : null
              );
            }
            return {
              results: [...batchIndexes]
                .sort((left, right) => (left ?? -1) - (right ?? -1))
                .slice(0, Number(statement.bindings[2]))
                .map((batch_index) => ({ batch_index })) as T[]
            };
          }
          if (sql.includes("input_order BETWEEN ? AND ?")) {
            const firstInputOrder = statement.bindings[2];
            const lastInputOrder = statement.bindings[3];
            return {
              results: inputs.filter((input) => {
                const inputOrder = (input as { input_order?: unknown }).input_order;
                return (
                  typeof inputOrder === "number" &&
                  typeof firstInputOrder === "number" &&
                  typeof lastInputOrder === "number" &&
                  inputOrder >= firstInputOrder &&
                  inputOrder <= lastInputOrder
                );
              }) as T[]
            };
          }
          return { results: inputs as T[] };
        }
        if (sql.includes("SELECT repository_id FROM repositories")) {
          return {
            results: (options.registeredRepositoryIds ?? [REPOSITORY_ID]).map(
              (repository_id) => ({ repository_id })
            ) as T[]
          };
        }
        return { results: [] };
      },
      async run<T>() {
        if (sql.includes("lease_epoch = lease_epoch + 1")) {
          const [requestedOwner, requestedClaimId, , , , , maximumEpoch] =
            statement.bindings;
          const now = new Date().toISOString();
          const canRun =
            Number.isSafeInteger(state.leaseEpoch) &&
            typeof maximumEpoch === "number" &&
            state.leaseEpoch >= 0 &&
            state.leaseEpoch < maximumEpoch &&
            (state.status === "queued" ||
              state.status === "failed" ||
              (state.status === "running" &&
                state.leaseExpiresAt !== null &&
                state.leaseExpiresAt <= now));
          if (canRun) {
            state.status = "running";
            state.leaseOwner = String(requestedOwner);
            state.leaseClaimId = String(requestedClaimId);
            state.leaseExpiresAt = new Date(
              Date.now() + 20 * 60 * 1_000
            ).toISOString();
            state.leaseOperationId = null;
            state.leaseEpoch += 1;
          }
          return result(canRun ? 1 : 0) as T;
        }
        if (
          sql.includes("SET lease_expires_at = ?") &&
          !sql.includes("lease_epoch = lease_epoch + 1")
        ) {
          const [
            renewedUntil,
            ,
            ,
            leaseOwner,
            leaseClaimId,
            leaseEpoch,
            expectedExpiry
          ] = statement.bindings;
          if (
            leaseIsActive(state, leaseOwner, leaseClaimId, leaseEpoch) &&
            state.leaseExpiresAt === expectedExpiry
          ) {
            state.leaseExpiresAt = String(renewedUntil);
            return result(1) as T;
          }
          return result(0) as T;
        }
        if (sql.includes("SET status = 'failed'")) {
          const [, , leaseOwner, leaseClaimId, leaseEpoch] = statement.bindings;
          if (
            state.status === "running" &&
            state.leaseOwner === leaseOwner &&
            state.leaseClaimId === leaseClaimId &&
            state.leaseEpoch === leaseEpoch
          ) {
            state.status = "failed";
            state.leaseOwner = null;
            state.leaseClaimId = null;
            state.leaseExpiresAt = null;
            state.leaseOperationId = null;
            return result(1) as T;
          }
          return result(0) as T;
        }
        if (sql.includes("UPDATE session_consolidations SET status = ?")) {
          if (state.failFinishOnce) {
            state.failFinishOnce = false;
            throw new Error("Synthetic finish failure");
          }
          const [status] = statement.bindings;
          if (state.status === "running" && (status === "complete" || status === "noop")) {
            state.status = status;
            state.leaseOwner = null;
            state.leaseClaimId = null;
            state.leaseExpiresAt = null;
            state.leaseOperationId = null;
            return result(1) as T;
          }
          return result(0) as T;
        }
        if (
          sql.includes("UPDATE session_consolidations") &&
          sql.includes("SET status = CASE") &&
          sql.includes("FROM consolidation_outputs")
        ) {
          if (state.failFinishOnce) {
            state.failFinishOnce = false;
            throw new Error("Synthetic finish failure");
          }
          const leaseOwner = statement.bindings[2];
          const leaseClaimId = statement.bindings[3];
          const leaseEpoch = statement.bindings[4];
          const expectedReceiptCount = statement.bindings[5];
          if (
            leaseIsActive(state, leaseOwner, leaseClaimId, leaseEpoch) &&
            state.receipts.length === expectedReceiptCount
          ) {
            state.status = state.outputs.length === 0 ? "noop" : "complete";
            state.leaseOwner = null;
            state.leaseClaimId = null;
            state.leaseExpiresAt = null;
            state.leaseOperationId = null;
            return result(1) as T;
          }
          return result(0) as T;
        }
        return result(0) as T;
      }
    };
    return statement;
  };

  const database = {
    prepare,
    withSession(constraint: string) {
      expect(constraint).toBe("first-primary");
      return {
        prepare,
        async batch(statements: FakeStatement[]) {
          const results = [];
          for (const statement of statements) {
            if (statement.sql.includes("SELECT status, lease_owner")) {
              results.push({
                ...result(0),
                results: [
                  {
                    status: state.status,
                    lease_owner: state.leaseOwner,
                    lease_claim_id: state.leaseClaimId,
                    lease_expires_at: state.leaseExpiresAt,
                    lease_operation_id: state.leaseOperationId,
                    lease_epoch: state.leaseEpoch,
                    has_outputs: state.outputs.length > 0 ? 1 : 0,
                    lease_active:
                      state.leaseExpiresAt !== null &&
                      state.leaseExpiresAt > new Date().toISOString()
                        ? 1
                        : 0
                  }
                ]
              });
            } else {
              results.push(await statement.run());
            }
          }
          return results;
        }
      };
    },
    async batch(statements: FakeStatement[]) {
      state.persistAttempts += 1;
      if (state.persistAttempts === expireLeaseBeforePersistAttempt) {
        state.leaseExpiresAt = "1970-01-01T00:00:00.000Z";
        expireLeaseBeforePersistAttempt = null;
      }
      const results = [];
      for (const statement of statements) {
        expect(statement.bindings).toHaveLength(statement.sql.match(/\?/gu)?.length ?? 0);
        let changes = 0;
        if (
          statement.sql.includes("UPDATE session_consolidations") &&
          statement.sql.includes("SET lease_operation_id = ?")
        ) {
          const [operationId, , , leaseOwner, leaseClaimId, leaseEpoch] =
            statement.bindings;
          if (
            typeof operationId === "string" &&
            isConsolidationOperationId(operationId) &&
            state.leaseOperationId === null &&
            leaseIsActive(state, leaseOwner, leaseClaimId, leaseEpoch)
          ) {
            state.leaseOperationId = operationId;
            state.operationIds.push(operationId);
            changes = 1;
          }
          results.push(result(changes));
          continue;
        }
        if (statement.sql.includes("INSERT INTO observations")) {
          const [observationId, , , , content, contentSha256] = statement.bindings;
          const analysisJson = statement.bindings[12];
          const outputOrder = statement.bindings[18];
          const leaseOwner = statement.bindings[24];
          const leaseClaimId = statement.bindings[25];
          const leaseEpoch = statement.bindings[26];
          const operationId = statement.bindings[27];
          if (
            typeof observationId === "string" &&
            typeof content === "string" &&
            typeof contentSha256 === "string" &&
            typeof analysisJson === "string" &&
            ownsConsolidationOperation(
              state,
              leaseOwner,
              leaseClaimId,
              leaseEpoch,
              operationId
            ) &&
            !state.outputs.some((output) => output.outputOrder === outputOrder) &&
            !state.observations.some(
              (observation) => observation.observationId === observationId
            )
          ) {
            state.observations.push({
              observationId,
              contentSha256,
              content,
              analysisJson,
              status: "pending_review"
            });
            changes = 1;
          }
        }
        if (statement.sql.includes("INSERT INTO consolidation_outputs")) {
          const [, , outputOrder, candidateId] = statement.bindings;
          const leaseOwner = statement.bindings[8];
          const leaseClaimId = statement.bindings[9];
          const leaseEpoch = statement.bindings[10];
          const operationId = statement.bindings[11];
          const contentSha256 = statement.bindings[13];
          const analysisJson = statement.bindings[14];
          const candidate = state.observations.find(
            (observation) => observation.observationId === candidateId
          );
          if (
            typeof outputOrder === "number" &&
            typeof candidateId === "string" &&
            ownsConsolidationOperation(
              state,
              leaseOwner,
              leaseClaimId,
              leaseEpoch,
              operationId
            ) &&
            candidate?.contentSha256 === contentSha256 &&
            candidate?.analysisJson === analysisJson &&
            !state.outputs.some((output) => output.outputOrder === outputOrder)
          ) {
            state.outputs.push({ outputOrder, candidateId });
            changes = 1;
          }
        }
        if (statement.sql.includes("INSERT INTO evidence")) {
          const evidenceId = statement.bindings[0];
          if (
            typeof evidenceId === "string" &&
            ownsConsolidationSlot(state, statement) &&
            !state.evidence.includes(evidenceId)
          ) {
            state.evidence.push(evidenceId);
            changes = 1;
          }
        }
        if (statement.sql.includes("INSERT INTO observation_evidence")) {
          const candidateId = statement.bindings[1];
          const evidenceIds = statement.bindings.slice(
            4,
            statement.bindings.length - 11
          );
          if (
            typeof candidateId === "string" &&
            ownsConsolidationSlot(state, statement)
          ) {
            for (const evidenceId of evidenceIds) {
              if (
                typeof evidenceId === "string" &&
                !state.evidenceLinks.some(
                  (link) =>
                    link.candidateId === candidateId &&
                    link.evidenceId === evidenceId
                )
              ) {
                state.evidenceLinks.push({ candidateId, evidenceId });
                changes += 1;
              }
            }
          }
        }
        if (statement.sql.includes("UPDATE observations AS candidate")) {
          changes = ownsConsolidationSlot(state, statement) ? 1 : 0;
        }
        if (statement.sql.includes("INSERT INTO review_requests")) {
          const candidateId = statement.bindings[0];
          if (
            typeof candidateId === "string" &&
            ownsConsolidationSlot(state, statement) &&
            !state.reviewRequests.includes(candidateId)
          ) {
            state.reviewRequests.push(candidateId);
            changes = 1;
          }
        }
        if (statement.sql.includes("INSERT INTO consolidation_batch_receipts")) {
          const [
            ,
            ,
            batchIndex,
            leaseOwner,
            leaseClaimId,
            leaseEpoch,
            leaseOperationId,
            batchInputDigest,
            modelResultDigest,
            outputManifestJson,
            outputManifestDigest,
            suggestionCount,
            completedAt
          ] = statement.bindings;
          let manifest: Array<{
            output_order: number;
            candidate_id: string;
            content_sha256: string;
            evidence_ids: string[];
          }> = [];
          try {
            manifest = JSON.parse(String(outputManifestJson)) as typeof manifest;
          } catch {
            manifest = [];
          }
          const exactManifest =
            Array.isArray(manifest) &&
            manifest.length === suggestionCount &&
            manifest.every((entry) => {
              const output = state.outputs.find(
                (item) =>
                  item.outputOrder === entry.output_order &&
                  item.candidateId === entry.candidate_id
              );
              const observation = state.observations.find(
                (item) => item.observationId === entry.candidate_id
              );
              return (
                output !== undefined &&
                observation?.contentSha256 === entry.content_sha256 &&
                state.reviewRequests.includes(entry.candidate_id) &&
                Array.isArray(entry.evidence_ids)
              );
            });
          if (
            typeof batchIndex === "number" &&
            typeof leaseOwner === "string" &&
            typeof leaseClaimId === "string" &&
            typeof leaseEpoch === "number" &&
            typeof leaseOperationId === "string" &&
            typeof batchInputDigest === "string" &&
            typeof modelResultDigest === "string" &&
            typeof outputManifestJson === "string" &&
            typeof outputManifestDigest === "string" &&
            typeof suggestionCount === "number" &&
            typeof completedAt === "string" &&
            exactManifest &&
            ownsConsolidationOperation(
              state,
              leaseOwner,
              leaseClaimId,
              leaseEpoch,
              leaseOperationId
            ) &&
            !state.receipts.some((receipt) => receipt.batchIndex === batchIndex)
          ) {
            state.receipts.push({
              batchIndex,
              leaseOwner,
              leaseClaimId,
              leaseEpoch,
              leaseOperationId,
              batchInputDigest,
              modelResultDigest,
              outputManifestJson,
              outputManifestDigest,
              suggestionCount,
              completedAt
            });
            changes = 1;
          }
        }
        if (
          statement.sql.includes("SET lease_operation_id = NULL") &&
          statement.sql.includes("updated_at = strftime")
        ) {
          const [
            ,
            ,
            leaseOwner,
            leaseClaimId,
            leaseEpoch,
            operationId,
            batchIndex
          ] = statement.bindings;
          if (
            ownsConsolidationOperation(
              state,
              leaseOwner,
              leaseClaimId,
              leaseEpoch,
              operationId
            ) &&
            state.receipts.some((receipt) => receipt.batchIndex === batchIndex)
          ) {
            state.leaseOperationId = null;
            changes = 1;
          }
        }
        results.push(result(changes));
      }
      return results;
    }
  };
  const ai = {
    async run(model: unknown, input: unknown) {
      activeAiCalls += 1;
      maximumConcurrentAiCalls = Math.max(maximumConcurrentAiCalls, activeAiCalls);
      const callNumber = aiCalls + 1;
      aiCalls = callNumber;
      aiModels.push(model);
      aiInputs.push(input);
      try {
        if (options.blockFirstAiCall && callNumber === 1) {
          firstAiStartedResolve?.();
          await releaseFirstAi;
        }
        if (options.yieldAiCall) {
          await Promise.resolve();
        }
        const configuredAttempt = options.modelAttempts?.[callNumber - 1];
        if (configuredAttempt?.kind === "throw") {
          throw new Error("Synthetic model failure");
        }
        if (configuredAttempt?.kind === "raw") {
          return configuredAttempt.response;
        }
        if (configuredAttempt?.kind === "analysis") {
          return modelFunctionResponse(
            "consolidation_suggestions",
            configuredAttempt.response
          );
        }
        const prompt = JSON.parse(modelPrompt(input)) as {
          inputs?: Array<{ source_id: string }>;
          scope_options?: Array<{ option_id: string; scope: string }>;
        };
        const sourceId = prompt.inputs?.[0]?.source_id;
        const projectOption = prompt.scope_options?.find(
          (option) =>
            option.scope === "project" &&
            (options.projectOptionAuthority === undefined ||
              (option as { authority?: string }).authority ===
                options.projectOptionAuthority)
        );
        if (projectOption === undefined) {
          throw new Error("The test model could not select a project scope option.");
        }
        const validSuggestion = {
              content:
                options.suggestionContents?.[callNumber - 1] ??
                "D1 remains the authoritative memory store.",
              kind: "decision",
              memory_class: "semantic",
              scope_option_id: projectOption.option_id,
              ...(options.suggestionValidFrom === undefined
                ? {}
                : { valid_from: options.suggestionValidFrom }),
              ...(options.suggestionValidUntil === undefined
                ? {}
                : { valid_until: options.suggestionValidUntil }),
              evidence_source_ids:
                options.crossBatchCitationOnce && callNumber === 1
                  ? ["source-50"]
                  : options.evidenceSourceIds ??
                    [typeof sourceId === "string" ? sourceId : "source-candidate"],
              confidence: 0.99
            };
        return modelFunctionResponse("consolidation_suggestions", {
          suggestions: [
            ...(options.prependInvalidSuggestion
              ? [
                  {
                    ...validSuggestion,
                    content: "Rejected temporal suggestion.",
                    valid_from: "2026-01-01T00:00:00Z"
                  }
                ]
              : []),
            validSuggestion
          ]
        });
      } finally {
        activeAiCalls -= 1;
      }
    }
  };

  return {
    env: { MEMORY_DB: database, AI: ai } as unknown as Parameters<
      typeof consolidateSession
    >[0],
    state,
    get aiCalls() {
      return aiCalls;
    },
    get maximumConcurrentAiCalls() {
      return maximumConcurrentAiCalls;
    },
    aiInputs,
    aiModels,
    async waitForFirstAiCall() {
      await firstAiStarted;
    },
    releaseFirstAiCall() {
      releaseFirstAiResolve?.();
      releaseFirstAiResolve = undefined;
    }
  };
}

function ownsConsolidationSlot(
  state: ConsolidationState,
  statement: FakeStatement
): boolean {
  const [
    leaseOwner,
    leaseClaimId,
    leaseEpoch,
    operationId,
    ,
    ,
    outputOrder,
    candidateId,
    ,
    contentSha256,
    analysisJson
  ] = statement.bindings.slice(-11);
  const output = state.outputs.find(
    (item) => item.outputOrder === outputOrder && item.candidateId === candidateId
  );
  const observation = state.observations.find(
    (item) => item.observationId === candidateId
  );
  return (
    ownsConsolidationOperation(
      state,
      leaseOwner,
      leaseClaimId,
      leaseEpoch,
      operationId
    ) &&
    output !== undefined &&
    observation?.contentSha256 === contentSha256 &&
    observation?.analysisJson === analysisJson
  );
}

function ownsConsolidationOperation(
  state: ConsolidationState,
  leaseOwner: unknown,
  leaseClaimId: unknown,
  leaseEpoch: unknown,
  operationId: unknown
): boolean {
  return (
    state.status === "running" &&
    state.leaseOwner === leaseOwner &&
    state.leaseClaimId === leaseClaimId &&
    state.leaseEpoch === leaseEpoch &&
    state.leaseOperationId === operationId
  );
}

function isConsolidationOperationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value
  );
}

function leaseIsActive(
  state: ConsolidationState,
  leaseOwner: unknown,
  leaseClaimId: unknown,
  leaseEpoch: unknown
): boolean {
  return (
    state.status === "running" &&
    state.leaseOwner === leaseOwner &&
    state.leaseClaimId === leaseClaimId &&
    state.leaseEpoch === leaseEpoch &&
    state.leaseExpiresAt !== null &&
    state.leaseExpiresAt > new Date().toISOString()
  );
}

function createCandidateFixture(options: {
  response?: unknown;
  rawResponse?: boolean;
  aiError?: Error;
  content?: string;
  hasTrustedEvidence?: boolean;
  repositoryRef?: string;
  sourceType?: string;
  modelAttempts?: readonly ModelAttempt[];
}) {
  const batch: FakeStatement[] = [];
  const aiInputs: unknown[] = [];
  const aiModels: unknown[] = [];
  const prepare = (sql: string): FakeStatement => {
    const statement: FakeStatement = {
      sql,
      bindings: [],
      bind(...bindings: unknown[]) {
        statement.bindings = bindings;
        return statement;
      },
      async first<T>() {
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM observations AS candidate")) {
          return {
            results: [
              {
                content: options.content ?? "D1 is authoritative.",
                session_id: SESSION_ID,
                evidence_id:
                  options.hasTrustedEvidence === false ? null : "evidence-1",
                repository_id:
                  options.hasTrustedEvidence === false ? null : REPOSITORY_ID,
                repository_ref:
                  options.hasTrustedEvidence === false
                    ? null
                    : (options.repositoryRef ?? "refs/heads/main"),
                repository_authority:
                  options.hasTrustedEvidence === false ? null : "agent_supplied",
                source_type:
                  options.hasTrustedEvidence === false
                    ? null
                    : (options.sourceType ?? "agent_submission")
              }
            ] as T[]
          };
        }
        if (sql.includes("SELECT repository_id FROM repositories")) {
          return { results: [{ repository_id: REPOSITORY_ID }] as T[] };
        }
        return { results: [] as T[] };
      },
      async run<T>() {
        return result(0) as T;
      }
    };
    return statement;
  };
  const database = {
    prepare,
    async batch(statements: FakeStatement[]) {
      batch.push(...statements);
      return statements.map(() => result(1));
    }
  };
  const ai = {
    async run(model: unknown, input: unknown) {
      aiModels.push(model);
      aiInputs.push(input);
      if (options.aiError !== undefined) {
        throw options.aiError;
      }
      const configuredAttempt = options.modelAttempts?.[aiInputs.length - 1];
      if (configuredAttempt?.kind === "throw") {
        throw new Error("Synthetic model failure");
      }
      if (configuredAttempt?.kind === "raw") {
        return configuredAttempt.response;
      }
      if (options.rawResponse) {
        return options.response;
      }
      return modelFunctionResponse(
        "candidate_analysis",
        withSelectedScopeOption(
          configuredAttempt?.kind === "analysis"
            ? configuredAttempt.response
            : options.response,
          input
        )
      );
    }
  };
  return {
    env: { MEMORY_DB: database, AI: ai } as unknown as Parameters<
      typeof processCandidateSubmission
    >[0],
    batch,
    aiInputs,
    aiModels
  };
}

function withSelectedScopeOption(response: unknown, input: unknown): unknown {
  if (
    typeof response !== "object" ||
    response === null ||
    !("persistent_value" in response) ||
    response.persistent_value !== true ||
    "scope_option_id" in response
  ) {
    return response;
  }
  const prompt = JSON.parse(modelPrompt(input)) as {
    scope_options?: Array<{ option_id: string; scope: string }>;
  };
  const requestedScope = "scope" in response ? response.scope : "repository";
  const option = prompt.scope_options?.find((item) => item.scope === requestedScope);
  if (option === undefined) {
    throw new Error("The test model could not select a scope option.");
  }
  const proposal = { ...(response as Record<string, unknown>) };
  delete proposal.scope;
  return {
    ...proposal,
    scope_option_id: option.option_id,
    evidence_source_ids:
      "evidence_source_ids" in response
        ? response.evidence_source_ids
        : ["evidence-1"]
  };
}

function modelPrompt(input: unknown): string {
  if (typeof input !== "object" || input === null || !("messages" in input)) {
    throw new Error("The AI input does not contain messages.");
  }
  const messages = input.messages;
  if (!Array.isArray(messages)) {
    throw new Error("The AI input messages are invalid.");
  }
  const content = messages.at(-1)?.content;
  if (typeof content !== "string") {
    throw new Error("The AI input prompt is invalid.");
  }
  return content;
}

function expectModelRequestContract(input: unknown, schemaName: string): void {
  if (typeof input !== "object" || input === null) {
    throw new Error("The AI input is invalid.");
  }
  expect(input).not.toHaveProperty("max_tokens");
  expect(input).not.toHaveProperty("response_format");
  expect(input).toHaveProperty("parallel_tool_calls", false);
  expect(input).toHaveProperty("tool_choice", {
    type: "function",
    function: { name: schemaName }
  });
  expect(input).toHaveProperty("tools", [
    {
      type: "function",
      function: {
        name: schemaName,
        description: expect.any(String),
        parameters: expect.objectContaining({ type: "object" })
      }
    }
  ]);
  if (!("tools" in input) || !Array.isArray(input.tools)) {
    throw new Error("The AI request tools are invalid.");
  }
  expect(input.tools).toHaveLength(1);
  if (!("max_completion_tokens" in input) || !("messages" in input)) {
    throw new Error("The AI request contract is incomplete.");
  }
  const messages = input.messages;
  if (!Array.isArray(messages)) {
    throw new Error("The AI input messages are invalid.");
  }
  const promptBytes = messages.reduce((total, message) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("content" in message) ||
      typeof message.content !== "string"
    ) {
      throw new Error("The AI input message is invalid.");
    }
    return total + new TextEncoder().encode(message.content).byteLength;
  }, 0);
  expect(input.max_completion_tokens).toBe(
    262_144 - 1_024 - promptBytes - modelToolContractBytes(input)
  );
}

function expectCandidateTimestampEnums(
  input: unknown,
  expected: readonly (string | null)[]
): void {
  for (const property of ["valid_from", "valid_until"]) {
    expect(input).toHaveProperty(
      ["tools", 0, "function", "parameters", "properties", property, "enum"],
      expected
    );
  }
}

function expectCandidateScopeEvidenceEnums(input: unknown): void {
  const prompt = JSON.parse(modelPrompt(input)) as {
    scope_options: Array<{ option_id: string }>;
    evidence_sources: Array<{ evidence_source_id: string }>;
  };
  const scopeOptionIds = prompt.scope_options
    .map((option) => option.option_id)
    .sort(stableStringCompare);
  const evidenceSourceIds = prompt.evidence_sources
    .map((source) => source.evidence_source_id)
    .sort(stableStringCompare);
  expect(input).toHaveProperty(
    [
      "tools",
      0,
      "function",
      "parameters",
      "properties",
      "scope_option_id",
      "enum"
    ],
    [null, ...scopeOptionIds]
  );
  expect(input).toHaveProperty(
    [
      "tools",
      0,
      "function",
      "parameters",
      "properties",
      "scope_option_id",
      "type"
    ],
    ["string", "null"]
  );
  expect(input).toHaveProperty(
    [
      "tools",
      0,
      "function",
      "parameters",
      "properties",
      "evidence_source_ids",
      "type"
    ],
    ["array", "null"]
  );
  expect(input).toHaveProperty(
    [
      "tools",
      0,
      "function",
      "parameters",
      "properties",
      "evidence_source_ids",
      "items",
      "enum"
    ],
    evidenceSourceIds
  );
  expect(input).toHaveProperty(
    ["tools", 0, "function", "parameters", "properties", "kind", "enum"],
    [
      null,
      "decision",
      "fact",
      "convention",
      "procedure",
      "learning",
      "incident",
      "reference",
      "feedback"
    ]
  );
  expect(input).toHaveProperty(
    ["tools", 0, "function", "parameters", "properties", "memory_class", "enum"],
    [null, "semantic", "procedural", "episodic"]
  );
  expect(input).toHaveProperty(
    ["tools", 0, "function", "parameters", "required"],
    [
      "persistent_value",
      "kind",
      "memory_class",
      "scope_option_id",
      "evidence_source_ids",
      "valid_from",
      "valid_until",
      "confidence"
    ]
  );
}

function stableStringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function expectConsolidationTimestampEnums(
  input: unknown,
  expected: readonly (string | null)[]
): void {
  for (const property of ["valid_from", "valid_until"]) {
    expect(input).toHaveProperty(
      [
        "tools",
        0,
        "function",
        "parameters",
        "properties",
        "suggestions",
        "items",
        "properties",
        property,
        "enum"
      ],
      expected
    );
  }
}

function modelToolContractBytes(input: object): number {
  if (!("tools" in input) || !("tool_choice" in input)) {
    throw new Error("The AI request tool contract is incomplete.");
  }
  return new TextEncoder().encode(
    JSON.stringify({ tools: input.tools, tool_choice: input.tool_choice })
  ).byteLength;
}

function modelFunctionResponse(name: string, value: unknown): Record<string, unknown> {
  return modelFunctionArgumentsResponse(name, JSON.stringify(value));
}

function modelFunctionArgumentsResponse(
  name: string,
  argumentsText: string
): Record<string, unknown> {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: "function",
              function: { name, arguments: argumentsText }
            }
          ]
        }
      }
    ]
  };
}

function isCanonicalJsonPrompt(input: unknown): boolean {
  const prompt = modelPrompt(input);
  try {
    return JSON.stringify(JSON.parse(prompt)) === prompt;
  } catch {
    return false;
  }
}

function result(changes: number) {
  return {
    success: true as const,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes
    },
    results: []
  };
}
