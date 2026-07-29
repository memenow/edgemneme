import { readFileSync } from "node:fs";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync
} from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  persistGitHubCandidates,
  prepareGitHubCandidateStatements
} from "../src/github/candidate-persistence";
import {
  activateGitHubTreeManifest,
  beginGitHubTreeManifest,
  buildGitHubTreeManifestDescriptor,
  completeGitHubTreeManifest,
  persistGitHubTreeManifestEntries,
  readActiveGitHubTreeHead,
  type GitHubTreeManifestDescriptor,
  type GitHubTreeManifestEntry
} from "../src/github/tree-manifest";
import { sha256 } from "../src/security/crypto";
import { buildGitHubBlobCandidate } from "../workers/github-sync/index";

const MIGRATIONS = Array.from({ length: 11 }, (_, index) => {
  const number = String(index + 1).padStart(4, "0");
  const names = [
    "initial",
    "allow_synthetic_cleanup",
    "validity_interval_guard",
    "synthetic_cleanup_registry_and_validity_preflight",
    "synthetic_cleanup_fence",
    "repository_scope_context",
    "repository_scope_hardening",
    "canonical_repository_scope_ownership",
    "repository_scope_runtime_guards",
    "github_credential_expiry_and_repository_identity",
    "github_tree_manifests"
  ];
  return `migrations/${number}_${names[index]}.sql`;
});

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
    await storeAndActivate(fixture.d1, activeManifest, [], null);
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
    const persist = () =>
      persistGitHubCandidates({
        database: fixture.d1,
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        repositoryRef: REF,
        externalRepositoryId: 42,
        manifestId: activeManifest.manifestId,
        observedSha: SHA.commit,
        candidates: [clear, tombstone]
      });

    await persist();
    await persist();
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
      persistGitHubCandidates({
        database: fixture.d1,
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        repositoryRef: REF,
        externalRepositoryId: 42,
        manifestId: activeManifest.manifestId,
        observedSha: SHA.commit,
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
      persistGitHubCandidates({
        database: fixture.d1,
        projectId: PROJECT_ID,
        repositoryId: "repository-b",
        repositoryRef: REF,
        externalRepositoryId: 42,
        manifestId: activeManifest.manifestId,
        observedSha: SHA.commit,
        candidates: [clear]
      })
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
  });

  it("keeps evidence provenance isolated when refs share the same Git object", async () => {
    const fixture = createFixture();
    const trackedRef = "refs/heads/feature";
    const manifestEntries = await entries([
      ["docs/context.md", SHA.keep, "text"]
    ]);
    const defaultManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(fixture.d1, defaultManifest, manifestEntries, null);

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
    await activate(fixture.d1, trackedManifest, null, [], SHA.commit);

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
    const trackedCandidate = await buildGitHubBlobCandidate({
      ...sharedInput,
      ref: trackedRef
    });

    expect(trackedCandidate.evidenceId).not.toBe(defaultCandidate.evidenceId);
    expect(trackedCandidate.locator).not.toBe(defaultCandidate.locator);
    for (const [manifest, candidate] of [
      [trackedManifest, trackedCandidate],
      [defaultManifest, defaultCandidate]
    ] as const) {
      const persist = async (): Promise<void> => {
        await persistGitHubCandidates({
          database: fixture.d1,
          projectId: PROJECT_ID,
          repositoryId: REPOSITORY_ID,
          repositoryRef: manifest.ref,
          externalRepositoryId: 42,
          manifestId: manifest.manifestId,
          observedSha: SHA.commit,
          candidates: [candidate]
        });
      };
      await persist();
      await persist();
    }

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
    const defaultManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(fixture.d1, defaultManifest, [], null);
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
    await activate(fixture.d1, trackedManifest, null, [], SHA.commit);

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
    for (const [manifest, candidate] of candidates) {
      expect(candidate.sensitivityStatus).toBe("tombstone");
      expect(candidate.repositoryPath).toBeNull();
      expect(candidate.observation).toBeUndefined();
      await persistGitHubCandidates({
        database: fixture.d1,
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        repositoryRef: manifest.ref,
        externalRepositoryId: 42,
        manifestId: manifest.manifestId,
        observedSha: SHA.commit,
        candidates: [candidate]
      });
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
    await storeAndActivate(fixture.d1, activeManifest, [], null);
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
      persistGitHubCandidates({
        database: fixture.d1,
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        repositoryRef: REF,
        externalRepositoryId: 42,
        manifestId: activeManifest.manifestId,
        observedSha: SHA.commit,
        candidates: [candidate]
      })
    ).rejects.toThrow(/evidence identity is immutable/iu);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM observations WHERE project_id = ?")
        .get(PROJECT_ID)
    ).toEqual({ count: 0 });
  });

  it("fails closed when a stored evidence tuple has a different immutable identity", async () => {
    const fixture = createFixture();
    const activeManifest = await descriptor("2026-07-28T00:00:00.000Z");
    await storeAndActivate(fixture.d1, activeManifest, [], null);
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
      persistGitHubCandidates({
        database: fixture.d1,
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        repositoryRef: REF,
        externalRepositoryId: 42,
        manifestId: activeManifest.manifestId,
        observedSha: SHA.commit,
        candidates: [candidate]
      })
    ).rejects.toThrow(/evidence identity is immutable/iu);
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
    await storeAndActivate(fixture.d1, newManifest, newEntries, expectedHead);

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
    ).toEqual({ manifestId: newManifest.manifestId, observedSha: SHA.commit });

    await activate(fixture.d1, newManifest, expectedHead);
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

  it("isolates deletion evidence when tracked refs converge on the same commit", async () => {
    const fixture = createFixture();
    const trackedRefs = ["refs/heads/feature-a", "refs/heads/feature-b"] as const;
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
    ).toEqual({ manifestId: oldManifest.manifestId, observedSha: SHA.commit });
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
    const candidateStatements = await prepareGitHubCandidateStatements({
      database: fixture.d1,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      repositoryRef: REF,
      externalRepositoryId: 42,
      manifestId: newManifest.manifestId,
      observedSha: SHA.commit,
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
      activate(fixture.d1, newManifest, expectedHead, candidateStatements)
    ).rejects.toThrow("synthetic activation failure");
    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({ manifestId: oldManifest.manifestId, observedSha: SHA.commit });
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
    const candidateStatements = await prepareGitHubCandidateStatements({
      database: fixture.d1,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      repositoryRef: REF,
      externalRepositoryId: 42,
      manifestId: newManifest.manifestId,
      observedSha: SHA.commit,
      candidates: [candidate]
    });

    await expect(
      activate(
        fixture.d1,
        newManifest,
        { manifestId: "4".repeat(64), observedSha: SHA.commit },
        candidateStatements
      )
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({ manifestId: oldManifest.manifestId, observedSha: SHA.commit });
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
    ).toEqual({ manifestId: oldManifest.manifestId, observedSha: SHA.commit });
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
        `INSERT INTO sync_cursors
         (project_id, repository_id, ref, observed_sha, status, updated_at)
         VALUES (?, ?, ?, ?, 'complete', ?)`
      )
      .run(PROJECT_ID, REPOSITORY_ID, REF, legacySha, NOW);
    const manifest = await descriptor("2026-07-29T00:00:00.000Z");
    const manifestEntries = await entries([["docs/current.md", SHA.keep, "text"]]);
    await beginGitHubTreeManifest(fixture.d1, manifest);
    await persistGitHubTreeManifestEntries(fixture.d1, manifest, manifestEntries);
    await completeGitHubTreeManifest(fixture.d1, manifest, manifestEntries, NOW);

    await activate(fixture.d1, manifest, null, [], legacySha);

    expect(
      await readActiveGitHubTreeHead(fixture.d1, PROJECT_ID, REPOSITORY_ID, REF)
    ).toEqual({ manifestId: manifest.manifestId, observedSha: SHA.commit });
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
  expectedHead: Awaited<ReturnType<typeof readActiveGitHubTreeHead>>
): Promise<void> {
  await beginGitHubTreeManifest(database, manifest);
  await persistGitHubTreeManifestEntries(database, manifest, manifestEntries);
  await completeGitHubTreeManifest(database, manifest, manifestEntries, NOW);
  await activate(database, manifest, expectedHead);
}

