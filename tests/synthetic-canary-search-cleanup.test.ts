import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// @ts-expect-error The JavaScript runtime helper has no separate declaration file.
import { executeSyntheticCleanup } from "../scripts/synthetic-canary-support.mjs";
// @ts-expect-error The JavaScript runtime helper has no separate declaration file.
import * as syntheticSearchCleanupModule from "../scripts/synthetic-canary-search-cleanup.mjs";

const {
  assertSyntheticSearchCleanup,
  mergeSyntheticCleanupLedgers,
  PROJECT_SCOPED_SEARCH_TABLES,
  syntheticCleanupVectorIds,
  syntheticSearchCleanupSql,
  syntheticSearchCleanupVerificationSql
} = syntheticSearchCleanupModule;

const SEARCH_GENERATION_ID = "qwen3-embedding-0.6b-chunk-2026-07-25";
const SEARCH_MIGRATIONS = [
  "migrations/search/0001_fts.sql",
  "migrations/search/0002_activate_qwen_generation.sql",
  "migrations/search/0003_projection_heads.sql",
  "migrations/search/0004_repository_partition.sql",
  "migrations/search/0005_memory_fts_chunk_ledger.sql"
] as const;

describe("synthetic canary Search cleanup", () => {
  it("deletes project-scoped state only after exact vectors are absent", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON;");
    for (const migration of SEARCH_MIGRATIONS) {
      database.exec(readFileSync(migration, "utf8"));
    }
    const targetProjectId = "target-project";
    const otherProjectId = "other-project";
    const targetVectorId = seedSearchCleanupState(database, targetProjectId);
    const otherVectorId = seedSearchCleanupState(database, otherProjectId);
    database.prepare(
      `UPDATE memory_search_vector_cleanup_janitor_state
       SET cursor_generation_id = ?, cursor_project_id = ?, cursor_memory_id = ?,
           updated_at = '2026-07-25T00:00:00.000Z'
       WHERE state_id = 1`
    ).run(SEARCH_GENERATION_ID, targetProjectId, `${targetProjectId}-memory`);

    const projectionRows = database.prepare(
      `SELECT generation_id, project_id, revision_id, chunk_id, vector_id
       FROM memory_search_vector_cleanup_receipts
       WHERE project_id = ?`
    ).all(targetProjectId);
    const vectorIds = syntheticCleanupVectorIds(
      targetProjectId,
      projectionRows,
      []
    ) as string[];
    expect(vectorIds).toEqual([targetVectorId]);

    const vectors = new Set([targetVectorId, otherVectorId]);
    let vectorsVerified = false;
    await executeSyntheticCleanup({
      claimAdmissionFence: () => undefined,
      waitForQuiescence: () => undefined,
      loadLedger: () => null,
      createLedger: () => ({ vector_ids: vectorIds, r2_keys: [] }),
      writeLedger: () => undefined,
      deleteSearchVectors: (ledger: { vector_ids: string[] }) => {
        for (const vectorId of ledger.vector_ids) {
          vectors.delete(vectorId);
        }
      },
      verifySearchVectors: (ledger: { vector_ids: string[] }) => {
        expect(
          ledger.vector_ids.every((vectorId) => !vectors.has(vectorId))
        ).toBe(true);
        expect(
          database.prepare(
            `SELECT COUNT(*) AS count
             FROM memory_search_vector_cleanup_receipts WHERE project_id = ?`
          ).get(targetProjectId)
        ).toEqual({ count: 1 });
        vectorsVerified = true;
      },
      deleteSearchState: () => {
        expect(vectorsVerified).toBe(true);
        database.exec(syntheticSearchCleanupSql(targetProjectId));
      },
      deleteR2Projections: () => undefined,
      verifyProjectionCleanup: () => {
        assertSyntheticSearchCleanup(
          database.prepare(
            syntheticSearchCleanupVerificationSql(targetProjectId)
          ).all()
        );
      },
      deleteAuthority: () => undefined,
      verifyAuthorityCleanup: () => undefined,
      removeLedger: () => undefined
    });

    expect(vectors).toEqual(new Set([otherVectorId]));
    for (const table of PROJECT_SCOPED_SEARCH_TABLES as string[]) {
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`)
          .get(targetProjectId)
      ).toEqual({ count: 0 });
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`)
          .get(otherProjectId)
      ).toEqual({ count: 1 });
    }
  });

  it("rejects cleanup receipts with noncanonical vector ownership", () => {
    expect(() =>
      syntheticCleanupVectorIds(
        "target-project",
        [
          {
            generation_id: SEARCH_GENERATION_ID,
            project_id: "target-project",
            revision_id: "target-revision",
            chunk_id: "chunk-0",
            vector_id: "f".repeat(64)
          }
        ],
        []
      )
    ).toThrow(/invalid vector ID/iu);
  });

  it("refreshes a recovery ledger with newly discovered cleanup receipts", () => {
    const projectId = "target-project";
    const principalId = "target-principal";
    const receiptVectorId = createHash("sha256")
      .update(`${SEARCH_GENERATION_ID}\n${projectId}\nrevision-1\nchunk-0`)
      .digest("hex");
    expect(
      mergeSyntheticCleanupLedgers(projectId, principalId, [
        {
          project_id: projectId,
          principal_id: principalId,
          vector_ids: [],
          r2_keys: []
        },
        {
          project_id: projectId,
          principal_id: principalId,
          vector_ids: [receiptVectorId],
          r2_keys: []
        }
      ])
    ).toEqual({
      project_id: projectId,
      principal_id: principalId,
      vector_ids: [receiptVectorId],
      r2_keys: []
    });
  });
});

