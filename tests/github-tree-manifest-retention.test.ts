import { readFileSync } from "node:fs";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync
} from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  failGitHubTreeManifest,
  maintainGitHubTreeManifestRetention
} from "../src/github/tree-manifest-retention";
import {
  activateGitHubTreeManifest,
  beginGitHubTreeManifest,
  buildGitHubTreeManifestDescriptor,
  completeGitHubTreeManifest,
  persistGitHubTreeManifestEntries,
  type GitHubTreeManifestDescriptor,
  type GitHubTreeManifestEntry
} from "../src/github/tree-manifest";
import { sha256 } from "../src/security/crypto";

const MIGRATIONS = [
  "migrations/0001_initial.sql",
  "migrations/0002_allow_synthetic_cleanup.sql",
  "migrations/0003_validity_interval_guard.sql",
  "migrations/0004_synthetic_cleanup_registry_and_validity_preflight.sql",
  "migrations/0005_synthetic_cleanup_fence.sql",
  "migrations/0006_repository_scope_context.sql",
  "migrations/0007_repository_scope_hardening.sql",
  "migrations/0008_canonical_repository_scope_ownership.sql",
  "migrations/0009_repository_scope_runtime_guards.sql",
  "migrations/0010_github_credential_expiry_and_repository_identity.sql",
  "migrations/0011_github_tree_manifests.sql"
];

const REF = "refs/heads/main";
const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);

