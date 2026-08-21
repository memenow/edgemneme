import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  deleteMemorySearchProjection,
  deriveMemorySearchVectorId,
  publishMemorySearchProjection
} from "../src/search/indexing";

const SEARCH_MIGRATIONS = [
  "migrations/search/0001_initial.sql"
] as const;
const GENERATION_ID = "qwen3-embedding-0.6b-chunk-2026-07-25";

describe("search projection chunk ledger publication", () => {
  it("atomically replaces real SQLite FTS, ledger, head, and stale-vector receipt state", async () => {
    const search = createSearchDatabase();
    const memory = createMemoryDatabase();
    const vectors = new FakeVectors();
    const input = {
      memoryDb: new SqliteD1(memory) as unknown as D1Database,
      searchDb: new SqliteD1(search) as unknown as D1Database,
      vectors: vectors as unknown as VectorizeIndex,
      ai: {
        async run() {
          return { data: [Array.from({ length: 1_024 }, () => 0.25)] };
        }
      } as unknown as Ai,
      projectId: "project-1",
      memoryId: "memory-1",
      projectVersion: 7
    };

    await expect(publishMemorySearchProjection(input)).resolves.toBe(true);
    const firstVector = await deriveMemorySearchVectorId(
      GENERATION_ID,
      "project-1",
      "revision-1",
      "chunk-0"
    );
    expect(vectors.ids).toEqual(new Set([firstVector]));

    memory.exec(`
      INSERT INTO memory_versions
        (project_id, memory_id, revision_id, valid_from, valid_until, content)
      VALUES ('project-1', 'memory-1', 'revision-2', NULL, NULL, 'replacement');
      UPDATE memories SET current_revision_id = 'revision-2'
       WHERE project_id = 'project-1' AND memory_id = 'memory-1';
      UPDATE projects SET project_version = 8 WHERE project_id = 'project-1';
    `);
    await expect(
      publishMemorySearchProjection({ ...input, projectVersion: 8 })
    ).resolves.toBe(true);

    const secondVector = await deriveMemorySearchVectorId(
      GENERATION_ID,
      "project-1",
      "revision-2",
      "chunk-0"
    );
    expect(vectors.ids).toEqual(new Set([secondVector]));
    expect(
      search.prepare(
        `SELECT project_version, revision_id, chunk_count
         FROM memory_projection_heads`
      ).all()
    ).toEqual([{ project_version: 8, revision_id: "revision-2", chunk_count: 1 }]);
    expect(
      search.prepare(
        `SELECT ledger.revision_id, ledger.chunk_id, ledger.vector_id,
                fts.revision_id AS fts_revision_id, fts.chunk_id AS fts_chunk_id
         FROM memory_fts_chunk_ledger AS ledger
         JOIN memory_fts AS fts ON fts.rowid = ledger.fts_rowid`
      ).all()
    ).toEqual([
      {
        revision_id: "revision-2",
        chunk_id: "chunk-0",
        vector_id: secondVector,
        fts_revision_id: "revision-2",
        fts_chunk_id: "chunk-0"
      }
    ]);
    expect(count(search, "memory_search_vector_cleanup_receipts")).toBe(0);
    expect(search.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(search.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it("deletes the prior Search head when D1 advances to an invalidated tombstone", async () => {
    const search = createSearchDatabase();
    const memory = createMemoryDatabase();
    const vectors = new FakeVectors();
    let aiCalls = 0;
    const input = {
      memoryDb: new SqliteD1(memory) as unknown as D1Database,
      searchDb: new SqliteD1(search) as unknown as D1Database,
      vectors: vectors as unknown as VectorizeIndex,
      ai: {
        async run() {
          aiCalls += 1;
          return { data: [Array.from({ length: 1_024 }, () => 0.25)] };
        }
      } as unknown as Ai,
      projectId: "project-1",
      memoryId: "memory-1",
      projectVersion: 7
    };

    await expect(publishMemorySearchProjection(input)).resolves.toBe(true);
    expect(aiCalls).toBe(1);
    expect(count(search, "memory_projection_heads")).toBe(1);

    memory.exec(`
      INSERT INTO memory_versions
        (project_id, memory_id, revision_id, valid_from, valid_until, content)
      VALUES ('project-1', 'memory-1', 'revision-invalidated', NULL, NULL,
              'Memory invalidated.');
      UPDATE memories
       SET current_revision_id = 'revision-invalidated', status = 'invalidated'
       WHERE project_id = 'project-1' AND memory_id = 'memory-1';
      UPDATE projects SET project_version = 8 WHERE project_id = 'project-1';
    `);

    await expect(
      publishMemorySearchProjection({ ...input, projectVersion: 8 })
    ).resolves.toBe(true);
    expect(aiCalls).toBe(1);
    expect(vectors.ids).toEqual(new Set());
    expect(count(search, "memory_projection_heads")).toBe(0);
    expect(count(search, "memory_fts_chunk_ledger")).toBe(0);
    expect(count(search, "memory_fts")).toBe(0);
    expect(count(search, "memory_search_projection_deletions")).toBe(0);
  });
});

describe("search projection chunk ledger deletion", () => {
  it("keeps an exact deletion receipt across Vectorize failure and retries idempotently", async () => {
    const fixture = await createDeleteFixture();
    fixture.vectors.deleteFailuresRemaining = 1;

    await expect(deleteProjection(fixture, "project-1", 7)).rejects.toThrow(
      "synthetic Vectorize delete failure"
    );
    expect(count(fixture.database, "memory_search_projection_deletions")).toBe(1);
    expect(count(fixture.database, "memory_projection_heads")).toBe(1);
    expect(count(fixture.database, "memory_fts_chunk_ledger")).toBe(1);
    expect(count(fixture.database, "memory_fts")).toBe(1);

    await expect(deleteProjection(fixture, "project-1", 7)).resolves.toBe(true);
    expect(fixture.vectors.ids).toEqual(new Set());
    expect(count(fixture.database, "memory_search_projection_deletions")).toBe(0);
    expect(count(fixture.database, "memory_projection_heads")).toBe(0);
    expect(count(fixture.database, "memory_fts_chunk_ledger")).toBe(0);
    expect(count(fixture.database, "memory_fts")).toBe(0);

    await expect(deleteProjection(fixture, "project-1", 7)).resolves.toBe(true);
    expect(fixture.vectors.deleteCalls).toHaveLength(2);
  });

  it("drains pending stale-vector receipts before deleting the current head", async () => {
    const fixture = await createDeleteFixture();
    const staleVectorId = await deriveMemorySearchVectorId(
      GENERATION_ID,
      "project-1",
      "revision-old",
      "chunk-0"
    );
    fixture.vectors.ids.add(staleVectorId);
    fixture.database.prepare(
      `INSERT INTO memory_search_vector_cleanup_receipts
       (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
       VALUES (?, 'project-1', 'memory-1', 'revision-old', 'chunk-0', ?)`
    ).run(GENERATION_ID, staleVectorId);

    await expect(deleteProjection(fixture, "project-1", 7)).resolves.toBe(true);

    expect(fixture.vectors.ids).toEqual(new Set());
    expect(fixture.vectors.deleteCalls).toEqual([
      [staleVectorId],
      [
        await deriveMemorySearchVectorId(
          GENERATION_ID,
          "project-1",
          "revision-1",
          "chunk-0"
        )
      ]
    ]);
    expect(count(fixture.database, "memory_search_vector_cleanup_receipts")).toBe(0);
  });

  it("rejects a stale project-version CAS without touching any projection", async () => {
    const fixture = await createDeleteFixture();

    await expect(deleteProjection(fixture, "project-1", 6)).resolves.toBe(false);
    expect(fixture.vectors.deleteCalls).toEqual([]);
    expect(count(fixture.database, "memory_search_projection_deletions")).toBe(0);
    expect(count(fixture.database, "memory_projection_heads")).toBe(1);
    expect(count(fixture.database, "memory_fts_chunk_ledger")).toBe(1);
    expect(count(fixture.database, "memory_fts")).toBe(1);
  });

  it("keeps generation and project ownership isolated during exact deletion", async () => {
    const fixture = await createDeleteFixture();
    await seedProjection(fixture.database, fixture.vectors, {
      projectId: "project-2",
      memoryId: "memory-1",
      revisionId: "revision-1",
      projectVersion: 7,
      content: "project two"
    });
    const projectTwoVector = await deriveMemorySearchVectorId(
      GENERATION_ID,
      "project-2",
      "revision-1",
      "chunk-0"
    );

    await expect(deleteProjection(fixture, "project-1", 7)).resolves.toBe(true);

    expect(fixture.vectors.ids).toEqual(new Set([projectTwoVector]));
    expect(
      fixture.database.prepare(
        `SELECT project_id, memory_id, revision_id, chunk_count
         FROM memory_projection_heads`
      ).all()
    ).toEqual([
      {
        project_id: "project-2",
        memory_id: "memory-1",
        revision_id: "revision-1",
        chunk_count: 1
      }
    ]);
    expect(
      fixture.database.prepare(
        `SELECT project_id, memory_id, revision_id, chunk_id, vector_id
         FROM memory_fts_chunk_ledger`
      ).all()
    ).toEqual([
      {
        project_id: "project-2",
        memory_id: "memory-1",
        revision_id: "revision-1",
        chunk_id: "chunk-0",
        vector_id: projectTwoVector
      }
    ]);
  });

  it("deletes double-digit chunk IDs without relying on lexical chunk order", async () => {
    const database = createSearchDatabase();
    const vectors = new FakeVectors();
    await seedProjection(database, vectors, {
      projectId: "project-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      projectVersion: 7,
      content: "many chunks",
      chunkCount: 12
    });
    const fixture = { database, searchDb: new SqliteD1(database), vectors };

    await expect(deleteProjection(fixture, "project-1", 7)).resolves.toBe(true);
    expect(vectors.ids).toEqual(new Set());
    expect(count(database, "memory_fts_chunk_ledger")).toBe(0);
    expect(count(database, "memory_fts")).toBe(0);
  });

  it("deletes a valid zero-chunk head without issuing an empty Vectorize delete", async () => {
    const database = createSearchDatabase();
    const vectors = new FakeVectors();
    await seedProjection(database, vectors, {
      projectId: "project-1",
      memoryId: "memory-empty",
      revisionId: "revision-empty",
      projectVersion: 7,
      content: "unused",
      chunkCount: 0
    });
    const fixture = { database, searchDb: new SqliteD1(database), vectors };

    await expect(
      deleteMemorySearchProjection({
        searchDb: fixture.searchDb as unknown as D1Database,
        vectors: vectors as unknown as VectorizeIndex,
        generationId: GENERATION_ID,
        projectId: "project-1",
        memoryId: "memory-empty",
        revisionId: "revision-empty",
        projectVersion: 7
      }, { attempts: 1, delayMs: 0 })
    ).resolves.toBe(true);
    expect(vectors.deleteCalls).toEqual([]);
    expect(count(database, "memory_projection_heads")).toBe(0);
  });

  it("fails closed when a ledger vector ID belongs to another project", async () => {
    const database = createSearchDatabase();
    const vectors = new FakeVectors();
    await seedProjection(database, vectors, {
      projectId: "project-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      projectVersion: 7,
      content: "poisoned",
      vectorProjectId: "project-2"
    });
    const fixture = { database, searchDb: new SqliteD1(database), vectors };

    await expect(deleteProjection(fixture, "project-1", 7)).rejects.toThrow(
      "crossed its ownership boundary"
    );
    expect(vectors.deleteCalls).toEqual([]);
    expect(count(database, "memory_projection_heads")).toBe(1);
    expect(count(database, "memory_fts_chunk_ledger")).toBe(1);
  });
});

async function createDeleteFixture(): Promise<{
  database: DatabaseSync;
  searchDb: SqliteD1;
  vectors: FakeVectors;
}> {
  const database = createSearchDatabase();
  const vectors = new FakeVectors();
  await seedProjection(database, vectors, {
    projectId: "project-1",
    memoryId: "memory-1",
    revisionId: "revision-1",
    projectVersion: 7,
    content: "project one"
  });
  return { database, searchDb: new SqliteD1(database), vectors };
}

function createSearchDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of SEARCH_MIGRATIONS) {
    database.exec(readFileSync(migration, "utf8"));
  }
  return database;
}

function createMemoryDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      project_version INTEGER NOT NULL
    );
    CREATE TABLE memories (
      project_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      current_revision_id TEXT,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      memory_class TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      PRIMARY KEY (project_id, memory_id)
    );
    CREATE TABLE memory_versions (
      project_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      content TEXT NOT NULL,
      PRIMARY KEY (project_id, revision_id)
    );
    CREATE TABLE memory_repository_contexts (
      project_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      repository_id TEXT NOT NULL
    );
    CREATE TABLE version_evidence (
      project_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL
    );
    CREATE TABLE evidence (
      project_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      locator TEXT,
      commit_sha TEXT,
      sensitivity_status TEXT NOT NULL,
      PRIMARY KEY (project_id, evidence_id)
    );
    INSERT INTO projects (project_id, project_version) VALUES ('project-1', 7);
    INSERT INTO memories
      (project_id, memory_id, current_revision_id, status, kind, memory_class,
       scope, scope_id)
    VALUES
      ('project-1', 'memory-1', 'revision-1', 'active', 'fact', 'semantic',
       'project', 'project-1');
    INSERT INTO memory_versions
      (project_id, memory_id, revision_id, valid_from, valid_until, content)
    VALUES ('project-1', 'memory-1', 'revision-1', NULL, NULL, 'initial');
  `);
  return database;
}

async function seedProjection(
  database: DatabaseSync,
  vectors: FakeVectors,
  input: {
    projectId: string;
    memoryId: string;
    revisionId: string;
    projectVersion: number;
    content: string;
    chunkCount?: number;
    vectorProjectId?: string;
  }
): Promise<void> {
  const chunkCount = input.chunkCount ?? 1;
  const vectorIds = await Promise.all(
    Array.from({ length: chunkCount }, (_, index) =>
      deriveMemorySearchVectorId(
        GENERATION_ID,
        input.vectorProjectId ?? input.projectId,
        input.revisionId,
        `chunk-${index}`
      )
    )
  );
  database.exec("BEGIN");
  database.prepare(
    `INSERT INTO memory_search_projection_write_leases
     (generation_id, project_id, memory_id, revision_id, project_version,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, ?, ?, '*', ?)`
  ).run(
    GENERATION_ID,
    input.projectId,
    input.memoryId,
    input.revisionId,
    input.projectVersion,
    chunkCount
  );
  database.prepare(
    `INSERT INTO memory_projection_heads
     (generation_id, project_id, memory_id, project_version, revision_id,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, ?, ?, '*', ?)`
  ).run(
    GENERATION_ID,
    input.projectId,
    input.memoryId,
    input.projectVersion,
    input.revisionId,
    chunkCount
  );
  for (let index = 0; index < chunkCount; index += 1) {
    const chunkId = `chunk-${index}`;
    const vectorId = vectorIds[index]!;
    database.prepare(
      `INSERT INTO memory_fts_chunk_ledger
       (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      GENERATION_ID,
      input.projectId,
      input.memoryId,
      input.revisionId,
      chunkId,
      vectorId
    );
    const row = database.prepare(
      `SELECT fts_rowid FROM memory_fts_chunk_ledger
       WHERE generation_id = ? AND project_id = ? AND memory_id = ?
         AND revision_id = ? AND chunk_id = ?`
    ).get(
      GENERATION_ID,
      input.projectId,
      input.memoryId,
      input.revisionId,
      chunkId
    ) as { fts_rowid: number };
    database.prepare(
      `INSERT INTO memory_fts
       (rowid, generation_id, project_id, memory_id, revision_id, chunk_id, status,
        kind, memory_class, scope, scope_id, content)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 'fact', 'semantic', 'project', ?, ?)`
    ).run(
      row.fts_rowid,
      GENERATION_ID,
      input.projectId,
      input.memoryId,
      input.revisionId,
      chunkId,
      input.projectId,
      input.content
    );
    vectors.ids.add(vectorId);
  }
  database.prepare(
    `DELETE FROM memory_search_projection_write_leases
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  ).run(GENERATION_ID, input.projectId, input.memoryId);
  database.exec("COMMIT");
}

function deleteProjection(
  fixture: { searchDb: SqliteD1; vectors: FakeVectors },
  projectId: string,
  projectVersion: number
): Promise<boolean> {
  return deleteMemorySearchProjection(
    {
      searchDb: fixture.searchDb as unknown as D1Database,
      vectors: fixture.vectors as unknown as VectorizeIndex,
      generationId: GENERATION_ID,
      projectId,
      memoryId: "memory-1",
      revisionId: "revision-1",
      projectVersion
    },
    { attempts: 1, delayMs: 0, delay: async () => undefined }
  );
}

function count(database: DatabaseSync, table: string): number {
  const result = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return result.count;
}

class SqliteStatement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string
  ) {}

  bind(...bindings: unknown[]): SqliteStatement {
    this.bindings = bindings as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement().all(...this.bindings) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.statement().run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  withSession(constraint: "first-primary"): SqliteD1 {
    expect(constraint).toBe("first-primary");
    return this;
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class FakeVectors {
  readonly ids = new Set<string>();
  readonly values = new Map<string, VectorizeVector>();
  readonly deleteCalls: string[][] = [];
  deleteFailuresRemaining = 0;

  async upsert(vectors: VectorizeVector[]): Promise<{ mutationId: string }> {
    for (const vector of vectors) {
      this.ids.add(vector.id);
      this.values.set(vector.id, vector);
    }
    return { mutationId: "synthetic-upsert" };
  }

  async deleteByIds(ids: string[]): Promise<{ mutationId: string }> {
    this.deleteCalls.push([...ids]);
    if (this.deleteFailuresRemaining > 0) {
      this.deleteFailuresRemaining -= 1;
      throw new Error("synthetic Vectorize delete failure");
    }
    for (const id of ids) {
      this.ids.delete(id);
      this.values.delete(id);
    }
    return { mutationId: "synthetic-delete" };
  }

  async getByIds(ids: string[]): Promise<VectorizeVector[]> {
    return ids
      .filter((id) => this.ids.has(id))
      .map((id) => this.values.get(id) ?? ({ id } as VectorizeVector));
  }
}
