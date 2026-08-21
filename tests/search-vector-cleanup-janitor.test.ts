import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  cleanupMemorySearchVectorReceiptPage,
  deriveMemorySearchVectorId,
  SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS,
  SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT_MS
} from "../src/search/indexing";
import { reapSearchVectorCleanupReceipts } from "../src/search/vector-cleanup-janitor";

const SEARCH_MIGRATIONS = [
  "migrations/search/0001_initial.sql"
] as const;
const GENERATION_ID = "qwen3-embedding-0.6b-chunk-2026-07-25";

describe("search vector cleanup janitor", () => {
  it("keeps the fixed claim lease above every bounded production holder", () => {
    expect(SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS).toBe(2 * 60 * 60 * 1_000);
    expect(SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT_MS).toBe(15 * 60 * 1_000);
    expect(SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS).toBeGreaterThan(
      (120 - 1) * 30_000 + 60 * 60 * 1_000
    );
  });

  it("rejects cleanup budgets above the scheduled safety caps", async () => {
    const fixture = createFixture();
    const env = {
      searchDb: fixture.searchDb as unknown as D1Database,
      vectors: fixture.vectors as unknown as VectorizeIndex
    };

    await expect(
      reapSearchVectorCleanupReceipts(env, { ownerLimit: 2 })
    ).rejects.toThrow("owner limit");
    await expect(
      reapSearchVectorCleanupReceipts(env, { receiptLimit: 51 })
    ).rejects.toThrow("receipt limit");
  });

  it("bounds each pass to one zero-head owner without crossing projects", async () => {
    const fixture = createFixture();
    const projectOneVector = await seedReceipt(fixture, "project-1", "memory-1", "revision-1");
    const projectTwoVector = await seedReceipt(fixture, "project-2", "memory-1", "revision-1");

    await expect(runJanitor(fixture)).resolves.toEqual({
      ownersExamined: 1,
      receiptsExamined: 1
    });
    expect(fixture.vectors.ids).toEqual(new Set([projectTwoVector]));
    expect(fixture.vectors.deleteCalls).toEqual([[projectOneVector]]);
    expect(receiptOwners(fixture.database)).toEqual(["project-2"]);

    await expect(runJanitor(fixture)).resolves.toEqual({
      ownersExamined: 1,
      receiptsExamined: 1
    });
    expect(fixture.vectors.ids).toEqual(new Set());
    expect(receiptOwners(fixture.database)).toEqual([]);
  });

  it("uses an indexed row-value keyset after the persistent cursor", async () => {
    const fixture = createFixture();
    await seedReceipt(fixture, "project-1", "memory-1", "revision-1");
    await seedReceipt(fixture, "project-2", "memory-1", "revision-1");
    const nowMs = Date.parse("2026-07-28T12:00:00.000Z");

    await runJanitor(fixture, 1, { now: () => nowMs });
    const beforeSecondPass = fixture.searchDb.preparedSql.length;
    await runJanitor(fixture, 1, { now: () => nowMs });
    const ownerQuery = fixture.searchDb.preparedSql
      .slice(beforeSecondPass)
      .find(
        (sql) =>
          sql.includes(
            "GROUP BY receipt.generation_id, receipt.project_id, receipt.memory_id"
          ) &&
          sql.includes("(receipt.generation_id, receipt.project_id, receipt.memory_id)")
      );
    expect(ownerQuery).toBeDefined();

    const plan = fixture.database
      .prepare(`EXPLAIN QUERY PLAN ${ownerQuery}`)
      .all(
        new Date(nowMs).toISOString(),
        new Date(nowMs).toISOString(),
        GENERATION_ID,
        "project-1",
        "memory-1",
        1
      )
      .map((row) => String(row.detail))
      .join("\n");
    expect(plan).toContain(
      "SEARCH receipt USING INDEX " +
        "memory_search_vector_cleanup_by_owner"
    );
    expect(plan).toContain(
      "SEARCH blocked USING INDEX memory_search_vector_cleanup_by_owner"
    );
    expect(plan).not.toContain("SCAN receipt");
    expect(plan).not.toContain("SCAN blocked");
  });

  it("deletes stale vectors but preserves a newly published revision vector", async () => {
    const fixture = createFixture();
    const currentVector = await seedPublishedProjection(
      fixture,
      "project-1",
      "memory-1",
      "revision-new"
    );
    const staleVector = await seedReceipt(
      fixture,
      "project-1",
      "memory-1",
      "revision-old"
    );
    insertReceipt(
      fixture.database,
      "project-1",
      "memory-1",
      "revision-new",
      currentVector
    );

    await expect(runJanitor(fixture, 50)).resolves.toEqual({
      ownersExamined: 1,
      receiptsExamined: 2
    });
    expect(fixture.vectors.ids).toEqual(new Set([currentVector]));
    expect(fixture.vectors.deleteCalls).toEqual([[staleVector]]);
    expect(count(fixture.database, "memory_search_vector_cleanup_receipts")).toBe(0);
    expect(count(fixture.database, "memory_fts_chunk_ledger")).toBe(1);
    expect(count(fixture.database, "memory_fts")).toBe(1);
  });

  it("retains a receipt after failure and retries the same exact vector", async () => {
    const fixture = createFixture();
    const vectorId = await seedReceipt(fixture, "project-1", "memory-1", "revision-1");
    fixture.vectors.deleteFailuresRemaining = 1;
    let nowMs = Date.parse("2026-07-28T12:00:00.000Z");

    await expect(
      runJanitor(fixture, 1, { now: () => nowMs })
    ).rejects.toThrow("synthetic Vectorize delete failure");
    expect(fixture.vectors.ids).toEqual(new Set([vectorId]));
    expect(count(fixture.database, "memory_search_vector_cleanup_receipts")).toBe(1);
    expect(cleanupBackoff(fixture.database, "project-1")).toEqual({
      cleanup_attempt: 1,
      cleanup_next_attempt_at: "2026-07-28T12:01:00.000Z",
      cleanup_last_error_code: "VECTORIZE_FAILURE"
    });

    await expect(runJanitor(fixture, 1, { now: () => nowMs })).resolves.toEqual({
      ownersExamined: 0,
      receiptsExamined: 0
    });
    nowMs += 60_001;
    await expect(runJanitor(fixture, 1, { now: () => nowMs })).resolves.toEqual({
      ownersExamined: 1,
      receiptsExamined: 1
    });
    expect(fixture.vectors.ids).toEqual(new Set());
    expect(fixture.vectors.deleteCalls).toEqual([[vectorId], [vectorId]]);
    expect(count(fixture.database, "memory_search_vector_cleanup_receipts")).toBe(0);
  });

  it("recovers an abandoned cleanup claim only after its lease expires", async () => {
    const fixture = createFixture();
    const vectorId = await seedReceipt(fixture, "project-1", "memory-1", "revision-1");
    const beforeExpiry = Date.parse("2026-07-28T13:00:00.000Z");
    fixture.database.prepare(
      `UPDATE memory_search_vector_cleanup_receipts
       SET cleanup_claim_token = ?, cleanup_claim_started_at = ?,
           cleanup_claim_expires_at = ?`
    ).run(
      "a".repeat(64),
      "2026-07-28T12:00:00.000Z",
      "2026-07-28T14:00:00.000Z"
    );

    await expect(
      runJanitor(fixture, 1, { now: () => beforeExpiry })
    ).resolves.toEqual({ ownersExamined: 0, receiptsExamined: 0 });
    expect(fixture.vectors.ids).toEqual(new Set([vectorId]));

    await expect(
      runJanitor(fixture, 1, {
        now: () => Date.parse("2026-07-28T14:00:00.001Z")
      })
    ).resolves.toEqual({ ownersExamined: 1, receiptsExamined: 1 });
    expect(fixture.vectors.ids).toEqual(new Set());
    expect(fixture.vectors.deleteCalls).toEqual([[vectorId]]);
  });

  it("does not call Vectorize after a cleanup claim expires", async () => {
    const fixture = createFixture();
    const vectorId = await seedReceipt(fixture, "project-1", "memory-1", "revision-1");
    const startedAt = Date.parse("2026-07-28T12:00:00.000Z");
    const clock = [startedAt, startedAt + SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS + 1];

    await expect(
      runCleanupPage(fixture, {
        now: () => clock.shift() ?? startedAt + SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS + 1
      })
    ).rejects.toThrow("claim is no longer current");

    expect(fixture.vectors.deleteCalls).toEqual([]);
    expect(fixture.vectors.ids).toEqual(new Set([vectorId]));
    expect(count(fixture.database, "memory_search_vector_cleanup_receipts")).toBe(1);
  });

  it("does not finalize a receipt when its claim expires after Vectorize deletion", async () => {
    const fixture = createFixture();
    const vectorId = await seedReceipt(fixture, "project-1", "memory-1", "revision-1");
    const startedAt = Date.parse("2026-07-28T12:00:00.000Z");
    const clock = [
      startedAt,
      startedAt + 1,
      startedAt + SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS + 1
    ];

    await expect(
      runCleanupPage(fixture, {
        now: () => clock.shift() ?? startedAt + SEARCH_VECTOR_CLEANUP_CLAIM_TTL_MS + 1
      })
    ).rejects.toThrow("claim is no longer current");

    expect(fixture.vectors.deleteCalls).toEqual([[vectorId]]);
    expect(fixture.vectors.ids).toEqual(new Set());
    expect(count(fixture.database, "memory_search_vector_cleanup_receipts")).toBe(1);
  });

  it("refuses to delete a vector owned by a matching projection head", async () => {
    const fixture = createFixture();
    await seedHeadWithoutLedger(fixture, "project-1", "memory-1", "revision-1");
    const vectorId = await seedReceipt(
      fixture,
      "project-1",
      "memory-1",
      "revision-1"
    );

    await expect(runJanitor(fixture)).rejects.toThrow("claim is no longer current");

    expect(fixture.vectors.deleteCalls).toEqual([]);
    expect(fixture.vectors.ids).toEqual(new Set([vectorId]));
    expect(cleanupBackoff(fixture.database, "project-1")).toMatchObject({
      cleanup_attempt: 1,
      cleanup_last_error_code: "CLAIM_INVALID"
    });
  });

  it("lets only one janitor delete before the same revision is republished", async () => {
    const fixture = createFixture();
    const vectorId = await seedReceipt(fixture, "project-1", "memory-1", "revision-1");
    fixture.searchDb.coordinateOverlappingClaims();

    const first = runCleanupPage(fixture);
    const second = runCleanupPage(fixture);
    await fixture.searchDb.secondClaimPaused;
    const expectedPage = {
      examinedReceipts: 1,
      pageIdentity: vectorId
    };
    await expect(Promise.race([first, second])).resolves.toEqual(expectedPage);
    expect(fixture.vectors.ids).toEqual(new Set());
    expect(count(fixture.database, "memory_search_vector_cleanup_receipts")).toBe(0);

    const republishedVector = await seedPublishedProjection(
      fixture,
      "project-1",
      "memory-1",
      "revision-1"
    );
    expect(republishedVector).toBe(vectorId);
    fixture.searchDb.releaseSecondClaim();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expectedPage,
      expectedPage
    ]);

    expect(fixture.vectors.ids).toEqual(new Set([vectorId]));
    expect(fixture.vectors.deleteCalls).toEqual([[vectorId]]);
    expect(count(fixture.database, "memory_search_vector_cleanup_receipts")).toBe(0);
  });

  it("advances past a poisoned owner and cleans the next healthy project", async () => {
    const fixture = createFixture();
    const foreignVector = await deriveMemorySearchVectorId(
      GENERATION_ID,
      "project-2",
      "revision-1",
      "chunk-0"
    );
    insertReceipt(
      fixture.database,
      "project-1",
      "memory-1",
      "revision-1",
      foreignVector
    );
    fixture.vectors.ids.add(foreignVector);
    const healthyVector = await seedReceipt(
      fixture,
      "project-2",
      "memory-1",
      "revision-healthy"
    );

    let nowMs = Date.parse("2026-07-28T12:00:00.000Z");
    await expect(
      runJanitor(fixture, 1, { now: () => nowMs })
    ).rejects.toThrow("ownership boundary");
    expect(fixture.vectors.deleteCalls).toEqual([]);
    expect(cleanupBackoff(fixture.database, "project-1")).toEqual({
      cleanup_attempt: 1,
      cleanup_next_attempt_at: "2026-07-28T12:01:00.000Z",
      cleanup_last_error_code: "OWNERSHIP_BOUNDARY"
    });
    await expect(runJanitor(fixture, 1, { now: () => nowMs })).resolves.toEqual({
      ownersExamined: 1,
      receiptsExamined: 1
    });
    expect(fixture.vectors.deleteCalls).toEqual([[healthyVector]]);
    expect(fixture.vectors.ids).toEqual(new Set([foreignVector]));
    expect(receiptOwners(fixture.database)).toEqual(["project-1"]);
    await expect(runJanitor(fixture, 1, { now: () => nowMs })).resolves.toEqual({
      ownersExamined: 0,
      receiptsExamined: 0
    });
    nowMs += 60_001;
    await expect(
      runJanitor(fixture, 1, { now: () => nowMs })
    ).rejects.toThrow("ownership boundary");
    expect(cleanupBackoff(fixture.database, "project-1")).toEqual({
      cleanup_attempt: 2,
      cleanup_next_attempt_at: "2026-07-28T12:03:00.001Z",
      cleanup_last_error_code: "OWNERSHIP_BOUNDARY"
    });
  });

  it("does not restore a synthetic project cursor after its receipts are purged", async () => {
    const fixture = createFixture();
    await seedReceipt(fixture, "project-1", "memory-1", "revision-1");
    fixture.database.prepare(
      `UPDATE memory_search_vector_cleanup_janitor_state
       SET cursor_version = 7, cursor_generation_id = ?, cursor_project_id = ?,
           cursor_memory_id = ?, updated_at = ?`
    ).run(
      GENERATION_ID,
      "project-0",
      "memory-0",
      "2026-07-28T11:59:00.000Z"
    );
    fixture.searchDb.coordinateCursorAdvance();

    const cleanup = runJanitor(fixture, 1, {
      now: () => Date.parse("2026-07-28T12:00:00.000Z")
    });
    await fixture.searchDb.ownerSelectionPaused;
    fixture.database.prepare(
      "DELETE FROM memory_search_vector_cleanup_receipts WHERE project_id = ?"
    ).run("project-1");
    fixture.database.prepare(
      `UPDATE memory_search_vector_cleanup_janitor_state
       SET cursor_generation_id = NULL, cursor_project_id = NULL,
           cursor_memory_id = NULL, updated_at = NULL
       WHERE cursor_project_id = ?`
    ).run("project-0");
    fixture.searchDb.releaseCursorAdvance();

    await expect(cleanup).resolves.toEqual({ ownersExamined: 0, receiptsExamined: 0 });
    expect(janitorCursor(fixture.database)).toEqual({
      cursor_version: 7,
      cursor_generation_id: null,
      cursor_project_id: null,
      cursor_memory_id: null,
      updated_at: null
    });
  });

  it("caps repeated poison-owner backoff at one hour and eight attempts", async () => {
    const fixture = createFixture();
    const foreignVector = await deriveMemorySearchVectorId(
      GENERATION_ID,
      "project-2",
      "revision-1",
      "chunk-0"
    );
    insertReceipt(
      fixture.database,
      "project-1",
      "memory-1",
      "revision-1",
      foreignVector
    );
    fixture.database.prepare(
      `UPDATE memory_search_vector_cleanup_receipts
       SET cleanup_attempt = 8, cleanup_next_attempt_at = ?,
           cleanup_last_error_code = 'OWNERSHIP_BOUNDARY'`
    ).run("2026-07-28T11:59:00.000Z");

    await expect(
      runJanitor(fixture, 1, {
        now: () => Date.parse("2026-07-28T12:00:00.000Z")
      })
    ).rejects.toThrow("ownership boundary");

    expect(cleanupBackoff(fixture.database, "project-1")).toEqual({
      cleanup_attempt: 8,
      cleanup_next_attempt_at: "2026-07-28T13:00:00.000Z",
      cleanup_last_error_code: "OWNERSHIP_BOUNDARY"
    });
  });

  it("clears expired owner backoff after a successful partial page", async () => {
    const fixture = createFixture();
    await seedReceipt(fixture, "project-1", "memory-1", "revision-1");
    await seedReceipt(fixture, "project-1", "memory-1", "revision-2");
    fixture.database.prepare(
      `UPDATE memory_search_vector_cleanup_receipts
       SET cleanup_attempt = 3, cleanup_next_attempt_at = ?,
           cleanup_last_error_code = 'VECTORIZE_FAILURE'`
    ).run("2026-07-28T11:59:00.000Z");

    await expect(
      runJanitor(fixture, 1, {
        now: () => Date.parse("2026-07-28T12:00:00.000Z")
      })
    ).resolves.toEqual({ ownersExamined: 1, receiptsExamined: 1 });

    expect(count(fixture.database, "memory_search_vector_cleanup_receipts")).toBe(1);
    expect(
      fixture.database.prepare(
        `SELECT cleanup_attempt, cleanup_next_attempt_at, cleanup_last_error_code
         FROM memory_search_vector_cleanup_receipts`
      ).get()
    ).toEqual({
      cleanup_attempt: 0,
      cleanup_next_attempt_at: null,
      cleanup_last_error_code: null
    });
  });
});

