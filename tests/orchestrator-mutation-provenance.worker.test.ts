import { describe, expect, it, vi } from "vitest";
import { ProjectCoordinator } from "../workers/memory-orchestrator/index";

const PROJECT_ID = "project-1";
const TARGET_MEMORY_ID = "00000000-0000-4000-8000-000000000010";

type Operation = "correct" | "invalidate" | "rollback";

describe("formal memory mutation repository provenance", () => {
  it.each(["correct", "invalidate", "rollback"] as const)(
    "binds %s evidence to the server-verified target repository",
    async (operation) => {
      const database = new MutationProvenanceDatabase("repository-a");
      const response = await invoke(database, mutationRequest(operation, "repository-a"));

      expect(response.status).toBe(200);
      expect(database.batches).toHaveLength(1);
      const evidence = requiredStatement(database, "INSERT INTO evidence");
      const link = requiredStatement(database, "INSERT INTO version_evidence");
      expect(evidence.sql).toContain(
        "ON CONFLICT(project_id, source_type, locator, excerpt_hash) DO UPDATE SET"
      );
      const locator =
        "repository:repository-a:scope:repository:repository-a:" +
        "repository:repository-b:docs/private.md";
      expect(evidence.bindings[3]).toBe(locator);
      expect(evidence.bindings.slice(7, 10)).toEqual([
        "repository-a",
        null,
        "agent_supplied"
      ]);
      expect(link.bindings[4]).toBe(locator);
      expect(link.bindings.slice(7, 10)).toEqual([
        "repository-a",
        null,
        "agent_supplied"
      ]);
    }
  );

  it.each(["correct", "invalidate", "rollback"] as const)(
    "rejects forged repository B context for repository A %s with no writes",
    async (operation) => {
      const database = new MutationProvenanceDatabase("repository-a");
      const response = await invoke(database, mutationRequest(operation, "repository-b"));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "The target memory repository context is invalid."
      });
      expect(database.batches).toHaveLength(0);
      expect(database.runCalls).toHaveLength(0);
      expect(
        database.reads.find((read) => read.sql.includes("FROM memories AS memory_record"))
          ?.bindings
      ).toEqual([PROJECT_ID, TARGET_MEMORY_ID]);
    }
  );

  it("uses distinct server namespaces for identical evidence in two repositories", async () => {
    const repositoryA = new MutationProvenanceDatabase("repository-a");
    const repositoryB = new MutationProvenanceDatabase("repository-b");

    expect((await invoke(repositoryA, mutationRequest("correct", "repository-a"))).status).toBe(
      200
    );
    expect((await invoke(repositoryB, mutationRequest("correct", "repository-b"))).status).toBe(
      200
    );

    const evidenceA = requiredStatement(repositoryA, "INSERT INTO evidence");
    const evidenceB = requiredStatement(repositoryB, "INSERT INTO evidence");
    expect(evidenceA.bindings[3]).not.toBe(evidenceB.bindings[3]);
    expect(evidenceA.bindings[0]).not.toBe(evidenceB.bindings[0]);
  });

  it("keeps project memory evidence explicitly contextless", async () => {
    const database = new MutationProvenanceDatabase(null);
    const response = await invoke(database, mutationRequest("correct", null));

    expect(response.status).toBe(200);
    const evidence = requiredStatement(database, "INSERT INTO evidence");
    const link = requiredStatement(database, "INSERT INTO version_evidence");
    expect(evidence.bindings[3]).toBe(
      "project:project-1:scope:project:project-1:" +
        "repository:repository-b:docs/private.md"
    );
    expect(evidence.bindings.slice(7, 10)).toEqual([null, null, null]);
    expect(link.bindings.slice(7, 10)).toEqual([null, null, null]);
  });

  it("rejects repository context for a project-scoped target with no writes", async () => {
    const database = new MutationProvenanceDatabase(null);
    const response = await invoke(database, mutationRequest("correct", "repository-b"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(database.batches).toHaveLength(0);
    expect(database.runCalls).toHaveLength(0);
  });

  it("derives safe provenance when an older gateway omits the internal context", async () => {
    const database = new MutationProvenanceDatabase("repository-a");
    const currentGateway = new MutationProvenanceDatabase("repository-a");
    const request = mutationRequest("correct", "repository-a");
    const body = (await request.json()) as Record<string, unknown>;
    delete body.target_repository_context;

    const response = await invoke(
      database,
      new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    );

    expect(response.status).toBe(200);
    const evidence = requiredStatement(database, "INSERT INTO evidence");
    expect(evidence.bindings.slice(7, 10)).toEqual([
      "repository-a",
      null,
      "agent_supplied"
    ]);
    expect(
      (await invoke(currentGateway, mutationRequest("correct", "repository-a"))).status
    ).toBe(200);
    expect(requiredStatement(database, "INSERT INTO audit_events").bindings[5]).toBe(
      requiredStatement(currentGateway, "INSERT INTO audit_events").bindings[5]
    );
  });

  it.each([
    {
      name: "commit",
      commit_sha: "b".repeat(40),
      repository_id: "repository-a"
    },
    {
      name: "repository context",
      commit_sha: "a".repeat(40),
      repository_id: "repository-b"
    }
  ])(
    "rejects an existing immutable evidence $name conflict before the batch",
    async ({ commit_sha, repository_id }) => {
      const database = new MutationProvenanceDatabase("repository-a", {
        commit_sha,
        repository_id,
        repository_ref: null,
        repository_path: null,
        repository_authority: "agent_supplied",
        sensitivity_status: "clear"
      });
      const response = await invoke(
        database,
        mutationRequest("correct", "repository-a", "a".repeat(40))
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        code: "VALIDATION_FAILED",
        message: "The submitted evidence conflicts with existing immutable provenance."
      });
      expect(database.batches).toHaveLength(0);
      expect(database.runCalls).toHaveLength(0);
    }
  );

  it.each([
    "evidence identity is immutable",
    "evidence repository context is immutable"
  ])("maps an atomic evidence race abort to deterministic validation: %s", async (message) => {
    const database = new MutationProvenanceDatabase(
      "repository-a",
      null,
      new Error(message)
    );
    const response = await invoke(database, mutationRequest("correct", "repository-a"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "The submitted evidence conflicts with existing immutable provenance."
    });
  });
});

