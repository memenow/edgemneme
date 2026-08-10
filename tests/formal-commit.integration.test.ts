import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildCandidatePromotionPlan } from "../src/storage/promotion-plan";
import { buildCandidateReviewPlan } from "../src/storage/review-plan";
import {
  buildMutationEvidencePlan,
  type MutationEvidenceRecord
} from "../src/storage/mutation-evidence-plan";
import {
  buildMemoryMutationPlan,
  type SqlStatement
} from "../src/storage/mutation-plan";

describe("formal candidate commit against the authoritative schema", () => {
  it("atomically promotes a reviewed candidate with evidence and audit history", () => {
    const database = seededDatabase();
    const plan = buildCandidatePromotionPlan({
      projectId: "project-1",
      expectedProjectVersion: 0,
      candidateId: "candidate-1",
      expectedCandidateVersion: 1,
      reviewRequestId: "review-1",
      decisionId: "decision-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest",
      idempotencyKey: "idempotency-key",
      reason: "Verified by the maintainer.",
      content: "D1 is authoritative.",
      contentSha256: "content-sha",
      kind: "decision",
      memoryClass: "semantic",
      scope: "project",
      scopeId: "project-1",
      evidence: [
        {
          evidenceId: "evidence-1",
          sourceType: "maintainer",
          locator: "memory://candidate/candidate-1",
          excerptHash: "excerpt-sha"
        }
      ],
      previousAuditHash: null,
      auditHash: "audit-hash-1",
      now: "2026-07-26T00:00:00.000Z"
    });

    executePlan(database, plan.statements);

    expect(
      database.prepare("SELECT project_version FROM projects WHERE project_id = 'project-1'").get()
    ).toEqual({ project_version: 1 });
    expect(
      database.prepare(
        "SELECT status, promoted_memory_id, promoted_revision_id FROM observations WHERE observation_id = 'candidate-1'"
      ).get()
    ).toEqual({
      status: "promoted",
      promoted_memory_id: "memory-1",
      promoted_revision_id: "revision-1"
    });
    expect(database.prepare("SELECT count(*) AS count FROM review_decisions").get()).toEqual({
      count: 1
    });
    expect(database.prepare("SELECT count(*) AS count FROM version_evidence").get()).toEqual({
      count: 1
    });
    expect(
      database.prepare("SELECT count(*) AS count FROM memory_repository_contexts").get()
    ).toEqual({ count: 0 });
  });

  it("atomically records the repository partition for a repository memory", () => {
    const database = seededDatabase();
    const plan = buildCandidatePromotionPlan({
      projectId: "project-1",
      expectedProjectVersion: 0,
      candidateId: "candidate-1",
      expectedCandidateVersion: 1,
      reviewRequestId: "review-1",
      decisionId: "decision-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest",
      idempotencyKey: "idempotency-key",
      reason: "Verified against repository evidence.",
      content: "Repository 1 uses pnpm.",
      contentSha256: "content-sha",
      kind: "fact",
      memoryClass: "semantic",
      scope: "repository",
      scopeId: "repository-1",
      repositoryId: "repository-1",
      evidence: [
        {
          evidenceId: "evidence-1",
          sourceType: "maintainer",
          locator: "memory://candidate/candidate-1",
          excerptHash: "excerpt-sha",
          repositoryId: "repository-1",
          repositoryAuthority: "agent_supplied"
        }
      ],
      previousAuditHash: null,
      auditHash: "audit-hash-1",
      now: "2026-07-26T00:00:00.000Z"
    });

    executePlan(database, plan.statements);

    expect(
      database.prepare(
        `SELECT repository_id FROM memory_repository_contexts
         WHERE project_id = 'project-1' AND memory_id = 'memory-1'`
      ).get()
    ).toEqual({ repository_id: "repository-1" });
    expect(
      database.prepare("SELECT project_version FROM projects WHERE project_id = 'project-1'").get()
    ).toEqual({ project_version: 1 });
  });

  it("rolls back the entire promotion when evidence is quarantined after planning", () => {
    const database = seededDatabase();
    const plan = buildCandidatePromotionPlan({
      projectId: "project-1",
      expectedProjectVersion: 0,
      candidateId: "candidate-1",
      expectedCandidateVersion: 1,
      reviewRequestId: "review-1",
      decisionId: "decision-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest",
      idempotencyKey: "idempotency-key",
      reason: "Verified by the maintainer.",
      content: "D1 is authoritative.",
      contentSha256: "content-sha",
      kind: "decision",
      memoryClass: "semantic",
      scope: "project",
      scopeId: "project-1",
      evidence: [
        {
          evidenceId: "evidence-1",
          sourceType: "maintainer",
          locator: "memory://candidate/candidate-1",
          excerptHash: "excerpt-sha",
          repositoryId: "repository-1",
          repositoryRef: "refs/heads/main",
          repositoryAuthority: "agent_supplied"
        }
      ],
      previousAuditHash: null,
      auditHash: "audit-hash-1",
      now: "2026-07-26T00:00:00.000Z"
    });
    database.prepare(
      "UPDATE evidence SET sensitivity_status = 'quarantined' WHERE evidence_id = 'evidence-1'"
    ).run();

    expect(() => executePlan(database, plan.statements)).toThrow(
      "clear evidence is required for a memory version"
    );

    expect(database.prepare("SELECT project_version, audit_head_hash FROM projects").get()).toEqual({
      project_version: 0,
      audit_head_hash: null
    });
    for (const table of [
      "audit_events",
      "memories",
      "memory_versions",
      "memory_repository_contexts",
      "version_evidence",
      "review_decisions",
      "idempotency_records",
      "outbox_events"
    ]) {
      expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
        count: 0
      });
    }
    expect(
      database.prepare(
        `SELECT candidate_version, status, promoted_memory_id, promoted_revision_id
         FROM observations WHERE observation_id = 'candidate-1'`
      ).get()
    ).toEqual({
      candidate_version: 1,
      status: "pending_review",
      promoted_memory_id: null,
      promoted_revision_id: null
    });
    expect(
      database.prepare("SELECT status FROM review_requests WHERE review_request_id = 'review-1'").get()
    ).toEqual({ status: "pending" });
    expect(
      database.prepare("SELECT sensitivity_status FROM evidence WHERE evidence_id = 'evidence-1'").get()
    ).toEqual({ sensitivity_status: "quarantined" });
  });

  it("makes a stale promotion plan a complete no-op", () => {
    const database = seededDatabase();
    database.prepare(
      "UPDATE observations SET candidate_version = 2, status = 'request_changes' WHERE observation_id = 'candidate-1'"
    ).run();
    const plan = buildCandidatePromotionPlan({
      projectId: "project-1",
      expectedProjectVersion: 0,
      candidateId: "candidate-1",
      expectedCandidateVersion: 1,
      reviewRequestId: "review-1",
      decisionId: "decision-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest",
      idempotencyKey: "idempotency-key",
      reason: "Verified by the maintainer.",
      content: "D1 is authoritative.",
      contentSha256: "content-sha",
      kind: "decision",
      memoryClass: "semantic",
      scope: "repository",
      scopeId: "repository-1",
      repositoryId: "repository-1",
      evidence: [
        {
          evidenceId: "evidence-1",
          sourceType: "maintainer",
          locator: "memory://candidate/candidate-1",
          excerptHash: "excerpt-sha",
          repositoryId: "repository-1",
          repositoryAuthority: "agent_supplied"
        }
      ],
      previousAuditHash: null,
      auditHash: "audit-hash-1",
      now: "2026-07-26T00:00:00.000Z"
    });

    const changes = executePlan(database, plan.statements);
    expect(changes.at(-1)).toBe(0);
    expect(database.prepare("SELECT count(*) AS count FROM memories").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({
      count: 0
    });
    expect(
      database.prepare("SELECT count(*) AS count FROM memory_repository_contexts").get()
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT project_version FROM projects WHERE project_id = 'project-1'").get()
    ).toEqual({ project_version: 0 });
  });

  it("records request-changes as an immutable project-versioned review", () => {
    const database = seededDatabase();
    const plan = buildCandidateReviewPlan({
      projectId: "project-1",
      expectedProjectVersion: 0,
      candidateId: "candidate-1",
      expectedCandidateVersion: 1,
      reviewRequestId: "review-1",
      decisionId: "decision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest",
      idempotencyKey: "idempotency-key",
      decision: "request_changes",
      reason: "Clarify the scope.",
      editsJson: '{"scope":"project"}',
      previousAuditHash: null,
      auditHash: "audit-hash-1",
      now: "2026-07-26T00:00:00.000Z"
    });

    executePlan(database, plan.statements);

    expect(
      database.prepare(
        "SELECT candidate_version, status FROM observations WHERE observation_id = 'candidate-1'"
      ).get()
    ).toEqual({ candidate_version: 2, status: "request_changes" });
    expect(
      database.prepare("SELECT status FROM review_requests WHERE review_request_id = 'review-1'").get()
    ).toEqual({ status: "changes_requested" });
    expect(
      database.prepare("SELECT decision, candidate_version FROM review_decisions").get()
    ).toEqual({ decision: "request_changes", candidate_version: 2 });
    expect(
      database.prepare("SELECT project_version FROM projects WHERE project_id = 'project-1'").get()
    ).toEqual({ project_version: 1 });
  });

  it("promotes the candidate body after structured request-changes edits", () => {
    const database = seededDatabase();
    const requestChanges = buildCandidateReviewPlan({
      projectId: "project-1",
      expectedProjectVersion: 0,
      candidateId: "candidate-1",
      expectedCandidateVersion: 1,
      reviewRequestId: "review-1",
      decisionId: "decision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest-1",
      idempotencyKey: "idempotency-key-1",
      decision: "request_changes",
      reason: "Use project scope.",
      editsJson: '{"scope":"project","scope_id":"project-1"}',
      previousAuditHash: null,
      auditHash: "audit-hash-1",
      now: "2026-07-26T00:00:00.000Z"
    });

    executePlan(database, requestChanges.statements);
    const candidate = database
      .prepare(
        `SELECT content, reviewed_content
         FROM observations WHERE observation_id = 'candidate-1'`
      )
      .get() as { content: string; reviewed_content: string | null };
    expect(candidate).toEqual({
      content: "D1 is authoritative.",
      reviewed_content: null
    });

    const promotedContent = candidate.reviewed_content ?? candidate.content;
    const approve = buildCandidatePromotionPlan({
      projectId: "project-1",
      expectedProjectVersion: 1,
      candidateId: "candidate-1",
      expectedCandidateVersion: 2,
      reviewRequestId: "review-1",
      decisionId: "decision-2",
      memoryId: "memory-1",
      revisionId: "revision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest-2",
      idempotencyKey: "idempotency-key-2",
      reason: "The candidate now has the required scope.",
      content: promotedContent,
      contentSha256: "content-sha",
      kind: "decision",
      memoryClass: "semantic",
      scope: "project",
      scopeId: "project-1",
      evidence: [
        {
          evidenceId: "evidence-1",
          sourceType: "maintainer",
          locator: "memory://candidate/candidate-1",
          excerptHash: "excerpt-sha"
        }
      ],
      previousAuditHash: "audit-hash-1",
      auditHash: "audit-hash-2",
      now: "2026-07-26T00:01:00.000Z"
    });

    executePlan(database, approve.statements);

    expect(
      database.prepare(
        `SELECT content FROM memory_versions
         WHERE project_id = 'project-1' AND memory_id = 'memory-1'`
      ).get()
    ).toEqual({ content: "D1 is authoritative." });
    expect(database.prepare("SELECT count(*) AS count FROM review_decisions").get()).toEqual({
      count: 2
    });
  });

  it("rejects formal audit writes from a scoped-only maintainer", () => {
    const database = seededDatabase();
    database.prepare("DELETE FROM project_grants WHERE grant_id = 'grant-1'").run();
    database.prepare(
      `INSERT INTO project_grants
       (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
       VALUES ('grant-2', 'project-1', 'maintainer-1', 'maintainer', 'repository',
               'repository-1', '2026-07-25')`
    ).run();
    const plan = buildCandidateReviewPlan({
      projectId: "project-1",
      expectedProjectVersion: 0,
      candidateId: "candidate-1",
      expectedCandidateVersion: 1,
      reviewRequestId: "review-1",
      decisionId: "decision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest",
      idempotencyKey: "idempotency-key",
      decision: "request_changes",
      reason: "Clarify the scope.",
      previousAuditHash: null,
      auditHash: "audit-hash-1",
      now: "2026-07-26T00:00:00.000Z"
    });

    expect(() => executePlan(database, plan.statements)).toThrow(
      "project maintainer grant required"
    );
    expect(database.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual({
      count: 0
    });
  });
});

