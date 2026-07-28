import { describe, expect, it, vi } from "vitest";
import githubSyncWorker, {
  classifyCredentialExpiration,
  isDailyFullReconciliation,
  recordCredentialExpirationObservation
} from "../workers/github-sync/index";

const REPOSITORY_SHA = "b".repeat(40);
const REWRITTEN_SHA = "d".repeat(40);
const TREE_SHA = "c".repeat(40);
const CREDENTIAL_VERSION = "credential-current";
const ACTIVE_EXPIRATION_HEADER = "2099-10-26 00:00:00 UTC";

describe("GitHub credential expiration", () => {
  const expiresAt = "2026-08-31T00:00:00.000Z";
  const expiresAtMs = Date.parse(expiresAt);
  const dayMs = 24 * 60 * 60 * 1_000;

  it.each([
    [15, { status: "active", warningThresholdDays: null }],
    [14, { status: "expiring", warningThresholdDays: 14 }],
    [7, { status: "expiring", warningThresholdDays: 7 }],
    [1, { status: "expiring", warningThresholdDays: 1 }],
    [0, { status: "expired", warningThresholdDays: null }]
  ] as const)("classifies the %i-day boundary", (daysRemaining, expected) => {
    expect(
      classifyCredentialExpiration(
        expiresAt,
        expiresAtMs - daysRemaining * dayMs
      )
    ).toEqual(expected);
  });

  it("records each warning threshold once across repeated cron observations", async () => {
    const warningEvents: CapturedStatement[] = [];
    const states: CapturedStatement[] = [];
    const database = createCredentialObservationDatabase(states, warningEvents);

    for (const daysRemaining of [14, 14, 7, 7, 1, 1]) {
      await recordCredentialExpirationObservation(
        database,
        CREDENTIAL_VERSION,
        expiresAt,
        expiresAtMs - daysRemaining * dayMs
      );
    }

    expect(warningEvents.map((event) => event.bindings[2])).toEqual([14, 7, 1]);
    expect(states.at(-1)?.bindings.slice(3, 5)).toEqual(["expiring", 1]);
    const serialized = JSON.stringify({ warningEvents, states });
    expect(serialized).not.toContain("x-oauth-scopes");
    expect(serialized).not.toContain("GITHUB_CLASSIC_TOKEN");
    expect(serialized).not.toContain("secret binding");
  });

  it("blocks an expired credential before repository enumeration or metadata", async () => {
    const scheduledTime = Date.parse("2026-07-28T00:00:00.000Z");
    const databaseState = createScheduledDatabase();
    const fetcher = createScheduledFetcher({
      expirationHeader: "2026-07-28 00:00:00 UTC",
      notModified: false
    });

    await runScheduled(databaseState.database, fetcher, scheduledTime);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0]?.[0] as Request).url).toBe(
      "https://api.github.com/user"
    );
    expect(databaseState.lastCredentialStatus).toBe("expired");
    expect(databaseState.lastSyncError).toBe("GITHUB_CREDENTIAL_EXPIRED");
    expect(databaseState.runClaims).toHaveLength(0);
  });
});

