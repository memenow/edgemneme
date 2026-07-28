import { describe, expect, it } from "vitest";
import { SearchPipeline } from "../src/search/pipeline";
import { asIndexGeneration } from "../src/search/ranking";
import type {
  HeadValidationInput,
  RecallInput,
  RecallProvider,
  RerankInput,
  Reranker,
  ValidatedSearchCandidate
} from "../src/search/types";

const generation = asIndexGeneration("generation-blue");

function validated(
  memoryId: string,
  retrievalScore: number,
  evidenceIds: string[] = [`evidence-${memoryId}`]
): ValidatedSearchCandidate {
  return {
    projectId: "project-1",
    memoryId,
    revisionId: `projected-${memoryId}`,
    memoryVersion: 3,
    chunkId: `chunk-${memoryId}`,
    content: `${memoryId} says D1 is authoritative.`,
    contentSha256: `sha-${memoryId}`,
    kind: "fact",
    memoryClass: "semantic",
    scope: "project",
    scopeId: "project-1",
    status: "active",
    validFrom: null,
    validUntil: null,
    evidenceIds,
    retrievalScore,
    embedding: memoryId.endsWith("1") ? [1, 0] : [0, 1],
    indexGeneration: generation
  };
}

class FakeRecall implements RecallProvider {
  readonly calls: RecallInput[] = [];

  constructor(
    private readonly memoryIds: string[],
    private readonly channel: "exact" | "lexical" | "semantic"
  ) {}

  async recall(input: RecallInput) {
    this.calls.push(input);
    return this.memoryIds.map((memoryId) => ({
      projectId: input.filters.projectId,
      memoryId,
      revisionId: `projected-${memoryId}`,
      chunkId: `chunk-${memoryId}`,
      indexGeneration: input.filters.indexGeneration,
      sourceScore: 0.9,
      channel: this.channel
    }));
  }
}

class FakeReranker implements Reranker {
  readonly calls: RerankInput[] = [];

  async rerank(input: RerankInput) {
    this.calls.push(input);
    return input.candidates.map((candidate, index) => ({
      candidate,
      relevance: index === 0 ? 0.95 : 0.8
    }));
  }
}

