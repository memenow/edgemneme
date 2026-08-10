import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";

// The deployment helper is plain ESM so GitHub Actions can run it without a TS runtime.
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as quiescence from "../scripts/github-sync-quiescence.mjs";
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as quiescenceSql from "../scripts/github-sync-quiescence-sql.mjs";

const NOW = "2026-08-01T00:30:00.000Z";
const BASE = "2026-08-01T00:00:00.000Z";
const FUTURE = "2026-08-01T01:00:00.000Z";
const ERROR = "GITHUB_RECONCILIATION_REQUIRED";

interface RestStatement {
  sql: string;
  params: SQLInputValue[];
}

class SqliteRestRuntime {
  readonly batchSizes: Array<{ label: string; size: number }> = [];
  queryCount = 0;
  batchCount = 0;
  throwAfterCommitLabel: string | null = null;
  afterCommit: ((label: string) => void) | null = null;
  incompatibleParameters = false;

  constructor(readonly database: DatabaseSync) {}

  async query(sql: string, params: SQLInputValue[], label: string) {
    this.queryCount += 1;
    if (label.includes("parameter compatibility")) {
      return {
        results: [{
          number_type: this.incompatibleParameters ? "text" : "integer",
          null_type: this.incompatibleParameters ? "text" : "null"
        }],
        meta: { served_by_primary: true }
      };
    }
    return {
      results: this.database.prepare(sql).all(...params),
      meta: { served_by_primary: true }
    };
  }

