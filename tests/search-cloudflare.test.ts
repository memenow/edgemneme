import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createCloudflareSearchPipeline,
  D1CurrentHeadValidator,
  QwenVectorRecallProvider,
  readActiveSearchGeneration,
  SearchDbExactRecallProvider,
  SearchDbLexicalRecallProvider,
  WorkersAiBgeReranker
} from "../src/search/cloudflare";
import { planHardFilters } from "../src/search/planning";
import { asIndexGeneration } from "../src/search/ranking";
import type {
  FusedRecallHit,
  RecallInput,
  ValidatedSearchCandidate
} from "../src/search/types";

const generation = asIndexGeneration("generation-blue");
const DEFAULT_VALID_AT_MS = Date.parse("2026-07-25T12:00:00.000Z");
const REPOSITORY_SCOPE_KEY = createHash("sha256")
  .update(JSON.stringify(["edgemneme.vector.scope", "repository", "repo-1"]))
  .digest("hex");

function semanticVectorMetadata(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    project_id: "project-1",
    memory_id: "memory-1",
    revision_id: "revision-1",
    chunk_id: "chunk-1",
    model_generation: "generation-blue",
    status: "active",
    repository_partition: "repo-1",
    kind: "fact",
    memory_class: "semantic",
    scope_key: REPOSITORY_SCOPE_KEY,
    valid_from_epoch_ms: Number.MIN_SAFE_INTEGER,
    valid_until_epoch_ms: Number.MAX_SAFE_INTEGER,
    ...overrides
  };
}

interface QueryRecord {
  sql: string;
  bindings: unknown[];
}

function fakeDatabase(
  rows: unknown[],
  records: QueryRecord[],
  options: { sessionModes?: string[] } = {}
): D1Database {
  const database = {
    prepare(sql: string) {
      const record = { sql, bindings: [] as unknown[] };
      records.push(record);
      return {
        bind(...bindings: unknown[]) {
          record.bindings = bindings;
          return this;
        },
        async all() {
          return {
            results:
              sql.includes("authorized_snapshot_version")
                ? [{ authorized_snapshot_version: record.bindings.at(-1) }]
                : rows,
            success: true,
            meta: {}
          };
        }
      };
    },
    async batch(statements: Array<{ all(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.all()));
    },
    withSession(mode: string) {
      options.sessionModes?.push(mode);
      return database;
    }
  };
  return database as unknown as D1Database;
}

function recallInput(overrides: Partial<RecallInput> = {}): RecallInput {
  return {
    query: "D1 authority",
    lexicalQuery: '"d1" AND "authority"',
    exactReferences: [{ type: "memory_id", value: "memory-1" }],
    filters: planHardFilters({
      projectId: "project-1",
      authorizedRepositoryIds: ["repo-1"],
      scope: { type: "repository", ids: ["repo-1"] },
      validAt: "2026-07-25T12:00:00.000Z",
      indexGeneration: generation
    }),
    limit: 20,
    ...overrides
  };
}

function fused(memoryId = "memory-1", revisionId = "revision-1"): FusedRecallHit {
  return {
    projectId: "project-1",
    memoryId,
    revisionId,
    chunkId: `chunk-${memoryId}`,
    indexGeneration: generation,
    retrievalScore: 0.5,
    channels: ["semantic"]
  };
}

function validated(memoryId: string): ValidatedSearchCandidate {
  return {
    projectId: "project-1",
    memoryId,
    revisionId: `revision-${memoryId}`,
    memoryVersion: 1,
    chunkId: `chunk-${memoryId}`,
    content: `Content for ${memoryId}`,
    contentSha256: `sha-${memoryId}`,
    kind: "fact",
    memoryClass: "semantic",
    scope: "project",
    scopeId: "project-1",
    status: "active",
    validFrom: null,
    validUntil: null,
    evidenceIds: [`evidence-${memoryId}`],
    retrievalScore: 0.5,
    indexGeneration: generation
  };
}