interface Fixture {
  database: DatabaseSync;
  searchDb: SqliteD1;
  vectors: FakeVectors;
}

function createFixture(): Fixture {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of SEARCH_MIGRATIONS) {
    database.exec(readFileSync(migration, "utf8"));
  }
  return { database, searchDb: new SqliteD1(database), vectors: new FakeVectors() };
}

function runJanitor(
  fixture: Fixture,
  receiptLimit = 1,
  overrides: NonNullable<Parameters<typeof reapSearchVectorCleanupReceipts>[1]> = {}
) {
  return reapSearchVectorCleanupReceipts(
    {
      searchDb: fixture.searchDb as unknown as D1Database,
      vectors: fixture.vectors as unknown as VectorizeIndex
    },
    { ownerLimit: 1, receiptLimit, attempts: 1, delayMs: 0, ...overrides }
  );
}

function runCleanupPage(
  fixture: Fixture,
  overrides: NonNullable<
    Parameters<typeof cleanupMemorySearchVectorReceiptPage>[2]
  > = {}
) {
  return cleanupMemorySearchVectorReceiptPage(
    {
      searchDb: fixture.searchDb as unknown as D1Database,
      vectors: fixture.vectors as unknown as VectorizeIndex
    },
    {
      generationId: GENERATION_ID,
      projectId: "project-1",
      memoryId: "memory-1"
    },
    { receiptLimit: 1, attempts: 1, delayMs: 0, ...overrides }
  );
}