describe("GitHub scheduled reconciliation", () => {
  it("forces a complete tree manifest reconciliation at 00:00 UTC", async () => {
    const scheduledTime = Date.parse("2026-07-28T00:00:00.000Z");
    const databaseState = createScheduledDatabase();
    const fetcher = createScheduledFetcher({
      expirationHeader: ACTIVE_EXPIRATION_HEADER,
      notModified: false
    });

    await runScheduled(databaseState.database, fetcher, scheduledTime);

    const refRequest = requestForPath(fetcher, "/git/ref/heads/main");
    expect(refRequest.headers.has("if-none-match")).toBe(false);
    expect(requestCount(fetcher, "/commits/")).toBe(1);
    expect(requestCount(fetcher, "/git/trees/")).toBe(1);
    expect(databaseState.runClaims).toEqual([
      expect.objectContaining({ fullReconciliation: 1 })
    ]);
    expect(databaseState.finishedRuns).toEqual([
      expect.objectContaining({ status: "complete", errorCode: null })
    ]);
  });

  it("uses the conditional fast path outside the midnight run", async () => {
    const scheduledTime = Date.parse("2026-07-28T06:00:00.000Z");
    const databaseState = createScheduledDatabase();
    const fetcher = createScheduledFetcher({
      expirationHeader: ACTIVE_EXPIRATION_HEADER,
      notModified: true
    });

    await runScheduled(databaseState.database, fetcher, scheduledTime);

    const refRequest = requestForPath(fetcher, "/git/ref/heads/main");
    expect(refRequest.headers.get("if-none-match")).toBe('"ref-etag"');
    expect(requestCount(fetcher, "/commits/")).toBe(0);
    expect(requestCount(fetcher, "/git/trees/")).toBe(0);
    expect(databaseState.runClaims).toEqual([
      expect.objectContaining({ fullReconciliation: 0 })
    ]);
  });

  it("deduplicates overlapping executions for the same repository and schedule", async () => {
    const scheduledTime = Date.parse("2026-07-28T00:00:00.000Z");
    const databaseState = createScheduledDatabase();
    const fetcher = createScheduledFetcher({
      expirationHeader: ACTIVE_EXPIRATION_HEADER,
      notModified: false
    });

    await runScheduled(databaseState.database, fetcher, scheduledTime);
    await runScheduled(databaseState.database, fetcher, scheduledTime);

    expect(databaseState.runClaims).toHaveLength(1);
    expect(requestExactCount(fetcher, "/repos/memenow/repository-42")).toBe(1);
    expect(requestCount(fetcher, "/git/trees/")).toBe(1);
  });

  it("rejects a different scheduled execution while the repository lease is active", async () => {
    const firstSchedule = Date.parse("2026-07-28T00:00:00.000Z");
    const databaseState = createScheduledDatabase({ leaveRunOpen: true });
    const fetcher = createScheduledFetcher({
      expirationHeader: ACTIVE_EXPIRATION_HEADER,
      notModified: false
    });

    await runScheduled(databaseState.database, fetcher, firstSchedule);
    await runScheduled(
      databaseState.database,
      fetcher,
      firstSchedule + 6 * 60 * 60 * 1_000
    );

    expect(databaseState.runClaims).toHaveLength(1);
    expect(requestExactCount(fetcher, "/repos/memenow/repository-42")).toBe(1);
  });

  it("reclaims an abandoned repository run before the next six-hour poll", async () => {
    vi.useFakeTimers();
    try {
      const firstSchedule = Date.parse("2026-07-28T00:00:00.000Z");
      vi.setSystemTime(firstSchedule);
      const databaseState = createScheduledDatabase({ leaveRunOpen: true });
      const fetcher = createScheduledFetcher({
        expirationHeader: ACTIVE_EXPIRATION_HEADER,
        notModified: false
      });

      await runScheduled(databaseState.database, fetcher, firstSchedule);
      vi.setSystemTime(firstSchedule + 6 * 60 * 60 * 1_000);
      await runScheduled(
        databaseState.database,
        fetcher,
        firstSchedule + 6 * 60 * 60 * 1_000
      );

      expect(databaseState.runClaims).toHaveLength(2);
      expect(requestExactCount(fetcher, "/repos/memenow/repository-42")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["force_push", "ancestry_gap"] as const)(
    "reconciles the current tree after a %s and retains the history-gap marker",
    async (changeKind) => {
      const scheduledTime = Date.parse("2026-07-28T06:00:00.000Z");
      const databaseState = createScheduledDatabase();
      const fetcher = createScheduledFetcher({
        expirationHeader: ACTIVE_EXPIRATION_HEADER,
        notModified: false,
        observedSha: REWRITTEN_SHA,
        comparisonUnavailable: changeKind === "ancestry_gap"
      });

      await runScheduled(databaseState.database, fetcher, scheduledTime);

      expect(requestCount(fetcher, "/compare/")).toBe(1);
      expect(requestCount(fetcher, "/commits/")).toBe(1);
      expect(requestCount(fetcher, "/git/trees/")).toBe(1);
      expect(databaseState.lastHistoryGapPossible).toBe(1);
      expect(databaseState.lastSyncError).toBeNull();
    }
  );

  it("preserves an expiring credential state when repository synchronization fails", async () => {
    const scheduledTime = Date.parse("2026-07-28T06:00:00.000Z");
    const databaseState = createScheduledDatabase();
    const fetcher = createScheduledFetcher({
      expirationHeader: "2026-08-04 06:00:00 UTC",
      notModified: false,
      refStatus: 500
    });

    await runScheduled(databaseState.database, fetcher, scheduledTime);

    expect(databaseState.lastSyncError).toBe("GITHUB_REPOSITORY_UNAVAILABLE");
    expect(databaseState.lastSyncCredentialStatus).toBe("expiring");
    expect(databaseState.finishedRuns).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "GITHUB_REPOSITORY_UNAVAILABLE"
      })
    ]);
  });

  it("fails closed before GitHub access when a synced repository lacks an owner ID", async () => {
    const databaseState = createScheduledDatabase({ expectedOwnerId: null });
    const fetcher = createScheduledFetcher({
      expirationHeader: ACTIVE_EXPIRATION_HEADER,
      notModified: false
    });

    await runScheduled(
      databaseState.database,
      fetcher,
      Date.parse("2026-07-28T06:00:00.000Z")
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(databaseState.lastSyncError).toBe("GITHUB_REPOSITORY_UNAVAILABLE");
    expect(databaseState.runClaims).toHaveLength(0);
  });

  it("recognizes only the UTC midnight minute as the daily full run", () => {
    expect(isDailyFullReconciliation(Date.parse("2026-07-28T00:00:00.000Z"))).toBe(
      true
    );
    expect(isDailyFullReconciliation(Date.parse("2026-07-28T00:00:59.000Z"))).toBe(
      true
    );
    expect(isDailyFullReconciliation(Date.parse("2026-07-28T00:01:00.000Z"))).toBe(
      false
    );
  });
});

