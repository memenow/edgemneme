import { describe, expect, it } from "vitest";
import { D1CurrentHeadValidator } from "../src/search/current-head";
import { SearchPipeline } from "../src/search/pipeline";
import { asIndexGeneration } from "../src/search/ranking";
import type {
  RecallInput,
  RecallProvider,
  RerankInput,
  Reranker
} from "../src/search/types";

const generation = asIndexGeneration("generation-blue");

class SingleChunkRecall implements RecallProvider {
  constructor(private readonly chunkId: string) {}

  async recall(input: RecallInput) {
    return [
      {
        projectId: input.filters.projectId,
        memoryId: "memory-1",
        revisionId: "revision-1",
        chunkId: this.chunkId,
        indexGeneration: input.filters.indexGeneration,
        channel: "semantic" as const
      }
    ];
  }
}

class RecordingReranker implements Reranker {
  readonly calls: RerankInput[] = [];

  async rerank(input: RerankInput) {
    this.calls.push(input);
    return input.candidates.map((candidate) => ({ candidate, relevance: 0.95 }));
  }
}

function authoritativeDatabase(content: string): D1Database {
  const database = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async all() {
          return {
            results: sql.includes("authorized_snapshot_version")
              ? [{ authorized_snapshot_version: bindings.at(-1) }]
              : [
                  {
                    project_id: "project-1",
                    memory_id: "memory-1",
                    revision_id: "revision-1",
                    memory_version: 1,
                    content,
                    content_sha256: "authoritative-full-revision-sha256",
                    kind: "fact",
                    memory_class: "semantic",
                    scope: "project",
                    scope_id: "project-1",
                    status: "active",
                    valid_from: null,
                    valid_until: null,
                    evidence_ids: "evidence-2,evidence-1"
                  }
                ],
            success: true,
            meta: {}
          };
        }
      };
    },
    async batch(statements: Array<{ all(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.all()));
    },
    withSession() {
      return database;
    }
  };
  return database as unknown as D1Database;
}

function pipelineFor(content: string, chunkId: string, reranker: Reranker) {
  return new SearchPipeline({
    semantic: new SingleChunkRecall(chunkId),
    headValidator: new D1CurrentHeadValidator(authoritativeDatabase(content)),
    reranker
  });
}

function search(pipeline: SearchPipeline) {
  return pipeline.search({
    projectId: "project-1",
    principalId: "principal-1",
    snapshotVersion: 7,
    query: "authoritative memory",
    indexGeneration: generation
  });
}

describe("authoritative search excerpts", () => {
  it("reranks and returns the recalled chunk from a near-16-KiB ASCII memory", async () => {
    const content = "a".repeat(15_900);
    const reranker = new RecordingReranker();
    const result = await search(pipelineFor(content, "chunk-2", reranker));

    expect(reranker.calls[0]?.candidates[0]?.chunkContent).toBe(
      content.slice(8_000, 12_000)
    );
    expect(result).toMatchObject({
      abstained: false,
      memories: [
        {
          memoryId: "memory-1",
          revisionId: "revision-1",
          chunkId: "chunk-2",
          evidenceIds: ["evidence-1", "evidence-2"],
          excerpt: content.slice(8_000, 12_000),
          excerptTruncated: false
        }
      ]
    });
  });

  it("accepts the exact 16-KiB formal-memory boundary through current-head validation", async () => {
    const content = "a".repeat(16 * 1024);
    const reranker = new RecordingReranker();

    const result = await search(pipelineFor(content, "chunk-0", reranker));

    expect(result).toMatchObject({ abstained: false });
    expect(result.memories[0]).toMatchObject({
      excerpt: content.slice(0, 4_000),
      excerptTruncated: false
    });
    expect(reranker.calls[0]?.candidates[0]?.chunkContent).toBe(content.slice(0, 4_000));
  });

  it.each([
    ["empty", "", "non-empty"],
    ["null-byte", "safe\0content", "without null bytes"],
    ["oversized", "a".repeat(16 * 1024 + 1), "16 KiB"]
  ])(
    "fails closed before reranking for %s authoritative content",
    async (_label, content, message) => {
      const reranker = new RecordingReranker();

      await expect(search(pipelineFor(content, "chunk-0", reranker))).rejects.toThrow(message);
      expect(reranker.calls).toEqual([]);
    }
  );

  it("truncates a recalled CJK chunk by code point within the default 2500-token budget", async () => {
    const content = "界".repeat(5_300);
    const reranker = new RecordingReranker();
    const result = await search(pipelineFor(content, "chunk-1", reranker));
    const memory = result.memories[0];

    expect(reranker.calls[0]?.candidates[0]?.chunkContent).toBe("界".repeat(1_333));
    expect(memory?.excerptTruncated).toBe(true);
    expect(memory?.excerpt.length).toBeGreaterThan(0);
    expect(memory?.excerpt.length).toBeLessThan(1_333);
    expect([...memory!.excerpt].every((codePoint) => codePoint === "界")).toBe(true);
    expect(conservativeTokens(result.contextPack)).toBeLessThanOrEqual(2_500);
    expect(result.contextPack).toContain("[memory:memory-1]");
    expect(result.contextPack).toContain("[revision:revision-1]");
    expect(result.contextPack).toContain("[chunk:chunk-1]");
    expect(result.contextPack).toContain("[evidence:evidence-1]");
    expect(result.contextPack).toContain("[evidence:evidence-2]");
  });

  it("fails closed before reranking when recall names a nonexistent chunk", async () => {
    const reranker = new RecordingReranker();

    await expect(
      search(pipelineFor("short authoritative content", "chunk-99", reranker))
    ).rejects.toThrow("does not exist in the authoritative memory content");
    expect(reranker.calls).toEqual([]);
  });

  it.each(["chunk-01", "chunk--1", "chunk-1.0", "chunk-"])(
    "fails closed before reranking for noncanonical chunk ID %s",
    async (chunkId) => {
      const reranker = new RecordingReranker();

      await expect(
        search(pipelineFor("short authoritative content", chunkId, reranker))
      ).rejects.toThrow("not a canonical memory chunk identifier");
      expect(reranker.calls).toEqual([]);
    }
  );

  it("returns ordinary short content as an untruncated authoritative excerpt", async () => {
    const content = "D1 is authoritative.";
    const reranker = new RecordingReranker();
    const result = await search(pipelineFor(content, "chunk-0", reranker));

    expect(result.memories[0]).toMatchObject({
      excerpt: content,
      excerptTruncated: false
    });
    expect(result.memories[0]).not.toHaveProperty("content");
    expect(result.memories[0]).not.toHaveProperty("chunkContent");
  });
});

function conservativeTokens(content: string): number {
  let estimatedTokens = 0;
  let asciiRunLength = 0;
  for (const codePoint of content) {
    const value = codePoint.codePointAt(0);
    if (value !== undefined && value <= 0x7f) {
      asciiRunLength += 1;
      continue;
    }
    estimatedTokens += Math.ceil(asciiRunLength / 4) + utf8ByteLength(value);
    asciiRunLength = 0;
  }
  return Math.max(1, estimatedTokens + Math.ceil(asciiRunLength / 4));
}

function utf8ByteLength(codePoint: number | undefined): number {
  if (codePoint === undefined) {
    return 0;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  if (codePoint <= 0xffff) {
    return 3;
  }
  return 4;
}
