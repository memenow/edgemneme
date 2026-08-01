import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { WorkflowStep } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_WORKFLOW_ID_PATTERN,
  canonicalGitHubSyncSlot,
  deterministicLaneWaitMs,
  githubDispatchIdentity,
  githubRefWorkflowIdentity,
  githubRetentionIdentity
} from "../src/github/sync-scheduling";
import {
  completeGitHubDispatchMaterialization,
  credentialLaneClaimId,
  hasGitHubDispatchMaterializationReceipt,
  releaseGitHubCredentialLane,
  reserveGitHubDispatchRequest,
  tryAcquireGitHubCredentialLane
} from "../src/github/sync-workflow";
import {
  claimRepositorySync,
  ensureStableWorkflowInstance,
  scheduleGitHubSyncWorkflows
} from "../workers/github-sync/index";
import {
  MAX_DISPATCH_RECONCILIATION_SUBREQUESTS_PER_ROW,
  MAX_LIST_RECONCILIATION_SUBREQUESTS,
  MAX_ORPHAN_RECONCILIATION_SUBREQUESTS_PER_ROW,
  MAX_PENDING_RECONCILIATION_SUBREQUESTS_PER_ROW,
  MAX_PRIOR_RECONCILIATION_PAGES,
  MAX_PRIOR_RECONCILIATION_SUBREQUESTS,
  MAX_RUNNING_RECONCILIATION_QUERIES_PER_INVOCATION_ROW,
  MAX_RUNNING_RECONCILIATION_ROWS,
  MAX_RUNNING_RECONCILIATION_SUBREQUESTS_PER_ROW,
  createPriorReconciliationBudget,
  ensureGitHubRefWorkflowBatch,
  reconcilePriorDispatchState,
  runGitHubDispatchWorkflow
} from "../workers/github-sync/workflow-core";
import { finishRejectedUnboundRepositoryRun } from "../workers/github-sync/workflow-orphan";

describe("GitHub Workflow scheduling", () => {
  it("keeps prior-state reconciliation below the configured Workflow step limit", () => {
    expect(MAX_PRIOR_RECONCILIATION_PAGES * 2).toBeLessThan(10_000);
    expect(MAX_LIST_RECONCILIATION_SUBREQUESTS).toBe(3);
    expect(
      MAX_PRIOR_RECONCILIATION_PAGES * MAX_LIST_RECONCILIATION_SUBREQUESTS
    ).toBeLessThan(MAX_PRIOR_RECONCILIATION_SUBREQUESTS);
    expect(MAX_PENDING_RECONCILIATION_SUBREQUESTS_PER_ROW).toBe(9);
    expect(MAX_ORPHAN_RECONCILIATION_SUBREQUESTS_PER_ROW).toBe(6);
    expect(MAX_RUNNING_RECONCILIATION_SUBREQUESTS_PER_ROW).toBe(54);
    expect(MAX_DISPATCH_RECONCILIATION_SUBREQUESTS_PER_ROW).toBe(6);
    expect(
      MAX_RUNNING_RECONCILIATION_ROWS *
        MAX_RUNNING_RECONCILIATION_QUERIES_PER_INVOCATION_ROW
    ).toBeLessThan(1_000);
    expect(100 * MAX_RUNNING_RECONCILIATION_SUBREQUESTS_PER_ROW).toBeLessThan(
      MAX_PRIOR_RECONCILIATION_SUBREQUESTS
    );
    expect(10_000 - MAX_PRIOR_RECONCILIATION_SUBREQUESTS).toBeGreaterThanOrEqual(
      2_800
    );
  });

  it("rejects a list retry reservation before crossing the subrequest cap", () => {
    const exact = createPriorReconciliationBudget();
    exact.reserveSubrequests(
      MAX_PRIOR_RECONCILIATION_SUBREQUESTS - MAX_LIST_RECONCILIATION_SUBREQUESTS
    );
    exact.reservePage();
    expect(exact.subrequestCount).toBe(MAX_PRIOR_RECONCILIATION_SUBREQUESTS);

    const overflow = createPriorReconciliationBudget();
    overflow.reserveSubrequests(
      MAX_PRIOR_RECONCILIATION_SUBREQUESTS -
        MAX_LIST_RECONCILIATION_SUBREQUESTS +
        1
    );
    expect(() => overflow.reservePage()).toThrow("GITHUB_RECONCILIATION_REQUIRED");
  });

  it("canonicalizes six-hour slots and builds bounded stable IDs", async () => {
    const scheduled = Date.parse("2026-07-29T11:59:59.999Z");
    expect(canonicalGitHubSyncSlot(scheduled)).toBe(
      Date.parse("2026-07-29T06:00:00.000Z")
    );
    const dispatch = await githubDispatchIdentity("credential-current", scheduled);
    const retention = await githubRetentionIdentity(scheduled);
    const nextRetention = await githubRetentionIdentity(
      Date.parse("2026-07-29T12:00:00.000Z")
    );
    const main = await githubRefWorkflowIdentity({
      dispatchId: dispatch.dispatchId,
      projectId: "project-1",
      repositoryId: "repository-1",
      ref: "refs/heads/main",
      scheduledFor: dispatch.scheduledFor,
      fullReconciliation: false
    });
    const release = await githubRefWorkflowIdentity({
      dispatchId: dispatch.dispatchId,
      projectId: "project-1",
      repositoryId: "repository-1",
      ref: "refs/heads/release",
      scheduledFor: dispatch.scheduledFor,
      fullReconciliation: false
    });

    for (const id of [
      dispatch.instanceId,
      retention.instanceId,
      main.instanceId,
      release.instanceId
    ]) {
      expect(id).toMatch(GITHUB_WORKFLOW_ID_PATTERN);
      expect(id.length).toBeLessThanOrEqual(100);
    }
    expect(main.instanceId).not.toBe(release.instanceId);
    expect(dispatch.scheduledFor).toBe("2026-07-29T06:00:00.000Z");
    expect(retention.utcDate).toBe("2026-07-29");
    expect(nextRetention.instanceId).not.toBe(retention.instanceId);
    expect(deterministicLaneWaitMs(main.instanceId, 0)).toBe(
      deterministicLaneWaitMs(main.instanceId, 0)
    );
  });

  it("recovers a stable create whose response was lost", async () => {
    const instance = {
      restart: vi.fn(),
      status: vi.fn().mockResolvedValue({ status: "running" })
    };
    const workflow = {
      create: vi.fn().mockRejectedValue(new Error("response lost")),
      get: vi.fn().mockResolvedValue(instance)
    } as unknown as Workflow<{ scheduledFor: string }>;

    await expect(
      ensureStableWorkflowInstance(workflow, `ghc-${"a".repeat(64)}`, {
        scheduledFor: "2026-07-29T06:00:00.000Z"
      })
    ).resolves.toBeUndefined();
    expect(instance.restart).not.toHaveBeenCalled();
  });

  it("does not let retention scheduling failure block dispatch", async () => {
    const dispatchCreate = vi.fn().mockResolvedValue({});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        scheduleGitHubSyncWorkflows(
          { scheduledTime: Date.parse("2026-07-29T06:00:00.000Z") },
          {
            MEMORY_DB: {} as D1Database,
            GITHUB_SYNC_ENABLED: "true",
            GITHUB_CLASSIC_TOKEN: "synthetic-token",
            GITHUB_CREDENTIAL_VERSION: "credential-current",
            GITHUB_DISPATCH_WORKFLOW: {
              create: dispatchCreate
            } as unknown as Workflow,
            GITHUB_RETENTION_WORKFLOW: {
              create: vi.fn().mockRejectedValue(new Error("retention unavailable")),
              get: vi.fn().mockRejectedValue(new Error("status unavailable"))
            } as unknown as Workflow
          }
        )
      ).resolves.toBeUndefined();
    } finally {
      warning.mockRestore();
    }
    expect(dispatchCreate).toHaveBeenCalledOnce();
  });

  it("recovers ambiguous createBatch results without coupling child failures", async () => {
    const running = {
      restart: vi.fn(),
      status: vi.fn().mockResolvedValue({ status: "running" })
    };
    const errored = {
      restart: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockResolvedValue({ status: "errored" })
    };
    const workflow = {
      createBatch: vi.fn().mockRejectedValue(new Error("batch response lost")),
      get: vi.fn().mockImplementation(async (id: string) =>
        id.endsWith("a") ? running : errored
      )
    } as unknown as Workflow<{
      dispatchId: string;
      itemId: string;
      credentialVersion: string;
      scheduledFor: string;
      absoluteDeadlineMs: number;
    }>;
    const payload = {
      dispatchId: "d".repeat(64),
      credentialVersion: "credential-current",
      scheduledFor: "2026-07-29T06:00:00.000Z",
      absoluteDeadlineMs: Date.parse("2026-07-29T11:59:00.000Z")
    };

    await expect(
      ensureGitHubRefWorkflowBatch(workflow, [
        { id: "child-a", params: { ...payload, itemId: "a".repeat(64) } },
        { id: "child-b", params: { ...payload, itemId: "b".repeat(64) } }
      ])
    ).resolves.toBeUndefined();
    expect(running.restart).not.toHaveBeenCalled();
    expect(errored.restart).toHaveBeenCalledOnce();
  });
});

