import { describe, expect, it } from "vitest";
import { buildMemoryMutationPlan } from "../src/storage/mutation-plan";

describe("formal memory mutation plan", () => {
  it("conditions every authoritative write on the expected project version", () => {
    const plan = buildMemoryMutationPlan({
      operation: "correct",
      projectId: "project-1",
      expectedProjectVersion: 5,
      memoryId: "memory-1",
      expectedMemoryVersion: 2,
      revisionId: "revision-3",
      actorPrincipalId: "principal-1",
      requestDigest: "request-digest",
      content: "Corrected claim.",
      contentSha256: "content-sha",
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
      now: "2026-07-25T00:00:00.000Z"
    });

    expect(plan.nextProjectVersion).toBe(6);
    expect(plan.nextMemoryVersion).toBe(3);
    expect(plan.statements.length).toBeGreaterThanOrEqual(5);
    for (const statement of plan.statements) {
      expect(statement.sql).toContain("project_version = ?");
      expect(statement.bindings).toContain(5);
    }
    const revision = plan.statements.find((statement) =>
      statement.sql.includes("INSERT INTO memory_versions")
    );
    expect(revision?.bindings).toContain("2026-07-01T00:00:00.000Z");
    expect(revision?.bindings).toContain("2026-08-01T00:00:00.000Z");
  });
});
