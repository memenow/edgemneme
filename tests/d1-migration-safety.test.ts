import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// The helper is plain ESM so GitHub Actions can run it without a TypeScript runtime.
// @ts-expect-error The JavaScript CLI has no separate declaration file.
import * as migrationSafety from "../scripts/d1-migration-safety.mjs";

const {
  buildSearchKeysetPredicate,
  buildBackupManifest,
  detectSearchTablePresence,
  extractD1PageRows,
  validateBackupManifest,
  validateD1IntegrityOutput,
  validateD1SchemaOutput,
  validateSearchSnapshotCountOutput
} = migrationSafety;

const memoryBookmark = "11111111-22222222-33333333-44444444444444444444444444444444";
const searchBookmark = "aaaaaaaa-bbbbbbbb-cccccccc-dddddddddddddddddddddddddddddddd";
const wranglerIntegrationTimeoutMs = 60_000;

function d1Result(results: Array<Record<string, unknown>>) {
  return [{ results, success: true, meta: { duration: 1 } }];
}

function runCommand(command: string, args: string[], label: string) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false"
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: wranglerIntegrationTimeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${label} failed with status ${result.status ?? "unknown"}.\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      { cause: result.error }
    );
  }
  return result.stdout;
}

function migratedSchemaRows(database: "MEMORY_DB" | "SEARCH_DB") {
  const directory =
    database === "MEMORY_DB"
      ? join(process.cwd(), "migrations")
      : join(process.cwd(), "migrations", "search");
  const migrationFiles = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[0-9]{4}_.+\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec("PRAGMA foreign_keys = ON;");
    for (const migration of migrationFiles) {
      reference.exec(readFileSync(join(directory, migration), "utf8"));
    }
    return reference
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL")
      .all() as Array<Record<string, unknown>>;
  } finally {
    reference.close();
  }
}

function backupInput() {
  return {
    createdAt: "2026-07-28T14:00:00.000Z",
    sourceCommit: "671343c355ffa64a6202b8275a55f066e7fd0aee",
    runId: "12345",
    runAttempt: "2",
    memoryBookmarkBefore: JSON.stringify({ bookmark: memoryBookmark }),
    memoryBookmarkAfter: JSON.stringify({ bookmark: memoryBookmark }),
    searchBookmarkBefore: JSON.stringify({ bookmark: searchBookmark }),
    searchBookmarkAfter: JSON.stringify({ bookmark: searchBookmark }),
    files: {
      "memory.sql": Buffer.from("CREATE TABLE projects (project_id TEXT PRIMARY KEY);\n"),
      "search-generations.jsonl": Buffer.from('{"generation_id":"generation-1"}\n'),
      "memory-fts.jsonl": Buffer.from(""),
      "memory-projection-heads.jsonl": Buffer.from(
        '{"generation_id":"generation-1","memory_id":"memory-1"}\n'
      ),
      "memory-fts-chunk-ledger.jsonl": Buffer.from(
        '{"fts_rowid":1,"generation_id":"generation-1","memory_id":"memory-1"}\n'
      ),
      "memory-search-projection-deletions.jsonl": Buffer.from(""),
      "memory-search-projection-write-leases.jsonl": Buffer.from(
        '{"generation_id":"generation-1","project_id":"project-1","memory_id":"memory-1"}\n'
      ),
      "memory-search-vector-cleanup-receipts.jsonl": Buffer.from(
        '{"generation_id":"generation-1","memory_id":"memory-1","vector_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n'
      ),
      "memory-search-vector-cleanup-janitor-state.jsonl": Buffer.from(
        '{"state_id":1,"cursor_generation_id":"generation-1","cursor_project_id":"project-1","cursor_memory_id":"memory-1","updated_at":"2026-07-28T14:00:00.000Z"}\n'
      )
    }
  };
}