async function seedReceipt(
  fixture: Fixture,
  projectId: string,
  memoryId: string,
  revisionId: string
): Promise<string> {
  const vectorId = await deriveMemorySearchVectorId(
    GENERATION_ID,
    projectId,
    revisionId,
    "chunk-0"
  );
  insertReceipt(fixture.database, projectId, memoryId, revisionId, vectorId);
  fixture.vectors.ids.add(vectorId);
  return vectorId;
}

function insertReceipt(
  database: DatabaseSync,
  projectId: string,
  memoryId: string,
  revisionId: string,
  vectorId: string
): void {
  database.prepare(
    `INSERT INTO memory_search_vector_cleanup_receipts
     (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
     VALUES (?, ?, ?, ?, 'chunk-0', ?)`
  ).run(GENERATION_ID, projectId, memoryId, revisionId, vectorId);
}

async function seedPublishedProjection(
  fixture: Fixture,
  projectId: string,
  memoryId: string,
  revisionId: string
): Promise<string> {
  const vectorId = await deriveMemorySearchVectorId(
    GENERATION_ID,
    projectId,
    revisionId,
    "chunk-0"
  );
  fixture.database.exec("BEGIN");
  fixture.database.prepare(
    `INSERT INTO memory_search_projection_write_leases
     (generation_id, project_id, memory_id, revision_id, project_version,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, ?, 7, '*', 1)`
  ).run(GENERATION_ID, projectId, memoryId, revisionId);
  fixture.database.prepare(
    `INSERT INTO memory_projection_heads
     (generation_id, project_id, memory_id, project_version, revision_id,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, 7, ?, '*', 1)`
  ).run(GENERATION_ID, projectId, memoryId, revisionId);
  fixture.database.prepare(
    `INSERT INTO memory_fts_chunk_ledger
     (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
     VALUES (?, ?, ?, ?, 'chunk-0', ?)`
  ).run(GENERATION_ID, projectId, memoryId, revisionId, vectorId);
  const row = fixture.database.prepare(
    "SELECT fts_rowid FROM memory_fts_chunk_ledger WHERE vector_id = ?"
  ).get(vectorId) as { fts_rowid: number };
  fixture.database.prepare(
    `INSERT INTO memory_fts
     (rowid, generation_id, project_id, memory_id, revision_id, chunk_id, status,
      kind, memory_class, scope, scope_id, content)
     VALUES (?, ?, ?, ?, ?, 'chunk-0', 'active', 'fact', 'semantic', 'project', ?,
             'current')`
  ).run(row.fts_rowid, GENERATION_ID, projectId, memoryId, revisionId, projectId);
  fixture.database.prepare(
    `DELETE FROM memory_search_projection_write_leases
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  ).run(GENERATION_ID, projectId, memoryId);
  fixture.database.exec("COMMIT");
  fixture.vectors.ids.add(vectorId);
  return vectorId;
}

async function seedHeadWithoutLedger(
  fixture: Fixture,
  projectId: string,
  memoryId: string,
  revisionId: string
): Promise<void> {
  fixture.database.exec("BEGIN");
  fixture.database.prepare(
    `INSERT INTO memory_search_projection_write_leases
     (generation_id, project_id, memory_id, revision_id, project_version,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, ?, 7, '*', 0)`
  ).run(GENERATION_ID, projectId, memoryId, revisionId);
  fixture.database.prepare(
    `INSERT INTO memory_projection_heads
     (generation_id, project_id, memory_id, project_version, revision_id,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, 7, ?, '*', 0)`
  ).run(GENERATION_ID, projectId, memoryId, revisionId);
  fixture.database.prepare(
    `DELETE FROM memory_search_projection_write_leases
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  ).run(GENERATION_ID, projectId, memoryId);
  fixture.database.exec("COMMIT");
}

