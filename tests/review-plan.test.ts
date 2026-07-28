import { describe, expect, it } from "vitest";
import { buildCandidateReviewPlan } from "../src/storage/review-plan";

describe("candidate review plan", () => {
  it.each(["reject", "request_changes"] as const)(
    "records an immutable audited %s decision",
    (decision) => {
      const plan = buildCandidateReviewPlan({
        projectId: "project-1",
        expectedProjectVersion: 4,
        candidateId: "candidate-1",
        expectedCandidateVersion: 2,
        reviewRequestId: "review-1",
        decisionId: "decision-1",
        actorPrincipalId: "maintainer-1",
        requestDigest: "request-digest",
        idempotencyKey: "idempotency-key",
        decision,
        reason: "The evidence is insufficient.",
        previousAuditHash: "audit-4",
        auditHash: "audit-5",
        now: "2026-07-26T00:00:00.000Z"
      });

      expect(plan.nextProjectVersion).toBe(5);
      expect(plan.nextCandidateVersion).toBe(3);
      expect(plan.response.status).toBe(
        decision === "reject" ? "rejected" : "request_changes"
      );
      expect(
        plan.statements.some((statement) => statement.sql.includes("INSERT INTO review_decisions"))
      ).toBe(true);
      expect(
        plan.statements.some((statement) => statement.sql.includes("INSERT INTO audit_events"))
      ).toBe(true);
      expect(
        plan.statements.some((statement) => statement.sql.includes("INSERT INTO outbox_events"))
      ).toBe(true);
      for (const statement of plan.statements) {
        expect(statement.sql).toContain("project_version = ?");
        expect(statement.bindings).toContain(4);
      }
    }
  );

  it("keeps structured review edits out of candidate content", () => {
    const plan = buildCandidateReviewPlan({
      projectId: "project-1",
      expectedProjectVersion: 4,
      candidateId: "candidate-1",
      expectedCandidateVersion: 2,
      reviewRequestId: "review-1",
      decisionId: "decision-1",
      actorPrincipalId: "maintainer-1",
      requestDigest: "request-digest",
      idempotencyKey: "idempotency-key",
      decision: "request_changes",
      reason: "Use repository scope.",
      editsJson: '{"scope":"repository","scope_id":"repository-1"}',
      reviewedContent: "The corrected candidate body.",
      previousAuditHash: "audit-4",
      auditHash: "audit-5",
      now: "2026-07-26T00:00:00.000Z"
    });

    const observationUpdate = plan.statements.find((statement) =>
      statement.sql.includes("UPDATE observations")
    );
    expect(observationUpdate?.bindings).toContain("The corrected candidate body.");
    expect(observationUpdate?.bindings).not.toContain(
      '{"scope":"repository","scope_id":"repository-1"}'
    );
    const decisionInsert = plan.statements.find((statement) =>
      statement.sql.includes("INSERT INTO review_decisions")
    );
    expect(decisionInsert?.bindings).toContain(
      '{"scope":"repository","scope_id":"repository-1"}'
    );
  });
});