describe("D1 migration backup safety", () => {
  it("builds a complete manifest with exact stable bookmarks and content checksums", () => {
    const input = backupInput();
    const manifest = buildBackupManifest(input);

    expect(manifest).toMatchObject({
      format: "edgemneme.d1-migration-backup",
      status: "complete",
      created_at: input.createdAt,
      source_commit: input.sourceCommit,
      workflow: { run_id: input.runId, run_attempt: input.runAttempt },
      databases: {
        memory: { binding: "MEMORY_DB", bookmark: memoryBookmark },
        search: {
          binding: "SEARCH_DB",
          bookmark: searchBookmark,
          export_boundary: "logical-snapshot-required-because-fts5-is-not-exportable"
        }
      }
    });
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "memory.sql",
          sha256: createHash("sha256").update(input.files["memory.sql"]).digest("hex")
        }),
        expect.objectContaining({ name: "memory-fts.jsonl", records: 0 }),
        expect.objectContaining({ name: "memory-fts-chunk-ledger.jsonl", records: 1 }),
        expect.objectContaining({
          name: "memory-search-projection-deletions.jsonl",
          records: 0
        }),
        expect.objectContaining({
          name: "memory-search-projection-write-leases.jsonl",
          records: 1
        }),
        expect.objectContaining({
          name: "memory-search-vector-cleanup-receipts.jsonl",
          records: 1
        }),
        expect.objectContaining({
          name: "memory-search-vector-cleanup-janitor-state.jsonl",
          records: 1,
          sha256: createHash("sha256")
            .update(input.files["memory-search-vector-cleanup-janitor-state.jsonl"])
            .digest("hex")
        })
      ])
    );
    expect(JSON.stringify(manifest)).not.toContain("database_id");
  });

  it("rejects a backup captured while either database was changing", () => {
    expect(() =>
      buildBackupManifest({
        ...backupInput(),
        memoryBookmarkAfter: JSON.stringify({
          bookmark: "11111112-22222222-33333333-44444444444444444444444444444444"
        })
      })
    ).toThrow(/changed while the backup was captured/iu);
  });

  it("rejects malformed bookmarks and modified backup objects", () => {
    expect(() =>
      buildBackupManifest({
        ...backupInput(),
        searchBookmarkAfter: JSON.stringify({ bookmark: "not-a-bookmark" })
      })
    ).toThrow(/bookmark/iu);

    const input = backupInput();
    const manifest = buildBackupManifest(input);
    expect(() =>
      validateBackupManifest(manifest, {
        ...input.files,
        "memory.sql": Buffer.from("modified")
      })
    ).toThrow(/checksum|size/iu);
    expect(() =>
      validateBackupManifest(manifest, {
        ...input.files,
        "memory-search-vector-cleanup-janitor-state.jsonl": Buffer.from('{"state_id":1}\n')
      })
    ).toThrow(/checksum|size/iu);
  });

  it("extracts only one successful D1 query result page", () => {
    expect(extractD1PageRows(JSON.stringify(d1Result([{ id: "one" }, { id: "two" }])))).toEqual([
      { id: "one" },
      { id: "two" }
    ]);
    expect(() => extractD1PageRows("not-json")).toThrow(/JSON/iu);
    expect(() =>
      extractD1PageRows(JSON.stringify([{ results: [], success: false }]))
    ).toThrow(/successful/iu);
  });

  it("probes only the eight controlled Search snapshot tables and fails closed on malformed output", () => {
    const controlledTables = [
      "search_generations",
      "memory_fts",
      "memory_projection_heads",
      "memory_fts_chunk_ledger",
      "memory_search_projection_deletions",
      "memory_search_projection_write_leases",
      "memory_search_vector_cleanup_receipts",
      "memory_search_vector_cleanup_janitor_state"
    ];

    for (const table of controlledTables) {
      expect(detectSearchTablePresence(JSON.stringify(d1Result([])), table)).toBe(false);
      expect(
        detectSearchTablePresence(JSON.stringify(d1Result([{ table_name: table }])), table)
      ).toBe(true);
    }

    expect(() =>
      detectSearchTablePresence(
        JSON.stringify(d1Result([{ table_name: "memory_projection_heads" }])),
        "memory_fts_chunk_ledger"
      )
    ).toThrow(/presence output/iu);
    expect(() =>
      detectSearchTablePresence(
        JSON.stringify(d1Result([{ table_name: "search_generations", unexpected: true }])),
        "search_generations"
      )
    ).toThrow(/presence output/iu);
    expect(() =>
      detectSearchTablePresence(JSON.stringify(d1Result([])), "unexpected_search_table")
    ).toThrow(/Search.*tables/iu);
  });

  it("builds injection-safe keyset predicates for integer and composite text cursors", () => {
    expect(
      buildSearchKeysetPredicate(
        JSON.stringify({ fts_rowid: 25 }),
        JSON.stringify({ fts_rowid: "rowid" })
      )
    ).toBe("WHERE rowid > 25");
    expect(
      buildSearchKeysetPredicate(
        JSON.stringify({ generation_id: "generation'1", project_id: "project-1" }),
        JSON.stringify({ generation_id: "generation_id", project_id: "project_id" })
      )
    ).toBe(
      "WHERE (generation_id, project_id) > " +
        "(CAST(X'67656e65726174696f6e2731' AS TEXT), CAST(X'70726f6a6563742d31' AS TEXT))"
    );
    expect(() =>
      buildSearchKeysetPredicate(
        JSON.stringify({ generation_id: "generation-1" }),
        JSON.stringify({ generation_id: "generation_id; DROP TABLE memory_fts" })
      )
    ).toThrow(/SQL identifier/iu);
  });

  it("requires logical Search snapshots to match the authoritative row counts", () => {
    const snapshots = {
      "search-generations.jsonl": Buffer.from('{"generation_id":"generation-1"}\n'),
      "memory-fts.jsonl": Buffer.from(""),
      "memory-projection-heads.jsonl": Buffer.from('{"memory_id":"memory-1"}\n'),
      "memory-fts-chunk-ledger.jsonl": Buffer.from('{"fts_rowid":1}\n'),
      "memory-search-projection-deletions.jsonl": Buffer.from(""),
      "memory-search-projection-write-leases.jsonl": Buffer.from('{"memory_id":"memory-1"}\n'),
      "memory-search-vector-cleanup-receipts.jsonl": Buffer.from('{"vector_id":"one"}\n'),
      "memory-search-vector-cleanup-janitor-state.jsonl": Buffer.from('{"state_id":1}\n')
    };
    const counts = d1Result([
      {
        search_generations: 1,
        memory_fts: 0,
        memory_projection_heads: 1,
        memory_fts_chunk_ledger: 1,
        memory_search_projection_deletions: 0,
        memory_search_projection_write_leases: 1,
        memory_search_vector_cleanup_receipts: 1,
        memory_search_vector_cleanup_janitor_state: 1
      }
    ]);

    expect(() => validateSearchSnapshotCountOutput(JSON.stringify(counts), snapshots)).not.toThrow();
    expect(() =>
      validateSearchSnapshotCountOutput(
        JSON.stringify(
          d1Result([
            {
              search_generations: 1,
              memory_fts: 0,
              memory_projection_heads: 1,
              memory_fts_chunk_ledger: 1,
              memory_search_projection_deletions: 0,
              memory_search_projection_write_leases: 1,
              memory_search_vector_cleanup_receipts: 1,
              memory_search_vector_cleanup_janitor_state: 2
            }
          ])
        ),
        snapshots
      )
    ).toThrow(/row count/iu);
  });

  it("accepts explicit empty snapshots for ledger tables that do not exist yet", () => {
    const snapshots = {
      "search-generations.jsonl": Buffer.from('{"generation_id":"generation-1"}\n'),
      "memory-fts.jsonl": Buffer.from(""),
      "memory-projection-heads.jsonl": Buffer.from(""),
      "memory-fts-chunk-ledger.jsonl": Buffer.from(""),
      "memory-search-projection-deletions.jsonl": Buffer.from(""),
      "memory-search-projection-write-leases.jsonl": Buffer.from(""),
      "memory-search-vector-cleanup-receipts.jsonl": Buffer.from(""),
      "memory-search-vector-cleanup-janitor-state.jsonl": Buffer.from("")
    };
    const counts = d1Result([
      {
        search_generations: 1,
        memory_fts: 0,
        memory_projection_heads: 0,
        memory_fts_chunk_ledger: 0,
        memory_search_projection_deletions: 0,
        memory_search_projection_write_leases: 0,
        memory_search_vector_cleanup_receipts: 0,
        memory_search_vector_cleanup_janitor_state: 0
      }
    ]);

    expect(() => validateSearchSnapshotCountOutput(JSON.stringify(counts), snapshots)).not.toThrow();
  });

  it("gates every Search snapshot and row count on the same fixed table-presence probe", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "migrate-d1.yml"),
      "utf8"
    );
    const snapshots = [
      {
        table: "search_generations",
        label: "search-generations",
        query: "SELECT * FROM search_generations"
      },
      {
        table: "memory_fts",
        label: "memory-fts",
        query: "SELECT rowid AS fts_rowid, * FROM memory_fts"
      },
      {
        table: "memory_projection_heads",
        label: "memory-projection-heads",
        query: "SELECT * FROM memory_projection_heads"
      },
      {
        table: "memory_fts_chunk_ledger",
        label: "memory-fts-chunk-ledger",
        query: "SELECT * FROM memory_fts_chunk_ledger"
      },
      {
        table: "memory_search_projection_deletions",
        label: "memory-search-projection-deletions",
        query: "SELECT * FROM memory_search_projection_deletions"
      },
      {
        table: "memory_search_projection_write_leases",
        label: "memory-search-projection-write-leases",
        query: "SELECT * FROM memory_search_projection_write_leases"
      },
      {
        table: "memory_search_vector_cleanup_receipts",
        label: "memory-search-vector-cleanup-receipts",
        query: "SELECT * FROM memory_search_vector_cleanup_receipts"
      },
      {
        table: "memory_search_vector_cleanup_janitor_state",
        label: "memory-search-vector-cleanup-janitor-state",
        query: "SELECT * FROM memory_search_vector_cleanup_janitor_state"
      }
    ];

    expect(workflow).toContain("FROM sqlite_master WHERE type = 'table'");
    for (const snapshot of snapshots) {
      expect(workflow).toContain(`detect_search_table ${snapshot.table}`);
      const escapedLabel = snapshot.label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const escapedQuery = snapshot.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const guardedSnapshot = workflow.match(
        new RegExp(
          `if \\[\\[ "\\$([A-Za-z_][A-Za-z0-9_]*)" == "1" \\]\\]; then\\s+` +
            `snapshot_search_table\\s+"${escapedLabel}"\\s+"${escapedQuery}"[\\s\\S]*?` +
            `else\\s+: > "\\$backup_dir/${escapedLabel}\\.jsonl"\\s+fi`,
          "u"
        )
      );
      expect(guardedSnapshot, `${snapshot.table} snapshot must be presence-gated`).not.toBeNull();

      const presenceVariable = guardedSnapshot?.[1];
      expect(presenceVariable).toBeTypeOf("string");
      expect(workflow).toMatch(
        new RegExp(
          `${presenceVariable}="\\$\\(\\s*detect_search_table\\s+${snapshot.table}\\s*\\)"`,
          "u"
        )
      );

      const countAlias = workflow.match(
        new RegExp(`\\$([A-Za-z_][A-Za-z0-9_]*) AS ${snapshot.table}(?:,|;)`, "u")
      );
      expect(countAlias, `${snapshot.table} count must use a gated value`).not.toBeNull();
      const countVariable = countAlias?.[1];
      expect(countVariable).toBeTypeOf("string");
      expect(workflow).toContain(`${countVariable}="0"`);
      expect(workflow).toMatch(
        new RegExp(
          `if \\[\\[ "\\$${presenceVariable}" == "1" \\]\\]; then\\s+` +
            `${countVariable}="\\(SELECT COUNT\\(\\*\\) FROM ${snapshot.table}\\)"\\s+fi`,
          "u"
        )
      );

      expect(workflow).toContain(
        `upload_and_verify "${snapshot.label}.jsonl" "application/x-ndjson"`
      );
    }
    expect(workflow).toContain("append-keyset-page");
    expect(workflow).not.toMatch(/LIMIT \$page_size OFFSET/iu);
  });
});