describe("GitHub tree manifest failure retention", () => {
  it("defines bounded partial keyset indexes for both retention lanes", () => {
    const fixture = createFixture();
    const indexes = fixture.database
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'github_tree_manifests_staging_keyset',
           'github_tree_manifests_failed_keyset'
         )
         ORDER BY name`
      )
      .all() as Array<{ name: string; sql: string }>;

    expect(
      indexes.map((row) => ({
        name: row.name,
        sql: row.sql.replace(/\s+/gu, " ").trim()
      }))
    ).toEqual([
      {
        name: "github_tree_manifests_failed_keyset",
        sql:
          "CREATE INDEX github_tree_manifests_failed_keyset " +
          "ON github_tree_manifests(project_id, manifest_id) " +
          "WHERE status IN ('failed', 'purging')"
      },
      {
        name: "github_tree_manifests_staging_keyset",
        sql:
          "CREATE INDEX github_tree_manifests_staging_keyset " +
          "ON github_tree_manifests(project_id, manifest_id) " +
          "WHERE status = 'staging'"
      }
    ]);
  });

  it("bounds raw keyset scans even when every staging row is ineligible", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    for (let index = 0; index < 150; index += 1) {
      const manifest = await descriptor(
        "project-a",
        "repository-a",
        new Date(
          Date.parse("2026-08-01T00:00:00.000Z") + index * 1_000
        ).toISOString()
      );
      await beginGitHubTreeManifest(fixture.d1, manifest);
    }
    fixture.adapter.allExecutions.length = 0;

    await expect(
      maintainGitHubTreeManifestRetention(
        fixture.d1,
        Date.parse("2026-07-28T00:00:00.000Z"),
        { maxPerState: 25 }
      )
    ).resolves.toEqual(emptyRetentionResult());

    const stagingPage = fixture.adapter.allExecutions.find((execution) =>
      execution.sql.includes("INDEXED BY github_tree_manifests_staging_keyset")
    );
    expect(stagingPage).toBeDefined();
    expect(stagingPage?.sql).not.toMatch(/ROW_NUMBER|WITH\s+eligible/iu);
    expect(stagingPage?.bindings.at(-1)).toBe(100);
    expect(stagingPage?.resultCount).toBe(100);
    const plan = fixture.database
      .prepare(`EXPLAIN QUERY PLAN ${stagingPage?.sql ?? "SELECT 1"}`)
      .all(...(stagingPage?.bindings ?? []))
      .map((row) => String(row.detail))
      .join("\n");
    expect(plan).toContain(
      "SEARCH manifest USING INDEX github_tree_manifests_staging_keyset"
    );
    expect(plan).not.toMatch(/SCAN manifest|USE TEMP B-TREE/iu);
    expect(
      fixture.database
        .prepare(
          `SELECT cursor_version, after_project_id, after_manifest_id
           FROM github_tree_manifest_retention_cursors WHERE lane = 'staging'`
        )
        .get()
    ).toEqual({
      cursor_version: 1,
      after_project_id: "project-a",
      after_manifest_id: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
  });

  it("uses the bounded failed-manifest keyset plan", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    await failedManifest(
      fixture.d1,
      "project-a",
      "repository-a",
      "2026-07-20T00:00:00.000Z",
      "docs/recent.md"
    );
    fixture.adapter.allExecutions.length = 0;

    await expect(
      maintainGitHubTreeManifestRetention(
        fixture.d1,
        Date.parse("2026-07-28T00:00:00.000Z"),
        { maxPerState: 25 }
      )
    ).resolves.toEqual(emptyRetentionResult());

    const failedPage = fixture.adapter.allExecutions.find((execution) =>
      execution.sql.includes("INDEXED BY github_tree_manifests_failed_keyset")
    );
    expect(failedPage).toBeDefined();
    expect(failedPage?.sql).not.toMatch(/ROW_NUMBER|WITH\s+eligible/iu);
    expect(failedPage?.bindings.at(-1)).toBe(100);
    expect(failedPage?.resultCount).toBe(1);
    const plan = fixture.database
      .prepare(`EXPLAIN QUERY PLAN ${failedPage?.sql ?? "SELECT 1"}`)
      .all(...(failedPage?.bindings ?? []))
      .map((row) => String(row.detail))
      .join("\n");
    expect(plan).toContain(
      "SEARCH manifest USING INDEX github_tree_manifests_failed_keyset"
    );
    expect(plan).not.toMatch(/SCAN manifest|USE TEMP B-TREE/iu);
  });

  it("reaches eligible staging work beyond one raw scan budget", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    seedProjectRepository(fixture.database, "project-z", "repository-z", 84);
    for (let index = 0; index < 201; index += 1) {
      const manifest = await descriptor(
        "project-a",
        "repository-a",
        new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 1_000).toISOString()
      );
      await beginGitHubTreeManifest(fixture.d1, manifest);
    }
    const eligible = await descriptor(
      "project-z",
      "repository-z",
      "2026-07-01T00:00:00.000Z"
    );
    await beginGitHubTreeManifest(fixture.d1, eligible);

    const results = [];
    const pageCounts: number[][] = [];
    const pageSql: string[][] = [];
    for (let invocation = 0; invocation < 3; invocation += 1) {
      const executionStart = fixture.adapter.allExecutions.length;
      results.push(
        await maintainGitHubTreeManifestRetention(
          fixture.d1,
          Date.parse("2026-07-28T00:00:00.000Z"),
          { maxPerState: 25 }
        )
      );
      const stagingPages = fixture.adapter.allExecutions
        .slice(executionStart)
        .filter((execution) =>
          execution.sql.includes("INDEXED BY github_tree_manifests_staging_keyset")
        );
      pageCounts.push(stagingPages.map((page) => page.resultCount));
      pageSql.push(stagingPages.map((page) => page.sql));
      expect(
        stagingPages.reduce((total, page) => total + page.resultCount, 0)
      ).toBeLessThanOrEqual(100);
    }

    expect(results).toEqual([
      emptyRetentionResult(),
      emptyRetentionResult(),
      { ...emptyRetentionResult(), failedStaging: 1 }
    ]);
    expect(pageCounts).toEqual([[100], [100], [2, 98]]);
    expect(pageSql[2]?.[0]).not.toContain("<= (?, ?)");
    expect(pageSql[2]?.[1]).toContain("<= (?, ?)");
    expect(manifestStatus(fixture.database, eligible)).toBe("failed");
    expect(retentionCursorVersion(fixture.database, "staging")).toBe(3);
  });

  it("records an idempotent bodyless failure audit for a partial manifest", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    const manifest = await descriptor(
      "project-a",
      "repository-a",
      "2026-06-01T00:00:00.000Z"
    );
    const manifestEntries = [
      await entry(null, "sensitive_tombstone", "secret/.env"),
      await entry("docs/ambiguous.dat", "partial", "docs/ambiguous.dat")
    ];
    await beginGitHubTreeManifest(fixture.d1, manifest);
    await persistGitHubTreeManifestEntries(
      fixture.d1,
      manifest,
      manifestEntries
    );

    await expect(
      failGitHubTreeManifest(
        fixture.d1,
        manifest,
        "GITHUB_PARTIAL_SYNC"
      )
    ).resolves.toBe("failed");
    await expect(
      failGitHubTreeManifest(
        fixture.d1,
        manifest,
        "GITHUB_PARTIAL_SYNC"
      )
    ).resolves.toBe("already_failed");
    expect(
      fixture.database
        .prepare(
          `SELECT status, entry_count, entries_checksum, failed_at,
                  failure_code, purged_at
           FROM github_tree_manifests
           WHERE project_id = ? AND manifest_id = ?`
        )
        .get("project-a", manifest.manifestId)
    ).toEqual({
      status: "failed",
      entry_count: 2,
      entries_checksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
      failed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      failure_code: "GITHUB_PARTIAL_SYNC",
      purged_at: null
    });
    const lifecycle = fixture.database
      .prepare(
        `SELECT event_id, event_type, failure_code, entry_count, entries_checksum,
                chunk_entry_count, chunk_digest, request_digest, recorded_at
         FROM github_tree_manifest_lifecycle_events
         WHERE project_id = ? AND manifest_id = ?`
      )
      .all("project-a", manifest.manifestId);
    expect(lifecycle).toEqual([
      {
        event_id: expect.stringMatching(/^[0-9a-f]{64}$/u),
        event_type: "failed",
        failure_code: "GITHUB_PARTIAL_SYNC",
        entry_count: 2,
        entries_checksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
        chunk_entry_count: null,
        chunk_digest: null,
        request_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        recorded_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u)
      }
    ]);
    expect(JSON.stringify(lifecycle)).not.toMatch(/secret\/\.env|docs\//u);
    const lifecycleEventId = String(
      (lifecycle[0] as { event_id: string } | undefined)?.event_id
    );
    expect(() =>
      fixture.database
        .prepare(
          `UPDATE github_tree_manifest_lifecycle_events
           SET request_digest = request_digest WHERE event_id = ?`
        )
        .run(lifecycleEventId)
    ).toThrow(/lifecycle events are immutable/iu);
    expect(() =>
      fixture.database
        .prepare(
          `DELETE FROM github_tree_manifest_lifecycle_events
           WHERE event_id = ?`
        )
        .run(lifecycleEventId)
    ).toThrow(/lifecycle events are immutable/iu);
    expect(
      fixture.database
        .prepare(
          `SELECT safe_path FROM github_tree_manifest_entries
           WHERE project_id = ? AND manifest_id = ?
           ORDER BY path_digest`
        )
        .all("project-a", manifest.manifestId)
    ).toContainEqual({ safe_path: null });
    expect(
      JSON.stringify(
        fixture.database
          .prepare(
            `SELECT status, entry_count, entries_checksum, failed_at,
                    failure_code, purged_at
             FROM github_tree_manifests
             WHERE project_id = ? AND manifest_id = ?`
          )
          .get("project-a", manifest.manifestId)
      )
    ).not.toContain("secret/.env");
    await expect(beginGitHubTreeManifest(fixture.d1, manifest)).rejects.toMatchObject({
      code: "GITHUB_PARTIAL_SYNC"
    });
  });

  it("rolls back the failure state when its lifecycle event cannot be inserted", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    const manifest = await descriptor(
      "project-a",
      "repository-a",
      new Date(Date.now() - 60_000).toISOString()
    );
    await beginGitHubTreeManifest(fixture.d1, manifest);
    await persistGitHubTreeManifestEntries(fixture.d1, manifest, [
      await entry("docs/failure.md", "partial", "docs/failure.md")
    ]);
    fixture.database.exec(`
      CREATE TRIGGER synthetic_failed_event_failure
      BEFORE INSERT ON github_tree_manifest_lifecycle_events
      WHEN NEW.event_type = 'failed'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic failed event failure');
      END;
    `);

    await expect(
      failGitHubTreeManifest(fixture.d1, manifest, "GITHUB_PARTIAL_SYNC")
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    expect(manifestStatus(fixture.database, manifest)).toBe("staging");
    expect(lifecycleEventCount(fixture.database, manifest, "failed")).toBe(0);

    fixture.database.exec("DROP TRIGGER synthetic_failed_event_failure");
    await expect(
      failGitHubTreeManifest(fixture.d1, manifest, "GITHUB_PARTIAL_SYNC")
    ).resolves.toBe("failed");
    expect(manifestStatus(fixture.database, manifest)).toBe("failed");
    expect(lifecycleEventCount(fixture.database, manifest, "failed")).toBe(1);
  });

  it("does not fail staging work while its repository sync lease is valid", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    const scheduledFor = "2026-07-28T00:00:00.000Z";
    const manifest = await descriptor(
      "project-a",
      "repository-a",
      scheduledFor
    );
    await beginGitHubTreeManifest(fixture.d1, manifest);
    fixture.database
      .prepare(
        `INSERT INTO github_repository_sync_runs
         (run_id, project_id, repository_id, scheduled_for,
          full_reconciliation, status, started_at, lease_expires_at)
         VALUES ('run-a', 'project-a', 'repository-a', ?, 1, 'running', ?, ?)`
      )
      .run(
        scheduledFor,
        "2026-07-28T00:00:01.000Z",
        "2026-07-28T01:00:01.000Z"
      );

    await expect(
      maintainGitHubTreeManifestRetention(
        fixture.d1,
        Date.parse("2026-07-28T00:30:00.000Z")
      )
    ).resolves.toEqual(emptyRetentionResult());
    expect(manifestStatus(fixture.database, manifest)).toBe("staging");

    fixture.database
      .prepare(
        `UPDATE github_repository_sync_runs
         SET status = 'failed', completed_at = ?,
             last_error_code = 'GITHUB_RECONCILIATION_REQUIRED'
         WHERE run_id = 'run-a'`
      )
      .run("2026-07-28T01:00:02.000Z");
    await expect(
      maintainGitHubTreeManifestRetention(
        fixture.d1,
        Date.parse("2026-07-28T02:00:00.000Z")
      )
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      failedStaging: 1
    });
    expect(manifestStatus(fixture.database, manifest)).toBe("failed");
    await expect(
      persistGitHubTreeManifestEntries(fixture.d1, manifest, [
        await entry("docs/late.md", "text", "docs/late.md")
      ])
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    await expect(
      completeGitHubTreeManifest(fixture.d1, manifest, [], new Date().toISOString())
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    await expect(activate(fixture.d1, manifest)).rejects.toMatchObject({
      code: "GITHUB_RECONCILIATION_REQUIRED"
    });
  });

  it("rejects backdated or future lifecycle times and retention before the database gate", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const manifest = await descriptor("project-a", "repository-a", createdAt);
    await beginGitHubTreeManifest(fixture.d1, manifest);
    expect(() =>
      fixture.database
        .prepare(
          `UPDATE github_tree_manifests
           SET status = 'failed', entry_count = 0, entries_checksum = ?,
               failed_at = ?, failure_code = 'GITHUB_PARTIAL_SYNC'
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run(
          "0".repeat(64),
          new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          "project-a",
          manifest.manifestId
        )
    ).toThrow(/state transition is invalid/iu);

    const olderCreatedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const backdated = await descriptor(
      "project-a",
      "repository-a",
      olderCreatedAt
    );
    await beginGitHubTreeManifest(fixture.d1, backdated);
    expect(() =>
      fixture.database
        .prepare(
          `UPDATE github_tree_manifests
           SET status = 'failed', entry_count = 0, entries_checksum = ?,
               failed_at = ?, failure_code = 'GITHUB_PARTIAL_SYNC'
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run(
          "0".repeat(64),
          new Date(Date.now() - 10 * 60_000).toISOString(),
          "project-a",
          backdated.manifestId
        )
    ).toThrow(/state transition is invalid/iu);
    expect(() =>
      fixture.database
        .prepare(
          `UPDATE github_tree_manifests
           SET status = 'failed', entry_count = 0, entries_checksum = ?,
               failed_at = 'not-a-time',
               failure_code = 'GITHUB_PARTIAL_SYNC'
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run("0".repeat(64), "project-a", backdated.manifestId)
    ).toThrow();

    await failGitHubTreeManifest(
      fixture.d1,
      manifest,
      "GITHUB_PARTIAL_SYNC"
    );
    expect(() =>
      fixture.database
        .prepare(
          `INSERT INTO github_tree_manifest_lifecycle_events
           (event_id, project_id, manifest_id, retention_version, event_type,
            failure_code, entry_count, entries_checksum, request_digest,
            recorded_at)
           SELECT ?, project_id, manifest_id, retention_version, 'failed',
                  failure_code, entry_count, entries_checksum, ?, ?
           FROM github_tree_manifests
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run(
          "f".repeat(64),
          "e".repeat(64),
          new Date(Date.now() - 10 * 60_000).toISOString(),
          "project-a",
          manifest.manifestId
        )
    ).toThrow(/lifecycle event is invalid/iu);
    expect(() =>
      fixture.database
        .prepare(
          `INSERT INTO github_tree_manifest_lifecycle_events
           (event_id, project_id, manifest_id, retention_version, event_type,
            failure_code, entry_count, entries_checksum, request_digest,
            recorded_at)
           SELECT ?, project_id, manifest_id, retention_version, 'failed',
                  failure_code, entry_count, entries_checksum, ?, 'not-a-time'
           FROM github_tree_manifests
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run(
          "d".repeat(64),
          "c".repeat(64),
          "project-a",
          manifest.manifestId
        )
    ).toThrow(/lifecycle event is invalid/iu);
    const purgeLeaseUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(() =>
      fixture.database
        .prepare(
          `UPDATE github_tree_manifests
           SET status = 'purging', retention_version = retention_version + 1,
               retention_attempt = retention_attempt + 1,
               retention_next_attempt_at = ?, purge_token = ?,
               purge_lease_until = ?
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run(
          purgeLeaseUntil,
          "1".repeat(64),
          purgeLeaseUntil,
          "project-a",
          manifest.manifestId
        )
    ).toThrow(/state transition is invalid/iu);
    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now())
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      failedStaging: 1
    });
    expect(manifestStatus(fixture.database, manifest)).toBe("failed");
    expect(manifestStatus(fixture.database, backdated)).toBe("failed");
  });

  it("deletes more than 1,000 retained entries in fixed-size resumable chunks", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    const createdAt = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1_000
    ).toISOString();
    const manifest = await descriptor("project-a", "repository-a", createdAt);
    const manifestEntries = Array.from({ length: 1_001 }, (_, index) => ({
      pathDigest: index.toString(16).padStart(64, "0"),
      safePath: `docs/${index}.md`,
      blobSha: BLOB_SHA,
      byteSize: 12,
      disposition: "partial" as const
    }));
    await beginGitHubTreeManifest(fixture.d1, manifest);
    await persistGitHubTreeManifestEntries(fixture.d1, manifest, manifestEntries);
    await failGitHubTreeManifest(
      fixture.d1,
      manifest,
      "GITHUB_PARTIAL_SYNC"
    );
    ageFailedManifest(
      fixture.database,
      manifest,
      new Date(Date.parse(createdAt) + 60_000).toISOString()
    );

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 1
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 1,
      entriesDeleted: 1_001,
      purged: 1
    });
    expect(entryCount(fixture.database, manifest)).toBe(0);
    expect(manifestStatus(fixture.database, manifest)).toBe("purged");
  });

  it("isolates a chunk failure and resumes after its persisted retry time", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    seedProjectRepository(fixture.database, "project-b", "repository-b", 84);
    const createdAt = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1_000
    ).toISOString();
    const failedA = await failedManifest(
      fixture.d1,
      "project-a",
      "repository-a",
      createdAt,
      "docs/shared.md"
    );
    const failedB = await failedManifest(
      fixture.d1,
      "project-b",
      "repository-b",
      createdAt,
      "docs/shared.md"
    );
    fixture.database.exec(`
      CREATE TRIGGER synthetic_chunk_failure
      BEFORE DELETE ON github_tree_manifest_entries
      WHEN OLD.manifest_id = '${failedA.manifestId}'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic chunk failure');
      END;
    `);

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 2,
        purgeLeaseMilliseconds: 100
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 2,
      entriesDeleted: 1,
      purged: 1,
      errors: 1
    });
    expect(manifestStatus(fixture.database, failedA)).toBe("purging");
    expect(manifestStatus(fixture.database, failedB)).toBe("purged");
    expect(entryCount(fixture.database, failedA)).toBe(1);
    expect(
      lifecycleEventCount(fixture.database, failedA, "purge_chunk")
    ).toBe(0);
    expect(
      lifecycleEventTypes(fixture.database, failedB)
    ).toEqual(["failed", "purge_chunk", "purged"]);
    fixture.database.exec("DROP TRIGGER synthetic_chunk_failure");
    await new Promise((resolve) => setTimeout(resolve, 125));

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 1
      })
    ).resolves.toEqual(emptyRetentionResult());
    makePurgeRetryDue(fixture.database, failedA);

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 1
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 1,
      entriesDeleted: 1,
      purged: 1
    });
    expect(manifestStatus(fixture.database, failedA)).toBe("purged");
    expect(
      lifecycleEventTypes(fixture.database, failedA)
    ).toEqual(["failed", "purge_chunk", "purged"]);
  });

  it("does not let 25 poisoned manifests starve a later project", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    seedProjectRepository(fixture.database, "project-z", "repository-z", 84);
    const baseCreatedAt = Date.now() - 31 * 24 * 60 * 60 * 1_000;
    const poisoned: GitHubTreeManifestDescriptor[] = [];
    for (let index = 0; index < 25; index += 1) {
      poisoned.push(
        await failedManifest(
          fixture.d1,
          "project-a",
          "repository-a",
          new Date(baseCreatedAt + index * 1_000).toISOString(),
          `docs/poisoned-${index}.md`
        )
      );
    }
    const healthy = await failedManifest(
      fixture.d1,
      "project-z",
      "repository-z",
      new Date(baseCreatedAt).toISOString(),
      "docs/healthy.md"
    );
    fixture.database.exec(`
      CREATE TRIGGER synthetic_poisoned_project
      BEFORE DELETE ON github_tree_manifest_entries
      WHEN OLD.project_id = 'project-a'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic poisoned project');
      END;
    `);

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 25
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 3,
      entriesDeleted: 1,
      purged: 1,
      errors: 2
    });
    expect(manifestStatus(fixture.database, healthy)).toBe("purged");
    expect(
      fixture.database
        .prepare(
          `SELECT status, COUNT(*) AS count
           FROM github_tree_manifests
           WHERE project_id = 'project-a'
           GROUP BY status ORDER BY status`
        )
        .all()
    ).toEqual([
      { status: "failed", count: 23 },
      { status: "purging", count: 2 }
    ]);
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM github_tree_manifests
           WHERE project_id = 'project-a' AND status = 'purging'
             AND retention_attempt = 1
             AND julianday(retention_next_attempt_at) > julianday('now')`
        )
        .get()
    ).toEqual({ count: 2 });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM github_tree_manifest_lifecycle_events
           WHERE project_id = 'project-a' AND event_type = 'purge_chunk'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(lifecycleEventTypes(fixture.database, healthy)).toEqual([
      "failed",
      "purge_chunk",
      "purged"
    ]);
    expect(poisoned).toHaveLength(25);
  });

  it("persists rotation past 25 pre-claim failures across 13 projects", async () => {
    const fixture = createFixture();
    const createdAt = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1_000
    ).toISOString();
    for (let projectIndex = 0; projectIndex < 13; projectIndex += 1) {
      const suffix = projectIndex.toString().padStart(2, "0");
      const projectId = `project-poison-${suffix}`;
      const repositoryId = `repository-poison-${suffix}`;
      seedProjectRepository(
        fixture.database,
        projectId,
        repositoryId,
        1_000 + projectIndex
      );
      for (let manifestIndex = 0; manifestIndex < 2; manifestIndex += 1) {
        await failedManifest(
          fixture.d1,
          projectId,
          repositoryId,
          new Date(Date.parse(createdAt) + manifestIndex * 1_000).toISOString(),
          `docs/poison-${suffix}-${manifestIndex}.md`
        );
      }
    }
    seedProjectRepository(fixture.database, "project-z", "repository-z", 2_000);
    const healthy = await failedManifest(
      fixture.d1,
      "project-z",
      "repository-z",
      createdAt,
      "docs/healthy-after-rotation.md"
    );
    fixture.database.exec(`
      CREATE TRIGGER synthetic_preclaim_failure
      BEFORE UPDATE OF status ON github_tree_manifests
      WHEN OLD.project_id GLOB 'project-poison-*'
        AND OLD.status = 'failed' AND NEW.status = 'purging'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic preclaim failure');
      END;
    `);

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 25
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      errors: 25
    });
    expect(manifestStatus(fixture.database, healthy)).toBe("failed");
    expect(retentionCursorVersion(fixture.database, "failed")).toBe(1);

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 25
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 1,
      entriesDeleted: 1,
      purged: 1,
      errors: 24
    });
    expect(manifestStatus(fixture.database, healthy)).toBe("purged");
    expect(retentionCursorVersion(fixture.database, "failed")).toBe(2);
  });

  it("provides eventual fairness with a one-manifest maintenance limit", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    seedProjectRepository(fixture.database, "project-z", "repository-z", 84);
    const baseCreatedAt = Date.now() - 31 * 24 * 60 * 60 * 1_000;
    const backlog: GitHubTreeManifestDescriptor[] = [];
    for (let index = 0; index < 5; index += 1) {
      backlog.push(
        await failedManifest(
          fixture.d1,
          "project-a",
          "repository-a",
          new Date(baseCreatedAt + index * 1_000).toISOString(),
          `docs/backlog-${index}.md`
        )
      );
    }
    const laterProject = await failedManifest(
      fixture.d1,
      "project-z",
      "repository-z",
      new Date(baseCreatedAt).toISOString(),
      "docs/later-project.md"
    );

    for (let invocation = 0; invocation < backlog.length; invocation += 1) {
      await expect(
        maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
          maxPerState: 1
        })
      ).resolves.toEqual({
        ...emptyRetentionResult(),
        claimed: 1,
        entriesDeleted: 1,
        purged: 1
      });
      expect(manifestStatus(fixture.database, laterProject)).toBe("failed");
    }

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 1
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 1,
      entriesDeleted: 1,
      purged: 1
    });
    expect(backlog.every((manifest) =>
      manifestStatus(fixture.database, manifest) === "purged"
    )).toBe(true);
    expect(manifestStatus(fixture.database, laterProject)).toBe("purged");
    expect(retentionCursorVersion(fixture.database, "failed")).toBe(6);
  });

  it("rolls back terminal state when the purge event fails and rejects time backfill", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    const createdAt = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1_000
    ).toISOString();
    const manifest = await failedManifest(
      fixture.d1,
      "project-a",
      "repository-a",
      createdAt,
      "docs/finalize.md"
    );
    fixture.database.exec(`
      CREATE TRIGGER synthetic_purged_event_failure
      BEFORE INSERT ON github_tree_manifest_lifecycle_events
      WHEN NEW.event_type = 'purged'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic purged event failure');
      END;
    `);

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 1
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 1,
      errors: 1
    });
    expect(entryCount(fixture.database, manifest)).toBe(0);
    expect(manifestStatus(fixture.database, manifest)).toBe("purging");
    expect(lifecycleEventTypes(fixture.database, manifest)).toEqual([
      "failed",
      "purge_chunk"
    ]);

    const backdatedPurgedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(() =>
      fixture.database
        .prepare(
          `UPDATE github_tree_manifests
           SET status = 'purged', retention_version = retention_version + 1,
               retention_next_attempt_at = NULL, purge_token = NULL,
               purge_lease_until = NULL, purged_at = ?
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run(backdatedPurgedAt, "project-a", manifest.manifestId)
    ).toThrow(/state transition is invalid/iu);

    fixture.database.exec("DROP TRIGGER synthetic_purged_event_failure");
    makePurgeRetryDue(fixture.database, manifest);
    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 1
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 1,
      purged: 1
    });
    expect(manifestStatus(fixture.database, manifest)).toBe("purged");
    expect(lifecycleEventTypes(fixture.database, manifest)).toEqual([
      "failed",
      "purge_chunk",
      "purged"
    ]);
  });

  it("allows only one concurrent retention claim", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    const createdAt = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1_000
    ).toISOString();
    const manifest = await failedManifest(
      fixture.d1,
      "project-a",
      "repository-a",
      createdAt,
      "docs/concurrent.md"
    );

    const results = await Promise.all([
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 1
      }),
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now(), {
        maxPerState: 1
      })
    ]);
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.purged, 0)).toBe(1);
    expect(manifestStatus(fixture.database, manifest)).toBe("purged");
    expect(retentionCursorVersion(fixture.database, "failed")).toBe(1);
  });

  it("never selects synthetic projects for operational retention", async () => {
    const fixture = createFixture();
    seedProjectRepository(
      fixture.database,
      "project-synthetic",
      "repository-synthetic",
      126,
      "system.synthetic.retention"
    );
    const createdAt = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1_000
    ).toISOString();
    const manifest = await failedManifest(
      fixture.d1,
      "project-synthetic",
      "repository-synthetic",
      createdAt,
      "docs/synthetic.md"
    );

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, Date.now())
    ).resolves.toEqual(emptyRetentionResult());
    expect(manifestStatus(fixture.database, manifest)).toBe("failed");
    expect(entryCount(fixture.database, manifest)).toBe(1);
  });

  it("purges failed entries after 30 days with bounded cross-project keyset progress", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    seedProjectRepository(fixture.database, "project-b", "repository-b", 84);
    const oldA = await failedManifest(
      fixture.d1,
      "project-a",
      "repository-a",
      "2026-05-31T00:00:00.000Z",
      "docs/shared.md"
    );
    const oldB = await failedManifest(
      fixture.d1,
      "project-b",
      "repository-b",
      "2026-05-31T00:00:00.000Z",
      "docs/shared.md"
    );
    const recent = await failedManifest(
      fixture.d1,
      "project-b",
      "repository-b",
      "2026-07-20T00:00:00.000Z",
      "docs/recent.md"
    );
    const retentionTime = Date.parse("2026-07-28T00:00:00.000Z");

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, retentionTime, {
        maxPerState: 1
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 1,
      entriesDeleted: 1,
      purged: 1
    });
    expect(manifestStatus(fixture.database, oldA)).toBe("purged");
    expect(manifestStatus(fixture.database, oldB)).toBe("failed");
    expect(entryCount(fixture.database, oldA)).toBe(0);
    expect(entryCount(fixture.database, oldB)).toBe(1);

    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, retentionTime, {
        maxPerState: 1
      })
    ).resolves.toEqual({
      ...emptyRetentionResult(),
      claimed: 1,
      entriesDeleted: 1,
      purged: 1
    });
    expect(manifestStatus(fixture.database, oldB)).toBe("purged");
    expect(manifestStatus(fixture.database, recent)).toBe("failed");
    expect(entryCount(fixture.database, recent)).toBe(1);
    await expect(
      maintainGitHubTreeManifestRetention(fixture.d1, retentionTime)
    ).resolves.toEqual(emptyRetentionResult());

    const tombstones = fixture.database
      .prepare(
        `SELECT project_id, status, entry_count, entries_checksum,
                failure_code, failed_at, purged_at
         FROM github_tree_manifests
         WHERE manifest_id IN (?, ?)
         ORDER BY project_id`
      )
      .all(oldA.manifestId, oldB.manifestId);
    expect(tombstones).toEqual([
      expect.objectContaining({
        project_id: "project-a",
        status: "purged",
        entry_count: 1,
        failure_code: "GITHUB_PARTIAL_SYNC",
        purged_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u)
      }),
      expect.objectContaining({
        project_id: "project-b",
        status: "purged",
        entry_count: 1,
        failure_code: "GITHUB_PARTIAL_SYNC",
        purged_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u)
      })
    ]);
    expect(JSON.stringify(tombstones)).not.toContain("docs/");
    expect(() =>
      fixture.database
        .prepare(
          `UPDATE github_tree_manifests SET failure_code = 'GITHUB_RATE_LIMITED'
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run("project-a", oldA.manifestId)
    ).toThrow(/state transition is invalid/iu);
    expect(() =>
      fixture.database
        .prepare(
          `DELETE FROM github_tree_manifests
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run("project-a", oldA.manifestId)
    ).toThrow(/manifests are immutable/iu);
  });

  it("keeps complete, active, and delta-referenced manifests outside retention", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-a", "repository-a", 42);
    const complete = await descriptor(
      "project-a",
      "repository-a",
      "2026-05-30T00:00:00.000Z"
    );
    const completeEntries = [await entry("docs/live.md", "text", "docs/live.md")];
    await beginGitHubTreeManifest(fixture.d1, complete);
    await persistGitHubTreeManifestEntries(fixture.d1, complete, completeEntries);
    await completeGitHubTreeManifest(
      fixture.d1,
      complete,
      completeEntries,
      "2026-05-30T00:01:00.000Z"
    );
    await activate(fixture.d1, complete);
    const failed = await failedManifest(
      fixture.d1,
      "project-a",
      "repository-a",
      "2026-05-31T00:00:00.000Z",
      "docs/failed.md"
    );

    expect(() =>
      fixture.database
        .prepare(
          `DELETE FROM github_tree_manifest_entries
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run("project-a", complete.manifestId)
    ).toThrow(/manifest entries are immutable/iu);
    expect(() =>
      fixture.database
        .prepare(
          `UPDATE github_tree_manifests
           SET status = 'purging', purged_at = ?
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run(
          "2026-07-28T00:00:00.000Z",
          "project-a",
          complete.manifestId
        )
    ).toThrow(/state transition is invalid/iu);
    expect(() =>
      fixture.database
        .prepare(
          `INSERT INTO github_tree_manifest_deltas
           (delta_id, project_id, repository_id, ref, old_manifest_id,
            new_manifest_id, path_digest, safe_path, change_kind,
            old_blob_sha, new_blob_sha, affected_memory_ids_json,
            idempotency_key, created_at)
           VALUES ('forged-delta', 'project-a', 'repository-a', ?, ?, ?, ?,
                   'docs/failed.md', 'changed', ?, ?, '[]', 'forged-delta', ?)`
        )
        .run(
          REF,
          failed.manifestId,
          complete.manifestId,
          "d".repeat(64),
          "e".repeat(40),
          "f".repeat(40),
          "2026-07-28T00:00:00.000Z"
        )
    ).toThrow(/deltas require complete manifests/iu);
    expect(() =>
      fixture.database
        .prepare(
          `INSERT INTO github_tree_manifest_deltas
           (delta_id, project_id, repository_id, ref, old_manifest_id,
            new_manifest_id, path_digest, safe_path, change_kind,
            old_blob_sha, new_blob_sha, affected_memory_ids_json,
            idempotency_key, created_at)
           VALUES ('forged-new-delta', 'project-a', 'repository-a', ?, ?, ?, ?,
                   'docs/failed.md', 'changed', ?, ?, '[]',
                   'forged-new-delta', ?)`
        )
        .run(
          REF,
          complete.manifestId,
          failed.manifestId,
          "e".repeat(64),
          "1".repeat(40),
          "2".repeat(40),
          "2026-07-28T00:00:00.000Z"
        )
    ).toThrow(/deltas require complete manifests/iu);
    expect(() =>
      fixture.database
        .prepare(
          `DELETE FROM github_tree_manifests
           WHERE project_id = ? AND manifest_id = ?`
        )
        .run("project-a", failed.manifestId)
    ).toThrow(/manifests are immutable/iu);
  });
});

async function failedManifest(
  database: D1Database,
  projectId: string,
  repositoryId: string,
  createdAt: string,
  path: string
): Promise<GitHubTreeManifestDescriptor> {
  const manifest = await descriptor(projectId, repositoryId, createdAt);
  const manifestEntries = [await entry(path, "partial", path)];
  await beginGitHubTreeManifest(database, manifest);
  await persistGitHubTreeManifestEntries(database, manifest, manifestEntries);
  await failGitHubTreeManifest(
    database,
    manifest,
    "GITHUB_PARTIAL_SYNC"
  );
  ageFailedManifest(
    (database as unknown as SqliteD1).databaseSync,
    manifest,
    new Date(Date.parse(createdAt) + 60_000).toISOString()
  );
  return manifest;
}

async function descriptor(
  projectId: string,
  repositoryId: string,
  collectionKey: string
): Promise<GitHubTreeManifestDescriptor> {
  return await buildGitHubTreeManifestDescriptor({
    projectId,
    repositoryId,
    ref: REF,
    observedSha: COMMIT_SHA,
    treeSha: TREE_SHA,
    repositoryAuthority: "default_branch",
    collectionKey,
    createdAt: collectionKey
  });
}

async function entry(
  safePath: string | null,
  disposition: GitHubTreeManifestEntry["disposition"],
  digestSource: string
): Promise<GitHubTreeManifestEntry> {
  return {
    pathDigest: await sha256(digestSource),
    safePath,
    blobSha: BLOB_SHA,
    byteSize: 12,
    disposition
  };
}

async function activate(
  database: D1Database,
  manifest: GitHubTreeManifestDescriptor
): Promise<void> {
  const payloadJson = JSON.stringify({ manifest_id: manifest.manifestId });
  await activateGitHubTreeManifest({
    database,
    descriptor: manifest,
    expectedHead: null,
    expectedCursorObservedSha: null,
    scheduledTime: Date.parse(manifest.collectionKey),
    nextSyncAt: "2026-07-28T06:00:00.000Z",
    historyGapPossible: false,
    credentialStatus: "active",
    etag: null,
    syncEvent: {
      eventId: `sync-${manifest.manifestId}`,
      payloadDigest: await sha256(payloadJson),
      payloadJson
    }
  });
}

function manifestStatus(
  database: DatabaseSync,
  manifest: GitHubTreeManifestDescriptor
): string | undefined {
  return (
    database
      .prepare(
        `SELECT status FROM github_tree_manifests
         WHERE project_id = ? AND manifest_id = ?`
      )
      .get(manifest.projectId, manifest.manifestId) as
      | { status: string }
      | undefined
  )?.status;
}

function entryCount(
  database: DatabaseSync,
  manifest: GitHubTreeManifestDescriptor
): number {
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM github_tree_manifest_entries
         WHERE project_id = ? AND manifest_id = ?`
      )
      .get(manifest.projectId, manifest.manifestId) as { count: number }
  ).count;
}

function lifecycleEventCount(
  database: DatabaseSync,
  manifest: GitHubTreeManifestDescriptor,
  eventType: "failed" | "purge_chunk" | "purged"
): number {
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM github_tree_manifest_lifecycle_events
         WHERE project_id = ? AND manifest_id = ? AND event_type = ?`
      )
      .get(manifest.projectId, manifest.manifestId, eventType) as {
      count: number;
    }
  ).count;
}

function lifecycleEventTypes(
  database: DatabaseSync,
  manifest: GitHubTreeManifestDescriptor
): string[] {
  return (
    database
      .prepare(
        `SELECT event_type
         FROM github_tree_manifest_lifecycle_events
         WHERE project_id = ? AND manifest_id = ?
         ORDER BY CASE event_type
           WHEN 'failed' THEN 0
           WHEN 'purge_chunk' THEN 1
           ELSE 2
         END, recorded_at, event_id`
      )
      .all(manifest.projectId, manifest.manifestId) as Array<{
      event_type: string;
    }>
  ).map((row) => row.event_type);
}

function retentionCursorVersion(
  database: DatabaseSync,
  lane: "staging" | "failed"
): number {
  return (
    database
      .prepare(
        `SELECT cursor_version
         FROM github_tree_manifest_retention_cursors WHERE lane = ?`
      )
      .get(lane) as { cursor_version: number }
  ).cursor_version;
}

function ageFailedManifest(
  database: DatabaseSync,
  manifest: GitHubTreeManifestDescriptor,
  failedAt: string
): void {
  withManifestTransitionGuardDisabled(database, () => {
    database
      .prepare(
        `UPDATE github_tree_manifests SET failed_at = ?
         WHERE project_id = ? AND manifest_id = ? AND status = 'failed'`
      )
      .run(failedAt, manifest.projectId, manifest.manifestId);
  });
}

function makePurgeRetryDue(
  database: DatabaseSync,
  manifest: GitHubTreeManifestDescriptor
): void {
  const retryAt = new Date(Date.now() - 60_000).toISOString();
  withManifestTransitionGuardDisabled(database, () => {
    database
      .prepare(
        `UPDATE github_tree_manifests
         SET retention_next_attempt_at = ?, purge_lease_until = ?
         WHERE project_id = ? AND manifest_id = ? AND status = 'purging'`
      )
      .run(retryAt, retryAt, manifest.projectId, manifest.manifestId);
  });
}

function withManifestTransitionGuardDisabled(
  database: DatabaseSync,
  action: () => void
): void {
  // Production timestamps come from D1; only deterministic retention fixtures
  // bypass the transition trigger to represent data older than 30 days.
  const trigger = database
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'github_tree_manifests_state_transition_guard'`
    )
    .get() as { sql: string } | undefined;
  if (trigger?.sql === undefined) {
    throw new Error("The manifest transition trigger is unavailable.");
  }
  database.exec("DROP TRIGGER github_tree_manifests_state_transition_guard");
  try {
    action();
  } finally {
    database.exec(trigger.sql);
  }
}

