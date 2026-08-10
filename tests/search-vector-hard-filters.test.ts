import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { QwenVectorRecallProvider } from "../src/search/cloudflare";
import { planHardFilters } from "../src/search/planning";
import { asIndexGeneration } from "../src/search/ranking";
import type { RecallInput } from "../src/search/types";

const generation = asIndexGeneration("generation-blue");
const validAt = "2026-07-29T12:00:00.000Z";
const validAtEpochMs = Date.parse(validAt);
const textEncoder = new TextEncoder();

type Metadata = Record<string, string | number>;

interface ProjectionTuple {
  generation_id: string;
  project_id: string;
  memory_id: string;
  revision_id: string;
  chunk_id: string;
}

interface VectorRecord {
  id: string;
  score: number;
  namespace: string;
  metadata: Metadata;
}

function recallInput(overrides: Partial<RecallInput> = {}): RecallInput {
  return {
    query: "Evidence-backed repository convention",
    lexicalQuery: null,
    exactReferences: [],
    filters: planHardFilters({
      projectId: "project-1",
      authorizedRepositoryIds: [],
      statuses: ["active"],
      kinds: ["fact"],
      memoryClasses: ["semantic"],
      scope: { type: "project", ids: ["project-1"] },
      validAt,
      indexGeneration: generation
    }),
    limit: 20,
    ...overrides
  };
}

function embeddingAi() {
  return {
    run: vi.fn(async () => ({
      data: [Array.from({ length: 1_024 }, () => 0.25)],
      shape: [1, 1_024]
    }))
  } as unknown as Ai;
}

function projectionDatabase(rows: readonly ProjectionTuple[]): D1Database {
  return {
    prepare() {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async all() {
          return {
            results: rows.filter(
              (row) =>
                bindings.includes(row.memory_id) &&
                bindings.includes(row.revision_id) &&
                bindings.includes(row.chunk_id)
            ),
            success: true,
            meta: {}
          };
        }
      };
    }
  } as unknown as D1Database;
}

function projectionTuple(memoryId: string): ProjectionTuple {
  return {
    generation_id: generation,
    project_id: "project-1",
    memory_id: memoryId,
    revision_id: `revision-${memoryId}`,
    chunk_id: `chunk-${memoryId}`
  };
}

function vectorRecord(
  memoryId: string,
  metadata: Partial<Metadata> = {},
  score = 0.9
): VectorRecord {
  return {
    id: `vector-${memoryId}`,
    score,
    namespace: "project-1",
    metadata: {
      project_id: "project-1",
      memory_id: memoryId,
      revision_id: `revision-${memoryId}`,
      chunk_id: `chunk-${memoryId}`,
      model_generation: generation,
      status: "active",
      repository_partition: "*",
      kind: "fact",
      memory_class: "semantic",
      scope_key: scopeKey("project", "project-1"),
      valid_from_epoch_ms: Number.MIN_SAFE_INTEGER,
      valid_until_epoch_ms: Number.MAX_SAFE_INTEGER,
      ...metadata
    }
  };
}

function scopeKey(scope: string, scopeId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["edgemneme.vector.scope", scope, scopeId]))
    .digest("hex");
}

function filterValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (isRecord(value) && Array.isArray(value.$in)) {
    if (!value.$in.every((item) => typeof item === "string")) {
      throw new TypeError("The metadata $in filter must contain only strings.");
    }
    return [...value.$in];
  }
  throw new TypeError("The metadata filter must be a string or $in expression.");
}