interface CapturedStatement {
  sql: string;
  bindings: unknown[];
}

function createCredentialObservationDatabase(
  states: CapturedStatement[],
  warningEvents: CapturedStatement[]
): D1Database {
  const warningKeys = new Set<string>();
  const applyStatement = (statement: CapturedStatement) => {
    if (statement.sql.includes("INSERT INTO github_credential_states")) {
      states.push(statement);
      return { meta: { changes: 1 } };
    }
    if (statement.sql.includes("INSERT INTO github_credential_expiry_warnings")) {
      const key = `${String(statement.bindings[1])}:${String(statement.bindings[2])}`;
      if (warningKeys.has(key)) {
        return { meta: { changes: 0 } };
      }
      warningKeys.add(key);
      warningEvents.push(statement);
      return { meta: { changes: 1 } };
    }
    throw new Error(`unexpected SQL: ${statement.sql}`);
  };
  return {
    prepare: vi.fn().mockImplementation((sql: string) => createStatement(sql, applyStatement)),
    batch: vi.fn().mockImplementation(async (statements: CapturedStatement[]) =>
      statements.map(applyStatement)
    )
  } as unknown as D1Database;
}

function createScheduledDatabase(options: {
  expectedOwnerId?: number | null;
  leaveRunOpen?: boolean;
} = {}) {
  const retentionCursors = new Map([
    ["staging", { afterProjectId: "", afterManifestId: "", version: 0 }],
    ["failed", { afterProjectId: "", afterManifestId: "", version: 0 }]
  ]);
  const runKeys = new Set<string>();
  const runClaims: Array<{ key: string; fullReconciliation: number }> = [];
  const activeRunByRepository = new Map<
    string,
    { runId: string; leaseExpiresAt: string }
  >();
  const finishedRuns: Array<{ status: string; errorCode: string | null }> = [];
  let lastCredentialStatus: string | null = null;
  let lastSyncError: string | null = null;
  let lastSyncCredentialStatus: string | null = null;
  let lastHistoryGapPossible: number | null = null;
  let activeManifestId = "existing-manifest";
  let activeObservedSha = REPOSITORY_SHA;
  let stagedManifest: Record<string, unknown> | null = null;
  const repository = {
    repository_id: "repository-1",
    project_id: "project-1",
    external_id: 42,
    expected_owner_external_id: options.expectedOwnerId === undefined
      ? 7
      : options.expectedOwnerId,
    owner: "memenow",
    name: "repository-42",
    default_branch: "main",
    tracked_refs_json: "[]"
  };
  const applyStatement = (statement: CapturedStatement) => {
    if (statement.sql.includes("UPDATE github_tree_manifest_retention_cursors")) {
      const lane = String(statement.bindings[2]);
      const cursor = retentionCursors.get(lane);
      if (
        cursor === undefined ||
        cursor.version !== Number(statement.bindings[3]) ||
        cursor.afterProjectId !== String(statement.bindings[4]) ||
        cursor.afterManifestId !== String(statement.bindings[5])
      ) {
        return { meta: { changes: 0 } };
      }
      retentionCursors.set(lane, {
        afterProjectId: String(statement.bindings[0]),
        afterManifestId: String(statement.bindings[1]),
        version: cursor.version + 1
      });
      return { meta: { changes: 1 } };
    }
    if (statement.sql.includes("INSERT INTO github_credential_states")) {
      if (statement.bindings.length >= 4) {
        lastCredentialStatus = String(statement.bindings[3]);
      } else if (lastCredentialStatus !== "expired") {
        lastCredentialStatus = "invalid";
      }
      return { meta: { changes: 1 } };
    }
    if (
      statement.sql.includes("UPDATE github_repository_sync_runs") &&
      statement.sql.includes("last_error_code = 'GITHUB_RECONCILIATION_REQUIRED'")
    ) {
      const cutoff = String(statement.bindings[3]);
      let changes = 0;
      for (const [repositoryKey, activeRun] of activeRunByRepository) {
        if (activeRun.leaseExpiresAt <= cutoff) {
          activeRunByRepository.delete(repositoryKey);
          changes += 1;
        }
      }
      return { meta: { changes } };
    }
    if (statement.sql.includes("INSERT INTO github_repository_sync_runs")) {
      const key = `${String(statement.bindings[1])}:${String(
        statement.bindings[2]
      )}:${String(statement.bindings[3])}`;
      const repositoryKey = `${String(statement.bindings[1])}:${String(
        statement.bindings[2]
      )}`;
      if (runKeys.has(key) || activeRunByRepository.has(repositoryKey)) {
        return { meta: { changes: 0 } };
      }
      runKeys.add(key);
      activeRunByRepository.set(repositoryKey, {
        runId: String(statement.bindings[0]),
        leaseExpiresAt: String(statement.bindings[6])
      });
      runClaims.push({ key, fullReconciliation: Number(statement.bindings[4]) });
      return { meta: { changes: 1 } };
    }
    if (statement.sql.includes("INSERT INTO github_tree_manifests")) {
      stagedManifest = {
        manifest_id: statement.bindings[0],
        project_id: statement.bindings[1],
        repository_id: statement.bindings[2],
        ref: statement.bindings[3],
        observed_sha: statement.bindings[4],
        tree_sha: statement.bindings[5],
        repository_authority: statement.bindings[6],
        collection_key: statement.bindings[7],
        status: "staging",
        entry_count: null,
        entries_checksum: null
      };
      return { meta: { changes: 1 } };
    }
    if (statement.sql.includes("UPDATE github_tree_manifests")) {
      stagedManifest = {
        ...stagedManifest,
        status: "complete",
        entry_count: statement.bindings[0],
        entries_checksum: statement.bindings[1]
      };
      return { meta: { changes: 1 } };
    }
    if (statement.sql.includes("INSERT INTO github_tree_ref_heads")) {
      activeManifestId = String(statement.bindings[3]);
      activeObservedSha = String(stagedManifest?.observed_sha ?? activeObservedSha);
      return { meta: { changes: 1 } };
    }
    if (
      statement.sql.includes("UPDATE github_repository_sync_runs") &&
      statement.sql.includes("SET status = ?")
    ) {
      finishedRuns.push({
        status: String(statement.bindings[0]),
        errorCode:
          statement.bindings[2] === null ? null : String(statement.bindings[2])
      });
      if (options.leaveRunOpen !== true) {
        for (const [repositoryKey, activeRun] of activeRunByRepository) {
          if (activeRun.runId === statement.bindings[3]) {
            activeRunByRepository.delete(repositoryKey);
          }
        }
      }
      return { meta: { changes: options.leaveRunOpen === true ? 0 : 1 } };
    }
    if (statement.sql.includes("INSERT INTO sync_cursors")) {
      if (statement.sql.includes("'failed'")) {
        lastSyncError = String(statement.bindings[5]);
        lastSyncCredentialStatus = String(statement.bindings[6]);
      } else {
        lastSyncError = null;
        lastHistoryGapPossible = Number(statement.bindings[6]);
        lastSyncCredentialStatus = String(statement.bindings[7]);
      }
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  };
  const prepare = (sql: string) => {
    const statement = createStatement(sql, applyStatement);
    statement.first = vi.fn().mockImplementation(async () => {
      if (sql.includes("FROM github_tree_manifest_retention_cursors")) {
        const lane = String(statement.bindings[0]);
        const cursor = retentionCursors.get(lane);
        return cursor === undefined
          ? null
          : {
              lane,
              after_project_id: cursor.afterProjectId,
              after_manifest_id: cursor.afterManifestId,
              cursor_version: cursor.version
            };
      }
      if (sql.includes("FROM github_access_baselines")) {
        return {
          credential_version: CREDENTIAL_VERSION,
          user_id: 7,
          scopes_json: '["repo"]',
          repositories_json:
            '[{"id":42,"permissions":{"pull":true,"push":false,"admin":false}}]'
        };
      }
      if (
        sql.includes("SELECT head.manifest_id, manifest.observed_sha")
      ) {
        return { manifest_id: activeManifestId, observed_sha: activeObservedSha };
      }
      if (sql.includes("FROM github_tree_manifests") && sql.includes("collection_key")) {
        return stagedManifest;
      }
      if (sql.includes("SELECT manifest.repository_authority")) {
        return stagedManifest === null
          ? null
          : {
              repository_authority: stagedManifest.repository_authority,
              observed_sha: stagedManifest.observed_sha,
              external_id: 42
            };
      }
      if (sql.includes("SELECT head.manifest_id, cursor.observed_sha")) {
        return { manifest_id: activeManifestId, observed_sha: activeObservedSha };
      }
      if (sql.includes("FROM sync_cursors")) {
        return { observed_sha: REPOSITORY_SHA, etag: '"ref-etag"' };
      }
      return null;
    });
    statement.all = vi.fn().mockImplementation(async () => ({
      results: sql.includes("FROM repositories") ? [repository] : []
    }));
    return statement;
  };
  const database = {
    withSession: vi.fn().mockReturnValue({ prepare }),
    prepare: vi.fn().mockImplementation(prepare),
    batch: vi.fn().mockImplementation(async (statements: CapturedStatement[]) =>
      statements.map(applyStatement)
    )
  } as unknown as D1Database;
  return {
    database,
    runClaims,
    finishedRuns,
    get lastCredentialStatus() {
      return lastCredentialStatus;
    },
    get lastSyncError() {
      return lastSyncError;
    },
    get lastSyncCredentialStatus() {
      return lastSyncCredentialStatus;
    },
    get lastHistoryGapPossible() {
      return lastHistoryGapPossible;
    }
  };
}

function createStatement(
  sql: string,
  applyStatement: (statement: CapturedStatement) => { meta: { changes: number } }
) {
  const statement = {
    sql,
    bindings: [] as unknown[],
    bind(...bindings: unknown[]) {
      this.bindings = bindings;
      return this;
    },
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
    run: vi.fn().mockImplementation(async () => applyStatement(statement))
  };
  return statement;
}

function createScheduledFetcher(options: {
  expirationHeader: string;
  notModified: boolean;
  observedSha?: string;
  comparisonUnavailable?: boolean;
  refStatus?: number;
}) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    if (url.pathname === "/user") {
      return new Response(JSON.stringify({ id: 7, login: "octocat" }), {
        headers: {
          "x-oauth-scopes": "repo",
          "github-authentication-token-expiration": options.expirationHeader
        }
      });
    }
    if (url.pathname === "/user/repos") {
      return Response.json([
        {
          id: 42,
          full_name: "memenow/repository-42",
          owner: { id: 7 },
          permissions: { pull: true, push: false, admin: false }
        }
      ]);
    }
    if (url.pathname === "/repos/memenow/repository-42") {
      return Response.json({ id: 42, owner: { id: 7 }, default_branch: "main" });
    }
    if (url.pathname.endsWith("/git/ref/heads/main")) {
      if (options.refStatus !== undefined) {
        return Response.json({ message: "synthetic failure" }, { status: options.refStatus });
      }
      if (options.notModified) {
        return new Response(null, { status: 304, headers: { etag: '"ref-etag"' } });
      }
      return Response.json({
        ref: "refs/heads/main",
        object: { sha: options.observedSha ?? REPOSITORY_SHA, type: "commit" }
      });
    }
    if (url.pathname.includes("/compare/")) {
      if (options.comparisonUnavailable === true) {
        return Response.json({ message: "synthetic gap" }, { status: 404 });
      }
      return Response.json({
        status: "diverged",
        ahead_by: 1,
        behind_by: 1,
        total_commits: 1,
        merge_base_commit: { sha: "e".repeat(40) }
      });
    }
    const observedSha = options.observedSha ?? REPOSITORY_SHA;
    if (url.pathname.endsWith(`/commits/${observedSha}`)) {
      return Response.json({ sha: observedSha, tree: { sha: TREE_SHA } });
    }
    if (url.pathname.endsWith(`/git/trees/${TREE_SHA}`)) {
      return Response.json({ sha: TREE_SHA, truncated: false, tree: [] });
    }
    throw new Error(`unexpected GitHub request: ${url.pathname}`);
  });
}

