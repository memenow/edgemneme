import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const MIGRATION = "migrations/0015_github_sync_default_branch.sql";

const ASCII_EDGE_CONTROL_CASES = [
  ...Array.from({ length: 0x21 }, (_, codePoint) => codePoint),
  0x7f
].flatMap((codePoint) => {
  const character = String.fromCodePoint(codePoint);
  const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  return [
    { label: `${label} leading`, value: `${character}main` },
    { label: `${label} trailing`, value: `main${character}` }
  ];
});

const INVALID_DEFAULT_BRANCHES: ReadonlyArray<{
  label: string;
  value: string | null;
}> = [
  { label: "missing", value: null },
  { label: "empty", value: "" },
  { label: "control-only", value: "\t\n\r" },
  { label: "double-dot", value: "feature/../admin" },
  { label: "double-slash", value: "feature//admin" },
  { label: "leading-slash", value: "/main" },
  { label: "trailing-slash", value: "main/" },
  ...ASCII_EDGE_CONTROL_CASES
];

describe("GitHub sync default-branch migration", () => {
  it.each(INVALID_DEFAULT_BRANCHES)(
    "fails atomically for an enabled GitHub repository with $label default branch",
    ({ value }) => {
      const database = createRepositoryDatabase();
      database.prepare(
        `INSERT INTO repositories
         (repository_id, provider, default_branch, sync_enabled)
         VALUES ('repository-1', 'github', ?, 1)`
      ).run(value);

      expect(() => applyMigrationAtomically(database)).toThrow(
        /github_default_branch_preflight_failed/iu
      );
      expect(
        database.prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'trigger'
             AND name = 'repositories_github_sync_default_branch_insert_guard'`
        ).get()
      ).toEqual({ count: 0 });
      expect(
        database.prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table'
             AND name = 'migration_0015_github_default_branch_preflight'`
        ).get()
      ).toEqual({ count: 0 });
    }
  );

  it("requires a default branch whenever GitHub synchronization is enabled", () => {
    const database = createRepositoryDatabase();
    database.exec(`
      INSERT INTO repositories
        (repository_id, provider, default_branch, sync_enabled)
      VALUES
        ('repository-disabled', 'github', NULL, 0),
        ('repository-enabled', 'GitHub', 'main', 1),
        ('repository-other', 'gitlab', NULL, 1);
    `);
    applyMigrationAtomically(database);

    const invalidInsert = database.prepare(
      `INSERT INTO repositories
       (repository_id, provider, default_branch, sync_enabled)
       VALUES ('repository-invalid', 'github', ?, 1)`
    );
    const invalidUpdate = database.prepare(
      `UPDATE repositories SET default_branch = ?, sync_enabled = 1
       WHERE repository_id = 'repository-disabled'`
    );
    for (const { value } of INVALID_DEFAULT_BRANCHES) {
      expect(() => invalidInsert.run(value)).toThrow(
        /github repository default branch is required/iu
      );
      expect(() => invalidUpdate.run(value)).toThrow(
        /github repository default branch is required/iu
      );
    }
    expect(() =>
      database.prepare(
        `UPDATE repositories SET default_branch = NULL
         WHERE repository_id = 'repository-enabled'`
      ).run()
    ).toThrow(/github repository default branch is required/iu);
    expect(() =>
      database.prepare(
        `UPDATE repositories
         SET default_branch = NULL, sync_enabled = 0
         WHERE repository_id = 'repository-enabled'`
      ).run()
    ).not.toThrow();
    expect(() =>
      database.prepare(
        `UPDATE repositories SET default_branch = 'main', sync_enabled = 1
         WHERE repository_id = 'repository-disabled'`
      ).run()
    ).not.toThrow();
    expect(() =>
      database.prepare(
        `UPDATE repositories SET default_branch = NULL
         WHERE repository_id = 'repository-other'`
      ).run()
    ).not.toThrow();
  });
});

function createRepositoryDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE repositories (
      repository_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      default_branch TEXT,
      sync_enabled INTEGER NOT NULL
    );
  `);
  return database;
}

function applyMigrationAtomically(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(readFileSync(MIGRATION, "utf8"));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