  async batch(statements: RestStatement[], label: string) {
    this.batchCount += 1;
    this.batchSizes.push({ label, size: statements.length });
    this.database.exec("BEGIN IMMEDIATE");
    let results: Array<{ results: unknown[]; meta: { served_by_primary: true } }>;
    try {
      results = statements.map((entry) => ({
        results: this.database.prepare(entry.sql).all(...entry.params),
        meta: { served_by_primary: true as const }
      }));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.afterCommit?.(label);
    if (this.throwAfterCommitLabel !== null && label === this.throwAfterCommitLabel) {
      this.throwAfterCommitLabel = null;
      throw new Error("synthetic committed response loss");
    }
    return results;
  }
}

describe("GitHub sync D1 quiescence", () => {
  it("treats an absent workflow schema as a clear no-op and rejects a partial schema", async () => {
    const absent = new SqliteRestRuntime(new DatabaseSync(":memory:"));
    await expect(reconcile(absent)).resolves.toMatchObject({
      schemaState: "absent",
      reconciliationState: "clear"
    });
    expect(absent.batchCount).toBe(0);

    const partialDatabase = new DatabaseSync(":memory:");
    partialDatabase.exec("CREATE TABLE github_sync_dispatches (dispatch_id TEXT)");
    await expect(reconcile(new SqliteRestRuntime(partialDatabase))).rejects.toThrow(
      "missing table"
    );
  });

  it.each(quiescenceSql.QUIESCENCE_REQUIRED_TRIGGERS as string[])(
    "fails closed when required trigger %s is missing",
    async (trigger) => {
      const database = createDatabase();
      database.exec(`DROP TRIGGER ${trigger}`);
      await expect(reconcile(new SqliteRestRuntime(database))).rejects.toThrow(
        `missing trigger ${trigger}`
      );
    }
  );

  it("probes native number/null semantics before mutating D1", async () => {
    const database = createDatabase();
    const repository = seedRepository(database, 1);
    const dispatch = seedDispatch(database, 1, "materialized");
    seedItem(database, repository, dispatch, 1, "pending");
    const runtime = new SqliteRestRuntime(database);
    runtime.incompatibleParameters = true;

    await expect(reconcile(runtime)).rejects.toThrow("scalar parameter semantics");
    expect(singleValue(database, "SELECT status FROM github_sync_dispatch_items")).toBe(
      "pending"
    );
    expect(runtime.batchSizes).toHaveLength(0);
  });

  it("drains pending/no-run work, zero-item dispatches, and an unexpired dangling lane", async () => {
    const database = createDatabase();
    const repository = seedRepository(database, 2);
    const pendingDispatch = seedDispatch(database, 2, "materialized");
    seedItem(database, repository, pendingDispatch, 2, "pending");
    seedDispatch(database, 3, "materialized");
    const completeDispatch = seedDispatch(database, 4, "dispatching");
    seedMaterializationReceipt(database, completeDispatch, 0, completeDispatch.scheduledFor);
    seedLane(database, "credential-dangling", "ref", "missing-run", 1);

    const first = await reconcile(new SqliteRestRuntime(database));
    expect(first).toMatchObject({
      reconciliationState: "pending",
      items: 1,
      dispatches: 3,
      lanes: 1
    });
    expect(
      database.prepare("SELECT status, last_error_code FROM github_sync_dispatch_items").get()
    ).toMatchObject({ status: "failed", last_error_code: ERROR });
    expect(
      database.prepare(
        "SELECT status FROM github_sync_dispatches WHERE dispatch_id = ?"
      ).get(completeDispatch.dispatchId)
    ).toMatchObject({ status: "complete" });
    expect(
      database.prepare(
        "SELECT holder_kind, holder_id, lease_claim_id, lease_epoch FROM github_credential_sync_lane"
      ).get()
    ).toMatchObject({
      holder_kind: null,
      holder_id: null,
      lease_claim_id: null,
      lease_epoch: 1
    });
    await expect(reconcile(new SqliteRestRuntime(database))).resolves.toMatchObject({
      reconciliationState: "clear"
    });
  });

  it("rejects every same-slot unbound item before terminalizing its claim-v1 run", async () => {
    const database = createDatabase();
    const repository = seedRepository(database, 5);
    const run = seedRun(database, repository, 5, "running");
    const firstDispatch = seedDispatch(database, 5, "materialized");
    const secondDispatch = seedDispatch(database, 6, "materialized", run.scheduledFor);
    seedItem(database, repository, firstDispatch, 5, "pending", { scheduledFor: run.scheduledFor });
    seedItem(database, repository, secondDispatch, 6, "pending", { scheduledFor: run.scheduledFor });

    const result = await reconcile(new SqliteRestRuntime(database));
    expect(result).toMatchObject({ items: 2, unboundRuns: 1, reconciliationState: "pending" });
    expect(
      database.prepare(
        "SELECT status, completed_at, last_error_code FROM github_repository_sync_runs"
      ).get()
    ).toMatchObject({ status: "failed", completed_at: NOW, last_error_code: ERROR });
    expect(singleValue(database, "SELECT COUNT(*) FROM github_sync_dispatch_item_rejection_receipts")).toBe(2);
  });

  it("reconciles running pairs and both directions of partial terminal binding", async () => {
    const database = createDatabase();
    const cases = [
      { index: 7, run: "running", item: "running", expected: "failed" },
      { index: 8, run: "complete", item: "running", expected: "complete" },
      { index: 9, run: "running", item: "complete", expected: "complete" },
      { index: 70, run: "failed", item: "running", expected: "failed" },
      { index: 71, run: "running", item: "failed", expected: "failed" },
      {
        index: 72,
        run: "complete",
        item: "complete",
        itemCompletedAt: "2026-08-01T00:20:00.000Z",
        expected: "complete"
      }
    ] as const;
    for (const entry of cases) {
      const repository = seedRepository(database, entry.index);
      const run = seedRun(database, repository, entry.index, entry.run);
      const dispatch = seedDispatch(database, entry.index, "materialized", run.scheduledFor);
      seedItem(database, repository, dispatch, entry.index, entry.item, {
        runId: run.runId,
        scheduledFor: run.scheduledFor,
        ...("itemCompletedAt" in entry ? { completedAt: entry.itemCompletedAt } : {})
      });
    }

    const result = await reconcile(new SqliteRestRuntime(database));
    expect(result).toMatchObject({ boundRuns: 6, reconciliationState: "pending" });
    for (const entry of cases) {
      expect(
        database.prepare(
          `SELECT run.status AS run_status, item.status AS item_status
           FROM github_repository_sync_runs AS run
           JOIN github_sync_dispatch_items AS item ON item.run_id = run.run_id
           WHERE run.repository_id = ?`
        ).get(`repository-${entry.index}`)
      ).toMatchObject({ run_status: entry.expected, item_status: entry.expected });
    }
    expect(singleValue(database, "SELECT COUNT(*) FROM github_repository_sync_finish_receipts")).toBe(6);
  });

  it("recovers a committed response loss and replays to an exact clear state", async () => {
    const database = createDatabase();
    const repository = seedRepository(database, 10);
    const dispatch = seedDispatch(database, 10, "materialized");
    seedItem(database, repository, dispatch, 10, "pending");
    const runtime = new SqliteRestRuntime(database);
    runtime.throwAfterCommitLabel = "Reject disabled GitHub sync unbound items";

    await expect(reconcile(runtime)).resolves.toMatchObject({ reconciliationState: "pending" });
    await expect(reconcile(runtime)).resolves.toMatchObject({ reconciliationState: "clear" });
    expect(singleValue(database, "SELECT COUNT(*) FROM github_sync_dispatch_item_rejection_receipts")).toBe(1);
  });

  it("returns pending across the 20-row boundary and resumes without skipping receipt debt", async () => {
    const database = createDatabase();
    const repository = seedRepository(database, 11);
    for (let index = 0; index < 21; index += 1) {
      const dispatch = seedDispatch(database, 100 + index, "failed");
      seedItem(database, repository, dispatch, 100 + index, "failed", { completedAt: NOW });
    }
    const runtime = new SqliteRestRuntime(database);

    await expect(reconcile(runtime)).resolves.toMatchObject({ items: 20, reconciliationState: "pending" });
    await expect(reconcile(runtime)).resolves.toMatchObject({ items: 1, reconciliationState: "pending" });
    await expect(reconcile(runtime)).resolves.toMatchObject({ items: 0, reconciliationState: "clear" });
    expect(singleValue(database, "SELECT COUNT(*) FROM github_sync_dispatch_item_rejection_receipts")).toBe(21);
    expect(runtime.batchSizes).toContainEqual({
      label: "Reject disabled GitHub sync unbound items",
      size: 40
    });
  });

  it("fails closed on early/future timestamps and impossible calendar dates", async () => {
    await expect(
      quiescence.reconcileGitHubSyncQuiescence(
        options("2026-02-31T00:00:00.000Z"),
        new SqliteRestRuntime(new DatabaseSync(":memory:"))
      )
    ).rejects.toThrow("quiescence time is invalid");

    const futureDatabase = createDatabase();
    const futureRepository = seedRepository(futureDatabase, 12);
    const futureDispatch = seedDispatch(futureDatabase, 12, "failed");
    seedItem(futureDatabase, futureRepository, futureDispatch, 12, "failed", {
      completedAt: FUTURE
    });
    await expect(reconcile(new SqliteRestRuntime(futureDatabase))).rejects.toThrow(
      "outside the quiescence window"
    );

    const earlyDatabase = createDatabase();
    const earlyRepository = seedRepository(earlyDatabase, 13);
    const run = seedRun(earlyDatabase, earlyRepository, 13, "running", {
      startedAt: "2026-08-01T00:10:00.000Z"
    });
    const earlyDispatch = seedDispatch(earlyDatabase, 13, "failed", run.scheduledFor);
    const earlyItem = seedItem(earlyDatabase, earlyRepository, earlyDispatch, 13, "failed", {
      completedAt: "2026-08-01T00:05:00.000Z",
      scheduledFor: run.scheduledFor
    });
    seedRejectionReceipt(earlyDatabase, earlyDispatch, earlyItem, ERROR);
    await expect(reconcile(new SqliteRestRuntime(earlyDatabase))).rejects.toThrow(
      "outside the quiescence window"
    );

    const createdDatabase = createDatabase();
    const createdRepository = seedRepository(createdDatabase, 14);
    const createdRun = seedRun(createdDatabase, createdRepository, 14, "running");
    const createdDispatch = seedDispatch(createdDatabase, 14, "materialized", createdRun.scheduledFor);
    seedItem(createdDatabase, createdRepository, createdDispatch, 14, "running", {
      runId: createdRun.runId,
      scheduledFor: createdRun.scheduledFor,
      createdAt: FUTURE
    });
    await expect(reconcile(new SqliteRestRuntime(createdDatabase))).rejects.toThrow(
      "outside the quiescence window"
    );
  });

  it("fails closed on materialization-count drift and a changed-token lane race", async () => {
    const driftDatabase = createDatabase();
    const driftRepository = seedRepository(driftDatabase, 15);
    const driftDispatch = seedDispatch(driftDatabase, 15, "dispatching");
    seedMaterializationReceipt(driftDatabase, driftDispatch, 0, BASE);
    seedItem(driftDatabase, driftRepository, driftDispatch, 15, "pending");
    await expect(reconcile(new SqliteRestRuntime(driftDatabase))).rejects.toThrow(
      "does not match its dispatch ledger"
    );

    const chronologyDatabase = createDatabase();
    const chronologyRepository = seedRepository(chronologyDatabase, 16);
    const chronologyRun = seedRun(chronologyDatabase, chronologyRepository, 16, "complete", {
      completedAt: "2026-08-01T00:05:00.000Z"
    });
    const chronologyDispatch = seedDispatch(
      chronologyDatabase,
      16,
      "dispatching",
      chronologyRun.scheduledFor
    );
    const chronologyItem = seedItem(
      chronologyDatabase,
      chronologyRepository,
      chronologyDispatch,
      16,
      "complete",
      {
        runId: chronologyRun.runId,
        scheduledFor: chronologyRun.scheduledFor,
        completedAt: "2026-08-01T00:05:00.000Z"
      }
    );
    seedFinishReceipt(
      chronologyDatabase,
      chronologyRepository,
      chronologyRun.runId,
      chronologyItem,
      "complete",
      null
    );
    seedMaterializationReceipt(
      chronologyDatabase,
      chronologyDispatch,
      1,
      "2026-08-01T00:10:00.000Z"
    );
    await expect(reconcile(new SqliteRestRuntime(chronologyDatabase))).rejects.toThrow(
      "does not match its dispatch ledger"
    );

    const earlyItemDatabase = createDatabase();
    const earlyItemRepository = seedRepository(earlyItemDatabase, 17);
    const earlyItemDispatch = seedDispatch(earlyItemDatabase, 17, "materialized");
    const earlyTerminalItem = seedItem(
      earlyItemDatabase,
      earlyItemRepository,
      earlyItemDispatch,
      17,
      "failed",
      {
        createdAt: "2026-08-01T00:20:00.000Z",
        completedAt: "2026-08-01T00:10:00.000Z"
      }
    );
    seedRejectionReceipt(earlyItemDatabase, earlyItemDispatch, earlyTerminalItem, ERROR);
    await expect(reconcile(new SqliteRestRuntime(earlyItemDatabase))).rejects.toThrow(
      "does not match its dispatch ledger"
    );

    const earlyRunDatabase = createDatabase();
    const earlyRunRepository = seedRepository(earlyRunDatabase, 18);
    const earlyRun = seedRun(earlyRunDatabase, earlyRunRepository, 18, "complete", {
      startedAt: "2026-08-01T00:10:00.000Z",
      completedAt: "2026-08-01T00:05:00.000Z"
    });
    const earlyRunDispatch = seedDispatch(
      earlyRunDatabase,
      18,
      "materialized",
      earlyRun.scheduledFor
    );
    const earlyRunItem = seedItem(
      earlyRunDatabase,
      earlyRunRepository,
      earlyRunDispatch,
      18,
      "complete",
      {
        runId: earlyRun.runId,
        scheduledFor: earlyRun.scheduledFor,
        completedAt: "2026-08-01T00:05:00.000Z"
      }
    );
    seedFinishReceipt(
      earlyRunDatabase,
      earlyRunRepository,
      earlyRun.runId,
      earlyRunItem,
      "complete",
      null
    );
    await expect(reconcile(new SqliteRestRuntime(earlyRunDatabase))).rejects.toThrow(
      "does not match its dispatch ledger"
    );

    const laneDatabase = createDatabase();
    seedLane(laneDatabase, "credential-race", "dispatch", "old-holder", 1);
    const laneRuntime = new SqliteRestRuntime(laneDatabase);
    laneRuntime.afterCommit = (label) => {
      if (label !== "Release disabled GitHub sync credential lanes") return;
      laneDatabase.prepare(
        `UPDATE github_credential_sync_lane
         SET holder_kind = 'dispatch', holder_id = 'new-holder',
             lease_claim_id = ?, lease_epoch = 2, lease_until = ?,
             available_after = ?, updated_at = ?
         WHERE credential_version = 'credential-race'`
      ).run(hex("new-claim"), "2026-08-01T02:00:00.000Z", NOW, "2026-08-01T00:31:00.000Z");
    };
    await expect(reconcile(laneRuntime)).rejects.toThrow("exact durable state");
    expect(
      laneDatabase.prepare(
        "SELECT holder_id, lease_epoch FROM github_credential_sync_lane"
      ).get()
    ).toMatchObject({ holder_id: "new-holder", lease_epoch: 2 });
  });

  it("keeps statement and HTTP budgets derived and below platform limits", () => {
    expect(quiescenceSql.QUIESCENCE_BATCH_LIMIT).toBe(20);
    expect(quiescence.QUIESCENCE_PHASE_STATEMENT_BUDGETS).toEqual({
      schema: 1,
      compatibility: 1,
      items: 61,
      boundRuns: 81,
      unboundRuns: 41,
      dispatches: 42,
      lanes: 61
    });
    expect(quiescence.MAX_QUIESCENCE_QUERY_STATEMENTS).toBe(288);
    expect(quiescence.MAX_QUIESCENCE_QUERY_STATEMENTS).toBeLessThan(1_000);
    expect(quiescence.MAX_QUIESCENCE_HTTP_REQUESTS).toBe(18);
    expect(3 * quiescenceSql.QUIESCENCE_BATCH_LIMIT).toBeLessThanOrEqual(64);
  });
});

function options(quiescenceNow = NOW) {
  return {
    config: "unused-by-test-runtime",
    disabledVersion: "absent",
    scheduleState: "clear",
    workflowState: "clear",
    quiescenceNow
  };
}

async function reconcile(runtime: SqliteRestRuntime) {
  return quiescence.reconcileGitHubSyncQuiescence(options(), runtime);
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(join(process.cwd(), "migrations"))
    .filter((entry) => /^\d+.*\.sql$/u.test(entry))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", name), "utf8"));
  }
  return database;
}

