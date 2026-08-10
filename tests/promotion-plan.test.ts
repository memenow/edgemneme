import { describe, expect, it } from "vitest";
import { buildCandidatePromotionPlan } from "../src/storage/promotion-plan";

describe("candidate promotion plan", () => {
  it("creates one guarded formal-memory commit from an approved review", () => {
    const plan = buildCandidatePromotionPlan({
      projectId: "project-1",
      expectedProjectVersion: 7,
      candidateId: "candidate-1",
      expectedCandidateVersion: 2,
      reviewRequestId: "review-1",
      decisionId: "decision-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest",
      idempotencyKey: "idempotency-key",
      reason: "Verified by the maintainer.",
      content: "The project uses pnpm.",
      contentSha256: "content-sha",
      kind: "fact",
      memoryClass: "semantic",
      scope: "project",
      scopeId: "project-1",
      evidence: [
        {
          evidenceId: "evidence-1",
          sourceType: "maintainer",
          locator: "memory://candidate/candidate-1",
          excerptHash: "excerpt-hash"
        }
      ],
      previousAuditHash: "audit-7",
      auditHash: "audit-8",
      now: "2026-07-26T00:00:00.000Z"
    });

    expect(plan.nextProjectVersion).toBe(8);
    expect(plan.nextCandidateVersion).toBe(3);
    expect(plan.response).toEqual({
      candidate_id: "candidate-1",
      candidate_version: 3,
      status: "promoted",
      memory_id: "memory-1",
      memory_version: 1,
      revision_id: "revision-1",
      project_version: 8
    });
    expect(plan.statements.some((statement) => statement.sql.includes("INSERT INTO memories"))).toBe(
      true
    );
    expect(
      plan.statements.some((statement) => statement.sql.includes("INSERT INTO memory_versions"))
    ).toBe(true);
    expect(
      plan.statements.some((statement) => statement.sql.includes("INSERT INTO audit_events"))
    ).toBe(true);
    expect(
      plan.statements.some((statement) => statement.sql.includes("INSERT INTO outbox_events"))
    ).toBe(true);
    for (const statement of plan.statements) {
      expect(statement.sql).toContain("project_version = ?");
      expect(statement.bindings).toContain(7);
    }
  });

  it("carries temporal validity into the immutable first revision", () => {
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
      content: "Temporary convention.",
      contentSha256: "content-sha",
      kind: "convention",
      memoryClass: "semantic",
      scope: "ref",
      scopeId: "refs/heads/feature",
      repositoryId: "repository-1",
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
      evidence: [
        {
          evidenceId: "evidence-1",
          sourceType: "maintainer",
          locator: "memory://candidate/candidate-1",
          excerptHash: "excerpt-hash"
        }
      ],
      previousAuditHash: null,
      auditHash: "audit-1",
      now: "2026-07-26T00:00:00.000Z"
    });

    const revision = plan.statements.find((statement) =>
      statement.sql.includes("INSERT INTO memory_versions")
    );
    expect(revision?.bindings).toContain("2026-07-01T00:00:00.000Z");
    expect(revision?.bindings).toContain("2026-08-01T00:00:00.000Z");
  });

  it("writes a guarded repository context for every non-project memory", () => {
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
      content: "This repository uses pnpm.",
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
          excerptHash: "excerpt-hash",
          repositoryId: "repository-1",
          repositoryAuthority: "agent_supplied"
        }
      ],
      previousAuditHash: null,
      auditHash: "audit-1",
      now: "2026-07-26T00:00:00.000Z"
    });

    const memoryInsertIndex = plan.statements.findIndex((statement) =>
      statement.sql.includes("INSERT INTO memories")
    );
    const contextInsertIndex = plan.statements.findIndex((statement) =>
      statement.sql.includes("INSERT INTO memory_repository_contexts")
    );
    const revisionInsertIndex = plan.statements.findIndex((statement) =>
      statement.sql.includes("INSERT INTO memory_versions")
    );

    expect(contextInsertIndex).toBeGreaterThan(memoryInsertIndex);
    expect(contextInsertIndex).toBeLessThan(revisionInsertIndex);
    expect(plan.statements[contextInsertIndex]?.bindings).toContain("repository-1");
    expect(plan.statements[contextInsertIndex]?.sql).toContain("project_version = ?");
  });

  it("rejects missing or contradictory repository context", () => {
    const base = {
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
      content: "This repository uses pnpm.",
      contentSha256: "content-sha",
      kind: "fact" as const,
      memoryClass: "semantic" as const,
      scope: "repository" as const,
      scopeId: "repository-1",
      evidence: [
        {
          evidenceId: "evidence-1",
          sourceType: "maintainer",
          locator: "memory://candidate/candidate-1",
          excerptHash: "excerpt-hash"
        }
      ],
      previousAuditHash: null,
      auditHash: "audit-1",
      now: "2026-07-26T00:00:00.000Z"
    };

    expect(() => buildCandidatePromotionPlan(base)).toThrow(
      "Non-project promotion requires a repository context."
    );
    expect(() =>
      buildCandidatePromotionPlan({ ...base, repositoryId: "repository-2" })
    ).toThrow("Repository scope must match its repository context.");
    expect(() =>
      buildCandidatePromotionPlan({
        ...base,
        scope: "project",
        scopeId: "project-1",
        repositoryId: "repository-1"
      })
    ).toThrow("Project promotion cannot have a repository context.");
  });
});
