import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const LEASE_MIGRATION = "0016_consolidation_lease.sql";

describe("consolidation lease migration", () => {
  it("expands the schema without invalidating in-flight legacy workers", () => {
    const database = databaseBeforeLeaseMigration();
    try {
      seedConsolidations(database);
      database.exec(readFileSync(`migrations/${LEASE_MIGRATION}`, "utf8"));

      expect(
        database
          .prepare(
            `SELECT status, lease_owner, lease_expires_at, lease_operation_id,
                    lease_epoch
             FROM session_consolidations
             WHERE consolidation_id = 'consolidation-running'`
          )
          .get()
      ).toEqual({
        status: "running",
        lease_owner: null,
        lease_expires_at: null,
        lease_operation_id: null,
        lease_epoch: 0
      });

      expect(() =>
        database.exec(
          `UPDATE session_consolidations
           SET status = 'complete', updated_at = '2026-07-29T00:01:00.000Z'
           WHERE consolidation_id = 'consolidation-running'`
        )
      ).not.toThrow();
      expect(() =>
        database.exec(
          `UPDATE session_consolidations
           SET status = 'running', updated_at = '2026-07-29T00:01:00.000Z'
           WHERE consolidation_id = 'consolidation-queued'`
        )
      ).not.toThrow();
      expect(() =>
        database.exec(
          `UPDATE session_consolidations
           SET status = 'failed', updated_at = '2026-07-29T00:02:00.000Z'
           WHERE consolidation_id = 'consolidation-queued'`
        )
      ).not.toThrow();
      expect(() =>
        database.exec(
          `INSERT INTO session_consolidations
             (consolidation_id, project_id, session_id, session_version, status,
              input_digest, created_at, updated_at)
           VALUES
             ('consolidation-legacy', 'project-1', 'session-legacy', 2,
              'queued', 'digest-legacy', '2026-07-29T00:03:00.000Z',
              '2026-07-29T00:03:00.000Z')`
        )
      ).not.toThrow();

      expect(
        database
          .prepare(
            `SELECT status, lease_owner, lease_expires_at, lease_operation_id,
                    lease_epoch
             FROM session_consolidations ORDER BY consolidation_id`
          )
          .all()
      ).toEqual([
        {
          status: "queued",
          lease_owner: null,
          lease_expires_at: null,
          lease_operation_id: null,
          lease_epoch: 0
        },
        {
          status: "failed",
          lease_owner: null,
          lease_expires_at: null,
          lease_operation_id: null,
          lease_epoch: 0
        },
        {
          status: "complete",
          lease_owner: null,
          lease_expires_at: null,
          lease_operation_id: null,
          lease_epoch: 0
        }
      ]);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'trigger'
               AND name GLOB 'session_consolidations_lease_*_guard'`
          )
          .get()
      ).toEqual({ count: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok"
      });
    } finally {
      database.close();
    }
  });

  it("bounds the fencing epoch to JavaScript safe integers", () => {
    const database = databaseBeforeLeaseMigration();
    try {
      seedConsolidations(database);
      database.exec(readFileSync(`migrations/${LEASE_MIGRATION}`, "utf8"));

      expect(() =>
        database.exec(
          `UPDATE session_consolidations SET lease_epoch = 9007199254740991
           WHERE consolidation_id = 'consolidation-queued'`
        )
      ).not.toThrow();
      for (const invalidEpoch of [
        "-1",
        "1.5",
        "9007199254740992"
      ]) {
        expect(() =>
          database.exec(
            `UPDATE session_consolidations SET lease_epoch = ${invalidEpoch}
             WHERE consolidation_id = 'consolidation-running'`
          )
        ).toThrow(/check constraint failed/iu);
      }
    } finally {
      database.close();
    }
  });
});

function databaseBeforeLeaseMigration(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync("migrations")
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  const leaseMigrationIndex = migrations.indexOf(LEASE_MIGRATION);
  expect(leaseMigrationIndex).toBeGreaterThan(0);
  for (const migration of migrations.slice(0, leaseMigrationIndex)) {
    database.exec(readFileSync(`migrations/${migration}`, "utf8"));
  }
  return database;
}

function seedConsolidations(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, created_at, updated_at)
    VALUES
      ('project-1', 'project-1', 'project-1', 'Project',
       '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('principal-1', 'test', 'principal-1', 'digest-1',
       '2026-07-29T00:00:00.000Z');
    INSERT INTO sessions
      (session_id, project_id, principal_id, session_version, status,
       agent_meta_json, opened_at, closed_at)
    VALUES
      ('session-running', 'project-1', 'principal-1', 2, 'closed', '{}',
       '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'),
      ('session-queued', 'project-1', 'principal-1', 2, 'closed', '{}',
       '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z'),
      ('session-legacy', 'project-1', 'principal-1', 2, 'closed', '{}',
       '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z');
    INSERT INTO session_consolidations
      (consolidation_id, project_id, session_id, session_version, status,
       input_digest, created_at, updated_at)
    VALUES
      ('consolidation-running', 'project-1', 'session-running', 2, 'running',
       'digest-running', '2026-07-29T00:00:00.000Z',
       '2026-07-29T00:00:00.000Z'),
      ('consolidation-queued', 'project-1', 'session-queued', 2, 'queued',
       'digest-queued', '2026-07-29T00:00:00.000Z',
       '2026-07-29T00:00:00.000Z');
  `);
}
