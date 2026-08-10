import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createRefScopeId, createWorktreeScopeId } from "../src/contracts/scope";

const AUTHORITY_MIGRATIONS = [
  "migrations/0001_initial.sql",
  "migrations/0002_allow_synthetic_cleanup.sql",
  "migrations/0003_validity_interval_guard.sql",
  "migrations/0004_synthetic_cleanup_registry_and_validity_preflight.sql",
  "migrations/0005_synthetic_cleanup_fence.sql",
  "migrations/0006_repository_scope_context.sql",
  "migrations/0007_repository_scope_hardening.sql",
  "migrations/0008_canonical_repository_scope_ownership.sql",
  "migrations/0009_repository_scope_runtime_guards.sql"
] as const;

const NOW = "2026-07-28T00:00:00.000Z";

describe("canonical repository scope materialization", () => {
  it("backfills exact canonical ref and worktree scope IDs without changing the public view", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 7);
    seedAuthority(database);
    const repositoryId = "repository:功能%one";
    const repositoryRef = "refs/heads/功能%release";
    const sessionId = "session:功能%one";
    const worktreeId = "worktree:功能%one";

    database.prepare(
      `INSERT INTO repositories
       (repository_id, project_id, provider, external_id, owner, name, created_at, updated_at)
       VALUES (?, 'project-a', 'github', 103, 'owner', 'unicode', ?, ?)`
    ).run(repositoryId, NOW, NOW);
    database.prepare(
      `INSERT INTO sync_cursors
       (project_id, repository_id, ref, status, updated_at)
       VALUES ('project-a', ?, ?, 'complete', ?)`
    ).run(repositoryId, repositoryRef, NOW);
    database.prepare(
      `INSERT INTO sessions
       (session_id, project_id, principal_id, status, agent_meta_json,
        worktree_meta_json, repository_id, repository_ref, worktree_id, opened_at)
       VALUES (?, 'project-a', 'principal-a', 'open', '{}', ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      JSON.stringify({
        repository_id: repositoryId,
        repository_ref: repositoryRef,
        worktree_id: worktreeId
      }),
      repositoryId,
      repositoryRef,
      worktreeId,
      NOW
    );

    applyMigrationAtomically(
      database,
      "migrations/0008_canonical_repository_scope_ownership.sql"
    );

    const refScopeId = createRefScopeId(repositoryId, repositoryRef);
    const worktreeScopeId = createWorktreeScopeId(sessionId, worktreeId);
    expect(
      database.prepare(
        `SELECT ref_scope_id FROM sync_cursors
         WHERE project_id = 'project-a' AND repository_id = ? AND ref = ?`
      ).get(repositoryId, repositoryRef)
    ).toEqual({ ref_scope_id: refScopeId });
    expect(
      database.prepare(
        "SELECT worktree_scope_id FROM sessions WHERE session_id = ?"
      ).get(sessionId)
    ).toEqual({ worktree_scope_id: worktreeScopeId });
    expect(
      database.prepare(
        `SELECT scope_kind, scope_id, repository_id, source_id
         FROM canonical_repository_scope_ownership
         WHERE project_id = 'project-a' AND scope_kind IN ('ref', 'worktree')
           AND scope_id IN (?, ?)
         ORDER BY scope_kind`
      ).all(refScopeId, worktreeScopeId)
    ).toEqual([
      {
        scope_kind: "ref",
        scope_id: refScopeId,
        repository_id: repositoryId,
        source_id: repositoryRef
      },
      {
        scope_kind: "worktree",
        scope_id: worktreeScopeId,
        repository_id: repositoryId,
        source_id: sessionId
      }
    ]);
  });

  it("materializes new rows and rejects forged, null, or rebound canonical identities", () => {
    const database = migratedDatabase();
    const ref = "refs/heads/main";
    const refScopeId = createRefScopeId("repository-a", ref);

    expect(() =>
      database.prepare(
        `INSERT INTO sync_cursors
         (project_id, repository_id, ref, status, updated_at, ref_scope_id)
         VALUES ('project-a', 'repository-a', ?, 'complete', ?, 'forged')`
      ).run(ref, NOW)
    ).toThrow(/canonical ref scope identity is invalid/iu);

    database.prepare(
      `INSERT INTO sync_cursors
       (project_id, repository_id, ref, status, updated_at)
       VALUES ('project-a', 'repository-a', ?, 'complete', ?)`
    ).run(ref, NOW);
    expect(
      database.prepare(
        `SELECT ref_scope_id FROM sync_cursors
         WHERE project_id = 'project-a' AND repository_id = 'repository-a' AND ref = ?`
      ).get(ref)
    ).toEqual({ ref_scope_id: refScopeId });
    expect(() =>
      database.prepare(
        `UPDATE sync_cursors SET ref_scope_id = NULL
         WHERE project_id = 'project-a' AND repository_id = 'repository-a' AND ref = ?`
      ).run(ref)
    ).toThrow(/canonical ref scope identity is invalid/iu);
    expect(() =>
      database.prepare(
        `UPDATE sync_cursors SET ref_scope_id = 'forged'
         WHERE project_id = 'project-a' AND repository_id = 'repository-a' AND ref = ?`
      ).run(ref)
    ).toThrow(/canonical ref scope identity is invalid/iu);
    expect(() =>
      database.prepare(
        `UPDATE sync_cursors SET ref = 'refs/heads/rebound'
         WHERE project_id = 'project-a' AND repository_id = 'repository-a' AND ref = ?`
      ).run(ref)
    ).toThrow(/scope identity is immutable/iu);

    const sessionId = "session-materialized";
    const worktreeId = "worktree-materialized";
    const worktreeScopeId = createWorktreeScopeId(sessionId, worktreeId);
    expect(() =>
      insertSession(database, {
        sessionId: "session-forged",
        worktreeId,
        worktreeScopeId: "forged"
      })
    ).toThrow(/canonical worktree scope identity is invalid/iu);

    insertSession(database, { sessionId, worktreeId });
    expect(
      database.prepare(
        "SELECT worktree_scope_id FROM sessions WHERE session_id = ?"
      ).get(sessionId)
    ).toEqual({ worktree_scope_id: worktreeScopeId });
    expect(() =>
      database.prepare(
        "UPDATE sessions SET worktree_scope_id = NULL WHERE session_id = ?"
      ).run(sessionId)
    ).toThrow(/canonical worktree scope identity is invalid/iu);
    expect(() =>
      database.prepare(
        "UPDATE sessions SET worktree_scope_id = 'forged' WHERE session_id = ?"
      ).run(sessionId)
    ).toThrow(/canonical worktree scope identity is invalid/iu);

    insertSession(database, { sessionId: "session-without-worktree", worktreeId: null });
    expect(() =>
      database.prepare(
        `UPDATE sessions SET worktree_scope_id = 'forged'
         WHERE session_id = 'session-without-worktree'`
      ).run()
    ).toThrow(/canonical worktree scope identity is invalid/iu);
  });

  it("uses indexed canonical lookups with five thousand unrelated worktree sessions", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 7);
    seedAuthority(database);
    database.prepare(
      `INSERT INTO sync_cursors
       (project_id, repository_id, ref, status, updated_at)
       VALUES ('project-a', 'repository-a', 'refs/heads/main', 'complete', ?)`
    ).run(NOW);

    const statement = database.prepare(
      `INSERT INTO sessions
       (session_id, project_id, principal_id, status, agent_meta_json,
        worktree_meta_json, repository_id, repository_ref, worktree_id, opened_at)
       VALUES (?, 'project-b', 'principal-b', 'open', '{}', ?, 'repository-b',
               'refs/heads/main', ?, ?)`
    );
    database.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 5_000; index += 1) {
      const worktreeId = `noise-worktree-${index}`;
      statement.run(
        `noise-session-${index}`,
        JSON.stringify({
          repository_id: "repository-b",
          repository_ref: "refs/heads/main",
          worktree_id: worktreeId
        }),
        worktreeId,
        NOW
      );
    }
    database.exec("COMMIT");

    applyMigrationAtomically(
      database,
      "migrations/0008_canonical_repository_scope_ownership.sql"
    );
    expect(
      database.prepare(
        `SELECT worktree_scope_id FROM sessions
         WHERE session_id = 'noise-session-4999'`
      ).get()
    ).toEqual({
      worktree_scope_id: createWorktreeScopeId(
        "noise-session-4999",
        "noise-worktree-4999"
      )
    });
    applyMigrationAtomically(database, "migrations/0009_repository_scope_runtime_guards.sql");

    const scopeId = createRefScopeId("repository-a", "refs/heads/main");
    expect(
      database.prepare(
        `SELECT scope_id FROM canonical_repository_scope_ownership
         WHERE project_id = 'project-a' AND scope_kind = 'ref' AND scope_id = ?`
      ).get(scopeId)
    ).toEqual({ scope_id: scopeId });

    const plan = database.prepare(
      `EXPLAIN QUERY PLAN
       SELECT scope_id FROM canonical_repository_scope_ownership
       WHERE project_id = 'project-a' AND scope_kind = 'ref' AND scope_id = ?`
    ).all(scopeId) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("sync_cursors_by_ref_scope");
    expect(details).not.toMatch(/RECURSIVE STEP|USE TEMP B-TREE/iu);
    expect(details).not.toMatch(/SCAN (?:sync_cursors|sessions)/iu);

    const worktreeScopeId = createWorktreeScopeId(
      "noise-session-4999",
      "noise-worktree-4999"
    );
    expect(
      database.prepare(
        `SELECT scope_id FROM canonical_repository_scope_ownership
         WHERE project_id = 'project-b' AND scope_kind = 'worktree' AND scope_id = ?`
      ).get(worktreeScopeId)
    ).toEqual({ scope_id: worktreeScopeId });
    const worktreePlan = database.prepare(
      `EXPLAIN QUERY PLAN
       SELECT scope_id FROM canonical_repository_scope_ownership
       WHERE project_id = 'project-b' AND scope_kind = 'worktree' AND scope_id = ?`
    ).all(worktreeScopeId) as Array<{ detail: string }>;
    const worktreeDetails = worktreePlan.map((row) => row.detail).join("\n");
    expect(worktreeDetails).toContain("sessions_by_worktree_scope");
    expect(worktreeDetails).not.toMatch(/RECURSIVE STEP|USE TEMP B-TREE/iu);
    expect(worktreeDetails).not.toMatch(/SCAN (?:sync_cursors|sessions)/iu);
  });

  it("rolls back and safely retries both materialization migrations", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 7);
    seedAuthority(database);
    database.exec(
      `INSERT INTO sync_cursors
       (project_id, repository_id, ref, status, updated_at)
       VALUES ('project-a', 'repository-b', 'refs/heads/cross-project', 'complete', '${NOW}')`
    );

    expect(() =>
      applyMigrationAtomically(
        database,
        "migrations/0008_canonical_repository_scope_ownership.sql"
      )
    ).toThrow(/canonical_scope_preflight/iu);
    expect(columnExists(database, "sync_cursors", "ref_scope_id")).toBe(false);
    expect(schemaObjectExists(database, "view", "canonical_repository_scope_ownership")).toBe(
      false
    );
    database.exec(
      `DELETE FROM sync_cursors
       WHERE project_id = 'project-a' AND repository_id = 'repository-b'`
    );
    applyMigrationAtomically(
      database,
      "migrations/0008_canonical_repository_scope_ownership.sql"
    );

    database.exec(
      `INSERT INTO sync_cursors
       (project_id, repository_id, ref, status, updated_at)
       VALUES ('project-a', 'repository-b', 'refs/heads/inter-migration', 'complete', '${NOW}')`
    );
    expect(() =>
      applyMigrationAtomically(database, "migrations/0009_repository_scope_runtime_guards.sql")
    ).toThrow(/repository_scope_runtime_preflight/iu);
    expect(schemaObjectExists(database, "trigger", "sync_cursor_ref_scope_materialize")).toBe(
      false
    );
    database.exec(
      `DELETE FROM sync_cursors
       WHERE project_id = 'project-a' AND repository_id = 'repository-b'`
    );
    applyMigrationAtomically(database, "migrations/0009_repository_scope_runtime_guards.sql");

    database.prepare(
      `INSERT INTO sync_cursors
       (project_id, repository_id, ref, status, updated_at)
       VALUES ('project-a', 'repository-a', 'refs/heads/retry', 'complete', ?)`
    ).run(NOW);
    expect(
      database.prepare(
        `SELECT ref_scope_id FROM sync_cursors
         WHERE project_id = 'project-a' AND repository_id = 'repository-a'
           AND ref = 'refs/heads/retry'`
      ).get()
    ).toEqual({
      ref_scope_id: createRefScopeId("repository-a", "refs/heads/retry")
    });
  });
});

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  applyAuthorityMigrations(database);
  seedAuthority(database);
  return database;
}

function seedAuthority(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, created_at, updated_at)
    VALUES
      ('project-a', 'project-a', 'locator-a', 'Project A', '${NOW}', '${NOW}'),
      ('project-b', 'project-b', 'locator-b', 'Project B', '${NOW}', '${NOW}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('principal-a', 'test', 'principal-a', 'digest-a', '${NOW}'),
      ('principal-b', 'test', 'principal-b', 'digest-b', '${NOW}');
    INSERT INTO repositories
      (repository_id, project_id, provider, external_id, owner, name, created_at, updated_at)
    VALUES
      ('repository-a', 'project-a', 'github', 101, 'owner', 'a', '${NOW}', '${NOW}'),
      ('repository-b', 'project-b', 'github', 102, 'owner', 'b', '${NOW}', '${NOW}');
  `);
}

function insertSession(
  database: DatabaseSync,
  input: {
    sessionId: string;
    worktreeId: string | null;
    worktreeScopeId?: string;
  }
): void {
  const metadata =
    input.worktreeId === null
      ? { repository_id: "repository-a", repository_ref: "refs/heads/main" }
      : {
          repository_id: "repository-a",
          repository_ref: "refs/heads/main",
          worktree_id: input.worktreeId
        };
  database.prepare(
    `INSERT INTO sessions
     (session_id, project_id, principal_id, status, agent_meta_json,
      worktree_meta_json, repository_id, repository_ref, worktree_id,
      worktree_scope_id, opened_at)
     VALUES (?, 'project-a', 'principal-a', 'open', '{}', ?, 'repository-a',
             'refs/heads/main', ?, ?, ?)`
  ).run(
    input.sessionId,
    JSON.stringify(metadata),
    input.worktreeId,
    input.worktreeScopeId ?? null,
    NOW
  );
}

function applyAuthorityMigrations(
  database: DatabaseSync,
  count: number = AUTHORITY_MIGRATIONS.length
): void {
  for (const migration of AUTHORITY_MIGRATIONS.slice(0, count)) {
    database.exec(readFileSync(migration, "utf8"));
  }
}

function applyMigrationAtomically(database: DatabaseSync, migration: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(readFileSync(migration, "utf8"));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function columnExists(database: DatabaseSync, table: string, column: string): boolean {
  return (
    database.prepare(
      `SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?`
    ).get(table, column) !== undefined
  );
}

function schemaObjectExists(database: DatabaseSync, type: string, name: string): boolean {
  return (
    database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?"
    ).get(type, name) !== undefined
  );
}
