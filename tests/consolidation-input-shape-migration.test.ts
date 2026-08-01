import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  "migrations/0020_consolidation_input_shape.sql",
  "utf8"
);

describe("consolidation input shape migration", () => {
  it("fails closed when legacy frozen inputs violate the bounded summary shape", () => {
    const database = createDatabase();
    seedConsolidation(database);
    database.exec(`
      INSERT INTO consolidation_inputs
        (project_id, consolidation_id, input_order, input_kind, source_id,
         content, content_sha256)
      VALUES
        ('project-1', 'consolidation-1', 1, 'summary', 'summary-1',
         'first summary', '${"a".repeat(64)}'),
        ('project-1', 'consolidation-1', 2, 'summary', 'summary-2',
         'second summary', '${"b".repeat(64)}');
    `);

    expect(() => database.exec(MIGRATION)).toThrow(
      /consolidation[_ ]input[_ ]shape[_ ]cutover[_ ]requires[_ ]canonical[_ ]inputs/iu
    );
  });

  it("enforces one summary while preserving candidate order compatibility", () => {
    const database = createDatabase();
    seedConsolidation(database);
    database.exec(MIGRATION);

    expect(() => insertInput(database, 0, "summary", "summary-0")).not.toThrow();
    expect(() => insertInput(database, 1, "candidate", "candidate-1")).not.toThrow();
    expect(() => insertInput(database, 50, "candidate", "candidate-50")).not.toThrow();
    expect(() => insertInput(database, 2, "summary", "summary-2")).toThrow(
      /only one summary/iu
    );

    const secondConsolidation = "consolidation-2";
    seedConsolidation(database, secondConsolidation, 2);
    expect(() =>
      insertInput(database, 0, "candidate", "candidate-0", secondConsolidation)
    ).not.toThrow();
    insertInput(database, 1, "summary", "summary-first", secondConsolidation);
    expect(() =>
      insertInput(database, 2, "summary", "summary-second", secondConsolidation)
    ).toThrow(/only one summary/iu);
  });
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, project_version,
       created_at, updated_at)
    VALUES
      ('project-1', 'project.one', 'project.one', 'Project One', 0,
       '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('principal-1', 'test', 'principal-1', 'digest-1',
       '2026-07-31T00:00:00.000Z');
    INSERT INTO sessions
      (session_id, project_id, principal_id, session_version, status,
       agent_meta_json, opened_at, closed_at)
    VALUES
      ('session-1', 'project-1', 'principal-1', 2, 'closed', '{}',
       '2026-07-31T00:00:00.000Z', '2026-07-31T00:01:00.000Z'),
      ('session-2', 'project-1', 'principal-1', 2, 'closed', '{}',
       '2026-07-31T00:00:00.000Z', '2026-07-31T00:01:00.000Z');
  `);
  return database;
}

function seedConsolidation(
  database: DatabaseSync,
  consolidationId = "consolidation-1",
  sessionNumber = 1
): void {
  database.prepare(
    `INSERT INTO session_consolidations
       (consolidation_id, project_id, session_id, session_version, status,
        input_digest, created_at, updated_at)
     VALUES (?, 'project-1', ?, 2, 'queued', ?,
             '2026-07-31T00:01:00.000Z', '2026-07-31T00:01:00.000Z')`
  ).run(consolidationId, `session-${sessionNumber}`, `digest-${consolidationId}`);
}

function insertInput(
  database: DatabaseSync,
  inputOrder: number,
  inputKind: "summary" | "candidate",
  sourceId: string,
  consolidationId = "consolidation-1"
): void {
  database.prepare(
    `INSERT INTO consolidation_inputs
       (project_id, consolidation_id, input_order, input_kind, source_id,
        content, content_sha256)
     VALUES ('project-1', ?, ?, ?, ?, ?, ?)`
  ).run(
    consolidationId,
    inputOrder,
    inputKind,
    sourceId,
    `${inputKind} content`,
    "b".repeat(64)
  );
}