function receiptOwners(database: DatabaseSync): string[] {
  return database.prepare(
    `SELECT DISTINCT project_id
     FROM memory_search_vector_cleanup_receipts
     ORDER BY project_id`
  ).all().map((row) => String(row.project_id));
}

function cleanupBackoff(
  database: DatabaseSync,
  projectId: string
): {
  cleanup_attempt: number;
  cleanup_next_attempt_at: string;
  cleanup_last_error_code: string;
} | undefined {
  return database.prepare(
    `SELECT cleanup_attempt, cleanup_next_attempt_at, cleanup_last_error_code
     FROM memory_search_vector_cleanup_receipts
     WHERE project_id = ?
     ORDER BY vector_id
     LIMIT 1`
  ).get(projectId) as ReturnType<typeof cleanupBackoff>;
}

function janitorCursor(database: DatabaseSync): Record<string, unknown> {
  return database.prepare(
    `SELECT cursor_version, cursor_generation_id, cursor_project_id,
            cursor_memory_id, updated_at
     FROM memory_search_vector_cleanup_janitor_state
     WHERE state_id = 1`
  ).get() as Record<string, unknown>;
}

function count(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
}

class FakeVectors {
  readonly ids = new Set<string>();
  readonly deleteCalls: string[][] = [];
  deleteFailuresRemaining = 0;