function emptyRetentionResult() {
  return {
    failedStaging: 0,
    claimed: 0,
    entriesDeleted: 0,
    purged: 0,
    errors: 0
  };
}

function createFixture(): {
  database: DatabaseSync;
  d1: D1Database;
  adapter: SqliteD1;
} {
  const database = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) {
    database.exec(readFileSync(migration, "utf8"));
  }
  const adapter = new SqliteD1(database);
  return {
    database,
    d1: adapter as unknown as D1Database,
    adapter
  };
}

function seedProjectRepository(
  database: DatabaseSync,
  projectId: string,
  repositoryId: string,
  externalId: number,
  projectRef: string = `project.${projectId}`
): void {
  const now = "2026-05-01T00:00:00.000Z";
  database
    .prepare(
      `INSERT INTO projects
       (project_id, project_ref, locator, display_name, project_version,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(projectId, projectRef, `locator.${projectId}`, projectId, now, now);
  database
    .prepare(
      `INSERT INTO repositories
       (repository_id, project_id, provider, external_id, owner, name,
        default_branch, tracked_refs_json, sync_enabled, created_at, updated_at,
        expected_owner_external_id)
       VALUES (?, ?, 'github', ?, 'memenow', ?, 'main', '[]', 1, ?, ?, 7)`
    )
    .run(repositoryId, projectId, externalId, repositoryId, now, now);
}

interface ExecutedSql {
  sql: string;
  bindings: SQLInputValue[];
  resultCount: number;
}

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: SQLInputValue[] = [],
    private readonly allExecutions: ExecutedSql[] = []
  ) {}

  bind(...bindings: SQLInputValue[]): SqliteD1Statement {
    return new SqliteD1Statement(
      this.database,
      this.sql,
      bindings,
      this.allExecutions
    );
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = this.statement().all(...this.bindings) as T[];
    this.allExecutions.push({
      sql: this.sql,
      bindings: [...this.bindings],
      resultCount: results.length
    });
    return {
      ...d1Result(0),
      results
    };
  }

  runSync(): D1Result {
    const result = this.statement().run(...this.bindings);
    return d1Result(Number(result.changes));
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

function d1Result(changes: number): D1Result {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes
    },
    results: []
  };
}

class SqliteD1 {
  readonly allExecutions: ExecutedSql[] = [];

  constructor(readonly databaseSync: DatabaseSync) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(
      this.databaseSync,
      sql,
      [],
      this.allExecutions
    );
  }

  withSession(): SqliteD1 {
    return this;
  }

  async batch(statements: SqliteD1Statement[]): Promise<D1Result[]> {
    this.databaseSync.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.databaseSync.exec("COMMIT");
      return results;
    } catch (error) {
      this.databaseSync.exec("ROLLBACK");
      throw error;
    }
  }
}
