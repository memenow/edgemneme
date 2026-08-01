import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const AUTHORITY_MIGRATIONS = [
  "migrations/0001_initial.sql",
  "migrations/0002_allow_synthetic_cleanup.sql",
  "migrations/0003_validity_interval_guard.sql",
  "migrations/0004_synthetic_cleanup_registry_and_validity_preflight.sql",
  "migrations/0005_synthetic_cleanup_fence.sql",
  "migrations/0006_repository_scope_context.sql",
  "migrations/0007_repository_scope_hardening.sql",
  "migrations/0008_canonical_repository_scope_ownership.sql",
  "migrations/0009_repository_scope_runtime_guards.sql",
  "migrations/0010_github_credential_expiry_and_repository_identity.sql",
  "migrations/0011_github_tree_manifests.sql",
  "migrations/0012_projection_rebuild_outbox_index.sql",
  "migrations/0013_projection_rebuild_unknown_status.sql",
  "migrations/0014_ordinary_workflow_reconciliation_index.sql",
  "migrations/0015_github_sync_default_branch.sql",
  "migrations/0016_consolidation_lease.sql",
  "migrations/0017_github_sync_activation_receipts.sql",
  "migrations/0018_consolidation_batch_receipts.sql"
] as const;

const SEARCH_MIGRATIONS = [
  "migrations/search/0001_fts.sql",
  "migrations/search/0002_activate_qwen_generation.sql",
  "migrations/search/0003_projection_heads.sql",
  "migrations/search/0004_repository_partition.sql",
  "migrations/search/0005_memory_fts_chunk_ledger.sql"
] as const;