describe("formal memory mutation against the authoritative schema", () => {
  it("preserves current validity and restores rollback-target validity", () => {
    const database = seededMemoryDatabase();
    const current = database.prepare(
      `SELECT content, valid_from, valid_until
       FROM memory_versions WHERE revision_id = 'revision-2'`
    ).get() as { content: string; valid_from: string | null; valid_until: string | null };
    const correct = buildMemoryMutationPlan({
      operation: "correct",
      projectId: "project-1",
      expectedProjectVersion: 2,
      memoryId: "memory-1",
      expectedMemoryVersion: 2,
      revisionId: "revision-3",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest-3",
      idempotencyKey: "idempotency-key-3",
      content: "Corrected current claim.",
      contentSha256: "content-sha-3",
      validFrom: current.valid_from,
      validUntil: current.valid_until,
      previousAuditHash: "audit-hash-2",
      auditHash: "audit-hash-3",
      now: "2026-07-26T00:02:00.000Z"
    });

    executePlan(database, correct.statements);
    expect(
      database.prepare(
        `SELECT valid_from, valid_until FROM memory_versions
         WHERE revision_id = 'revision-3'`
      ).get()
    ).toEqual({
      valid_from: "2026-02-01T00:00:00.000Z",
      valid_until: "2026-03-01T00:00:00.000Z"
    });

    const rollbackTarget = database.prepare(
      `SELECT content, valid_from, valid_until
       FROM memory_versions WHERE project_id = 'project-1'
         AND memory_id = 'memory-1' AND memory_version = 1`
    ).get() as { content: string; valid_from: string | null; valid_until: string | null };
    const rollback = buildMemoryMutationPlan({
      operation: "rollback",
      projectId: "project-1",
      expectedProjectVersion: 3,
      memoryId: "memory-1",
      expectedMemoryVersion: 3,
      revisionId: "revision-4",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest-4",
      idempotencyKey: "idempotency-key-4",
      content: rollbackTarget.content,
      contentSha256: "content-sha-1",
      validFrom: rollbackTarget.valid_from,
      validUntil: rollbackTarget.valid_until,
      previousAuditHash: "audit-hash-3",
      auditHash: "audit-hash-4",
      now: "2026-07-26T00:03:00.000Z"
    });

    executePlan(database, rollback.statements);
    expect(
      database.prepare(
        `SELECT content, valid_from, valid_until FROM memory_versions
         WHERE revision_id = 'revision-4'`
      ).get()
    ).toEqual({
      content: "Historical claim.",
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: "2026-02-01T00:00:00.000Z"
    });

    const invalidatedCurrent = database.prepare(
      `SELECT content, valid_from, valid_until
       FROM memory_versions WHERE revision_id = 'revision-4'`
    ).get() as { content: string; valid_from: string | null; valid_until: string | null };
    const invalidate = buildMemoryMutationPlan({
      operation: "invalidate",
      projectId: "project-1",
      expectedProjectVersion: 4,
      memoryId: "memory-1",
      expectedMemoryVersion: 4,
      revisionId: "revision-5",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest-5",
      idempotencyKey: "idempotency-key-5",
      content: invalidatedCurrent.content,
      contentSha256: "content-sha-1",
      validFrom: invalidatedCurrent.valid_from,
      validUntil: invalidatedCurrent.valid_until,
      nextStatus: "invalidated",
      previousAuditHash: "audit-hash-4",
      auditHash: "audit-hash-5",
      now: "2026-07-26T00:04:00.000Z"
    });

    executePlan(database, invalidate.statements);
    expect(
      database.prepare(
        `SELECT v.valid_from, v.valid_until, m.status
         FROM memory_versions v JOIN memories m ON m.memory_id = v.memory_id
         WHERE v.revision_id = 'revision-5'`
      ).get()
    ).toEqual({
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: "2026-02-01T00:00:00.000Z",
      status: "invalidated"
    });
  });
});