interface RepositorySeed {
  projectId: string;
  repositoryId: string;
  ref: string;
  repositoryUpdatedAt: string;
  cursorUpdatedAt: string;
}

function seedRepository(database: DatabaseSync, index: number): RepositorySeed {
  database.prepare(
    `INSERT OR IGNORE INTO projects
     (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
     VALUES ('quiescence-project', 'project.quiescence', 'locator.quiescence',
             'Quiescence', 0, ?, ?)`
  ).run(BASE, BASE);
  const repositoryId = `repository-${index}`;
  database.prepare(
    `INSERT INTO repositories
     (repository_id, project_id, provider, external_id, expected_owner_external_id,
      owner, name, default_branch, tracked_refs_json, sync_enabled, created_at, updated_at)
     VALUES (?, 'quiescence-project', 'github', ?, 7, 'memenow', ?, 'main',
             '[]', 1, ?, ?)`
  ).run(repositoryId, 10_000 + index, `repository-${index}`, BASE, BASE);
  database.prepare(
    `INSERT INTO sync_cursors
     (project_id, repository_id, ref, status, history_gap_possible,
      credential_status, updated_at)
     VALUES ('quiescence-project', ?, 'refs/heads/main', 'idle', 0, 'active', ?)`
  ).run(repositoryId, BASE);
  return {
    projectId: "quiescence-project",
    repositoryId,
    ref: "refs/heads/main",
    repositoryUpdatedAt: BASE,
    cursorUpdatedAt: BASE
  };
}