describe("GitHub credential lane", () => {
  it("serializes holders, enforces pacing, supports takeover, and rejects ABA release", async () => {
    const fixture = createDatabase();
    const credentialVersion = "credential-current";
    const firstClaim = await credentialLaneClaimId({
      credentialVersion,
      holderKind: "ref",
      holderId: "item-a"
    });
    const secondClaim = await credentialLaneClaimId({
      credentialVersion,
      holderKind: "ref",
      holderId: "item-b"
    });
    const first = await tryAcquireGitHubCredentialLane(fixture.d1, {
      credentialVersion,
      holderKind: "ref",
      holderId: "item-a",
      claimId: firstClaim,
      nowMs: 1_000,
      leaseMs: 1_000
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("first lane claim failed");

    await expect(
      tryAcquireGitHubCredentialLane(fixture.d1, {
        credentialVersion,
        holderKind: "ref",
        holderId: "item-b",
        claimId: secondClaim,
        nowMs: 1_001,
        leaseMs: 1_000
      })
    ).resolves.toMatchObject({ acquired: false });
    await expect(
      tryAcquireGitHubCredentialLane(fixture.d1, {
        credentialVersion,
        holderKind: "ref",
        holderId: "item-a",
        claimId: firstClaim,
        nowMs: 1_002,
        leaseMs: 1_000
      })
    ).resolves.toMatchObject({ acquired: true, token: { epoch: 1 } });

    await releaseGitHubCredentialLane(fixture.d1, first.token, 1_100);
    await expect(
      tryAcquireGitHubCredentialLane(fixture.d1, {
        credentialVersion,
        holderKind: "ref",
        holderId: "item-b",
        claimId: secondClaim,
        nowMs: 1_179,
        leaseMs: 1_000
      })
    ).resolves.toMatchObject({ acquired: false });
    const second = await tryAcquireGitHubCredentialLane(fixture.d1, {
      credentialVersion,
      holderKind: "ref",
      holderId: "item-b",
      claimId: secondClaim,
      nowMs: 1_180,
      leaseMs: 1_000
    });
    expect(second).toMatchObject({ acquired: true, token: { epoch: 2 } });
    await expect(
      releaseGitHubCredentialLane(fixture.d1, first.token, 1_200)
    ).resolves.toBeUndefined();
    expect(
      fixture.database.prepare(
        `SELECT holder_id, lease_epoch FROM github_credential_sync_lane
         WHERE credential_version = ?`
      ).get(credentialVersion)
    ).toEqual({ holder_id: "item-b", lease_epoch: 2 });

    const takeoverClaim = await credentialLaneClaimId({
      credentialVersion,
      holderKind: "ref",
      holderId: "item-c"
    });
    await expect(
      tryAcquireGitHubCredentialLane(fixture.d1, {
        credentialVersion,
        holderKind: "ref",
        holderId: "item-c",
        claimId: takeoverClaim,
        nowMs: 2_181,
        leaseMs: 1_000
      })
    ).resolves.toMatchObject({ acquired: true, token: { epoch: 3 } });
  });

  it("recovers an exact lane claim after commit response loss", async () => {
    const fixture = createDatabase({
      remaining: 1,
      matches: (sql) =>
        sql.includes("UPDATE github_credential_sync_lane") &&
        sql.includes("lease_epoch = lease_epoch + 1")
    });
    const claimId = await credentialLaneClaimId({
      credentialVersion: "credential-current",
      holderKind: "dispatch",
      holderId: "dispatch-a"
    });

    await expect(
      tryAcquireGitHubCredentialLane(fixture.d1, {
        credentialVersion: "credential-current",
        holderKind: "dispatch",
        holderId: "dispatch-a",
        claimId,
        nowMs: 1_000,
        leaseMs: 1_000
      })
    ).resolves.toMatchObject({ acquired: true, token: { epoch: 1 } });
  });

  it("recovers lane initialization after commit response loss", async () => {
    const fixture = createDatabase({
      remaining: 1,
      matches: (sql) => sql.includes("INSERT INTO github_credential_sync_lane")
    });
    const claimId = await credentialLaneClaimId({
      credentialVersion: "credential-current",
      holderKind: "dispatch",
      holderId: "dispatch-a"
    });
    await expect(
      tryAcquireGitHubCredentialLane(fixture.d1, {
        credentialVersion: "credential-current",
        holderKind: "dispatch",
        holderId: "dispatch-a",
        claimId,
        nowMs: 1_000,
        leaseMs: 1_000
      })
    ).resolves.toMatchObject({ acquired: true, token: { epoch: 1 } });
  });

  it("recovers an exact lane release after commit response loss", async () => {
    const fixture = createDatabase({
      remaining: 1,
      matches: (sql) =>
        sql.includes("UPDATE github_credential_sync_lane") &&
        sql.includes("SET holder_kind = NULL")
    });
    const claimId = await credentialLaneClaimId({
      credentialVersion: "credential-current",
      holderKind: "ref",
      holderId: "item-a"
    });
    const claim = await tryAcquireGitHubCredentialLane(fixture.d1, {
      credentialVersion: "credential-current",
      holderKind: "ref",
      holderId: "item-a",
      claimId,
      nowMs: 1_000,
      leaseMs: 1_000
    });
    if (!claim.acquired) throw new Error("lane claim failed");

    await expect(
      releaseGitHubCredentialLane(fixture.d1, claim.token, 1_100)
    ).resolves.toBeUndefined();
    expect(
      fixture.database.prepare(
        `SELECT holder_id, lease_claim_id, lease_until, available_after
         FROM github_credential_sync_lane
         WHERE credential_version = 'credential-current'`
      ).get()
    ).toEqual({
      holder_id: null,
      lease_claim_id: null,
      lease_until: null,
      available_after: "1970-01-01T00:00:01.180Z"
    });
  });

  it("rejects a forged release receipt for an already-free lane", async () => {
    const fixture = createDatabase();
    fixture.database.prepare(
      `INSERT INTO github_credential_sync_lane
       (credential_version, holder_kind, holder_id, lease_claim_id, lease_epoch,
        lease_until, available_after, updated_at)
       VALUES ('credential-forged', NULL, NULL, NULL, 1, NULL,
               '2026-07-29T06:00:00.080Z', '2026-07-29T06:00:00.000Z')`
    ).run();
    expect(() => fixture.database.prepare(
      `INSERT INTO github_credential_sync_lane_release_receipts
       (receipt_id, credential_version, holder_kind, holder_id,
        lease_claim_id, lease_epoch, lease_until, released_at, available_after)
       VALUES (?, 'credential-forged', 'ref', 'forged-item', ?, 1,
               '2026-07-29T06:10:00.000Z', '2026-07-29T06:00:00.000Z',
               '2026-07-29T06:00:00.080Z')`
    ).run("d".repeat(64), "e".repeat(64))).toThrow(
      "release receipt state is invalid"
    );
  });
});

describe("GitHub Workflow request budgets", () => {
  it("persists conservative request blocks and never exceeds the bound", async () => {
    const fixture = createDatabase();
    const dispatchId = "d".repeat(64);
    fixture.database.prepare(
      `INSERT INTO github_sync_dispatches
       (dispatch_id, credential_version, workflow_instance_id, scheduled_for,
        utc_date, status, created_at)
       VALUES (?, 'credential-current', ?, '2026-07-29T06:00:00.000Z',
               '2026-07-29', 'materialized', '2026-07-29T06:00:00.000Z')`
    ).run(dispatchId, `ghd-${dispatchId}`);
    const claimId = await credentialLaneClaimId({
      credentialVersion: "credential-current",
      holderKind: "dispatch",
      holderId: dispatchId
    });
    const claim = await tryAcquireGitHubCredentialLane(fixture.d1, {
      credentialVersion: "credential-current",
      holderKind: "dispatch",
      holderId: dispatchId,
      claimId,
      leaseMs: 60_000
    });
    if (!claim.acquired) throw new Error("lane claim failed");

    await expect(
      reserveGitHubDispatchRequest(fixture.d1, dispatchId, claim.token, 205)
    ).resolves.toBe(100);
    await expect(
      reserveGitHubDispatchRequest(fixture.d1, dispatchId, claim.token, 205)
    ).resolves.toBe(100);
    await expect(
      reserveGitHubDispatchRequest(fixture.d1, dispatchId, claim.token, 205)
    ).resolves.toBe(5);
    await expect(
      reserveGitHubDispatchRequest(fixture.d1, dispatchId, claim.token, 205)
    ).resolves.toBeNull();
    expect(
      fixture.database.prepare(
        `SELECT github_request_count FROM github_sync_dispatches
         WHERE dispatch_id = ?`
      ).get(dispatchId)
    ).toEqual({ github_request_count: 205 });
  });

  it("recovers a request block whose commit response was lost", async () => {
    const fixture = createDatabase({
      remaining: 1,
      matches: (sql) =>
        sql.includes("UPDATE github_sync_dispatches") &&
        sql.includes("github_request_count = github_request_count +")
    });
    const dispatchId = "e".repeat(64);
    fixture.database.prepare(
      `INSERT INTO github_sync_dispatches
       (dispatch_id, credential_version, workflow_instance_id, scheduled_for,
        utc_date, status, created_at)
       VALUES (?, 'credential-current', ?, '2026-07-29T06:00:00.000Z',
               '2026-07-29', 'materialized', '2026-07-29T06:00:00.000Z')`
    ).run(dispatchId, `ghd-${dispatchId}`);
    const claimId = await credentialLaneClaimId({
      credentialVersion: "credential-current",
      holderKind: "dispatch",
      holderId: dispatchId
    });
    const claim = await tryAcquireGitHubCredentialLane(fixture.d1, {
      credentialVersion: "credential-current",
      holderKind: "dispatch",
      holderId: dispatchId,
      claimId,
      leaseMs: 60_000
    });
    if (!claim.acquired) throw new Error("lane claim failed");

    await expect(
      reserveGitHubDispatchRequest(fixture.d1, dispatchId, claim.token, 900)
    ).resolves.toBe(100);
    expect(
      fixture.database.prepare(
        `SELECT github_request_count FROM github_sync_dispatches
         WHERE dispatch_id = ?`
      ).get(dispatchId)
    ).toEqual({ github_request_count: 100 });
  });

  it("rejects request blocks fenced by a newer lane holder", async () => {
    const fixture = createDatabase();
    const dispatchId = "9".repeat(64);
    fixture.database.prepare(
      `INSERT INTO github_sync_dispatches
       (dispatch_id, credential_version, workflow_instance_id, scheduled_for,
        utc_date, status, created_at)
       VALUES (?, 'credential-current', ?, '2026-07-29T06:00:00.000Z',
               '2026-07-29', 'materialized', '2026-07-29T06:00:00.000Z')`
    ).run(dispatchId, `ghd-${dispatchId}`);
    const oldClaimId = await credentialLaneClaimId({
      credentialVersion: "credential-current",
      holderKind: "dispatch",
      holderId: dispatchId
    });
    const old = await tryAcquireGitHubCredentialLane(fixture.d1, {
      credentialVersion: "credential-current",
      holderKind: "dispatch",
      holderId: dispatchId,
      claimId: oldClaimId,
      nowMs: Date.now() - 2_000,
      leaseMs: 1_000
    });
    if (!old.acquired) throw new Error("old lane claim failed");
    const newHolderId = "8".repeat(64);
    const newClaimId = await credentialLaneClaimId({
      credentialVersion: "credential-current",
      holderKind: "dispatch",
      holderId: newHolderId
    });
    await expect(
      tryAcquireGitHubCredentialLane(fixture.d1, {
        credentialVersion: "credential-current",
        holderKind: "dispatch",
        holderId: newHolderId,
        claimId: newClaimId,
        leaseMs: 60_000
      })
    ).resolves.toMatchObject({ acquired: true, token: { epoch: 2 } });

    await expect(
      reserveGitHubDispatchRequest(fixture.d1, dispatchId, old.token, 900)
    ).rejects.toThrow("holder is unavailable");
    expect(
      fixture.database.prepare(
        `SELECT github_request_count FROM github_sync_dispatches
         WHERE dispatch_id = ?`
      ).get(dispatchId)
    ).toEqual({ github_request_count: 0 });
  });
});

describe("GitHub dispatch materialization", () => {
  it("recovers the terminal materialization receipt after response loss", async () => {
    const fixture = createDatabase({
      remaining: 1,
      matches: (sql) =>
        sql.includes("UPDATE github_sync_dispatches") &&
        sql.includes("status = 'dispatching'")
    });
    const dispatchId = "f".repeat(64);
    fixture.database.prepare(
      `INSERT INTO github_sync_dispatches
       (dispatch_id, credential_version, workflow_instance_id, scheduled_for,
        utc_date, status, created_at)
       VALUES (?, 'credential-current', ?, '2026-07-29T06:00:00.000Z',
               '2026-07-29', 'materialized', '2026-07-29T06:00:00.000Z')`
    ).run(dispatchId, `ghd-${dispatchId}`);

    await expect(
      completeGitHubDispatchMaterialization(fixture.d1, {
        dispatchId,
        itemCount: 0,
        completedAt: "2026-07-29T06:00:00.000Z"
      })
    ).resolves.toBeUndefined();
    await expect(
      hasGitHubDispatchMaterializationReceipt(fixture.d1, dispatchId)
    ).resolves.toBe(true);
    await expect(
      completeGitHubDispatchMaterialization(fixture.d1, {
        dispatchId,
        itemCount: 0,
        completedAt: "2026-07-29T06:00:00.000Z"
      })
    ).resolves.toBeUndefined();
    await expect(
      completeGitHubDispatchMaterialization(fixture.d1, {
        dispatchId,
        itemCount: 0,
        completedAt: "2026-07-29T06:00:01.000Z"
      })
    ).rejects.toThrow();
  });
});

describe("GitHub Workflow recovery", () => {
  it("terminalizes prior pending work after credential rotation with an exact rejection receipt", async () => {
    const fixture = createDatabase({
      remaining: 1,
      matches: (sql) =>
        sql.includes("INSERT INTO github_sync_dispatch_item_rejection_receipts")
    });
    const repository = seedWorkflowRepository(fixture.database);
    const dispatchId = "1".repeat(64);
    const itemId = "2".repeat(64);
    const priorSlot = "2026-07-29T06:00:00.000Z";
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId,
      itemId,
      credentialVersion: "credential-old",
      scheduledFor: priorSlot,
      dispatchStatus: "materialized"
    });

    let reconciliationNow: string | undefined;
    await expect(
      reconcilePriorDispatchState(
        createImmediateWorkflowStep((name, result) => {
          if (name === "establish prior dispatch reconciliation time") {
            reconciliationNow = result as string;
          }
        }),
        fixture.d1,
        priorSlot,
        "credential-current"
      )
    ).resolves.toBeUndefined();
    await expect(
      reconcilePriorDispatchState(
        createImmediateWorkflowStep(),
        fixture.d1,
        priorSlot,
        "credential-current"
      )
    ).resolves.toBeUndefined();

    expect(fixture.database.prepare(
      `SELECT status, run_id, completed_at, last_error_code
       FROM github_sync_dispatch_items WHERE item_id = ?`
    ).get(itemId)).toEqual({
      status: "failed",
      run_id: null,
      completed_at: reconciliationNow,
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
    expect(fixture.database.prepare(
      `SELECT dispatch_id, credential_version, project_id, repository_id, ref,
              completed_at
       FROM github_sync_dispatch_item_rejection_receipts
       WHERE dispatch_item_id = ?`
    ).get(itemId)).toEqual({
      dispatch_id: dispatchId,
      credential_version: "credential-old",
      project_id: repository.projectId,
      repository_id: repository.repositoryId,
      ref: repository.ref,
      completed_at: reconciliationNow
    });
    expect(fixture.database.prepare(
      `SELECT status, completed_at, last_error_code FROM github_sync_dispatches
       WHERE dispatch_id = ?`
    ).get(dispatchId)).toEqual({
      status: "failed",
      completed_at: reconciliationNow,
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
  });

  it("settles an expired prior running item and records a finish receipt", async () => {
    const fixture = createDatabase();
    const repository = seedWorkflowRepository(fixture.database);
    const dispatchId = "3".repeat(64);
    const itemId = "4".repeat(64);
    const runId = "5".repeat(64);
    const priorSlot = "2026-07-29T06:00:00.000Z";
    seedWorkflowRun(fixture.database, {
      ...repository,
      runId,
      scheduledFor: priorSlot,
      leaseExpiresAt: "2026-07-30T06:30:00.000Z"
    });
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId,
      itemId,
      credentialVersion: "credential-current",
      scheduledFor: priorSlot,
      dispatchStatus: "dispatching",
      runId
    });

    await expect(
      reconcilePriorDispatchState(
        createImmediateWorkflowStep(),
        fixture.d1,
        "2026-07-29T12:00:00.000Z",
        "credential-current"
      )
    ).resolves.toBeUndefined();

    expect(fixture.database.prepare(
      `SELECT status, last_error_code FROM github_repository_sync_runs
       WHERE run_id = ?`
    ).get(runId)).toEqual({
      status: "failed",
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
    expect(fixture.database.prepare(
      `SELECT status, last_error_code FROM github_repository_sync_finish_receipts
       WHERE dispatch_item_id = ?`
    ).get(itemId)).toEqual({
      status: "failed",
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
  });

  it("forces an unexpired running item to settle on credential rotation", async () => {
    const fixture = createDatabase();
    const repository = seedWorkflowRepository(fixture.database);
    const dispatchId = "d".repeat(64);
    const itemId = "e".repeat(64);
    const runId = "f".repeat(64);
    const slot = "2026-07-29T06:00:00.000Z";
    const startedAt = "2026-07-29T06:15:00.000Z";
    seedWorkflowRun(fixture.database, {
      ...repository,
      runId,
      scheduledFor: slot,
      startedAt,
      leaseExpiresAt: "2030-07-29T06:30:00.000Z"
    });
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId,
      itemId,
      credentialVersion: "credential-old",
      scheduledFor: slot,
      dispatchStatus: "dispatching",
      runId
    });

    let reconciliationNow: string | undefined;
    await expect(
      reconcilePriorDispatchState(
        createImmediateWorkflowStep((name, result) => {
          if (name === "establish prior dispatch reconciliation time") {
            reconciliationNow = result as string;
          }
        }),
        fixture.d1,
        slot,
        "credential-current"
      )
    ).resolves.toBeUndefined();
    expect(reconciliationNow).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(Date.parse(reconciliationNow as string)).toBeGreaterThan(
      Date.parse(startedAt)
    );
    expect(fixture.database.prepare(
      `SELECT status, completed_at, last_error_code
       FROM github_repository_sync_runs
       WHERE run_id = ?`
    ).get(runId)).toEqual({
      status: "failed",
      completed_at: reconciliationNow,
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
    expect(fixture.database.prepare(
      `SELECT status, run_id, completed_at, last_error_code
       FROM github_sync_dispatch_items
       WHERE item_id = ?`
    ).get(itemId)).toEqual({
      status: "failed",
      run_id: runId,
      completed_at: reconciliationNow,
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
    expect(fixture.database.prepare(
      `SELECT completed_at FROM github_repository_sync_finish_receipts
       WHERE dispatch_item_id = ?`
    ).get(itemId)).toEqual({ completed_at: reconciliationNow });
    expect(fixture.database.prepare(
      `SELECT completed_at FROM github_sync_dispatches WHERE dispatch_id = ?`
    ).get(dispatchId)).toEqual({ completed_at: reconciliationNow });
  });

  it("finishes a rejected unbound run before retrying the next-slot claim", async () => {
    const fault: SqliteFault = {
      remaining: 0,
      matches: (sql) =>
        sql.includes("last_error_code = 'GITHUB_RECONCILIATION_REQUIRED'")
    };
    const fixture = createDatabase(fault);
    const repository = seedWorkflowRepository(fixture.database);
    const priorSlot = "2026-07-29T06:00:00.000Z";
    const currentSlot = "2026-07-29T12:00:00.000Z";
    const priorRunId = "1".repeat(63) + "a";
    seedWorkflowRun(fixture.database, {
      ...repository,
      runId: priorRunId,
      scheduledFor: priorSlot,
      startedAt: "2026-07-29T11:59:00.000Z",
      leaseExpiresAt: "2030-07-29T12:59:00.000Z"
    });
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId: "2".repeat(64),
      itemId: "3".repeat(64),
      credentialVersion: "credential-current",
      scheduledFor: priorSlot,
      dispatchStatus: "dispatching"
    });
    await reconcilePriorDispatchState(
      createImmediateWorkflowStep(),
      fixture.d1,
      currentSlot,
      "credential-current"
    );
    expect(fixture.database.prepare(
      `SELECT status FROM github_repository_sync_runs WHERE run_id = ?`
    ).get(priorRunId)).toEqual({ status: "running" });

    const currentItemId = "4".repeat(64);
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId: "5".repeat(64),
      itemId: currentItemId,
      credentialVersion: "credential-current",
      scheduledFor: currentSlot,
      dispatchStatus: "dispatching"
    });
    const selected = {
      repository_id: repository.repositoryId,
      project_id: repository.projectId,
      external_id: 42,
      expected_owner_external_id: 7,
      owner: "memenow",
      name: "edgemneme",
      default_branch: "main",
      tracked_refs_json: "[]",
      repository_configuration_version: 1,
      repository_updated_at: repository.repositoryUpdatedAt,
      ref: repository.ref,
      cursor_status: "idle",
      cursor_updated_at: repository.cursorUpdatedAt,
      cursor_version: 1,
      selected_head_manifest_id: null,
      selected_head_version: 0,
      last_sync_at: null
    };
    const claimStartedAt = Date.parse(currentSlot);
    await expect(
      claimRepositorySync(fixture.d1, selected, claimStartedAt, false, claimStartedAt)
    ).resolves.toBeNull();
    fault.remaining = 2;
    await expect(
      finishRejectedUnboundRepositoryRun(
        fixture.d1,
        {
          item_id: currentItemId,
          project_id: repository.projectId,
          repository_id: repository.repositoryId,
          ref: repository.ref,
          scheduled_for: currentSlot
        },
        null,
        currentSlot
      )
    ).rejects.toThrow("synthetic response loss");
    await expect(
      finishRejectedUnboundRepositoryRun(
        fixture.d1,
        {
          item_id: currentItemId,
          project_id: repository.projectId,
          repository_id: repository.repositoryId,
          ref: repository.ref,
          scheduled_for: currentSlot
        },
        null,
        currentSlot
      )
    ).resolves.toBe(true);
    expect(fixture.database.prepare(
      `SELECT status, completed_at, last_error_code
       FROM github_repository_sync_runs WHERE run_id = ?`
    ).get(priorRunId)).toEqual({
      status: "failed",
      completed_at: currentSlot,
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
    await expect(
      claimRepositorySync(fixture.d1, selected, claimStartedAt, false, claimStartedAt)
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  it("retries a claim when another recovery uses a different completion time", async () => {
    const fixture = createDatabase();
    const repository = seedWorkflowRepository(fixture.database);
    const priorSlot = "2026-07-29T06:00:00.000Z";
    const currentSlot = "2026-07-29T12:00:00.000Z";
    const priorRunId = "6".repeat(63) + "a";
    seedWorkflowRun(fixture.database, {
      ...repository,
      runId: priorRunId,
      scheduledFor: priorSlot,
      startedAt: "2026-07-29T11:59:00.000Z",
      leaseExpiresAt: "2030-07-29T12:59:00.000Z"
    });
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId: "7".repeat(64),
      itemId: "8".repeat(64),
      credentialVersion: "credential-current",
      scheduledFor: priorSlot,
      dispatchStatus: "dispatching"
    });
    await reconcilePriorDispatchState(
      createImmediateWorkflowStep(),
      fixture.d1,
      currentSlot,
      "credential-current"
    );

    const currentItemId = "9".repeat(64);
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId: "a".repeat(64),
      itemId: currentItemId,
      credentialVersion: "credential-current",
      scheduledFor: currentSlot,
      dispatchStatus: "dispatching"
    });
    const selected = {
      repository_id: repository.repositoryId,
      project_id: repository.projectId,
      external_id: 42,
      expected_owner_external_id: 7,
      owner: "memenow",
      name: "edgemneme",
      default_branch: "main",
      tracked_refs_json: "[]",
      repository_configuration_version: 1,
      repository_updated_at: repository.repositoryUpdatedAt,
      ref: repository.ref,
      cursor_status: "idle",
      cursor_updated_at: repository.cursorUpdatedAt,
      cursor_version: 1,
      selected_head_manifest_id: null,
      selected_head_version: 0,
      last_sync_at: null
    };
    const claimStartedAt = Date.parse(currentSlot);
    await expect(
      claimRepositorySync(fixture.d1, selected, claimStartedAt, false, claimStartedAt)
    ).resolves.toBeNull();

    fixture.database.prepare(
      `UPDATE github_repository_sync_runs
       SET status = 'failed', completed_at = ?,
           last_error_code = 'GITHUB_RECONCILIATION_REQUIRED'
       WHERE run_id = ? AND status = 'running'`
    ).run("2026-07-29T12:00:01.000Z", priorRunId);
    await expect(
      finishRejectedUnboundRepositoryRun(
        fixture.d1,
        {
          item_id: currentItemId,
          project_id: repository.projectId,
          repository_id: repository.repositoryId,
          ref: repository.ref,
          scheduled_for: currentSlot
        },
        null,
        "2026-07-29T12:00:02.000Z"
      )
    ).resolves.toBe(false);
    await expect(
      claimRepositorySync(fixture.d1, selected, claimStartedAt, false, claimStartedAt)
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ["disabled", "UPDATE repositories SET sync_enabled = 0 WHERE repository_id = ?"],
    ["removed ref", "UPDATE repositories SET default_branch = 'trunk' WHERE repository_id = ?"],
    ["paused", "UPDATE sync_cursors SET status = 'paused' WHERE repository_id = ?"]
  ])(
    "globally settles an expired rejected unbound run after the repository is %s",
    async (_state, mutation) => {
      const fixture = createDatabase();
      const repository = seedWorkflowRepository(fixture.database);
      const priorSlot = "2026-07-29T06:00:00.000Z";
      const currentSlot = "2026-07-29T12:00:00.000Z";
      const runId = "b".repeat(64);
      const dispatchId = "c".repeat(64);
      const itemId = "d".repeat(64);
      seedWorkflowRun(fixture.database, {
        ...repository,
        runId,
        scheduledFor: priorSlot,
        leaseExpiresAt: "2026-07-29T06:30:00.000Z"
      });
      seedWorkflowDispatchItem(fixture.database, {
        ...repository,
        dispatchId,
        itemId,
        credentialVersion: "credential-current",
        scheduledFor: priorSlot,
        dispatchStatus: "dispatching"
      });
      fixture.database.prepare(mutation).run(repository.repositoryId);

      await expect(
        reconcilePriorDispatchState(
          createImmediateWorkflowStep(),
          fixture.d1,
          currentSlot,
          "credential-current"
        )
      ).resolves.toBeUndefined();

      expect(fixture.database.prepare(
        `SELECT status, last_error_code FROM github_repository_sync_runs
         WHERE run_id = ?`
      ).get(runId)).toEqual({
        status: "failed",
        last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
      });
      expect(fixture.database.prepare(
        `SELECT status, run_id, last_error_code FROM github_sync_dispatch_items
         WHERE item_id = ?`
      ).get(itemId)).toEqual({
        status: "failed",
        run_id: null,
        last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
      });
      expect(fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM github_sync_dispatch_item_rejection_receipts
         WHERE dispatch_item_id = ?`
      ).get(itemId)).toEqual({ count: 1 });
      expect(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM github_repository_sync_runs
         WHERE status = 'running'`
      ).get()).toEqual({ count: 0 });
    }
  );

  it("settles an unexpired rejected unbound run only after credential rotation", async () => {
    const fixture = createDatabase();
    const repository = seedWorkflowRepository(fixture.database);
    const slot = "2026-07-29T12:00:00.000Z";
    const runId = "e".repeat(64);
    const itemId = "f".repeat(64);
    seedWorkflowRun(fixture.database, {
      ...repository,
      runId,
      scheduledFor: slot,
      leaseExpiresAt: "2030-07-29T12:30:00.000Z"
    });
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId: "1".repeat(62) + "ab",
      itemId,
      credentialVersion: "credential-old",
      scheduledFor: slot,
      dispatchStatus: "dispatching"
    });

    await expect(
      reconcilePriorDispatchState(
        createImmediateWorkflowStep(),
        fixture.d1,
        slot,
        "credential-current"
      )
    ).resolves.toBeUndefined();
    expect(fixture.database.prepare(
      `SELECT status, last_error_code FROM github_repository_sync_runs
       WHERE run_id = ?`
    ).get(runId)).toEqual({
      status: "failed",
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
  });

  it("limits each running settlement invocation to forty rows", async () => {
    const fixture = createDatabase();
    const repository = seedWorkflowRepository(fixture.database);
    const priorSlot = "2026-07-29T06:00:00.000Z";
    const dispatchId = "b".repeat(64);
    for (let index = 0; index < MAX_RUNNING_RECONCILIATION_ROWS + 1; index += 1) {
      const ref = `refs/heads/recovery-${index}`;
      const runId = `a${index.toString(16).padStart(63, "0")}`;
      const itemId = `c${index.toString(16).padStart(63, "0")}`;
      seedWorkflowRun(fixture.database, {
        ...repository,
        ref,
        runId,
        scheduledFor: priorSlot,
        leaseExpiresAt: "2026-07-29T06:30:00.000Z"
      });
      seedWorkflowDispatchItem(fixture.database, {
        ...repository,
        ref,
        dispatchId,
        itemId,
        credentialVersion: "credential-current",
        scheduledFor: priorSlot,
        dispatchStatus: "dispatching",
        runId
      });
    }
    let firstPageSize = 0;
    const step = createImmediateWorkflowStep((name, result) => {
      if (name === "list prior running dispatch items 1") {
        firstPageSize = (result as unknown[]).length;
        throw new Error("stop after bounded running page");
      }
    });

    await expect(
      reconcilePriorDispatchState(
        step,
        fixture.d1,
        "2026-07-29T12:00:00.000Z",
        "credential-current"
      )
    ).rejects.toThrow("stop after bounded running page");
    expect(firstPageSize).toBe(MAX_RUNNING_RECONCILIATION_ROWS);
  });

  it("re-reads a prior run that completes between list and settlement", async () => {
    const fixture = createDatabase();
    const repository = seedWorkflowRepository(fixture.database);
    const dispatchId = "6".repeat(64);
    const itemId = "7".repeat(64);
    const runId = "8".repeat(64);
    const priorSlot = "2026-07-29T06:00:00.000Z";
    const completedAt = "2026-07-29T11:59:59.000Z";
    seedWorkflowRun(fixture.database, {
      ...repository,
      runId,
      scheduledFor: priorSlot,
      leaseExpiresAt: "2026-07-29T06:30:00.000Z"
    });
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId,
      itemId,
      credentialVersion: "credential-current",
      scheduledFor: priorSlot,
      dispatchStatus: "dispatching",
      runId
    });
    fixture.database.prepare(
      `INSERT INTO github_sync_dispatch_materialization_receipts
       (receipt_id, dispatch_id, item_count, completed_at) VALUES (?, ?, 1, ?)`
    ).run("9".repeat(64), dispatchId, priorSlot);
    let raced = false;
    const step = createImmediateWorkflowStep((name) => {
      if (raced || !name.startsWith("list prior running dispatch items")) return;
      raced = true;
      fixture.database.prepare(
        `UPDATE github_repository_sync_runs
         SET status = 'complete', completed_at = ?, last_error_code = NULL
         WHERE run_id = ?`
      ).run(completedAt, runId);
      fixture.database.prepare(
        `UPDATE github_sync_dispatch_items
         SET status = 'complete', completed_at = ?, last_error_code = NULL
         WHERE item_id = ?`
      ).run(completedAt, itemId);
      fixture.database.prepare(
        `INSERT INTO github_repository_sync_finish_receipts
         (receipt_id, run_id, dispatch_item_id, project_id, repository_id, ref,
          status, last_error_code, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'complete', NULL, ?)`
      ).run(
        "a".repeat(64),
        runId,
        itemId,
        repository.projectId,
        repository.repositoryId,
        repository.ref,
        completedAt
      );
    });

    await expect(
      reconcilePriorDispatchState(
        step,
        fixture.d1,
        "2026-07-29T12:00:00.000Z",
        "credential-current"
      )
    ).resolves.toBeUndefined();
    expect(fixture.database.prepare(
      `SELECT status, last_error_code FROM github_sync_dispatch_items
       WHERE item_id = ?`
    ).get(itemId)).toEqual({ status: "complete", last_error_code: null });
    expect(fixture.database.prepare(
      `SELECT status FROM github_sync_dispatches WHERE dispatch_id = ?`
    ).get(dispatchId)).toEqual({ status: "complete" });
  });

  it("terminalizes pending items when a fanout page fails permanently", async () => {
    const fixture = createDatabase();
    const repository = seedWorkflowRepository(fixture.database);
    const scheduledTime = canonicalGitHubSyncSlot(Date.now()) + 6 * 60 * 60 * 1_000;
    const identity = await githubDispatchIdentity(
      "credential-current",
      scheduledTime
    );
    const itemId = "b".repeat(64);
    seedWorkflowDispatchItem(fixture.database, {
      ...repository,
      dispatchId: identity.dispatchId,
      itemId,
      credentialVersion: "credential-current",
      scheduledFor: identity.scheduledFor,
      dispatchStatus: "dispatching"
    });
    for (let index = 1; index <= 100; index += 1) {
      const additionalItemId = index.toString(16).padStart(64, "0");
      fixture.database.prepare(
        `INSERT INTO github_sync_dispatch_items
         (item_id, dispatch_id, project_id, repository_id, ref, scheduled_for,
          full_reconciliation, repository_configuration_version, cursor_version,
          selected_head_manifest_id, selected_head_version,
          repository_updated_at, cursor_status, cursor_updated_at,
          workflow_instance_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, NULL, 0, ?, 'idle', ?, ?,
                 'pending', ?)`
      ).run(
        additionalItemId,
        identity.dispatchId,
        repository.projectId,
        repository.repositoryId,
        `refs/heads/test-${index}`,
        identity.scheduledFor,
        repository.repositoryUpdatedAt,
        repository.cursorUpdatedAt,
        `ghr-${additionalItemId}`,
        identity.scheduledFor
      );
    }
    fixture.database.prepare(
      `INSERT INTO github_sync_dispatch_materialization_receipts
       (receipt_id, dispatch_id, item_count, completed_at) VALUES (?, ?, 101, ?)`
    ).run("c".repeat(64), identity.dispatchId, identity.scheduledFor);
    const fanoutError = new Error("permanent fanout failure");
    const refWorkflow = {
      createBatch: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(fanoutError),
      create: vi.fn().mockRejectedValue(fanoutError),
      get: vi.fn().mockRejectedValue(fanoutError)
    } as unknown as Workflow;

    await expect(
      runGitHubDispatchWorkflow(
        {
          dispatchId: identity.dispatchId,
          credentialVersion: "credential-current",
          scheduledFor: identity.scheduledFor,
          utcDate: identity.utcDate
        },
        identity.instanceId,
        createImmediateWorkflowStep(),
        {
          MEMORY_DB: fixture.d1,
          GITHUB_SYNC_ENABLED: "true",
          GITHUB_CLASSIC_TOKEN: "synthetic-token",
          GITHUB_CREDENTIAL_VERSION: "credential-current",
          GITHUB_REF_SYNC_WORKFLOW: refWorkflow
        }
      )
    ).rejects.toThrow("permanent fanout failure");
    expect(fixture.database.prepare(
      `SELECT status, run_id, last_error_code FROM github_sync_dispatch_items
       WHERE item_id = ?`
    ).get(itemId)).toEqual({
      status: "failed",
      run_id: null,
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
    expect(fixture.database.prepare(
      `SELECT COUNT(*) AS count FROM github_sync_dispatch_items
       WHERE dispatch_id = ? AND status = 'failed' AND run_id IS NULL`
    ).get(identity.dispatchId)).toEqual({ count: 101 });
    expect(fixture.database.prepare(
      `SELECT COUNT(*) AS count
       FROM github_sync_dispatch_item_rejection_receipts
       WHERE dispatch_id = ?`
    ).get(identity.dispatchId)).toEqual({ count: 101 });
    expect(refWorkflow.createBatch).toHaveBeenCalledTimes(2);
    expect(fixture.database.prepare(
      `SELECT status, last_error_code FROM github_sync_dispatches
       WHERE dispatch_id = ?`
    ).get(identity.dispatchId)).toEqual({
      status: "failed",
      last_error_code: "GITHUB_RECONCILIATION_REQUIRED"
    });
    const terminalSnapshot = fixture.database.prepare(
      `SELECT status, completed_at, last_error_code
       FROM github_sync_dispatch_items WHERE item_id = ?`
    ).get(itemId);
    vi.mocked(refWorkflow.createBatch).mockClear();
    await expect(
      runGitHubDispatchWorkflow(
        {
          dispatchId: identity.dispatchId,
          credentialVersion: "credential-current",
          scheduledFor: identity.scheduledFor,
          utcDate: identity.utcDate
        },
        identity.instanceId,
        createImmediateWorkflowStep(),
        {
          MEMORY_DB: fixture.d1,
          GITHUB_SYNC_ENABLED: "true",
          GITHUB_CLASSIC_TOKEN: "synthetic-token",
          GITHUB_CREDENTIAL_VERSION: "credential-current",
          GITHUB_REF_SYNC_WORKFLOW: refWorkflow
        }
      )
    ).resolves.toBeUndefined();
    expect(refWorkflow.createBatch).not.toHaveBeenCalled();
    expect(fixture.database.prepare(
      `SELECT status, completed_at, last_error_code
       FROM github_sync_dispatch_items WHERE item_id = ?`
    ).get(itemId)).toEqual(terminalSnapshot);
  });
});

describe("GitHub Workflow migration", () => {
  it("installs per-ref run identity and guarded Workflow state", () => {
    const fixture = createDatabase();
    const indexes = fixture.database
      .prepare("PRAGMA index_list(github_repository_sync_runs)")
      .all() as Array<{ name: string; origin: string }>;
    const uniqueColumns = indexes
      .filter((index) => index.origin === "u")
      .map((index) =>
        (fixture.database.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{
          name: string;
        }>).map((column) => column.name)
      );
    expect(uniqueColumns).toContainEqual([
      "project_id",
      "repository_id",
      "claimed_ref",
      "scheduled_for"
    ]);

    const dispatchId = "a".repeat(64);
    fixture.database.prepare(
      `INSERT INTO github_sync_dispatches
       (dispatch_id, credential_version, workflow_instance_id, scheduled_for,
        utc_date, status, created_at)
       VALUES (?, 'credential-current', ?, '2026-07-29T06:00:00.000Z',
               '2026-07-29', 'materialized', '2026-07-29T06:00:00.000Z')`
    ).run(dispatchId, `ghd-${dispatchId}`);
    expect(() =>
      fixture.database.prepare(
        `UPDATE github_sync_dispatches SET credential_version = 'different'
         WHERE dispatch_id = ?`
      ).run(dispatchId)
    ).toThrow("identity is immutable");
    fixture.database.prepare(
      `UPDATE github_sync_dispatches SET status = 'dispatching'
       WHERE dispatch_id = ?`
    ).run(dispatchId);
    expect(() =>
      fixture.database.prepare(
        `UPDATE github_sync_dispatches SET status = 'materialized'
         WHERE dispatch_id = ?`
      ).run(dispatchId)
    ).toThrow("transition is invalid");

    const repository = seedWorkflowRepository(fixture.database);
    expect(() => fixture.database.prepare(
      `INSERT INTO github_sync_dispatch_items
       (item_id, dispatch_id, project_id, repository_id, ref, scheduled_for,
        full_reconciliation, repository_configuration_version, cursor_version,
        selected_head_manifest_id, selected_head_version,
        repository_updated_at, cursor_status, cursor_updated_at,
        workflow_instance_id, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, '2026-07-29T06:00:00.000Z', 0, 1, 1,
               NULL, 0, ?, 'idle', ?, ?, 'failed',
               '2026-07-29T06:00:00.000Z', '2026-07-29T06:00:01.000Z')`
    ).run(
      "f".repeat(64),
      dispatchId,
      repository.projectId,
      repository.repositoryId,
      repository.ref,
      repository.repositoryUpdatedAt,
      repository.cursorUpdatedAt,
      `ghr-${"f".repeat(64)}`
    )).toThrow();

    fixture.database.prepare(
      `INSERT INTO github_credential_sync_lane
       (credential_version, holder_kind, holder_id, lease_claim_id, lease_epoch,
        lease_until, available_after, updated_at)
       VALUES ('credential-lane', NULL, NULL, NULL, 0, NULL,
               '2026-07-29T06:00:00.000Z', '2026-07-29T06:00:00.000Z')`
    ).run();
    expect(() =>
      fixture.database.prepare(
        `UPDATE github_credential_sync_lane
         SET holder_kind = 'ref', holder_id = 'item', lease_claim_id = ?,
             lease_until = '2026-07-29T06:10:00.000Z'
         WHERE credential_version = 'credential-lane'`
      ).run("b".repeat(64))
    ).toThrow("lane transition is invalid");

    const cleanupTrigger = fixture.database.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger' AND name = 'synthetic_cleanup_registry_delete_child_guard'`
    ).get() as { sql: string };
    expect(cleanupTrigger.sql).toContain("consolidation_batch_receipts");
    expect(cleanupTrigger.sql).toContain("github_repository_sync_finish_receipts");
    expect(cleanupTrigger.sql).toContain("github_sync_dispatch_items");
    expect(cleanupTrigger.sql).toContain("github_sync_dispatches");
    expect(cleanupTrigger.sql).toContain("github_credential_sync_lane");
  });
});

interface SqliteFault {
  remaining: number;
  matches(sql: string): boolean;
}

function createDatabase(fault?: SqliteFault): {
  database: DatabaseSync;
  d1: D1Database;
} {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(join(process.cwd(), "migrations"))
    .filter((entry) => /^\d+.*\.sql$/u.test(entry))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", name), "utf8"));
  }
  const d1 = new SqliteD1(database, fault) as unknown as D1Database;
  return { database, d1 };
}

function seedWorkflowRepository(database: DatabaseSync): {
  projectId: string;
  repositoryId: string;
  ref: string;
  repositoryUpdatedAt: string;
  cursorUpdatedAt: string;
} {
  const projectId = "workflow-project";
  const repositoryId = "workflow-repository";
  const ref = "refs/heads/main";
  const timestamp = "2026-07-29T00:00:00.000Z";
  database.prepare(
    `INSERT INTO projects
     (project_id, project_ref, locator, display_name, project_version,
      created_at, updated_at)
     VALUES (?, 'project.workflow', 'locator.workflow', 'Workflow', 0, ?, ?)`
  ).run(projectId, timestamp, timestamp);
  database.prepare(
    `INSERT INTO repositories
     (repository_id, project_id, provider, external_id,
      expected_owner_external_id, owner, name, default_branch,
      tracked_refs_json, sync_enabled, created_at, updated_at)
     VALUES (?, ?, 'github', 42, 7, 'memenow', 'edgemneme', 'main',
             '[]', 1, ?, ?)`
  ).run(repositoryId, projectId, timestamp, timestamp);
  database.prepare(
    `INSERT INTO sync_cursors
     (project_id, repository_id, ref, status, history_gap_possible,
      credential_status, updated_at)
     VALUES (?, ?, ?, 'idle', 0, 'active', ?)`
  ).run(projectId, repositoryId, ref, timestamp);
  return {
    projectId,
    repositoryId,
    ref,
    repositoryUpdatedAt: timestamp,
    cursorUpdatedAt: timestamp
  };
}

function seedWorkflowRun(
  database: DatabaseSync,
  input: {
    projectId: string;
    repositoryId: string;
    ref: string;
    runId: string;
    scheduledFor: string;
    leaseExpiresAt: string;
    startedAt?: string;
  }
): void {
  database.prepare(
    `INSERT INTO github_repository_sync_runs
     (run_id, project_id, repository_id, scheduled_for, full_reconciliation,
      status, started_at, lease_expires_at, claimed_ref,
      claimed_head_manifest_id, claimed_head_version,
      repository_configuration_version, cursor_version, claim_contract_version)
     VALUES (?, ?, ?, ?, 0, 'running', ?, ?, ?, NULL, 0, 1, 1, 1)`
  ).run(
    input.runId,
    input.projectId,
    input.repositoryId,
    input.scheduledFor,
    input.startedAt ?? input.scheduledFor,
    input.leaseExpiresAt,
    input.ref
  );
}

function seedWorkflowDispatchItem(
  database: DatabaseSync,
  input: {
    projectId: string;
    repositoryId: string;
    ref: string;
    repositoryUpdatedAt: string;
    cursorUpdatedAt: string;
    dispatchId: string;
    itemId: string;
    credentialVersion: string;
    scheduledFor: string;
    dispatchStatus: "materialized" | "dispatching";
    runId?: string;
  }
): void {
  database.prepare(
    `INSERT INTO github_sync_dispatches
     (dispatch_id, credential_version, workflow_instance_id, scheduled_for,
      utc_date, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dispatch_id) DO NOTHING`
  ).run(
    input.dispatchId,
    input.credentialVersion,
    `ghd-${input.dispatchId}`,
    input.scheduledFor,
    input.scheduledFor.slice(0, 10),
    input.dispatchStatus,
    input.scheduledFor
  );
  const running = input.runId !== undefined;
  database.prepare(
    `INSERT INTO github_sync_dispatch_items
     (item_id, dispatch_id, project_id, repository_id, ref, scheduled_for,
      full_reconciliation, repository_configuration_version, cursor_version,
      selected_head_manifest_id, selected_head_version,
      repository_updated_at, cursor_status, cursor_updated_at,
      workflow_instance_id, status, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, NULL, 0, ?, 'idle', ?, ?, ?, ?, ?)`
  ).run(
    input.itemId,
    input.dispatchId,
    input.projectId,
    input.repositoryId,
    input.ref,
    input.scheduledFor,
    input.repositoryUpdatedAt,
    input.cursorUpdatedAt,
    `ghr-${input.itemId}`,
    running ? "running" : "pending",
    input.runId ?? null,
    input.scheduledFor
  );
}

function createImmediateWorkflowStep(
  afterStep?: (name: string, result: unknown) => void | Promise<void>
): WorkflowStep {
  return {
    async do(name: string, ...args: unknown[]): Promise<unknown> {
      const callback = args.find((value) => typeof value === "function") as
        | (() => Promise<unknown>)
        | undefined;
      if (callback === undefined) throw new Error(`Missing callback for ${name}`);
      const result = await callback();
      await afterStep?.(name, result);
      return result;
    },
    async sleep(): Promise<void> {}
  } as unknown as WorkflowStep;
}

class SqliteD1 {
  constructor(
    private readonly database: DatabaseSync,
    private readonly fault?: SqliteFault
  ) {}

  withSession(): SqliteD1 {
    return this;
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, this.fault);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const sqliteStatements = statements as unknown as SqliteStatement[];
    const results: D1Result[] = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of sqliteStatements) {
        results.push(statement.executeWithoutResponseFault());
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    for (const statement of sqliteStatements) {
      if (statement.consumeResponseFault()) {
        throw new Error("synthetic response loss");
      }
    }
    return results;
  }
}

class SqliteStatement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly fault?: SqliteFault
  ) {}

  bind(...bindings: unknown[]): SqliteStatement {
    this.bindings = bindings as SQLInputValue[];
    return this;
  }

  run(): Promise<D1Result> {
    const result = this.executeWithoutResponseFault();
    if (this.consumeResponseFault()) {
      return Promise.reject(new Error("synthetic response loss"));
    }
    return Promise.resolve(result);
  }

  executeWithoutResponseFault(): D1Result {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
      results: []
    } as unknown as D1Result;
  }

  consumeResponseFault(): boolean {
    if (
      this.fault !== undefined &&
      this.fault.remaining > 0 &&
      this.fault.matches(this.sql)
    ) {
      this.fault.remaining -= 1;
      return true;
    }
    return false;
  }

  first<T>(): Promise<T | null> {
    if (this.consumeResponseFault()) {
      return Promise.reject(new Error("synthetic response loss"));
    }
    return Promise.resolve(
      (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null
    );
  }

  all<T>(): Promise<D1Result<T>> {
    return Promise.resolve({
      success: true,
      meta: {},
      results: this.database.prepare(this.sql).all(...this.bindings) as T[]
    } as unknown as D1Result<T>);
  }
}