describe("SearchPipeline", () => {
  it("runs exact, lexical, semantic, authoritative validation, MMR, and reranking", async () => {
    const exact = new FakeRecall(["memory-1"], "exact");
    const lexical = new FakeRecall(["memory-1", "memory-stale"], "lexical");
    const semantic = new FakeRecall(["memory-2", "memory-1"], "semantic");
    const validationCalls: HeadValidationInput[] = [];
    const reranker = new FakeReranker();
    const pipeline = new SearchPipeline({
      exact,
      lexical,
      semantic,
      headValidator: {
        async validate(input) {
          validationCalls.push(input);
          return [validated("memory-1", 1), validated("memory-2", 0.8)];
        }
      },
      reranker
    });

    const result = await pipeline.search({
      projectId: "project-1",
      principalId: "principal-1",
      snapshotVersion: 7,
      query: "memory-1 src/storage/mutation-plan.ts D1",
      indexGeneration: generation,
      limit: 5,
      now: "2026-07-25T12:00:00.000Z"
    });

    expect(result.abstained).toBe(false);
    expect(result.memories.map((memory) => memory.memoryId)).toEqual(["memory-1", "memory-2"]);
    expect(result.contextPack).toContain("[evidence-memory-1]");
    expect(result.indexGeneration).toBe(generation);
    expect(exact.calls[0]?.exactReferences).toEqual(
      expect.arrayContaining([
        { type: "memory_id", value: "memory-1" },
        { type: "path", value: "src/storage/mutation-plan.ts" }
      ])
    );
    expect(lexical.calls[0]?.lexicalQuery).toContain('"d1"');
    expect(semantic.calls[0]?.query).toBe("memory-1 src/storage/mutation-plan.ts D1");
    expect(validationCalls[0]).toMatchObject({
      projectId: "project-1",
      principalId: "principal-1",
      snapshotVersion: 7,
      filters: { projectId: "project-1", statuses: ["active"] }
    });
    expect(validationCalls[0]?.candidates).toHaveLength(3);
    expect(reranker.calls[0]?.candidates.length).toBeLessThanOrEqual(20);
  });

  it("abstains when authoritative current heads have no evidence citations", async () => {
    const recall = new FakeRecall(["memory-1"], "semantic");
    const pipeline = new SearchPipeline({
      lexical: recall,
      semantic: recall,
      headValidator: {
        async validate() {
          return [validated("memory-1", 1, [])];
        }
      },
      reranker: new FakeReranker()
    });

    const result = await pipeline.search({
      projectId: "project-1",
      principalId: "principal-1",
      snapshotVersion: 1,
      query: "authoritative database",
      indexGeneration: generation
    });

    expect(result).toMatchObject({
      abstained: true,
      abstentionReason: "NO_EVIDENCE_BACKED_MATCH",
      memories: [],
      contextPack: ""
    });
  });

  it("abstains when the reranker reports insufficient relevance", async () => {
    const recall = new FakeRecall(["memory-1"], "semantic");
    const pipeline = new SearchPipeline({
      semantic: recall,
      headValidator: {
        async validate() {
          return [validated("memory-1", 1)];
        }
      },
      reranker: {
        async rerank(input) {
          return input.candidates.map((candidate) => ({ candidate, relevance: 0.2 }));
        }
      }
    });

    const result = await pipeline.search({
      projectId: "project-1",
      principalId: "principal-1",
      snapshotVersion: 1,
      query: "unrelated premise",
      indexGeneration: generation,
      minimumRelevance: 0.5
    });

    expect(result.abstentionReason).toBe("LOW_RELEVANCE");
    expect(result.memories).toEqual([]);
  });

  it("rejects invalid authority context before recall", async () => {
    const recall = new FakeRecall([], "semantic");
    const pipeline = new SearchPipeline({
      semantic: recall,
      headValidator: { async validate() { return []; } },
      reranker: new FakeReranker()
    });

    await expect(
      pipeline.search({
        projectId: "project-1",
        principalId: "",
        snapshotVersion: -1,
        query: "anything",
        indexGeneration: generation
      })
    ).rejects.toThrow("principalId");
    expect(recall.calls).toEqual([]);
  });

  it("rejects validator injection and enforces the context token budget", async () => {
    const recall = new FakeRecall(["memory-1"], "semantic");
    const pipeline = new SearchPipeline({
      semantic: recall,
      headValidator: {
        async validate() {
          return [
            { ...validated("memory-injected", 100), content: "Injected." },
            { ...validated("memory-1", 1), content: "x".repeat(100) }
          ];
        }
      },
      reranker: new FakeReranker()
    });

    const result = await pipeline.search({
      projectId: "project-1",
      principalId: "principal-1",
      snapshotVersion: 1,
      query: "anything",
      indexGeneration: generation,
      maximumContextTokens: 2
    });

    expect(result).toMatchObject({
      abstained: true,
      abstentionReason: "CONTEXT_BUDGET_EXCEEDED",
      memories: []
    });
  });

  it("conservatively budgets CJK and emoji context", async () => {
    const recall = new FakeRecall(["memory-1"], "semantic");
    const pipeline = new SearchPipeline({
      semantic: recall,
      headValidator: {
        async validate() {
          return [{ ...validated("memory-1", 1), content: "中文项目记忆🧠" }];
        }
      },
      reranker: new FakeReranker()
    });

    await expect(
      pipeline.search({
        projectId: "project-1",
        principalId: "principal-1",
        snapshotVersion: 1,
        query: "项目记忆",
        indexGeneration: generation,
        maximumContextTokens: 10
      })
    ).resolves.toMatchObject({
      abstained: true,
      abstentionReason: "CONTEXT_BUDGET_EXCEEDED",
      memories: []
    });
  });

  it("distinguishes no recall from no authoritative current-head match", async () => {
    const empty = new FakeRecall([], "semantic");
    const noRecall = new SearchPipeline({
      semantic: empty,
      headValidator: { async validate() { return []; } },
      reranker: new FakeReranker()
    });
    await expect(
      noRecall.search({
        projectId: "project-1",
        principalId: "principal-1",
        snapshotVersion: 1,
        query: "nothing",
        indexGeneration: generation
      })
    ).resolves.toMatchObject({ abstentionReason: "NO_RECALL" });

    const hit = new FakeRecall(["memory-1"], "semantic");
    const noHead = new SearchPipeline({
      semantic: hit,
      headValidator: { async validate() { return []; } },
      reranker: new FakeReranker()
    });
    await expect(
      noHead.search({
        projectId: "project-1",
        principalId: "principal-1",
        snapshotVersion: 1,
        query: "stale",
        indexGeneration: generation
      })
    ).resolves.toMatchObject({ abstentionReason: "NO_CURRENT_HEAD_MATCH" });
  });

  it("deduplicates reranker output and validates result controls", async () => {
    const recall = new FakeRecall(["memory-1"], "semantic");
    const pipeline = new SearchPipeline({
      semantic: recall,
      headValidator: { async validate() { return [validated("memory-1", 1)]; } },
      reranker: {
        async rerank(input) {
          const first = input.candidates[0];
          return first === undefined
            ? []
            : [
                { candidate: { ...first }, relevance: 0.7 },
                { candidate: first, relevance: 0.9 }
              ];
        }
      }
    });
    const base = {
      projectId: "project-1",
      principalId: "principal-1",
      snapshotVersion: 1,
      query: "memory",
      indexGeneration: generation
    };

    await expect(pipeline.search(base)).resolves.toMatchObject({
      abstained: false,
      memories: [{ memoryId: "memory-1", relevance: 0.9 }]
    });
    expect((await pipeline.search(base)).memories[0]).not.toHaveProperty("embedding");
    const callsBeforeInvalidInput = recall.calls.length;
    await expect(pipeline.search({ ...base, limit: 0 })).rejects.toThrow("limit");
    await expect(pipeline.search({ ...base, maximumContextTokens: 0 })).rejects.toThrow(
      "maximumContextTokens"
    );
    await expect(pipeline.search({ ...base, minimumRelevance: 2 })).rejects.toThrow(
      "minimumRelevance"
    );
    expect(recall.calls).toHaveLength(callsBeforeInvalidInput);
  });
});
