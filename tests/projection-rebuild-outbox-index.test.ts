import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// The deployment helper is plain ESM so GitHub Actions can run it without a TypeScript runtime.
// @ts-expect-error The JavaScript CLI has no separate declaration file.
import { projectionRebuildHistoryQuery } from "../scripts/enqueue-projection-rebuild.mjs";

const MIGRATION_DIRECTORY = join(process.cwd(), "migrations");
const INDEX_MIGRATION = "0012_projection_rebuild_outbox_index.sql";
const UNKNOWN_STATUS_MIGRATION = "0013_projection_rebuild_unknown_status.sql";
const INDEX_NAME = "outbox_projection_rebuild_history";
const DISPATCH_INDEX_NAME = "outbox_dispatch_ready";
const RECONCILE_INDEX_NAME = "outbox_projection_rebuild_reconcile";
const ORDINARY_RECONCILE_INDEX_NAME = "outbox_ordinary_workflow_reconcile";
const WORKFLOW_LATEST_INDEX_NAME = "workflow_runs_projection_rebuild_latest";
const REBUILD_TARGET_COUNT = 10_000;
const HISTORY_BATCH_SIZE = 50;

describe("projection rebuild outbox history index", () => {
  it("applies the complete authority migration history with the exact partial expression index", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyMigrations(database, authorityMigrationFiles());

      const index = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
        )
        .get(INDEX_NAME) as { sql: string } | undefined;
      const normalizedSql = index?.sql.replace(/\s+/gu, " ").trim();

      expect(normalizedSql).toBe(
        "CREATE INDEX outbox_projection_rebuild_history " +
          "ON outbox_events ( " +
          "json_extract(payload_json, '$.projectionTargetId'), " +
          "json_extract(payload_json, '$.executionOrdinal'), " +
          "event_id ) " +
          "WHERE event_type = 'projection.rebuild.requested' " +
          "AND event_id GLOB 'projection-rebuild:*' " +
          "AND json_extract(payload_json, '$.projectionMode') " +
          "IN ('snapshot', 'search', 'delete')"
      );
      expect(
        database
          .prepare(`PRAGMA index_list('outbox_events')`)
          .all()
          .find((row) => (row as { name?: unknown }).name === INDEX_NAME)
      ).toMatchObject({ partial: 1 });
      const dispatchIndex = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(DISPATCH_INDEX_NAME) as { sql: string } | undefined;
      expect(dispatchIndex?.sql.replace(/\s+/gu, " ").trim()).toBe(
        "CREATE INDEX outbox_dispatch_ready ON outbox_events (created_at, event_id) " +
          "WHERE dispatched_at IS NULL AND failed_at IS NULL"
      );
      expect(
        database
          .prepare(`PRAGMA index_list('outbox_events')`)
          .all()
          .find((row) => (row as { name?: unknown }).name === RECONCILE_INDEX_NAME)
      ).toMatchObject({ partial: 1 });
      const reconcileIndex = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(RECONCILE_INDEX_NAME) as { sql: string } | undefined;
      expect(reconcileIndex?.sql.replace(/\s+/gu, " ").trim()).toBe(
        "CREATE INDEX outbox_projection_rebuild_reconcile " +
          "ON outbox_events ( " +
          "COALESCE(next_attempt_at, ''), " +
          "json_extract(payload_json, '$.projectionTargetId'), " +
          "json_extract(payload_json, '$.executionOrdinal'), " +
          "event_id ) " +
          "WHERE event_type = 'projection.rebuild.requested' " +
          "AND event_id GLOB 'projection-rebuild:*' " +
          "AND json_extract(payload_json, '$.projectionMode') " +
          "IN ('snapshot', 'search', 'delete') " +
          "AND dispatched_at IS NOT NULL " +
          "AND failed_at IS NULL " +
          "AND ( " +
          "last_error_code IS NULL " +
          "OR last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN' " +
          ")"
      );
      const ordinaryReconcileIndex = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(ORDINARY_RECONCILE_INDEX_NAME) as { sql: string } | undefined;
      expect(ordinaryReconcileIndex?.sql.replace(/\s+/gu, " ").trim()).toBe(
        "CREATE INDEX outbox_ordinary_workflow_reconcile " +
          "ON outbox_events ( COALESCE(next_attempt_at, ''), created_at, event_id ) " +
          "WHERE event_type <> 'projection.rebuild.requested' " +
          "AND event_type IN ( " +
          "'candidate.submitted', 'candidate.reviewed', " +
          "'session.consolidation.requested', 'github.sync.requested', " +
          "'memory.changed' ) " +
          "AND dispatched_at IS NOT NULL AND failed_at IS NULL " +
          "AND ( last_error_code IS NULL " +
          "OR last_error_code IN ( " +
          "'WORKFLOW_RECONCILIATION_PENDING', 'WORKFLOW_CONTROL_PLANE_UNKNOWN' ) )"
      );
      expect(
        database
          .prepare(`PRAGMA index_list('outbox_events')`)
          .all()
          .find((row) => (row as { name?: unknown }).name === ORDINARY_RECONCILE_INDEX_NAME)
      ).toMatchObject({ partial: 1 });
      const workflowLatestIndex = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(WORKFLOW_LATEST_INDEX_NAME) as { sql: string } | undefined;
      expect(workflowLatestIndex?.sql.replace(/\s+/gu, " ").trim()).toBe(
        "CREATE INDEX workflow_runs_projection_rebuild_latest " +
          "ON workflow_runs ( project_id, root_workflow_id, updated_at DESC, workflow_id DESC )"
      );
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      database.close();
    }
  });

  it("adds constrained projection unknown-status observations with safe defaults", () => {
    const database = migratedDatabase();
    try {
      expect(
        database
          .prepare(
            `SELECT name, type, "notnull" AS not_null, dflt_value
             FROM pragma_table_info('outbox_events')
             WHERE name GLOB 'projection_unknown_*'
             ORDER BY cid`
          )
          .all()
      ).toEqual([
        {
          name: "projection_unknown_count",
          type: "INTEGER",
          not_null: 1,
          dflt_value: "0"
        },
        {
          name: "projection_unknown_first_observed_at",
          type: "TEXT",
          not_null: 0,
          dflt_value: null
        },
        {
          name: "projection_unknown_last_observed_at",
          type: "TEXT",
          not_null: 0,
          dflt_value: null
        },
        {
          name: "projection_unknown_alerted_at",
          type: "TEXT",
          not_null: 0,
          dflt_value: null
        }
      ]);

      seedProject(database);
      insertRebuildEvent(database, 1);
      const eventId = `projection-rebuild:search:${projectionTargetId(1)}`;
      expect(
        database
          .prepare(
            `SELECT projection_unknown_count, projection_unknown_first_observed_at,
                    projection_unknown_last_observed_at, projection_unknown_alerted_at
             FROM outbox_events WHERE event_id = ?`
          )
          .get(eventId)
      ).toEqual({
        projection_unknown_count: 0,
        projection_unknown_first_observed_at: null,
        projection_unknown_last_observed_at: null,
        projection_unknown_alerted_at: null
      });
      expect(() =>
        database
          .prepare(
            `UPDATE outbox_events SET projection_unknown_count = -1
             WHERE event_id = ?`
          )
          .run(eventId)
      ).toThrow(/check constraint failed/iu);
      expect(() =>
        database
          .prepare(
            `UPDATE outbox_events SET projection_unknown_count = 13
             WHERE event_id = ?`
          )
          .run(eventId)
      ).toThrow(/check constraint failed/iu);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      database.close();
    }
  });

  it("rolls back a failed index migration completely and permits a clean retry", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const migrations = authorityMigrationFiles();
      const migrationIndex = migrations.indexOf(INDEX_MIGRATION);
      expect(migrationIndex).toBeGreaterThan(0);
      applyMigrations(database, migrations.slice(0, migrationIndex));
      const migration = readFileSync(join(MIGRATION_DIRECTORY, INDEX_MIGRATION), "utf8");

      expect(() =>
        executeMigrationAtomically(
          database,
          `${migration}\nCREATE INDEX forced_projection_rebuild_failure ` +
            "ON missing_outbox_table(event_id);"
        )
      ).toThrow(/missing_outbox_table|no such table/iu);
      expect(schemaObjectCount(database, "index", INDEX_NAME)).toBe(0);
      expect(schemaObjectCount(database, "index", DISPATCH_INDEX_NAME)).toBe(0);
      expect(schemaObjectCount(database, "index", RECONCILE_INDEX_NAME)).toBe(0);
      expect(schemaObjectCount(database, "index", WORKFLOW_LATEST_INDEX_NAME)).toBe(0);
      expect(schemaObjectCount(database, "index", "forced_projection_rebuild_failure")).toBe(0);

      expect(() => executeMigrationAtomically(database, migration)).not.toThrow();
      expect(schemaObjectCount(database, "index", INDEX_NAME)).toBe(1);
      expect(schemaObjectCount(database, "index", DISPATCH_INDEX_NAME)).toBe(1);
      expect(schemaObjectCount(database, "index", RECONCILE_INDEX_NAME)).toBe(1);
      expect(schemaObjectCount(database, "index", WORKFLOW_LATEST_INDEX_NAME)).toBe(1);
      expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      database.close();
    }
  });

  it("rolls back a failed unknown-status migration and restores the prior index", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const migrations = authorityMigrationFiles();
      const migrationIndex = migrations.indexOf(UNKNOWN_STATUS_MIGRATION);
      expect(migrationIndex).toBeGreaterThan(0);
      applyMigrations(database, migrations.slice(0, migrationIndex));
      const priorIndexSql = normalizedSchemaSql(database, "index", RECONCILE_INDEX_NAME);
      expect(priorIndexSql).toContain("AND last_error_code IS NULL");
      const migration = readFileSync(
        join(MIGRATION_DIRECTORY, UNKNOWN_STATUS_MIGRATION),
        "utf8"
      );

      expect(() =>
        executeMigrationAtomically(
          database,
          `${migration}\nCREATE INDEX forced_projection_unknown_failure ` +
            "ON missing_outbox_table(event_id);"
        )
      ).toThrow(/missing_outbox_table|no such table/iu);
      expect(projectionUnknownColumnNames(database)).toEqual([]);
      expect(normalizedSchemaSql(database, "index", RECONCILE_INDEX_NAME)).toBe(
        priorIndexSql
      );
      expect(schemaObjectCount(database, "index", "forced_projection_unknown_failure")).toBe(0);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });

      expect(() => executeMigrationAtomically(database, migration)).not.toThrow();
      expect(projectionUnknownColumnNames(database)).toEqual([
        "projection_unknown_count",
        "projection_unknown_first_observed_at",
        "projection_unknown_last_observed_at",
        "projection_unknown_alerted_at"
      ]);
      expect(normalizedSchemaSql(database, "index", RECONCILE_INDEX_NAME)).toContain(
        "OR last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'"
      );
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      database.close();
    }
  });

  it("uses the partial expression index for the exact rebuild-history query", () => {
    const database = migratedDatabase();
    try {
      seedProject(database);
      insertRebuildEvent(database, 1);
      const query = projectionRebuildHistoryQuery([projectionTargetId(1)]);
      const details = queryPlanDetails(database, query);

      expectIndexedHistoryPlan(details);
      expect(database.prepare(query).all()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("uses the partial ready index for deterministic global outbox dispatch", () => {
    const database = migratedDatabase();
    try {
      seedProject(database);
      insertRebuildEvent(database, 1);
      const query = `SELECT event_id, project_id, project_version, event_type,
                            payload_digest, payload_json, attempt
                     FROM outbox_events
                     WHERE dispatched_at IS NULL AND failed_at IS NULL
                       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                     ORDER BY created_at ASC, event_id ASC LIMIT ?`;
      const details = queryPlanDetails(database, query);

      expect(
        details.some(
          (detail) =>
            detail.includes(`USING INDEX ${DISPATCH_INDEX_NAME}`) ||
            detail.includes(`USING COVERING INDEX ${DISPATCH_INDEX_NAME}`)
        )
      ).toBe(true);
      expect(details.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
      expect(database.prepare(query).all("2026-07-28T00:01:00.000Z", 250)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("uses the reconciliation index for the exact dispatched-rebuild scan", () => {
    const database = migratedDatabase();
    try {
      seedProject(database);
      insertRebuildEvent(database, 1);
      insertRebuildEvent(database, 2);
      database
        .prepare(
          `UPDATE outbox_events
           SET dispatched_at = '2026-07-28T00:00:30.000Z'
           WHERE event_id IN (?, ?)`
        )
        .run(
          `projection-rebuild:search:${projectionTargetId(1)}`,
          `projection-rebuild:delete:${projectionTargetId(2)}`
        );
      database
        .prepare(
          `UPDATE outbox_events
           SET last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN',
               projection_unknown_count = 12,
               projection_unknown_first_observed_at = '2026-07-28T00:00:30.000Z',
               projection_unknown_last_observed_at = '2026-07-28T00:55:30.000Z',
               projection_unknown_alerted_at = '2026-07-28T00:55:30.000Z'
           WHERE event_id = ?`
        )
        .run(`projection-rebuild:delete:${projectionTargetId(2)}`);
      const query = `SELECT e.event_id, e.project_id, e.project_version, e.event_type,
                            e.payload_digest, e.payload_json, e.dispatched_at, e.next_attempt_at,
                            e.last_error_code, e.projection_unknown_count,
                            latest.workflow_id AS latest_workflow_id,
                            latest.status AS latest_workflow_status
                     FROM outbox_events AS e INDEXED BY outbox_projection_rebuild_reconcile
                     LEFT JOIN workflow_runs AS latest
                       ON latest.workflow_id = (
                         SELECT candidate.workflow_id
                         FROM workflow_runs AS candidate
                         WHERE candidate.project_id = e.project_id
                           AND candidate.root_workflow_id = e.event_id
                         ORDER BY candidate.updated_at DESC, candidate.workflow_id DESC
                         LIMIT 1
                       )
                     WHERE e.event_type = 'projection.rebuild.requested'
                       AND e.event_id GLOB 'projection-rebuild:*'
                       AND json_extract(e.payload_json, '$.projectionMode')
                           IN ('snapshot', 'search', 'delete')
                       AND e.dispatched_at IS NOT NULL
                       AND e.failed_at IS NULL
                       AND (
                         e.last_error_code IS NULL
                         OR e.last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'
                       )
                       AND COALESCE(e.next_attempt_at, '') <= ?
                       AND (
                         COALESCE(e.next_attempt_at, ''),
                         json_extract(e.payload_json, '$.projectionTargetId'),
                         json_extract(e.payload_json, '$.executionOrdinal'),
                         e.event_id
                       ) > (?, ?, ?, ?)
                     ORDER BY
                       COALESCE(e.next_attempt_at, ''),
                       json_extract(e.payload_json, '$.projectionTargetId'),
                       json_extract(e.payload_json, '$.executionOrdinal'),
                       e.event_id
                     LIMIT ?`;
      const args = ["2026-07-28T00:01:00.000Z", "", "", -1, "", 20] as const;
      const details = queryPlanDetails(database, query, ...args);

      expect(
        details.some((detail) => detail.includes(`USING INDEX ${RECONCILE_INDEX_NAME}`))
      ).toBe(true);
      expect(
        details.some((detail) => detail.includes(WORKFLOW_LATEST_INDEX_NAME))
      ).toBe(true);
      expect(details.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
      expect(database.prepare(query).all(...args)).toEqual([
        expect.objectContaining({
          event_id: `projection-rebuild:search:${projectionTargetId(1)}`
        }),
        expect.objectContaining({
          event_id: `projection-rebuild:delete:${projectionTargetId(2)}`
        })
      ]);
    } finally {
      database.close();
    }
  });

  it("uses the ordinary reconciliation index without a table scan or sort", () => {
    const database = migratedDatabase();
    try {
      seedProject(database);
      const insert = database.prepare(
        `INSERT INTO outbox_events
           (event_id, project_id, project_version, event_type, payload_digest,
            payload_json, dispatched_at, next_attempt_at, last_error_code, created_at)
         VALUES (?, 'project-index-test', 1, ?, ?, ?,
                 '2026-07-28T00:00:30.000Z', ?, ?, ?)`
      );
      insert.run(
        "candidate-due",
        "candidate.submitted",
        "candidate-digest",
        JSON.stringify({ type: "candidate.submitted" }),
        null,
        null,
        "2026-07-28T00:00:00.000Z"
      );
      insert.run(
        "memory-due",
        "memory.changed",
        "memory-digest",
        JSON.stringify({ type: "memory.changed" }),
        "2026-07-28T00:04:00.000Z",
        "WORKFLOW_CONTROL_PLANE_UNKNOWN",
        "2026-07-28T00:00:01.000Z"
      );
      insert.run(
        "candidate-future",
        "candidate.submitted",
        "future-digest",
        JSON.stringify({ type: "candidate.submitted" }),
        "2026-07-28T00:06:00.000Z",
        "WORKFLOW_RECONCILIATION_PENDING",
        "2026-07-28T00:00:02.000Z"
      );
      insert.run(
        "projection-excluded",
        "projection.rebuild.requested",
        "projection-digest",
        JSON.stringify({ type: "projection.rebuild.requested" }),
        null,
        null,
        "2026-07-28T00:00:03.000Z"
      );
      const query = `SELECT e.event_id, latest.status AS latest_workflow_status
                     FROM outbox_events AS e
                       INDEXED BY outbox_ordinary_workflow_reconcile
                     LEFT JOIN workflow_runs AS latest
                       ON latest.workflow_id = (
                         SELECT candidate.workflow_id
                         FROM workflow_runs AS candidate
                         WHERE candidate.project_id = e.project_id
                           AND candidate.root_workflow_id = CASE
                             WHEN e.event_type = 'memory.changed'
                               THEN e.project_id || ':' || e.project_version
                             ELSE e.event_id
                           END
                         ORDER BY candidate.updated_at DESC, candidate.workflow_id DESC
                         LIMIT 1
                       )
                     WHERE e.event_type <> 'projection.rebuild.requested'
                       AND e.event_type IN (
                         'candidate.submitted', 'candidate.reviewed',
                         'session.consolidation.requested', 'github.sync.requested',
                         'memory.changed'
                       )
                       AND e.dispatched_at IS NOT NULL AND e.failed_at IS NULL
                       AND (
                         e.last_error_code IS NULL
                         OR e.last_error_code IN (
                           'WORKFLOW_RECONCILIATION_PENDING',
                           'WORKFLOW_CONTROL_PLANE_UNKNOWN'
                         )
                       )
                       AND COALESCE(e.next_attempt_at, '') <= ?
                     ORDER BY COALESCE(e.next_attempt_at, ''), e.created_at, e.event_id
                     LIMIT ?`;
      const args = ["2026-07-28T00:05:00.000Z", 20] as const;
      const details = queryPlanDetails(database, query, ...args);

      expect(
        details.some((detail) => detail.includes(`USING INDEX ${ORDINARY_RECONCILE_INDEX_NAME}`))
      ).toBe(true);
      expect(details.some((detail) => detail.includes(WORKFLOW_LATEST_INDEX_NAME))).toBe(true);
      expect(details.some((detail) => detail.includes("SCAN e"))).toBe(false);
      expect(details.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
      expect(database.prepare(query).all(...args)).toEqual([
        { event_id: "candidate-due", latest_workflow_status: null },
        { event_id: "memory-due", latest_workflow_status: null }
      ]);
    } finally {
      database.close();
    }
  });

  it("bounds 10,000 target-history lookups to indexed batches without indexing ordinary events", () => {
    const database = migratedDatabase();
    try {
      seedProject(database);
      database.exec("BEGIN IMMEDIATE");
      try {
        for (let index = 0; index < REBUILD_TARGET_COUNT; index += 1) {
          insertRebuildEvent(database, index);
        }
        insertNonRebuildEvents(database);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      const targetIds = Array.from(
        { length: REBUILD_TARGET_COUNT },
        (_, index) => projectionTargetId(index)
      );
      let statementCount = 0;
      let resultCount = 0;
      for (let start = 0; start < targetIds.length; start += HISTORY_BATCH_SIZE) {
        const query = projectionRebuildHistoryQuery(
          targetIds.slice(start, start + HISTORY_BATCH_SIZE)
        );
        const details = queryPlanDetails(database, query);
        expectIndexedHistoryPlan(details);
        resultCount += database.prepare(query).all().length;
        statementCount += 1;
      }

      expect(statementCount).toBe(REBUILD_TARGET_COUNT / HISTORY_BATCH_SIZE);
      expect(resultCount).toBe(REBUILD_TARGET_COUNT);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM outbox_events INDEXED BY outbox_projection_rebuild_history
             WHERE event_type = 'projection.rebuild.requested'
               AND event_id GLOB 'projection-rebuild:*'
               AND json_extract(payload_json, '$.projectionMode')
                   IN ('snapshot', 'search', 'delete')`
          )
          .get()
      ).toEqual({ count: REBUILD_TARGET_COUNT });
      expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_events").get()).toEqual({
        count: REBUILD_TARGET_COUNT + 2
      });
    } finally {
      database.close();
    }
  });
});

function authorityMigrationFiles(): string[] {
  return readdirSync(MIGRATION_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[0-9]{4}_.+\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function applyMigrations(database: DatabaseSync, migrations: string[]): void {
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of migrations) {
    database.exec(readFileSync(join(MIGRATION_DIRECTORY, migration), "utf8"));
  }
}

function executeMigrationAtomically(database: DatabaseSync, migration: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(migration);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, authorityMigrationFiles());
  return database;
}

function seedProject(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO projects
       (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
     VALUES ('project-index-test', 'project.index-test', 'project.index-test',
             'Index Test', 1, '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z')`
  ).run();
}

function insertRebuildEvent(database: DatabaseSync, index: number): void {
  const targetId = projectionTargetId(index);
  const mode = ["snapshot", "search", "delete"][index % 3];
  const payload = JSON.stringify({
    type: "projection.rebuild.requested",
    eventId: `projection-rebuild:${mode}:${targetId}`,
    projectId: "project-index-test",
    projectVersion: 1,
    projectionMode: mode,
    searchGenerationId: "generation-index-test",
    projectionTargetId: targetId,
    executionOrdinal: index % 10_000
  });
  database.prepare(
    `INSERT INTO outbox_events
       (event_id, project_id, project_version, event_type, payload_digest,
        payload_json, created_at)
     VALUES (?, 'project-index-test', 1, 'projection.rebuild.requested', ?, ?,
             '2026-07-28T00:00:00.000Z')`
  ).run(`projection-rebuild:${mode}:${targetId}`, `digest-${index}`, payload);
}

function insertNonRebuildEvents(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO outbox_events
       (event_id, project_id, project_version, event_type, payload_digest,
        payload_json, created_at)
     VALUES (?, 'project-index-test', 1, 'memory.changed', ?, ?,
             '2026-07-28T00:00:00.000Z')`
  ).run(
    "ordinary-memory-change",
    "ordinary-digest",
    JSON.stringify({
      projectionMode: "snapshot",
      projectionTargetId: "f".repeat(64),
      executionOrdinal: 0
    })
  );
  database.prepare(
    `INSERT INTO outbox_events
       (event_id, project_id, project_version, event_type, payload_digest,
        payload_json, created_at)
     VALUES (?, 'project-index-test', 1, 'projection.rebuild.requested', ?, ?,
             '2026-07-28T00:00:00.000Z')`
  ).run(
    `projection-rebuild:invalid:${"e".repeat(64)}`,
    "invalid-mode-digest",
    JSON.stringify({
      projectionMode: "invalid",
      projectionTargetId: "e".repeat(64),
      executionOrdinal: 0
    })
  );
}

function projectionTargetId(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function queryPlanDetails(
  database: DatabaseSync,
  query: string,
  ...args: Array<string | number | bigint | Uint8Array | null>
): string[] {
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args) as Array<{ detail: string }>
  ).map((row) => row.detail);
}

function expectIndexedHistoryPlan(details: string[]): void {
  for (const alias of ["first", "latest"]) {
    expect(
      details.some(
        (detail) =>
          detail.startsWith(`SEARCH ${alias} USING INDEX `) && detail.includes(INDEX_NAME)
      )
    ).toBe(true);
  }
  expect(details.some((detail) => detail.includes("SCAN outbox_events"))).toBe(false);
}

function schemaObjectCount(database: DatabaseSync, type: string, name: string): number {
  return (
    database
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ? AND name = ?")
      .get(type, name) as { count: number }
  ).count;
}

function projectionUnknownColumnNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM pragma_table_info('outbox_events')
         WHERE name GLOB 'projection_unknown_*'
         ORDER BY cid`
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function normalizedSchemaSql(database: DatabaseSync, type: string, name: string): string {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
    .get(type, name) as { sql: string } | undefined;
  expect(row).toBeDefined();
  return row!.sql.replace(/\s+/gu, " ").trim();
}