describe("formal mutation evidence provenance against immutable migrations", () => {
  it("atomically writes new repository-bound evidence and its revision link", () => {
    const database = seededRepositoryMutationDatabase();

    executeRepositoryEvidenceMutation(database, "revision-3", expectedMutationEvidence());

    expect(repositoryMutationSnapshot(database)).toMatchObject({
      project: { project_version: 3, audit_head_hash: "audit-hash-3" },
      memory: {
        current_revision_id: "revision-3",
        memory_version: 3,
        status: "active"
      },
      counts: {
        audit_events: 3,
        memory_versions: 3,
        evidence: 1,
        version_evidence: 1,
        idempotency_records: 1,
        outbox_events: 1
      }
    });
    expect(
      database.prepare(
        `SELECT repository_id, repository_ref, repository_path, repository_authority,
                commit_sha
         FROM evidence`
      ).get()
    ).toEqual({
      repository_id: "repository-a",
      repository_ref: null,
      repository_path: null,
      repository_authority: "agent_supplied",
      commit_sha: "a".repeat(40)
    });
  });

  it("reuses an exact immutable evidence tuple and links the stored evidence identity", () => {
    const evidence = expectedMutationEvidence();
    const database = seededRepositoryMutationDatabase(evidence);

    executeRepositoryEvidenceMutation(database, "revision-3", evidence);

    expect(database.prepare("SELECT count(*) AS count FROM evidence").get()).toEqual({
      count: 1
    });
    expect(
      database.prepare("SELECT evidence_id FROM version_evidence").get()
    ).toEqual({ evidence_id: "existing-evidence" });
    expect(repositoryMutationSnapshot(database)).toMatchObject({
      project: { project_version: 3 },
      memory: { current_revision_id: "revision-3", memory_version: 3 },
      counts: { version_evidence: 1, idempotency_records: 1, outbox_events: 1 }
    });
  });

  it.each([
    {
      name: "commit",
      stored: { ...expectedMutationEvidence(), commitSha: "b".repeat(40) },
      error: /evidence identity is immutable/iu
    },
    {
      name: "repository context",
      stored: { ...expectedMutationEvidence(), repositoryId: "repository-b" },
      error: /evidence repository context is immutable/iu
    }
  ])(
    "rolls back the complete mutation on an immutable $name conflict",
    ({ stored, error }) => {
      const database = seededRepositoryMutationDatabase(stored);
      const before = repositoryMutationSnapshot(database);

      expect(() =>
        executeRepositoryEvidenceMutation(
          database,
          "revision-conflict",
          expectedMutationEvidence()
        )
      ).toThrow(error);

      expect(repositoryMutationSnapshot(database)).toEqual(before);
      expect(
        database.prepare(
          `SELECT commit_sha, repository_id, repository_ref, repository_path,
                  repository_authority
           FROM evidence`
        ).get()
      ).toEqual({
        commit_sha: stored.commitSha,
        repository_id: stored.repositoryId,
        repository_ref: stored.repositoryRef,
        repository_path: null,
        repository_authority: stored.repositoryAuthority
      });
    }
  );

  it("rolls back the complete mutation when evidence is quarantined after preflight", () => {
    const evidence = expectedMutationEvidence();
    const database = seededRepositoryMutationDatabase(evidence);
    database.prepare(
      `UPDATE evidence SET sensitivity_status = 'quarantined'
       WHERE evidence_id = 'existing-evidence'`
    ).run();
    const before = repositoryMutationSnapshot(database);

    expect(() =>
      executeRepositoryEvidenceMutation(database, "revision-quarantined", evidence)
    ).toThrow(/clear evidence is required for a memory version/iu);

    expect(repositoryMutationSnapshot(database)).toEqual(before);
    expect(
      database.prepare(
        `SELECT sensitivity_status FROM evidence WHERE evidence_id = 'existing-evidence'`
      ).get()
    ).toEqual({ sensitivity_status: "quarantined" });
  });
});

