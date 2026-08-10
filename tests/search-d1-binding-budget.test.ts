import { describe, expect, it } from "vitest";
import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_STATUSES
} from "../src/contracts/taxonomy";
import {
  D1CurrentHeadValidator,
  QwenVectorRecallProvider,
  SearchDbLexicalRecallProvider,
  SearchDbExactRecallProvider
} from "../src/search/cloudflare";
import { planHardFilters } from "../src/search/planning";
import { asIndexGeneration } from "../src/search/ranking";
import type {
  FusedRecallHit,
  HardFilterPlan,
  RecallInput
} from "../src/search/types";

const GENERATION = asIndexGeneration("generation-blue");
const SNAPSHOT_VERSION = 9;

interface QueryRecord {
  sql: string;
  bindings: unknown[];
}

function fakeDatabase(
  records: QueryRecord[],
  rowsForQuery: (record: QueryRecord) => unknown[]
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
          return { results: rowsForQuery(record), success: true, meta: {} };
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

function defaultFilters(): HardFilterPlan {
  return planHardFilters({
    projectId: "project-1",
    authorizedRepositoryIds: ["repo-1"],
    scope: { type: "repository", ids: ["repo-1"] },
    validAt: "2026-07-25T12:00:00.000Z",
    indexGeneration: GENERATION
  });
}

function maximumFilters(): HardFilterPlan {
  return planHardFilters({
    projectId: "project-1",
    authorizedRepositoryIds: Array.from(
      { length: 75 },
      (_, index) => `repository-${String(index).padStart(2, "0")}`
    ),
    statuses: MEMORY_STATUSES,
    kinds: MEMORY_KINDS,
    memoryClasses: MEMORY_CLASSES,
    scope: {
      type: "repository",
      ids: Array.from(
        { length: 50 },
        (_, index) => `scope-${String(index).padStart(2, "0")}`
      )
    },
    validAt: "2026-07-25T12:00:00.000Z",
    indexGeneration: GENERATION
  });
}

function recallInput(overrides: Partial<RecallInput> = {}): RecallInput {
  return {
    query: "memory_id:memory-1",
    lexicalQuery: null,
    exactReferences: [{ type: "memory_id", value: "memory-1" }],
    filters: defaultFilters(),
    limit: 20,
    ...overrides
  };
}

function fused(memoryId: string, revisionId: string): FusedRecallHit {
  return {
    projectId: "project-1",
    memoryId,
    revisionId,
    chunkId: "chunk-0",
    indexGeneration: GENERATION,
    retrievalScore: 0.5,
    channels: ["semantic"]
  };
}

function projectionRow(memoryId = "memory-1") {
  return {
    generation_id: "generation-blue",
    project_id: "project-1",
    memory_id: memoryId,
    revision_id: `revision-${memoryId}`,
    chunk_id: `chunk-${memoryId}`
  };
}

function currentHeadRowsFromBindings(bindings: readonly unknown[]) {
  const rows = [];
  for (let index = 0; index < bindings.length - 1; index += 1) {
    const memoryId = bindings[index];
    const revisionId = bindings[index + 1];
    if (
      typeof memoryId !== "string" ||
      !/^memory-\d{2}$/u.test(memoryId) ||
      typeof revisionId !== "string" ||
      !/^revision-\d{2}$/u.test(revisionId)
    ) {
      continue;
    }
    rows.push({
      project_id: "project-1",
      memory_id: memoryId,
      revision_id: revisionId,
      memory_version: 1,
      content: `Content for ${memoryId}`,
      content_sha256: `sha-${memoryId}`,
      kind: "fact",
      memory_class: "semantic",
      scope: "project",
      scope_id: "project-1",
      status: "active",
      valid_from: null,
      valid_until: null,
      evidence_ids: `evidence-${memoryId}`
    });
  }
  return rows;
}

describe("D1 search binding budgets", () => {
  it("batches exact-reference recall without changing deterministic results", async () => {
    const records: QueryRecord[] = [];
    const query = Array.from(
      { length: 40 },
      (_, index) => `src/search/module-${index}.ts`
    ).join(" ");
    const exactReferences = Array.from({ length: 40 }, (_, index) => ({
      type: "path" as const,
      value: `src/search/module-${index}.ts`
    }));
    const database = fakeDatabase(records, (record) =>
      record.bindings.includes("src/search/module-0.ts")
        ? [projectionRow("memory-02"), projectionRow("memory-04")]
        : [
            projectionRow("memory-01"),
            projectionRow("memory-02"),
            projectionRow("memory-03")
          ]
    );

    const results = await new SearchDbExactRecallProvider(database).recall(
      recallInput({ query, exactReferences, limit: 3 })
    );

    expect(query.length).toBeLessThanOrEqual(4_096);
    expect(records.length).toBeGreaterThan(1);
    expect(records.every((record) => record.bindings.length <= 100)).toBe(true);
    expect(records.every((record) => record.bindings.at(-1) === 3)).toBe(true);
    expect(results.map((result) => result.memoryId)).toEqual([
      "memory-01",
      "memory-02",
      "memory-03"
    ]);
  });

  it("compacts maximum legal exact-recall filters before batching", async () => {
    const records: QueryRecord[] = [];
    const database = fakeDatabase(records, () => []);

    await new SearchDbExactRecallProvider(database).recall(
      recallInput({ filters: maximumFilters() })
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.sql).toContain("json_each(?)");
    expect(records[0]?.bindings.length).toBeLessThanOrEqual(100);
  });

  it("compacts maximum legal lexical-recall filters below the D1 limit", async () => {
    const records: QueryRecord[] = [];
    const database = fakeDatabase(records, () => []);

    await new SearchDbLexicalRecallProvider(database).recall(
      recallInput({
        query: "D1 authority",
        lexicalQuery: '"d1" AND "authority"',
        exactReferences: [],
        filters: maximumFilters()
      })
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.sql).toContain("json_each(?)");
    expect(records[0]?.bindings.length).toBeLessThanOrEqual(100);
  });

  it("keeps semantic tuple validation below the D1 limit at maximum recall", async () => {
    const records: QueryRecord[] = [];
    const filters = maximumFilters();
    const vectorCalls: VectorizeQueryOptions[] = [];
    const matches = Array.from({ length: 20 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return {
        id: `vector-${suffix}`,
        score: 0.9,
        namespace: "project-1",
        metadata: {
          project_id: "project-1",
          memory_id: `memory-${suffix}`,
          revision_id: `revision-${suffix}`,
          chunk_id: `chunk-${suffix}`,
          model_generation: "generation-blue",
          status: "active",
          repository_partition: "*",
          kind: "fact",
          memory_class: "semantic",
          scope_key: "placeholder",
          valid_from_epoch_ms: Number.MIN_SAFE_INTEGER,
          valid_until_epoch_ms: Number.MAX_SAFE_INTEGER
        }
      };
    });
    const database = fakeDatabase(records, () =>
      matches.map((match) => ({
        generation_id: match.metadata.model_generation,
        project_id: match.metadata.project_id,
        memory_id: match.metadata.memory_id,
        revision_id: match.metadata.revision_id,
        chunk_id: match.metadata.chunk_id
      }))
    );
    const ai = {
      async run() {
        return { data: [Array.from({ length: 1_024 }, () => 0.25)] };
      }
    } as unknown as Ai;
    const vectors = {
      async query(_vector: number[], options: VectorizeQueryOptions) {
        vectorCalls.push(options);
        const filter = options.filter;
        if (filter === undefined) {
          throw new Error("Expected a semantic hard filter.");
        }
        const firstString = (value: unknown): string => {
          if (typeof value === "string") {
            return value;
          }
          if (
            typeof value === "object" &&
            value !== null &&
            "$in" in value &&
            Array.isArray(value.$in) &&
            typeof value.$in[0] === "string"
          ) {
            return value.$in[0];
          }
          throw new Error("Expected a nonempty Vectorize string filter.");
        };
        const filteredMatches = matches.map((match) => ({
          ...match,
          metadata: {
            ...match.metadata,
            model_generation: firstString(filter.model_generation),
            status: firstString(filter.status),
            repository_partition: firstString(filter.repository_partition),
            kind: firstString(filter.kind),
            memory_class: firstString(filter.memory_class),
            scope_key: firstString(filter.scope_key)
          }
        }));
        return { count: filteredMatches.length, matches: filteredMatches };
      }
    } as unknown as VectorizeIndex;

    const results = await new QwenVectorRecallProvider(
      ai,
      vectors,
      database
    ).recall(
      recallInput({
        query: "authoritative project memory",
        exactReferences: [],
        filters
      })
    );

    expect(vectorCalls.length).toBeGreaterThan(1);
    expect(vectorCalls[0]?.filter?.repository_partition).toBe("*");
    const recalledRepositoryIds = vectorCalls.slice(1).flatMap((options) => {
      const partition = options.filter?.repository_partition;
      if (typeof partition === "string") {
        return [partition];
      }
      if (
        typeof partition === "object" &&
        partition !== null &&
        "$in" in partition &&
        Array.isArray(partition.$in)
      ) {
        return partition.$in;
      }
      throw new Error("Unexpected repository partition filter.");
    });
    expect(new Set(recalledRepositoryIds.filter((value) => value !== "*"))).toEqual(
      new Set(filters.authorizedRepositoryIds)
    );
    const scopedRepositoryPairs = vectorCalls
      .filter((options) => options.filter?.repository_partition !== "*")
      .flatMap((options) => {
        const partition = options.filter?.repository_partition;
        const scope = options.filter?.scope_key;
        const repositories =
          typeof partition === "string"
            ? [partition]
            : typeof partition === "object" &&
                partition !== null &&
                "$in" in partition &&
                Array.isArray(partition.$in)
              ? partition.$in
              : [];
        const scopeKeys =
          typeof scope === "string"
            ? [scope]
            : typeof scope === "object" &&
                scope !== null &&
                "$in" in scope &&
                Array.isArray(scope.$in)
              ? scope.$in
              : [];
        return repositories.flatMap((repositoryId) =>
          scopeKeys.map((scopeKey) => `${repositoryId}\u0000${scopeKey}`)
        );
      });
    expect(new Set(scopedRepositoryPairs).size).toBe(75 * 50);
    expect(scopedRepositoryPairs).toHaveLength(75 * 50);
    for (const options of vectorCalls) {
      expect(
        new TextEncoder().encode(JSON.stringify(options.filter)).byteLength
      ).toBeLessThan(2_048);
    }
    expect(records).toHaveLength(1);
    expect(records[0]?.sql).toContain("json_each(?)");
    expect(records[0]?.bindings.length).toBeLessThanOrEqual(100);
    expect(results).toHaveLength(20);
  });

  it("batches current-head pairs and preserves deterministic global ordering", async () => {
    const records: QueryRecord[] = [];
    const candidates = Array.from({ length: 60 }, (_, index) => {
      const suffix = String(59 - index).padStart(2, "0");
      return fused(`memory-${suffix}`, `revision-${suffix}`);
    });
    const database = fakeDatabase(records, (record) => {
      if (record.sql.includes("authorized_snapshot_version")) {
        return [{ authorized_snapshot_version: SNAPSHOT_VERSION }];
      }
      return currentHeadRowsFromBindings(record.bindings).sort((left, right) =>
        left.memory_id.localeCompare(right.memory_id)
      );
    });

    const results = await new D1CurrentHeadValidator(database).validate({
      projectId: "project-1",
      principalId: "principal-1",
      snapshotVersion: SNAPSHOT_VERSION,
      filters: defaultFilters(),
      candidates
    });

    const candidateQueries = records.filter(
      (record) => !record.sql.includes("authorized_snapshot_version")
    );
    expect(candidateQueries.length).toBeGreaterThan(1);
    expect(records.every((record) => record.bindings.length <= 100)).toBe(true);
    expect(results.map((candidate) => candidate.memoryId)).toEqual(
      Array.from({ length: 60 }, (_, index) =>
        `memory-${String(index).padStart(2, "0")}`
      )
    );
  });

  it("compacts maximum legal current-head filters below the D1 limit", async () => {
    const records: QueryRecord[] = [];
    const database = fakeDatabase(records, (record) =>
      record.sql.includes("authorized_snapshot_version")
        ? [{ authorized_snapshot_version: SNAPSHOT_VERSION }]
        : []
    );

    await new D1CurrentHeadValidator(database).validate({
      projectId: "project-1",
      principalId: "principal-1",
      snapshotVersion: SNAPSHOT_VERSION,
      filters: maximumFilters(),
      candidates: [fused("memory-00", "revision-00")]
    });

    expect(records[0]?.sql).toContain("json_each(?)");
    expect(records.every((record) => record.bindings.length <= 100)).toBe(true);
  });

  it("fails closed when a batch cannot confirm the requested snapshot", async () => {
    const records: QueryRecord[] = [];
    const candidates = Array.from({ length: 60 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return fused(`memory-${suffix}`, `revision-${suffix}`);
    });
    const database = fakeDatabase(records, (record) =>
      record.sql.includes("authorized_snapshot_version")
        ? []
        : currentHeadRowsFromBindings(record.bindings)
    );

    await expect(
      new D1CurrentHeadValidator(database).validate({
        projectId: "project-1",
        principalId: "principal-1",
        snapshotVersion: SNAPSHOT_VERSION,
        filters: defaultFilters(),
        candidates
      })
    ).resolves.toEqual([]);
  });
});
