import { describe, expect, it, vi } from "vitest";
import {
  createRefScopeId,
  createWorktreeScopeId
} from "../src/contracts/scope";
import {
  projectionScopeIndexKey,
  type ProjectionMemory
} from "../src/projection/markdown";
import { buildProjectionSnapshotPlan } from "../src/projection/snapshot";
import { ProjectCoordinator } from "../workers/memory-orchestrator/index";

const PROJECT_ID = "project-1";
const PROJECT_VERSION = 1;
const SNAPSHOT_ID = "1";

const MEMORY: ProjectionMemory = {
  projectId: PROJECT_ID,
  projectVersion: PROJECT_VERSION,
  snapshotId: SNAPSHOT_ID,
  memoryId: "memory-1",
  revisionId: "revision-1",
  memoryVersion: 1,
  kind: "fact",
  memoryClass: "semantic",
  scope: "repository",
  scopeId: "repository-a",
  status: "active",
  validFrom: null,
  validUntil: null,
  evidenceIds: ["evidence-a"],
  content: "Repository A uses pnpm."
};

describe("R2 projection scope key admission", () => {
  it("builds a regular scope index key from the complete snapshot prefix", () => {
    expect(projectionScopeIndexKey(PROJECT_ID, SNAPSHOT_ID, "repository/42")).toBe(
      "projects/project-1/projections/1/indexes/by-scope/repository%2F42/index.json"
    );
  });

  it("accepts exactly 1,024 UTF-8 bytes and rejects 1,025 bytes", async () => {
    const boundaryScopeId = asciiScopeIdForProjectionKeyBytes(1_024);
    const boundaryKey = projectionScopeIndexKey(
      PROJECT_ID,
      SNAPSHOT_ID,
      boundaryScopeId
    );
    expect(new TextEncoder().encode(boundaryKey).byteLength).toBe(1_024);

    const boundaryMemory = { ...MEMORY, scopeId: boundaryScopeId };
    const plan = await buildProjectionSnapshotPlan({
      projectId: PROJECT_ID,
      projectVersion: PROJECT_VERSION,
      snapshotId: SNAPSHOT_ID,
      heads: [boundaryMemory],
      revisions: [boundaryMemory]
    });
    expect(plan.writes.some((write) => write.key === boundaryKey)).toBe(true);

    expect(() =>
      projectionScopeIndexKey(PROJECT_ID, SNAPSHOT_ID, `${boundaryScopeId}a`)
    ).toThrow("Projection scope index key is 1025 UTF-8 bytes");
  });

  it.each([
    [
      "Git ref",
      createRefScopeId("repository-a", `refs/heads/${"界".repeat(61)}`)
    ],
    [
      "worktree",
      createWorktreeScopeId("session-a", `worktree/${"🚀".repeat(46)}`)
    ]
  ])(
    "rejects a long %s scope using the encoded full key byte length",
    async (_label, scopeId) => {
      const memory = { ...MEMORY, scopeId };
      await expect(
        buildProjectionSnapshotPlan({
          projectId: PROJECT_ID,
          projectVersion: PROJECT_VERSION,
          snapshotId: SNAPSHOT_ID,
          heads: [memory],
          revisions: [memory]
        })
      ).rejects.toThrow(/R2 allows at most 1024 bytes/u);
    }
  );

  it.each([
    {
      label: "repository",
      scope: "repository",
      scopeId: `${asciiScopeIdForProjectionKeyBytes(1_024)}a`
    },
    {
      label: "Git ref",
      scope: "ref",
      scopeId: createRefScopeId(
        "repository-a",
        `refs/heads/${"界".repeat(61)}`
      )
    },
    {
      label: "worktree",
      scope: "worktree",
      scopeId: createWorktreeScopeId(
        "session-a",
        `worktree/${"🚀".repeat(46)}`
      )
    }
  ] as const)(
    "rejects an oversized $label key before candidate promotion writes",
    async ({ scope, scopeId }) => {
      const database = new CandidateAdmissionDatabase();
      const coordinator = Object.assign(Object.create(ProjectCoordinator.prototype), {
        env: candidateEnvironment(database)
      });
      const response = await ProjectCoordinator.prototype.fetch.call(
        coordinator,
        candidateReviewRequest(scope, scopeId)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringMatching(/R2 allows at most 1024 bytes/u)
      });
      expect(database.batches).toHaveLength(0);
    }
  );
});

function asciiScopeIdForProjectionKeyBytes(targetBytes: number): string {
  const oneByteScopeKey = projectionScopeIndexKey(PROJECT_ID, SNAPSHOT_ID, "a");
  const fixedKeyBytes = new TextEncoder().encode(oneByteScopeKey).byteLength - 1;
  return "a".repeat(targetBytes - fixedKeyBytes);
}

function candidateReviewRequest(
  scope: "repository" | "ref" | "worktree",
  scopeId: string
): Request {
  return new Request("https://project-coordinator/candidate-review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidate_id: "00000000-0000-4000-8000-000000000001",
      expected_candidate_version: 1,
      decision: "approve",
      reason: "The repository provenance is verified.",
      edits: {
        kind: "fact",
        memory_class: "semantic",
        scope,
        scope_id: scopeId
      },
      idempotency_key: `projection-key-${scope}`,
      project_id: PROJECT_ID,
      actor_principal_id: "maintainer-1"
    })
  });
}

function candidateEnvironment(database: CandidateAdmissionDatabase) {
  return {
    MEMORY_DB: database,
    SEARCH_DB: {},
    PROJECTIONS: {},
    MEMORY_VECTORS: {},
    AI: {},
    MEMORY_WORKFLOW: {
      create: vi.fn(),
      get: vi.fn()
    },
    MEMORY_OUTBOX: {}
  };
}

interface CapturedStatement {
  sql: string;
  bindings: unknown[];
}

class CandidateAdmissionDatabase {
  readonly batches: CapturedStatement[][] = [];

  withSession(_constraint: "first-primary"): CandidateAdmissionDatabase {
    return this;
  }

  prepare(sql: string) {
    const statement: CapturedStatement = { sql, bindings: [] };
    return {
      get sql() {
        return statement.sql;
      },
      get bindings() {
        return statement.bindings;
      },
      bind(...bindings: unknown[]) {
        statement.bindings = bindings;
        return this;
      },
      async first() {
        if (sql.includes("FROM project_grants grant_row")) {
          return { authorized: 1 };
        }
        if (sql.includes("FROM idempotency_records")) {
          return null;
        }
        if (sql.includes("JOIN observations o")) {
          return {
            project_version: 0,
            audit_head_hash: null,
            candidate_version: 1,
            status: "pending_review",
            content: "Repository A uses pnpm.",
            reviewed_content: null,
            kind: "fact",
            memory_class: "semantic",
            scope: "repository",
            scope_id: "repository-a",
            valid_from: null,
            valid_until: null,
            session_id: "session-a",
            session_repository_id: "repository-a",
            session_repository_ref: "refs/heads/main",
            session_worktree_id: "worktree-a",
            analysis_json: JSON.stringify({
              persistent_value: true,
              evidence_source_ids: ["evidence-a"]
            }),
            review_request_id: "review-1"
          };
        }
        return null;
      },
      async all() {
        return { results: [] };
      }
    };
  }

  async batch(statements: CapturedStatement[]) {
    this.batches.push(statements);
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}