describe("Cloudflare search adapters", () => {
  it("reads and strictly validates the one active search generation", async () => {
    const records: QueryRecord[] = [];
    const database = fakeDatabase(
      [
        {
          generation_id: "generation-blue",
          embedding_model: "@cf/qwen/qwen3-embedding-0.6b",
          embedding_dimensions: 1024,
          distance_metric: "cosine",
          instruction_version: "query-schema-2026-07-25",
          chunk_schema_version: "chunk-schema-2026-07-25",
          reranker_model: "@cf/baai/bge-reranker-base",
          activated_at: "2026-07-25T00:00:00.000Z"
        }
      ],
      records
    );

    await expect(readActiveSearchGeneration(database)).resolves.toMatchObject({
      id: "generation-blue",
      embeddingDimensions: 1024,
      distanceMetric: "cosine"
    });
    expect(records[0]?.sql).toContain("status = 'active'");

    await expect(readActiveSearchGeneration(fakeDatabase([], []))).rejects.toThrow(
      "active search generation"
    );
    await expect(
      readActiveSearchGeneration(fakeDatabase([{ generation_id: "bad" }, { generation_id: "bad-2" }], []))
    ).rejects.toThrow("active search generation");
    await expect(
      readActiveSearchGeneration(
        fakeDatabase(
          [
            {
              generation_id: "generation-blue",
              embedding_model: "wrong-model",
              embedding_dimensions: 1024,
              distance_metric: "cosine",
              instruction_version: "query-schema-2026-07-25",
              chunk_schema_version: "chunk-schema-2026-07-25",
              reranker_model: "@cf/baai/bge-reranker-base",
              activated_at: "2026-07-25T00:00:00.000Z"
            }
          ],
          []
        )
      )
    ).rejects.toThrow("incompatible");
    await expect(
      readActiveSearchGeneration(
        fakeDatabase(
          [
            {
              generation_id: "g".repeat(65),
              embedding_model: "@cf/qwen/qwen3-embedding-0.6b",
              embedding_dimensions: 1024,
              distance_metric: "cosine",
              instruction_version: "query-schema-2026-07-25",
              chunk_schema_version: "chunk-schema-2026-07-25",
              reranker_model: "@cf/baai/bge-reranker-base",
              activated_at: "2026-07-25T00:00:00.000Z"
            }
          ],
          []
        )
      )
    ).rejects.toThrow("64 UTF-8 bytes");
  });

  it("does not query SEARCH_DB when an exact or lexical channel has no expression", async () => {
    const records: QueryRecord[] = [];
    const database = fakeDatabase([], records);

    await expect(
      new SearchDbExactRecallProvider(database).recall(
        recallInput({ exactReferences: [] })
      )
    ).resolves.toEqual([]);
    await expect(
      new SearchDbLexicalRecallProvider(database).recall(
        recallInput({ lexicalQuery: null })
      )
    ).resolves.toEqual([]);
    expect(records).toEqual([]);
  });

  it("binds exact references and hard filters without interpolating untrusted values", async () => {
    const records: QueryRecord[] = [];
    const provider = new SearchDbExactRecallProvider(
      fakeDatabase(
        [
          {
            generation_id: "generation-blue",
            project_id: "project-1",
            memory_id: "memory-1",
            revision_id: "revision-1",
            chunk_id: "chunk-1"
          }
        ],
        records
      )
    );
    const input = recallInput({
      exactReferences: [
        { type: "memory_id", value: "memory-1" },
        { type: "path", value: "src/search/pipeline.ts" },
        { type: "sha", value: "deadbeef" },
        { type: "symbol", value: "SearchPipeline.search" }
      ]
    });

    await expect(provider.recall(input)).resolves.toEqual([
      expect.objectContaining({
        projectId: "project-1",
        memoryId: "memory-1",
        channel: "exact",
        indexGeneration: generation
      })
    ]);
    expect(records[0]?.sql).not.toContain("src/search/pipeline.ts");
    expect(records[0]?.sql).toContain(
      "instr(char(10) || memory_fts.locator || char(10)"
    );
    expect(records[0]?.sql).toContain(
      "julianday(memory_fts.valid_from) <= julianday(?)"
    );
    expect(records[0]?.sql).toContain(
      "julianday(memory_fts.valid_until) > julianday(?)"
    );
    expect(records[0]?.bindings).toEqual(
      expect.arrayContaining([
        "generation-blue",
        "project-1",
        "repo-1",
        "memory-1",
        "src/search/pipeline.ts",
        "deadbeef",
        "SearchPipeline.search"
      ])
    );

    const escapedRecords: QueryRecord[] = [];
    await new SearchDbExactRecallProvider(fakeDatabase([], escapedRecords)).recall(
      recallInput({
        exactReferences: [{ type: "path", value: "src/my_file.ts" }],
        limit: 100
      })
    );
    expect(escapedRecords[0]?.bindings).toContain("src/my\\_file.ts");
    expect(escapedRecords[0]?.bindings.at(-1)).toBe(20);
  });

  it("executes FTS MATCH with projection filters and rejects cross-project rows", async () => {
    const records: QueryRecord[] = [];
    const provider = new SearchDbLexicalRecallProvider(
      fakeDatabase(
        [
          {
            generation_id: "generation-blue",
            project_id: "project-1",
            memory_id: "memory-1",
            revision_id: "revision-1",
            chunk_id: "chunk-1",
            source_score: -2.5
          }
        ],
        records
      )
    );

    await expect(provider.recall(recallInput())).resolves.toHaveLength(1);
    expect(records[0]?.sql).toContain("memory_fts MATCH ?");
    expect(records[0]?.sql).toContain("ORDER BY bm25(memory_fts)");
    expect(records[0]?.bindings).toContain('"d1" AND "authority"');

    await expect(
      provider.recall(recallInput({ lexicalQuery: "d1 OR authority" }))
    ).rejects.toThrow("normalized lexical query");

    const crossProject = new SearchDbLexicalRecallProvider(
      fakeDatabase(
        [
          {
            generation_id: "generation-blue",
            project_id: "project-2",
            memory_id: "memory-1",
            revision_id: "revision-1",
            chunk_id: "chunk-1",
            source_score: 0
          }
        ],
        []
      )
    );
    await expect(crossProject.recall(recallInput())).rejects.toThrow("projection row");
  });

  it("embeds with Qwen3 at 1024 dimensions and queries a project namespace", async () => {
    const aiCalls: Array<{ model: string; input: unknown }> = [];
    const vectorCalls: Array<{ vector: number[]; options: VectorizeQueryOptions }> = [];
    const ai = {
      async run(model: string, input: unknown) {
        aiCalls.push({ model, input });
        return { data: [Array.from({ length: 1024 }, () => 0.25)], shape: [1, 1024] };
      }
    } as unknown as Ai;
    const vectors = {
      async query(vector: number[], options: VectorizeQueryOptions) {
        vectorCalls.push({ vector, options });
        if (options.filter?.repository_partition === "*") {
          return { count: 0, matches: [] };
        }
        return {
          count: 1,
          matches: [
            {
              id: "vector-1",
              score: 0.9,
              namespace: "project-1",
              metadata: semanticVectorMetadata()
            }
          ]
        };
      }
    } as unknown as VectorizeIndex;

    const provider = new QwenVectorRecallProvider(
      ai,
      vectors,
      fakeDatabase(
        [
          {
            generation_id: "generation-blue",
            project_id: "project-1",
            memory_id: "memory-1",
            revision_id: "revision-1",
            chunk_id: "chunk-1"
          }
        ],
        []
      )
    );
    await expect(provider.recall(recallInput())).resolves.toEqual([
      expect.objectContaining({
        projectId: "project-1",
        memoryId: "memory-1",
        revisionId: "revision-1",
        chunkId: "chunk-1",
        channel: "semantic"
      })
    ]);
    expect(aiCalls).toEqual([
      {
        model: "@cf/qwen/qwen3-embedding-0.6b",
        input: {
          queries: ["D1 authority"],
          instruction: expect.any(String)
        }
      }
    ]);
    expect(vectorCalls).toEqual([
      {
        vector: expect.any(Array),
        options: {
          topK: 20,
          namespace: "project-1",
          returnValues: false,
          returnMetadata: "all",
          filter: {
            model_generation: "generation-blue",
            status: "active",
            valid_from_epoch_ms: { $lte: DEFAULT_VALID_AT_MS },
            valid_until_epoch_ms: { $gt: DEFAULT_VALID_AT_MS },
            scope_key: REPOSITORY_SCOPE_KEY,
            repository_partition: "*"
          }
        }
      },
      {
        vector: expect.any(Array),
        options: {
          topK: 20,
          namespace: "project-1",
          returnValues: false,
          returnMetadata: "all",
          filter: {
            model_generation: "generation-blue",
            status: "active",
            valid_from_epoch_ms: { $lte: DEFAULT_VALID_AT_MS },
            valid_until_epoch_ms: { $gt: DEFAULT_VALID_AT_MS },
            scope_key: REPOSITORY_SCOPE_KEY,
            repository_partition: "repo-1"
          }
        }
      }
    ]);
    expect(vectorCalls[0]?.vector).toHaveLength(1024);
  });

  it("applies explicit single and multiple statuses before semantic top-K selection", async () => {
    const vectorCalls: VectorizeQueryOptions[] = [];
    const ai = {
      async run() {
        return { data: [Array.from({ length: 1024 }, () => 0.25)], shape: [1, 1024] };
      }
    } as unknown as Ai;
    const vectors = {
      async query(_vector: number[], options: VectorizeQueryOptions) {
        vectorCalls.push(options);
        return { count: 0, matches: [] };
      }
    } as unknown as VectorizeIndex;
    const provider = new QwenVectorRecallProvider(
      ai,
      vectors,
      fakeDatabase([], [])
    );

    await provider.recall(
      recallInput({
        filters: planHardFilters({
          projectId: "project-1",
          statuses: ["contested"],
          validAt: "2026-07-25T12:00:00.000Z",
          indexGeneration: generation
        })
      })
    );
    await provider.recall(
      recallInput({
        filters: planHardFilters({
          projectId: "project-1",
          authorizedRepositoryIds: ["repo-2", "repo-1"],
          statuses: ["invalidated", "active"],
          validAt: "2026-07-25T12:00:00.000Z",
          indexGeneration: generation
        })
      })
    );
    await provider.recall(
      recallInput({
        filters: planHardFilters({
          projectId: "project-1",
          authorizedRepositoryIds: [],
          validAt: "2026-07-25T12:00:00.000Z",
          indexGeneration: generation
        })
      })
    );

    expect(vectorCalls.map((options) => options.filter)).toEqual([
      {
        model_generation: "generation-blue",
        status: "contested",
        valid_from_epoch_ms: { $lte: DEFAULT_VALID_AT_MS },
        valid_until_epoch_ms: { $gt: DEFAULT_VALID_AT_MS }
      },
      {
        model_generation: "generation-blue",
        status: { $in: ["active", "invalidated"] },
        valid_from_epoch_ms: { $lte: DEFAULT_VALID_AT_MS },
        valid_until_epoch_ms: { $gt: DEFAULT_VALID_AT_MS },
        repository_partition: "*"
      },
      {
        model_generation: "generation-blue",
        status: { $in: ["active", "invalidated"] },
        valid_from_epoch_ms: { $lte: DEFAULT_VALID_AT_MS },
        valid_until_epoch_ms: { $gt: DEFAULT_VALID_AT_MS },
        repository_partition: { $in: ["repo-1", "repo-2"] }
      },
      {
        model_generation: "generation-blue",
        status: "active",
        valid_from_epoch_ms: { $lte: DEFAULT_VALID_AT_MS },
        valid_until_epoch_ms: { $gt: DEFAULT_VALID_AT_MS },
        repository_partition: "*"
      }
    ]);
  });

  it("batches every authorized repository below the strict Vectorize filter limit", async () => {
    const statuses = [
      "active",
      "archived",
      "contested",
      "invalidated",
      "superseded"
    ] as const;
    const firstBatch = Array.from(
      { length: 26 },
      (_, index) => `a-${String(index).padStart(2, "0")}-${"x".repeat(59)}`
    );
    const equalityTriggerRepositoryId = `b-${"y".repeat(62)}`;
    const trailingRepositoryIds = Array.from(
      { length: 53 },
      (_, index) => `z-${String(index).padStart(2, "0")}-${"z".repeat(59)}`
    );
    const sortedRepositoryIds = [
      ...firstBatch,
      equalityTriggerRepositoryId,
      ...trailingRepositoryIds
    ];
    const repositoryIds = [...sortedRepositoryIds].reverse();
    const filterByteLength = (filter: unknown) =>
      new TextEncoder().encode(JSON.stringify(filter)).byteLength;
    const exactLimitCandidate = {
      model_generation: "generation-blue",
      status: { $in: [...statuses] },
      valid_from_epoch_ms: { $lte: DEFAULT_VALID_AT_MS },
      valid_until_epoch_ms: { $gt: DEFAULT_VALID_AT_MS },
      repository_partition: {
        $in: [...firstBatch, equalityTriggerRepositoryId]
      }
    };

    expect(filterByteLength(exactLimitCandidate)).toBe(2_048);
    expect(repositoryIds).toHaveLength(80);
    expect(new Set(repositoryIds).size).toBe(80);
    for (const repositoryId of repositoryIds) {
      expect(new TextEncoder().encode(repositoryId).byteLength).toBeLessThanOrEqual(64);
    }

    const vectorCalls: VectorizeQueryOptions[] = [];
    const ai = {
      run: vi.fn(async () => ({
        data: [Array.from({ length: 1024 }, () => 0.25)],
        shape: [1, 1024]
      }))
    } as unknown as Ai;
    const targetRepositoryId = sortedRepositoryIds.at(-1)!;
    const targetMatch = {
      id: "vector-late-batch",
      score: 0.99,
      namespace: "project-1",
      metadata: semanticVectorMetadata({
        memory_id: "memory-late-batch",
        revision_id: "revision-memory-late-batch",
        chunk_id: "chunk-memory-late-batch",
        repository_partition: targetRepositoryId
      })
    };
    const repositoryIdsFromFilter = (options: VectorizeQueryOptions): string[] => {
      const partition = options.filter?.repository_partition;
      if (typeof partition === "string") {
        return [partition];
      }
      if (
        typeof partition === "object" &&
        partition !== null &&
        "$in" in partition &&
        Array.isArray(partition.$in) &&
        partition.$in.every(
          (value): value is string => typeof value === "string"
        )
      ) {
        return partition.$in;
      }
      throw new Error("Unexpected repository partition filter.");
    };
    const vectors = {
      async query(_vector: number[], options: VectorizeQueryOptions) {
        vectorCalls.push(options);
        if (repositoryIdsFromFilter(options).includes(targetRepositoryId)) {
          return { count: 1, matches: [targetMatch] };
        }
        return { count: 0, matches: [] };
      }
    } as unknown as VectorizeIndex;
    const provider = new QwenVectorRecallProvider(
      ai,
      vectors,
      fakeDatabase(
        ["memory-late-batch"].map((memoryId) => ({
          generation_id: "generation-blue",
          project_id: "project-1",
          memory_id: memoryId,
          revision_id: `revision-${memoryId}`,
          chunk_id: `chunk-${memoryId}`
        })),
        []
      )
    );

    const hits = await provider.recall(
      recallInput({
        filters: planHardFilters({
          projectId: "project-1",
          authorizedRepositoryIds: repositoryIds,
          statuses,
          validAt: "2026-07-25T12:00:00.000Z",
          indexGeneration: generation
        }),
        limit: 5
      })
    );

    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(vectorCalls.length).toBeGreaterThan(2);
    const recalledRepositoryIds = vectorCalls
      .slice(1)
      .flatMap(repositoryIdsFromFilter);
    expect(recalledRepositoryIds).toEqual(sortedRepositoryIds);
    expect(new Set(recalledRepositoryIds).size).toBe(80);
    expect(vectorCalls[1]?.filter?.repository_partition).toEqual({
      $in: firstBatch
    });
    expect(
      vectorCalls.findIndex((options) =>
        repositoryIdsFromFilter(options).includes(targetRepositoryId)
      )
    ).toBeGreaterThan(2);
    for (const options of vectorCalls) {
      expect(options).toMatchObject({
        topK: 5,
        namespace: "project-1",
        returnValues: false,
        returnMetadata: "all",
        filter: {
          model_generation: "generation-blue",
          status: { $in: [...statuses] }
        }
      });
      expect(options.filter).not.toHaveProperty("project_id");
      expect(filterByteLength(options.filter)).toBeLessThan(2_048);
    }
    expect(hits).toEqual([
      expect.objectContaining({
        memoryId: "memory-late-batch",
        sourceScore: 0.99
      })
    ]);
  });

  it("fails closed on malformed embeddings and cross-boundary vector matches", async () => {
    const vectors = { query: vi.fn() } as unknown as VectorizeIndex;
    const malformedAi = {
      async run() {
        return { data: [[0.1, 0.2]], shape: [1, 2] };
      }
    } as unknown as Ai;
    await expect(
      new QwenVectorRecallProvider(malformedAi, vectors, fakeDatabase([], [])).recall(
        recallInput()
      )
    ).rejects.toThrow("1024");
    expect(vectors.query).not.toHaveBeenCalled();

    const validAi = {
      async run() {
        return { data: [Array.from({ length: 1024 }, () => 0.1)], shape: [1, 1024] };
      }
    } as unknown as Ai;
    const crossNamespace = {
      async query(_vector: number[], options: VectorizeQueryOptions) {
        if (options.filter?.repository_partition === "*") {
          return { count: 0, matches: [] };
        }
        return {
          count: 1,
          matches: [
            {
              id: "vector-1",
              score: 0.8,
              namespace: "project-2",
              metadata: {
                project_id: "project-1",
                memory_id: "memory-1",
                revision_id: "revision-1",
                chunk_id: "chunk-1",
                model_generation: "generation-blue"
              }
            }
          ]
        };
      }
    } as unknown as VectorizeIndex;
    await expect(
      new QwenVectorRecallProvider(validAi, crossNamespace, fakeDatabase([], [])).recall(
        recallInput()
      )
    ).rejects.toThrow("namespace");

    const unregisteredTuple = {
      async query(_vector: number[], options: VectorizeQueryOptions) {
        if (options.filter?.repository_partition === "*") {
          return { count: 0, matches: [] };
        }
        return {
          count: 1,
          matches: [
            {
              id: "vector-1",
              score: 0.8,
              namespace: "project-1",
              metadata: semanticVectorMetadata({
                chunk_id: "unregistered-chunk"
              })
            }
          ]
        };
      }
    } as unknown as VectorizeIndex;
    await expect(
      new QwenVectorRecallProvider(validAi, unregisteredTuple, fakeDatabase([], [])).recall(
        recallInput()
      )
    ).resolves.toEqual([]);

    const partiallyPublished = {
      async query(_vector: number[], options: VectorizeQueryOptions) {
        if (options.filter?.repository_partition === "*") {
          return { count: 0, matches: [] };
        }
        return {
          count: 2,
          matches: [
            {
              id: "vector-published",
              score: 0.9,
              namespace: "project-1",
              metadata: semanticVectorMetadata({ chunk_id: "chunk-published" })
            },
            {
              id: "vector-unpublished",
              score: 0.8,
              namespace: "project-1",
              metadata: semanticVectorMetadata({ chunk_id: "chunk-unpublished" })
            }
          ]
        };
      }
    } as unknown as VectorizeIndex;
    await expect(
      new QwenVectorRecallProvider(
        validAi,
        partiallyPublished,
        fakeDatabase(
          [
            {
              generation_id: "generation-blue",
              project_id: "project-1",
              memory_id: "memory-1",
              revision_id: "revision-1",
              chunk_id: "chunk-published"
            }
          ],
          []
        )
      ).recall(recallInput())
    ).resolves.toEqual([
      expect.objectContaining({ chunkId: "chunk-published", channel: "semantic" })
    ]);

    const crossGeneration = {
      async query() {
        return {
          count: 1,
          matches: [
            {
              id: "vector-cross-generation",
              score: 0.8,
              namespace: "project-1",
              metadata: {
                project_id: "project-1",
                memory_id: "memory-1",
                revision_id: "revision-1",
                chunk_id: "chunk-1",
                model_generation: "generation-green"
              }
            }
          ]
        };
      }
    } as unknown as VectorizeIndex;
    await expect(
      new QwenVectorRecallProvider(validAi, crossGeneration, fakeDatabase([], [])).recall(
        recallInput()
      )
    ).rejects.toThrow("project or generation boundary");

    const crossRepository = {
      async query() {
        return {
          count: 1,
          matches: [
            {
              id: "vector-cross-repository",
              score: 0.8,
              namespace: "project-1",
              metadata: {
                project_id: "project-1",
                memory_id: "memory-1",
                revision_id: "revision-1",
                chunk_id: "chunk-1",
                model_generation: "generation-blue",
                repository_partition: "repo-2"
              }
            }
          ]
        };
      }
    } as unknown as VectorizeIndex;
    await expect(
      new QwenVectorRecallProvider(validAi, crossRepository, fakeDatabase([], [])).recall(
        recallInput()
      )
    ).rejects.toThrow("repository boundary");

    const zeroAi = {
      async run() {
        return { data: [Array.from({ length: 1024 }, () => 0)], shape: [1, 1024] };
      }
    } as unknown as Ai;
    await expect(
      new QwenVectorRecallProvider(zeroAi, vectors, fakeDatabase([], [])).recall(recallInput())
    ).rejects.toThrow("1024");

    const invalidShapeAi = {
      async run() {
        return { data: [Array.from({ length: 1024 }, () => 0.1)], shape: [1024] };
      }
    } as unknown as Ai;
    await expect(
      new QwenVectorRecallProvider(invalidShapeAi, vectors, fakeDatabase([], [])).recall(
        recallInput()
      )
    ).rejects.toThrow("shape");

    await expect(
      new QwenVectorRecallProvider(validAi, vectors, fakeDatabase([], [])).recall(
        recallInput({ query: "x".repeat(4_097) })
      )
    ).rejects.toThrow("model input limit");
  });

  it("validates ACL, snapshot, current revision, taxonomy, and evidence on first-primary", async () => {
    const records: QueryRecord[] = [];
    const sessionModes: string[] = [];
    const database = fakeDatabase(
      [
        {
          project_id: "project-1",
          memory_id: "memory-1",
          revision_id: "revision-1",
          memory_version: 3,
          content: "D1 is authoritative.",
          content_sha256: "content-sha",
          kind: "fact",
          memory_class: "semantic",
          scope: "project",
          scope_id: "project-1",
          status: "active",
          valid_from: null,
          valid_until: null,
          evidence_ids: "evidence-2,evidence-1,evidence-2"
        }
      ],
      records,
      { sessionModes }
    );
    const validator = new D1CurrentHeadValidator(database);

    await expect(
      validator.validate({
        projectId: "project-1",
        principalId: "principal-1",
        snapshotVersion: 9,
        filters: recallInput().filters,
        candidates: [fused(), fused("memory-1", "revision-stale"), fused("memory-other")]
      })
    ).resolves.toEqual([
      expect.objectContaining({
        projectId: "project-1",
        memoryId: "memory-1",
        revisionId: "revision-1",
        chunkId: "chunk-memory-1",
        evidenceIds: ["evidence-1", "evidence-2"],
        retrievalScore: 0.5
      })
    ]);
    expect(sessionModes).toEqual(["first-primary"]);
    expect(records[0]?.sql).toContain("project_grants");
    expect(records[0]?.sql).toContain("memory_repository_contexts");
    expect(records[0]?.sql).toContain("project_grant_repository_contexts");
    expect(records[0]?.sql).toContain(
      "grant_row.scope_id = grant_row.project_id"
    );
    expect(records[0]?.sql).toContain(
      "request_memory_context.repository_id IN (?)"
    );
    expect(records[0]?.sql).toContain("current_revision_id");
    expect(records[0]?.sql).toContain(
      "julianday(v.valid_from) <= julianday(?)"
    );
    expect(records[0]?.sql).toContain(
      "julianday(v.valid_until) > julianday(?)"
    );
    expect(records[0]?.bindings).toEqual(
      expect.arrayContaining(["project-1", "principal-1", 9, "memory-1", "revision-1"])
    );

    await expect(
      validator.validate({
        projectId: "project-1",
        principalId: "principal-1",
        snapshotVersion: 9,
        filters: recallInput().filters,
        candidates: []
      })
    ).resolves.toEqual([]);
    await expect(
      validator.validate({
        projectId: "project-1",
        principalId: "principal-1",
        snapshotVersion: -1,
        filters: recallInput().filters,
        candidates: []
      })
    ).rejects.toThrow("snapshot version");
    await expect(
      validator.validate({
        projectId: "project-2",
        principalId: "principal-1",
        snapshotVersion: 9,
        filters: recallInput().filters,
        candidates: [fused()]
      })
    ).rejects.toThrow("project boundary");
  });

  it("fails closed when an authoritative row is malformed or was not recalled", async () => {
    const baseRow = {
      project_id: "project-1",
      memory_id: "memory-1",
      revision_id: "revision-1",
      memory_version: 1,
      content: "content",
      content_sha256: "sha",
      kind: "fact",
      memory_class: "semantic",
      scope: "project",
      scope_id: "project-1",
      status: "active",
      valid_from: null,
      valid_until: null,
      evidence_ids: null
    };
    const input = {
      projectId: "project-1",
      principalId: "principal-1",
      snapshotVersion: 1,
      filters: recallInput().filters,
      candidates: [fused()]
    };

    await expect(
      new D1CurrentHeadValidator(
        fakeDatabase([{ ...baseRow, revision_id: "unrequested" }], [])
      ).validate(input)
    ).rejects.toThrow("did not match");
    await expect(
      new D1CurrentHeadValidator(
        fakeDatabase([{ ...baseRow, kind: "unknown" }], [])
      ).validate(input)
    ).rejects.toThrow("memory kind");
    await expect(
      new D1CurrentHeadValidator(
        fakeDatabase([{ ...baseRow, memory_version: 0 }], [])
      ).validate(input)
    ).rejects.toThrow("memory version");
    await expect(
      new D1CurrentHeadValidator(
        fakeDatabase([{ ...baseRow, valid_until: "invalid" }], [])
      ).validate(input)
    ).rejects.toThrow("validity timestamp");
  });

  it("maps BGE context indexes to candidates and rejects malformed output", async () => {
    const calls: Array<{ model: string; input: unknown }> = [];
    const ai = {
      async run(model: string, input: unknown) {
        calls.push({ model, input });
        return { response: [{ id: 1, score: 2 }, { id: 0, score: -2 }] };
      }
    } as unknown as Ai;
    const candidates = [validated("memory-1"), validated("memory-2")];

    const reranked = await new WorkersAiBgeReranker(ai).rerank({
      query: "D1 authority",
      candidates
    });
    expect(reranked.map((item) => item.candidate.memoryId)).toEqual(["memory-2", "memory-1"]);
    expect(reranked[0]?.relevance).toBeCloseTo(0.880797, 5);
    expect(calls).toEqual([
      {
        model: "@cf/baai/bge-reranker-base",
        input: {
          query: "D1 authority",
          top_k: 2,
          contexts: [{ text: "Content for memory-1" }, { text: "Content for memory-2" }]
        }
      }
    ]);

    const invalid = {
      async run() {
        return { response: [{ id: 0, score: 1 }, { id: 0, score: 2 }] };
      }
    } as unknown as Ai;
    await expect(
      new WorkersAiBgeReranker(invalid).rerank({ query: "query", candidates })
    ).rejects.toThrow("reranker output");

    await expect(
      new WorkersAiBgeReranker(ai).rerank({ query: "query", candidates: [] })
    ).resolves.toEqual([]);
    await expect(
      new WorkersAiBgeReranker(ai).rerank({
        query: "query",
        candidates: Array.from({ length: 21 }, (_, index) => validated(`memory-${index}`))
      })
    ).rejects.toThrow("at most 20");
    const incomplete = {
      async run() {
        return { response: [] };
      }
    } as unknown as Ai;
    await expect(
      new WorkersAiBgeReranker(incomplete).rerank({ query: "query", candidates })
    ).rejects.toThrow("cover every candidate");
  });

  it("builds a SearchPipeline from Cloudflare bindings and the active generation", async () => {
    const searchDatabase = fakeDatabase(
      [
        {
          generation_id: "generation-blue",
          embedding_model: "@cf/qwen/qwen3-embedding-0.6b",
          embedding_dimensions: 1024,
          distance_metric: "cosine",
          instruction_version: "query-schema-2026-07-25",
          chunk_schema_version: "chunk-schema-2026-07-25",
          reranker_model: "@cf/baai/bge-reranker-base",
          activated_at: "2026-07-25T00:00:00.000Z"
        }
      ],
      []
    );
    const runtime = await createCloudflareSearchPipeline({
      searchDatabase,
      memoryDatabase: fakeDatabase([], []),
      vectors: {} as VectorizeIndex,
      ai: {} as Ai
    });

    expect(runtime.generation.id).toBe(generation);
    expect(runtime.pipeline).toBeDefined();
  });
});
