import { describe, expect, it } from "vitest";
import { GatewayService, type GatewayEnv } from "../src/gateway/service";
import type { AuthenticatedPrincipal } from "../src/security/auth";

const principal: AuthenticatedPrincipal = {
  principalId: "principal-1",
  projectId: "project-1",
  role: "maintainer"
};

describe("GatewayService mutation authorization", () => {
  it.each([
    [
      "session_open",
      1,
      (service: GatewayService) =>
        service.openSession({ projectRef: "project:one", agentMeta: { name: "test" } })
    ],
    [
      "memory_change_submit",
      2,
      (service: GatewayService) => service.submitMemoryChange({ operation: "invalidate" })
    ],
    [
      "candidate_review",
      2,
      (service: GatewayService) =>
        service.reviewCandidate({
          candidateId: "candidate-1",
          expectedCandidateVersion: 1,
          decision: "reject",
          reason: "Not durable.",
          idempotencyKey: "review-key"
        })
    ]
  ])(
    "denies %s when a high inherited role has no project-scope grant",
    async (_operation, minimumRank, invoke) => {
      const statements: Array<{ sql: string; bindings: unknown[] }> = [];
      const database = {
        withSession(consistency: string) {
          expect(consistency).toBe("first-primary");
          return {
            prepare(sql: string) {
              const statement = { sql, bindings: [] as unknown[] };
              statements.push(statement);
              return {
                bind(...bindings: unknown[]) {
                  statement.bindings = bindings;
                  return this;
                },
                async first() {
                  return null;
                }
              };
            }
          };
        }
      } as unknown as D1Database;
      const service = new GatewayService(
        { MEMORY_DB: database } as unknown as GatewayEnv,
        principal
      );

      await expect(invoke(service)).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
      expect(statements).toHaveLength(1);
      expect(statements[0]?.sql).toContain("scope_kind = 'project'");
      expect(statements[0]?.bindings).toEqual([
        "project-1",
        "principal-1",
        "project-1",
        minimumRank
      ]);
    }
  );
});