function seedDispatch(
  database: DatabaseSync,
  index: number,
  status: "materialized" | "dispatching" | "failed",
  scheduledFor = timestampFor(index)
) {
  const dispatchId = hex(`dispatch-${index}`);
  const credentialVersion = `credential-${index}`;
  const terminal = status === "failed";
  database.prepare(
    `INSERT INTO github_sync_dispatches
     (dispatch_id, credential_version, workflow_instance_id, scheduled_for,
      utc_date, status, created_at, completed_at, last_error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    dispatchId,
    credentialVersion,
    `ghd-${dispatchId}`,
    scheduledFor,
    scheduledFor.slice(0, 10),
    status,
    scheduledFor,
    terminal ? NOW : null,
    terminal ? ERROR : null
  );
  return { dispatchId, credentialVersion, scheduledFor };
}

function seedRun(
  database: DatabaseSync,
  repository: RepositorySeed,
  index: number,
  status: "running" | "complete" | "failed",
  overrides: { startedAt?: string; completedAt?: string } = {}
) {
  const runId = `run-${index}`;
  const scheduledFor = timestampFor(index);
  const startedAt = overrides.startedAt ?? scheduledFor;
  const completedAt = status === "running" ? null : (overrides.completedAt ?? "2026-08-01T00:20:00.000Z");
  database.prepare(
    `INSERT INTO github_repository_sync_runs
     (run_id, project_id, repository_id, scheduled_for, full_reconciliation,
      status, started_at, lease_expires_at, completed_at, last_error_code,
      claimed_ref, claimed_head_manifest_id, claimed_head_version,
      repository_configuration_version, cursor_version, claim_contract_version)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL, 0, 1, 1, 1)`
  ).run(
    runId,
    repository.projectId,
    repository.repositoryId,
    scheduledFor,
    status,
    startedAt,
    FUTURE,
    completedAt,
    status === "failed" ? ERROR : null,
    repository.ref
  );
  return { runId, scheduledFor };
}

function seedItem(
  database: DatabaseSync,
  repository: RepositorySeed,
  dispatch: ReturnType<typeof seedDispatch>,
  index: number,
  status: "pending" | "running" | "complete" | "failed",
  overrides: {
    runId?: string;
    scheduledFor?: string;
    completedAt?: string;
    createdAt?: string;
  } = {}
) {
  const itemId = hex(`item-${index}`);
  const completedAt = status === "pending" || status === "running"
    ? null
    : (overrides.completedAt ?? "2026-08-01T00:22:00.000Z");
  const runId = status === "running" || status === "complete"
    ? overrides.runId ?? `missing-run-${index}`
    : overrides.runId ?? null;
  database.prepare(
    `INSERT INTO github_sync_dispatch_items
     (item_id, dispatch_id, project_id, repository_id, ref, scheduled_for,
      full_reconciliation, repository_configuration_version, cursor_version,
      selected_head_manifest_id, selected_head_version, repository_updated_at,
      cursor_status, cursor_updated_at, workflow_instance_id, status, run_id,
      created_at, completed_at, last_error_code)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, NULL, 0, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    itemId,
    dispatch.dispatchId,
    repository.projectId,
    repository.repositoryId,
    repository.ref,
    overrides.scheduledFor ?? dispatch.scheduledFor,
    repository.repositoryUpdatedAt,
    repository.cursorUpdatedAt,
    `ghr-${itemId}`,
    status,
    runId,
    overrides.createdAt ?? dispatch.scheduledFor,
    completedAt,
    status === "failed" ? ERROR : null
  );
  return { itemId, completedAt: completedAt ?? NOW };
}

