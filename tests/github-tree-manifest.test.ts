import { readFileSync } from "node:fs";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync
} from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  prepareGitHubCandidateStatements
} from "../src/github/candidate-persistence";
import type { PersistableGitHubCandidate } from "../src/github/candidate-persistence";
import type { PendingGitHubSyncActivationFence } from "../src/github/sync-activation-fence";
import { markGitHubSyncPendingReview } from "../src/github/sync-review-cursor";
import {
  activateGitHubTreeManifest,
  beginGitHubTreeManifest,
  buildGitHubTreeManifestDescriptor,
  completeGitHubTreeManifest,
  createGitHubTreeManifestActivationAttempt,
  persistGitHubTreeManifestEntries,
  readActiveGitHubTreeHead,
  type GitHubTreeManifestActivationClaim,
  type GitHubTreeManifestDescriptor,
  type GitHubTreeManifestEntry
} from "../src/github/tree-manifest";
import { sha256 } from "../src/security/crypto";
import {
  buildGitHubBlobCandidate,
  buildStableSyncEvent
} from "../workers/github-sync/index";

const MIGRATIONS = ["migrations/0001_initial.sql"];

const NOW = "2026-07-28T00:00:00.000Z";
const PROJECT_ID = "project-a";
const REPOSITORY_ID = "repository-a";
const REF = "refs/heads/main";
const SHA = {
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  keep: "c".repeat(40),
  changedOld: "d".repeat(40),
  changedNew: "e".repeat(40),
  deleted: "f".repeat(40),
  sensitive: "1".repeat(40),
  added: "2".repeat(40)
};