describe("post-migration D1 validation", () => {
  it("requires quick_check=ok and zero foreign-key violations", () => {
    const healthy = [
      { results: [{ quick_check: "ok" }], success: true },
      { results: [], success: true }
    ];
    expect(() => validateD1IntegrityOutput("MEMORY_DB", JSON.stringify(healthy))).not.toThrow();
    expect(() =>
      validateD1IntegrityOutput(
        "SEARCH_DB",
        JSON.stringify([
          { results: [{ quick_check: "database disk image is malformed" }], success: true },
          { results: [], success: true }
        ])
      )
    ).toThrow(/quick_check/iu);
    expect(() =>
      validateD1IntegrityOutput(
        "MEMORY_DB",
        JSON.stringify([
          { results: [{ quick_check: "ok" }], success: true },
          { results: [{ table: "memories", rowid: 1 }], success: true }
        ])
      )
    ).toThrow(/foreign_key_check/iu);
  });

  it("requires every application schema object and its exact normalized definition", () => {
    const memoryRows = migratedSchemaRows("MEMORY_DB");
    const searchRows = migratedSchemaRows("SEARCH_DB");

    expect(() =>
      validateD1SchemaOutput("MEMORY_DB", JSON.stringify(d1Result(memoryRows)))
    ).not.toThrow();
    expect(() =>
      validateD1SchemaOutput("SEARCH_DB", JSON.stringify(d1Result(searchRows)))
    ).not.toThrow();
    expect(() =>
      validateD1SchemaOutput(
        "MEMORY_DB",
        JSON.stringify(d1Result(memoryRows.filter((row) => row.name !== "projects")))
      )
    ).toThrow(/projects/iu);

    const wrongDefinition = memoryRows.map((row) =>
      row.name === "audit_sequence_guard"
        ? { ...row, sql: "CREATE TRIGGER audit_sequence_guard AFTER INSERT ON projects BEGIN SELECT 1; END" }
        : row
    );
    expect(() =>
      validateD1SchemaOutput("MEMORY_DB", JSON.stringify(d1Result(wrongDefinition)))
    ).toThrow(/unexpected schema definitions/iu);

    const changedLiteral = memoryRows.map((row) =>
      row.name === "audit_sequence_guard" && typeof row.sql === "string"
        ? { ...row, sql: row.sql.replace("'stale project head'", "'STALE project head'") }
        : row
    );
    expect(() =>
      validateD1SchemaOutput("MEMORY_DB", JSON.stringify(d1Result(changedLiteral)))
    ).toThrow(/unexpected schema definitions/iu);

    expect(() =>
      validateD1SchemaOutput(
        "MEMORY_DB",
        JSON.stringify(
          d1Result([
            ...memoryRows,
            {
              type: "table",
              name: "unexpected_application_table",
              sql: "CREATE TABLE unexpected_application_table (id TEXT PRIMARY KEY)"
            }
          ])
        )
      )
    ).toThrow(/unknown application schema objects/iu);
  });

  it("ignores only the known Cloudflare metadata table", () => {
    const memoryRows = migratedSchemaRows("MEMORY_DB");
    const cloudflareMetadata = {
      type: "table",
      name: "_cf_METADATA",
      sql: "CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)"
    };

    expect(() =>
      validateD1SchemaOutput(
        "MEMORY_DB",
        JSON.stringify(d1Result([...memoryRows, cloudflareMetadata]))
      )
    ).not.toThrow();
    expect(() =>
      validateD1SchemaOutput(
        "MEMORY_DB",
        JSON.stringify(
          d1Result([
            ...memoryRows,
            {
              type: "table",
              name: "_cf_fake",
              sql: "CREATE TABLE _cf_fake (id TEXT PRIMARY KEY)"
            }
          ])
        )
      )
    ).toThrow(/unknown application schema objects: table:_cf_fake/iu);
  });

  it(
    "accepts schema output produced after the pinned Wrangler applies local MEMORY_DB migrations",
    { timeout: wranglerIntegrationTimeoutMs },
    () => {
      const directory = mkdtempSync(join(tmpdir(), "edgemneme-d1-migration-safety-test-"));
      const persistenceDirectory = join(directory, "persist");
      const schemaPath = join(directory, "memory-schema.json");
      const configPath = join(process.cwd(), "wrangler", "memory-orchestrator.jsonc");
      const scriptPath = join(process.cwd(), "scripts", "d1-migration-safety.mjs");
      const packageJson = JSON.parse(
        readFileSync(join(process.cwd(), "package.json"), "utf8")
      ) as { devDependencies?: { wrangler?: unknown } };
      const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

      try {
        expect(packageJson.devDependencies?.wrangler).toMatch(/^\d+\.\d+\.\d+$/u);
        expect(
          runCommand(pnpmCommand, ["exec", "wrangler", "--version"], "Wrangler version check").trim()
        ).toBe(packageJson.devDependencies?.wrangler);

        runCommand(
          pnpmCommand,
          [
            "exec",
            "wrangler",
            "d1",
            "migrations",
            "apply",
            "MEMORY_DB",
            "--local",
            "--persist-to",
            persistenceDirectory,
            "--config",
            configPath
          ],
          "Local D1 migration apply"
        );
        const schemaOutput = runCommand(
          pnpmCommand,
          [
            "exec",
            "wrangler",
            "d1",
            "execute",
            "MEMORY_DB",
            "--local",
            "--persist-to",
            persistenceDirectory,
            "--config",
            configPath,
            "--command",
            "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name;",
            "--json"
          ],
          "Local D1 schema query"
        );
        expect(extractD1PageRows(schemaOutput)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "table", name: "_cf_METADATA" })
          ])
        );

        writeFileSync(schemaPath, schemaOutput, { mode: 0o600 });
        expect(() =>
          runCommand(
            process.execPath,
            [scriptPath, "validate-schema", "MEMORY_DB", schemaPath],
            "Local D1 schema validation"
          )
        ).not.toThrow();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
