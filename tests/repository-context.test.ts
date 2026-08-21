import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createRefScopeId, createWorktreeScopeId } from "../src/contracts/scope";
import {
  resolveMemoryChangeRepositoryContext,
  resolveMemoryRepositoryOwnership,
  resolveScopeRepositoryOwnership,
  resolveTrustedRepositoryContext
} from "../src/contracts/repository-context";

const MIGRATIONS = [
  "migrations/0001_initial.sql"
] as const;

describe("trusted repository context", () => {
  it("resolves normalized session and evidence provenance only inside the project", async () => {
    const database = contextDatabase();
    const d1 = asD1(database);

    await expect(
      resolveTrustedRepositoryContext(d1, "project-1", {
        kind: "session",
        id: "session-a"
      })
    ).resolves.toEqual({
      projectId: "project-1",
      repositoryId: "repository-a",
      repositoryRef: "refs/heads/feature-a",
      repositoryPath: null,
      repositoryAuthority: "agent_supplied",
      source: { kind: "session", id: "session-a" }
    });
    await expect(
      resolveTrustedRepositoryContext(d1, "project-1", {
        kind: "evidence",
        id: "evidence-a"
      })
    ).resolves.toEqual({
      projectId: "project-1",
      repositoryId: "repository-a",
      repositoryRef: "refs/heads/main",
      repositoryPath: "src/index.ts",
      repositoryAuthority: "default_branch",
      source: { kind: "evidence", id: "evidence-a" }
    });
    await expect(
      resolveTrustedRepositoryContext(d1, "project-2", {
        kind: "session",
        id: "session-a"
      })
    ).resolves.toBeNull();
    await expect(
      resolveTrustedRepositoryContext(d1, "project-2", {
        kind: "evidence",
        id: "evidence-a"
      })
    ).resolves.toBeNull();
  });

  it("resolves every formal scope to its normalized repository owner", async () => {
    const d1 = asD1(contextDatabase());
    const refScopeId = createRefScopeId("repository-a", "refs/heads/main");
    const worktreeScopeId = createWorktreeScopeId("session-a", "worktree-a");

    await expect(
      resolveScopeRepositoryOwnership(d1, "project-1", "project", "project-1")
    ).resolves.toEqual({ projectId: "project-1", repositoryId: null });
    await expect(
      resolveScopeRepositoryOwnership(d1, "project-1", "repository", "repository-a")
    ).resolves.toEqual({ projectId: "project-1", repositoryId: "repository-a" });
    await expect(
      resolveScopeRepositoryOwnership(d1, "project-1", "ref", refScopeId)
    ).resolves.toEqual({ projectId: "project-1", repositoryId: "repository-a" });
    await expect(
      resolveScopeRepositoryOwnership(d1, "project-1", "session", "session-a")
    ).resolves.toEqual({ projectId: "project-1", repositoryId: "repository-a" });
    await expect(
      resolveScopeRepositoryOwnership(d1, "project-1", "worktree", worktreeScopeId)
    ).resolves.toEqual({ projectId: "project-1", repositoryId: "repository-a" });

    await expect(
      resolveScopeRepositoryOwnership(d1, "project-1", "project", "project-2")
    ).resolves.toBeNull();
    await expect(
      resolveScopeRepositoryOwnership(
        d1,
        "project-1",
        "worktree",
        createWorktreeScopeId("session-a", "other-worktree")
      )
    ).resolves.toBeNull();
  });

  it("loads immutable formal-memory repository ownership", async () => {
    const d1 = asD1(contextDatabase());

    await expect(
      resolveMemoryRepositoryOwnership(d1, "project-1", "memory-repository-a")
    ).resolves.toEqual({ projectId: "project-1", repositoryId: "repository-a" });
    await expect(
      resolveMemoryRepositoryOwnership(d1, "project-2", "memory-repository-a")
    ).resolves.toBeNull();
    await expect(
      resolveMemoryRepositoryOwnership(d1, "project-1", "memory-project")
    ).resolves.toBeNull();
  });

  it("derives exact mutation context from canonical formal-memory ownership", async () => {
    const d1 = asD1(contextDatabase());
    const refScopeId = createRefScopeId("repository-a", "refs/heads/main");
    const worktreeScopeId = createWorktreeScopeId("session-a", "worktree-a");

    await expect(
      resolveMemoryChangeRepositoryContext(d1, "project-1", "memory-project")
    ).resolves.toEqual({
      scope: "project",
      scopeId: "project-1",
      repositoryId: null,
      repositoryRef: null,
      sessionId: null,
      worktreeId: null
    });
    await expect(
      resolveMemoryChangeRepositoryContext(d1, "project-1", "memory-repository-a")
    ).resolves.toEqual({
      scope: "repository",
      scopeId: "repository-a",
      repositoryId: "repository-a",
      repositoryRef: null,
      sessionId: null,
      worktreeId: null
    });
    await expect(
      resolveMemoryChangeRepositoryContext(d1, "project-1", "memory-ref-a")
    ).resolves.toEqual({
      scope: "ref",
      scopeId: refScopeId,
      repositoryId: "repository-a",
      repositoryRef: "refs/heads/main",
      sessionId: null,
      worktreeId: null
    });
    await expect(
      resolveMemoryChangeRepositoryContext(d1, "project-1", "memory-session-a")
    ).resolves.toEqual({
      scope: "session",
      scopeId: "session-a",
      repositoryId: "repository-a",
      repositoryRef: "refs/heads/feature-a",
      sessionId: "session-a",
      worktreeId: null
    });
    await expect(
      resolveMemoryChangeRepositoryContext(d1, "project-1", "memory-worktree-a")
    ).resolves.toEqual({
      scope: "worktree",
      scopeId: worktreeScopeId,
      repositoryId: "repository-a",
      repositoryRef: "refs/heads/feature-a",
      sessionId: "session-a",
      worktreeId: "worktree-a"
    });
    await expect(
      resolveMemoryChangeRepositoryContext(d1, "project-1", "memory-invalid-ref")
    ).resolves.toBeNull();
  });
});

function contextDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) {
    database.exec(readFileSync(migration, "utf8"));
  }
  // The canonical guards make the deliberately mismatched
  // memory-invalid-ref context row impossible to persist; drop them in this
  // fixture so the runtime mismatch path remains observable.
  database.exec("DROP TRIGGER memory_repository_context_canonical_insert_guard");
  database.exec("DROP TRIGGER memory_repository_context_no_update");
  const now = "2026-07-27T00:00:00.000Z";
  const refScopeId = createRefScopeId("repository-a", "refs/heads/main");
  const worktreeScopeId = createWorktreeScopeId("session-a", "worktree-a");
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, created_at, updated_at)
    VALUES
      ('project-1', 'project-1', 'locator-1', 'Project 1', '${now}', '${now}'),
      ('project-2', 'project-2', 'locator-2', 'Project 2', '${now}', '${now}');
    INSERT INTO repositories
      (repository_id, project_id, provider, external_id, owner, name, created_at, updated_at)
    VALUES
      ('repository-a', 'project-1', 'github', 101, 'owner', 'a', '${now}', '${now}'),
      ('repository-b', 'project-1', 'github', 102, 'owner', 'b', '${now}', '${now}'),
      ('repository-c', 'project-2', 'github', 103, 'owner', 'c', '${now}', '${now}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES ('principal-1', 'test', 'principal-1', 'digest-1', '${now}');
    INSERT INTO sessions
      (session_id, project_id, principal_id, status, agent_meta_json,
       repository_id, repository_ref, worktree_id, worktree_scope_id, opened_at)
    VALUES
      ('session-a', 'project-1', 'principal-1', 'open', '{}',
       'repository-a', 'refs/heads/feature-a', 'worktree-a', '${worktreeScopeId}', '${now}');
    INSERT INTO sync_cursors
      (project_id, repository_id, ref, ref_scope_id, updated_at)
    VALUES ('project-1', 'repository-a', 'refs/heads/main', '${refScopeId}', '${now}');
    INSERT INTO evidence
      (evidence_id, project_id, source_type, locator, repository_id,
       repository_ref, repository_path, repository_authority, excerpt_hash,
       sensitivity_status, recorded_at)
    VALUES
      ('evidence-a', 'project-1', 'github_blob',
       'github://101/abcdef0/src/index.ts', 'repository-a', 'refs/heads/main',
       'src/index.ts', 'default_branch', 'excerpt-a', 'clear', '${now}');
    INSERT INTO memories
      (memory_id, project_id, kind, memory_class, scope, scope_id, status,
       created_at, updated_at)
    VALUES
      ('memory-project', 'project-1', 'fact', 'semantic', 'project', 'project-1',
       'active', '${now}', '${now}'),
      ('memory-repository-a', 'project-1', 'fact', 'semantic', 'repository',
       'repository-a', 'active', '${now}', '${now}'),
      ('memory-ref-a', 'project-1', 'fact', 'semantic', 'ref',
       '${refScopeId}', 'active', '${now}', '${now}'),
      ('memory-session-a', 'project-1', 'fact', 'semantic', 'session',
       'session-a', 'active', '${now}', '${now}'),
      ('memory-worktree-a', 'project-1', 'fact', 'semantic', 'worktree',
       '${worktreeScopeId}', 'active', '${now}', '${now}'),
      ('memory-invalid-ref', 'project-1', 'fact', 'semantic', 'ref',
       '${refScopeId}', 'active', '${now}', '${now}');
    UPDATE memory_repository_contexts
    SET repository_id = 'repository-b'
    WHERE project_id = 'project-1' AND memory_id = 'memory-invalid-ref';
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