describe("GitHub tree manifest reconciliation", () => {
  it("persists candidate artifacts in idempotent project-scoped bulk statements", async () => {
    const fixture = createFixture();
    const activeManifest = await descriptor("2026-07-28T00:00:00.000Z");
    const clear = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path: "docs/context.md",
      blobSha: SHA.keep,
      content: "Durable project context."
    });
    const tombstone = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path: "docs/private.txt",
      blobSha: SHA.sensitive,
      content: "api_key = 'synthetic-sensitive-value'"
    });
    const committed = await storeAndActivate(
      fixture.d1,
      activeManifest,
      [],
      null,
      [clear, tombstone]
    );
    await activate(
      fixture.d1,
      activeManifest,
      null,
      committed.candidateStatements,
      null,
      committed.activationClaim
    );
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM evidence WHERE project_id = ?) AS evidence,
             (SELECT COUNT(*) FROM observations WHERE project_id = ?) AS observations,
             (SELECT COUNT(*) FROM observation_evidence WHERE project_id = ?) AS links,
             (SELECT COUNT(*) FROM outbox_events
              WHERE project_id = ? AND event_type = 'candidate.submitted') AS outbox`
        )
        .get(PROJECT_ID, PROJECT_ID, PROJECT_ID, PROJECT_ID)
    ).toEqual({ evidence: 2, observations: 1, links: 1, outbox: 1 });
    expect(
      fixture.database
        .prepare(
          `SELECT content FROM observations WHERE project_id = ?`
        )
        .all(PROJECT_ID)
    ).toEqual([{ content: "Durable project context." }]);
    expect(JSON.stringify(fixture.database.prepare(`SELECT * FROM evidence`).all())).not.toContain(
      "synthetic-sensitive-value"
    );
    expect(
      fixture.database
        .prepare(
          `SELECT locator, repository_path FROM evidence
           WHERE project_id = ? AND sensitivity_status = 'tombstone'`
        )
        .get(PROJECT_ID)
    ).toEqual({
      locator: expect.stringMatching(
        new RegExp(`^github://42/${SHA.commit}/path-sha256/[0-9a-f]{64}$`, "u")
      ),
      repository_path: null
    });

    await expect(
      prepareGitHubCandidateStatements({
        database: fixture.d1,
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        repositoryRef: REF,
        externalRepositoryId: 42,
        manifestId: activeManifest.manifestId,
        observedSha: SHA.commit,
        activationFence: committed.activationFence,
        candidates: [
          {
            ...tombstone,
            locator:
              `github://raw-sensitive-prefix/${SHA.commit}/path-sha256/` +
              "7".repeat(64)
          }
        ]
      })
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    expect(() =>
      fixture.database
        .prepare(
          `INSERT INTO evidence
           (evidence_id, project_id, source_type, locator, repository_id,
            repository_ref, repository_path, repository_authority, commit_sha,
            excerpt_hash, sensitivity_status, recorded_at)
           VALUES ('forged-sensitive-evidence', ?, 'github_blob', ?, ?, ?, NULL,
                   'default_branch', ?, 'forged-excerpt', 'tombstone', ?)`
        )
        .run(
          PROJECT_ID,
          `github://raw-sensitive-prefix/${SHA.commit}/path-sha256/${"7".repeat(64)}`,
          REPOSITORY_ID,
          REF,
          SHA.commit,
          NOW
        )
    ).toThrow(/evidence repository context is invalid/iu);

    await expect(
      prepareGitHubCandidateStatements({
        database: fixture.d1,
        projectId: PROJECT_ID,
        repositoryId: "repository-b",
        repositoryRef: REF,
        externalRepositoryId: 42,
        manifestId: activeManifest.manifestId,
        observedSha: SHA.commit,
        activationFence: committed.activationFence,
        candidates: [clear]
      })
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
  });

  it("rejects deltas that do not exactly match manifest entry provenance", async () => {
    const fixture = createFixture();
    const changedPath = "docs/changed.md";
    const deletedPath = "docs/deleted.md";
    const withdrawnPath = "docs/withdrawn.md";
    const addedPath = "docs/added-sensitive.md";
    const changedPathDigest = await sha256(changedPath);
    const deletedPathDigest = await sha256(deletedPath);
    const withdrawnPathDigest = await sha256(withdrawnPath);
    const addedPathDigest = await sha256(addedPath);
    const oldEntries = await entries([
      [changedPath, SHA.changedOld, "text"],
      [deletedPath, SHA.deleted, "text"],
      [withdrawnPath, SHA.keep, "text"]
    ]);
    const oldManifest = await descriptor("2026-07-26T00:00:00.000Z");
    await storeAndActivate(fixture.d1, oldManifest, oldEntries, null);
    const newEntries = await entries([
      [changedPath, SHA.changedNew, "text"],
      [withdrawnPath, SHA.sensitive, "sensitive_tombstone"],
      [addedPath, SHA.added, "sensitive_tombstone"]
    ]);
    const newManifest = await descriptor("2026-07-27T00:00:00.000Z");
    await beginGitHubTreeManifest(fixture.d1, newManifest);
    await persistGitHubTreeManifestEntries(fixture.d1, newManifest, newEntries);
    await completeGitHubTreeManifest(fixture.d1, newManifest, newEntries, NOW);
    const insertInvalidDelta = (input: {
      id: string;
      pathDigest: string;
      safePath: string;
      changeKind: "added" | "changed" | "deleted" | "withdrawn";
      oldBlobSha: string | null;
      newBlobSha: string | null;
      oldDisposition: string | null;
      newDisposition: string | null;
    }): void => {
      fixture.database
        .prepare(
          `INSERT INTO github_tree_manifest_deltas
           (delta_id, project_id, repository_id, ref, old_manifest_id,
            new_manifest_id, path_digest, safe_path, change_kind,
            old_blob_sha, new_blob_sha, old_disposition, new_disposition,
            affected_memory_ids_json, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`
        )
        .run(
          input.id,
          PROJECT_ID,
          REPOSITORY_ID,
          REF,
          oldManifest.manifestId,
          newManifest.manifestId,
          input.pathDigest,
          input.safePath,
          input.changeKind,
          input.oldBlobSha,
          input.newBlobSha,
          input.oldDisposition,
          input.newDisposition,
          `${input.id}-idempotency`,
          NOW
        );
    };

    expect(() =>
      insertInvalidDelta({
        id: "invalid-added-provenance",
        pathDigest: addedPathDigest,
        safePath: "wrong/added.md",
        changeKind: "added",
        oldBlobSha: null,
        newBlobSha: SHA.added,
        oldDisposition: null,
        newDisposition: "sensitive_tombstone"
      })
    ).toThrow(/delta provenance is invalid/iu);
    expect(() =>
      insertInvalidDelta({
        id: "invalid-changed-provenance",
        pathDigest: changedPathDigest,
        safePath: "wrong/changed.md",
        changeKind: "changed",
        oldBlobSha: SHA.changedOld,
        newBlobSha: SHA.changedNew,
        oldDisposition: "text",
        newDisposition: "text"
      })
    ).toThrow(/delta provenance is invalid/iu);
    expect(() =>
      insertInvalidDelta({
        id: "invalid-deleted-provenance",
        pathDigest: deletedPathDigest,
        safePath: "wrong/deleted.md",
        changeKind: "deleted",
        oldBlobSha: SHA.deleted,
        newBlobSha: null,
        oldDisposition: "text",
        newDisposition: null
      })
    ).toThrow(/delta provenance is invalid/iu);
    expect(() =>
      insertInvalidDelta({
        id: "invalid-withdrawn-provenance",
        pathDigest: withdrawnPathDigest,
        safePath: "leaked/withdrawn.md",
        changeKind: "withdrawn",
        oldBlobSha: SHA.keep,
        newBlobSha: SHA.sensitive,
        oldDisposition: "text",
        newDisposition: "sensitive_tombstone"
      })
    ).toThrow(/delta provenance is invalid/iu);
  });

  it("preserves a clear identity when the same source becomes a tombstone", async () => {
    const fixture = createFixture();
    const path = "docs/text-to-tombstone.md";
    const { clear, tombstone } = await buildPolicyCandidatePair(path);
    const clearManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      clearManifest,
      await entries([[path, SHA.keep, "text"]]),
      null,
      [clear]
    );
    const clearEvidenceBefore = readEvidence(fixture.database, clear.evidenceId);

    const tombstoneManifest = await descriptor("2026-07-29T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      tombstoneManifest,
      await entries([[path, SHA.keep, "sensitive_tombstone"]]),
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF),
      [tombstone]
    );

    expect(tombstone.evidenceId).not.toBe(clear.evidenceId);
    expect(readEvidence(fixture.database, clear.evidenceId)).toEqual(
      clearEvidenceBefore
    );
    expect(readEvidence(fixture.database, tombstone.evidenceId)).toMatchObject({
      evidence_id: tombstone.evidenceId,
      repository_path: null,
      sensitivity_status: "tombstone"
    });
  });

  it("replays the same ref and SHA across manifests without resetting durable artifacts", async () => {
    const fixture = createFixture();
    const firstManifest = await descriptor("2026-07-28T00:00:00.000Z");
    const candidate = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path: "docs/context.md",
      blobSha: SHA.keep,
      content: "Durable project context."
    });
    const observationId = candidate.observation?.observationId;
    if (observationId === undefined) {
      throw new Error("The replay fixture requires a clear candidate.");
    }
    await storeAndActivate(fixture.d1, firstManifest, [], null, [candidate]);

    fixture.database
      .prepare(
        `UPDATE observations
         SET status = 'pending_review', updated_at = ?
         WHERE project_id = ? AND observation_id = ?`
      )
      .run("2026-07-28T01:00:00.000Z", PROJECT_ID, observationId);
    fixture.database
      .prepare(
        `UPDATE observations
         SET candidate_version = 2, status = 'request_changes',
             review_reason = 'Synthetic lifecycle advancement', updated_at = ?
         WHERE project_id = ? AND observation_id = ?`
      )
      .run("2026-07-28T02:00:00.000Z", PROJECT_ID, observationId);
    fixture.database
      .prepare(
        `UPDATE evidence
         SET sensitivity_status = 'quarantined', object_uri = ?
         WHERE project_id = ? AND evidence_id = ?`
      )
      .run("r2://synthetic-quarantine/object", PROJECT_ID, candidate.evidenceId);
    fixture.database
      .prepare(
        `UPDATE outbox_events
         SET dispatched_at = ?, next_attempt_at = ?,
             last_error_code = 'SYNTHETIC_RETRY', attempt = 3
         WHERE project_id = ?
           AND event_type IN ('candidate.submitted', 'github.sync.requested')`
      )
      .run(
        "2026-07-28T03:00:00.000Z",
        "2026-07-28T04:00:00.000Z",
        PROJECT_ID
      );
    fixture.database
      .prepare(
        `UPDATE projects SET project_version = 7, updated_at = ?
         WHERE project_id = ?`
      )
      .run("2026-07-28T05:00:00.000Z", PROJECT_ID);

    const durableBefore = readCandidateReplayState(
      fixture.database,
      observationId,
      candidate.evidenceId
    );
    const expectedHead = await readActiveGitHubTreeHead(
      fixture.d1,
      PROJECT_ID,
      REPOSITORY_ID,
      REF
    );
    const secondManifest = await descriptor("2026-07-29T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      secondManifest,
      [],
      expectedHead,
      [candidate]
    );

    const durableAfter = readCandidateReplayState(
      fixture.database,
      observationId,
      candidate.evidenceId
    );
    expect(durableAfter.observation).toEqual(durableBefore.observation);
    expect(durableAfter.evidence).toEqual(durableBefore.evidence);
    expect(durableAfter.link).toEqual(durableBefore.link);
    expect(durableBefore.observation).toMatchObject({
      candidate_version: 2,
      status: "request_changes",
      review_reason: "Synthetic lifecycle advancement"
    });
    expect(durableBefore.evidence).toMatchObject({
      sensitivity_status: "quarantined",
      object_uri: "r2://synthetic-quarantine/object"
    });
    expect(durableBefore.outbox).toHaveLength(2);
    expect(durableBefore.outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_version: 0,
          dispatched_at: "2026-07-28T03:00:00.000Z",
          next_attempt_at: "2026-07-28T04:00:00.000Z",
          last_error_code: "SYNTHETIC_RETRY",
          attempt: 3
        })
      ])
    );
    const secondSyncEvent = await buildStableSyncEvent({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      ref: REF,
      observedSha: SHA.commit,
      manifestId: secondManifest.manifestId
    });
    const secondSyncPayload = JSON.stringify(secondSyncEvent);
    expect(
      durableAfter.outbox.filter(
        (event) => event.event_id !== secondSyncEvent.eventId
      )
    ).toEqual(durableBefore.outbox);
    const secondSyncRows = durableAfter.outbox.filter(
      (event) => event.event_id === secondSyncEvent.eventId
    );
    expect(secondSyncRows).toHaveLength(1);
    const secondSyncRow = secondSyncRows[0];
    if (secondSyncRow === undefined) {
      throw new Error("The second manifest must enqueue its own sync event.");
    }
    const { created_at: secondSyncCreatedAt, ...secondSyncDurableState } =
      secondSyncRow;
    expect(secondSyncDurableState).toEqual({
      event_id: secondSyncEvent.eventId,
      project_id: PROJECT_ID,
      project_version: 7,
      event_type: "github.sync.requested",
      payload_digest: await sha256(secondSyncPayload),
      payload_json: secondSyncPayload,
      dispatched_at: null,
      failed_at: null,
      next_attempt_at: null,
      last_error_code: null,
      attempt: 0,
      projection_unknown_alerted_at: null,
      projection_unknown_count: 0,
      projection_unknown_first_observed_at: null,
      projection_unknown_last_observed_at: null
    });
    expect(new Date(String(secondSyncCreatedAt)).toISOString()).toBe(
      secondSyncCreatedAt
    );
    expect(
      await readActiveGitHubTreeHead(
        fixture.d1,
        PROJECT_ID,
        REPOSITORY_ID,
        REF
      )
    ).toEqual({
      manifestId: secondManifest.manifestId,
      observedSha: SHA.commit,
      headVersion: 2
    });
    expect(
      fixture.database
        .prepare(
          `SELECT cursor.observed_sha, cursor.status, cursor.cursor_version,
                  (SELECT COUNT(*) FROM github_tree_activation_receipts
                   WHERE project_id = ?) AS receipts
           FROM sync_cursors AS cursor
           WHERE cursor.project_id = ? AND cursor.repository_id = ?
             AND cursor.ref = ?`
        )
        .get(PROJECT_ID, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({
      observed_sha: SHA.commit,
      status: "observed",
      cursor_version: 3,
      receipts: 2
    });
  });

  it("keeps clear and tombstone evidence immutable across a same-SHA policy cycle", async () => {
    const fixture = createFixture();
    const path = "docs/policy-source.md";
    const clearCandidate = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path,
      blobSha: SHA.keep,
      content: "Durable project context."
    });
    const tombstoneCandidate = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path,
      blobSha: SHA.keep,
      content: "api_key = 'synthetic-sensitive-value'"
    });
    expect(clearCandidate.sensitivityStatus).toBe("clear");
    expect(tombstoneCandidate.sensitivityStatus).toBe("tombstone");
    expect(tombstoneCandidate.evidenceId).not.toBe(clearCandidate.evidenceId);

    const clearManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      clearManifest,
      await entries([[path, SHA.keep, "text"]]),
      null,
      [clearCandidate]
    );
    const clearEvidenceBefore = fixture.database
      .prepare(`SELECT * FROM evidence WHERE project_id = ? AND evidence_id = ?`)
      .get(PROJECT_ID, clearCandidate.evidenceId);

    const sensitiveManifest = await descriptor("2026-07-29T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      sensitiveManifest,
      await entries([[path, SHA.keep, "sensitive_tombstone"]]),
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF),
      [tombstoneCandidate]
    );
    const tombstoneEvidenceBefore = fixture.database
      .prepare(`SELECT * FROM evidence WHERE project_id = ? AND evidence_id = ?`)
      .get(PROJECT_ID, tombstoneCandidate.evidenceId);

    const restoredCandidate = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path,
      blobSha: SHA.keep,
      content: "Durable project context."
    });
    expect(restoredCandidate.evidenceId).toBe(clearCandidate.evidenceId);
    const restoredManifest = await descriptor("2026-07-30T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      restoredManifest,
      await entries([[path, SHA.keep, "text"]]),
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF),
      [restoredCandidate]
    );

    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({
      manifestId: restoredManifest.manifestId,
      observedSha: SHA.commit,
      headVersion: 3
    });
    expect(
      fixture.database
        .prepare(`SELECT * FROM evidence WHERE project_id = ? AND evidence_id = ?`)
        .get(PROJECT_ID, clearCandidate.evidenceId)
    ).toEqual(clearEvidenceBefore);
    expect(
      fixture.database
        .prepare(`SELECT * FROM evidence WHERE project_id = ? AND evidence_id = ?`)
        .get(PROJECT_ID, tombstoneCandidate.evidenceId)
    ).toEqual(tombstoneEvidenceBefore);
    expect(
      fixture.database
        .prepare(
          `SELECT sensitivity_status, COUNT(*) AS count
           FROM evidence
           WHERE project_id = ? AND source_type = 'github_blob'
           GROUP BY sensitivity_status ORDER BY sensitivity_status`
        )
        .all(PROJECT_ID)
    ).toEqual([
      { sensitivity_status: "clear", count: 1 },
      { sensitivity_status: "tombstone", count: 1 }
    ]);
    const syncPayloadRows = fixture.database
      .prepare(
        `SELECT payload_json FROM outbox_events
         WHERE project_id = ? AND event_type = 'github.sync.requested'
         ORDER BY created_at, event_id`
      )
      .all(PROJECT_ID) as Array<{ payload_json: string }>;
    const syncPayloads = syncPayloadRows.map(
      (row) => JSON.parse(row.payload_json) as { manifestId: string }
    );
    expect(new Set(syncPayloads.map((payload) => payload.manifestId))).toEqual(
      new Set([
        clearManifest.manifestId,
        sensitiveManifest.manifestId,
        restoredManifest.manifestId
      ])
    );
  });

  it("keeps delayed same-SHA review events from resuming a paused cursor", async () => {
    const fixture = createFixture();
    const firstManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(fixture.d1, firstManifest, [], null);
    const secondManifest = await descriptor("2026-07-29T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      secondManifest,
      [],
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    );
    const cursorBeforeStaleEvent = fixture.database
      .prepare(
        `SELECT status, updated_at, cursor_version FROM sync_cursors
         WHERE project_id = ? AND repository_id = ? AND ref = ?`
      )
      .get(PROJECT_ID, REPOSITORY_ID, REF);

    await markGitHubSyncPendingReview(fixture.d1, {
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      ref: REF,
      observedSha: SHA.commit,
      manifestId: firstManifest.manifestId,
      updatedAt: "2026-07-29T02:00:00.000Z"
    });
    expect(
      fixture.database
        .prepare(
          `SELECT status, updated_at, cursor_version FROM sync_cursors
           WHERE project_id = ? AND repository_id = ? AND ref = ?`
        )
        .get(PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual(cursorBeforeStaleEvent);

    fixture.database
      .prepare(
        `UPDATE sync_cursors SET status = 'paused', updated_at = ?
         WHERE project_id = ? AND repository_id = ? AND ref = ?`
      )
      .run("2026-07-29T02:30:00.000Z", PROJECT_ID, REPOSITORY_ID, REF);
    const pausedCursor = fixture.database
      .prepare(
        `SELECT status, updated_at, cursor_version FROM sync_cursors
         WHERE project_id = ? AND repository_id = ? AND ref = ?`
      )
      .get(PROJECT_ID, REPOSITORY_ID, REF);

    await markGitHubSyncPendingReview(fixture.d1, {
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      ref: REF,
      observedSha: SHA.commit,
      manifestId: secondManifest.manifestId,
      updatedAt: "2026-07-29T03:00:00.000Z"
    });
    expect(
      fixture.database
        .prepare(
          `SELECT status, updated_at, cursor_version FROM sync_cursors
           WHERE project_id = ? AND repository_id = ? AND ref = ?`
        )
        .get(PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual(pausedCursor);

    fixture.database
      .prepare(
        `UPDATE sync_cursors SET status = 'complete', updated_at = ?
         WHERE project_id = ? AND repository_id = ? AND ref = ?`
      )
      .run("2026-07-29T03:30:00.000Z", PROJECT_ID, REPOSITORY_ID, REF);
    const driftedCursor = fixture.database
      .prepare(
        `SELECT status, updated_at, cursor_version FROM sync_cursors
         WHERE project_id = ? AND repository_id = ? AND ref = ?`
      )
      .get(PROJECT_ID, REPOSITORY_ID, REF);
    await expect(
      markGitHubSyncPendingReview(fixture.d1, {
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        ref: REF,
        observedSha: SHA.commit,
        manifestId: secondManifest.manifestId,
        updatedAt: "2026-07-29T04:00:00.000Z"
      })
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    expect(
      fixture.database
        .prepare(
          `SELECT status, updated_at, cursor_version FROM sync_cursors
           WHERE project_id = ? AND repository_id = ? AND ref = ?`
        )
        .get(PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual(driftedCursor);
  });

  it("keeps pending candidate statements inert until the activation witness exists", async () => {
    const fixture = createFixture();
    const manifest = await descriptor("2026-07-28T00:00:00.000Z");
    await beginGitHubTreeManifest(fixture.d1, manifest);
    await persistGitHubTreeManifestEntries(fixture.d1, manifest, []);
    await completeGitHubTreeManifest(fixture.d1, manifest, [], NOW);
    const candidate = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path: "docs/context.md",
      blobSha: SHA.keep,
      content: "Durable project context."
    });
    const pending = await prepareCandidateActivation(
      fixture.d1,
      manifest,
      null,
      [candidate]
    );

    await fixture.d1.batch([...pending.candidateStatements]);
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM evidence WHERE project_id = ?) AS evidence,
             (SELECT COUNT(*) FROM observations WHERE project_id = ?) AS observations,
             (SELECT COUNT(*) FROM outbox_events WHERE project_id = ?) AS outbox`
        )
        .get(PROJECT_ID, PROJECT_ID, PROJECT_ID)
    ).toEqual({ evidence: 0, observations: 0, outbox: 0 });

    await activate(
      fixture.d1,
      manifest,
      null,
      pending.candidateStatements,
      null,
      pending.activationClaim
    );
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM evidence WHERE project_id = ?) AS evidence,
             (SELECT COUNT(*) FROM observations WHERE project_id = ?) AS observations,
             (SELECT COUNT(*) FROM github_tree_activation_receipts
              WHERE project_id = ?) AS receipts`
        )
        .get(PROJECT_ID, PROJECT_ID, PROJECT_ID)
    ).toEqual({ evidence: 1, observations: 1, receipts: 1 });
  });

  it("recovers an exact response-loss retry from the committed receipt", async () => {
    const fixture = createFixture();
    const manifest = await descriptor("2026-07-28T00:00:00.000Z");
    await beginGitHubTreeManifest(fixture.d1, manifest);
    await persistGitHubTreeManifestEntries(fixture.d1, manifest, []);
    await completeGitHubTreeManifest(fixture.d1, manifest, [], NOW);
    const pending = await prepareCandidateActivation(
      fixture.d1,
      manifest,
      null,
      []
    );
    fixture.control.failAfterNextCommittedBatch();

    await activate(
      fixture.d1,
      manifest,
      null,
      pending.candidateStatements,
      null,
      pending.activationClaim
    );
    await activate(
      fixture.d1,
      manifest,
      null,
      pending.candidateStatements,
      null,
      pending.activationClaim
    );
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM github_tree_activation_witnesses) AS witnesses,
             (SELECT COUNT(*) FROM github_tree_activation_receipts) AS receipts,
             (SELECT COUNT(*) FROM github_tree_ref_heads) AS heads,
             (SELECT COUNT(*) FROM outbox_events
              WHERE event_type = 'github.sync.requested') AS outbox`
        )
        .get()
    ).toEqual({ witnesses: 1, receipts: 1, heads: 1, outbox: 1 });

    await expect(
      activate(
        fixture.d1,
        manifest,
        null,
        pending.candidateStatements,
        null,
        {
          ...pending.activationClaim,
          activationToken: "9".repeat(64)
        }
      )
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
  });

  it("rejects a manifest collected for a different scheduled run", async () => {
    const fixture = createFixture();
    const manifest = await descriptor("2026-07-28T00:00:00.000Z");
    await beginGitHubTreeManifest(fixture.d1, manifest);
    await persistGitHubTreeManifestEntries(fixture.d1, manifest, []);
    await completeGitHubTreeManifest(fixture.d1, manifest, [], NOW);
    const pending = await prepareCandidateActivation(
      fixture.d1,
      manifest,
      null,
      []
    );
    const payloadJson = JSON.stringify({ manifest_id: manifest.manifestId });

    await expect(
      activateGitHubTreeManifest({
        database: fixture.d1,
        descriptor: manifest,
        expectedHead: null,
        activationClaim: pending.activationClaim,
        scheduledTime: Date.parse("2026-07-28T06:00:00.000Z"),
        nextSyncAt: "2026-07-28T12:00:00.000Z",
        historyGapPossible: false,
        credentialStatus: "active",
        etag: null,
        syncEvent: {
          eventId: `sync-${manifest.manifestId}`,
          payloadDigest: await sha256(payloadJson),
          payloadJson
        },
        candidateStatements: pending.candidateStatements
      })
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    expect(
      fixture.database
        .prepare(`SELECT COUNT(*) AS count FROM github_tree_activation_receipts`)
        .get()
    ).toEqual({ count: 0 });
  });

  it("does not heal a target head that has no activation receipt", async () => {
    const fixture = createFixture();
    const oldManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(fixture.d1, oldManifest, [], null);
    const expectedHead = await readActiveGitHubTreeHead(
      fixture.d1,
      PROJECT_ID,
      REPOSITORY_ID,
      REF
    );
    const newManifest = await descriptor("2026-07-29T00:00:00.000Z");
    await beginGitHubTreeManifest(fixture.d1, newManifest);
    await persistGitHubTreeManifestEntries(fixture.d1, newManifest, []);
    await completeGitHubTreeManifest(fixture.d1, newManifest, [], NOW);
    const pending = await prepareCandidateActivation(
      fixture.d1,
      newManifest,
      expectedHead,
      []
    );
    fixture.database
      .prepare(
        `UPDATE github_tree_ref_heads
         SET manifest_id = ?, head_version = head_version + 1,
             activated_at = ?, updated_at = ?
         WHERE project_id = ? AND repository_id = ? AND ref = ?`
      )
      .run(
        newManifest.manifestId,
        NOW,
        NOW,
        PROJECT_ID,
        REPOSITORY_ID,
        REF
      );

    await expect(
      activate(
        fixture.d1,
        newManifest,
        expectedHead,
        pending.candidateStatements,
        expectedHead?.observedSha ?? null,
        pending.activationClaim
      )
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM github_tree_activation_receipts
           WHERE manifest_id = ?`
        )
        .get(newManifest.manifestId)
    ).toEqual({ count: 0 });
  });

  it.each(["observation", "candidate outbox", "sync outbox"] as const)(
    "aborts the whole activation on a conflicting %s artifact",
    async (artifact) => {
      const fixture = createFixture();
      const manifest = await descriptor("2026-07-28T00:00:00.000Z");
      await beginGitHubTreeManifest(fixture.d1, manifest);
      await persistGitHubTreeManifestEntries(fixture.d1, manifest, []);
      await completeGitHubTreeManifest(fixture.d1, manifest, [], NOW);
      const candidate = await buildGitHubBlobCandidate({
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        externalRepositoryId: 42,
        defaultBranch: "main",
        ref: REF,
        observedSha: SHA.commit,
        path: "docs/context.md",
        blobSha: SHA.keep,
        content: "Durable project context."
      });
      const observation = candidate.observation;
      if (observation === undefined) {
        throw new Error("The candidate collision fixture requires an observation.");
      }
      const pending = await prepareCandidateActivation(
        fixture.d1,
        manifest,
        null,
        [candidate]
      );
      if (artifact === "observation") {
        fixture.database
          .prepare(
            `INSERT INTO observations
             (observation_id, project_id, candidate_version, status, content,
              content_sha256, evidence_json, created_at, updated_at)
             VALUES (?, ?, 1, 'queued', 'conflicting content', ?, '[]', ?, ?)`
          )
          .run(
            observation.observationId,
            PROJECT_ID,
            observation.contentSha256,
            NOW,
            NOW
          );
      } else if (artifact === "candidate outbox") {
        fixture.database
          .prepare(
            `INSERT INTO outbox_events
             (event_id, project_id, project_version, event_type, payload_digest,
              payload_json, created_at)
             VALUES (?, ?, 0, 'candidate.submitted', ?, ?, ?)`
          )
          .run(
            observation.event.eventId,
            PROJECT_ID,
            "0".repeat(64),
            JSON.stringify({ conflicting: true }),
            NOW
          );
      } else {
        const syncEvent = await buildStableSyncEvent({
          projectId: PROJECT_ID,
          repositoryId: REPOSITORY_ID,
          externalRepositoryId: 42,
          ref: REF,
          observedSha: SHA.commit,
          manifestId: manifest.manifestId
        });
        fixture.database
          .prepare(
            `INSERT INTO outbox_events
             (event_id, project_id, project_version, event_type, payload_digest,
              payload_json, created_at)
             VALUES (?, ?, 0, 'github.sync.requested', ?, ?, ?)`
          )
          .run(
            syncEvent.eventId,
            PROJECT_ID,
            "0".repeat(64),
            JSON.stringify({ conflicting: true }),
            NOW
          );
      }

      await expect(
        activate(
          fixture.d1,
          manifest,
          null,
          pending.candidateStatements,
          null,
          pending.activationClaim
        )
      ).rejects.toThrow(/stale candidate head|constraint|immutable/iu);
      expect(
        fixture.database
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM evidence WHERE project_id = ?) AS evidence,
               (SELECT COUNT(*) FROM github_tree_activation_witnesses) AS witnesses,
               (SELECT COUNT(*) FROM github_tree_activation_receipts) AS receipts,
               (SELECT COUNT(*) FROM github_tree_ref_heads) AS heads`
          )
          .get(PROJECT_ID)
      ).toEqual({ evidence: 0, witnesses: 0, receipts: 0, heads: 0 });
    }
  );

  it("aborts activation when a deterministic delta ID has different content", async () => {
    const fixture = createFixture();
    const oldManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(fixture.d1, oldManifest, [], null);
    const expectedHead = await readActiveGitHubTreeHead(
      fixture.d1,
      PROJECT_ID,
      REPOSITORY_ID,
      REF
    );
    const newManifest = await descriptor("2026-07-29T00:00:00.000Z");
    const newEntries = await entries([["docs/new.md", SHA.added, "text"]]);
    const newEntry = newEntries[0];
    if (newEntry === undefined) {
      throw new Error("The delta collision fixture requires one entry.");
    }
    await beginGitHubTreeManifest(fixture.d1, newManifest);
    await persistGitHubTreeManifestEntries(fixture.d1, newManifest, newEntries);
    await completeGitHubTreeManifest(fixture.d1, newManifest, newEntries, NOW);
    const pending = await prepareCandidateActivation(
      fixture.d1,
      newManifest,
      expectedHead,
      []
    );
    const deltaId =
      `github-tree-delta:added:${newManifest.manifestId}:` +
      newEntry.pathDigest;
    fixture.database
      .prepare(
        `INSERT INTO github_tree_manifest_deltas
         (delta_id, project_id, repository_id, ref, old_manifest_id,
          new_manifest_id, path_digest, safe_path, change_kind, old_blob_sha,
          new_blob_sha, old_disposition, new_disposition,
          affected_memory_ids_json, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'docs/new.md', 'added', NULL,
                 ?, NULL, 'text', '[]', 'conflicting-idempotency-key', ?)`
      )
      .run(
        deltaId,
        PROJECT_ID,
        REPOSITORY_ID,
        REF,
        oldManifest.manifestId,
        newManifest.manifestId,
        newEntry.pathDigest,
        newEntry.blobSha,
        NOW
      );

    await expect(
      activate(
        fixture.d1,
        newManifest,
        expectedHead,
        pending.candidateStatements,
        expectedHead?.observedSha ?? null,
        pending.activationClaim
      )
    ).rejects.toThrow(/manifest deltas are immutable/iu);
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM github_tree_activation_receipts
              WHERE manifest_id = ?) AS receipts,
             (SELECT manifest_id FROM github_tree_ref_heads
              WHERE project_id = ? AND repository_id = ? AND ref = ?) AS head`
        )
        .get(
          newManifest.manifestId,
          PROJECT_ID,
          REPOSITORY_ID,
          REF
        )
    ).toEqual({ receipts: 0, head: oldManifest.manifestId });
  });

  it("keeps evidence provenance isolated when refs share the same Git object", async () => {
    const fixture = createFixture();
    const trackedRef = "refs/heads/feature";
    fixture.database
      .prepare(
        `UPDATE repositories SET tracked_refs_json = ?, updated_at = ?
         WHERE project_id = ? AND repository_id = ?`
      )
      .run(JSON.stringify([trackedRef]), NOW, PROJECT_ID, REPOSITORY_ID);
    const manifestEntries = await entries([
      ["docs/context.md", SHA.keep, "text"]
    ]);
    const defaultManifest = await descriptor("2026-07-28T00:00:00.000Z");
    const sharedInput = {
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      observedSha: SHA.commit,
      path: "docs/context.md",
      blobSha: SHA.keep,
      content: "Durable project context."
    } as const;
    const defaultCandidate = await buildGitHubBlobCandidate({
      ...sharedInput,
      ref: REF
    });
    await storeAndActivate(
      fixture.d1,
      defaultManifest,
      manifestEntries,
      null,
      [defaultCandidate]
    );

    fixture.database
      .prepare(
        `INSERT INTO sync_cursors
         (project_id, repository_id, ref, observed_sha, status, updated_at)
         VALUES (?, ?, ?, ?, 'complete', ?)`
      )
      .run(PROJECT_ID, REPOSITORY_ID, trackedRef, SHA.commit, NOW);
    const trackedManifest = await buildGitHubTreeManifestDescriptor({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      ref: trackedRef,
      observedSha: SHA.commit,
      treeSha: SHA.tree,
      repositoryAuthority: "tracked_ref",
      collectionKey: "2026-07-28T06:00:00.000Z",
      createdAt: "2026-07-28T06:00:00.000Z"
    });
    await beginGitHubTreeManifest(fixture.d1, trackedManifest);
    await persistGitHubTreeManifestEntries(
      fixture.d1,
      trackedManifest,
      manifestEntries
    );
    await completeGitHubTreeManifest(
      fixture.d1,
      trackedManifest,
      manifestEntries,
      NOW
    );
    const trackedCandidate = await buildGitHubBlobCandidate({
      ...sharedInput,
      ref: trackedRef
    });
    const trackedActivation = await prepareCandidateActivation(
      fixture.d1,
      trackedManifest,
      null,
      [trackedCandidate],
      SHA.commit
    );
    await activate(
      fixture.d1,
      trackedManifest,
      null,
      trackedActivation.candidateStatements,
      SHA.commit,
      trackedActivation.activationClaim
    );

    expect(trackedCandidate.evidenceId).not.toBe(defaultCandidate.evidenceId);
    expect(trackedCandidate.locator).not.toBe(defaultCandidate.locator);

    const linkedProvenance = fixture.database
      .prepare(
        `SELECT observation.observation_id, evidence.evidence_id,
                evidence.repository_ref, evidence.repository_authority
         FROM observations AS observation
         JOIN observation_evidence AS link
           ON link.project_id = observation.project_id
          AND link.observation_id = observation.observation_id
         JOIN evidence
           ON evidence.project_id = link.project_id
          AND evidence.evidence_id = link.evidence_id
         WHERE observation.project_id = ? AND evidence.source_type = 'github_blob'
         ORDER BY evidence.repository_ref`
      )
      .all(PROJECT_ID);
    expect(linkedProvenance).toEqual([
      {
        observation_id: trackedCandidate.observation?.observationId,
        evidence_id: trackedCandidate.evidenceId,
        repository_ref: trackedRef,
        repository_authority: "tracked_ref"
      },
      {
        observation_id: defaultCandidate.observation?.observationId,
        evidence_id: defaultCandidate.evidenceId,
        repository_ref: REF,
        repository_authority: "default_branch"
      }
    ]);
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM evidence
              WHERE project_id = ? AND source_type = 'github_blob') AS evidence,
             (SELECT COUNT(*) FROM observations WHERE project_id = ?) AS observations,
             (SELECT COUNT(*) FROM observation_evidence WHERE project_id = ?) AS links,
             (SELECT COUNT(*) FROM outbox_events
              WHERE project_id = ? AND event_type = 'candidate.submitted') AS outbox`
        )
        .get(PROJECT_ID, PROJECT_ID, PROJECT_ID, PROJECT_ID)
    ).toEqual({ evidence: 2, observations: 2, links: 2, outbox: 2 });
  });

  it("keeps bodyless tombstones isolated across default and tracked refs", async () => {
    const fixture = createFixture();
    const trackedRef = "refs/heads/release";
    fixture.database
      .prepare(
        `UPDATE repositories SET tracked_refs_json = ?, updated_at = ?
         WHERE project_id = ? AND repository_id = ?`
      )
      .run(JSON.stringify([trackedRef]), NOW, PROJECT_ID, REPOSITORY_ID);
    const defaultManifest = await descriptor("2026-07-28T00:00:00.000Z");
    fixture.database
      .prepare(
        `INSERT INTO sync_cursors
         (project_id, repository_id, ref, observed_sha, status, updated_at)
         VALUES (?, ?, ?, ?, 'complete', ?)`
      )
      .run(PROJECT_ID, REPOSITORY_ID, trackedRef, SHA.commit, NOW);
    const trackedManifest = await buildGitHubTreeManifestDescriptor({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      ref: trackedRef,
      observedSha: SHA.commit,
      treeSha: SHA.tree,
      repositoryAuthority: "tracked_ref",
      collectionKey: "2026-07-28T06:00:00.000Z",
      createdAt: "2026-07-28T06:00:00.000Z"
    });
    await beginGitHubTreeManifest(fixture.d1, trackedManifest);
    await persistGitHubTreeManifestEntries(fixture.d1, trackedManifest, []);
    await completeGitHubTreeManifest(fixture.d1, trackedManifest, [], NOW);
    const sharedInput = {
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      observedSha: SHA.commit,
      path: ".env.production",
      blobSha: SHA.sensitive,
      content: "SYNTHETIC_SECRET=value"
    } as const;
    const candidates = [
      [defaultManifest, await buildGitHubBlobCandidate({ ...sharedInput, ref: REF })],
      [trackedManifest, await buildGitHubBlobCandidate({ ...sharedInput, ref: trackedRef })]
    ] as const;
    await storeAndActivate(
      fixture.d1,
      defaultManifest,
      [],
      null,
      [candidates[0][1]]
    );
    const trackedActivation = await prepareCandidateActivation(
      fixture.d1,
      trackedManifest,
      null,
      [candidates[1][1]],
      SHA.commit
    );
    await activate(
      fixture.d1,
      trackedManifest,
      null,
      trackedActivation.candidateStatements,
      SHA.commit,
      trackedActivation.activationClaim
    );
    for (const [manifest, candidate] of candidates) {
      expect(candidate.sensitivityStatus).toBe("tombstone");
      expect(candidate.repositoryPath).toBeNull();
      expect(candidate.observation).toBeUndefined();
      expect(manifest.manifestId).toHaveLength(64);
    }

    expect(candidates[0][1].evidenceId).not.toBe(candidates[1][1].evidenceId);
    expect(candidates[0][1].locator).not.toBe(candidates[1][1].locator);
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM evidence
              WHERE project_id = ? AND source_type = 'github_blob'
                AND sensitivity_status = 'tombstone') AS evidence,
             (SELECT COUNT(*) FROM observations WHERE project_id = ?) AS observations,
             (SELECT COUNT(*) FROM outbox_events
              WHERE project_id = ? AND event_type = 'candidate.submitted') AS outbox`
        )
        .get(PROJECT_ID, PROJECT_ID, PROJECT_ID)
    ).toEqual({ evidence: 2, observations: 0, outbox: 0 });
  });

  it.each([
    ["repository ref", { repositoryRef: "refs/heads/attacker" }],
    ["repository authority", { repositoryAuthority: "tracked_ref" as const }]
  ])("fails closed when immutable evidence drifts only in %s", async (_label, drift) => {
    const fixture = createFixture();
    const activeManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await beginGitHubTreeManifest(fixture.d1, activeManifest);
    await persistGitHubTreeManifestEntries(fixture.d1, activeManifest, []);
    await completeGitHubTreeManifest(fixture.d1, activeManifest, [], NOW);
    const candidate = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path: "docs/context.md",
      blobSha: SHA.keep,
      content: "Durable project context."
    });
    const pending = await prepareCandidateActivation(
      fixture.d1,
      activeManifest,
      null,
      [candidate]
    );
    fixture.database
      .prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, repository_id,
          repository_ref, repository_path, repository_authority, commit_sha,
          excerpt_hash, sensitivity_status, recorded_at)
         VALUES (?, ?, 'github_blob', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        candidate.evidenceId,
        PROJECT_ID,
        candidate.locator,
        candidate.repositoryId,
        "repositoryRef" in drift ? drift.repositoryRef : candidate.repositoryRef,
        candidate.repositoryPath,
        "repositoryAuthority" in drift
          ? drift.repositoryAuthority
          : candidate.repositoryAuthority,
        SHA.commit,
        candidate.excerptHash,
        candidate.sensitivityStatus,
        NOW
      );

    await expect(
      activate(
        fixture.d1,
        activeManifest,
        null,
        pending.candidateStatements,
        null,
        pending.activationClaim
      )
    ).rejects.toThrow(/constraint|activation conflict/iu);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM observations WHERE project_id = ?")
        .get(PROJECT_ID)
    ).toEqual({ count: 0 });
  });

  it("fails closed when a stored evidence tuple has a different immutable identity", async () => {
    const fixture = createFixture();
    const activeManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await beginGitHubTreeManifest(fixture.d1, activeManifest);
    await persistGitHubTreeManifestEntries(fixture.d1, activeManifest, []);
    await completeGitHubTreeManifest(fixture.d1, activeManifest, [], NOW);
    const candidate = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path: "docs/context.md",
      blobSha: SHA.keep,
      content: "Durable project context."
    });
    const pending = await prepareCandidateActivation(
      fixture.d1,
      activeManifest,
      null,
      [candidate]
    );
    fixture.database
      .prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, repository_id,
          repository_ref, repository_path, repository_authority, commit_sha,
          excerpt_hash, sensitivity_status, recorded_at)
         VALUES ('preexisting-evidence', ?, 'github_blob', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        PROJECT_ID,
        candidate.locator,
        candidate.repositoryId,
        candidate.repositoryRef,
        candidate.repositoryPath,
        candidate.repositoryAuthority,
        SHA.commit,
        candidate.excerptHash,
        candidate.sensitivityStatus,
        NOW
      );

    await expect(
      activate(
        fixture.d1,
        activeManifest,
        null,
        pending.candidateStatements,
        null,
        pending.activationClaim
      )
    ).rejects.toThrow(/constraint|activation conflict/iu);
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM observations WHERE project_id = ?) AS observations,
             (SELECT COUNT(*) FROM observation_evidence WHERE project_id = ?) AS links,
             (SELECT COUNT(*) FROM outbox_events
              WHERE project_id = ? AND event_type = 'candidate.submitted') AS outbox`
        )
        .get(PROJECT_ID, PROJECT_ID, PROJECT_ID)
    ).toEqual({ observations: 0, links: 0, outbox: 0 });
  });

  it("detects deletion during an unchanged-SHA reconciliation and queues bodyless review", async () => {
    const fixture = createFixture();
    const oldEntries = await entries([
      ["docs/keep.md", SHA.keep, "text"],
      ["docs/changed.md", SHA.changedOld, "text"],
      ["docs/deleted.md", SHA.deleted, "text"],
      [".env.production", SHA.sensitive, "sensitive_tombstone"]
    ]);
    const oldManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(fixture.d1, oldManifest, oldEntries, null);
    seedAffectedMemory(fixture.database, oldEntries[2] as GitHubTreeManifestEntry);

    const newEntries = await entries([
      ["docs/keep.md", SHA.keep, "text"],
      ["docs/changed.md", SHA.changedNew, "text"],
      ["docs/added.md", SHA.added, "text"]
    ]);
    const newManifest = await descriptor("2026-07-29T00:00:00.000Z");
    const expectedHead = await readActiveGitHubTreeHead(
      fixture.d1,
      PROJECT_ID,
      REPOSITORY_ID,
      REF
    );
    const committed = await storeAndActivate(
      fixture.d1,
      newManifest,
      newEntries,
      expectedHead
    );

    expect(
      fixture.database
        .prepare(
          `SELECT change_kind, COUNT(*) AS count
           FROM github_tree_manifest_deltas
           WHERE project_id = ? AND new_manifest_id = ?
           GROUP BY change_kind ORDER BY change_kind`
        )
        .all(PROJECT_ID, newManifest.manifestId)
    ).toEqual([
      { change_kind: "added", count: 1 },
      { change_kind: "changed", count: 1 },
      { change_kind: "deleted", count: 2 }
    ]);
    const observations = fixture.database
      .prepare(
        `SELECT content, status, scope, scope_id, analysis_json
         FROM observations
         WHERE project_id = ? AND status = 'pending_review'
         ORDER BY observation_id`
      )
      .all(PROJECT_ID) as Array<{
      content: string | null;
      status: string;
      scope: string;
      scope_id: string;
      analysis_json: string;
    }>;
    expect(observations).toHaveLength(2);
    expect(observations.every((row) => row.content === null)).toBe(true);
    expect(observations.every((row) => row.scope === "repository")).toBe(true);
    expect(observations.every((row) => row.scope_id === REPOSITORY_ID)).toBe(true);
    const analyses = observations.map((row) => JSON.parse(row.analysis_json));
    expect(
      analyses.find((analysis) => analysis.safe_path === "docs/deleted.md")
        ?.affected_memory_ids
    ).toEqual(["memory-affected"]);
    const sensitive = analyses.find((analysis) => analysis.safe_path === null);
    expect(sensitive).toMatchObject({
      path_digest: oldEntries[3]?.pathDigest,
      affected_memory_ids: []
    });
    const serializedSensitiveRows = JSON.stringify(
      fixture.database
        .prepare(
          `SELECT locator, repository_path FROM evidence
           WHERE project_id = ? AND source_type = 'repository_path_absent'
             AND repository_path IS NULL`
        )
        .all(PROJECT_ID)
    );
    expect(serializedSensitiveRows).not.toContain(".env.production");
    expect(serializedSensitiveRows).toContain(oldEntries[3]?.pathDigest);
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM review_requests
           WHERE project_id = ? AND status = 'pending'`
        )
        .get(PROJECT_ID)
    ).toEqual({ count: 2 });
    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({
      manifestId: newManifest.manifestId,
      observedSha: SHA.commit,
      headVersion: 2
    });

    await activate(
      fixture.d1,
      newManifest,
      expectedHead,
      committed.candidateStatements,
      expectedHead?.observedSha ?? null,
      committed.activationClaim
    );
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM github_tree_manifest_deltas
              WHERE project_id = ? AND new_manifest_id = ?) AS deltas,
             (SELECT COUNT(*) FROM observations
              WHERE project_id = ? AND status = 'pending_review') AS observations,
             (SELECT COUNT(*) FROM review_requests
              WHERE project_id = ? AND status = 'pending') AS reviews`
        )
        .get(
          PROJECT_ID,
          newManifest.manifestId,
          PROJECT_ID,
          PROJECT_ID
        )
    ).toEqual({ deltas: 4, observations: 2, reviews: 2 });
  });

  it.each([
    ["sensitive", "sensitive_tombstone"],
    ["binary", "binary_excluded"],
    ["generated", "generated_excluded"]
  ] as const)(
    "withdraws an affected text source reclassified as %s without leaking its body or path",
    async (_label, newDisposition) => {
      const fixture = createFixture();
      const sourcePath = `private/${newDisposition}-source.fixture`;
      const oldEntries = await entries([[sourcePath, SHA.keep, "text"]]);
      const oldEntry = oldEntries[0] as GitHubTreeManifestEntry;
      const oldManifest = await descriptor("2026-07-27T00:00:00.000Z");
      await storeAndActivate(fixture.d1, oldManifest, oldEntries, null);
      seedAffectedMemory(fixture.database, oldEntry);
      const oldEvidenceBefore = fixture.database
        .prepare(`SELECT * FROM evidence WHERE evidence_id = 'evidence-a'`)
        .get();

      const newEntries = await entries([
        [sourcePath, SHA.keep, newDisposition]
      ]);
      const newManifest = await descriptor("2026-07-28T00:00:00.000Z");
      const expectedHead = await readActiveGitHubTreeHead(
        fixture.d1,
        PROJECT_ID,
        REPOSITORY_ID,
        REF
      );
      const committed = await storeAndActivate(
        fixture.d1,
        newManifest,
        newEntries,
        expectedHead
      );

      const delta = fixture.database
        .prepare(
          `SELECT change_kind, safe_path, old_blob_sha, new_blob_sha,
                  old_disposition, new_disposition, affected_memory_ids_json
           FROM github_tree_manifest_deltas
           WHERE project_id = ? AND new_manifest_id = ?`
        )
        .get(PROJECT_ID, newManifest.manifestId) as {
        change_kind: string;
        safe_path: string | null;
        old_blob_sha: string;
        new_blob_sha: string;
        old_disposition: string;
        new_disposition: string;
        affected_memory_ids_json: string;
      };
      expect(delta).toMatchObject({
        change_kind: "withdrawn",
        safe_path: null,
        old_blob_sha: SHA.keep,
        new_blob_sha: SHA.keep,
        old_disposition: "text",
        new_disposition: newDisposition
      });
      expect(JSON.parse(delta.affected_memory_ids_json)).toEqual([
        "memory-affected"
      ]);

      const withdrawalEvidence = fixture.database
        .prepare(
          `SELECT evidence_id, source_type, locator, repository_path,
                  sensitivity_status, commit_sha, excerpt_hash
           FROM evidence
           WHERE project_id = ? AND source_type = 'repository_source_withdrawn'`
        )
        .get(PROJECT_ID) as Record<string, unknown>;
      expect(withdrawalEvidence).toMatchObject({
        evidence_id:
          `github-source-withdrawn-evidence:${oldManifest.manifestId}:` +
          `${newManifest.manifestId}:${oldEntry.pathDigest}`,
        source_type: "repository_source_withdrawn",
        repository_path: null,
        sensitivity_status: "tombstone",
        commit_sha: SHA.commit,
        excerpt_hash: oldEntry.pathDigest
      });
      expect(String(withdrawalEvidence.locator)).toContain(
        `/manifest-sha256/${newManifest.manifestId}/source-withdrawn/` +
          `path-sha256/${oldEntry.pathDigest}`
      );

      const observation = fixture.database
        .prepare(
          `SELECT observation_id, content, content_sha256, status, analysis_json,
                  evidence_json
           FROM observations
           WHERE project_id = ?
             AND json_extract(analysis_json, '$.schema') =
               'github.repository_source_withdrawn'`
        )
        .get(PROJECT_ID) as {
        observation_id: string;
        content: string | null;
        content_sha256: string | null;
        status: string;
        analysis_json: string;
        evidence_json: string;
      };
      expect(observation).toMatchObject({
        content: null,
        content_sha256: null,
        status: "pending_review"
      });
      const analysis = JSON.parse(observation.analysis_json) as Record<
        string,
        unknown
      >;
      expect(analysis).toMatchObject({
        schema: "github.repository_source_withdrawn",
        repository_id: REPOSITORY_ID,
        repository_ref: REF,
        old_manifest_id: oldManifest.manifestId,
        new_manifest_id: newManifest.manifestId,
        path_digest: oldEntry.pathDigest,
        old_blob_sha: SHA.keep,
        new_blob_sha: SHA.keep,
        old_disposition: "text",
        new_disposition: newDisposition,
        affected_memory_ids: ["memory-affected"],
        suggested_operation: "invalidate"
      });
      expect(analysis).not.toHaveProperty("safe_path");
      expect(analysis).not.toHaveProperty("content");
      expect(
        fixture.database
          .prepare(
            `SELECT status FROM memories
             WHERE project_id = ? AND memory_id = 'memory-affected'`
          )
          .get(PROJECT_ID)
      ).toEqual({ status: "active" });
      expect(
        fixture.database
          .prepare(
            `SELECT status, required_role FROM review_requests
             WHERE project_id = ? AND candidate_id = ?`
          )
          .get(PROJECT_ID, observation.observation_id)
      ).toEqual({ status: "pending", required_role: "maintainer" });

      const withdrawalArtifacts = JSON.stringify({
        delta,
        withdrawalEvidence,
        observation,
        review: fixture.database
          .prepare(
            `SELECT * FROM review_requests
             WHERE project_id = ? AND candidate_id = ?`
          )
          .get(PROJECT_ID, observation.observation_id)
      });
      expect(withdrawalArtifacts).not.toContain(sourcePath);
      expect(withdrawalArtifacts).not.toContain("The deleted path exists.");
      expect(
        fixture.database
          .prepare(`SELECT * FROM evidence WHERE evidence_id = 'evidence-a'`)
          .get()
      ).toEqual(oldEvidenceBefore);

      const syncPayloadRows = fixture.database
        .prepare(
          `SELECT payload_json FROM outbox_events
           WHERE project_id = ? AND event_type = 'github.sync.requested'
           ORDER BY event_id`
        )
        .all(PROJECT_ID) as Array<{ payload_json: string }>;
      const syncPayloads = syncPayloadRows.map(
        (row) => JSON.parse(row.payload_json) as { manifestId: string }
      );
      expect(syncPayloads).toHaveLength(2);
      expect(new Set(syncPayloads.map((payload) => payload.manifestId))).toEqual(
        new Set([oldManifest.manifestId, newManifest.manifestId])
      );

      const countsBeforeReplay = fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM github_tree_manifest_deltas) AS deltas,
             (SELECT COUNT(*) FROM evidence
              WHERE source_type = 'repository_source_withdrawn') AS evidence,
             (SELECT COUNT(*) FROM observations
              WHERE json_extract(analysis_json, '$.schema') =
                'github.repository_source_withdrawn') AS observations,
             (SELECT COUNT(*) FROM review_requests) AS reviews,
             (SELECT COUNT(*) FROM outbox_events
              WHERE event_type = 'github.sync.requested') AS outbox`
        )
        .get();
      await activate(
        fixture.d1,
        newManifest,
        expectedHead,
        committed.candidateStatements,
        expectedHead?.observedSha ?? null,
        committed.activationClaim
      );
      expect(
        fixture.database
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM github_tree_manifest_deltas) AS deltas,
               (SELECT COUNT(*) FROM evidence
                WHERE source_type = 'repository_source_withdrawn') AS evidence,
               (SELECT COUNT(*) FROM observations
                WHERE json_extract(analysis_json, '$.schema') =
                  'github.repository_source_withdrawn') AS observations,
               (SELECT COUNT(*) FROM review_requests) AS reviews,
               (SELECT COUNT(*) FROM outbox_events
                WHERE event_type = 'github.sync.requested') AS outbox`
          )
          .get()
      ).toEqual(countsBeforeReplay);
    }
  );

  it("records a bodyless withdrawal tombstone without opening an empty review", async () => {
    const fixture = createFixture();
    const sourcePath = "private/unreferenced-source.fixture";
    const oldEntries = await entries([[sourcePath, SHA.keep, "text"]]);
    const oldManifest = await descriptor("2026-07-27T00:00:00.000Z");
    await storeAndActivate(fixture.d1, oldManifest, oldEntries, null);
    const newEntries = await entries([
      [sourcePath, SHA.keep, "sensitive_tombstone"]
    ]);
    const newManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      newManifest,
      newEntries,
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    );

    expect(
      fixture.database
        .prepare(
          `SELECT change_kind, safe_path, affected_memory_ids_json
           FROM github_tree_manifest_deltas
           WHERE project_id = ? AND new_manifest_id = ?`
        )
        .get(PROJECT_ID, newManifest.manifestId)
    ).toEqual({
      change_kind: "withdrawn",
      safe_path: null,
      affected_memory_ids_json: "[]"
    });
    const artifact = fixture.database
      .prepare(
        `SELECT locator, repository_path, sensitivity_status
         FROM evidence
         WHERE project_id = ? AND source_type = 'repository_source_withdrawn'`
      )
      .get(PROJECT_ID);
    expect(artifact).toMatchObject({
      repository_path: null,
      sensitivity_status: "tombstone"
    });
    expect(JSON.stringify(artifact)).not.toContain(sourcePath);
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM observations
              WHERE json_extract(analysis_json, '$.schema') =
                'github.repository_source_withdrawn') AS observations,
             (SELECT COUNT(*) FROM review_requests) AS reviews`
        )
        .get()
    ).toEqual({ observations: 0, reviews: 0 });
  });

  it("classifies a same-SHA non-text disposition change without a withdrawal review", async () => {
    const fixture = createFixture();
    const path = "assets/generated.bin";
    const oldManifest = await descriptor("2026-07-27T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      oldManifest,
      await entries([[path, SHA.keep, "binary_excluded"]]),
      null
    );
    const newManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      newManifest,
      await entries([[path, SHA.keep, "generated_excluded"]]),
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    );

    expect(
      fixture.database
        .prepare(
          `SELECT change_kind, old_blob_sha, new_blob_sha,
                  old_disposition, new_disposition
           FROM github_tree_manifest_deltas
           WHERE project_id = ? AND new_manifest_id = ?`
        )
        .get(PROJECT_ID, newManifest.manifestId)
    ).toEqual({
      change_kind: "changed",
      old_blob_sha: SHA.keep,
      new_blob_sha: SHA.keep,
      old_disposition: "binary_excluded",
      new_disposition: "generated_excluded"
    });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM evidence
           WHERE source_type = 'repository_source_withdrawn'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it("isolates deletion evidence when tracked refs converge on the same commit", async () => {
    const fixture = createFixture();
    const trackedRefs = ["refs/heads/feature-a", "refs/heads/feature-b"] as const;
    fixture.database
      .prepare(
        `UPDATE repositories SET tracked_refs_json = ?, updated_at = ?
         WHERE project_id = ? AND repository_id = ?`
      )
      .run(JSON.stringify(trackedRefs), NOW, PROJECT_ID, REPOSITORY_ID);
    const deletedPath = "private/shared-secret.env";
    const oldObservedSha = "6".repeat(40);
    const oldTreeSha = "7".repeat(40);
    const deletedEntries = await entries([
      [deletedPath, SHA.sensitive, "sensitive_tombstone"]
    ]);
    const deletedEntry = deletedEntries[0];
    if (deletedEntry === undefined) {
      throw new Error("The deletion fixture requires one manifest entry");
    }

    for (const [index, ref] of trackedRefs.entries()) {
      fixture.database
        .prepare(
          `INSERT INTO sync_cursors
           (project_id, repository_id, ref, observed_sha, status, updated_at)
           VALUES (?, ?, ?, ?, 'complete', ?)`
        )
        .run(PROJECT_ID, REPOSITORY_ID, ref, oldObservedSha, NOW);
      const oldManifest = await buildGitHubTreeManifestDescriptor({
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        ref,
        observedSha: oldObservedSha,
        treeSha: oldTreeSha,
        repositoryAuthority: "tracked_ref",
        collectionKey: `2026-07-27T0${index}:00:00.000Z`,
        createdAt: `2026-07-27T0${index}:00:00.000Z`
      });
      await beginGitHubTreeManifest(fixture.d1, oldManifest);
      await persistGitHubTreeManifestEntries(
        fixture.d1,
        oldManifest,
        deletedEntries
      );
      await completeGitHubTreeManifest(
        fixture.d1,
        oldManifest,
        deletedEntries,
        NOW
      );
      await activate(fixture.d1, oldManifest, null, [], oldObservedSha);

      const newManifest = await buildGitHubTreeManifestDescriptor({
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        ref,
        observedSha: SHA.commit,
        treeSha: SHA.tree,
        repositoryAuthority: "tracked_ref",
        collectionKey: `2026-07-29T0${index}:00:00.000Z`,
        createdAt: `2026-07-29T0${index}:00:00.000Z`
      });
      const expectedHead = await readActiveGitHubTreeHead(
        fixture.d1,
        PROJECT_ID,
        REPOSITORY_ID,
        ref
      );
      await storeAndActivate(fixture.d1, newManifest, [], expectedHead);
    }

    const evidence = fixture.database
      .prepare(
        `SELECT locator, repository_ref, repository_path, sensitivity_status
         FROM evidence
         WHERE project_id = ? AND source_type = 'repository_path_absent'
         ORDER BY repository_ref`
      )
      .all(PROJECT_ID) as Array<{
      locator: string;
      repository_ref: string;
      repository_path: string | null;
      sensitivity_status: string;
    }>;
    expect(evidence).toHaveLength(2);
    expect(evidence.map((row) => row.repository_ref)).toEqual(trackedRefs);
    expect(new Set(evidence.map((row) => row.locator)).size).toBe(2);
    for (const [index, row] of evidence.entries()) {
      const ref = trackedRefs[index];
      if (ref === undefined) {
        throw new Error("Every deletion evidence row must map to a tracked ref");
      }
      const refDigest = await sha256(["github.ref", ref].join("\n"));
      expect(row.locator).toBe(
        `github://42/${SHA.commit}/ref-sha256/${refDigest}/` +
          `path-sha256/${deletedEntry.pathDigest}`
      );
      expect(row.repository_path).toBeNull();
      expect(row.sensitivity_status).toBe("tombstone");
    }
    const serialized = JSON.stringify(
      fixture.database
        .prepare(
          `SELECT evidence.locator, evidence.repository_path, observation.content
           FROM evidence
           JOIN observation_evidence AS link
             ON link.project_id = evidence.project_id
            AND link.evidence_id = evidence.evidence_id
           JOIN observations AS observation
             ON observation.project_id = link.project_id
            AND observation.observation_id = link.observation_id
           WHERE evidence.project_id = ?
             AND evidence.source_type = 'repository_path_absent'`
        )
        .all(PROJECT_ID)
    );
    expect(serialized).not.toContain(deletedPath);
    expect(serialized).not.toContain(trackedRefs[0]);
    expect(serialized).not.toContain(trackedRefs[1]);
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM observations
              WHERE project_id = ? AND status = 'pending_review') AS observations,
             (SELECT COUNT(*) FROM observation_evidence
              WHERE project_id = ?) AS links,
             (SELECT COUNT(*) FROM review_requests
              WHERE project_id = ? AND status = 'pending') AS reviews`
        )
        .get(PROJECT_ID, PROJECT_ID, PROJECT_ID)
    ).toEqual({ observations: 2, links: 2, reviews: 2 });
  });

  it("retains affected-memory IDs when an earlier clear path later became sensitive", async () => {
    const fixture = createFixture();
    const path = "docs/private-note.md";
    const clearEntries = await entries([[path, SHA.changedOld, "text"]]);
    const clearManifest = await descriptor("2026-07-27T00:00:00.000Z");
    await storeAndActivate(fixture.d1, clearManifest, clearEntries, null);
    seedAffectedMemory(fixture.database, clearEntries[0] as GitHubTreeManifestEntry);

    const sensitiveEntries = await entries([
      [path, SHA.sensitive, "sensitive_tombstone"]
    ]);
    const sensitiveManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      sensitiveManifest,
      sensitiveEntries,
      await readActiveGitHubTreeHead(
        fixture.d1,
        PROJECT_ID,
        REPOSITORY_ID,
        REF
      )
    );

    const deletedManifest = await descriptor("2026-07-29T00:00:00.000Z");
    await storeAndActivate(
      fixture.d1,
      deletedManifest,
      [],
      await readActiveGitHubTreeHead(
        fixture.d1,
        PROJECT_ID,
        REPOSITORY_ID,
        REF
      )
    );

    const delta = fixture.database
      .prepare(
        `SELECT safe_path, affected_memory_ids_json
         FROM github_tree_manifest_deltas
         WHERE project_id = ? AND new_manifest_id = ? AND change_kind = 'deleted'`
      )
      .get(PROJECT_ID, deletedManifest.manifestId) as {
      safe_path: string | null;
      affected_memory_ids_json: string;
    };
    expect(delta.safe_path).toBeNull();
    expect(JSON.parse(delta.affected_memory_ids_json)).toEqual(["memory-affected"]);
  });

  it("keeps a partial staging manifest from advancing the active head or cursor", async () => {
    const fixture = createFixture();
    const oldManifest = await descriptor("2026-07-28T00:00:00.000Z");
    const oldEntries = await entries([["docs/keep.md", SHA.keep, "text"]]);
    await storeAndActivate(fixture.d1, oldManifest, oldEntries, null);
    const partialManifest = await descriptor("2026-07-29T00:00:00.000Z");
    const partialEntries = await entries([
      ["docs/keep.md", SHA.keep, "text"],
      ["docs/ambiguous.dat", SHA.added, "partial"]
    ]);
    await beginGitHubTreeManifest(fixture.d1, partialManifest);
    await persistGitHubTreeManifestEntries(
      fixture.d1,
      partialManifest,
      partialEntries
    );

    await expect(
      completeGitHubTreeManifest(
        fixture.d1,
        partialManifest,
        partialEntries,
        NOW
      )
    ).rejects.toMatchObject({ code: "GITHUB_PARTIAL_SYNC" });
    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({
      manifestId: oldManifest.manifestId,
      observedSha: SHA.commit,
      headVersion: 1
    });
    expect(
      fixture.database
        .prepare(
          `SELECT status FROM github_tree_manifests
           WHERE project_id = ? AND manifest_id = ?`
        )
        .get(PROJECT_ID, partialManifest.manifestId)
    ).toEqual({ status: "staging" });
    expect(
      fixture.database
        .prepare(
          `SELECT observed_sha FROM sync_cursors
           WHERE project_id = ? AND repository_id = ? AND ref = ?`
        )
        .get(PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({ observed_sha: SHA.commit });
  });

  it("rolls back deltas, review artifacts, head, and cursor when activation fails", async () => {
    const fixture = createFixture();
    const oldManifest = await descriptor("2026-07-28T00:00:00.000Z");
    const oldEntries = await entries([["docs/deleted.md", SHA.deleted, "text"]]);
    await storeAndActivate(fixture.d1, oldManifest, oldEntries, null);

    const newManifest = await descriptor("2026-07-29T00:00:00.000Z");
    const newEntries = await entries([
      ["docs/new-context.md", SHA.added, "text"]
    ]);
    await beginGitHubTreeManifest(fixture.d1, newManifest);
    await persistGitHubTreeManifestEntries(fixture.d1, newManifest, newEntries);
    await completeGitHubTreeManifest(fixture.d1, newManifest, newEntries, NOW);
    const expectedHead = await readActiveGitHubTreeHead(
      fixture.d1,
      PROJECT_ID,
      REPOSITORY_ID,
      REF
    );
    const candidate = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path: "docs/new-context.md",
      blobSha: SHA.added,
      content: "New durable context."
    });
    const activationClaim = await prepareActivationClaim(
      fixture.d1,
      newManifest,
      expectedHead?.observedSha ?? null
    );
    const candidateStatements = await prepareGitHubCandidateStatements({
      database: fixture.d1,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      repositoryRef: REF,
      externalRepositoryId: 42,
      manifestId: newManifest.manifestId,
      observedSha: SHA.commit,
      activationFence: buildActivationFence(
        newManifest,
        expectedHead,
        activationClaim
      ),
      candidates: [candidate]
    });
    fixture.database.exec(`
      CREATE TRIGGER synthetic_activation_failure
      BEFORE INSERT ON evidence
      WHEN NEW.source_type = 'github_blob'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic activation failure');
      END;
    `);

    await expect(
      activate(
        fixture.d1,
        newManifest,
        expectedHead,
        candidateStatements,
        expectedHead?.observedSha ?? null,
        activationClaim
      )
    ).rejects.toThrow("synthetic activation failure");
    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({
      manifestId: oldManifest.manifestId,
      observedSha: SHA.commit,
      headVersion: 1
    });
    expect(
      fixture.database
        .prepare(
          `SELECT observed_sha FROM sync_cursors
           WHERE project_id = ? AND repository_id = ? AND ref = ?`
        )
        .get(PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({ observed_sha: SHA.commit });
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM github_tree_manifest_deltas
              WHERE project_id = ? AND new_manifest_id = ?) AS deltas,
             (SELECT COUNT(*) FROM evidence
              WHERE project_id = ? AND source_type = 'repository_path_absent') AS evidence,
             (SELECT COUNT(*) FROM review_requests
              WHERE project_id = ?) AS reviews`
        )
        .get(
          PROJECT_ID,
          newManifest.manifestId,
          PROJECT_ID,
          PROJECT_ID
        )
    ).toEqual({ deltas: 0, evidence: 0, reviews: 0 });
  });

  it("does not publish candidates when the expected manifest head is stale", async () => {
    const fixture = createFixture();
    const oldManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(fixture.d1, oldManifest, [], null);
    const newManifest = await descriptor("2026-07-29T00:00:00.000Z");
    const newEntries = await entries([["docs/new.md", SHA.added, "text"]]);
    await beginGitHubTreeManifest(fixture.d1, newManifest);
    await persistGitHubTreeManifestEntries(fixture.d1, newManifest, newEntries);
    await completeGitHubTreeManifest(fixture.d1, newManifest, newEntries, NOW);
    const candidate = await buildGitHubBlobCandidate({
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      externalRepositoryId: 42,
      defaultBranch: "main",
      ref: REF,
      observedSha: SHA.commit,
      path: "docs/new.md",
      blobSha: SHA.added,
      content: "New durable context."
    });
    const staleExpectedHead = {
      manifestId: "4".repeat(64),
      observedSha: SHA.commit,
      headVersion: 1
    };
    const activationClaim = await prepareActivationClaim(
      fixture.d1,
      newManifest,
      SHA.commit
    );
    const candidateStatements = await prepareGitHubCandidateStatements({
      database: fixture.d1,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      repositoryRef: REF,
      externalRepositoryId: 42,
      manifestId: newManifest.manifestId,
      observedSha: SHA.commit,
      activationFence: buildActivationFence(
        newManifest,
        staleExpectedHead,
        activationClaim
      ),
      candidates: [candidate]
    });

    await expect(
      activate(
        fixture.d1,
        newManifest,
        staleExpectedHead,
        candidateStatements,
        SHA.commit,
        activationClaim
      )
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({
      manifestId: oldManifest.manifestId,
      observedSha: SHA.commit,
      headVersion: 1
    });
    expect(
      fixture.database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM evidence
              WHERE project_id = ? AND source_type = 'github_blob') AS evidence,
             (SELECT COUNT(*) FROM observations WHERE project_id = ?) AS observations`
        )
        .get(PROJECT_ID, PROJECT_ID)
    ).toEqual({ evidence: 0, observations: 0 });
  });

  it("does not advance the head when its cursor has drifted from the expected SHA", async () => {
    const fixture = createFixture();
    const oldManifest = await descriptor("2026-07-28T00:00:00.000Z");
    const oldEntries = await entries([["docs/old.md", SHA.keep, "text"]]);
    await storeAndActivate(fixture.d1, oldManifest, oldEntries, null);
    const expectedHead = await readActiveGitHubTreeHead(
      fixture.d1,
      PROJECT_ID,
      REPOSITORY_ID,
      REF
    );
    const driftedSha = "9".repeat(40);
    fixture.database
      .prepare(
        `UPDATE sync_cursors SET observed_sha = ?
         WHERE project_id = ? AND repository_id = ? AND ref = ?`
      )
      .run(driftedSha, PROJECT_ID, REPOSITORY_ID, REF);
    const newManifest = await descriptor("2026-07-29T00:00:00.000Z");
    const newEntries = await entries([["docs/new.md", SHA.added, "text"]]);
    await beginGitHubTreeManifest(fixture.d1, newManifest);
    await persistGitHubTreeManifestEntries(fixture.d1, newManifest, newEntries);
    await completeGitHubTreeManifest(fixture.d1, newManifest, newEntries, NOW);

    await expect(
      activate(fixture.d1, newManifest, expectedHead)
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({
      manifestId: oldManifest.manifestId,
      observedSha: SHA.commit,
      headVersion: 1
    });
    expect(
      fixture.database
        .prepare(
          `SELECT observed_sha FROM sync_cursors
           WHERE project_id = ? AND repository_id = ? AND ref = ?`
        )
        .get(PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({ observed_sha: driftedSha });
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM github_tree_manifest_deltas
           WHERE project_id = ? AND new_manifest_id = ?`
        )
        .get(PROJECT_ID, newManifest.manifestId)
    ).toEqual({ count: 0 });
  });

  it("bootstraps a manifest head from a matching legacy cursor", async () => {
    const fixture = createFixture();
    const legacySha = "8".repeat(40);
    fixture.database
      .prepare(
        `UPDATE sync_cursors
         SET observed_sha = ?, status = 'complete', updated_at = ?
         WHERE project_id = ? AND repository_id = ? AND ref = ?`
      )
      .run(legacySha, NOW, PROJECT_ID, REPOSITORY_ID, REF);
    const manifest = await descriptor("2026-07-29T00:00:00.000Z");
    const manifestEntries = await entries([["docs/current.md", SHA.keep, "text"]]);
    await beginGitHubTreeManifest(fixture.d1, manifest);
    await persistGitHubTreeManifestEntries(fixture.d1, manifest, manifestEntries);
    await completeGitHubTreeManifest(fixture.d1, manifest, manifestEntries, NOW);

    await activate(fixture.d1, manifest, null, [], legacySha);

    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({
      manifestId: manifest.manifestId,
      observedSha: SHA.commit,
      headVersion: 1
    });
    expect(
      fixture.database
        .prepare(
          `SELECT observed_sha FROM sync_cursors
           WHERE project_id = ? AND repository_id = ? AND ref = ?`
        )
        .get(PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({ observed_sha: SHA.commit });
  });

  it("keeps manifest and affected-memory reconciliation isolated by project", async () => {
    const fixture = createFixture();
    seedProjectRepository(fixture.database, "project-b", "repository-b", 84);
    const path = "docs/shared.md";
    const pathDigest = await sha256(path);
    const projectBManifest = await buildGitHubTreeManifestDescriptor({
      projectId: "project-b",
      repositoryId: "repository-b",
      ref: REF,
      observedSha: SHA.commit,
      treeSha: SHA.tree,
      repositoryAuthority: "default_branch",
      collectionKey: NOW,
      createdAt: NOW
    });
    const projectBEntries: GitHubTreeManifestEntry[] = [
      {
        pathDigest,
        safePath: path,
        blobSha: SHA.keep,
        byteSize: 12,
        disposition: "text"
      }
    ];
    await storeAndActivate(fixture.d1, projectBManifest, projectBEntries, null);

    expect(
      fixture.database
        .prepare(
          `SELECT project_id, repository_id FROM github_tree_ref_heads
           ORDER BY project_id`
        )
        .all()
    ).toEqual([{ project_id: "project-b", repository_id: "repository-b" }]);
    expect(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM github_tree_manifest_deltas
           WHERE project_id = ?`
        )
        .get(PROJECT_ID)
    ).toEqual({ count: 0 });
  });

  it("uses project-scoped path indexes for historical deletion reconciliation", () => {
    const fixture = createFixture();
    const manifestPlan = fixture.database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT manifest_id FROM github_tree_manifest_entries
         WHERE project_id = ? AND path_digest = ? AND safe_path = ?`
      )
      .all(PROJECT_ID, "7".repeat(64), "docs/example.md") as Array<{
      detail: string;
    }>;
    const evidencePlan = fixture.database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT evidence_id FROM evidence
         WHERE project_id = ? AND repository_id = ?
           AND repository_ref = ? AND repository_path = ?`
      )
      .all(PROJECT_ID, REPOSITORY_ID, REF, "docs/example.md") as Array<{
      detail: string;
    }>;

    expect(manifestPlan.some((row) => row.detail.includes("github_tree_manifest_entries_by_path"))).toBe(
      true
    );
    expect(evidencePlan.some((row) => row.detail.includes("evidence_by_repository_ref_path"))).toBe(
      true
    );
  });
});

async function descriptor(collectionKey: string): Promise<GitHubTreeManifestDescriptor> {
  return await buildGitHubTreeManifestDescriptor({
    projectId: PROJECT_ID,
    repositoryId: REPOSITORY_ID,
    ref: REF,
    observedSha: SHA.commit,
    treeSha: SHA.tree,
    repositoryAuthority: "default_branch",
    collectionKey,
    createdAt: collectionKey
  });
}

async function buildPolicyCandidatePair(path: string): Promise<{
  clear: PersistableGitHubCandidate;
  tombstone: PersistableGitHubCandidate;
}> {
  const clear = await buildGitHubBlobCandidate({
    projectId: PROJECT_ID,
    repositoryId: REPOSITORY_ID,
    externalRepositoryId: 42,
    defaultBranch: "main",
    ref: REF,
    observedSha: SHA.commit,
    path,
    blobSha: SHA.keep,
    content: "Durable project context."
  });
  const tombstone = await buildGitHubBlobCandidate({
    projectId: PROJECT_ID,
    repositoryId: REPOSITORY_ID,
    externalRepositoryId: 42,
    defaultBranch: "main",
    ref: REF,
    observedSha: SHA.commit,
    path,
    blobSha: SHA.keep,
    content: "api_key = 'synthetic-sensitive-value'"
  });
  if (
    clear.sensitivityStatus !== "clear" ||
    tombstone.sensitivityStatus !== "tombstone"
  ) {
    throw new Error("The policy candidate fixture has an unexpected disposition.");
  }
  return { clear, tombstone };
}

function readEvidence(
  database: DatabaseSync,
  evidenceId: string
): Record<string, unknown> | undefined {
  return database
    .prepare(
      `SELECT * FROM evidence WHERE project_id = ? AND evidence_id = ?`
    )
    .get(PROJECT_ID, evidenceId) as Record<string, unknown> | undefined;
}

async function entries(
  rows: ReadonlyArray<
    readonly [string, string, GitHubTreeManifestEntry["disposition"]]
  >
): Promise<GitHubTreeManifestEntry[]> {
  return await Promise.all(
    rows.map(async ([path, blobSha, disposition]) => ({
      pathDigest: await sha256(path),
      safePath: disposition === "sensitive_tombstone" ? null : path,
      blobSha,
      byteSize: 12,
      disposition
    }))
  );
}

async function storeAndActivate(
  database: D1Database,
  manifest: GitHubTreeManifestDescriptor,
  manifestEntries: readonly GitHubTreeManifestEntry[],
  expectedHead: Awaited<ReturnType<typeof readActiveGitHubTreeHead>>,
  candidates: readonly PersistableGitHubCandidate[] = []
): Promise<PreparedCandidateActivation> {
  await beginGitHubTreeManifest(database, manifest);
  await persistGitHubTreeManifestEntries(database, manifest, manifestEntries);
  await completeGitHubTreeManifest(database, manifest, manifestEntries, NOW);
  const pending = await prepareCandidateActivation(
    database,
    manifest,
    expectedHead,
    candidates
  );
  await activate(
    database,
    manifest,
    expectedHead,
    pending.candidateStatements,
    expectedHead?.observedSha ?? null,
    pending.activationClaim
  );
  return pending;
}

interface PreparedCandidateActivation {
  activationClaim: GitHubTreeManifestActivationClaim;
  activationFence: PendingGitHubSyncActivationFence;
  candidateStatements: readonly D1PreparedStatement[];
}

async function prepareCandidateActivation(
  database: D1Database,
  manifest: GitHubTreeManifestDescriptor,
  expectedHead: Awaited<ReturnType<typeof readActiveGitHubTreeHead>>,
  candidates: readonly PersistableGitHubCandidate[],
  expectedCursorObservedSha: string | null = expectedHead?.observedSha ?? null
): Promise<PreparedCandidateActivation> {
  const activationClaim = await prepareActivationClaim(
    database,
    manifest,
    expectedCursorObservedSha
  );
  const activationFence = buildActivationFence(
    manifest,
    expectedHead,
    activationClaim
  );
  const candidateStatements = await prepareGitHubCandidateStatements({
    database,
    projectId: manifest.projectId,
    repositoryId: manifest.repositoryId,
    repositoryRef: manifest.ref,
    externalRepositoryId: activationClaim.expectedExternalId,
    manifestId: manifest.manifestId,
    observedSha: manifest.observedSha,
    activationFence,
    candidates
  });
  return { activationClaim, activationFence, candidateStatements };
}

function buildActivationFence(
  manifest: GitHubTreeManifestDescriptor,
  expectedHead: Awaited<ReturnType<typeof readActiveGitHubTreeHead>>,
  activationClaim: GitHubTreeManifestActivationClaim
): PendingGitHubSyncActivationFence {
  return {
    projectId: manifest.projectId,
    repositoryId: manifest.repositoryId,
    ref: manifest.ref,
    manifestId: manifest.manifestId,
    repositoryAuthority: manifest.repositoryAuthority,
    runId: activationClaim.runId,
    receiptId: activationClaim.receiptId,
    activationToken: activationClaim.activationToken,
    scheduledFor: new Date(Date.parse(manifest.collectionKey)).toISOString(),
    fullReconciliation: activationClaim.fullReconciliation,
    expectedHeadManifestId: expectedHead?.manifestId ?? null,
    expectedHeadVersion: expectedHead?.headVersion ?? 0,
    expectedExternalId: activationClaim.expectedExternalId,
    expectedOwnerExternalId: activationClaim.expectedOwnerExternalId,
    expectedOwner: activationClaim.expectedOwner,
    expectedName: activationClaim.expectedName,
    expectedDefaultBranch: activationClaim.expectedDefaultBranch,
    expectedTrackedRefsJson: activationClaim.expectedTrackedRefsJson,
    expectedRepositoryConfigurationVersion:
      activationClaim.expectedRepositoryConfigurationVersion,
    expectedRepositoryUpdatedAt:
      activationClaim.expectedRepositoryUpdatedAt,
    expectedCursorObservedSha: activationClaim.expectedCursorObservedSha,
    expectedCursorStatus: activationClaim.expectedCursorStatus,
    expectedCursorUpdatedAt: activationClaim.expectedCursorUpdatedAt,
    expectedCursorVersion: activationClaim.expectedCursorVersion
  };
}

async function activate(
  database: D1Database,
  manifest: GitHubTreeManifestDescriptor,
  expectedHead: Awaited<ReturnType<typeof readActiveGitHubTreeHead>>,
  candidateStatements: readonly D1PreparedStatement[] = [],
  expectedCursorObservedSha: string | null = expectedHead?.observedSha ?? null,
  preparedClaim?: GitHubTreeManifestActivationClaim
): Promise<void> {
  const activationClaim =
    preparedClaim ??
    (await prepareActivationClaim(
      database,
      manifest,
      expectedCursorObservedSha
    ));
  const syncEvent = await buildStableSyncEvent({
    projectId: manifest.projectId,
    repositoryId: manifest.repositoryId,
    externalRepositoryId: activationClaim.expectedExternalId,
    ref: manifest.ref,
    observedSha: manifest.observedSha,
    manifestId: manifest.manifestId
  });
  const payloadJson = JSON.stringify(syncEvent);
  await activateGitHubTreeManifest({
    database,
    descriptor: manifest,
    expectedHead,
    activationClaim,
    scheduledTime: Date.parse(manifest.collectionKey),
    nextSyncAt: "2026-07-28T06:00:00.000Z",
    historyGapPossible: false,
    credentialStatus: "active",
    etag: '"synthetic-etag"',
    syncEvent: {
      eventId: syncEvent.eventId,
      payloadDigest: await sha256(payloadJson),
      payloadJson
    },
    candidateStatements
  });
}

async function prepareActivationClaim(
  database: D1Database,
  manifest: GitHubTreeManifestDescriptor,
  expectedCursorObservedSha: string | null
): Promise<GitHubTreeManifestActivationClaim> {
  const repository = await database
    .withSession("first-primary")
    .prepare(
      `SELECT external_id, expected_owner_external_id, owner, name,
              default_branch, tracked_refs_json,
              github_sync_configuration_version, updated_at
       FROM repositories
       WHERE project_id = ? AND repository_id = ?`
    )
    .bind(manifest.projectId, manifest.repositoryId)
    .first<{
      external_id: number;
      expected_owner_external_id: number;
      owner: string;
      name: string;
      default_branch: string;
      tracked_refs_json: string;
      github_sync_configuration_version: number;
      updated_at: string;
    }>();
  const cursor = await database
    .withSession("first-primary")
    .prepare(
      `SELECT status, updated_at, cursor_version
       FROM sync_cursors
       WHERE project_id = ? AND repository_id = ? AND ref = ?`
    )
    .bind(manifest.projectId, manifest.repositoryId, manifest.ref)
    .first<{
      status: string;
      updated_at: string;
      cursor_version: number;
    }>();
  const head = await database
    .withSession("first-primary")
    .prepare(
      `SELECT manifest_id, head_version
       FROM github_tree_ref_heads
       WHERE project_id = ? AND repository_id = ? AND ref = ?`
    )
    .bind(manifest.projectId, manifest.repositoryId, manifest.ref)
    .first<{ manifest_id: string; head_version: number }>();
  if (repository === null || cursor === null) {
    throw new Error("Synthetic activation requires repository and cursor rows.");
  }
  const scheduledFor = new Date(
    Date.parse(manifest.collectionKey)
  ).toISOString();
  const runId = await sha256(
    [
      "synthetic.github.sync.run",
      manifest.projectId,
      manifest.repositoryId,
      manifest.ref,
      manifest.manifestId
    ].join("\n")
  );
  await database
    .prepare(
      `INSERT INTO github_repository_sync_runs
       (run_id, project_id, repository_id, scheduled_for,
        full_reconciliation, status, started_at, lease_expires_at,
        claimed_ref, claimed_head_manifest_id, claimed_head_version,
        repository_configuration_version, cursor_version, claim_contract_version)
       VALUES (?, ?, ?, ?, 1, 'running', ?,
               '2099-01-01T00:00:00.000Z', ?, ?, ?, ?, ?, 1)
       ON CONFLICT(run_id) DO NOTHING`
    )
    .bind(
      runId,
      manifest.projectId,
      manifest.repositoryId,
      scheduledFor,
      NOW,
      manifest.ref,
      head?.manifest_id ?? null,
      head?.head_version ?? 0,
      repository.github_sync_configuration_version,
      cursor.cursor_version
    )
    .run();
  const attempt = await createGitHubTreeManifestActivationAttempt({
    runId,
    projectId: manifest.projectId,
    repositoryId: manifest.repositoryId,
    ref: manifest.ref,
    manifestId: manifest.manifestId
  });
  return {
    runId,
    ...attempt,
    expectedExternalId: repository.external_id,
    expectedOwnerExternalId: repository.expected_owner_external_id,
    expectedOwner: repository.owner,
    expectedName: repository.name,
    expectedDefaultBranch: repository.default_branch,
    expectedTrackedRefsJson: repository.tracked_refs_json,
    expectedRepositoryConfigurationVersion:
      repository.github_sync_configuration_version,
    expectedRepositoryUpdatedAt: repository.updated_at,
    expectedCursorStatus: cursor.status,
    expectedCursorUpdatedAt: cursor.updated_at,
    expectedCursorVersion: cursor.cursor_version,
    expectedCursorObservedSha,
    fullReconciliation: true
  };
}

function createFixture(): {
  database: DatabaseSync;
  d1: D1Database;
  control: SqliteD1;
} {
  const database = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) {
    database.exec(readFileSync(migration, "utf8"));
  }
  seedProjectRepository(database, PROJECT_ID, REPOSITORY_ID, 42);
  const control = new SqliteD1(database);
  return { database, d1: control as unknown as D1Database, control };
}

function seedProjectRepository(
  database: DatabaseSync,
  projectId: string,
  repositoryId: string,
  externalId: number
): void {
  database
    .prepare(
      `INSERT INTO projects
       (project_id, project_ref, locator, display_name, project_version,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(projectId, `project.${projectId}`, `locator.${projectId}`, projectId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO repositories
       (repository_id, project_id, provider, external_id, owner, name,
        default_branch, tracked_refs_json, sync_enabled, created_at, updated_at,
        expected_owner_external_id)
       VALUES (?, ?, 'github', ?, 'memenow', ?, 'main', '[]', 1, ?, ?, 7)`
    )
    .run(repositoryId, projectId, externalId, repositoryId, NOW, NOW);
  database
    .prepare(
      `INSERT INTO sync_cursors
       (project_id, repository_id, ref, status, history_gap_possible,
        credential_status, updated_at)
       VALUES (?, ?, ?, 'idle', 0, 'active', ?)
       ON CONFLICT(project_id, repository_id, ref) DO NOTHING`
    )
    .run(projectId, repositoryId, REF, NOW);
}

function readCandidateReplayState(
  database: DatabaseSync,
  observationId: string,
  evidenceId: string
): {
  observation: Record<string, unknown> | undefined;
  evidence: Record<string, unknown> | undefined;
  link: Record<string, unknown> | undefined;
  outbox: Record<string, unknown>[];
} {
  return {
    observation: database
      .prepare(
        `SELECT * FROM observations
         WHERE project_id = ? AND observation_id = ?`
      )
      .get(PROJECT_ID, observationId) as Record<string, unknown> | undefined,
    evidence: database
      .prepare(
        `SELECT * FROM evidence
         WHERE project_id = ? AND evidence_id = ?`
      )
      .get(PROJECT_ID, evidenceId) as Record<string, unknown> | undefined,
    link: database
      .prepare(
        `SELECT * FROM observation_evidence
         WHERE project_id = ? AND observation_id = ? AND evidence_id = ?`
      )
      .get(PROJECT_ID, observationId, evidenceId) as
      | Record<string, unknown>
      | undefined,
    outbox: database
      .prepare(
        `SELECT * FROM outbox_events
         WHERE project_id = ?
           AND event_type IN ('candidate.submitted', 'github.sync.requested')
         ORDER BY event_type, event_id`
      )
      .all(PROJECT_ID) as Record<string, unknown>[]
  };
}

function seedAffectedMemory(
  database: DatabaseSync,
  deletedEntry: GitHubTreeManifestEntry
): void {
  if (deletedEntry.safePath === null) {
    throw new Error("The affected-memory fixture requires a previously safe path");
  }
  database
    .prepare(
      `INSERT INTO principals
       (principal_id, issuer, subject, token_digest, created_at)
       VALUES ('principal-a', 'test', 'principal-a', 'digest-a', ?)`
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO project_grants
       (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
       VALUES ('grant-a', ?, 'principal-a', 'maintainer', 'project', ?, ?)`
    )
    .run(PROJECT_ID, PROJECT_ID, NOW);
  database
    .prepare(
      `INSERT INTO audit_events
       (audit_id, project_id, sequence, event_type, actor_principal_id,
        request_digest, previous_event_hash, event_hash, recorded_at)
       VALUES ('audit-a', ?, 1, 'test', 'principal-a', 'request-a', NULL,
               'event-a', ?)`
    )
    .run(PROJECT_ID, NOW);
  database
    .prepare(
      `INSERT INTO memories
       (memory_id, project_id, memory_version, kind, memory_class, scope,
        scope_id, status, created_at, updated_at)
       VALUES ('memory-affected', ?, 0, 'fact', 'semantic', 'repository', ?,
               'active', ?, ?)`
    )
    .run(PROJECT_ID, REPOSITORY_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO evidence
       (evidence_id, project_id, source_type, locator, repository_id,
        repository_ref, repository_path, repository_authority, commit_sha,
        excerpt_hash, sensitivity_status, recorded_at)
       VALUES ('evidence-a', ?, 'github_blob', ?, ?, ?, ?, 'default_branch',
               ?, ?, 'clear', ?)`
    )
    .run(
      PROJECT_ID,
      `github://42/old/${deletedEntry.safePath}`,
      REPOSITORY_ID,
      REF,
      deletedEntry.safePath,
      SHA.commit,
      deletedEntry.pathDigest,
      NOW
    );
  database
    .prepare(
      `INSERT INTO memory_versions
       (revision_id, project_id, memory_id, memory_version, content,
        content_sha256, audit_id, recorded_at)
       VALUES ('revision-a', ?, 'memory-affected', 1, 'The deleted path exists.',
               'content-a', 'audit-a', ?)`
    )
    .run(PROJECT_ID, NOW);
  database
    .prepare(
      `UPDATE memories SET current_revision_id = 'revision-a', memory_version = 1
       WHERE project_id = ? AND memory_id = 'memory-affected'`
    )
    .run(PROJECT_ID);
  database
    .prepare(
      `INSERT INTO version_evidence (project_id, revision_id, evidence_id)
       VALUES (?, 'revision-a', 'evidence-a')`
    )
    .run(PROJECT_ID);
}

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: SQLInputValue[] = []
  ) {}

  bind(...bindings: SQLInputValue[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.sql, bindings);
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      ...d1Result(0),
      results: this.statement().all(...this.bindings) as T[]
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
  private failAfterCommit = false;

  constructor(private readonly database: DatabaseSync) {}

  failAfterNextCommittedBatch(): void {
    this.failAfterCommit = true;
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, sql);
  }

  withSession(): SqliteD1 {
    return this;
  }

  async batch(statements: SqliteD1Statement[]): Promise<D1Result[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.database.exec("COMMIT");
      if (this.failAfterCommit) {
        this.failAfterCommit = false;
        throw new Error("synthetic response loss after commit");
      }
      return results;
    } catch (error) {
      if (this.database.isTransaction) {
        this.database.exec("ROLLBACK");
      }
      throw error;
    }
  }
}
