import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  authenticateProjectBearer,
  hasMemoryRole,
  hasRepositoryRole,
  hierarchicalMemoryAccessPredicate,
  requireMemoryRole,
  requireProjectRole,
  requireRepositoryRole,
  requireRole,
  validateOrigin
} from "../src/security/auth";

describe("authorization policy", () => {
  const reader = {
    principalId: "principal-1",
    projectId: "project-1",
    role: "reader" as const
  };

  it("permits a missing Origin for non-browser MCP clients", () => {
    expect(() =>
      validateOrigin(new Request("https://memory.example/mcp"), "https://console.example")
    ).not.toThrow();
  });

  it("allows only an exact configured browser Origin", () => {
    const request = new Request("https://memory.example/mcp", {
      headers: { Origin: "https://console.example" }
    });
    expect(() => validateOrigin(request, "https://console.example")).not.toThrow();
    expect(() => validateOrigin(request, "https://evil.example")).toThrowError(
      expect.objectContaining({ code: "UNAUTHENTICATED" })
    );
  });

  it("enforces reader, writer, and maintainer ordering", () => {
    expect(() => requireRole(reader, "reader")).not.toThrow();
    expect(() => requireRole(reader, "writer")).toThrowError(
      expect.objectContaining({ code: "PROJECT_UNAVAILABLE" })
    );
    expect(() =>
      requireRole({ ...reader, role: "maintainer" }, "writer")
    ).not.toThrow();
  });

  it("requires an active project-wide grant for project-global operations", async () => {
    const calls: unknown[][] = [];
    const database = {
      withSession(constraint: string) {
        expect(constraint).toBe("first-primary");
        return {
          prepare(sql: string) {
            expect(sql).toContain("scope_kind = 'project'");
            return {
              bindings: [] as unknown[],
              bind(...bindings: unknown[]) {
                this.bindings = bindings;
                calls.push(bindings);
                return this;
              },
              async first() {
                return { authorized: 1 };
              }
            };
          }
        };
      }
    };

    await expect(
      requireProjectRole(database as unknown as D1Database, reader, "reader")
    ).resolves.toBeUndefined();
    expect(calls).toEqual([["project-1", "principal-1", "project-1", 0]]);

    const denied = {
      withSession() {
        return {
          prepare() {
            return {
              bind() {
                return this;
              },
              async first() {
                return null;
              }
            };
          }
        };
      }
    };
    await expect(
      requireProjectRole(denied as unknown as D1Database, reader, "maintainer")
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
  });

  it("authenticates a bearer through a first-primary grant lookup", async () => {
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    const database = {
      withSession(constraint: string) {
        expect(constraint).toBe("first-primary");
        return {
          prepare(sql: string) {
            const call = { sql, bindings: [] as unknown[] };
            calls.push(call);
            return {
              bind(...bindings: unknown[]) {
                call.bindings = bindings;
                return this;
              },
              async first() {
                return {
                  principal_id: "principal-1",
                  project_id: "project-1",
                  role: "maintainer"
                };
              }
            };
          }
        };
      }
    };
    const request = new Request("https://memory.example/mcp", {
      headers: { Authorization: `Bearer ${"t".repeat(48)}` }
    });

    await expect(
      authenticateProjectBearer(request, database as unknown as D1Database, "p".repeat(48))
    ).resolves.toEqual({
      principalId: "principal-1",
      projectId: "project-1",
      role: "maintainer"
    });
    expect(calls[0]?.sql).toContain("ORDER BY CASE g.role");
    expect(calls[0]?.bindings[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("returns the same unauthenticated error for missing, malformed, and unknown tokens", async () => {
    const unreachable = {} as D1Database;
    await expect(
      authenticateProjectBearer(
        new Request("https://memory.example/mcp"),
        unreachable,
        "p".repeat(48)
      )
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      authenticateProjectBearer(
        new Request("https://memory.example/mcp", {
          headers: { Authorization: "Bearer short" }
        }),
        unreachable,
        "p".repeat(48)
      )
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      authenticateProjectBearer(
        new Request("https://memory.example/mcp", {
          headers: { Authorization: `Bearer ${"x".repeat(4097)}` }
        }),
        unreachable,
        "p".repeat(48)
      )
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      authenticateProjectBearer(
        new Request("https://memory.example/mcp", {
          headers: { Authorization: `Bearer ${"x".repeat(48)}` }
        }),
        unreachable,
        "short-pepper"
      )
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const database = {
      withSession() {
        return {
          prepare() {
            return {
              bind() {
                return this;
              },
              async first() {
                return null;
              }
            };
          }
        };
      }
    };
    await expect(
      authenticateProjectBearer(
        new Request("https://memory.example/mcp", {
          headers: { Authorization: `Bearer ${"u".repeat(48)}` }
        }),
        database as unknown as D1Database,
        "p".repeat(48)
      )
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("applies one hierarchical ACL predicate to project and repository descendants", async () => {
    const database = authorizationDatabase();
    const d1 = asD1(database);
    const projectPrincipal = principal("principal-project", "maintainer");
    const repositoryPrincipal = principal("principal-repository-a", "reader");
    const refPrincipal = principal("principal-ref-a", "reader");
    const otherRepositoryPrincipal = principal("principal-repository-b", "reader");
    const contextlessPrincipal = principal("principal-contextless", "reader");

    await expect(hasMemoryRole(d1, projectPrincipal, "reader", "memory-repository-b"))
      .resolves.toBe(true);
    await expect(hasMemoryRole(d1, repositoryPrincipal, "reader", "memory-project"))
      .resolves.toBe(true);
    await expect(hasMemoryRole(d1, repositoryPrincipal, "reader", "memory-repository-a"))
      .resolves.toBe(true);
    await expect(hasMemoryRole(d1, repositoryPrincipal, "reader", "memory-ref-a"))
      .resolves.toBe(true);
    await expect(hasMemoryRole(d1, repositoryPrincipal, "reader", "memory-repository-b"))
      .resolves.toBe(false);
    await expect(hasMemoryRole(d1, refPrincipal, "reader", "memory-project"))
      .resolves.toBe(true);
    await expect(hasMemoryRole(d1, refPrincipal, "reader", "memory-repository-a"))
      .resolves.toBe(true);
    await expect(hasMemoryRole(d1, refPrincipal, "reader", "memory-ref-a"))
      .resolves.toBe(true);
    await expect(hasMemoryRole(d1, refPrincipal, "reader", "memory-ref-other"))
      .resolves.toBe(false);
    await expect(hasMemoryRole(d1, otherRepositoryPrincipal, "reader", "memory-repository-a"))
      .resolves.toBe(false);
    await expect(hasMemoryRole(d1, contextlessPrincipal, "reader", "memory-project"))
      .resolves.toBe(false);
    await expect(hasMemoryRole(d1, repositoryPrincipal, "writer", "memory-repository-a"))
      .resolves.toBe(false);

    await expect(hasRepositoryRole(d1, repositoryPrincipal, "reader", "repository-a"))
      .resolves.toBe(true);
    await expect(hasRepositoryRole(d1, refPrincipal, "reader", "repository-a"))
      .resolves.toBe(true);
    await expect(hasRepositoryRole(d1, repositoryPrincipal, "reader", "repository-b"))
      .resolves.toBe(false);

    await expect(
      requireMemoryRole(d1, repositoryPrincipal, "reader", "memory-repository-a")
    ).resolves.toBeUndefined();
    await expect(
      requireMemoryRole(d1, repositoryPrincipal, "reader", "memory-repository-b")
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });
    await expect(
      requireRepositoryRole(d1, repositoryPrincipal, "reader", "repository-a")
    ).resolves.toBeUndefined();
    await expect(
      requireRepositoryRole(d1, repositoryPrincipal, "reader", "repository-b")
    ).rejects.toMatchObject({ code: "PROJECT_UNAVAILABLE" });

    expect(hierarchicalMemoryAccessPredicate("grant", "memory")).toContain(
      "memory_repository_contexts"
    );
    expect(() => hierarchicalMemoryAccessPredicate("grant; DROP TABLE", "memory"))
      .toThrow(TypeError);
    expect(() => hierarchicalMemoryAccessPredicate("grant", "memory; DROP TABLE"))
      .toThrow(TypeError);
  });
});

function principal(
  principalId: string,
  role: "reader" | "writer" | "maintainer"
) {
  return { principalId, projectId: "project-1", role };
}

function authorizationDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0001_initial.sql",
    "migrations/0002_allow_synthetic_cleanup.sql",
    "migrations/0003_validity_interval_guard.sql",
    "migrations/0004_synthetic_cleanup_registry_and_validity_preflight.sql",
    "migrations/0005_synthetic_cleanup_fence.sql",
    "migrations/0006_repository_scope_context.sql"
  ]) {
    database.exec(readFileSync(migration, "utf8"));
  }
  const now = "2026-07-27T00:00:00.000Z";
  const refScope = "repository:repository-a:ref:refs%2Fheads%2Fmain";
  const otherRefScope = "repository:repository-a:ref:refs%2Fheads%2Fother";
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, created_at, updated_at)
    VALUES
      ('project-1', 'project-1', 'locator-1', 'Project 1', '${now}', '${now}'),
      ('project-2', 'project-2', 'locator-2', 'Project 2', '${now}', '${now}');
    INSERT INTO repositories
      (repository_id, project_id, provider, external_id, owner, name, created_at, updated_at)
    VALUES
      ('repository-a', 'project-1', 'github', 201, 'owner', 'a', '${now}', '${now}'),
      ('repository-b', 'project-1', 'github', 202, 'owner', 'b', '${now}', '${now}'),
      ('repository-c', 'project-2', 'github', 203, 'owner', 'c', '${now}', '${now}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('principal-project', 'test', 'project', 'digest-project', '${now}'),
      ('principal-repository-a', 'test', 'repository-a', 'digest-repository-a', '${now}'),
      ('principal-ref-a', 'test', 'ref-a', 'digest-ref-a', '${now}'),
      ('principal-repository-b', 'test', 'repository-b', 'digest-repository-b', '${now}'),
      ('principal-contextless', 'test', 'contextless', 'digest-contextless', '${now}');
    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES
      ('grant-project', 'project-1', 'principal-project', 'maintainer', 'project',
       'project-1', '${now}'),
      ('grant-repository-a', 'project-1', 'principal-repository-a', 'reader',
       'repository', 'repository-a', '${now}'),
      ('grant-ref-a', 'project-1', 'principal-ref-a', 'reader', 'ref',
       '${refScope}', '${now}'),
      ('grant-repository-b', 'project-1', 'principal-repository-b', 'reader',
       'repository', 'repository-b', '${now}'),
      ('grant-contextless', 'project-1', 'principal-contextless', 'reader', 'ref',
       '${otherRefScope}', '${now}');
    INSERT INTO project_grant_repository_contexts
      (project_id, grant_id, repository_id, created_at)
    VALUES
      ('project-1', 'grant-repository-a', 'repository-a', '${now}'),
      ('project-1', 'grant-ref-a', 'repository-a', '${now}'),
      ('project-1', 'grant-repository-b', 'repository-b', '${now}');
    INSERT INTO memories
      (memory_id, project_id, kind, memory_class, scope, scope_id, status,
       created_at, updated_at)
    VALUES
      ('memory-project', 'project-1', 'fact', 'semantic', 'project', 'project-1',
       'active', '${now}', '${now}'),
      ('memory-repository-a', 'project-1', 'fact', 'semantic', 'repository',
       'repository-a', 'active', '${now}', '${now}'),
      ('memory-repository-b', 'project-1', 'fact', 'semantic', 'repository',
       'repository-b', 'active', '${now}', '${now}'),
      ('memory-ref-a', 'project-1', 'fact', 'semantic', 'ref', '${refScope}',
       'active', '${now}', '${now}'),
      ('memory-ref-other', 'project-1', 'fact', 'semantic', 'ref', '${otherRefScope}',
       'active', '${now}', '${now}');
    INSERT INTO memory_repository_contexts
      (project_id, memory_id, repository_id, created_at)
    VALUES
      ('project-1', 'memory-repository-a', 'repository-a', '${now}'),
      ('project-1', 'memory-repository-b', 'repository-b', '${now}'),
      ('project-1', 'memory-ref-a', 'repository-a', '${now}'),
      ('project-1', 'memory-ref-other', 'repository-a', '${now}');
  `);
  return database;
}

function asD1(database: DatabaseSync): D1Database {
  return {
    withSession(constraint: string) {
      expect(constraint).toBe("first-primary");
      return {
        prepare(sql: string) {
          const statement = database.prepare(sql);
          let bindings: SQLInputValue[] = [];
          return {
            bind(...values: unknown[]) {
              bindings = values as SQLInputValue[];
              return this;
            },
            async first<T>() {
              return (statement.get(...bindings) as T | undefined) ?? null;
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}
