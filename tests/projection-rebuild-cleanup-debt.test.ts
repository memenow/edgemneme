import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Production rebuild utilities are plain ESM so they can run without a TypeScript runtime.
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as projectionRebuildSupport from "../scripts/projection-rebuild-support.mjs";
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as projectionRebuildCli from "../scripts/enqueue-projection-rebuild.mjs";

const {
  PROJECTION_REBUILD_EVENT_TYPE,
  assertProjectionRebuildCleanupDebtClear,
  projectionRebuildDescriptors,
  projectionRebuildEvent,
  requireProjectionRebuildCleanupDebt,
  summarizeProjectionRebuildVerification
} = projectionRebuildSupport;
const {
  loadProjectionRebuildCleanupDebt,
  loadRebuildTargets,
  main: runProjectionRebuildCommand,
  projectionRebuildCleanupDebtQuery
} = projectionRebuildCli;

describe("projection rebuild cleanup-debt release gate", () => {
  it("counts only headless active-generation debt with global and project isolation", () => {
    const database = createCleanupDebtDatabase();
    database.prepare(
      `INSERT INTO memory_projection_heads (generation_id, project_id, memory_id)
       VALUES ('generation-alpha', 'project:alpha', 'memory-active')`
    ).run();
    seedVectorReceipt(database, "generation-alpha", "project:alpha", "memory-active", "a");
    seedVectorReceipt(database, "generation-alpha", "project:alpha", "memory-stale", "b");
    seedVectorReceipt(database, "generation-alpha", "project:unknown", "memory-orphan", "c");
    seedVectorReceipt(database, "generation-beta", "project:alpha", "memory-retired", "d");
    seedDeletion(database, "generation-alpha", "project:alpha", "memory-active");
    seedDeletion(database, "generation-alpha", "project:alpha", "memory-stale");
    seedDeletion(database, "generation-alpha", "project:unknown", "memory-orphan");
    seedDeletion(database, "generation-beta", "project:alpha", "memory-retired");

    const globalQuery = projectionRebuildCleanupDebtQuery({
      searchGenerationId: "generation-alpha"
    });
    expect(database.prepare(globalQuery).all()).toEqual([{
      vector_cleanup_count: 2,
      projection_deletion_count: 2
    }]);
    expect(database.prepare(projectionRebuildCleanupDebtQuery({
      searchGenerationId: "generation-alpha",
      projectId: "project:alpha"
    })).all()).toEqual([{
      vector_cleanup_count: 1,
      projection_deletion_count: 1
    }]);
    expect(database.prepare(projectionRebuildCleanupDebtQuery({
      searchGenerationId: "generation-alpha",
      projectId: "project:unknown"
    })).all()).toEqual([{
      vector_cleanup_count: 1,
      projection_deletion_count: 1
    }]);

    expect(globalQuery).toContain("NOT EXISTS");
    expect(globalQuery).toContain("memory_projection_heads");
    expect(globalQuery).not.toContain("memory_fts");
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${globalQuery}`).all()
      .map((row) => String(row.detail)).join("\n");
    expect(plan).toContain("memory_search_vector_cleanup_by_owner");
    expect(plan.match(/SEARCH debt USING PRIMARY KEY/gu)).toHaveLength(1);
  });

  it("uses one fixed-result query even when the durable debt set is large", () => {
    const database = createCleanupDebtDatabase();
    const insert = database.prepare(
      `INSERT INTO memory_search_vector_cleanup_receipts
       (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
       VALUES ('generation-alpha', ?, ?, 'revision-old', 'chunk-0', ?)`
    );
    for (let index = 0; index < 1_000; index += 1) {
      const suffix = index.toString(16).padStart(64, "0");
      insert.run(`project:${String(index).padStart(4, "0")}`, `memory:${index}`, suffix);
    }
    let queryCount = 0;
    const cleanupDebt = loadProjectionRebuildCleanupDebt(
      "config.jsonc",
      "generation-alpha",
      undefined,
      {
        runQuery: (
          databaseName: string,
          sql: string,
          configPath: string,
          label: string
        ) => {
          queryCount += 1;
          expect(databaseName).toBe("SEARCH_DB");
          expect(configPath).toBe("config.jsonc");
          expect(label).toContain("headless");
          return database.prepare(sql).all();
        }
      }
    );

    expect(cleanupDebt).toEqual({
      vectorCleanupCount: 1_000,
      projectionDeletionCount: 0
    });
    expect(queryCount).toBe(1);
  });

  it("fails global enumeration on active heads outside admitted authority", () => {
    expect(() => loadRebuildTargets("config.jsonc", undefined, {
      pageSize: 10,
      runQuery: rebuildTargetQueryFake("project:unknown")
    })).toThrow(/outside the admitted authority set.*project:unknown/iu);

    expect(loadRebuildTargets("config.jsonc", "project:alpha", {
      pageSize: 10,
      runQuery: rebuildTargetQueryFake("project:unknown")
    })).toEqual([{
      project_id: "project:alpha",
      project_version: 3,
      memory_count: 0,
      revision_count: 0,
      scope_count: 0,
      content_bytes: 0,
      search_generation_id: "generation-alpha",
      memory_heads: [],
      search_heads: []
    }]);
  });

  it("fails fast with owner-specific recovery guidance instead of assigning rebuild ETA", () => {
    const target = {
      project_id: "project:alpha",
      project_version: 3,
      memory_count: 0,
      revision_count: 0,
      scope_count: 0,
      content_bytes: 0,
      search_generation_id: "generation-alpha",
      memory_heads: [],
      search_heads: []
    };
    const [descriptor] = projectionRebuildDescriptors(target);
    const event = projectionRebuildEvent(descriptor, 0);
    const outbox = {
      event_id: event.eventId,
      project_id: target.project_id,
      project_version: target.project_version,
      event_type: PROJECTION_REBUILD_EVENT_TYPE,
      payload_digest: event.payloadDigest,
      payload_json: JSON.stringify(event.payload),
      dispatched_at: "2026-07-28T12:00:00.000Z",
      failed_at: null,
      workflow_status: "complete"
    };
    const base = {
      targets: [target],
      events: [event],
      outboxRows: [outbox],
      snapshotRows: [{
        project_id: target.project_id,
        project_version: target.project_version,
        active_snapshot_id: `${target.project_id}:${target.project_version}`,
        snapshot_id: `${target.project_id}:${target.project_version}`,
        status: "active",
        manifest_key: "projects/project-alpha/projections/3/manifest.json",
        manifest_sha256: "a".repeat(64)
      }],
      searchRows: []
    };

    expect(() => assertProjectionRebuildCleanupDebtClear({
      vectorCleanupCount: 3,
      projectionDeletionCount: 0
    })).toThrow(/reliable ETA.*scheduled vector cleanup janitor.*backoff.*rerun/isu);
    expect(() => assertProjectionRebuildCleanupDebtClear({
      vectorCleanupCount: 0,
      projectionDeletionCount: 2
    })).toThrow(/No automated owner.*reviewed exact-owner recovery/isu);
    expect(() => assertProjectionRebuildCleanupDebtClear({
      vectorCleanupCount: 3,
      projectionDeletionCount: 2
    })).toThrow(/vector cleanup janitor[\s\S]*No automated owner/iu);

    const complete = summarizeProjectionRebuildVerification({
      ...base,
      cleanupDebt: { vectorCleanupCount: 0, projectionDeletionCount: 0 }
    });
    expect(complete).toMatchObject({
      complete: true,
      pendingCount: 0,
      vectorCleanupDebtCount: 0,
      projectionDeletionDebtCount: 0
    });
    expect(() => summarizeProjectionRebuildVerification({
      ...base,
      cleanupDebt: { vectorCleanupCount: 1, projectionDeletionCount: 0 }
    })).toThrow(/headless cleanup debt/iu);
    expect(() => requireProjectionRebuildCleanupDebt([])).toThrow(/exactly one/iu);
    expect(() => requireProjectionRebuildCleanupDebt([{
      vector_cleanup_count: -1,
      projection_deletion_count: 0
    }])).toThrow(/count/iu);
  });

  it("checks cleanup debt before history, immediately before enqueue, and on every verify poll", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/enqueue-projection-rebuild.mjs"),
      "utf8"
    );
    const mainStart = source.indexOf("export async function main");
    const verifyStart = source.indexOf("async function verifyTargets");
    const mainSource = source.slice(mainStart, verifyStart);
    const firstGate = mainSource.indexOf("assertProjectionRebuildCleanupDebtClear(");
    const history = mainSource.indexOf("const historyRows = loadHistoryRows");
    const preEnqueueReload = mainSource.indexOf("const preEnqueueTargets = loadRebuildTargets");
    const secondGate = mainSource.indexOf(
      "assertProjectionRebuildCleanupDebtClear(",
      firstGate + 1
    );
    const enqueue = mainSource.indexOf(
      "enqueueProjectionEvents(configPath, selection.events)"
    );

    expect(firstGate).toBeGreaterThanOrEqual(0);
    expect(firstGate).toBeLessThan(history);
    expect(secondGate).toBeGreaterThan(preEnqueueReload);
    expect(secondGate).toBeLessThan(enqueue);

    const verifySource = source.slice(verifyStart);
    const verifyGate = verifySource.indexOf("assertProjectionRebuildCleanupDebtClear(");
    const verifyHistory = verifySource.indexOf("const historyRows = loadHistoryRows");
    const verifyEta = verifySource.indexOf("estimateProjectionRebuildEtaSeconds");
    expect(verifyGate).toBeGreaterThanOrEqual(0);
    expect(verifyGate).toBeLessThan(verifyHistory);
    expect(verifyGate).toBeLessThan(verifyEta);
  });

  it("performs no mutation or verification polling after a debt gate fails", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      for (const command of ["plan", "enqueue", "verify"]) {
        const { runtime, state } = emptyAuthorityRuntime([
          { vectorCleanupCount: 1, projectionDeletionCount: 0 }
        ]);
        await expect(runProjectionRebuildCommand(
          [command, "--config", "package.json"],
          runtime
        )).rejects.toThrow(/scheduled vector cleanup janitor/iu);
        expect(state.mutationCount).toBe(0);
        expect(state.labels).not.toContain("Load projection rebuild execution history");
        expect(state.labels).not.toContain("Load active projection snapshots");
        expect(state.cleanupCallCount).toBe(1);
      }

      const { runtime, state } = emptyAuthorityRuntime([
        { vectorCleanupCount: 0, projectionDeletionCount: 0 },
        { vectorCleanupCount: 0, projectionDeletionCount: 1 }
      ]);
      await expect(runProjectionRebuildCommand(
        ["enqueue", "--config", "package.json"],
        runtime
      )).rejects.toThrow(/No automated owner.*reviewed exact-owner recovery/isu);
      expect(state.cleanupCallCount).toBe(2);
      expect(state.mutationCount).toBe(0);
    } finally {
      stdout.mockRestore();
    }
  });
});

function emptyAuthorityRuntime(cleanupDebt: Array<{
  vectorCleanupCount: number;
  projectionDeletionCount: number;
}>) {
  const state = {
    cleanupCallCount: 0,
    labels: [] as string[],
    mutationCount: 0
  };
  return {
    state,
    runtime: {
      runQuery: (_database: string, _sql: string, _config: string, label: string) => {
        state.labels.push(label);
        if (label === "Load active search generation") {
          return [{ generation_id: "generation-alpha" }];
        }
        if (
          label === "Load authoritative projection rebuild targets" ||
          label === "Load authoritative projection rebuild memory heads" ||
          label === "Load active search projection ledger heads"
        ) {
          return [];
        }
        if (label === "Load headless search projection cleanup debt") {
          const value = cleanupDebt[Math.min(
            state.cleanupCallCount,
            cleanupDebt.length - 1
          )];
          state.cleanupCallCount += 1;
          return [{
            vector_cleanup_count: value?.vectorCleanupCount ?? 0,
            projection_deletion_count: value?.projectionDeletionCount ?? 0
          }];
        }
        throw new Error(`Unexpected projection rebuild query: ${label}`);
      },
      enqueueEvents: () => {
        state.mutationCount += 1;
      }
    }
  };
}

function createCleanupDebtDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE memory_projection_heads (
      generation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      PRIMARY KEY (generation_id, project_id, memory_id)
    ) WITHOUT ROWID;
    CREATE TABLE memory_search_vector_cleanup_receipts (
      generation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      vector_id TEXT NOT NULL,
      PRIMARY KEY (generation_id, project_id, memory_id, vector_id)
    ) WITHOUT ROWID;
    CREATE INDEX memory_search_vector_cleanup_by_owner
      ON memory_search_vector_cleanup_receipts(
        generation_id, project_id, memory_id, vector_id
      );
    CREATE TABLE memory_search_projection_deletions (
      generation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      project_version INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      PRIMARY KEY (generation_id, project_id, memory_id)
    ) WITHOUT ROWID;
  `);
  return database;
}

function seedVectorReceipt(
  database: DatabaseSync,
  generationId: string,
  projectId: string,
  memoryId: string,
  vectorSeed: string
): void {
  database.prepare(
    `INSERT INTO memory_search_vector_cleanup_receipts
     (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
     VALUES (?, ?, ?, 'revision-old', 'chunk-0', ?)`
  ).run(generationId, projectId, memoryId, vectorSeed.repeat(64));
}

function seedDeletion(
  database: DatabaseSync,
  generationId: string,
  projectId: string,
  memoryId: string
): void {
  database.prepare(
    `INSERT INTO memory_search_projection_deletions
     (generation_id, project_id, memory_id, revision_id, project_version, chunk_count)
     VALUES (?, ?, ?, 'revision-old', 1, 1)`
  ).run(generationId, projectId, memoryId);
}

function rebuildTargetQueryFake(foreignProjectId: string) {
  return (_database: string, _sql: string, _config: string, label: string) => {
    if (label === "Load active search generation") {
      return [{ generation_id: "generation-alpha" }];
    }
    if (label === "Load authoritative projection rebuild targets") {
      return [{
        project_id: "project:alpha",
        project_version: 3,
        memory_count: 0,
        revision_count: 0,
        scope_count: 0,
        content_bytes: 0
      }];
    }
    if (label === "Load authoritative projection rebuild memory heads") {
      return [];
    }
    if (label === "Load active search projection ledger heads") {
      return [{ project_id: foreignProjectId }];
    }
    throw new Error(`Unexpected projection rebuild query: ${label}`);
  };
}