function matchesFilter(metadata: Metadata, filter: unknown): boolean {
  if (!isRecord(filter)) {
    throw new TypeError("The Vectorize filter must be an object.");
  }
  return Object.entries(filter).every(([field, condition]) => {
    const value = metadata[field];
    if (typeof condition === "string" || typeof condition === "number") {
      return value === condition;
    }
    if (!isRecord(condition)) {
      return false;
    }
    if (Array.isArray(condition.$in)) {
      return condition.$in.includes(value);
    }
    if (typeof value !== "number") {
      return false;
    }
    return (
      (condition.$lte === undefined ||
        (typeof condition.$lte === "number" && value <= condition.$lte)) &&
      (condition.$gt === undefined ||
        (typeof condition.$gt === "number" && value > condition.$gt))
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterByteLength(filter: unknown): number {
  return textEncoder.encode(JSON.stringify(filter)).byteLength;
}

function expectCompleteHardFilter(
  filter: unknown,
  expected: {
    kinds: readonly string[];
    memoryClasses: readonly string[];
    scopeKeys: readonly string[];
  }
): asserts filter is Record<string, unknown> {
  expect(filter).toEqual(
    expect.objectContaining({
      model_generation: generation,
      status: expect.anything(),
      repository_partition: expect.anything(),
      kind: expect.anything(),
      memory_class: expect.anything(),
      scope_key: expect.anything(),
      valid_from_epoch_ms: { $lte: validAtEpochMs },
      valid_until_epoch_ms: { $gt: validAtEpochMs }
    })
  );
  if (!isRecord(filter)) {
    throw new TypeError("The Vectorize filter must be an object.");
  }
  expect(filterValues(filter.kind).sort()).toEqual([...expected.kinds].sort());
  expect(filterValues(filter.memory_class).sort()).toEqual(
    [...expected.memoryClasses].sort()
  );
  expect(expected.scopeKeys).toEqual(
    expect.arrayContaining(filterValues(filter.scope_key))
  );
}

describe("semantic Vectorize hard filters", () => {
  it("hashes the canonical scope tuple and applies all eight indexes before top-K", async () => {
    const longUnicodeScopeId = "界".repeat(2_048);
    const repositoryScopeKey = scopeKey("repository", longUnicodeScopeId);
    const worktreeScopeKey = scopeKey("worktree", longUnicodeScopeId);
    expect(repositoryScopeKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(worktreeScopeKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(repositoryScopeKey).not.toBe(worktreeScopeKey);

    const vectorCalls: VectorizeQueryOptions[] = [];
    const vectors = {
      async query(_vector: number[], options: VectorizeQueryOptions) {
        vectorCalls.push(options);
        return { count: 0, matches: [] };
      }
    } as unknown as VectorizeIndex;
    const provider = new QwenVectorRecallProvider(
      embeddingAi(),
      vectors,
      projectionDatabase([])
    );
    const filters = {
      authorizedRepositoryIds: [],
      statuses: ["contested", "active"] as const,
      kinds: ["fact", "decision"] as const,
      memoryClasses: ["semantic", "procedural"] as const,
      validAt,
      indexGeneration: generation
    };

    await provider.recall(
      recallInput({
        filters: planHardFilters({
          projectId: "project-1",
          ...filters,
          scope: { type: "repository", ids: [longUnicodeScopeId] }
        })
      })
    );
    await provider.recall(
      recallInput({
        filters: planHardFilters({
          projectId: "project-1",
          ...filters,
          scope: { type: "worktree", ids: [longUnicodeScopeId] }
        })
      })
    );

    expect(vectorCalls).toHaveLength(2);
    expectCompleteHardFilter(vectorCalls[0]?.filter, {
      kinds: ["decision", "fact"],
      memoryClasses: ["procedural", "semantic"],
      scopeKeys: [repositoryScopeKey]
    });
    expectCompleteHardFilter(vectorCalls[1]?.filter, {
      kinds: ["decision", "fact"],
      memoryClasses: ["procedural", "semantic"],
      scopeKeys: [worktreeScopeKey]
    });
    expect(vectorCalls.map((call) => call.topK)).toEqual([20, 20]);
  });

  it("uses null sentinels with start-inclusive and end-exclusive validity", async () => {
    const records = [
      vectorRecord("unbounded"),
      vectorRecord("starts-at-boundary", {
        valid_from_epoch_ms: validAtEpochMs
      }),
      vectorRecord("starts-after-boundary", {
        valid_from_epoch_ms: validAtEpochMs + 1
      }),
      vectorRecord("ends-at-boundary", {
        valid_until_epoch_ms: validAtEpochMs
      }),
      vectorRecord("ends-after-boundary", {
        valid_until_epoch_ms: validAtEpochMs + 1
      })
    ];
    expect(records[0]?.metadata.valid_from_epoch_ms).toBe(Number.MIN_SAFE_INTEGER);
    expect(records[0]?.metadata.valid_until_epoch_ms).toBe(Number.MAX_SAFE_INTEGER);

    const vectorCalls: VectorizeQueryOptions[] = [];
    const vectors = {
      async query(_vector: number[], options: VectorizeQueryOptions) {
        vectorCalls.push(options);
        const matches = records.filter((record) =>
          matchesFilter(record.metadata, options.filter)
        );
        return { count: matches.length, matches };
      }
    } as unknown as VectorizeIndex;
    const provider = new QwenVectorRecallProvider(
      embeddingAi(),
      vectors,
      projectionDatabase(records.map((record) => projectionTuple(record.metadata.memory_id as string)))
    );

    const hits = await provider.recall(recallInput());

    expect(vectorCalls).toHaveLength(1);
    expectCompleteHardFilter(vectorCalls[0]?.filter, {
      kinds: ["fact"],
      memoryClasses: ["semantic"],
      scopeKeys: [scopeKey("project", "project-1")]
    });
    expect(hits.map((hit) => hit.memoryId).sort()).toEqual([
      "ends-after-boundary",
      "starts-at-boundary",
      "unbounded"
    ]);
  });

  it("batches repository and scope pairs below 2048 bytes without losing late hits", async () => {
    const repositoryIds = Array.from(
      { length: 50 },
      (_, index) => `repo-${String(index).padStart(2, "0")}-${"r".repeat(54)}`
    ).reverse();
    const sortedRepositoryIds = [...repositoryIds].sort();
    const expectedScopeKeys = sortedRepositoryIds.map((repositoryId) =>
      scopeKey("repository", repositoryId)
    );
    const targetRepositoryId = sortedRepositoryIds.at(-1)!;
    const targetScopeKey = scopeKey("repository", targetRepositoryId);
    const target = vectorRecord(
      "late-batch",
      {
        repository_partition: targetRepositoryId,
        scope_key: targetScopeKey
      },
      0.99
    );
    const vectorCalls: VectorizeQueryOptions[] = [];
    const ai = embeddingAi() as Ai & { run: ReturnType<typeof vi.fn> };
    const vectors = {
      async query(_vector: number[], options: VectorizeQueryOptions) {
        vectorCalls.push(options);
        const matches = matchesFilter(target.metadata, options.filter) ? [target] : [];
        return { count: matches.length, matches };
      }
    } as unknown as VectorizeIndex;
    const provider = new QwenVectorRecallProvider(
      ai,
      vectors,
      projectionDatabase([projectionTuple("late-batch")])
    );

    const hits = await provider.recall(
      recallInput({
        filters: planHardFilters({
          projectId: "project-1",
          authorizedRepositoryIds: repositoryIds,
          statuses: [
            "active",
            "archived",
            "contested",
            "invalidated",
            "superseded"
          ],
          kinds: [
            "decision",
            "fact",
            "convention",
            "procedure",
            "learning",
            "incident",
            "reference",
            "feedback"
          ],
          memoryClasses: ["semantic", "procedural", "episodic"],
          scope: { type: "repository", ids: repositoryIds },
          validAt,
          indexGeneration: generation
        }),
        limit: 5
      })
    );

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(vectorCalls.length).toBeGreaterThan(2);
    const observedPairs = new Set<string>();
    for (const call of vectorCalls) {
      expect(filterByteLength(call.filter)).toBeLessThan(2_048);
      expectCompleteHardFilter(call.filter, {
        kinds: [
          "decision",
          "fact",
          "convention",
          "procedure",
          "learning",
          "incident",
          "reference",
          "feedback"
        ],
        memoryClasses: ["semantic", "procedural", "episodic"],
        scopeKeys: expectedScopeKeys
      });
      for (const repositoryId of filterValues(call.filter.repository_partition)) {
        for (const currentScopeKey of filterValues(call.filter.scope_key)) {
          observedPairs.add(JSON.stringify([repositoryId, currentScopeKey]));
        }
      }
    }
    const expectedPairs = new Set(
      ["*", ...sortedRepositoryIds].flatMap((repositoryId) =>
        expectedScopeKeys.map((currentScopeKey) =>
          JSON.stringify([repositoryId, currentScopeKey])
        )
      )
    );
    expect([...observedPairs].sort()).toEqual([...expectedPairs].sort());
    expect(
      vectorCalls.findIndex((call) => matchesFilter(target.metadata, call.filter))
    ).toBeGreaterThan(0);
    expect(hits).toEqual([
      expect.objectContaining({
        memoryId: "late-batch",
        sourceScore: 0.99
      })
    ]);
  });
});
