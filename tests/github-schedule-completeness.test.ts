import { describe, expect, it, vi } from "vitest";
import { createGitHubRequestPacer } from "../src/github/client";
import {
  classifyCredentialExpiration,
  isDailyFullReconciliation,
  recordCredentialExpirationObservation,
  runScheduledGitHubSync
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
  interface SyncCursorState {
    observedSha: string | null;
    etag: string | null;
    status: string;
    updatedAt: string;
    version: number;
    lastSyncAt: string | null;
  }

  interface SyncRunState {
    runId: string;
    projectId: string;
    repositoryId: string;
    scheduledFor: string;
    fullReconciliation: number;
    leaseExpiresAt: string;
    claimedRef: string;
    claimedHeadManifestId: string | null;
    claimedHeadVersion: number;
    repositoryConfigurationVersion: number;
    cursorVersion: number;
    status: "running" | "complete" | "failed";
    completedAt: string | null;
    errorCode: string | null;
  }

  interface ActivationWitnessState {
    activationToken: string;
    receiptId: string;
    runId: string;
    projectId: string;
    repositoryId: string;
    ref: string;
    manifestId: string;
    activationRequestDigest: string;
  }

  interface ActivationReceiptState {
    receiptId: string;
    activationToken: string;
    projectId: string;
    repositoryId: string;
    ref: string;
    manifestId: string;
    runId: string;
    expectedHeadManifestId: string | null;
    expectedHeadVersion: number;
    activatedHeadVersion: number;
    expectedCursorObservedSha: string | null;
    expectedCursorStatus: string;
    expectedCursorUpdatedAt: string;
    expectedCursorVersion: number;
    expectedRepositoryConfigurationVersion: number;
    expectedRepositoryUpdatedAt: string;
    observedSha: string;
    syncEventId: string;
    syncEventPayloadDigest: string;
    activationRequestDigest: string;
    scheduledFor: string;
    fullReconciliation: number;
  }

  const retentionCursors = new Map([
    ["staging", { afterProjectId: "", afterManifestId: "", version: 0 }],
    ["failed", { afterProjectId: "", afterManifestId: "", version: 0 }]
  ]);
  const runKeys = new Set<string>();
  const runClaims: Array<{ key: string; fullReconciliation: number }> = [];
  const runsById = new Map<string, SyncRunState>();
  const activeRunByRepository = new Map<string, string>();
  const activationWitnesses = new Map<string, ActivationWitnessState>();
  const activationReceipts = new Map<string, ActivationReceiptState>();
  const finishedRuns: Array<{ status: string; errorCode: string | null }> = [];
  let lastCredentialStatus: string | null = null;
  let lastSyncError: string | null = null;
  let lastSyncCredentialStatus: string | null = null;
  let lastHistoryGapPossible: number | null = null;
  let activeManifestId = "a".repeat(64);
  let activeObservedSha = REPOSITORY_SHA;
  let activeHeadVersion = 1;
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
    tracked_refs_json: "[]",
    repository_configuration_version: 1,
    repository_updated_at: "1970-01-01T00:00:00.000Z"
  };
  const cursor: SyncCursorState = {
    observedSha: REPOSITORY_SHA,
    etag: '"ref-etag"',
    status: "complete",
    updatedAt: "1970-01-01T00:00:00.000Z",
    version: 1,
    lastSyncAt: null
  };
  const repositoryKey = `${repository.project_id}:${repository.repository_id}`;

  const finishRun = (
    runId: string,
    status: "complete" | "failed",
    errorCode: string | null,
    completedAt: string
  ): number => {
    const run = runsById.get(runId);
    if (run === undefined || run.status !== "running") {
      return 0;
    }
    run.status = status;
    run.completedAt = completedAt;
    run.errorCode = errorCode;
    if (activeRunByRepository.get(repositoryKey) === runId) {
      activeRunByRepository.delete(repositoryKey);
    }
    finishedRuns.push({ status, errorCode });
    return 1;
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
      const cutoff = String(statement.bindings[4]);
      let changes = 0;
      for (const [activeRepositoryKey, runId] of activeRunByRepository) {
        const activeRun = runsById.get(runId);
        if (
          activeRun !== undefined &&
          activeRun.status === "running" &&
          activeRun.leaseExpiresAt <= cutoff
        ) {
          activeRun.status = "failed";
          activeRunByRepository.delete(activeRepositoryKey);
          changes += 1;
        }
      }
      return { meta: { changes } };
    }
    if (statement.sql.includes("INSERT INTO github_repository_sync_runs")) {
      const runId = String(statement.bindings[0]);
      const claimProjectId = String(statement.bindings[6]);
      const claimRepositoryId = String(statement.bindings[7]);
      const claimRepositoryKey = `${claimProjectId}:${claimRepositoryId}`;
      const key = `${claimRepositoryKey}:${String(statement.bindings[1])}`;
      const activeRunId = activeRunByRepository.get(claimRepositoryKey);
      const activeRun = activeRunId === undefined
        ? undefined
        : runsById.get(activeRunId);
      const claimMatchesSelection =
        claimProjectId === repository.project_id &&
        claimRepositoryId === repository.repository_id &&
        statement.bindings[8] === repository.external_id &&
        statement.bindings[9] === repository.expected_owner_external_id &&
        statement.bindings[10] === repository.owner &&
        statement.bindings[11] === repository.name &&
        statement.bindings[12] === repository.default_branch &&
        statement.bindings[13] === repository.tracked_refs_json &&
        statement.bindings[14] === repository.repository_configuration_version &&
        statement.bindings[15] === repository.repository_updated_at &&
        statement.bindings[16] === cursor.status &&
        statement.bindings[17] === cursor.updatedAt &&
        statement.bindings[18] === cursor.version &&
        statement.bindings[19] === activeManifestId &&
        statement.bindings[20] === activeHeadVersion;
      if (
        !claimMatchesSelection ||
        runKeys.has(key) ||
        (activeRun !== undefined &&
          activeRun.status === "running" &&
          activeRun.leaseExpiresAt > String(statement.bindings[21]))
      ) {
        return { meta: { changes: 0 } };
      }
      runKeys.add(key);
      const run: SyncRunState = {
        runId,
        projectId: claimProjectId,
        repositoryId: claimRepositoryId,
        scheduledFor: String(statement.bindings[1]),
        fullReconciliation: Number(statement.bindings[2]),
        leaseExpiresAt: String(statement.bindings[4]),
        claimedRef: String(statement.bindings[5]),
        claimedHeadManifestId:
          statement.bindings[19] === null
            ? null
            : String(statement.bindings[19]),
        claimedHeadVersion: Number(statement.bindings[20]),
        repositoryConfigurationVersion: Number(statement.bindings[14]),
        cursorVersion: Number(statement.bindings[18]),
        status: "running",
        completedAt: null,
        errorCode: null
      };
      runsById.set(runId, run);
      activeRunByRepository.set(claimRepositoryKey, runId);
      runClaims.push({
        key,
        fullReconciliation: run.fullReconciliation
      });
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
    if (statement.sql.includes("INSERT INTO github_tree_activation_witnesses")) {
      const witness: ActivationWitnessState = {
        activationToken: String(statement.bindings[0]),
        receiptId: String(statement.bindings[1]),
        runId: String(statement.bindings[2]),
        projectId: String(statement.bindings[3]),
        repositoryId: String(statement.bindings[4]),
        ref: String(statement.bindings[5]),
        manifestId: String(statement.bindings[6]),
        activationRequestDigest: String(statement.bindings[7])
      };
      const run = runsById.get(witness.runId);
      if (
        run === undefined ||
        run.status !== "running" ||
        run.projectId !== witness.projectId ||
        run.repositoryId !== witness.repositoryId ||
        run.claimedRef !== witness.ref
      ) {
        return { meta: { changes: 0 } };
      }
      activationWitnesses.set(witness.activationToken, witness);
      return { meta: { changes: 1 } };
    }
    if (statement.sql.includes("INSERT INTO github_tree_ref_heads")) {
      const witness = [...activationWitnesses.values()].find(
        (candidate) =>
          candidate.projectId === statement.bindings[0] &&
          candidate.repositoryId === statement.bindings[1] &&
          candidate.ref === statement.bindings[2] &&
          candidate.manifestId === statement.bindings[3]
      );
      const run = witness === undefined ? undefined : runsById.get(witness.runId);
      if (
        run === undefined ||
        run.status !== "running" ||
        run.claimedHeadManifestId !== activeManifestId ||
        run.claimedHeadVersion !== activeHeadVersion
      ) {
        return { meta: { changes: 0 } };
      }
      activeManifestId = String(statement.bindings[3]);
      activeObservedSha = String(stagedManifest?.observed_sha ?? activeObservedSha);
      activeHeadVersion += 1;
      return { meta: { changes: 1 } };
    }
    if (
      statement.sql.includes("UPDATE sync_cursors") &&
      statement.sql.includes("SET observed_sha = ?")
    ) {
      cursor.observedSha = String(statement.bindings[0]);
      cursor.lastSyncAt = String(statement.bindings[1]);
      cursor.status = "observed";
      cursor.etag = statement.bindings[5] === null
        ? null
        : String(statement.bindings[5]);
      cursor.updatedAt = String(statement.bindings[6]);
      cursor.version = Number(statement.bindings[13]) + 1;
      lastSyncError = null;
      lastHistoryGapPossible = Number(statement.bindings[3]);
      lastSyncCredentialStatus = String(statement.bindings[4]);
      return { meta: { changes: 1 } };
    }
    if (
      statement.sql.includes("UPDATE github_repository_sync_runs") &&
      statement.sql.includes("SET status = 'complete'")
    ) {
      const runId = String(statement.bindings[1]);
      const witness = activationWitnesses.get(String(statement.bindings[18]));
      const run = runsById.get(runId);
      if (
        witness === undefined ||
        witness.receiptId !== statement.bindings[19] ||
        witness.runId !== runId ||
        run === undefined ||
        run.status !== "running" ||
        activeManifestId !== statement.bindings[16] ||
        activeHeadVersion !== statement.bindings[17] ||
        cursor.observedSha !== statement.bindings[13] ||
        cursor.updatedAt !== statement.bindings[14] ||
        cursor.version !== statement.bindings[15]
      ) {
        return { meta: { changes: 0 } };
      }
      return {
        meta: {
          changes: finishRun(
            runId,
            "complete",
            null,
            String(statement.bindings[0])
          )
        }
      };
    }
    if (statement.sql.includes("INSERT INTO github_tree_activation_receipts")) {
      const receipt: ActivationReceiptState = {
        receiptId: String(statement.bindings[0]),
        activationToken: String(statement.bindings[1]),
        projectId: String(statement.bindings[2]),
        repositoryId: String(statement.bindings[3]),
        ref: String(statement.bindings[4]),
        manifestId: String(statement.bindings[5]),
        runId: String(statement.bindings[6]),
        expectedHeadManifestId:
          statement.bindings[7] === null ? null : String(statement.bindings[7]),
        expectedHeadVersion: Number(statement.bindings[8]),
        activatedHeadVersion: Number(statement.bindings[9]),
        expectedCursorObservedSha:
          statement.bindings[10] === null
            ? null
            : String(statement.bindings[10]),
        expectedCursorStatus: String(statement.bindings[11]),
        expectedCursorUpdatedAt: String(statement.bindings[12]),
        expectedCursorVersion: Number(statement.bindings[13]),
        expectedRepositoryConfigurationVersion: Number(statement.bindings[15]),
        expectedRepositoryUpdatedAt: String(statement.bindings[16]),
        observedSha: String(statement.bindings[17]),
        syncEventId: String(statement.bindings[18]),
        syncEventPayloadDigest: String(statement.bindings[19]),
        activationRequestDigest: String(statement.bindings[20]),
        scheduledFor: String(statement.bindings[21]),
        fullReconciliation: Number(statement.bindings[22])
      };
      const witness = activationWitnesses.get(receipt.activationToken);
      const run = runsById.get(receipt.runId);
      if (
        witness === undefined ||
        witness.receiptId !== receipt.receiptId ||
        witness.activationRequestDigest !== receipt.activationRequestDigest ||
        run?.status !== "complete" ||
        activeManifestId !== receipt.manifestId ||
        activeHeadVersion !== receipt.activatedHeadVersion ||
        cursor.observedSha !== receipt.observedSha ||
        cursor.version !== Number(statement.bindings[14])
      ) {
        throw new Error("GitHub tree activation receipt final state is invalid");
      }
      activationReceipts.set(receipt.receiptId, receipt);
      return { meta: { changes: 1 } };
    }
    if (
      statement.sql.includes("UPDATE github_repository_sync_runs") &&
      statement.sql.includes("SET status = ?")
    ) {
      if (options.leaveRunOpen === true) {
        return { meta: { changes: 0 } };
      }
      const status = String(statement.bindings[0]) as "complete" | "failed";
      return {
        meta: {
          changes: finishRun(
            String(statement.bindings[3]),
            status,
            statement.bindings[2] === null ? null : String(statement.bindings[2]),
            String(statement.bindings[1])
          )
        }
      };
    }
    if (
      statement.sql.includes("WITH configured AS") &&
      statement.sql.includes("INSERT INTO sync_cursors")
    ) {
      return { meta: { changes: 1 } };
    }
    if (
      statement.sql.includes("UPDATE sync_cursors") &&
      statement.sql.includes("SET status = 'complete'")
    ) {
      cursor.status = "complete";
      cursor.lastSyncAt = String(statement.bindings[0]);
      cursor.etag = statement.bindings[2] === null
        ? null
        : String(statement.bindings[2]);
      cursor.updatedAt = String(statement.bindings[4]);
      cursor.version += 1;
      lastSyncError = null;
      lastSyncCredentialStatus = String(statement.bindings[3]);
      return { meta: { changes: 1 } };
    }
    if (statement.sql.includes("INSERT INTO sync_cursors")) {
      if (statement.sql.includes("'failed'")) {
        lastSyncError = String(statement.bindings[5]);
        lastSyncCredentialStatus = String(statement.bindings[6]);
        cursor.status = "failed";
        cursor.updatedAt = String(statement.bindings[7]);
        cursor.version += 1;
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
      if (sql.includes("SELECT completed_at FROM github_repository_sync_runs")) {
        const run = runsById.get(String(statement.bindings[0]));
        return run !== undefined &&
          run.status === statement.bindings[1] &&
          run.errorCode === statement.bindings[2]
          ? { completed_at: run.completedAt }
          : null;
      }
      if (
        sql.includes(
          "SELECT head.manifest_id, head.head_version, manifest.observed_sha"
        )
      ) {
        return {
          manifest_id: activeManifestId,
          head_version: activeHeadVersion,
          observed_sha: activeObservedSha
        };
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
      if (sql.includes("FROM github_tree_activation_receipts")) {
        const receipt = activationReceipts.get(String(statement.bindings[0]));
        if (
          receipt === undefined ||
          receipt.activationToken !== statement.bindings[1] ||
          receipt.projectId !== statement.bindings[2] ||
          receipt.repositoryId !== statement.bindings[3] ||
          receipt.ref !== statement.bindings[4] ||
          receipt.manifestId !== statement.bindings[5] ||
          receipt.runId !== statement.bindings[6] ||
          receipt.expectedHeadManifestId !== statement.bindings[7] ||
          receipt.expectedHeadVersion !== statement.bindings[8] ||
          receipt.activatedHeadVersion !== statement.bindings[9] ||
          receipt.expectedCursorObservedSha !== statement.bindings[10] ||
          receipt.expectedCursorStatus !== statement.bindings[11] ||
          receipt.expectedCursorUpdatedAt !== statement.bindings[12] ||
          receipt.expectedCursorVersion !== statement.bindings[13] ||
          receipt.expectedRepositoryConfigurationVersion !== statement.bindings[14] ||
          receipt.expectedRepositoryUpdatedAt !== statement.bindings[15] ||
          receipt.observedSha !== statement.bindings[16] ||
          receipt.syncEventId !== statement.bindings[17] ||
          receipt.syncEventPayloadDigest !== statement.bindings[18] ||
          receipt.activationRequestDigest !== statement.bindings[19] ||
          receipt.scheduledFor !== statement.bindings[20] ||
          receipt.fullReconciliation !== statement.bindings[21]
        ) {
          return null;
        }
        return { receipt_id: receipt.receiptId };
      }
      if (sql.includes("SELECT observed_sha, etag FROM sync_cursors")) {
        return { observed_sha: cursor.observedSha, etag: cursor.etag };
      }
      return null;
    });
    statement.all = vi.fn().mockImplementation(async () => {
      if (sql.includes("FROM repositories")) {
        return { results: [repository] };
      }
      if (sql.includes("ROW_NUMBER() OVER")) {
        const configured = JSON.parse(
          String(statement.bindings[0])
        ) as Array<{ repository_id: string; ref: string }>;
        const selected = configured.find(
          (candidate) => candidate.repository_id === repository.repository_id
        );
        return {
          results:
            selected === undefined
              ? []
              : [
                  {
                    ...repository,
                    ref: selected.ref,
                    cursor_status: cursor.status,
                    cursor_updated_at: cursor.updatedAt,
                    cursor_version: cursor.version,
                    selected_head_manifest_id: activeManifestId,
                    selected_head_version: activeHeadVersion,
                    last_sync_at: cursor.lastSyncAt ?? String(statement.bindings[1])
                  }
                ]
        };
      }
      return { results: [] };
    });
    return statement;
  };
  const database = {
    withSession: vi.fn().mockReturnValue({ prepare }),
    prepare: vi.fn().mockImplementation(prepare),
    batch: vi.fn().mockImplementation(async (statements: CapturedStatement[]) => {
      if (
        options.leaveRunOpen === true &&
        statements.some((statement) =>
          statement.sql.includes("INSERT INTO github_tree_activation_witnesses")
        )
      ) {
        return statements.map(() => ({ meta: { changes: 0 } }));
      }
      return statements.map(applyStatement);
    })
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
    await runScheduledGitHubSync(
      { scheduledTime } as ScheduledController,
      {
        MEMORY_DB: database,
        GITHUB_SYNC_ENABLED: "true",
        GITHUB_CLASSIC_TOKEN: "synthetic-token",
        GITHUB_CREDENTIAL_VERSION: CREDENTIAL_VERSION
      },
      { beforeRequest: createGitHubRequestPacer({ minimumIntervalMs: 0 }) }
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