function expectedMutationEvidence(): MutationEvidenceRecord {
  return {
    evidenceId: "expected-evidence",
    sourceType: "repository_file",
    locator:
      "repository:repository-a:scope:repository:repository-a:" +
      "repository:repository-b:docs/private.md",
    commitSha: "a".repeat(40),
    excerptHash: "e".repeat(64),
    repositoryId: "repository-a",
    repositoryRef: null,
    repositoryAuthority: "agent_supplied"
  };
}

function executeRepositoryEvidenceMutation(
  database: DatabaseSync,
  revisionId: string,
  evidence: MutationEvidenceRecord
): number[] {
  const mutation = buildMemoryMutationPlan({
    operation: "correct",
    projectId: "project-1",
    expectedProjectVersion: 2,
    memoryId: "memory-repository-a",
    expectedMemoryVersion: 2,
    revisionId,
    actorPrincipalId: "maintainer-1",
    requestDigest: `request-${revisionId}`,
    idempotencyKey: `idempotency-${revisionId}`,
    content: "The repository uses the verified deployment policy.",
    contentSha256: `content-${revisionId}`,
    validFrom: null,
    validUntil: null,
    previousAuditHash: "audit-hash-2",
    auditHash: "audit-hash-3",
    now: "2026-07-28T00:00:00.000Z"
  });
  const evidencePlan = buildMutationEvidencePlan({
    projectId: "project-1",
    expectedProjectVersion: 2,
    revisionId,
    recordedAt: "2026-07-28T00:00:00.000Z",
    evidence: [evidence]
  });
  const statements = [...mutation.statements];
  statements.splice(1, 0, ...evidencePlan.evidenceStatements);
  statements.splice(
    2 + evidencePlan.evidenceStatements.length,
    0,
    ...evidencePlan.linkStatements
  );
  return executePlan(database, statements);
}

