import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// Production maintenance schema probes are plain ESM for direct use in GitHub Actions.
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as maintenanceSchemaModule from "../scripts/d1-maintenance-schema.mjs";

const {
  expectedSchemaProbeRows,
  localMigrationFiles,
  parseSchemaInventory,
  remoteSchemaProbeSql
} = maintenanceSchemaModule;

type DatabaseName = "MEMORY_DB" | "SEARCH_DB";

interface SchemaProbe {
  objects: Record<string, unknown>[];
  columns: Record<string, unknown>[];
  foreignKeys: Record<string, unknown>[];
  indexes: Record<string, unknown>[];
}

const migrationDirectory = (database: DatabaseName) =>
  database === "MEMORY_DB" ? "migrations" : "migrations/search";

function executeRemoteSchemaProbe(database: DatabaseName, migrationCount: number): SchemaProbe {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys = ON;");
    for (const migration of localMigrationFiles(database).slice(0, migrationCount)) {
      sqlite.exec(readFileSync(join(migrationDirectory(database), migration), "utf8"));
    }
    const sql = remoteSchemaProbeSql(database);
    return {
      objects: sqlite.prepare(sql.objects).all() as Record<string, unknown>[],
      columns: sql.columns.flatMap((statement: string) =>
        sqlite.prepare(statement).all() as Record<string, unknown>[]
      ),
      foreignKeys: sql.foreignKeys.flatMap((statement: string) =>
        sqlite.prepare(statement).all() as Record<string, unknown>[]
      ),
      indexes: sql.indexes.flatMap((statement: string) =>
        sqlite.prepare(statement).all() as Record<string, unknown>[]
      )
    };
  } finally {
    sqlite.close();
  }
}

describe("remote D1 maintenance schema probes", () => {
  it.each([
    ["MEMORY_DB", 0],
    ["MEMORY_DB", localMigrationFiles("MEMORY_DB").length],
    ["SEARCH_DB", 0],
    ["SEARCH_DB", localMigrationFiles("SEARCH_DB").length]
  ] as const)("matches the local %s schema after %s migrations", (database, migrationCount) => {
    const expected = parseSchemaInventory(
      expectedSchemaProbeRows(database, migrationCount),
      database
    );
    const observed = parseSchemaInventory(
      executeRemoteSchemaProbe(database, migrationCount),
      database
    );
    expect(observed).toEqual(expected);
  });

  it.each(["MEMORY_DB", "SEARCH_DB"] as const)(
    "stays within remote %s SQL and batch limits",
    (database) => {
      const probe = remoteSchemaProbeSql(database);
      const detailStatements = [
        ...probe.columns,
        ...probe.foreignKeys,
        ...probe.indexes
      ];
      expect(detailStatements.length + 2).toBeLessThanOrEqual(64);
      for (const sql of detailStatements) {
        expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(100_000);
        expect(sql.split("\nUNION ALL\n").length).toBeLessThanOrEqual(5);
        expect(sql).not.toMatch(/pragma_[a-z_]+\(\s*(?:m|il)\.name\s*\)/iu);
      }
    }
  );
});