async function invoke(
  database: MutationProvenanceDatabase,
  request: Request
): Promise<Response> {
  const coordinator = Object.assign(Object.create(ProjectCoordinator.prototype), {
    env: {
      MEMORY_DB: database,
      SEARCH_DB: {},
      PROJECTIONS: {},
      MEMORY_VECTORS: {},
      AI: {},
      MEMORY_WORKFLOW: { create: vi.fn(), get: vi.fn() },
      MEMORY_OUTBOX: {}
    }
  });
  return ProjectCoordinator.prototype.fetch.call(coordinator, request);
}

function mutationRequest(
  operation: Operation,
  repositoryId: string | null,
  commitSha?: string
): Request {
  const projectScope = repositoryId === null;
  return new Request("https://project-coordinator/mutate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation,
      target_memory_id: TARGET_MEMORY_ID,
      expected_memory_version: 2,
      expected_project_version: 7,
      project_id: PROJECT_ID,
      actor_principal_id: "maintainer-1",
      payload:
        operation === "correct"
          ? { content: "The target repository uses a verified deployment policy." }
          : operation === "rollback"
            ? { memory_version: 1 }
            : {},
      evidence: [
        {
          source_type: "repository_file",
          locator: "repository:repository-b:docs/private.md",
          ...(commitSha === undefined ? {} : { commit_sha: commitSha }),
          repository_id: "repository-b",
          repository_ref: "refs/heads/private"
        }
      ],
      target_repository_context: {
        scope: projectScope ? "project" : "repository",
        scope_id: projectScope ? PROJECT_ID : repositoryId,
        repository_id: repositoryId,
        repository_ref: null,
        session_id: null,
        worktree_id: null
      },
      idempotency_key: `mutation-provenance-${operation}-${repositoryId ?? "project"}`
    })
  });
}

interface CapturedStatement {
  sql: string;
  bindings: unknown[];
}

class MutationProvenanceDatabase {
  readonly batches: CapturedStatement[][] = [];
  readonly reads: CapturedStatement[] = [];
  readonly runCalls: CapturedStatement[] = [];

  constructor(
    private readonly targetRepositoryId: string | null,
    private readonly storedEvidence: StoredEvidence | null = null,
    private readonly batchError: Error | null = null
  ) {}

  withSession(_constraint: "first-primary"): MutationProvenanceDatabase {
    return this;
  }

  prepare(sql: string) {
    const database = this;
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
        database.reads.push({ sql, bindings: [...statement.bindings] });
        if (sql.includes("FROM project_grants grant_row")) {
          expect(statement.bindings).toEqual([PROJECT_ID, "maintainer-1", PROJECT_ID]);
          return { authorized: 1 };
        }
        if (sql.includes("FROM memories AS memory_record")) {
          expect(statement.bindings).toEqual([PROJECT_ID, TARGET_MEMORY_ID]);
          return database.targetRepositoryId === null
            ? { scope: "project", scope_id: PROJECT_ID, repository_id: null }
            : {
                scope: "repository",
                scope_id: database.targetRepositoryId,
                repository_id: database.targetRepositoryId
              };
        }
        if (sql.includes("FROM repositories")) {
          expect(statement.bindings).toEqual([PROJECT_ID, database.targetRepositoryId]);
          return database.targetRepositoryId === null
            ? null
            : { repository_id: database.targetRepositoryId };
        }
        if (sql.includes("FROM idempotency_records")) {
          return null;
        }
        if (sql.includes("FROM evidence")) {
          return database.storedEvidence;
        }
        if (sql.includes("FROM projects p JOIN memories m")) {
          expect(statement.bindings).toEqual([PROJECT_ID, TARGET_MEMORY_ID]);
          return {
            project_version: 7,
            audit_head_hash: null,
            memory_version: 2,
            content: "Current repository policy.",
            valid_from: null,
            valid_until: null
          };
        }
        if (sql.includes("FROM memory_versions")) {
          expect(statement.bindings).toEqual([PROJECT_ID, TARGET_MEMORY_ID, 1]);
          return {
            content: "Historical repository policy.",
            valid_from: null,
            valid_until: null
          };
        }
        return null;
      },
      async run() {
        database.runCalls.push({ sql, bindings: [...statement.bindings] });
        return { meta: { changes: 1 } };
      }
    };
  }

  async batch(statements: CapturedStatement[]) {
    this.batches.push(
      statements.map((statement) => ({
        sql: statement.sql,
        bindings: [...statement.bindings]
      }))
    );
    if (this.batchError !== null) {
      throw this.batchError;
    }
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

interface StoredEvidence {
  commit_sha: string | null;
  repository_id: string | null;
  repository_ref: string | null;
  repository_path: string | null;
  repository_authority: string | null;
  sensitivity_status: string;
}

function requiredStatement(
  database: MutationProvenanceDatabase,
  sqlFragment: string
): CapturedStatement {
  const statement = database.batches[0]?.find((item) => item.sql.includes(sqlFragment));
  if (statement === undefined) {
    throw new Error(`Missing statement: ${sqlFragment}`);
  }
  return statement;
}
