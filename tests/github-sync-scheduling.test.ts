import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GitHubSyncError } from "../src/github/client";
import {
  GITHUB_SYNC_REQUEST_INTERVAL_MS,
  GITHUB_SYNC_REQUEST_BUDGET,
  claimRepositorySync,
  finishRepositorySyncRun,
  markUnchanged,
  materializeAndSelectScheduledRefs,
  recordSyncFailure,
  requiresFullReconciliation,
  type ConfiguredRefRow,
  type ScheduledRefRow
} from "../workers/github-sync/index";

const SCHEDULED_TIME = Date.parse("2026-07-29T06:00:00.000Z");

describe("GitHub ref scheduling", () => {
  it("materializes and selects every due configured ref", async () => {
    const fixture = createSchedulingFixture();
    for (const repositoryId of ["repository-a", "repository-b", "repository-c", "repository-d", "repository-e"]) {
      insertRepository(fixture.database, "project-1", repositoryId);
    }
    insertCursor(fixture.database, "repository-a", "refs/heads/main", {
      updatedAt: "2026-07-29T00:03:00.000Z"
    });
    insertCursor(fixture.database, "repository-a", "refs/heads/release", {
      updatedAt: "2026-07-29T00:01:00.000Z"
    });
    insertCursor(fixture.database, "repository-b", "refs/heads/main", {
      updatedAt: "2026-07-29T00:02:00.000Z"
    });
    insertCursor(fixture.database, "repository-c", "refs/heads/main", {
      status: "paused",
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    insertCursor(fixture.database, "repository-d", "refs/heads/main", {
      nextSyncAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const configured = [
      configuredRef("repository-a", "refs/heads/main"),
      configuredRef("repository-a", "refs/heads/release"),
      configuredRef("repository-b", "refs/heads/main"),
      configuredRef("repository-c", "refs/heads/main"),
      configuredRef("repository-d", "refs/heads/main"),
      configuredRef("repository-e", "refs/heads/main")
    ];

    const selected = await materializeAndSelectScheduledRefs(
      fixture.d1,
      configured,
      SCHEDULED_TIME
    );

    expect(selected.map(({ repository_id, ref }) => [repository_id, ref])).toEqual([
      ["repository-a", "refs/heads/release"],
      ["repository-b", "refs/heads/main"],
      ["repository-a", "refs/heads/main"],
      ["repository-e", "refs/heads/main"]
    ]);
    expect(
      fixture.database
        .prepare(
          `SELECT status, next_sync_at FROM sync_cursors
           WHERE project_id = ? AND repository_id = ? AND ref = ?`
        )
        .get("project-1", "repository-e", "refs/heads/main")
    ).toEqual({
      status: "idle",
      next_sync_at: "2026-07-29T06:00:00.000Z"
    });
  });

  it("uses the project, repository, and ref tuple as a stable tie-breaker", async () => {
    const fixture = createSchedulingFixture();
    insertRepository(fixture.database, "project-b", "repository-b");
    insertRepository(fixture.database, "project-a", "repository-a");

    const selected = await materializeAndSelectScheduledRefs(
      fixture.d1,
      [
        configuredRef("repository-b", "refs/heads/main", "project-b"),
        configuredRef("repository-a", "refs/heads/release", "project-a"),
        configuredRef("repository-a", "refs/heads/main", "project-a")
      ],
      SCHEDULED_TIME
    );

    expect(selected.map(({ project_id, repository_id, ref }) => [
      project_id,
      repository_id,
      ref
    ])).toEqual([
      ["project-a", "repository-a", "refs/heads/main"],
      ["project-a", "repository-a", "refs/heads/release"],
      ["project-b", "repository-b", "refs/heads/main"]
    ]);
  });

  it.each(["paused", "disabled"] as const)(
    "skips a ref that is %s after scheduling but before its repository claim",
    async (mutation) => {
      const fixture = createSchedulingFixture();
      insertRepository(fixture.database, "project-1", "repository-a");
      insertCursor(fixture.database, "repository-a", "refs/heads/main", {
        updatedAt: "2026-07-29T00:00:00.000Z"
      });
      const [selected] = await materializeAndSelectScheduledRefs(
        fixture.d1,
        [configuredRef("repository-a", "refs/heads/main")],
        SCHEDULED_TIME
      );
      expect(selected).toBeDefined();
      if (mutation === "paused") {
        fixture.database
          .prepare(
            `UPDATE sync_cursors
             SET status = 'paused', updated_at = '2026-07-29T06:00:01.000Z'
             WHERE project_id = 'project-1'
               AND repository_id = 'repository-a'
               AND ref = 'refs/heads/main'`
          )
          .run();
      } else {
        fixture.database
          .prepare(
            `UPDATE repositories SET sync_enabled = 0
             WHERE project_id = 'project-1'
               AND repository_id = 'repository-a'`
          )
          .run();
      }

      await expect(
        claimRepositorySync(fixture.d1, selected as ScheduledRefRow, SCHEDULED_TIME, true)
      ).resolves.toBeNull();
      expect(
        fixture.database
          .prepare(`SELECT COUNT(*) AS count FROM github_repository_sync_runs`)
          .get()
      ).toEqual({ count: 0 });
    }
  );

  it("keeps one active repository lease across overlapping schedules", async () => {
    const fixture = createSchedulingFixture();
    insertRepository(fixture.database, "project-1", "repository-a");
    insertCursor(fixture.database, "repository-a", "refs/heads/main", {
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const [selected] = await materializeAndSelectScheduledRefs(
      fixture.d1,
      [configuredRef("repository-a", "refs/heads/main")],
      SCHEDULED_TIME
    );
    expect(selected).toBeDefined();

    const firstRunId = await claimRepositorySync(
      fixture.d1,
      selected as ScheduledRefRow,
      SCHEDULED_TIME,
      true
    );
    const overlappingRunId = await claimRepositorySync(
      fixture.d1,
      selected as ScheduledRefRow,
      SCHEDULED_TIME + 60_000,
      true
    );

    expect(firstRunId).toMatch(/^[0-9a-f]{64}$/u);
    expect(overlappingRunId).toBeNull();
    expect(
      fixture.database
        .prepare(
          `SELECT status, COUNT(*) AS count
           FROM github_repository_sync_runs GROUP BY status`
        )
        .get()
    ).toEqual({ status: "running", count: 1 });
  });

  it("claims two refs from the same repository independently in one slot", async () => {
    const fixture = createSchedulingFixture();
    insertRepository(fixture.database, "project-1", "repository-a");
    insertCursor(fixture.database, "repository-a", "refs/heads/main", {
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    insertCursor(fixture.database, "repository-a", "refs/heads/release", {
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const selected = await materializeAndSelectScheduledRefs(
      fixture.d1,
      [
        configuredRef("repository-a", "refs/heads/main"),
        configuredRef("repository-a", "refs/heads/release")
      ],
      SCHEDULED_TIME
    );

    const runIds = await Promise.all(
      selected.map((row) =>
        claimRepositorySync(fixture.d1, row, SCHEDULED_TIME, true)
      )
    );

    expect(runIds).toHaveLength(2);
    expect(runIds.every((runId) => /^[0-9a-f]{64}$/u.test(runId ?? ""))).toBe(
      true
    );
    expect(new Set(runIds).size).toBe(2);
    expect(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM github_repository_sync_runs
         WHERE project_id = 'project-1' AND repository_id = 'repository-a'
           AND scheduled_for = '2026-07-29T06:00:00.000Z'`
      ).get()
    ).toEqual({ count: 2 });
  });

  it("recovers an exact repository claim after D1 commits but loses the response", async () => {
    const responseLost = new Error("synthetic claim response lost");
    const fault: SqliteD1Fault = {
      mode: "after_commit",
      matches: (sql) => sql.includes("INSERT INTO github_repository_sync_runs"),
      error: responseLost,
      remaining: 1
    };
    const fixture = createSchedulingFixture(fault);
    insertRepository(fixture.database, "project-1", "repository-a");
    insertCursor(fixture.database, "repository-a", "refs/heads/main", {
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const [selected] = await materializeAndSelectScheduledRefs(
      fixture.d1,
      [configuredRef("repository-a", "refs/heads/main")],
      SCHEDULED_TIME
    );
    expect(selected).toBeDefined();

    const runId = await claimRepositorySync(
      fixture.d1,
      selected as ScheduledRefRow,
      SCHEDULED_TIME,
      true
    );

    expect(runId).toMatch(/^[0-9a-f]{64}$/u);
    expect(fault.remaining).toBe(0);
    expect(
      fixture.database.prepare(
        `SELECT run_id, project_id, repository_id, scheduled_for,
                full_reconciliation, status, claimed_ref,
                claimed_head_manifest_id, claimed_head_version,
                repository_configuration_version, cursor_version,
                claim_contract_version
         FROM github_repository_sync_runs`
      ).get()
    ).toEqual({
      run_id: runId,
      project_id: "project-1",
      repository_id: "repository-a",
      scheduled_for: "2026-07-29T06:00:00.000Z",
      full_reconciliation: 1,
      status: "running",
      claimed_ref: "refs/heads/main",
      claimed_head_manifest_id: null,
      claimed_head_version: 0,
      repository_configuration_version: 1,
      cursor_version: 1,
      claim_contract_version: 1
    });
  });

  it("recovers an exact repository finish after D1 commits but loses the response", async () => {
    const completedAt = "2026-07-29T06:05:00.000Z";
    const fixture = createSchedulingFixture({
      mode: "after_commit",
      matches: (sql) =>
        sql.includes("UPDATE github_repository_sync_runs") &&
        sql.includes("SET status = ?"),
      error: new Error("synthetic finish response lost"),
      remaining: 1
    });
    insertRepository(fixture.database, "project-1", "repository-a");
    insertCursor(fixture.database, "repository-a", "refs/heads/main", {
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const [selected] = await materializeAndSelectScheduledRefs(
      fixture.d1,
      [configuredRef("repository-a", "refs/heads/main")],
      SCHEDULED_TIME
    );
    const runId = await claimRepositorySync(
      fixture.d1,
      selected as ScheduledRefRow,
      SCHEDULED_TIME,
      true
    );
    expect(runId).not.toBeNull();

    await expect(
      finishRepositorySyncRun(fixture.d1, runId as string, null, completedAt)
    ).resolves.toBe(completedAt);
    expect(
      fixture.database.prepare(
        `SELECT status, completed_at, last_error_code
         FROM github_repository_sync_runs WHERE run_id = ?`
      ).get(runId as string)
    ).toEqual({ status: "complete", completed_at: completedAt, last_error_code: null });
  });

  it("preserves a repository claim error when D1 did not commit the row", async () => {
    const writeFailed = new Error("synthetic claim write failure");
    const fixture = createSchedulingFixture({
      mode: "before_commit",
      matches: (sql) => sql.includes("INSERT INTO github_repository_sync_runs"),
      error: writeFailed,
      remaining: 1
    });
    insertRepository(fixture.database, "project-1", "repository-a");
    insertCursor(fixture.database, "repository-a", "refs/heads/main", {
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const [selected] = await materializeAndSelectScheduledRefs(
      fixture.d1,
      [configuredRef("repository-a", "refs/heads/main")],
      SCHEDULED_TIME
    );
    expect(selected).toBeDefined();

    await expect(
      claimRepositorySync(
        fixture.d1,
        selected as ScheduledRefRow,
        SCHEDULED_TIME,
        true
      )
    ).rejects.toBe(writeFailed);
    expect(
      fixture.database
        .prepare(`SELECT COUNT(*) AS count FROM github_repository_sync_runs`)
        .get()
    ).toEqual({ count: 0 });
  });

  it("prevents stale and pre-claim failures from overwriting a newer active run", async () => {
    const fixture = createSchedulingFixture();
    insertRepository(fixture.database, "project-1", "repository-a");
    insertCursor(fixture.database, "repository-a", "refs/heads/main", {
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const [selected] = await materializeAndSelectScheduledRefs(
      fixture.d1,
      [configuredRef("repository-a", "refs/heads/main")],
      SCHEDULED_TIME
    );
    expect(selected).toBeDefined();
    const selectedRef = selected as ScheduledRefRow;
    const staleRunId = await claimRepositorySync(
      fixture.d1,
      selectedRef,
      SCHEDULED_TIME,
      true
    );
    expect(staleRunId).not.toBeNull();
    finishSyntheticRun(fixture.database, staleRunId as string);
    const activeRunId = await claimRepositorySync(
      fixture.d1,
      selectedRef,
      SCHEDULED_TIME + 60_000,
      true
    );
    expect(activeRunId).not.toBeNull();

    const failure = new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    await recordSyncFailure(
      fixture.d1,
      selectedRef,
      selectedRef.ref,
      failure,
      SCHEDULED_TIME,
      "active",
      selectedRef,
      staleRunId
    );
    await recordSyncFailure(
      fixture.d1,
      selectedRef,
      selectedRef.ref,
      failure,
      SCHEDULED_TIME,
      "active",
      selectedRef
    );
    await expect(
      markUnchanged(
        fixture.d1,
        selectedRef,
        selectedRef.ref,
        SCHEDULED_TIME,
        '"stale"',
        undefined,
        "active",
        staleRunId as string
      )
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });

    expect(readCursorState(fixture.database)).toEqual({
      status: "idle",
      etag: null,
      last_error_code: null,
      updated_at: "2026-07-29T00:00:00.000Z"
    });
  });

  it.each(["repository configuration", "paused cursor"] as const)(
    "rejects %s ABA after a protocol-one run claim",
    async (mutation) => {
      const fixture = createSchedulingFixture();
      insertRepository(fixture.database, "project-1", "repository-a");
      insertCursor(fixture.database, "repository-a", "refs/heads/main", {
        updatedAt: "2026-07-29T00:00:00.000Z"
      });
      const [selected] = await materializeAndSelectScheduledRefs(
        fixture.d1,
        [configuredRef("repository-a", "refs/heads/main")],
        SCHEDULED_TIME
      );
      expect(selected).toBeDefined();
      const selectedRef = selected as ScheduledRefRow;
      const runId = await claimRepositorySync(
        fixture.d1,
        selectedRef,
        SCHEDULED_TIME,
        true
      );
      expect(runId).not.toBeNull();

      if (mutation === "repository configuration") {
        fixture.database.prepare(
          `UPDATE repositories
           SET name = 'temporary-name', github_sync_configuration_version = 2,
               updated_at = '2026-07-29T06:00:01.000Z'
           WHERE project_id = 'project-1' AND repository_id = 'repository-a'`
        ).run();
        fixture.database.prepare(
          `UPDATE repositories
           SET name = 'repository-a', github_sync_configuration_version = 3,
               updated_at = '2026-07-29T00:00:00.000Z'
           WHERE project_id = 'project-1' AND repository_id = 'repository-a'`
        ).run();
      } else {
        fixture.database.prepare(
          `UPDATE sync_cursors
           SET status = 'paused', cursor_version = 2,
               updated_at = '2026-07-29T06:00:01.000Z'
           WHERE project_id = 'project-1'
             AND repository_id = 'repository-a'
             AND ref = 'refs/heads/main'`
        ).run();
        fixture.database.prepare(
          `UPDATE sync_cursors
           SET status = 'idle', cursor_version = 3,
               updated_at = '2026-07-29T00:00:00.000Z'
           WHERE project_id = 'project-1'
             AND repository_id = 'repository-a'
             AND ref = 'refs/heads/main'`
        ).run();
      }

      const failure = new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
      await recordSyncFailure(
        fixture.d1,
        selectedRef,
        selectedRef.ref,
        failure,
        SCHEDULED_TIME,
        "active",
        selectedRef,
        runId
      );
      await expect(
        markUnchanged(
          fixture.d1,
          selectedRef,
          selectedRef.ref,
          SCHEDULED_TIME,
          '"stale"',
          undefined,
          "active",
          runId as string
        )
      ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });

      expect(readCursorState(fixture.database)).toEqual({
        status: "idle",
        etag: null,
        last_error_code: null,
        updated_at: "2026-07-29T00:00:00.000Z"
      });
      expect(
        fixture.database.prepare(
          `SELECT cursor_version FROM sync_cursors
           WHERE project_id = 'project-1'
             AND repository_id = 'repository-a'
             AND ref = 'refs/heads/main'`
        ).get()
      ).toEqual({ cursor_version: mutation === "paused cursor" ? 3 : 1 });
    }
  );

  it("allows terminal cursor writes for an exact protocol-one run claim", async () => {
    const failureFixture = createSchedulingFixture();
    insertRepository(failureFixture.database, "project-1", "repository-a");
    insertCursor(failureFixture.database, "repository-a", "refs/heads/main", {
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const [failureSelection] = await materializeAndSelectScheduledRefs(
      failureFixture.d1,
      [configuredRef("repository-a", "refs/heads/main")],
      SCHEDULED_TIME
    );
    expect(failureSelection).toBeDefined();
    const failureRunId = await claimRepositorySync(
      failureFixture.d1,
      failureSelection as ScheduledRefRow,
      SCHEDULED_TIME,
      true
    );
    expect(failureRunId).not.toBeNull();
    await recordSyncFailure(
      failureFixture.d1,
      failureSelection as ScheduledRefRow,
      "refs/heads/main",
      new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE"),
      SCHEDULED_TIME,
      "active",
      failureSelection as ScheduledRefRow,
      failureRunId
    );
    expect(readCursorState(failureFixture.database)).toMatchObject({
      status: "failed",
      last_error_code: "GITHUB_REPOSITORY_UNAVAILABLE"
    });

    const unchangedFixture = createSchedulingFixture();
    insertRepository(unchangedFixture.database, "project-1", "repository-a");
    insertCursor(unchangedFixture.database, "repository-a", "refs/heads/main", {
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const [unchangedSelection] = await materializeAndSelectScheduledRefs(
      unchangedFixture.d1,
      [configuredRef("repository-a", "refs/heads/main")],
      SCHEDULED_TIME
    );
    expect(unchangedSelection).toBeDefined();
    const unchangedRunId = await claimRepositorySync(
      unchangedFixture.d1,
      unchangedSelection as ScheduledRefRow,
      SCHEDULED_TIME,
      true
    );
    expect(unchangedRunId).not.toBeNull();
    await markUnchanged(
      unchangedFixture.d1,
      unchangedSelection as ScheduledRefRow,
      "refs/heads/main",
      SCHEDULED_TIME,
      '"current"',
      undefined,
      "active",
      unchangedRunId as string
    );
    expect(readCursorState(unchangedFixture.database)).toMatchObject({
      status: "complete",
      etag: '"current"',
      last_error_code: null
    });
  });

  it("recovers an exact unchanged cursor write after D1 commits but loses the response", async () => {
    const responseLost = new Error("synthetic unchanged response lost");
    const fault: SqliteD1Fault = {
      mode: "after_commit",
      matches: (sql) =>
        sql.includes("UPDATE sync_cursors") && sql.includes("SET status = 'complete'"),
      error: responseLost,
      remaining: 1
    };
    const fixture = createSchedulingFixture(fault);
    insertRepository(fixture.database, "project-1", "repository-a");
    insertCursor(fixture.database, "repository-a", "refs/heads/main", {
      observedSha: "a".repeat(40),
      historyGapPossible: 1,
      lastErrorCode: "GITHUB_RECONCILIATION_REQUIRED",
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const [selected] = await materializeAndSelectScheduledRefs(
      fixture.d1,
      [configuredRef("repository-a", "refs/heads/main")],
      SCHEDULED_TIME
    );
    expect(selected).toBeDefined();
    const selectedRef = selected as ScheduledRefRow;
    const runId = await claimRepositorySync(
      fixture.d1,
      selectedRef,
      SCHEDULED_TIME,
      true
    );
    expect(runId).not.toBeNull();

    await expect(
      markUnchanged(
        fixture.d1,
        selectedRef,
        selectedRef.ref,
        SCHEDULED_TIME,
        '"current"',
        undefined,
        "expiring",
        runId as string
      )
    ).resolves.toBeUndefined();

    expect(fault.remaining).toBe(0);
    expect(
      fixture.database.prepare(
        `SELECT observed_sha, status, last_sync_at, next_sync_at,
                history_gap_possible, credential_status, etag,
                last_error_code, updated_at, cursor_version
         FROM sync_cursors
         WHERE project_id = 'project-1'
           AND repository_id = 'repository-a'
           AND ref = 'refs/heads/main'`
      ).get()
    ).toEqual({
      observed_sha: "a".repeat(40),
      status: "complete",
      last_sync_at: "2026-07-29T06:00:00.000Z",
      next_sync_at: "2026-07-29T12:00:00.000Z",
      history_gap_possible: 0,
      credential_status: "expiring",
      etag: '"current"',
      last_error_code: null,
      updated_at: expect.any(String),
      cursor_version: 2
    });
    expect(
      fixture.database.prepare(
        `SELECT status, completed_at, last_error_code
         FROM github_repository_sync_runs WHERE run_id = ?`
      ).get(runId as string)
    ).toEqual({
      status: "running",
      completed_at: null,
      last_error_code: null
    });
  });

  it("preserves an unchanged cursor error when D1 did not commit the update", async () => {
    const writeFailed = new Error("synthetic unchanged write failure");
    const fixture = createSchedulingFixture({
      mode: "before_commit",
      matches: (sql) =>
        sql.includes("UPDATE sync_cursors") && sql.includes("SET status = 'complete'"),
      error: writeFailed,
      remaining: 1
    });
    insertRepository(fixture.database, "project-1", "repository-a");
    insertCursor(fixture.database, "repository-a", "refs/heads/main", {
      observedSha: "b".repeat(40),
      updatedAt: "2026-07-29T00:00:00.000Z"
    });
    const [selected] = await materializeAndSelectScheduledRefs(
      fixture.d1,
      [configuredRef("repository-a", "refs/heads/main")],
      SCHEDULED_TIME
    );
    expect(selected).toBeDefined();
    const selectedRef = selected as ScheduledRefRow;
    const runId = await claimRepositorySync(
      fixture.d1,
      selectedRef,
      SCHEDULED_TIME,
      true
    );
    expect(runId).not.toBeNull();

    await expect(
      markUnchanged(
        fixture.d1,
        selectedRef,
        selectedRef.ref,
        SCHEDULED_TIME,
        '"current"',
        undefined,
        "active",
        runId as string
      )
    ).rejects.toBe(writeFailed);
    expect(readCursorState(fixture.database)).toEqual({
      status: "idle",
      etag: null,
      last_error_code: null,
      updated_at: "2026-07-29T00:00:00.000Z"
    });
  });

  it("dispatches every due ref each slot and performs one full reconciliation per UTC day", async () => {
    const fixture = createSchedulingFixture();
    const repositories = ["repository-a", "repository-b", "repository-c", "repository-d"];
    const configured = repositories.map((repositoryId) =>
      configuredRef(repositoryId, "refs/heads/main")
    );
    for (const [index, repositoryId] of repositories.entries()) {
      insertRepository(fixture.database, "project-1", repositoryId);
      insertCursor(fixture.database, repositoryId, "refs/heads/main", {
        lastSyncAt: "2026-07-28T18:00:00.000Z",
        updatedAt: `2026-07-28T00:0${index}:00.000Z`
      });
    }

    const midnight = Date.parse("2026-07-29T00:00:00.000Z");
    const midnightSelection = await materializeAndSelectScheduledRefs(
      fixture.d1,
      configured,
      midnight
    );
    expect(midnightSelection.map((row) => row.repository_id)).toEqual([
      "repository-a",
      "repository-b",
      "repository-c",
      "repository-d"
    ]);
    expect(
      midnightSelection.every((row) =>
        requiresFullReconciliation(midnight, row.last_sync_at)
      )
    ).toBe(true);
    markCursorAttempt(
      fixture.database,
      repositories,
      "2026-07-29T00:00:00.000Z",
      "2026-07-29T06:00:00.000Z"
    );

    const sixUtc = Date.parse("2026-07-29T06:00:00.000Z");
    const sixUtcSelection = await materializeAndSelectScheduledRefs(
      fixture.d1,
      configured,
      sixUtc
    );
    expect(sixUtcSelection.map((row) => row.repository_id)).toEqual([
      "repository-a",
      "repository-b",
      "repository-c",
      "repository-d"
    ]);
    expect(
      sixUtcSelection.every((row) =>
        !requiresFullReconciliation(sixUtc, row.last_sync_at)
      )
    ).toBe(true);
    markCursorAttempt(
      fixture.database,
      repositories,
      "2026-07-29T06:00:00.000Z",
      "2026-07-29T12:00:00.000Z"
    );

    const noonUtc = Date.parse("2026-07-29T12:00:00.000Z");
    const noonSelection = await materializeAndSelectScheduledRefs(
      fixture.d1,
      configured,
      noonUtc
    );
    expect(noonSelection.map((row) => row.repository_id)).toEqual([
      "repository-a",
      "repository-b",
      "repository-c",
      "repository-d"
    ]);
    expect(
      noonSelection.every(
        (row) => !requiresFullReconciliation(noonUtc, row.last_sync_at)
      )
    ).toBe(true);
  });

  it("catches up the daily full reconciliation after a missed midnight slot", () => {
    const sixUtc = Date.parse("2026-07-29T06:00:00.000Z");
    expect(
      requiresFullReconciliation(sixUtc, "2026-07-28T18:00:00.000Z")
    ).toBe(true);
    expect(
      requiresFullReconciliation(sixUtc, "2026-07-29T00:10:00.000Z")
    ).toBe(false);
  });

  it("bounds each Workflow while dispatching every due ref", () => {
    expect(GITHUB_SYNC_REQUEST_BUDGET).toEqual({
      accessBaseline: 900,
      perRef: 2_005,
      maxRefsPerSchedule: null,
      maxTotalPerWorkflow: 2_005
    });
    expect(GITHUB_SYNC_REQUEST_BUDGET.perRef).toBeLessThan(10_000);
    expect(GITHUB_SYNC_REQUEST_INTERVAL_MS).toBe(80);
  });

  it("configures bounded GitHub Workflows without a Queue", () => {
    const configuration = readFileSync("wrangler/github-sync.jsonc", "utf8");
    expect(configuration).toContain('"subrequests": 10000');
    expect(configuration.match(/"class_name": "GitHub/g)).toHaveLength(3);
    expect(configuration).not.toContain('"queues"');
  });
});

function configuredRef(
  repositoryId: string,
  ref: string,
  projectId = "project-1"
): ConfiguredRefRow {
  return {
    project_id: projectId,
    repository_id: repositoryId,
    ref
  };
}

function createSchedulingFixture(fault?: SqliteD1Fault): {
  database: DatabaseSync;
  d1: D1Database;
} {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE repositories (
      repository_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_id INTEGER NOT NULL,
      expected_owner_external_id INTEGER,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      default_branch TEXT,
      tracked_refs_json TEXT NOT NULL,
      sync_enabled INTEGER NOT NULL,
      github_sync_configuration_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT '2026-07-29T00:00:00.000Z',
      PRIMARY KEY (project_id, repository_id)
    );
    CREATE TABLE sync_cursors (
      project_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      observed_sha TEXT,
      status TEXT NOT NULL,
      etag TEXT,
      last_sync_at TEXT,
      next_sync_at TEXT,
      history_gap_possible INTEGER NOT NULL,
      credential_status TEXT NOT NULL,
      last_error_code TEXT,
      updated_at TEXT NOT NULL,
      cursor_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (project_id, repository_id, ref)
    );
    CREATE TABLE github_tree_ref_heads (
      project_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      manifest_id TEXT NOT NULL,
      head_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, repository_id, ref)
    );
    CREATE TABLE github_repository_sync_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      full_reconciliation INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      claimed_ref TEXT,
      claimed_head_manifest_id TEXT,
      claimed_head_version INTEGER,
      repository_configuration_version INTEGER,
      cursor_version INTEGER,
      claim_contract_version INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      last_error_code TEXT,
      UNIQUE (project_id, repository_id, claimed_ref, scheduled_for)
    );
    CREATE TABLE github_sync_dispatch_items (
      item_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  return {
    database,
    d1: new SqliteD1(database, fault) as unknown as D1Database
  };
}

function finishSyntheticRun(database: DatabaseSync, runId: string): void {
  database
    .prepare(
      `UPDATE github_repository_sync_runs
       SET status = 'failed', completed_at = '2026-07-29T06:00:00.000Z',
           last_error_code = 'GITHUB_RECONCILIATION_REQUIRED'
       WHERE run_id = ?`
    )
    .run(runId);
}

function readCursorState(database: DatabaseSync): {
  status: string;
  etag: string | null;
  last_error_code: string | null;
  updated_at: string;
} {
  return database
    .prepare(
      `SELECT status, etag, last_error_code, updated_at
       FROM sync_cursors
       WHERE project_id = 'project-1'
         AND repository_id = 'repository-a'
         AND ref = 'refs/heads/main'`
    )
    .get() as {
    status: string;
    etag: string | null;
    last_error_code: string | null;
    updated_at: string;
  };
}

function insertRepository(
  database: DatabaseSync,
  projectId: string,
  repositoryId: string
): void {
  database.prepare(
    `INSERT INTO repositories
     (repository_id, project_id, provider, external_id,
      expected_owner_external_id, owner, name, default_branch,
      tracked_refs_json, sync_enabled)
     VALUES (?, ?, 'github', ?, 7, 'memenow', ?, 'main', '[]', 1)`
  ).run(
    repositoryId,
    projectId,
    Math.abs(hashString(`${projectId}:${repositoryId}`)) + 1,
    repositoryId
  );
}

function insertCursor(
  database: DatabaseSync,
  repositoryId: string,
  ref: string,
  options: {
    status?: "idle" | "paused";
    observedSha?: string | null;
    lastSyncAt?: string | null;
    nextSyncAt?: string | null;
    historyGapPossible?: 0 | 1;
    lastErrorCode?: string | null;
    updatedAt: string;
  }
): void {
  database.prepare(
    `INSERT INTO sync_cursors
     (project_id, repository_id, ref, observed_sha, status, next_sync_at,
      last_sync_at, history_gap_possible, credential_status, last_error_code,
      updated_at)
     VALUES ('project-1', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(
    repositoryId,
    ref,
    options.observedSha ?? null,
    options.status ?? "idle",
    options.nextSyncAt ?? null,
    options.lastSyncAt ?? null,
    options.historyGapPossible ?? 0,
    options.lastErrorCode ?? null,
    options.updatedAt
  );
}

function markCursorAttempt(
  database: DatabaseSync,
  repositoryIds: string[],
  attemptedAt: string,
  nextSyncAt: string
): void {
  const statement = database.prepare(
    `UPDATE sync_cursors
     SET last_sync_at = ?, updated_at = ?, next_sync_at = ?
     WHERE project_id = 'project-1' AND repository_id = ?`
  );
  for (const repositoryId of repositoryIds) {
    statement.run(attemptedAt, attemptedAt, nextSyncAt, repositoryId);
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return hash;
}

interface SqliteD1Fault {
  mode: "before_commit" | "after_commit";
  matches: (sql: string) => boolean;
  error: Error;
  remaining: number;
}

class SqliteD1 {
  constructor(
    private readonly database: DatabaseSync,
    private readonly fault?: SqliteD1Fault
  ) {}

  withSession(): SqliteD1 {
    return this;
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, sql, this.fault);
  }
}

class SqliteD1Statement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly fault?: SqliteD1Fault
  ) {}

  bind(...bindings: unknown[]): SqliteD1Statement {
    this.bindings = bindings as SQLInputValue[];
    return this;
  }

  async run(): Promise<unknown> {
    if (
      this.fault !== undefined &&
      this.fault.remaining > 0 &&
      this.fault.mode === "before_commit" &&
      this.fault.matches(this.sql)
    ) {
      this.fault.remaining -= 1;
      throw this.fault.error;
    }
    const result = this.database.prepare(this.sql).run(...this.bindings);
    if (
      this.fault !== undefined &&
      this.fault.remaining > 0 &&
      this.fault.mode === "after_commit" &&
      this.fault.matches(this.sql)
    ) {
      this.fault.remaining -= 1;
      throw this.fault.error;
    }
    return { meta: { changes: Number(result.changes) } };
  }

  async all<T>(): Promise<unknown> {
    return {
      results: this.database.prepare(this.sql).all(...this.bindings) as T[]
    };
  }

  async first<T>(): Promise<T | null> {
    return (
      (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ??
      null
    );
  }
}