async function runScheduled(
  database: D1Database,
  fetcher: typeof fetch,
  scheduledTime: number
): Promise<void> {
  vi.stubGlobal("fetch", fetcher);
  try {
    await githubSyncWorker.scheduled(
      { scheduledTime } as ScheduledController,
      {
        MEMORY_DB: database,
        GITHUB_SYNC_ENABLED: "true",
        GITHUB_CLASSIC_TOKEN: "synthetic-token",
        GITHUB_CREDENTIAL_VERSION: CREDENTIAL_VERSION
      },
      {} as ExecutionContext
    );
  } finally {
    vi.unstubAllGlobals();
  }
}

function requestForPath(fetcher: ReturnType<typeof vi.fn>, suffix: string): Request {
  const request = fetcher.mock.calls
    .map(([input]) => input as Request)
    .find((candidate) => new URL(candidate.url).pathname.endsWith(suffix));
  if (request === undefined) {
    throw new Error(`request not found: ${suffix}`);
  }
  return request;
}

function requestCount(fetcher: ReturnType<typeof vi.fn>, pathPart: string): number {
  return fetcher.mock.calls.filter(([input]) =>
    new URL((input as Request).url).pathname.includes(pathPart)
  ).length;
}

function requestExactCount(fetcher: ReturnType<typeof vi.fn>, path: string): number {
  return fetcher.mock.calls.filter(
    ([input]) => new URL((input as Request).url).pathname === path
  ).length;
}