  async deleteByIds(ids: string[]): Promise<void> {
    this.deleteCalls.push([...ids]);
    if (this.deleteFailuresRemaining > 0) {
      this.deleteFailuresRemaining -= 1;
      throw new Error("synthetic Vectorize delete failure");
    }
    for (const id of ids) {
      this.ids.delete(id);
    }
  }

  async getByIds(ids: string[]): Promise<Array<{ id: string }>> {
    return ids.filter((id) => this.ids.has(id)).map((id) => ({ id }));
  }
}

class SqliteD1 {
  readonly preparedSql: string[] = [];
  private coordinateClaims = false;
  private receiptReadArrivals = 0;
  private releaseFirstReceiptReader: (() => void) | undefined;
  private firstReceiptReader = Promise.resolve();
  private releaseSecondReceiptReader: (() => void) | undefined;
  private secondReceiptReader = Promise.resolve();
  private claimBatchCount = 0;
  private releasePausedClaim: (() => void) | undefined;
  private pausedClaim = Promise.resolve();
  private reportSecondClaimPaused: (() => void) | undefined;
  secondClaimPaused = Promise.resolve();
  private coordinateCursor = false;
  private releasePausedCursor: (() => void) | undefined;
  private pausedCursor = Promise.resolve();
  private reportOwnerSelectionPaused: (() => void) | undefined;
  ownerSelectionPaused = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    this.preparedSql.push(sql);
    return new SqliteStatement(this.database, sql, this);
  }

  coordinateOverlappingClaims(): void {
    this.coordinateClaims = true;
    this.firstReceiptReader = new Promise<void>((resolve) => {
      this.releaseFirstReceiptReader = resolve;
    });
    this.secondReceiptReader = new Promise<void>((resolve) => {
      this.releaseSecondReceiptReader = resolve;
    });
    this.pausedClaim = new Promise<void>((resolve) => {
      this.releasePausedClaim = resolve;
    });
    this.secondClaimPaused = new Promise<void>((resolve) => {
      this.reportSecondClaimPaused = resolve;
    });
  }

  releaseSecondClaim(): void {
    this.releasePausedClaim?.();
  }

  coordinateCursorAdvance(): void {
    this.coordinateCursor = true;
    this.pausedCursor = new Promise<void>((resolve) => {
      this.releasePausedCursor = resolve;
    });
    this.ownerSelectionPaused = new Promise<void>((resolve) => {
      this.reportOwnerSelectionPaused = resolve;
    });
  }

  releaseCursorAdvance(): void {
    this.releasePausedCursor?.();
  }

  async afterRead(sql: string): Promise<void> {
    if (
      this.coordinateCursor &&
      sql.includes(
        "GROUP BY receipt.generation_id, receipt.project_id, receipt.memory_id"
      )
    ) {
      this.coordinateCursor = false;
      this.reportOwnerSelectionPaused?.();
      await this.pausedCursor;
    }
    if (
      this.coordinateClaims &&
      sql.includes("FROM memory_search_vector_cleanup_receipts") &&
      sql.includes("ORDER BY vector_id")
    ) {
      this.receiptReadArrivals += 1;
      if (this.receiptReadArrivals === 1) {
        await this.firstReceiptReader;
      } else if (this.receiptReadArrivals === 2) {
        this.releaseFirstReceiptReader?.();
        await this.secondReceiptReader;
      }
    }
  }

  async batch(statements: SqliteStatement[]): Promise<D1Result[]> {
    if (
      this.coordinateClaims &&
      statements[0]?.text.includes("SET cleanup_claim_token = ?")
    ) {
      this.claimBatchCount += 1;
      if (this.claimBatchCount === 1) {
        this.releaseSecondReceiptReader?.();
      }
      if (this.claimBatchCount === 2) {
        this.reportSecondClaimPaused?.();
        await this.pausedClaim;
      }
    }
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results as unknown as D1Result[];
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteStatement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    readonly text: string,
    private readonly owner: SqliteD1
  ) {}

  bind(...bindings: SQLInputValue[]): SqliteStatement {
    this.bindings = bindings;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const results = this.statement().all(...this.bindings) as T[];
    await this.owner.afterRead(this.text);
    return { results };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  run(): D1Result {
    const result = this.statement().run(...this.bindings);
    return {
      success: true,
      meta: { changes: Number(result.changes) }
    } as D1Result;
  }

  private statement(): StatementSync {
    return this.database.prepare(this.text);
  }
}