describe("authoritative D1 migrations", () => {
  it("requires GitHub owner identity and keeps expiry warnings authoritative", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 9);
    seedRepositoryAuthority(database);
    database.exec(
      readFileSync(
        "migrations/0010_github_credential_expiry_and_repository_identity.sql",
        "utf8"
      )
    );

    expect(() =>
      database.prepare(
        `UPDATE repositories SET updated_at = '2026-07-28T00:00:00.000Z'
         WHERE repository_id = 'repository-1'`
      ).run()
    ).not.toThrow();
    expect(() =>
      database.prepare(
        `UPDATE repositories SET sync_enabled = 0
         WHERE repository_id = 'repository-1'`
      ).run()
    ).not.toThrow();
    expect(() =>
      database.prepare(
        `UPDATE repositories
         SET sync_enabled = 1, expected_owner_external_id = 7
         WHERE repository_id = 'repository-1'`
      ).run()
    ).not.toThrow();
    expect(() =>
      database.prepare(
        `INSERT INTO repositories
         (repository_id, project_id, provider, external_id, owner, name,
          sync_enabled, created_at, updated_at)
         VALUES ('repository-missing-owner', 'project-1', 'GitHub', 303,
                 'owner', 'missing-owner', 1,
                 '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z')`
      ).run()
    ).toThrow(/github repository owner identity is required/iu);
    database.prepare(
      `INSERT INTO repositories
       (repository_id, project_id, provider, external_id,
        expected_owner_external_id, owner, name, sync_enabled, created_at, updated_at)
       VALUES ('repository-mixed-case-provider', 'project-1', 'GitHub', 304, 7,
               'owner', 'mixed-case-provider', 1,
               '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z')`
    ).run();
    expect(
      database.prepare(
        `SELECT repository_id FROM repositories
         WHERE lower(provider) = 'github' AND sync_enabled = 1
           AND repository_id = 'repository-mixed-case-provider'`
      ).get()
    ).toEqual({ repository_id: "repository-mixed-case-provider" });
    expect(
      database.prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'repositories_github_sync_identity'`
      ).get()
    ).toMatchObject({ sql: expect.stringContaining("lower(provider)") });

    database.exec(`
      INSERT INTO github_access_baselines
        (credential_version, user_id, scopes_json, repositories_json,
         approved_by_principal_id, approved_at, created_at)
      VALUES
        ('credential-current', 7, '["repo"]', '[]', 'principal-1',
         '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z'),
        ('credential-unknown-expiry', 7, '["repo"]', '[]', 'principal-1',
         '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z');
      INSERT INTO github_credential_states
        (credential_version, expires_at, last_observed_at, credential_status,
         warning_threshold_days, updated_at)
      VALUES
        ('credential-current', '2026-08-11T00:00:00.000Z',
         '2026-07-28T00:00:00.000Z', 'expiring', 14,
         '2026-07-28T00:00:00.000Z'),
        ('credential-unknown-expiry', NULL,
         '2026-07-28T00:00:00.000Z', 'active', NULL,
         '2026-07-28T00:00:00.000Z');
      INSERT INTO github_credential_expiry_warnings
        (event_id, credential_version, threshold_days, expires_at, observed_at,
         event_digest)
      VALUES
        ('warning-14', 'credential-current', 14, '2026-08-11T00:00:00.000Z',
         '2026-07-28T00:00:00.000Z', 'digest-14');
    `);

    expect(() =>
      database.prepare(
        `INSERT INTO github_credential_expiry_warnings
         (event_id, credential_version, threshold_days, expires_at, observed_at,
          event_digest)
         VALUES ('warning-14-repeat', 'credential-current', 14,
                 '2026-08-11T00:00:00.000Z', '2026-07-28T06:00:00.000Z',
                 'digest-14-repeat')`
      ).run()
    ).toThrow(/unique/iu);
    expect(() =>
      database.prepare(
        `UPDATE github_credential_expiry_warnings SET event_digest = 'changed'
         WHERE event_id = 'warning-14'`
      ).run()
    ).toThrow(/immutable/iu);
    expect(() =>
      database.prepare(
        `UPDATE github_credential_states SET expires_at = '2026-08-12T00:00:00.000Z'
         WHERE credential_version = 'credential-current'`
      ).run()
    ).toThrow(/credential version must change with expiration/iu);
    expect(() =>
      database.prepare(
        `UPDATE github_credential_states SET expires_at = NULL
         WHERE credential_version = 'credential-current'`
      ).run()
    ).toThrow(/credential version must change with expiration/iu);
    expect(() =>
      database.prepare(
        `UPDATE github_credential_states SET expires_at = '2026-08-12T00:00:00.000Z'
         WHERE credential_version = 'credential-unknown-expiry'`
      ).run()
    ).toThrow(/credential version must change with expiration/iu);

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it("rolls back GitHub owner identity migration when enabled rows need backfill", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 9);
    seedRepositoryAuthority(database);
    database.prepare(
      `UPDATE repositories SET sync_enabled = 1
       WHERE repository_id = 'repository-1'`
    ).run();

    expect(() =>
      applyMigrationAtomically(
        database,
        "migrations/0010_github_credential_expiry_and_repository_identity.sql"
      )
    ).toThrow(/github_owner_identity_preflight_failed/iu);
    expect(
      database.prepare(
        `SELECT COUNT(*) AS count
         FROM pragma_table_info('repositories')
         WHERE name = 'expected_owner_external_id'`
      ).get()
    ).toEqual({ count: 0 });
    expect(
      schemaObjectCount(database, "table", "migration_0010_github_owner_identity_preflight")
    ).toBe(0);

    database.prepare(
      `UPDATE repositories SET sync_enabled = 0
       WHERE repository_id = 'repository-1'`
    ).run();
    applyMigrationAtomically(
      database,
      "migrations/0010_github_credential_expiry_and_repository_identity.sql"
    );

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it("applies cleanly and enforces chronological ISO validity intervals", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database);
    seedAuthority(database);

    expect(() => insertObservation(database, "date-only", "2026-07-25", null)).toThrow(
      /invalid observation validity interval/iu
    );
    expect(() =>
      insertObservation(
        database,
        "reverse",
        "2026-07-26T00:00:00.000Z",
        "2026-07-25T00:00:00.000Z"
      )
    ).toThrow(/invalid observation validity interval/iu);
    expect(() =>
      insertObservation(
        database,
        "offset",
        "2026-07-25T02:00:00.000+02:00",
        "2026-07-25T00:00:00.000Z"
      )
    ).not.toThrow();
    expect(() =>
      database.exec(
        "UPDATE observations SET valid_until = '2026-07-24T00:00:00.000Z' " +
          "WHERE observation_id = 'offset'"
      )
    ).toThrow(/invalid observation validity interval/iu);

    expect(() =>
      database.prepare(
        `INSERT INTO memory_versions
         (revision_id, project_id, memory_id, memory_version, content, content_sha256,
          valid_from, valid_until, audit_id, recorded_at)
         VALUES ('revision-1', 'project-1', 'memory-1', 1, 'content', 'sha',
                 '2026-07-26T00:00:00.000Z', '2026-07-25T00:00:00.000Z',
                 'audit-1', '2026-07-25T00:00:00.000Z')`
      ).run()
    ).toThrow(/invalid memory validity interval/iu);

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it.each([
    {
      label: "a non-ISO observation boundary",
      seed: (database: DatabaseSync) =>
        insertObservation(database, "legacy-invalid", "2026-07-25", null)
    },
    {
      label: "a reversed observation interval",
      seed: (database: DatabaseSync) =>
        insertObservation(
          database,
          "legacy-invalid",
          "2026-07-26T00:00:00.000Z",
          "2026-07-25T00:00:00.000Z"
        )
    },
    {
      label: "a non-ISO memory boundary",
      seed: (database: DatabaseSync) =>
        insertMemoryVersion(database, "not-a-date", null)
    },
    {
      label: "a reversed memory interval",
      seed: (database: DatabaseSync) =>
        insertMemoryVersion(
          database,
          "2026-07-26T00:00:00.000Z",
          "2026-07-25T00:00:00.000Z"
        )
    }
  ])("fails closed before installing the registry when legacy data contains $label", ({ seed }) => {
    const database = new DatabaseSync(":memory:");
    for (const migration of [
      "migrations/0001_initial.sql",
      "migrations/0002_allow_synthetic_cleanup.sql"
    ]) {
      database.exec(readFileSync(migration, "utf8"));
    }
    seedAuthority(database);
    seed(database);
    database.exec(readFileSync("migrations/0003_validity_interval_guard.sql", "utf8"));

    expect(() =>
      database.exec(
        readFileSync(
          "migrations/0004_synthetic_cleanup_registry_and_validity_preflight.sql",
          "utf8"
        )
      )
    ).toThrow(/validity_preflight/iu);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master " +
            "WHERE type = 'table' AND name = 'synthetic_cleanup_registry'"
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it("registers only synthetic projects and keeps cleanup identity immutable", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 5);
    seedAuthority(database);
    seedSyntheticAuthority(database);

    expect(() =>
      database.prepare(
        `INSERT INTO synthetic_cleanup_registry
         (project_id, principal_id, expires_at, created_at)
         VALUES ('project-1', 'principal-1',
                 '2026-07-25T23:00:00.000Z', '2026-07-25T00:00:00.000Z')`
      ).run()
    ).toThrow(/synthetic project and principal required/iu);
    expect(() =>
      database.prepare(
        `INSERT INTO synthetic_cleanup_registry
         (project_id, principal_id, expires_at, created_at)
         VALUES ('synthetic-project', 'synthetic-principal',
                 '2026-07-25T23:00:00.000Z', '2026-07-25T00:00:00.000Z')`
      ).run()
    ).not.toThrow();
    expect(() =>
      database.prepare(
        `UPDATE synthetic_cleanup_registry
         SET expires_at = '2026-07-26T00:00:00.000Z'
         WHERE project_id = 'synthetic-project'`
      ).run()
    ).toThrow(/cleanup registration is immutable/iu);
    database.prepare(
      `UPDATE projects SET project_ref = 'project.drifted'
       WHERE project_id = 'synthetic-project'`
    ).run();
    expect(() =>
      database.prepare(
        `DELETE FROM synthetic_cleanup_registry
         WHERE project_id = 'synthetic-project'`
      ).run()
    ).toThrow(/cleanup identity is invalid/iu);
  });

  it("atomically fences synthetic work admission before authority cleanup", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 5);
    seedSyntheticAuthority(database);
    database.prepare(
      `INSERT INTO synthetic_cleanup_registry
       (project_id, principal_id, expires_at, created_at)
       VALUES ('synthetic-project', 'synthetic-principal',
               '2026-07-25T23:00:00.000Z', '2026-07-25T00:00:00.000Z')`
    ).run();

    expect(
      database.prepare(
        `UPDATE synthetic_cleanup_registry
         SET cleanup_fenced_at = '2026-07-26T00:00:00.000Z',
             cleanup_claim_id = 'claim-1',
             cleanup_claim_expires_at = '2026-07-26T00:30:00.000Z'
         WHERE project_id = 'synthetic-project' AND cleanup_claim_id IS NULL`
      ).run().changes
    ).toBe(1);
    expect(() =>
      database.prepare(
        `UPDATE synthetic_cleanup_registry SET cleanup_fenced_at = NULL
         WHERE project_id = 'synthetic-project'`
      ).run()
    ).toThrow(/cleanup fence is immutable/iu);
    expect(() =>
      database.prepare(
        `UPDATE projects SET project_version = 1
         WHERE project_id = 'synthetic-project'`
      ).run()
    ).toThrow(/cleanup is fenced/iu);
    expect(() =>
      database.prepare(
        `INSERT INTO workflow_runs
         (workflow_id, root_workflow_id, project_id, workflow_type, status,
          attempt, created_at, updated_at)
         VALUES ('workflow-1', 'workflow-1', 'synthetic-project', 'memory.changed',
                 'running', 1, '2026-07-26T00:00:00.000Z',
                 '2026-07-26T00:00:00.000Z')`
      ).run()
    ).toThrow(/cleanup is fenced/iu);
    expect(() =>
      database.prepare(
        `INSERT INTO outbox_events
         (event_id, project_id, project_version, event_type, payload_digest,
          payload_json, created_at)
         VALUES ('event-1', 'synthetic-project', 0, 'memory.changed', 'digest',
                 '{}', '2026-07-26T00:00:00.000Z')`
      ).run()
    ).toThrow(/cleanup is fenced/iu);

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("normalizes repository provenance and rejects cross-project relationships", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 7);
    seedRepositoryAuthority(database);

    expect(() =>
      database.prepare(
        `INSERT INTO project_grants
         (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
         VALUES ('grant-invalid-project', 'project-1', 'principal-1', 'reader',
                 'project', 'project-2', '2026-07-27T00:00:00.000Z')`
      ).run()
    ).toThrow(/project grant scope is invalid/iu);
    expect(() =>
      database.prepare(
        `INSERT INTO project_grants
         (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
         VALUES ('grant-invalid-repository', 'project-1', 'principal-1', 'reader',
                 'repository', 'repository-2', '2026-07-27T00:00:00.000Z')`
      ).run()
    ).toThrow(/repository grant scope is invalid/iu);
    expect(() =>
      database.prepare(
        `INSERT INTO sessions
         (session_id, project_id, principal_id, status, agent_meta_json,
          repository_id, opened_at)
         VALUES ('session-invalid', 'project-1', 'principal-1', 'open', '{}',
                 'repository-2', '2026-07-27T00:00:00.000Z')`
      ).run()
    ).toThrow(/session repository context is invalid/iu);
    expect(() =>
      database.prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, repository_id,
          repository_authority, excerpt_hash, sensitivity_status, recorded_at)
         VALUES ('evidence-invalid', 'project-1', 'test', 'test://invalid',
                 'repository-2', 'agent_supplied', 'hash', 'clear',
                 '2026-07-27T00:00:00.000Z')`
      ).run()
    ).toThrow(/evidence repository context is invalid/iu);
    expect(() =>
      database.prepare(
        `INSERT INTO repositories
         (repository_id, project_id, provider, external_id, owner, name, created_at, updated_at)
         VALUES ('repository-duplicate', 'project-2', 'github', 301, 'owner', 'duplicate',
                 '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z')`
      ).run()
    ).toThrow(/unique/iu);

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("backfills resolvable legacy session, grant, and memory repository ownership", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 5);
    seedRepositoryAuthority(database);
    const now = "2026-07-27T00:00:00.000Z";
    database.exec(`
      INSERT INTO sessions
        (session_id, project_id, principal_id, status, agent_meta_json,
         worktree_meta_json, opened_at)
      VALUES
        ('session-legacy', 'project-1', 'principal-1', 'open', '{}',
         '{"repository_id":"repository-1","repository_ref":"refs/heads/main","worktree_id":"worktree-1"}',
         '${now}');
      INSERT INTO project_grants
        (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
      VALUES
        ('grant-legacy', 'project-1', 'principal-1', 'reader', 'session',
         'session-legacy', '${now}');
      INSERT INTO memories
        (memory_id, project_id, kind, memory_class, scope, scope_id, status,
         created_at, updated_at)
      VALUES
        ('memory-legacy', 'project-1', 'fact', 'semantic', 'session',
         'session-legacy', 'active', '${now}', '${now}');
    `);

    database.exec(readFileSync("migrations/0006_repository_scope_context.sql", "utf8"));

    expect(
      database.prepare(
        `SELECT repository_id, repository_ref, worktree_id
         FROM sessions WHERE session_id = 'session-legacy'`
      ).get()
    ).toEqual({
      repository_id: "repository-1",
      repository_ref: "refs/heads/main",
      worktree_id: "worktree-1"
    });
    expect(
      database.prepare(
        `SELECT repository_id FROM project_grant_repository_contexts
         WHERE grant_id = 'grant-legacy'`
      ).get()
    ).toEqual({ repository_id: "repository-1" });
    expect(
      database.prepare(
        `SELECT repository_id FROM memory_repository_contexts
         WHERE memory_id = 'memory-legacy'`
      ).get()
    ).toEqual({ repository_id: "repository-1" });
    expect(() =>
      database.prepare(
        `UPDATE sessions SET repository_ref = 'refs/heads/other'
         WHERE session_id = 'session-legacy'`
      ).run()
    ).toThrow(/session repository context is immutable/iu);
    expect(() =>
      database.prepare(
        `UPDATE memory_repository_contexts SET repository_id = 'repository-2'
         WHERE memory_id = 'memory-legacy'`
      ).run()
    ).toThrow(/memory repository context is immutable/iu);
  });

  it("fails closed before schema expansion when legacy repository ownership is ambiguous", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 5);
    seedRepositoryAuthority(database);
    database.prepare(
      `INSERT INTO repositories
       (repository_id, project_id, provider, external_id, owner, name, created_at, updated_at)
       VALUES ('repository-duplicate', 'project-2', 'github', 301, 'owner', 'duplicate',
               '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z')`
    ).run();

    expect(() =>
      database.exec(readFileSync("migrations/0006_repository_scope_context.sql", "utf8"))
    ).toThrow(/repository_scope_preflight/iu);
    expect(
      database.prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = 'repository_id'").get()
    ).toBeUndefined();
  });

  it.each([
    {
      label: "a ref without repository ownership",
      metadata: '{"ref":"refs/heads/main"}'
    },
    {
      label: "a worktree without repository ownership",
      metadata: '{"worktree_id":"worktree-legacy"}'
    },
    {
      label: "conflicting repository_ref and ref aliases",
      metadata:
        '{"repository_id":"repository-1","repository_ref":"refs/heads/main","ref":"refs/heads/other"}'
    }
  ])("fails closed when legacy worktree metadata contains $label", ({ metadata }) => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 5);
    seedRepositoryAuthority(database);
    database.prepare(
      `INSERT INTO sessions
       (session_id, project_id, principal_id, status, agent_meta_json,
        worktree_meta_json, opened_at)
       VALUES ('session-legacy-ambiguous', 'project-1', 'principal-1', 'open', '{}', ?,
               '2026-07-27T00:00:00.000Z')`
    ).run(metadata);
    database.exec(readFileSync("migrations/0006_repository_scope_context.sql", "utf8"));
    expect(() =>
      applyMigrationAtomically(database, "migrations/0007_repository_scope_hardening.sql")
    ).toThrow(/repository_scope_hardening_preflight/iu);
    expect(schemaObjectCount(database, "view", "invalid_session_repository_metadata")).toBe(0);
  });

  it("rolls back a failed 0007 preflight and succeeds after remediation", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 6);
    seedRepositoryAuthority(database);
    database.exec(`
      INSERT INTO sessions
        (session_id, project_id, principal_id, status, agent_meta_json,
         worktree_meta_json, opened_at)
      VALUES ('session-0007-retry', 'project-1', 'principal-1', 'open', '{}',
              '{"ref":"refs/heads/main"}', '2026-07-27T00:00:00.000Z');
    `);

    expect(() =>
      applyMigrationAtomically(database, "migrations/0007_repository_scope_hardening.sql")
    ).toThrow(/repository_scope_hardening_preflight/iu);
    expect(
      schemaObjectCount(database, "view", "invalid_session_repository_metadata") +
        schemaObjectCount(database, "table", "migration_0007_repository_scope_hardening_preflight") +
        schemaObjectCount(database, "trigger", "sessions_repository_metadata_insert_guard")
    ).toBe(0);
    database.exec(
      "UPDATE sessions SET worktree_meta_json = NULL WHERE session_id = 'session-0007-retry'"
    );
    applyMigrationAtomically(database, "migrations/0007_repository_scope_hardening.sql");
    expect(schemaObjectCount(database, "view", "invalid_session_repository_metadata")).toBe(1);
  });

  it.each([
    {
      label: "a non-project grant without canonical ownership",
      seed: (database: DatabaseSync) =>
        database.prepare(
          `INSERT INTO project_grants
           (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
           VALUES ('grant-dangling-ref', 'project-1', 'principal-1', 'reader', 'ref',
                   'repository:repository-1:ref:refs%2Fheads%2Fmain',
                   '2026-07-27T00:00:00.000Z')`
        ).run(),
      cleanup: (database: DatabaseSync) =>
        database.exec("DELETE FROM project_grants WHERE grant_id = 'grant-dangling-ref'")
    },
    {
      label: "a sync cursor owned by another project",
      seed: (database: DatabaseSync) =>
        database.prepare(
          `INSERT INTO sync_cursors
           (project_id, repository_id, ref, status, updated_at)
           VALUES ('project-1', 'repository-2', 'refs/heads/main', 'complete',
                   '2026-07-27T00:00:00.000Z')`
        ).run(),
      cleanup: (database: DatabaseSync) =>
        database.exec(
          "DELETE FROM sync_cursors WHERE project_id = 'project-1' AND repository_id = 'repository-2'"
        )
    }
  ])("fails closed when existing data contains $label", ({ seed, cleanup }) => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 7);
    seedRepositoryAuthority(database);
    seed(database);

    expect(() =>
      applyMigrationAtomically(
        database,
        "migrations/0008_canonical_repository_scope_ownership.sql"
      )
    ).toThrow(/canonical_scope_preflight/iu);
    expect(
      schemaObjectCount(database, "view", "canonical_repository_scope_ownership") +
        schemaObjectCount(database, "table", "migration_0008_canonical_scope_preflight")
    ).toBe(0);
    cleanup(database);
    applyMigrationAtomically(
      database,
      "migrations/0008_canonical_repository_scope_ownership.sql"
    );
    expect(schemaObjectCount(database, "view", "canonical_repository_scope_ownership")).toBe(1);
  });

  it("rechecks canonical ownership before installing runtime guards", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database, 8);
    seedRepositoryAuthority(database);
    database.prepare(
      `INSERT INTO sync_cursors
       (project_id, repository_id, ref, status, updated_at)
       VALUES ('project-1', 'repository-2', 'refs/heads/inter-migration', 'complete',
               '2026-07-27T00:00:00.000Z')`
    ).run();

    expect(() =>
      applyMigrationAtomically(database, "migrations/0009_repository_scope_runtime_guards.sql")
    ).toThrow(/repository_scope_runtime_preflight/iu);
    expect(
      schemaObjectCount(database, "table", "migration_0009_repository_scope_runtime_preflight") +
        schemaObjectCount(database, "trigger", "project_grant_canonical_scope_insert_guard")
    ).toBe(0);
    database.exec(
      "DELETE FROM sync_cursors WHERE project_id = 'project-1' AND repository_id = 'repository-2'"
    );
    applyMigrationAtomically(database, "migrations/0009_repository_scope_runtime_guards.sql");
    expect(schemaObjectCount(database, "trigger", "project_grant_canonical_scope_insert_guard")).toBe(1);
  });

  it("enforces canonical ownership for every repository-bound grant and memory scope", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database);
    seedRepositoryAuthority(database);
    const now = "2026-07-27T00:00:00.000Z";
    database.exec(`
      INSERT INTO sync_cursors
        (project_id, repository_id, ref, status, updated_at)
      VALUES
        ('project-1', 'repository-1', 'refs/heads/main', 'complete', '${now}'),
        ('project-1', 'repository-1', 'refs/heads/中文 branch', 'complete', '${now}');
      INSERT INTO sessions
        (session_id, project_id, principal_id, status, agent_meta_json,
         worktree_meta_json, repository_id, repository_ref, worktree_id, opened_at)
      VALUES
        ('session-owned', 'project-1', 'principal-1', 'open', '{}',
         '{"repository_id":"repository-1","repository_ref":"refs/heads/main","worktree_id":"worktree-1"}',
         'repository-1', 'refs/heads/main', 'worktree-1', '${now}'),
        ('session-unowned', 'project-1', 'principal-1', 'open', '{}', NULL,
         NULL, NULL, NULL, '${now}');
      INSERT INTO project_grants
        (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
      VALUES
        ('grant-project', 'project-1', 'principal-1', 'reader', 'project',
         'project-1', '${now}'),
        ('grant-repository', 'project-1', 'principal-1', 'reader', 'repository',
         'repository-1', '${now}'),
        ('grant-ref', 'project-1', 'principal-1', 'reader', 'ref',
         'repository:repository-1:ref:refs%2Fheads%2Fmain', '${now}'),
        ('grant-ref-unicode', 'project-1', 'principal-1', 'reader', 'ref',
         'repository:repository-1:ref:refs%2Fheads%2F%E4%B8%AD%E6%96%87%20branch', '${now}'),
        ('grant-session', 'project-1', 'principal-1', 'reader', 'session',
         'session-owned', '${now}'),
        ('grant-worktree', 'project-1', 'principal-1', 'reader', 'worktree',
         'session:session-owned:worktree:worktree-1', '${now}');
    `);

    expect(
      database.prepare(
        `SELECT grant_id, repository_id
         FROM project_grant_repository_contexts
         ORDER BY grant_id`
      ).all()
    ).toEqual([
      { grant_id: "grant-ref", repository_id: "repository-1" },
      { grant_id: "grant-ref-unicode", repository_id: "repository-1" },
      { grant_id: "grant-repository", repository_id: "repository-1" },
      { grant_id: "grant-session", repository_id: "repository-1" },
      { grant_id: "grant-worktree", repository_id: "repository-1" }
    ]);
    expect(() =>
      database.prepare(
        `INSERT INTO project_grant_repository_contexts
         (project_id, grant_id, repository_id, created_at)
         VALUES ('project-1', 'grant-ref', 'repository-1', '${now}')`
      ).run()
    ).not.toThrow();
    expect(
      database.prepare(
        `SELECT COUNT(*) AS count FROM project_grant_repository_contexts
         WHERE grant_id = 'grant-ref'`
      ).get()
    ).toEqual({ count: 1 });

    for (const [grantId, scopeKind, scopeId] of [
      ["grant-invalid-repository", "repository", "repository-2"],
      ["grant-invalid-ref", "ref", "repository:repository-1:ref:refs%2fheads%2Fmain"],
      ["grant-invalid-session", "session", "session-unowned"],
      ["grant-invalid-worktree", "worktree", "session:session-owned:worktree:other"]
    ] as const) {
      expect(() =>
        database.prepare(
          `INSERT INTO project_grants
           (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
           VALUES (?, 'project-1', 'principal-1', 'reader', ?, ?, ?)`
        ).run(grantId, scopeKind, scopeId, now)
      ).toThrow(/project grant scope is invalid/iu);
    }

    database.exec(`
      INSERT INTO memories
        (memory_id, project_id, kind, memory_class, scope, scope_id, status,
         created_at, updated_at)
      VALUES
        ('memory-project', 'project-1', 'fact', 'semantic', 'project', 'project-1',
         'active', '${now}', '${now}'),
        ('memory-repository', 'project-1', 'fact', 'semantic', 'repository', 'repository-1',
         'active', '${now}', '${now}'),
        ('memory-ref', 'project-1', 'fact', 'semantic', 'ref',
         'repository:repository-1:ref:refs%2Fheads%2Fmain', 'active', '${now}', '${now}'),
        ('memory-session', 'project-1', 'fact', 'semantic', 'session', 'session-owned',
         'active', '${now}', '${now}'),
        ('memory-worktree', 'project-1', 'fact', 'semantic', 'worktree',
         'session:session-owned:worktree:worktree-1', 'active', '${now}', '${now}');
    `);
    expect(
      database.prepare(
        `SELECT memory_id, repository_id FROM memory_repository_contexts
         ORDER BY memory_id`
      ).all()
    ).toEqual([
      { memory_id: "memory-ref", repository_id: "repository-1" },
      { memory_id: "memory-repository", repository_id: "repository-1" },
      { memory_id: "memory-session", repository_id: "repository-1" },
      { memory_id: "memory-worktree", repository_id: "repository-1" }
    ]);
    expect(() =>
      database.prepare(
        `INSERT INTO memory_repository_contexts
         (project_id, memory_id, repository_id, created_at)
         VALUES ('project-1', 'memory-ref', 'repository-1', '${now}')`
      ).run()
    ).not.toThrow();
    expect(() =>
      database.prepare(
        `INSERT INTO memories
         (memory_id, project_id, kind, memory_class, scope, scope_id, status,
          created_at, updated_at)
         VALUES ('memory-invalid-ref', 'project-1', 'fact', 'semantic', 'ref',
                 'repository:repository-1:ref:refs%2fheads%2Fmain', 'active', ?, ?)`
      ).run(now, now)
    ).toThrow(/memory scope is invalid/iu);
    expect(() =>
      database.prepare(
        `UPDATE project_grant_repository_contexts SET repository_id = 'repository-2'
         WHERE grant_id = 'grant-ref'`
      ).run()
    ).toThrow(/grant repository context is immutable/iu);
    expect(() =>
      database.prepare(
        `INSERT INTO sync_cursors
         (project_id, repository_id, ref, status, updated_at)
         VALUES ('project-1', 'repository-2', 'refs/heads/cross-project', 'complete', ?)`
      ).run(now)
    ).toThrow(/sync cursor repository ownership is invalid/iu);
    database.prepare(
      `INSERT INTO sync_cursors
       (project_id, repository_id, ref, status, updated_at)
       VALUES ('project-1', 'repository-1', 'refs/heads/unreferenced', 'complete', ?)`
    ).run(now);
    expect(() =>
      database.prepare(
        `UPDATE sync_cursors SET repository_id = 'repository-2'
         WHERE project_id = 'project-1' AND repository_id = 'repository-1'
           AND ref = 'refs/heads/unreferenced'`
      ).run()
    ).toThrow(/sync cursor repository ownership is invalid/iu);
    expect(() =>
      database.prepare(
        `UPDATE project_grants SET revoked_at = ? WHERE grant_id = 'grant-ref-unicode'`
      ).run(now)
    ).not.toThrow();
    expectSqlError(
      database,
      "UPDATE project_grants SET grant_id = 'grant-project-renamed' WHERE grant_id = 'grant-project'",
      /project grant identity is immutable/iu
    );
    expect(() =>
      database.prepare(
        `UPDATE memories SET status = 'contested', updated_at = ?
         WHERE memory_id = 'memory-ref'`
      ).run(now)
    ).not.toThrow();
    expectSqlError(
      database,
      "UPDATE memories SET memory_id = 'memory-project-renamed' WHERE memory_id = 'memory-project'",
      /memory scope identity is immutable/iu
    );
    database.exec(`
      INSERT INTO evidence
        (evidence_id, project_id, source_type, locator, excerpt_hash,
         sensitivity_status, recorded_at)
      VALUES ('evidence-stable', 'project-1', 'test', 'test://stable', 'hash',
              'clear', '${now}');
    `);
    for (const identityUpdate of [
      "evidence_id = 'evidence-renamed'",
      "project_id = 'project-2'",
      "source_type = 'github_blob'",
      "locator = 'test://forged'",
      "excerpt_hash = 'forged-hash'",
      "commit_sha = 'forged-commit'",
      "recorded_at = '2026-07-28T00:00:00.000Z'"
    ]) {
      expectSqlError(
        database,
        `UPDATE evidence SET ${identityUpdate} WHERE evidence_id = 'evidence-stable'`,
        /evidence (identity|repository context) is immutable/iu
      );
    }
    expect(() =>
      database.exec(
        "UPDATE evidence SET sensitivity_status = 'quarantined', object_uri = 'r2://quarantine' " +
          "WHERE evidence_id = 'evidence-stable'"
      )
    ).not.toThrow();
    expect(() =>
      database.prepare(
        `DELETE FROM sync_cursors
         WHERE project_id = 'project-1' AND repository_id = 'repository-1'
           AND ref = 'refs/heads/main'`
      ).run()
    ).toThrow(/GitHub sync cursors cannot be deleted/iu);
    expectSqlError(
      database,
      "DELETE FROM sessions WHERE session_id = 'session-owned'",
      /session scope ownership is referenced/iu
    );
    expectSqlError(
      database,
      "UPDATE sessions SET session_id = 'session-rebound' WHERE session_id = 'session-owned'",
      /session identity is immutable/iu
    );
    expect(() =>
      database.prepare(
        `INSERT INTO sessions
         (session_id, project_id, principal_id, status, agent_meta_json,
          worktree_meta_json, opened_at)
         VALUES ('session-invalid-metadata', 'project-1', 'principal-1', 'open', '{}',
                 '{"ref":"refs/heads/main"}', ?)`
      ).run(now)
    ).toThrow(/session repository metadata is invalid/iu);
    expect(() =>
      database.prepare(
        `UPDATE memories SET scope_id = 'repository:repository-1:ref:refs%2Fheads%2Fother'
         WHERE memory_id = 'memory-ref'`
      ).run()
    ).toThrow(/memory scope is invalid|memory scope identity is immutable/iu);

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it("allows only clear evidence to be linked to a new memory version", () => {
    const database = new DatabaseSync(":memory:");
    applyAuthorityMigrations(database);
    seedAuthority(database);
    const now = "2026-07-28T00:00:00.000Z";
    database.exec(`
      INSERT INTO memory_versions
        (revision_id, project_id, memory_id, memory_version, content, content_sha256,
         audit_id, recorded_at)
      VALUES ('revision-evidence-guard', 'project-1', 'memory-1', 1, 'content', 'sha',
              'audit-1', '${now}');
      INSERT INTO evidence
        (evidence_id, project_id, source_type, locator, excerpt_hash,
         sensitivity_status, recorded_at)
      VALUES
        ('evidence-clear', 'project-1', 'test', 'test://clear', 'clear-hash', 'clear', '${now}'),
        ('evidence-quarantined', 'project-1', 'test', 'test://quarantined',
         'quarantined-hash', 'quarantined', '${now}'),
        ('evidence-tombstone', 'project-1', 'test', 'test://tombstone',
         'tombstone-hash', 'tombstone', '${now}');
      INSERT INTO version_evidence (project_id, revision_id, evidence_id)
      VALUES ('project-1', 'revision-evidence-guard', 'evidence-clear');
    `);

    for (const evidenceId of ["evidence-quarantined", "evidence-tombstone"]) {
      expectSqlError(
        database,
        `INSERT INTO version_evidence (project_id, revision_id, evidence_id)
         VALUES ('project-1', 'revision-evidence-guard', '${evidenceId}')`,
        /clear evidence is required/iu
      );
    }
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM version_evidence").get()
    ).toEqual({ count: 1 });
    expect(() =>
      database.exec(
        "UPDATE evidence SET sensitivity_status = 'quarantined' " +
          "WHERE evidence_id = 'evidence-clear'"
      )
    ).not.toThrow();
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM version_evidence").get()
    ).toEqual({ count: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it("keeps the activation migration compatible with old sync writers and fences ABA", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyAuthorityMigrations(database, 16);
    seedGitHubActivationMigrationFixture(database);
    database.exec(`
      INSERT INTO github_repository_sync_runs
        (run_id, project_id, repository_id, scheduled_for,
         full_reconciliation, status, started_at, lease_expires_at)
      VALUES
        ('legacy-run', 'activation-project', 'activation-repository',
         '2026-07-30T00:00:00.000Z', 0, 'running',
         '2026-07-30T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    `);

    applyMigrationAtomically(
      database,
      "migrations/0017_github_sync_activation_receipts.sql"
    );
    const witnessCleanupPlan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT activation_token
         FROM github_tree_activation_witnesses
         WHERE project_id = ?
         ORDER BY created_at, activation_token`
      )
      .all("activation-project") as Array<{ detail: string }>;
    expect(witnessCleanupPlan.map((row) => row.detail).join("\n")).toMatch(
      /github_tree_activation_witnesses_by_project/iu
    );
    expect(
      database
        .prepare(
          `SELECT claim_contract_version, claimed_ref,
                  repository_configuration_version, cursor_version
           FROM github_repository_sync_runs WHERE run_id = 'legacy-run'`
        )
        .get()
    ).toEqual({
      claim_contract_version: 0,
      claimed_ref: null,
      repository_configuration_version: null,
      cursor_version: null
    });
    expect(() =>
      database.exec(`
        UPDATE repositories
        SET tracked_refs_json = '["refs/heads/feature"]'
        WHERE project_id = 'activation-project'
          AND repository_id = 'activation-repository';
        UPDATE sync_cursors
        SET updated_at = '2026-07-30T00:00:01.000Z'
        WHERE project_id = 'activation-project'
          AND repository_id = 'activation-repository'
          AND ref = 'refs/heads/main';
        UPDATE github_repository_sync_runs
        SET status = 'complete', completed_at = '2026-07-30T00:00:01.000Z'
        WHERE run_id = 'legacy-run';
      `)
    ).not.toThrow();
    expect(
      database
        .prepare(
          `SELECT
             (SELECT github_sync_configuration_version FROM repositories
              WHERE repository_id = 'activation-repository') AS repository_version,
             (SELECT cursor_version FROM sync_cursors
              WHERE repository_id = 'activation-repository'
                AND ref = 'refs/heads/main') AS cursor_version`
        )
        .get()
    ).toEqual({ repository_version: 2, cursor_version: 2 });
    expect(() =>
      database.exec(
        `UPDATE github_repository_sync_runs
         SET scheduled_for = '2026-07-30T06:00:00.000Z'
         WHERE run_id = 'legacy-run'`
      )
    ).toThrow(/sync run claim is immutable/iu);
    expect(() =>
      database.exec(
        `UPDATE github_repository_sync_runs
         SET status = 'running', completed_at = NULL
         WHERE run_id = 'legacy-run'`
      )
    ).toThrow(/sync run is terminal/iu);
    expect(() =>
      database.exec(
        `DELETE FROM sync_cursors
         WHERE project_id = 'activation-project'
           AND repository_id = 'activation-repository'
           AND ref = 'refs/heads/main'`
      )
    ).toThrow(/sync cursors cannot be deleted/iu);
    expect(() =>
      database.exec(
        `INSERT INTO sync_cursors
          (project_id, repository_id, ref, status, credential_status,
           history_gap_possible, updated_at, cursor_version)
         VALUES
          ('activation-project', 'activation-repository', 'refs/heads/feature',
           'idle', 'active', 0, '2026-07-30T00:00:02.000Z', 2)`
      )
    ).toThrow(/initial version must be one/iu);
    expect(schemaObjectCount(
      database,
      "table",
      "github_sync_activation_schema_preflight"
    )).toBe(0);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps GitHub sync runs append-only outside synthetic cleanup", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyAuthorityMigrations(database);
    seedGitHubActivationMigrationFixture(database);
    seedSyntheticAuthority(database);
    database.exec(`
      INSERT INTO github_repository_sync_runs
        (run_id, project_id, repository_id, scheduled_for,
         full_reconciliation, status, started_at, lease_expires_at,
         claimed_ref, claimed_head_manifest_id, claimed_head_version,
         repository_configuration_version, cursor_version,
         claim_contract_version)
      VALUES
        ('ordinary-claimed-run', 'activation-project', 'activation-repository',
         '2026-07-30T00:00:00.000Z', 0, 'running',
         '2026-07-30T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
         'refs/heads/main', NULL, 0, 1, 1, 1);
      INSERT INTO synthetic_cleanup_registry
        (project_id, principal_id, expires_at, created_at)
      VALUES
        ('synthetic-project', 'synthetic-principal',
         '2026-07-26T00:00:00.000Z', '2026-07-25T00:00:00.000Z');
      INSERT INTO repositories
        (repository_id, project_id, provider, external_id,
         expected_owner_external_id, owner, name, default_branch,
         tracked_refs_json, sync_enabled, created_at, updated_at)
      VALUES
        ('synthetic-repository', 'synthetic-project', 'github', 9301, 7,
         'owner', 'synthetic-repository', 'main', '[]', 1,
         '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z');
      INSERT INTO github_repository_sync_runs
        (run_id, project_id, repository_id, scheduled_for,
         full_reconciliation, status, started_at, lease_expires_at)
      VALUES
        ('synthetic-run', 'synthetic-project', 'synthetic-repository',
         '2026-07-25T00:00:00.000Z', 0, 'running',
         '2026-07-25T00:00:00.000Z', '2026-07-25T00:15:00.000Z');
    `);

    expect(() =>
      database.exec(
        "DELETE FROM github_repository_sync_runs " +
          "WHERE run_id = 'ordinary-claimed-run'"
      )
    ).toThrow(/GitHub repository sync runs cannot be deleted/iu);
    expect(() =>
      database.exec(
        "DELETE FROM github_repository_sync_runs WHERE run_id = 'synthetic-run'"
      )
    ).not.toThrow();
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM github_repository_sync_runs
           WHERE run_id = 'synthetic-run'`
        )
        .get()
    ).toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("requires GitHub repository configuration versions to start at one", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyAuthorityMigrations(database);
    seedGitHubActivationMigrationFixture(database);

    expect(() =>
      database.exec(`
        INSERT INTO repositories
          (repository_id, project_id, provider, external_id,
           expected_owner_external_id, owner, name, default_branch,
           tracked_refs_json, sync_enabled, created_at, updated_at,
           github_sync_configuration_version)
        VALUES
          ('repository-invalid-version', 'activation-project', 'github', 302, 7,
           'owner', 'invalid-version', 'main', '[]', 1,
           '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z', 2)
      `)
    ).toThrow(/GitHub repository configuration initial version must be one/iu);
    database.exec(`
      INSERT INTO repositories
        (repository_id, project_id, provider, external_id,
         expected_owner_external_id, owner, name, default_branch,
         tracked_refs_json, sync_enabled, created_at, updated_at)
      VALUES
        ('repository-default-version', 'activation-project', 'github', 303, 7,
         'owner', 'default-version', 'main', '[]', 1,
         '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')
    `);
    expect(
      database
        .prepare(
          `SELECT github_sync_configuration_version AS version
           FROM repositories WHERE repository_id = 'repository-default-version'`
        )
        .get()
    ).toEqual({ version: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects a legacy head version that JavaScript cannot fence exactly", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyAuthorityMigrations(database, 16);
    seedGitHubActivationMigrationFixture(database);
    database.exec(`
      INSERT INTO github_tree_manifests
        (manifest_id, project_id, repository_id, ref, observed_sha, tree_sha,
         repository_authority, collection_key, status, created_at)
      VALUES
        ('${"a".repeat(64)}', 'activation-project', 'activation-repository',
         'refs/heads/main', '${"b".repeat(40)}', '${"c".repeat(40)}',
         'default_branch', '2026-07-30T00:00:00.000Z', 'staging',
         '2026-07-30T00:00:00.000Z');
      UPDATE github_tree_manifests
      SET status = 'complete', entry_count = 0,
          entries_checksum = '${"d".repeat(64)}',
          completed_at = '2026-07-30T00:00:00.000Z'
      WHERE manifest_id = '${"a".repeat(64)}';
      INSERT INTO github_tree_ref_heads
        (project_id, repository_id, ref, manifest_id, head_version,
         activated_at, updated_at)
      VALUES
        ('activation-project', 'activation-repository', 'refs/heads/main',
         '${"a".repeat(64)}', 9007199254740992,
         '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z');
    `);

    expect(() =>
      applyMigrationAtomically(
        database,
        "migrations/0017_github_sync_activation_receipts.sql"
      )
    ).toThrow(/invalid_head_version_count/iu);
    expect(schemaObjectCount(
      database,
      "table",
      "github_tree_activation_receipts"
    )).toBe(0);
  });
});