function seedRejectionReceipt(
  database: DatabaseSync,
  dispatch: ReturnType<typeof seedDispatch>,
  item: ReturnType<typeof seedItem>,
  errorCode: string
) {
  database.prepare(
    `INSERT INTO github_sync_dispatch_item_rejection_receipts
     (receipt_id, dispatch_item_id, dispatch_id, credential_version,
      project_id, repository_id, ref, last_error_code, completed_at)
     SELECT ?, item_id, dispatch_id, ?, project_id, repository_id, ref, ?, ?
     FROM github_sync_dispatch_items WHERE item_id = ?`
  ).run(
    hex(["github.sync.dispatch.item.rejection", item.itemId, errorCode, item.completedAt].join("\n")),
    dispatch.credentialVersion,
    errorCode,
    item.completedAt,
    item.itemId
  );
}

function seedMaterializationReceipt(
  database: DatabaseSync,
  dispatch: ReturnType<typeof seedDispatch>,
  itemCount: number,
  completedAt: string
) {
  database.prepare(
    `INSERT INTO github_sync_dispatch_materialization_receipts
     (receipt_id, dispatch_id, item_count, completed_at) VALUES (?, ?, ?, ?)`
  ).run(
    hex([
      "github.sync.dispatch.materialization",
      dispatch.dispatchId,
      String(itemCount),
      completedAt
    ].join("\n")),
    dispatch.dispatchId,
    itemCount,
    completedAt
  );
}