async function activate(
  database: D1Database,
  manifest: GitHubTreeManifestDescriptor,
  expectedHead: Awaited<ReturnType<typeof readActiveGitHubTreeHead>>,
  candidateStatements: readonly D1PreparedStatement[] = [],
  expectedCursorObservedSha: string | null = expectedHead?.observedSha ?? null
): Promise<void> {
  const payloadJson = JSON.stringify({ manifest_id: manifest.manifestId });
  await activateGitHubTreeManifest({
    database,
    descriptor: manifest,
    expectedHead,
    expectedCursorObservedSha,
    scheduledTime: Date.parse(manifest.collectionKey),
    nextSyncAt: "2026-07-28T06:00:00.000Z",
    historyGapPossible: false,
    credentialStatus: "active",
    etag: '"synthetic-etag"',
    syncEvent: {
      eventId: `sync-${manifest.manifestId}`,
      payloadDigest: await sha256(payloadJson),
      payloadJson
    },
    candidateStatements
  });
}

function createFixture(): { database: DatabaseSync; d1: D1Database } {
  const database = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) {
    database.exec(readFileSync(migration, "utf8"));
  }
  seedProjectRepository(database, PROJECT_ID, REPOSITORY_ID, 42);
  return { database, d1: new SqliteD1(database) as unknown as D1Database };
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
  constructor(private readonly database: DatabaseSync) {}

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
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