describe("search D1 migrations", () => {
  it("applies cleanly and enforces one monotonic projection head per generation", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of SEARCH_MIGRATIONS) {
      database.exec(readFileSync(migration, "utf8"));
    }

    const generation = "qwen3-embedding-0.6b-chunk-2026-07-25";
    const advance = database.prepare(
      `INSERT INTO memory_projection_heads
       (generation_id, project_id, memory_id, project_version, revision_id,
        repository_partition, chunk_count)
       VALUES (?, 'project-1', 'memory-1', ?, ?, '*', 0)
       ON CONFLICT(generation_id, project_id, memory_id) DO UPDATE SET
         project_version = excluded.project_version,
         revision_id = excluded.revision_id,
         chunk_count = excluded.chunk_count
       WHERE excluded.project_version > memory_projection_heads.project_version
          OR (
            excluded.project_version = memory_projection_heads.project_version
            AND excluded.revision_id = memory_projection_heads.revision_id
          )`
    );
    const runAdvance = (projectVersion: number, revisionId: string): number => {
      insertProjectionWriteLease(database, {
        generationId: generation,
        projectId: "project-1",
        memoryId: "memory-1",
        projectVersion,
        revisionId,
        repositoryPartition: "*",
        chunkCount: 0
      });
      try {
        return Number(advance.run(generation, projectVersion, revisionId).changes);
      } finally {
        deleteProjectionWriteLease(database, generation, "project-1", "memory-1");
      }
    };
    expect(runAdvance(7, "revision-1")).toBe(1);
    expect(runAdvance(6, "revision-stale")).toBe(0);
    expect(runAdvance(7, "revision-conflict")).toBe(0);
    expect(runAdvance(8, "revision-2")).toBe(1);
    expect(runAdvance(8, "revision-2")).toBe(1);
    expect(
      database.prepare(
        `SELECT project_version, revision_id FROM memory_projection_heads
         WHERE generation_id = ? AND project_id = 'project-1' AND memory_id = 'memory-1'`
      ).get(generation)
    ).toEqual({ project_version: 8, revision_id: "revision-2" });
    expect(() =>
      insertProjectionWriteLease(database, {
        generationId: generation,
        projectId: "project-1",
        memoryId: "memory-2",
        projectVersion: -1,
        revisionId: "revision-1",
        repositoryPartition: "*",
        chunkCount: 1
      })
    ).toThrow(/check/iu);

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it("uses the owner ledger index and FTS rowid path for chunk cleanup", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of SEARCH_MIGRATIONS) {
      database.exec(readFileSync(migration, "utf8"));
    }

    const generation = "qwen3-embedding-0.6b-chunk-2026-07-25";
    insertProjectionWriteLease(database, {
      generationId: generation,
      projectId: "project-1",
      memoryId: "memory-1",
      projectVersion: 7,
      revisionId: "revision-1",
      repositoryPartition: "*",
      chunkCount: 1
    });
    database.prepare(
      `INSERT INTO memory_projection_heads
       (generation_id, project_id, memory_id, project_version, revision_id,
        repository_partition, chunk_count)
       VALUES (?, 'project-1', 'memory-1', 7, 'revision-1', '*', 1)`
    ).run(generation);
    database.prepare(
      `INSERT INTO memory_fts_chunk_ledger
       (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
       VALUES (?, 'project-1', 'memory-1', 'revision-1', 'chunk-0', ?)`
    ).run(generation, "a".repeat(64));
    const ledger = database.prepare(
      `SELECT fts_rowid FROM memory_fts_chunk_ledger
       WHERE generation_id = ? AND project_id = 'project-1'
         AND memory_id = 'memory-1'`
    ).get(generation) as { fts_rowid: number };
    database.prepare(
      `INSERT INTO memory_fts
       (rowid, generation_id, project_id, memory_id, revision_id, chunk_id,
        status, kind, memory_class, scope, scope_id, content)
       VALUES (?, ?, 'project-1', 'memory-1', 'revision-1', 'chunk-0',
               'active', 'fact', 'semantic', 'project', 'project-1', 'content')`
    ).run(ledger.fts_rowid, generation);
    deleteProjectionWriteLease(database, generation, "project-1", "memory-1");

    const ownerPlan = database.prepare(
      `EXPLAIN QUERY PLAN
       SELECT fts_rowid, vector_id
       FROM memory_fts_chunk_ledger INDEXED BY memory_fts_chunk_ledger_by_owner
       WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
    ).all(generation, "project-1", "memory-1") as Array<{ detail: string }>;
    expect(ownerPlan.map((row) => row.detail).join("\n")).toMatch(
      /memory_fts_chunk_ledger_by_owner/iu
    );

    const rowidPlan = database.prepare(
      "EXPLAIN QUERY PLAN DELETE FROM memory_fts WHERE rowid = ?"
    ).all(ledger.fts_rowid) as Array<{ detail: string }>;
    expect(rowidPlan.map((row) => row.detail).join("\n")).toMatch(
      /virtual table index[^\n]*=/iu
    );

    expect(
      database.prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'trigger'
           AND name IN (
             'memory_fts_chunk_ledger_delete_ownership_guard',
             'memory_fts_chunk_ledger_delete_fts'
           )
         ORDER BY name`
      ).all()
    ).toEqual([
      { name: "memory_fts_chunk_ledger_delete_fts" },
      { name: "memory_fts_chunk_ledger_delete_ownership_guard" }
    ]);
    database.prepare(
      "UPDATE memory_fts SET memory_id = 'memory-other' WHERE rowid = ?"
    ).run(ledger.fts_rowid);
    expect(() =>
      database.prepare(
        `DELETE FROM memory_fts_chunk_ledger
         WHERE generation_id = ? AND project_id = 'project-1'
           AND memory_id = 'memory-1' AND revision_id = 'revision-1'
           AND chunk_id = 'chunk-0'`
      ).run(generation)
    ).toThrow(/chunk ledger does not own its FTS row/iu);
    database.prepare(
      "UPDATE memory_fts SET memory_id = 'memory-1' WHERE rowid = ?"
    ).run(ledger.fts_rowid);

    database.prepare(
      `DELETE FROM memory_fts_chunk_ledger
       WHERE generation_id = ? AND project_id = 'project-1'
         AND memory_id = 'memory-1' AND revision_id = 'revision-1'
         AND chunk_id = 'chunk-0'`
    ).run(generation);
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_fts").get()).toEqual({
      count: 0
    });
  });

  it("fails closed on legacy search rows, rolls back, and can retry after reset", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of SEARCH_MIGRATIONS.slice(0, -1)) {
      database.exec(readFileSync(migration, "utf8"));
    }
    const generation = "qwen3-embedding-0.6b-chunk-2026-07-25";
    database.prepare(
      `INSERT INTO memory_projection_heads
       (generation_id, project_id, memory_id, project_version, revision_id,
        repository_partition)
       VALUES (?, 'project-1', 'memory-1', 7, 'revision-legacy', '*')`
    ).run(generation);
    database.prepare(
      `INSERT INTO memory_fts
       (generation_id, project_id, memory_id, revision_id, chunk_id, status, kind,
        memory_class, scope, scope_id, content)
       VALUES (?, 'project-1', 'memory-1', 'revision-legacy', 'chunk-0', 'active',
               'fact', 'semantic', 'project', 'project-1', 'legacy')`
    ).run(generation);
    const ledgerMigration = readFileSync(SEARCH_MIGRATIONS.at(-1)!, "utf8");

    expect(() => executeMigrationAtomically(database, ledgerMigration)).toThrow(
      /legacy search projection must be cleared/iu
    );
    expect(
      database.prepare(
        `SELECT 1 FROM pragma_table_info('memory_projection_heads')
         WHERE name = 'chunk_count'`
      ).get()
    ).toBeUndefined();
    expect(
      database.prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name = 'memory_fts_chunk_ledger'`
      ).get()
    ).toBeUndefined();

    database.exec("DELETE FROM memory_fts; DELETE FROM memory_projection_heads;");
    expect(() => executeMigrationAtomically(database, ledgerMigration)).not.toThrow();
    expect(
      database.prepare(
        `SELECT "notnull" AS required FROM pragma_table_info('memory_projection_heads')
         WHERE name = 'chunk_count'`
      ).get()
    ).toEqual({ required: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_fts_chunk_ledger").get())
      .toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it("rejects pre-ledger Worker head writes after the chunk-ledger migration", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of SEARCH_MIGRATIONS) {
      database.exec(readFileSync(migration, "utf8"));
    }
    const generation = "qwen3-embedding-0.6b-chunk-2026-07-25";

    expect(() =>
      database.prepare(
        `INSERT INTO memory_projection_heads
         (generation_id, project_id, memory_id, project_version, revision_id,
          repository_partition)
         VALUES (?, 'project-1', 'memory-legacy', 7, 'revision-legacy', '*')`
      ).run(generation)
    ).toThrow(/chunk ledger protocol/iu);
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_projection_heads").get())
      .toEqual({ count: 0 });
  });

  it("preserves vector cleanup receipts until whole-project cleanup drains them", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of SEARCH_MIGRATIONS) {
      database.exec(readFileSync(migration, "utf8"));
    }
    const generation = "qwen3-embedding-0.6b-chunk-2026-07-25";
    const vectorId = "a".repeat(64);
    insertProjectionWriteLease(database, {
      generationId: generation,
      projectId: "project-1",
      memoryId: "memory-1",
      projectVersion: 7,
      revisionId: "revision-1",
      repositoryPartition: "*",
      chunkCount: 1
    });
    database.prepare(
      `INSERT INTO memory_projection_heads
       (generation_id, project_id, memory_id, project_version, revision_id,
        repository_partition, chunk_count)
       VALUES (?, 'project-1', 'memory-1', 7, 'revision-1', '*', 1)`
    ).run(generation);
    database.prepare(
      `INSERT INTO memory_fts_chunk_ledger
       (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
       VALUES (?, 'project-1', 'memory-1', 'revision-1', 'chunk-0', ?)`
    ).run(generation, vectorId);
    const row = database.prepare(
      "SELECT fts_rowid FROM memory_fts_chunk_ledger WHERE vector_id = ?"
    ).get(vectorId) as { fts_rowid: number };
    database.prepare(
      `INSERT INTO memory_fts
       (rowid, generation_id, project_id, memory_id, revision_id, chunk_id,
        status, kind, memory_class, scope, scope_id, content)
       VALUES (?, ?, 'project-1', 'memory-1', 'revision-1', 'chunk-0',
               'active', 'fact', 'semantic', 'project', 'project-1', 'content')`
    ).run(row.fts_rowid, generation);
    database.prepare(
      `INSERT INTO memory_search_projection_deletions
       (generation_id, project_id, memory_id, revision_id, project_version, chunk_count)
       VALUES (?, 'project-1', 'memory-1', 'revision-1', 7, 1)`
    ).run(generation);
    database.prepare(
      `INSERT INTO memory_search_vector_cleanup_receipts
       (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
       VALUES (?, 'project-1', 'memory-1', 'revision-1', 'chunk-0', ?)`
    ).run(generation, vectorId);
    deleteProjectionWriteLease(database, generation, "project-1", "memory-1");

    database.exec(`
      DELETE FROM memory_fts WHERE project_id = 'project-1';
      DELETE FROM memory_projection_heads WHERE project_id = 'project-1';
    `);

    expect(
      database.prepare(
        "SELECT COUNT(*) AS count FROM memory_search_vector_cleanup_receipts"
      ).get()
    ).toEqual({ count: 1 });
    database.exec(
      "DELETE FROM memory_search_vector_cleanup_receipts WHERE project_id = 'project-1'"
    );

    for (const table of [
      "memory_fts",
      "memory_fts_chunk_ledger",
      "memory_projection_heads",
      "memory_search_projection_deletions",
      "memory_search_vector_cleanup_receipts"
    ]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0
      });
    }
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });
});

function executeMigrationAtomically(database: DatabaseSync, migration: string): void {
  database.exec("BEGIN");
  try {
    database.exec(migration);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertProjectionWriteLease(
  database: DatabaseSync,
  input: {
    generationId: string;
    projectId: string;
    memoryId: string;
    revisionId: string;
    projectVersion: number;
    repositoryPartition: string;
    chunkCount: number;
  }
): void {
  database.prepare(
    `INSERT INTO memory_search_projection_write_leases
     (generation_id, project_id, memory_id, revision_id, project_version,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.generationId,
    input.projectId,
    input.memoryId,
    input.revisionId,
    input.projectVersion,
    input.repositoryPartition,
    input.chunkCount
  );
}

function deleteProjectionWriteLease(
  database: DatabaseSync,
  generationId: string,
  projectId: string,
  memoryId: string
): void {
  database.prepare(
    `DELETE FROM memory_search_projection_write_leases
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  ).run(generationId, projectId, memoryId);
}

function seedAuthority(database: DatabaseSync): void {
  const now = "2026-07-25T00:00:00.000Z";
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
    VALUES ('project-1', 'project-1', 'project-1', 'Project', 0, '${now}', '${now}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES ('principal-1', 'test', 'principal-1', 'digest-1', '${now}');
    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES ('grant-1', 'project-1', 'principal-1', 'maintainer', 'project',
            'project-1', '${now}');
    INSERT INTO audit_events
      (audit_id, project_id, sequence, event_type, actor_principal_id,
       request_digest, event_hash, recorded_at)
    VALUES ('audit-1', 'project-1', 1, 'test', 'principal-1', 'request', 'event', '${now}');
    INSERT INTO memories
      (memory_id, project_id, memory_version, kind, memory_class, scope, scope_id,
       status, created_at, updated_at)
    VALUES ('memory-1', 'project-1', 0, 'fact', 'semantic', 'project', 'project-1',
            'active', '${now}', '${now}');
  `);
}

function insertObservation(
  database: DatabaseSync,
  observationId: string,
  validFrom: string | null,
  validUntil: string | null
): void {
  database.prepare(
    `INSERT INTO observations
     (observation_id, project_id, principal_id, candidate_version, status, content,
      content_sha256, evidence_json, valid_from, valid_until, created_at)
     VALUES (?, 'project-1', 'principal-1', 1, 'queued', 'candidate', 'sha', '[]',
             ?, ?, '2026-07-25T00:00:00.000Z')`
  ).run(observationId, validFrom, validUntil);
}

function insertMemoryVersion(
  database: DatabaseSync,
  validFrom: string | null,
  validUntil: string | null
): void {
  database.prepare(
    `INSERT INTO memory_versions
     (revision_id, project_id, memory_id, memory_version, content, content_sha256,
      valid_from, valid_until, audit_id, recorded_at)
     VALUES ('legacy-revision', 'project-1', 'memory-1', 1, 'content', 'sha',
             ?, ?, 'audit-1', '2026-07-25T00:00:00.000Z')`
  ).run(validFrom, validUntil);
}

function seedSyntheticAuthority(database: DatabaseSync): void {
  const now = "2026-07-25T00:00:00.000Z";
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
    VALUES ('synthetic-project', 'system.synthetic.synthetic-project',
            'system.synthetic.synthetic-project', 'Synthetic Project', 0, '${now}', '${now}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES ('synthetic-principal', 'system.synthetic', 'synthetic-principal',
            'synthetic-digest', '${now}');
  `);
}

function seedRepositoryAuthority(database: DatabaseSync): void {
  const now = "2026-07-27T00:00:00.000Z";
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, created_at, updated_at)
    VALUES
      ('project-1', 'repository-project-1', 'repository-locator-1', 'Project 1',
       '${now}', '${now}'),
      ('project-2', 'repository-project-2', 'repository-locator-2', 'Project 2',
       '${now}', '${now}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES ('principal-1', 'repository-test', 'principal-1', 'repository-digest-1', '${now}');
    INSERT INTO repositories
      (repository_id, project_id, provider, external_id, owner, name, created_at, updated_at)
    VALUES
      ('repository-1', 'project-1', 'github', 301, 'owner', 'one', '${now}', '${now}'),
      ('repository-2', 'project-2', 'github', 302, 'owner', 'two', '${now}', '${now}');
  `);
}

function seedGitHubActivationMigrationFixture(database: DatabaseSync): void {
  const now = "2026-07-30T00:00:00.000Z";
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, project_version,
       created_at, updated_at)
    VALUES
      ('activation-project', 'activation-project', 'activation-project',
       'Activation Project', 0, '${now}', '${now}');
    INSERT INTO repositories
      (repository_id, project_id, provider, external_id,
       expected_owner_external_id, owner, name, default_branch,
       tracked_refs_json, sync_enabled, created_at, updated_at)
    VALUES
      ('activation-repository', 'activation-project', 'github', 301, 7,
       'owner', 'repository', 'main', '[]', 1, '${now}', '${now}');
    INSERT INTO sync_cursors
      (project_id, repository_id, ref, status, history_gap_possible,
       credential_status, updated_at)
    VALUES
      ('activation-project', 'activation-repository', 'refs/heads/main',
       'idle', 0, 'active', '${now}');
  `);
}

function applyAuthorityMigrations(
  database: DatabaseSync,
  count: number = AUTHORITY_MIGRATIONS.length
): void {
  for (const migration of AUTHORITY_MIGRATIONS.slice(0, count)) {
    database.exec(readFileSync(migration, "utf8"));
  }
}

function expectSqlError(database: DatabaseSync, sql: string, error: RegExp): void {
  expect(() => database.exec(sql)).toThrow(error);
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

function schemaObjectCount(database: DatabaseSync, type: string, name: string): number {
  return (
    database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = ? AND name = ?").get(
      type,
      name
    ) as { count: number }
  ).count;
}
