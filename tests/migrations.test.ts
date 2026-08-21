import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

function objectNames(database: DatabaseSync, type: string): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all(type)
    .map((row) => (row as { name: string }).name);
}

describe("authority schema migration", () => {
  it("applies the squashed initial schema with the terminal object inventory", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync("migrations/0001_initial.sql", "utf8"));

    const tables = objectNames(database, "table");
    expect(tables).toContain("projects");
    expect(tables).toContain("memories");
    expect(tables).toContain("memory_versions");
    expect(tables).toContain("audit_events");
    expect(tables).toContain("sessions");
    expect(tables).toContain("repositories");
    expect(tables).toContain("memory_repository_contexts");
    expect(tables).toContain("project_grant_repository_contexts");
    expect(tables).toContain("github_tree_manifests");
    expect(tables).toContain("github_tree_ref_heads");
    expect(tables).toContain("github_repository_sync_runs");
    expect(tables).toContain("github_sync_dispatches");
    expect(tables).toContain("github_sync_dispatch_items");
    expect(tables).toContain("session_consolidations");
    expect(tables).toContain("consolidation_inputs");
    expect(tables).toContain("consolidation_batch_receipts");
    expect(tables).toContain("outbox_events");
    expect(tables).toContain("synthetic_cleanup_registry");
    expect(tables.some((name) => name.includes("preflight"))).toBe(false);

    const triggers = objectNames(database, "trigger");
    expect(triggers).toContain("audit_sequence_guard");
    expect(triggers).toContain("memory_version_guard");

    expect(
      database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_cursors'"
        )
        .get()
    ).toMatchObject({
      sql: expect.stringContaining("ref_scope_id")
    });
  });
});

describe("search schema migration", () => {
  it("applies the squashed search schema with the active generation seed", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync("migrations/search/0001_initial.sql", "utf8"));

    const tables = objectNames(database, "table");
    expect(tables).toContain("search_generations");
    expect(tables).toContain("memory_projection_heads");
    expect(tables).toContain("memory_fts_chunk_ledger");

    expect(
      database
        .prepare(
          "SELECT generation_id, embedding_dimensions, status FROM search_generations"
        )
        .all()
    ).toEqual([
      {
        generation_id: "qwen3-embedding-0.6b-chunk-2026-07-25",
        embedding_dimensions: 1024,
        status: "active"
      }
    ]);

    expect(
      database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_projection_heads'"
        )
        .get()
    ).toMatchObject({
      sql: expect.stringContaining("repository_partition")
    });
  });
});
