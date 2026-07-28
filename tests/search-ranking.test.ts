import { describe, expect, it } from "vitest";
import {
  asIndexGeneration,
  deduplicateCandidates,
  defineIndexGenerationMetadata,
  fuseReciprocalRanks,
  selectWithMmr
} from "../src/search/ranking";
import type { ValidatedSearchCandidate } from "../src/search/types";

function candidate(
  memoryId: string,
  score: number,
  content: string,
  embedding: number[]
): ValidatedSearchCandidate {
  return {
    projectId: "project-1",
    memoryId,
    revisionId: `revision-${memoryId}`,
    memoryVersion: 1,
    chunkId: `chunk-${memoryId}`,
    content,
    contentSha256: `sha-${memoryId}`,
    kind: "fact",
    memoryClass: "semantic",
    scope: "project",
    scopeId: "project-1",
    status: "active",
    validFrom: null,
    validUntil: null,
    evidenceIds: [`evidence-${memoryId}`],
    retrievalScore: score,
    embedding,
    indexGeneration: asIndexGeneration("generation-blue")
  };
}

describe("search ranking", () => {
  it("uses weighted RRF, rewards cross-channel agreement, and excludes stale generations", () => {
    const generation = asIndexGeneration("generation-blue");
    const fused = fuseReciprocalRanks(
      [
        {
          channel: "exact",
          weight: 4,
          hits: [
            {
              projectId: "project-1",
              memoryId: "memory-exact",
              revisionId: "revision-exact",
              chunkId: "chunk-exact",
              indexGeneration: generation
            }
          ]
        },
        {
          channel: "lexical",
          weight: 1,
          hits: [
            {
              projectId: "project-1",
              memoryId: "memory-shared",
              revisionId: "revision-shared",
              chunkId: "chunk-shared",
              indexGeneration: generation
            },
            {
              projectId: "project-1",
              memoryId: "memory-lexical",
              revisionId: "revision-lexical",
              chunkId: "chunk-lexical",
              indexGeneration: generation
            }
          ]
        },
        {
          channel: "semantic",
          weight: 1,
          hits: [
            {
              projectId: "project-1",
              memoryId: "memory-shared",
              revisionId: "revision-shared",
              chunkId: "chunk-shared",
              indexGeneration: generation
            },
            {
              projectId: "project-1",
              memoryId: "memory-stale",
              revisionId: "revision-stale",
              chunkId: "chunk-stale",
              indexGeneration: asIndexGeneration("generation-green")
            }
          ]
        }
      ],
      generation
    );

    expect(fused.map((hit) => hit.memoryId)).toEqual([
      "memory-exact",
      "memory-shared",
      "memory-lexical"
    ]);
    expect(fused[1]?.channels).toEqual(["lexical", "semantic"]);
  });

  it("rejects invalid fusion options and ignores duplicate hits within one channel", () => {
    const generation = asIndexGeneration("generation-blue");
    const hit = {
      projectId: "project-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      chunkId: "chunk-1",
      indexGeneration: generation
    };
    const fused = fuseReciprocalRanks(
      [{ channel: "lexical", weight: 1, hits: [hit, hit] }],
      generation,
      1
    );
    expect(fused[0]?.retrievalScore).toBe(0.5);
    expect(() => fuseReciprocalRanks([], generation, 0)).toThrow("rrfConstant");
    expect(() =>
      fuseReciprocalRanks([{ channel: "exact", weight: 0, hits: [] }], generation)
    ).toThrow("weights");
  });

  it("keeps the strongest current revision for each memory", () => {
    const older = candidate("memory-1", 0.8, "older", [1, 0]);
    const newer = {
      ...candidate("memory-1", 0.7, "newer", [1, 0]),
      memoryVersion: 2,
      revisionId: "revision-new"
    };
    const other = candidate("memory-2", 0.6, "other", [0, 1]);

    expect(deduplicateCandidates([older, newer, other]).map((item) => item.revisionId)).toEqual([
      "revision-new",
      "revision-memory-2"
    ]);
  });

  it("uses MMR to diversify otherwise similar high-scoring results", () => {
    const selected = selectWithMmr(
      [
        candidate("memory-a", 1, "D1 is authoritative", [1, 0]),
        candidate("memory-b", 0.99, "D1 remains authoritative", [0.99, 0.01]),
        candidate("memory-c", 0.8, "GitHub synchronization", [0, 1])
      ],
      { limit: 2, lambda: 0.6 }
    );

    expect(selected.map((item) => item.memoryId)).toEqual(["memory-a", "memory-c"]);
  });

  it("falls back to lexical diversity and handles zero vectors and invalid lambda", () => {
    const { embedding: _firstEmbedding, ...firstWithoutVector } = candidate(
      "memory-a",
      1,
      "D1 database source",
      []
    );
    const { embedding: _secondEmbedding, ...secondWithoutVector } = candidate(
      "memory-b",
      0.9,
      "D1 database copy",
      []
    );
    const { embedding: _thirdEmbedding, ...thirdWithoutVector } = candidate(
      "memory-c",
      0.8,
      "GitHub repository",
      []
    );
    const withoutVectors = [
      firstWithoutVector,
      secondWithoutVector,
      thirdWithoutVector
    ];
    expect(selectWithMmr(withoutVectors, { limit: 2, lambda: 0.6 }).map((item) => item.memoryId))
      .toEqual(["memory-a", "memory-c"]);
    expect(
      selectWithMmr(
        [
          candidate("memory-zero", 1, "", [0, 0]),
          candidate("memory-other", 0.5, "", [0, 0])
        ],
        { limit: 2 }
      )
    ).toHaveLength(2);
    expect(selectWithMmr(withoutVectors, { limit: 0 })).toEqual([]);
    expect(() => selectWithMmr(withoutVectors, { limit: 2, lambda: 2 })).toThrow("lambda");
  });

  it("treats generation IDs as opaque validated identifiers", () => {
    expect(asIndexGeneration("gen/2026-07-25:qwen-generation")).toBe(
      "gen/2026-07-25:qwen-generation"
    );
    expect(() => asIndexGeneration("")).toThrow("generation");
    expect(() => asIndexGeneration("   ")).toThrow("generation");
    expect(() => asIndexGeneration("x".repeat(257))).toThrow("generation");
  });

  it("validates generation metadata without deriving or rewriting its identifier", () => {
    expect(
      defineIndexGenerationMetadata({
        id: "operator-selected-generation",
        embeddingModel: "@cf/qwen/qwen3-embedding-0.6b",
        embeddingDimensions: 1024,
        distanceMetric: "cosine",
        instructionVersion: "retrieval-schema-2026-07-25",
        chunkSchemaVersion: "chunk-schema-2026-07-25",
        rerankerModel: "bge-generation-2026-07-25"
      })
    ).toMatchObject({ id: "operator-selected-generation", embeddingDimensions: 1024 });
    expect(() =>
      defineIndexGenerationMetadata({
        id: "generation",
        embeddingModel: "model",
        embeddingDimensions: 0,
        distanceMetric: "cosine",
        instructionVersion: "instruction",
        chunkSchemaVersion: "chunk",
        rerankerModel: "reranker"
      })
    ).toThrow("metadata");
  });
});
