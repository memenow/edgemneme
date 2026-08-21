import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GatewayService, type GatewayEnv } from "../src/gateway/service";
import type { AuthenticatedPrincipal } from "../src/security/auth";
import { sha256 } from "../src/security/crypto";

const NOW = "2026-07-27T12:00:00.000Z";
const PROJECT_ID = "project-1";
const PROJECT_REF = "project:one";
const DELETION_CANDIDATE_ID =
  `github-path-absent-observation:${"a".repeat(64)}:` +
  `${"b".repeat(64)}:${"c".repeat(64)}`;

describe("GatewayService multi-repository isolation", () => {
  it("allows a repository writer to open, submit, and close only in its repository", async () => {
    const fixture = createFixture();
    const service = fixture.service(repoWriterPrincipal());

    const opened = await service.openSession({
      projectRef: PROJECT_REF,
      agentMeta: { name: "repository-writer" },
      worktreeMeta: {
        repository_id: "repository-a",
        ref: "refs/heads/feature-a",
        worktree_id: "worktree-a"
      }
    });
    const sessionId = String(opened.session_id);
    expect(
      fixture.database
        .prepare(
          `SELECT repository_id, repository_ref, worktree_id
           FROM sessions WHERE session_id = ?`
        )
        .get(sessionId)
    ).toEqual({
      repository_id: "repository-a",
      repository_ref: "refs/heads/feature-a",
      worktree_id: "worktree-a"
    });

    const forgedEvidence = {
      source_type: "repository_file",
      locator: "docs/architecture.md",
      excerpt_hash: "a".repeat(64),
      repository_id: "repository-b",
      repository_authority: "default_branch"
    };
    const candidate = await service.submitCandidate({
      projectRef: PROJECT_REF,
      sessionId,
      content: "Repository A uses D1 as its memory authority.",
      evidence: [forgedEvidence],
      idempotencyKey: "candidate-repository-a"
    });
    expect(candidate.status).toBe("queued");
    expect(
      fixture.database
        .prepare(
          `SELECT repository_id, repository_ref, repository_path,
                  repository_authority, locator
           FROM evidence`
        )
        .get()
    ).toEqual({
      repository_id: "repository-a",
      repository_ref: "refs/heads/feature-a",
      repository_path: null,
      repository_authority: "agent_supplied",
      locator: "repository:repository-a:docs/architecture.md"
    });
    expect(
      fixture.database
        .prepare("SELECT evidence_json FROM observations WHERE observation_id = ?")
        .get(String(candidate.candidate_id))
    ).toEqual({
      evidence_json: JSON.stringify([
        {
          excerpt_hash: "a".repeat(64),
          locator: "docs/architecture.md",
          source_type: "repository_file"
        }
      ])
    });

    await expect(
      service.closeSession({
        sessionId,
        expectedSessionVersion: 1,
        triggerConsolidation: false,
        idempotencyKey: "close-repository-a"
      })
    ).resolves.toMatchObject({ status: "closed", session_version: 2 });
    const beforeLateCandidate = tableCount(fixture.database, "observations");
    await expect(
      service.submitCandidate({
        projectRef: PROJECT_REF,
        sessionId,
        content: "This candidate arrived after close.",
        evidence: [],
        idempotencyKey: "late-candidate-repository-a"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(tableCount(fixture.database, "observations")).toBe(beforeLateCandidate);

    const sessionsBeforeDeniedOpen = tableCount(fixture.database, "sessions");
    await expect(
      service.openSession({
        projectRef: PROJECT_REF,
        agentMeta: { name: "repository-writer" },
        worktreeMeta: { repository_id: "repository-b" }
      })
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
    expect(tableCount(fixture.database, "sessions")).toBe(sessionsBeforeDeniedOpen);
  });

  it("deduplicates repeated candidate evidence with identical provenance", async () => {
    const fixture = createFixture();
    const service = fixture.service(repoWriterPrincipal());
    const opened = await service.openSession({
      projectRef: PROJECT_REF,
      agentMeta: { name: "repository-writer" },
      worktreeMeta: {
        repository_id: "repository-a",
        ref: "refs/heads/feature-a"
      }
    });
    const evidence = {
      source_type: "repository_file",
      locator: "docs/architecture.md",
      commit_sha: "a".repeat(40),
      excerpt_hash: "e".repeat(64)
    };

    const input = {
      projectRef: PROJECT_REF,
      sessionId: String(opened.session_id),
      content: "Repository A uses D1 as its memory authority.",
      evidence: [evidence, evidence],
      idempotencyKey: "candidate-duplicate-evidence"
    };
    const candidate = await service.submitCandidate(input);
    const replay = await service.submitCandidate(input);

    expect(candidate.status).toBe("queued");
    expect(replay).toEqual(candidate);
    expect(tableCount(fixture.database, "evidence")).toBe(1);
    expect(tableCount(fixture.database, "observation_evidence")).toBe(1);
    const observation = fixture.database
      .prepare("SELECT evidence_json FROM observations WHERE observation_id = ?")
      .get(String(candidate.candidate_id)) as { evidence_json: string };
    expect(JSON.parse(observation.evidence_json)).toEqual([evidence]);
  });

  it("rejects duplicate candidate evidence with conflicting provenance", async () => {
    const fixture = createFixture();
    const service = fixture.service(repoWriterPrincipal());
    const opened = await service.openSession({
      projectRef: PROJECT_REF,
      agentMeta: { name: "repository-writer" },
      worktreeMeta: {
        repository_id: "repository-a",
        ref: "refs/heads/feature-a"
      }
    });

    await expect(
      service.submitCandidate({
        projectRef: PROJECT_REF,
        sessionId: String(opened.session_id),
        content: "Repository A uses D1 as its memory authority.",
        evidence: [
          {
            source_type: "repository_file",
            locator: "docs/architecture.md",
            commit_sha: "a".repeat(40),
            excerpt_hash: "e".repeat(64)
          },
          {
            source_type: "repository_file",
            locator: "docs/architecture.md",
            commit_sha: "b".repeat(40),
            excerpt_hash: "e".repeat(64)
          }
        ],
        idempotencyKey: "candidate-conflicting-duplicate-evidence"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "The submitted evidence conflicts with existing immutable provenance."
    });
    expect(tableCount(fixture.database, "observations")).toBe(0);
    expect(tableCount(fixture.database, "evidence")).toBe(0);
    expect(tableCount(fixture.database, "observation_evidence")).toBe(0);
    expect(tableCount(fixture.database, "idempotency_records")).toBe(0);
    expect(tableCount(fixture.database, "outbox_events")).toBe(0);
  });

  it("links an exact evidence replay without changing its recorded provenance", async () => {
    const fixture = createFixture();
    const service = fixture.service(repoWriterPrincipal());
    const opened = await service.openSession({
      projectRef: PROJECT_REF,
      agentMeta: { name: "repository-writer" },
      worktreeMeta: {
        repository_id: "repository-a",
        ref: "refs/heads/feature-a"
      }
    });
    const excerptHash = "e".repeat(64);
    const locator = "repository:repository-a:docs/architecture.md";
    const evidenceId = await sha256(
      `${PROJECT_ID}\nrepository_file\n${locator}\n${excerptHash}`
    );
    const originalRecordedAt = "2026-01-01T00:00:00.000Z";
    fixture.database
      .prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, commit_sha, excerpt_hash,
          sensitivity_status, recorded_at, repository_id, repository_ref,
          repository_path, repository_authority)
         VALUES (?, ?, 'repository_file', ?, ?, ?, 'clear', ?, 'repository-a',
                 'refs/heads/feature-a', NULL, 'agent_supplied')`
      )
      .run(
        evidenceId,
        PROJECT_ID,
        locator,
        "a".repeat(40),
        excerptHash,
        originalRecordedAt
      );

    const candidate = await service.submitCandidate({
      projectRef: PROJECT_REF,
      sessionId: String(opened.session_id),
      content: "Repository A uses D1 as its memory authority.",
      evidence: [
        {
          source_type: "repository_file",
          locator: "docs/architecture.md",
          commit_sha: "a".repeat(40),
          excerpt_hash: excerptHash
        }
      ],
      idempotencyKey: "candidate-exact-evidence-replay"
    });

    expect(candidate.status).toBe("queued");
    expect(
      fixture.database
        .prepare(
          `SELECT recorded_at, sensitivity_status FROM evidence
           WHERE evidence_id = ?`
        )
        .get(evidenceId)
    ).toEqual({
      recorded_at: originalRecordedAt,
      sensitivity_status: "clear"
    });
    expect(tableCount(fixture.database, "evidence")).toBe(1);
    expect(tableCount(fixture.database, "observation_evidence")).toBe(1);
  });

  it.each([
    ["commit", { commit_sha: "b".repeat(40) }],
    ["repository", { repository_id: "repository-b" }],
    ["ref", { repository_ref: "refs/heads/other" }],
    ["path", { repository_path: "docs/architecture.md" }],
    ["authority", { repository_authority: "tracked_ref" }],
    ["sensitivity", { sensitivity_status: "quarantined" }]
  ] as const)(
    "rejects existing candidate evidence with conflicting immutable %s provenance",
    async (_name, conflict) => {
      const stored = conflict as {
        commit_sha?: string;
        repository_id?: string;
        repository_ref?: string;
        repository_path?: string;
        repository_authority?: string;
        sensitivity_status?: string;
      };
      const fixture = createFixture();
      const service = fixture.service(repoWriterPrincipal());
      const opened = await service.openSession({
        projectRef: PROJECT_REF,
        agentMeta: { name: "repository-writer" },
        worktreeMeta: {
          repository_id: "repository-a",
          ref: "refs/heads/feature-a"
        }
      });
      fixture.database
        .prepare(
          `INSERT INTO evidence
           (evidence_id, project_id, source_type, locator, commit_sha, excerpt_hash,
            sensitivity_status, recorded_at, repository_id, repository_ref,
            repository_path, repository_authority)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          await sha256(
            `${PROJECT_ID}\nrepository_file\nrepository:repository-a:docs/architecture.md\n${"e".repeat(64)}`
          ),
          PROJECT_ID,
          "repository_file",
          "repository:repository-a:docs/architecture.md",
          stored.commit_sha ?? "a".repeat(40),
          "e".repeat(64),
          stored.sensitivity_status ?? "clear",
          NOW,
          stored.repository_id ?? "repository-a",
          stored.repository_ref ?? "refs/heads/feature-a",
          stored.repository_path ?? null,
          stored.repository_authority ?? "agent_supplied"
        );

      await expect(
        service.submitCandidate({
          projectRef: PROJECT_REF,
          sessionId: String(opened.session_id),
          content: "Repository A uses D1 as its memory authority.",
          evidence: [
            {
              source_type: "repository_file",
              locator: "docs/architecture.md",
              commit_sha: "a".repeat(40),
              excerpt_hash: "e".repeat(64)
            }
          ],
          idempotencyKey: `candidate-existing-conflict-${_name}`
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "The submitted evidence conflicts with existing immutable provenance."
      });
      expect(tableCount(fixture.database, "observations")).toBe(0);
      expect(tableCount(fixture.database, "evidence")).toBe(1);
      expect(tableCount(fixture.database, "observation_evidence")).toBe(0);
      expect(tableCount(fixture.database, "idempotency_records")).toBe(0);
      expect(tableCount(fixture.database, "outbox_events")).toBe(0);
    }
  );

  it.each([
    ["commit", "b".repeat(40), "clear"],
    ["sensitivity", "a".repeat(40), "quarantined"]
  ] as const)(
    "rolls back a candidate when evidence %s provenance conflicts after preflight",
    async (conflictName, storedCommitSha, storedSensitivity) => {
      const fixture = createFixture();
      const service = fixture.service(repoWriterPrincipal());
      const opened = await service.openSession({
        projectRef: PROJECT_REF,
        agentMeta: { name: "repository-writer" },
        worktreeMeta: {
          repository_id: "repository-a",
          ref: "refs/heads/feature-a"
        }
      });
      const expectedEvidenceId = await sha256(
        `${PROJECT_ID}\nrepository_file\nrepository:repository-a:docs/architecture.md\n${"e".repeat(64)}`
      );
      fixture.memoryDb.beforeBatch = (batchNumber) => {
        if (batchNumber !== 3) {
          return;
        }
        fixture.database
          .prepare(
            `INSERT INTO evidence
             (evidence_id, project_id, source_type, locator, commit_sha, excerpt_hash,
              sensitivity_status, recorded_at, repository_id, repository_ref,
              repository_path, repository_authority)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'agent_supplied')`
          )
          .run(
            expectedEvidenceId,
            PROJECT_ID,
            "repository_file",
            "repository:repository-a:docs/architecture.md",
            storedCommitSha,
            "e".repeat(64),
            storedSensitivity,
            NOW,
            "repository-a",
            "refs/heads/feature-a"
          );
      };

      await expect(
        service.submitCandidate({
          projectRef: PROJECT_REF,
          sessionId: String(opened.session_id),
          content: "Repository A uses D1 as its memory authority.",
          evidence: [
            {
              source_type: "repository_file",
              locator: "docs/architecture.md",
              commit_sha: "a".repeat(40),
              excerpt_hash: "e".repeat(64)
            }
          ],
          idempotencyKey: `candidate-racing-evidence-${conflictName}-conflict`
        })
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "The submitted evidence conflicts with existing immutable provenance."
      });
      expect(tableCount(fixture.database, "observations")).toBe(0);
      expect(tableCount(fixture.database, "evidence")).toBe(1);
      expect(tableCount(fixture.database, "observation_evidence")).toBe(0);
      expect(tableCount(fixture.database, "idempotency_records")).toBe(0);
      expect(tableCount(fixture.database, "outbox_events")).toBe(0);
    }
  );

  it("returns project memory plus only the authorized repository before pagination", async () => {
    const fixture = createFixture();
    seedMemories(fixture.database);
    const service = fixture.service(repoWriterPrincipal());

    const first = await service.search({ projectRef: PROJECT_REF, limit: 1 });
    expect(memoryIds(first)).toEqual(["memory-shared"]);
    const second = await service.search({
      projectRef: PROJECT_REF,
      limit: 1,
      pageToken: String(first.next_page_token)
    });
    expect(memoryIds(second)).toEqual(["memory-a"]);
    expect(memoryIds(second)).not.toContain("memory-b");
    const unauthorizedFilter = await service.search({
      projectRef: PROJECT_REF,
      filters: { scope: "repository", scope_id: "repository-b" },
      limit: 10
    });
    expect(memoryIds(unauthorizedFilter)).toEqual([]);

    const projectService = fixture.service(projectMaintainerPrincipal());
    const all = await projectService.search({ projectRef: PROJECT_REF, limit: 10 });
    expect(memoryIds(all)).toEqual(["memory-shared", "memory-b", "memory-a"]);
  });

  it("intersects project access with a session repository and binds page tokens to it", async () => {
    const fixture = createFixture();
    seedMemories(fixture.database);
    const projectService = fixture.service(projectMaintainerPrincipal());
    const opened = await projectService.openSession({
      projectRef: PROJECT_REF,
      agentMeta: { name: "project-maintainer" },
      worktreeMeta: { repository_id: "repository-a" }
    });
    const sessionId = String(opened.session_id);

    const first = await projectService.search({
      projectRef: PROJECT_REF,
      sessionId,
      limit: 1
    });
    expect(memoryIds(first)).toEqual(["memory-shared"]);
    const second = await projectService.search({
      projectRef: PROJECT_REF,
      sessionId,
      limit: 1,
      pageToken: String(first.next_page_token)
    });
    expect(memoryIds(second)).toEqual(["memory-a"]);

    await expect(
      projectService.search({
        projectRef: PROJECT_REF,
        limit: 1,
        pageToken: String(first.next_page_token)
      })
    ).rejects.toMatchObject({ code: "PAGE_TOKEN_INVALID" });
  });

  it("rejects a page token replayed by another principal with the same repository grant", async () => {
    const fixture = createFixture();
    seedMemories(fixture.database);
    const writer = fixture.service(repoWriterPrincipal());
    const reader = fixture.service(repoReaderPrincipal());
    const first = await writer.search({ projectRef: PROJECT_REF, limit: 1 });

    await expect(
      reader.search({
        projectRef: PROJECT_REF,
        limit: 1,
        pageToken: String(first.next_page_token)
      })
    ).rejects.toMatchObject({ code: "PAGE_TOKEN_INVALID" });
  });

  it("rejects ambiguous or unowned structured worktree context before mutation", async () => {
    const fixture = createFixture();
    const service = fixture.service(repoWriterPrincipal());
    const before = tableCount(fixture.database, "sessions");

    await expect(
      service.openSession({
        projectRef: PROJECT_REF,
        agentMeta: { name: "repository-writer" },
        worktreeMeta: {
          repository_id: "repository-a",
          repository_ref: "refs/heads/a",
          ref: "refs/heads/b"
        }
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      service.openSession({
        projectRef: PROJECT_REF,
        agentMeta: { name: "repository-writer" },
        worktreeMeta: { ref: "refs/heads/a" }
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(tableCount(fixture.database, "sessions")).toBe(before);
  });

  it("fails closed when a repository writer grant is revoked before session creation", async () => {
    const fixture = createFixture();
    const service = fixture.service(repoWriterPrincipal());
    fixture.memoryDb.beforeBatch = (batchNumber) => {
      if (batchNumber === 1) {
        fixture.database
          .prepare("UPDATE project_grants SET revoked_at = ? WHERE grant_id = ?")
          .run(NOW, "grant-a-writer");
      }
    };

    await expect(
      service.openSession({
        projectRef: PROJECT_REF,
        agentMeta: { name: "repository-writer" },
        worktreeMeta: { repository_id: "repository-a" }
      })
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
    expect(tableCount(fixture.database, "sessions")).toBe(0);
  });

  it("fails closed when a repository writer grant is revoked before the candidate batch", async () => {
    const fixture = createFixture();
    const service = fixture.service(repoWriterPrincipal());
    const opened = await service.openSession({
      projectRef: PROJECT_REF,
      agentMeta: { name: "repository-writer" },
      worktreeMeta: { repository_id: "repository-a" }
    });
    fixture.memoryDb.beforeBatch = (batchNumber) => {
      if (batchNumber === 3) {
        fixture.database
          .prepare("UPDATE project_grants SET revoked_at = ? WHERE grant_id = ?")
          .run(NOW, "grant-a-writer");
      }
    };

    await expect(
      service.submitCandidate({
        projectRef: PROJECT_REF,
        sessionId: String(opened.session_id),
        content: "This candidate must not survive grant revocation.",
        evidence: [],
        idempotencyKey: "candidate-after-grant-revocation"
      })
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
    expect(tableCount(fixture.database, "observations")).toBe(0);
    expect(tableCount(fixture.database, "idempotency_records")).toBe(0);
    expect(tableCount(fixture.database, "outbox_events")).toBe(0);
  });

  it("fails closed when a repository writer grant is revoked before the close batch", async () => {
    const fixture = createFixture();
    const service = fixture.service(repoWriterPrincipal());
    const opened = await service.openSession({
      projectRef: PROJECT_REF,
      agentMeta: { name: "repository-writer" },
      worktreeMeta: { repository_id: "repository-a" }
    });
    const sessionId = String(opened.session_id);
    fixture.memoryDb.beforeBatch = (batchNumber) => {
      if (batchNumber === 3) {
        fixture.database
          .prepare("UPDATE project_grants SET revoked_at = ? WHERE grant_id = ?")
          .run(NOW, "grant-a-writer");
      }
    };

    await expect(
      service.closeSession({
        sessionId,
        expectedSessionVersion: 1,
        summary: "This close must not survive grant revocation.",
        triggerConsolidation: true,
        idempotencyKey: "close-after-grant-revocation"
      })
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
    expect(
      fixture.database
        .prepare("SELECT status, session_version FROM sessions WHERE session_id = ?")
        .get(sessionId)
    ).toEqual({ status: "open", session_version: 1 });
    expect(tableCount(fixture.database, "session_consolidations")).toBe(0);
    expect(tableCount(fixture.database, "idempotency_records")).toBe(0);
    expect(tableCount(fixture.database, "outbox_events")).toBe(0);
  });

  it.each(["reject", "request_changes"] as const)(
    "forwards a valid GitHub path-absence candidate for %s",
    async (decision) => {
      const fixture = createFixture();
      const service = fixture.service(projectMaintainerPrincipal());

      await expect(
        service.reviewCandidate({
          candidateId: DELETION_CANDIDATE_ID,
          expectedCandidateVersion: 1,
          decision,
          reason: "The deleted repository path requires a maintainer disposition.",
          ...(decision === "request_changes"
            ? { edits: { content: "Provide a replacement evidence-backed claim." } }
            : {}),
          idempotencyKey: `review-deletion-${decision}`
        })
      ).resolves.toEqual({ accepted: true });

      expect(fixture.coordinatorInputs).toEqual([
        expect.objectContaining({
          candidate_id: DELETION_CANDIDATE_ID,
          decision
        })
      ]);
    }
  );

  it.each([
    ["wrong prefix", DELETION_CANDIDATE_ID.replace("observation", "candidate")],
    [
      "uppercase digest",
      `github-path-absent-observation:A${"a".repeat(63)}:${"b".repeat(64)}:${"c".repeat(64)}`
    ],
    [
      "short digest",
      `github-path-absent-observation:${"a".repeat(63)}:${"b".repeat(64)}:${"c".repeat(64)}`
    ],
    ["trailing whitespace", `${DELETION_CANDIDATE_ID} `],
    ["NUL byte", `${DELETION_CANDIDATE_ID}\0`]
  ])("rejects a candidate identifier with %s before coordinator mutation", async (_label, candidateId) => {
    const fixture = createFixture();
    const service = fixture.service(projectMaintainerPrincipal());

    await expect(
      service.reviewCandidate({
        candidateId,
        expectedCandidateVersion: 1,
        decision: "reject",
        reason: "The candidate identifier is invalid.",
        idempotencyKey: `invalid-candidate-${_label}`
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(fixture.memoryDb.batchCount).toBe(0);
    expect(fixture.coordinatorInputs).toEqual([]);
  });

  it("derives memory-change repository context and overwrites caller-supplied context", async () => {
    const fixture = createFixture();
    seedMemories(fixture.database);
    const service = fixture.service(projectMaintainerPrincipal());
    const before = mutationTableCounts(fixture.database);

    await service.submitMemoryChange({
      operation: "correct",
      target_memory_id: "memory-a",
      expected_memory_version: 1,
      expected_project_version: 0,
      payload: { content: "Repository A uses a reviewed release policy." },
      evidence: [{ source_type: "repository_file", locator: "docs/release.md" }],
      idempotency_key: "memory-change-repository-a",
      target_repository_context: {
        scope: "repository",
        scope_id: "repository-b",
        repository_id: "repository-b",
        repository_ref: null,
        session_id: null,
        worktree_id: null
      }
    });
    await service.submitMemoryChange({
      operation: "invalidate",
      target_memory_id: "memory-b",
      expected_memory_version: 1,
      expected_project_version: 0,
      payload: { reason: "Repository B replaced this policy." },
      evidence: [{ source_type: "repository_file", locator: "docs/replaced.md" }],
      idempotency_key: "memory-change-repository-b"
    });

    expect(fixture.coordinatorInputs).toHaveLength(2);
    expect(fixture.coordinatorInputs[0]?.target_repository_context).toEqual({
      scope: "repository",
      scope_id: "repository-a",
      repository_id: "repository-a",
      repository_ref: null,
      session_id: null,
      worktree_id: null
    });
    expect(fixture.coordinatorInputs[1]?.target_repository_context).toEqual({
      scope: "repository",
      scope_id: "repository-b",
      repository_id: "repository-b",
      repository_ref: null,
      session_id: null,
      worktree_id: null
    });
    expect(mutationTableCounts(fixture.database)).toEqual(before);
  });
});

function createFixture(): {
  database: DatabaseSync;
  memoryDb: SqliteD1;
  coordinatorInputs: Array<Record<string, unknown>>;
  service: (principal: AuthenticatedPrincipal) => GatewayService;
} {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0001_initial.sql",
    "migrations/0002_allow_synthetic_cleanup.sql",
    "migrations/0003_validity_interval_guard.sql",
    "migrations/0004_synthetic_cleanup_registry_and_validity_preflight.sql",
    "migrations/0005_synthetic_cleanup_fence.sql",
    "migrations/0006_repository_scope_context.sql",
    "migrations/0007_repository_scope_hardening.sql",
    "migrations/0008_canonical_repository_scope_ownership.sql",
    "migrations/0009_repository_scope_runtime_guards.sql"
  ]) {
    database.exec(readFileSync(migration, "utf8"));
  }
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
    VALUES ('${PROJECT_ID}', '${PROJECT_REF}', '${PROJECT_REF}', 'Project One',
            0, '${NOW}', '${NOW}');
    INSERT INTO repositories
      (repository_id, project_id, provider, external_id, owner, name, default_branch,
       created_at, updated_at)
    VALUES
      ('repository-a', '${PROJECT_ID}', 'github', 101, 'memenow', 'repo-a', 'main',
       '${NOW}', '${NOW}'),
      ('repository-b', '${PROJECT_ID}', 'github', 102, 'memenow', 'repo-b', 'main',
       '${NOW}', '${NOW}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('project-maintainer', 'test', 'project-maintainer', 'digest-maintainer', '${NOW}'),
      ('repo-a-writer', 'test', 'repo-a-writer', 'digest-writer', '${NOW}'),
      ('repo-a-reader', 'test', 'repo-a-reader', 'digest-reader', '${NOW}');
    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES
      ('grant-project', '${PROJECT_ID}', 'project-maintainer', 'maintainer',
       'project', '${PROJECT_ID}', '${NOW}'),
      ('grant-a-writer', '${PROJECT_ID}', 'repo-a-writer', 'writer',
       'repository', 'repository-a', '${NOW}'),
      ('grant-a-reader', '${PROJECT_ID}', 'repo-a-reader', 'reader',
       'repository', 'repository-a', '${NOW}');
    INSERT INTO project_grant_repository_contexts
      (project_id, grant_id, repository_id, created_at)
    VALUES
      ('${PROJECT_ID}', 'grant-a-writer', 'repository-a', '${NOW}'),
      ('${PROJECT_ID}', 'grant-a-reader', 'repository-a', '${NOW}');
  `);
  const memoryDb = new SqliteD1(database);
  const coordinatorInputs: Array<Record<string, unknown>> = [];
  const projectCoordinator = {
    idFromName: () => ({ toString: () => PROJECT_ID }),
    get: () => ({
      fetch: async (_url: string, init: RequestInit) => {
        coordinatorInputs.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ accepted: true });
      }
    })
  };
  return {
    database,
    memoryDb,
    coordinatorInputs,
    service: (principal) =>
      new GatewayService(
        {
          MEMORY_DB: memoryDb as unknown as D1Database,
          PROJECT_COORDINATOR: projectCoordinator
        } as unknown as GatewayEnv,
        principal
      )
  };
}

function seedMemories(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO audit_events
      (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
       previous_event_hash, event_hash, recorded_at)
    VALUES ('audit-1', '${PROJECT_ID}', 1, 'test.seed', 'project-maintainer',
            'request-digest', NULL, 'event-hash', '${NOW}');
    INSERT INTO memories
      (memory_id, project_id, memory_version, kind, memory_class, scope, scope_id,
       status, created_at, updated_at)
    VALUES
      ('memory-shared', '${PROJECT_ID}', 0, 'fact', 'semantic', 'project', '${PROJECT_ID}',
       'active', '${NOW}', '2026-07-27T12:03:00.000Z'),
      ('memory-b', '${PROJECT_ID}', 0, 'fact', 'semantic', 'repository', 'repository-b',
       'active', '${NOW}', '2026-07-27T12:02:00.000Z'),
      ('memory-a', '${PROJECT_ID}', 0, 'fact', 'semantic', 'repository', 'repository-a',
       'active', '${NOW}', '2026-07-27T12:01:00.000Z');
    INSERT INTO memory_versions
      (revision_id, project_id, memory_id, memory_version, content, content_sha256,
       audit_id, recorded_at)
    VALUES
      ('revision-shared', '${PROJECT_ID}', 'memory-shared', 1, 'Shared policy.',
       'sha-shared', 'audit-1', '${NOW}'),
      ('revision-b', '${PROJECT_ID}', 'memory-b', 1, 'Repository B policy.',
       'sha-b', 'audit-1', '${NOW}'),
      ('revision-a', '${PROJECT_ID}', 'memory-a', 1, 'Repository A policy.',
       'sha-a', 'audit-1', '${NOW}');
    UPDATE memories
    SET memory_version = 1,
        current_revision_id = CASE memory_id
          WHEN 'memory-shared' THEN 'revision-shared'
          WHEN 'memory-b' THEN 'revision-b'
          ELSE 'revision-a'
        END;
    INSERT INTO memory_repository_contexts
      (project_id, memory_id, repository_id, created_at)
    VALUES
      ('${PROJECT_ID}', 'memory-a', 'repository-a', '${NOW}'),
      ('${PROJECT_ID}', 'memory-b', 'repository-b', '${NOW}');
  `);
}

function repoWriterPrincipal(): AuthenticatedPrincipal {
  return { principalId: "repo-a-writer", projectId: PROJECT_ID, role: "writer" };
}

function repoReaderPrincipal(): AuthenticatedPrincipal {
  return { principalId: "repo-a-reader", projectId: PROJECT_ID, role: "reader" };
}

function projectMaintainerPrincipal(): AuthenticatedPrincipal {
  return {
    principalId: "project-maintainer",
    projectId: PROJECT_ID,
    role: "maintainer"
  };
}

function memoryIds(result: Record<string, unknown>): string[] {
  return (result.memories as Array<{ memory_id: string }>).map((row) => row.memory_id);
}

function tableCount(database: DatabaseSync, table: string): number {
  if (!/^[a-z_]+$/u.test(table)) {
    throw new TypeError("Table names must be simple identifiers.");
  }
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

function mutationTableCounts(database: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    [
      "memories",
      "memory_versions",
      "evidence",
      "version_evidence",
      "audit_events",
      "idempotency_records",
      "outbox_events"
    ].map((table) => [table, tableCount(database, table)])
  );
}

class SqliteStatement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...bindings: unknown[]): SqliteStatement {
    this.bindings = bindings as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement().all(...this.bindings) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: Number(this.statement().run(...this.bindings).changes) } };
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

class SqliteD1 {
  batchCount = 0;
  beforeBatch: ((batchNumber: number) => void) | undefined;

  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  withSession(_constraint: "first-primary"): SqliteD1 {
    return this;
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.batchCount += 1;
    this.beforeBatch?.(this.batchCount);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