function repositoryMutationSnapshot(database: DatabaseSync) {
  return {
    project: database.prepare(
      `SELECT project_version, audit_head_hash FROM projects WHERE project_id = 'project-1'`
    ).get(),
    memory: database.prepare(
      `SELECT current_revision_id, memory_version, status
       FROM memories WHERE memory_id = 'memory-repository-a'`
    ).get(),
    counts: Object.fromEntries(
      [
        "audit_events",
        "memory_versions",
        "evidence",
        "version_evidence",
        "idempotency_records",
        "outbox_events"
      ].map((table) => [
        table,
        Number(
          (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
            count: number | bigint;
          }).count
        )
      ])
    )
  };
}

function seededRepositoryMutationDatabase(
  existingEvidence?: MutationEvidenceRecord
): DatabaseSync {
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
    VALUES
      ('project-1', 'project-ref-1', 'locator-1', 'Project 1', 0,
       '2026-07-27', '2026-07-27');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('maintainer-1', 'test', 'maintainer-1', 'digest-1', '2026-07-27');
    INSERT INTO repositories
      (repository_id, project_id, provider, external_id, owner, name,
       tracked_refs_json, sync_enabled, created_at, updated_at)
    VALUES
      ('repository-a', 'project-1', 'github', 101, 'owner', 'repository-a',
       '[]', 0, '2026-07-27', '2026-07-27'),
      ('repository-b', 'project-1', 'github', 102, 'owner', 'repository-b',
       '[]', 0, '2026-07-27', '2026-07-27');
    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES
      ('grant-1', 'project-1', 'maintainer-1', 'maintainer', 'project',
       'project-1', '2026-07-27');
    INSERT INTO memories
      (memory_id, project_id, current_revision_id, memory_version, kind, memory_class,
       scope, scope_id, status, created_at, updated_at)
    VALUES
      ('memory-repository-a', 'project-1', NULL, 0, 'fact', 'semantic',
       'repository', 'repository-a', 'active', '2026-07-27', '2026-07-27');
    INSERT INTO audit_events
      (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
       previous_event_hash, event_hash, recorded_at)
    VALUES
      ('audit-1', 'project-1', 1, 'seed', 'maintainer-1', 'request-1',
       NULL, 'audit-hash-1', '2026-07-27');
    INSERT INTO memory_versions
      (revision_id, project_id, memory_id, memory_version, content, content_sha256,
       valid_from, valid_until, audit_id, recorded_at)
    VALUES
      ('revision-1', 'project-1', 'memory-repository-a', 1, 'Historical policy.',
       'content-1', NULL, NULL, 'audit-1', '2026-07-27');
    UPDATE memories
      SET current_revision_id = 'revision-1', memory_version = 1
      WHERE memory_id = 'memory-repository-a';
    UPDATE projects
      SET project_version = 1, audit_head_hash = 'audit-hash-1'
      WHERE project_id = 'project-1';
    INSERT INTO audit_events
      (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
       previous_event_hash, event_hash, recorded_at)
    VALUES
      ('audit-2', 'project-1', 2, 'seed', 'maintainer-1', 'request-2',
       'audit-hash-1', 'audit-hash-2', '2026-07-27');
    INSERT INTO memory_versions
      (revision_id, project_id, memory_id, memory_version, content, content_sha256,
       valid_from, valid_until, audit_id, recorded_at)
    VALUES
      ('revision-2', 'project-1', 'memory-repository-a', 2, 'Current policy.',
       'content-2', NULL, NULL, 'audit-2', '2026-07-27');
    UPDATE memories
      SET current_revision_id = 'revision-2', memory_version = 2
      WHERE memory_id = 'memory-repository-a';
    UPDATE projects
      SET project_version = 2, audit_head_hash = 'audit-hash-2'
      WHERE project_id = 'project-1';
  `);
  if (existingEvidence !== undefined) {
    database.prepare(
      `INSERT INTO evidence
       (evidence_id, project_id, source_type, locator, commit_sha, excerpt_hash,
        sensitivity_status, recorded_at, repository_id, repository_ref,
        repository_path, repository_authority)
       VALUES ('existing-evidence', 'project-1', ?, ?, ?, ?, 'clear',
               '2026-07-27', ?, ?, NULL, ?)`
    ).run(
      existingEvidence.sourceType,
      existingEvidence.locator,
      existingEvidence.commitSha,
      existingEvidence.excerptHash,
      existingEvidence.repositoryId,
      existingEvidence.repositoryRef,
      existingEvidence.repositoryAuthority
    );
  }
  return database;
}

function seededDatabase(): DatabaseSync {
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
    VALUES
      ('project-1', 'project-ref-1', 'locator-1', 'Project 1', 0, '2026-07-25', '2026-07-25');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('maintainer-1', 'test', 'maintainer-1', 'digest-1', '2026-07-25');
    INSERT INTO repositories
      (repository_id, project_id, provider, external_id, owner, name,
       tracked_refs_json, sync_enabled, created_at, updated_at)
    VALUES
      ('repository-1', 'project-1', 'github', 101, 'owner', 'repository-1',
       '[]', 0, '2026-07-25', '2026-07-25');
    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES
      ('grant-1', 'project-1', 'maintainer-1', 'maintainer', 'project',
       'project-1', '2026-07-25');
    INSERT INTO sessions
      (session_id, project_id, principal_id, session_version, status,
       agent_meta_json, worktree_meta_json, repository_id, repository_ref,
       worktree_id, opened_at)
    VALUES
      ('session-1', 'project-1', 'maintainer-1', 1, 'open', '{}',
       '{"repository_id":"repository-1","repository_ref":"refs/heads/main","worktree_id":"worktree-1"}',
       'repository-1', 'refs/heads/main', 'worktree-1', '2026-07-25');
    INSERT INTO observations
      (observation_id, project_id, session_id, principal_id, candidate_version,
       status, content, content_sha256, created_at)
    VALUES
      ('candidate-1', 'project-1', 'session-1', 'maintainer-1', 1,
       'pending_review', 'D1 is authoritative.', 'content-sha', '2026-07-25');
    INSERT INTO evidence
      (evidence_id, project_id, source_type, locator, repository_id, excerpt_hash,
       sensitivity_status, recorded_at, repository_ref, repository_authority)
    VALUES
      ('evidence-1', 'project-1', 'maintainer', 'memory://candidate/candidate-1',
       'repository-1', 'excerpt-sha', 'clear', '2026-07-25', 'refs/heads/main',
       'agent_supplied');
    INSERT INTO observation_evidence
      (project_id, observation_id, evidence_id, created_at)
    VALUES
      ('project-1', 'candidate-1', 'evidence-1', '2026-07-25');
    INSERT INTO review_requests
      (review_request_id, project_id, candidate_id, status, required_role, created_at, updated_at)
    VALUES
      ('review-1', 'project-1', 'candidate-1', 'pending', 'maintainer',
       '2026-07-25', '2026-07-25');
  `);
  return database;
}

function seededMemoryDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("migrations/0001_initial.sql", "utf8"));
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
    VALUES
      ('project-1', 'project-ref-1', 'locator-1', 'Project 1', 0,
       '2026-07-25', '2026-07-25');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('maintainer-1', 'test', 'maintainer-1', 'digest-1', '2026-07-25');
    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES
      ('grant-1', 'project-1', 'maintainer-1', 'maintainer', 'project',
       'project-1', '2026-07-25');
    INSERT INTO audit_events
      (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
       previous_event_hash, event_hash, recorded_at)
    VALUES
      ('audit-1', 'project-1', 1, 'seed', 'maintainer-1', 'request-digest-1',
       NULL, 'audit-hash-1', '2026-07-25');
    INSERT INTO memories
      (memory_id, project_id, current_revision_id, memory_version, kind, memory_class,
       scope, scope_id, status, created_at, updated_at)
    VALUES
      ('memory-1', 'project-1', NULL, 0, 'fact', 'semantic', 'project',
       'project-1', 'active', '2026-07-25', '2026-07-25');
    INSERT INTO memory_versions
      (revision_id, project_id, memory_id, memory_version, content, content_sha256,
       valid_from, valid_until, audit_id, recorded_at)
    VALUES
      ('revision-1', 'project-1', 'memory-1', 1, 'Historical claim.', 'content-sha-1',
       '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
       'audit-1', '2026-07-25');
    UPDATE memories
      SET current_revision_id = 'revision-1', memory_version = 1
      WHERE memory_id = 'memory-1';
    UPDATE projects
      SET project_version = 1, audit_head_hash = 'audit-hash-1'
      WHERE project_id = 'project-1';
    INSERT INTO audit_events
      (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
       previous_event_hash, event_hash, recorded_at)
    VALUES
      ('audit-2', 'project-1', 2, 'seed', 'maintainer-1', 'request-digest-2',
       'audit-hash-1', 'audit-hash-2', '2026-07-25');
    INSERT INTO memory_versions
      (revision_id, project_id, memory_id, memory_version, content, content_sha256,
       valid_from, valid_until, audit_id, recorded_at)
    VALUES
      ('revision-2', 'project-1', 'memory-1', 2, 'Current claim.', 'content-sha-2',
       '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z',
       'audit-2', '2026-07-25');
    UPDATE memories
      SET current_revision_id = 'revision-2', memory_version = 2
      WHERE memory_id = 'memory-1';
    UPDATE projects
      SET project_version = 2, audit_head_hash = 'audit-hash-2'
      WHERE project_id = 'project-1';
  `);
  return database;
}

function executePlan(database: DatabaseSync, statements: readonly SqlStatement[]): number[] {
  database.exec("BEGIN IMMEDIATE");
  try {
    const changes = statements.map((statement) => {
      const result = database.prepare(statement.sql).run(...sqlBindings(statement.bindings));
      return Number(result.changes);
    });
    database.exec("COMMIT");
    return changes;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function sqlBindings(bindings: readonly unknown[]): SQLInputValue[] {
  return bindings.map((binding) => {
    if (
      binding === null ||
      typeof binding === "string" ||
      typeof binding === "number" ||
      typeof binding === "bigint" ||
      binding instanceof Uint8Array
    ) {
      return binding;
    }
    throw new TypeError("Unsupported SQL binding in test plan.");
  });
}