function seedFinishReceipt(
  database: DatabaseSync,
  repository: RepositorySeed,
  runId: string,
  item: ReturnType<typeof seedItem>,
  status: "complete" | "failed",
  errorCode: string | null
) {
  database.prepare(
    `INSERT INTO github_repository_sync_finish_receipts
     (receipt_id, run_id, dispatch_item_id, project_id, repository_id, ref,
      status, last_error_code, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    hex([
      "github.repository.sync.finish",
      item.itemId,
      runId,
      status,
      errorCode ?? "",
      item.completedAt
    ].join("\n")),
    runId,
    item.itemId,
    repository.projectId,
    repository.repositoryId,
    repository.ref,
    status,
    errorCode,
    item.completedAt
  );
}

function seedLane(
  database: DatabaseSync,
  credentialVersion: string,
  holderKind: "dispatch" | "ref",
  holderId: string,
  epoch: number
) {
  database.prepare(
    `INSERT INTO github_credential_sync_lane
     (credential_version, holder_kind, holder_id, lease_claim_id, lease_epoch,
      lease_until, available_after, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(credentialVersion, holderKind, holderId, hex(`claim-${credentialVersion}`), epoch, FUTURE, BASE, BASE);
}

function singleValue(database: DatabaseSync, sql: string): unknown {
  const row = database.prepare(sql).get() as Record<string, unknown>;
  return Object.values(row)[0];
}

function timestampFor(index: number): string {
  return new Date(Date.parse(BASE) + (index * 1_000)).toISOString();
}

function hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