function seedSearchCleanupState(database: DatabaseSync, projectId: string): string {
  const memoryId = `${projectId}-memory`;
  const revisionId = `${projectId}-revision`;
  const chunkId = "chunk-0";
  const vectorId = createHash("sha256")
    .update(`${SEARCH_GENERATION_ID}\n${projectId}\n${revisionId}\n${chunkId}`)
    .digest("hex");
  database.prepare(
    `INSERT INTO memory_search_projection_write_leases
     (generation_id, project_id, memory_id, revision_id, project_version,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, ?, 1, '*', 1)`
  ).run(SEARCH_GENERATION_ID, projectId, memoryId, revisionId);
  database.prepare(
    `INSERT INTO memory_projection_heads
     (generation_id, project_id, memory_id, project_version, revision_id,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, 1, ?, '*', 1)`
  ).run(SEARCH_GENERATION_ID, projectId, memoryId, revisionId);
  database.prepare(
    `INSERT INTO memory_fts_chunk_ledger
     (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(SEARCH_GENERATION_ID, projectId, memoryId, revisionId, chunkId, vectorId);
  const ledger = database.prepare(
    `SELECT fts_rowid FROM memory_fts_chunk_ledger
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  ).get(SEARCH_GENERATION_ID, projectId, memoryId) as { fts_rowid: number };
  database.prepare(
    `INSERT INTO memory_fts
     (rowid, generation_id, project_id, memory_id, revision_id, chunk_id,
      status, kind, memory_class, scope, scope_id, content)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'fact', 'semantic', 'project', ?, 'content')`
  ).run(
    ledger.fts_rowid,
    SEARCH_GENERATION_ID,
    projectId,
    memoryId,
    revisionId,
    chunkId,
    projectId
  );
  database.prepare(
    `INSERT INTO memory_search_projection_deletions
     (generation_id, project_id, memory_id, revision_id, project_version, chunk_count)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(SEARCH_GENERATION_ID, projectId, memoryId, revisionId);
  database.prepare(
    `INSERT INTO memory_search_vector_cleanup_receipts
     (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(SEARCH_GENERATION_ID, projectId, memoryId, revisionId, chunkId, vectorId);
  return vectorId;
}
