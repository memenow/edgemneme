import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync
} from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  isProjectWorkAdmitted,
  reapExpiredSyntheticProjects
} from "../src/workflows/synthetic-cleanup";

// @ts-expect-error The JavaScript runtime helper has no separate declaration file.
import * as syntheticCanarySupport from "../scripts/synthetic-canary-support.mjs";

const { PROJECT_SCOPED_TABLES, syntheticCleanupSql, syntheticSeedSql } =
  syntheticCanarySupport;

const PROJECT_ID = "synthetic-project";
const PRINCIPAL_ID = "synthetic-principal";
const WORKFLOW_ID = "synthetic-workflow";
const GENERATION_ID = "qwen3-embedding-0.6b-chunk-2026-07-25";
const REVISION_ID = "synthetic-revision";
const VECTOR_ID = testVectorId(GENERATION_ID, PROJECT_ID, REVISION_ID, "chunk-0");
const RETIRED_GENERATION_ID = "retired-generation";
const PREFIX = `projects/${PROJECT_ID}/projections/`;
const MEMORY_MIGRATIONS = [
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
  "migrations/0018_consolidation_batch_receipts.sql",
  "migrations/0019_github_sync_workflows.sql",
  "migrations/0020_consolidation_input_shape.sql"
] as const;

describe("scheduled synthetic cleanup", () => {
  it("registers the canary for cleanup 23 hours after creation", () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of MEMORY_MIGRATIONS) {
      database.exec(readFileSync(migration, "utf8"));
    }
    database.exec(
      syntheticSeedSql({
        projectId: "seed-project",
        principalId: "seed-principal",
        repositoryId: "seed-canary-repository",
        projectRef: "system.synthetic.seed-project",
        tokenDigest: "seed-token-digest",
        promotionCandidateId: "seed-candidate",
        now: "2026-07-25T00:00:00.000Z"
      })
    );

    expect(
      database
        .prepare(
          `SELECT registry.expires_at, observation.analysis_json
           FROM synthetic_cleanup_registry AS registry
           JOIN observations AS observation
             ON observation.project_id = registry.project_id
           WHERE registry.project_id = 'seed-project'`
        )
        .get()
    ).toEqual({
      expires_at: "2026-07-25T23:00:00.000Z",
      analysis_json: expect.stringContaining('"persistent_value":true')
    });
    const analysis = JSON.parse(
      String(
        database.prepare(
          `SELECT analysis_json FROM observations
           WHERE project_id = 'seed-project' AND observation_id = 'seed-candidate'`
        ).get()?.analysis_json
      )
    ) as Record<string, unknown>;
    expect(analysis.evidence_source_ids).toHaveLength(1);
    expect(
      database
        .prepare(
          `SELECT repository_id, provider, sync_enabled
           FROM repositories WHERE project_id = 'seed-project'`
        )
        .get()
    ).toEqual({
      repository_id: "seed-canary-repository",
      provider: "system.synthetic.seed-project",
      sync_enabled: 0
    });
  });

  it("keeps the runner cleanup child-first with the durable registration last", () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of MEMORY_MIGRATIONS) {
      database.exec(readFileSync(migration, "utf8"));
    }
    database.exec(
      syntheticSeedSql({
        projectId: "runner-project",
        principalId: "runner-principal",
        repositoryId: "runner-canary-repository",
        projectRef: "system.synthetic.runner-project",
        tokenDigest: "runner-token-digest",
        promotionCandidateId: "runner-candidate",
        now: "2026-07-25T00:00:00.000Z"
      })
    );
    seedRepositoryScopedRows(
      database,
      "runner-project",
      "runner-principal",
      201
    );
    database.exec(
      syntheticSeedSql({
        projectId: "preserved-project",
        principalId: "preserved-principal",
        repositoryId: "preserved-canary-repository",
        projectRef: "system.synthetic.preserved-project",
        tokenDigest: "preserved-token-digest",
        promotionCandidateId: "preserved-candidate",
        now: "2026-07-25T00:00:00.000Z"
      })
    );
    seedRepositoryScopedRows(
      database,
      "preserved-project",
      "preserved-principal",
      202
    );
    seedGitHubCredential(database, "runner-principal", "runner-project");
    seedGitHubWorkflowRows(database, "runner-project");

    expect(repositoryScopedCounts(database, "runner-project")).toEqual({
      repositories: 2,
      repository_sessions: 1,
      grant_contexts: 1,
      memory_contexts: 1,
      sync_cursors: 1,
      sync_runs: 2,
      tree_manifests: 2,
      tree_lifecycle_events: 1,
      tree_entries: 2,
      tree_deltas: 1,
      tree_heads: 1
    });

    expect(() =>
      database.exec(syntheticCleanupSql("runner-project", "runner-principal"))
    ).not.toThrow();
    expect(
      database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM projects WHERE project_id = 'runner-project') AS projects,
             (SELECT COUNT(*) FROM principals WHERE principal_id = 'runner-principal') AS principals,
             (SELECT COUNT(*) FROM synthetic_cleanup_registry
              WHERE project_id = 'runner-project') AS registrations`
        )
        .get()
    ).toEqual({ projects: 0, principals: 0, registrations: 0 });
    expect(repositoryScopedCounts(database, "preserved-project")).toEqual({
      repositories: 2,
      repository_sessions: 1,
      grant_contexts: 1,
      memory_contexts: 1,
      sync_cursors: 1,
      sync_runs: 1,
      tree_manifests: 2,
      tree_lifecycle_events: 1,
      tree_entries: 2,
      tree_deltas: 1,
      tree_heads: 1
    });
  });

  it("orders every runner authority table before its foreign key parents", () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of MEMORY_MIGRATIONS) {
      database.exec(readFileSync(migration, "utf8"));
    }
    const cleanupSql = syntheticCleanupSql("order-project", "order-principal") as string;
    const deletionTables = [...cleanupSql.matchAll(/^DELETE FROM ([a-z_]+)\b/gmu)].map(
      (match) => match[1] as string
    );
    expect(deletionTables).toEqual([
      "github_credential_expiry_warnings",
      "github_credential_states",
      "github_rate_observations",
      "github_access_baselines",
      ...(PROJECT_SCOPED_TABLES as string[]),
      "github_sync_dispatch_materialization_receipts",
      "github_sync_dispatches",
      "github_credential_sync_lane_release_receipts",
      "github_credential_sync_lane",
      "synthetic_cleanup_registry",
      "principals",
      "projects"
    ]);
    const deletionOrder = new Map<string, number>(
      deletionTables.map((table, index) => [table, index])
    );

    for (const [childTable, childIndex] of deletionOrder) {
      if (!/^[a-z_]+$/u.test(childTable)) {
        throw new TypeError("Synthetic cleanup table names must be simple identifiers.");
      }
      const parents = database
        .prepare(`PRAGMA foreign_key_list("${childTable}")`)
        .all() as Array<{ table: string }>;
      for (const parent of parents) {
        const parentIndex = deletionOrder.get(parent.table);
        if (parentIndex !== undefined) {
          expect(childIndex, `${childTable} must be deleted before ${parent.table}`)
            .toBeLessThan(parentIndex);
        }
      }
    }
  });

  it("terminates nonterminal workflows, paginates an exact R2 prefix, and deletes authority last", async () => {
    const fixture = createFixture();
    expect(
      fixture.memory
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM repositories WHERE project_id = ?) AS repositories,
             (SELECT COUNT(*) FROM sessions
              WHERE project_id = ? AND repository_id IS NOT NULL) AS repository_sessions,
             (SELECT COUNT(*) FROM project_grant_repository_contexts
              WHERE project_id = ?) AS grant_contexts,
             (SELECT COUNT(*) FROM memory_repository_contexts
              WHERE project_id = ?) AS memory_contexts,
             (SELECT COUNT(*) FROM sync_cursors WHERE project_id = ?) AS sync_cursors,
             (SELECT COUNT(*) FROM github_repository_sync_runs
              WHERE project_id = ?) AS sync_runs,
             (SELECT COUNT(*) FROM github_sync_dispatch_items
              WHERE project_id = ?) AS dispatch_items,
             (SELECT COUNT(*) FROM github_repository_sync_finish_receipts
              WHERE project_id = ?) AS finish_receipts,
             (SELECT COUNT(*) FROM github_sync_dispatch_item_rejection_receipts
              WHERE project_id = ?) AS rejection_receipts,
             (SELECT COUNT(*) FROM github_sync_dispatch_materialization_receipts
              WHERE dispatch_id IN (
                SELECT dispatch_id FROM github_sync_dispatches
                WHERE credential_version = 'system.synthetic.' || ?
              )) AS materialization_receipts,
             (SELECT COUNT(*) FROM github_sync_dispatches
              WHERE credential_version = 'system.synthetic.' || ?) AS dispatches,
             (SELECT COUNT(*) FROM github_credential_sync_lane_release_receipts
              WHERE credential_version = 'system.synthetic.' || ?) AS lane_release_receipts,
             (SELECT COUNT(*) FROM github_credential_sync_lane
              WHERE credential_version = 'system.synthetic.' || ?) AS credential_lanes`
        )
        .get(
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID,
          PROJECT_ID
        )
    ).toEqual({
      repositories: 1,
      repository_sessions: 1,
      grant_contexts: 1,
      memory_contexts: 1,
      sync_cursors: 1,
      sync_runs: 2,
      dispatch_items: 2,
      finish_receipts: 1,
      rejection_receipts: 1,
      materialization_receipts: 1,
      dispatches: 1,
      lane_release_receipts: 1,
      credential_lanes: 1
    });
    fixture.r2.keys.add(`${PREFIX}1/manifest.json`);
    fixture.r2.keys.add(`${PREFIX}1/README.md`);
    fixture.r2.keys.add("projects/other-project/projections/1/manifest.json");
    fixture.vectors.ids.add(VECTOR_ID);

    await expect(
      reapExpiredSyntheticProjects(fixture.environment, {
        now: () => "2026-07-26T00:00:00.000Z",
        delay: async () => undefined
      })
    ).resolves.toEqual({ attempted: 1, cleaned: 1, failed: 0 });

    expect(fixture.workflow.terminated).toEqual([WORKFLOW_ID]);
    expect(fixture.workflow.observedFence).toBe(true);
    expect(fixture.r2.listPrefixes).toEqual([
      PREFIX,
      PREFIX,
      PREFIX
    ]);
    expect([...fixture.r2.keys]).toEqual([
      "projects/other-project/projections/1/manifest.json"
    ]);
    expect(fixture.vectors.ids).toEqual(new Set());
    expect(count(fixture.memory, "projects", "project_id = ?", PROJECT_ID)).toBe(0);
    expect(count(fixture.memory, "principals", "principal_id = ?", PRINCIPAL_ID)).toBe(0);
    expect(count(fixture.search, "memory_fts", "project_id = ?", PROJECT_ID)).toBe(0);
    expect(count(fixture.search, "memory_projection_heads", "project_id = ?", PROJECT_ID)).toBe(0);
    expect(count(fixture.search, "memory_fts_chunk_ledger", "project_id = ?", PROJECT_ID)).toBe(0);
    expect(
      count(
        fixture.search,
        "memory_search_projection_deletions",
        "project_id = ?",
        PROJECT_ID
      )
    ).toBe(0);
    expect(
      count(
        fixture.memory,
        "github_sync_dispatch_materialization_receipts",
        "dispatch_id = ?",
        createHash("sha256").update(`${PROJECT_ID}\ndispatch`).digest("hex")
      )
    ).toBe(0);
    expect(
      count(
        fixture.memory,
        "github_sync_dispatches",
        "credential_version = ?",
        `system.synthetic.${PROJECT_ID}`
      )
    ).toBe(0);
    expect(
      count(
        fixture.memory,
        "github_credential_sync_lane_release_receipts",
        "credential_version = ?",
        `system.synthetic.${PROJECT_ID}`
      )
    ).toBe(0);
    expect(
      count(
        fixture.memory,
        "github_credential_sync_lane",
        "credential_version = ?",
        `system.synthetic.${PROJECT_ID}`
      )
    ).toBe(0);
    expect(
      count(
        fixture.search,
        "memory_search_vector_cleanup_receipts",
        "project_id = ?",
        PROJECT_ID
      )
    ).toBe(0);
    expect(
      count(
        fixture.memory,
        "github_access_baselines",
        "approved_by_principal_id = ?",
        PRINCIPAL_ID
      )
    ).toBe(0);
  });

  it("retains the durable registry and authority when R2 cleanup fails", async () => {
    const fixture = createFixture();
    fixture.r2.keys.add(`${PREFIX}1/manifest.json`);
    fixture.r2.failDelete = true;
    fixture.vectors.ids.add(VECTOR_ID);

    await expect(
      reapExpiredSyntheticProjects(fixture.environment, {
        now: () => "2026-07-26T00:00:00.000Z",
        delay: async () => undefined
      })
    ).resolves.toEqual({ attempted: 1, cleaned: 0, failed: 1 });

    expect(count(fixture.memory, "projects", "project_id = ?", PROJECT_ID)).toBe(1);
    expect(
      fixture.memory
        .prepare(
          `SELECT cleanup_fenced_at, cleanup_claim_id, cleanup_claim_expires_at,
                  last_attempt_at, last_error_code
           FROM synthetic_cleanup_registry WHERE project_id = ?`
        )
        .get(PROJECT_ID)
    ).toEqual({
      cleanup_fenced_at: "2026-07-26T00:00:00.000Z",
      cleanup_claim_id: null,
      cleanup_claim_expires_at: null,
      last_attempt_at: "2026-07-26T00:00:00.000Z",
      last_error_code: "SYNTHETIC_CLEANUP_FAILED"
    });
    await expect(
      isProjectWorkAdmitted(fixture.environment.memoryDb, PROJECT_ID)
    ).resolves.toBe(false);
  });

  it("keeps authority when asynchronous Vectorize deletion cannot be verified", async () => {
    const fixture = createFixture();
    fixture.vectors.ids.add(VECTOR_ID);
    fixture.vectors.retainAfterDelete = true;

    await expect(
      reapExpiredSyntheticProjects(fixture.environment, {
        now: () => "2026-07-26T00:00:00.000Z",
        delay: async () => undefined,
        vectorVerificationAttempts: 2
      })
    ).resolves.toEqual({ attempted: 1, cleaned: 0, failed: 1 });

    expect(fixture.vectors.getByIds).toHaveBeenCalledTimes(2);
    expect(count(fixture.memory, "projects", "project_id = ?", PROJECT_ID)).toBe(1);
    expect(count(fixture.search, "memory_fts", "project_id = ?", PROJECT_ID)).toBe(1);
  });

  it("fails closed before Vectorize deletion for a noncanonical cleanup receipt", async () => {
    const fixture = createFixture();
    const invalidVectorId = "f".repeat(64);
    fixture.search.prepare(
      `INSERT INTO memory_search_vector_cleanup_receipts
       (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
       VALUES (?, ?, 'invalid-memory', 'invalid-revision', 'chunk-0', ?)`
    ).run(GENERATION_ID, PROJECT_ID, invalidVectorId);
    fixture.vectors.ids.add(VECTOR_ID);
    fixture.vectors.ids.add(invalidVectorId);

    await expect(
      reapExpiredSyntheticProjects(fixture.environment, {
        now: () => "2026-07-26T00:00:00.000Z",
        delay: async () => undefined
      })
    ).resolves.toEqual({ attempted: 1, cleaned: 0, failed: 1 });

    expect(fixture.vectors.deleteByIds).not.toHaveBeenCalled();
    expect(count(fixture.memory, "projects", "project_id = ?", PROJECT_ID)).toBe(1);
    expect(count(fixture.search, "memory_projection_heads", "project_id = ?", PROJECT_ID)).toBe(1);
  });

  it("retains authority when an FTS row has no owning chunk ledger", async () => {
    const fixture = createFixture();
    fixture.search.prepare(
      `INSERT INTO memory_fts
       (generation_id, project_id, memory_id, revision_id, chunk_id, status, kind,
        memory_class, scope, scope_id, content)
       VALUES (?, ?, 'orphan-memory', 'orphan-revision', 'chunk-0', 'active', 'fact',
               'semantic', 'project', ?, 'orphan content')`
    ).run(GENERATION_ID, PROJECT_ID, PROJECT_ID);
    fixture.vectors.ids.add(VECTOR_ID);

    await expect(
      reapExpiredSyntheticProjects(fixture.environment, {
        now: () => "2026-07-26T00:00:00.000Z",
        delay: async () => undefined
      })
    ).resolves.toEqual({ attempted: 1, cleaned: 0, failed: 1 });

    expect(count(fixture.memory, "projects", "project_id = ?", PROJECT_ID)).toBe(1);
    expect(count(fixture.search, "memory_fts", "project_id = ?", PROJECT_ID)).toBe(1);
    expect(count(fixture.search, "memory_fts", "memory_id = ?", "orphan-memory")).toBe(1);
  });

  it("uses exact ledger and receipt vectors without crossing project or generation boundaries", async () => {
    const fixture = createFixture();
    const cleanupRevision = "synthetic-cleanup-revision";
    const deletionRevision = "synthetic-deletion-revision";
    const cleanupVectorId = testVectorId(
      RETIRED_GENERATION_ID,
      PROJECT_ID,
      cleanupRevision,
      "chunk-0"
    );
    const deletionVectorId = testVectorId(
      RETIRED_GENERATION_ID,
      PROJECT_ID,
      deletionRevision,
      "chunk-0"
    );
    const otherProjectId = "other-project";
    const otherRevision = "other-revision";
    const otherVectorId = seedSearchProjection(
      fixture.search,
      GENERATION_ID,
      otherProjectId,
      "other-memory",
      otherRevision
    );
    const otherCleanupVectorId = testVectorId(
      RETIRED_GENERATION_ID,
      otherProjectId,
      "other-cleanup-revision",
      "chunk-0"
    );
    const otherDeletionVectorId = testVectorId(
      RETIRED_GENERATION_ID,
      otherProjectId,
      "other-deletion-revision",
      "chunk-0"
    );
    seedRetiredGeneration(fixture.search);
    seedVectorCleanupReceipt(
      fixture.search,
      PROJECT_ID,
      "synthetic-cleanup-memory",
      cleanupRevision,
      cleanupVectorId
    );
    seedProjectionDeletionReceipt(
      fixture.search,
      PROJECT_ID,
      "synthetic-deletion-memory",
      deletionRevision
    );
    seedVectorCleanupReceipt(
      fixture.search,
      otherProjectId,
      "other-cleanup-memory",
      "other-cleanup-revision",
      otherCleanupVectorId
    );
    seedProjectionDeletionReceipt(
      fixture.search,
      otherProjectId,
      "other-deletion-memory",
      "other-deletion-revision"
    );
    seedProjectionWriteLease(
      fixture.search,
      PROJECT_ID,
      "synthetic-lease-memory",
      "synthetic-lease-revision"
    );
    seedProjectionWriteLease(
      fixture.search,
      otherProjectId,
      "other-lease-memory",
      "other-lease-revision"
    );
    fixture.search.prepare("DELETE FROM memory_fts WHERE project_id = ?").run(PROJECT_ID);
    for (const id of [
      VECTOR_ID,
      cleanupVectorId,
      deletionVectorId,
      otherVectorId,
      otherCleanupVectorId,
      otherDeletionVectorId
    ]) {
      fixture.vectors.ids.add(id);
    }

    await expect(
      reapExpiredSyntheticProjects(fixture.environment, {
        now: () => "2026-07-26T00:00:00.000Z",
        delay: async () => undefined
      })
    ).resolves.toEqual({ attempted: 1, cleaned: 1, failed: 0 });

    expect(fixture.vectors.deleteByIds).toHaveBeenCalledWith(
      [VECTOR_ID, cleanupVectorId, deletionVectorId].sort()
    );
    expect(fixture.vectors.ids).toEqual(
      new Set([otherVectorId, otherCleanupVectorId, otherDeletionVectorId])
    );
    for (const table of [
      "memory_fts",
      "memory_projection_heads",
      "memory_fts_chunk_ledger",
      "memory_search_projection_write_leases",
      "memory_search_projection_deletions",
      "memory_search_vector_cleanup_receipts"
    ]) {
      expect(count(fixture.search, table, "project_id = ?", PROJECT_ID)).toBe(0);
      expect(count(fixture.search, table, "project_id = ?", otherProjectId)).toBe(1);
    }
  });

  it("clears only a vector cleanup janitor cursor that references the synthetic project", async () => {
    const targetFixture = createFixture();
    seedVectorCleanupJanitorCursor(targetFixture.search, PROJECT_ID);

    await expect(
      reapExpiredSyntheticProjects(targetFixture.environment, {
        now: () => "2026-07-26T00:00:00.000Z",
        delay: async () => undefined
      })
    ).resolves.toEqual({ attempted: 1, cleaned: 1, failed: 0 });

    expect(readVectorCleanupJanitorCursor(targetFixture.search)).toEqual({
      cursor_generation_id: null,
      cursor_project_id: null,
      cursor_memory_id: null,
      updated_at: null
    });

    const otherFixture = createFixture();
    seedVectorCleanupJanitorCursor(otherFixture.search, "other-project");

    await expect(
      reapExpiredSyntheticProjects(otherFixture.environment, {
        now: () => "2026-07-26T00:00:00.000Z",
        delay: async () => undefined
      })
    ).resolves.toEqual({ attempted: 1, cleaned: 1, failed: 0 });

    expect(readVectorCleanupJanitorCursor(otherFixture.search)).toEqual({
      cursor_generation_id: GENERATION_ID,
      cursor_project_id: "other-project",
      cursor_memory_id: "cursor-memory",
      updated_at: "2026-07-25T00:00:00.000Z"
    });
  });

  it("allows only one overlapping janitor to claim the durable fence", async () => {
    const fixture = createFixture();
    const options = {
      now: () => "2026-07-26T00:00:00.000Z",
      delay: async () => undefined
    };

    const results = await Promise.all([
      reapExpiredSyntheticProjects(fixture.environment, options),
      reapExpiredSyntheticProjects(fixture.environment, options)
    ]);

    expect(results.reduce((sum, result) => sum + result.attempted, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.cleaned, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
  });
});

function createFixture() {
  const memory = new DatabaseSync(":memory:");
  const search = new DatabaseSync(":memory:");
  for (const migration of MEMORY_MIGRATIONS) {
    memory.exec(readFileSync(migration, "utf8"));
  }
  for (const migration of [
    "migrations/search/0001_fts.sql",
    "migrations/search/0002_activate_qwen_generation.sql",
    "migrations/search/0003_projection_heads.sql",
    "migrations/search/0004_repository_partition.sql",
    "migrations/search/0005_memory_fts_chunk_ledger.sql"
  ]) {
    search.exec(readFileSync(migration, "utf8"));
  }
  seedMemory(memory);
  seedSearch(search);
  const r2 = new FakeR2();
  const vectors = new FakeVectors();
  const workflow = new FakeWorkflow(memory);
  return {
    memory,
    search,
    r2,
    vectors,
    workflow,
    environment: {
      memoryDb: new AsyncDatabase(memory),
      searchDb: new AsyncDatabase(search),
      projections: r2,
      vectors,
      workflow
    } as unknown as Parameters<typeof reapExpiredSyntheticProjects>[0]
  };
}

function seedMemory(database: DatabaseSync): void {
  const now = "2026-07-25T00:00:00.000Z";
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
    VALUES ('${PROJECT_ID}', 'system.synthetic.${PROJECT_ID}',
            'system.synthetic.${PROJECT_ID}', 'Synthetic Project', 0, '${now}', '${now}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES ('${PRINCIPAL_ID}', 'system.synthetic', '${PRINCIPAL_ID}',
            'synthetic-digest', '${now}');
    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES ('synthetic-grant', '${PROJECT_ID}', '${PRINCIPAL_ID}', 'maintainer',
            'project', '${PROJECT_ID}', '${now}');
    INSERT INTO audit_events
      (audit_id, project_id, sequence, event_type, actor_principal_id,
       request_digest, event_hash, recorded_at)
    VALUES ('synthetic-audit', '${PROJECT_ID}', 1, 'synthetic_test', '${PRINCIPAL_ID}',
            'request', 'event', '${now}');
    INSERT INTO memories
      (memory_id, project_id, memory_version, kind, memory_class, scope, scope_id,
       status, created_at, updated_at)
    VALUES ('synthetic-memory', '${PROJECT_ID}', 0, 'fact', 'semantic', 'project',
            '${PROJECT_ID}', 'active', '${now}', '${now}');
    INSERT INTO memory_versions
      (revision_id, project_id, memory_id, memory_version, content, content_sha256,
       audit_id, recorded_at)
    VALUES ('${REVISION_ID}', '${PROJECT_ID}', 'synthetic-memory', 1,
            'synthetic content', 'content-sha', 'synthetic-audit', '${now}');
    UPDATE memories SET current_revision_id = '${REVISION_ID}', memory_version = 1
      WHERE project_id = '${PROJECT_ID}' AND memory_id = 'synthetic-memory';
    UPDATE projects SET project_version = 1, audit_head_hash = 'event'
      WHERE project_id = '${PROJECT_ID}';
    INSERT INTO workflow_runs
      (workflow_id, root_workflow_id, project_id, workflow_type, status,
       attempt, created_at, updated_at)
    VALUES ('${WORKFLOW_ID}', '${WORKFLOW_ID}', '${PROJECT_ID}', 'memory.changed',
            'running', 1, '${now}', '${now}');
    INSERT INTO synthetic_cleanup_registry
      (project_id, principal_id, expires_at, created_at)
    VALUES ('${PROJECT_ID}', '${PRINCIPAL_ID}',
            '2026-07-25T23:00:00.000Z', '${now}');
  `);
  seedRepositoryScopedRows(database, PROJECT_ID, PRINCIPAL_ID, 101);
  seedGitHubCredential(database, PRINCIPAL_ID, PROJECT_ID);
  seedGitHubWorkflowRows(database, PROJECT_ID);
}

function seedGitHubCredential(
  database: DatabaseSync,
  principalId: string,
  projectId: string
): void {
  const credentialVersion = `system.synthetic.${projectId}`;
  const now = "2026-07-25T00:00:00.000Z";
  database.prepare(
    `INSERT INTO github_access_baselines
     (credential_version, user_id, scopes_json, repositories_json,
      approved_by_principal_id, approved_at, created_at)
     VALUES (?, 1, '[]', '[]', ?, ?, ?)`
  ).run(credentialVersion, principalId, now, now);
  database.prepare(
    `INSERT INTO github_rate_observations
     (observation_id, credential_version, observed_at)
     VALUES (?, ?, ?)`
  ).run(`${credentialVersion}.rate`, credentialVersion, now);
  database.prepare(
    `INSERT INTO github_credential_states
     (credential_version, expires_at, last_observed_at, credential_status,
      warning_threshold_days, updated_at)
     VALUES (?, '2026-08-08T00:00:00.000Z', ?, 'expiring', 14, ?)`
  ).run(credentialVersion, now, now);
  database.prepare(
    `INSERT INTO github_credential_expiry_warnings
     (event_id, credential_version, threshold_days, expires_at, observed_at,
      event_digest)
     VALUES (?, ?, 14, '2026-08-08T00:00:00.000Z', ?, ?)`
  ).run(`${credentialVersion}.warning.14`, credentialVersion, now, "synthetic-digest");
}

function seedGitHubWorkflowRows(database: DatabaseSync, projectId: string): void {
  const credentialVersion = `system.synthetic.${projectId}`;
  const repositoryId = `${projectId}-repository`;
  const ref = "refs/heads/feature";
  const now = "2026-07-25T00:00:00.000Z";
  const leaseUntil = "2026-07-25T00:20:00.000Z";
  const runId = `${projectId}-workflow-sync-run`;
  const dispatchId = createHash("sha256").update(`${projectId}\ndispatch`).digest("hex");
  const itemId = createHash("sha256").update(`${projectId}\nitem`).digest("hex");
  const rejectedItemId = createHash("sha256")
    .update(`${projectId}\nrejected-item`)
    .digest("hex");
  const receiptId = createHash("sha256").update(`${projectId}\nfinish`).digest("hex");
  const rejectionReceiptId = createHash("sha256")
    .update(`${projectId}\nrejection`)
    .digest("hex");
  const materializationReceiptId = createHash("sha256")
    .update(`${projectId}\nmaterialization`)
    .digest("hex");
  const laneReceiptId = createHash("sha256")
    .update(`${projectId}\nlane-release`)
    .digest("hex");
  const laneClaimId = createHash("sha256")
    .update(`${projectId}\nlane-claim`)
    .digest("hex");
  const dispatchWorkflowId = `ghd-${createHash("sha256")
    .update(`${projectId}\ndispatch-workflow`)
    .digest("hex")}`;
  const refWorkflowId = `ghr-${createHash("sha256")
    .update(`${projectId}\nref-workflow`)
    .digest("hex")}`;
  const rejectedWorkflowId = `ghr-${createHash("sha256")
    .update(`${projectId}\nrejected-workflow`)
    .digest("hex")}`;

  database.prepare(
    `INSERT INTO github_repository_sync_runs
     (run_id, project_id, repository_id, scheduled_for, full_reconciliation,
      status, started_at, lease_expires_at, completed_at, claimed_ref,
      claimed_head_manifest_id, claimed_head_version,
      repository_configuration_version, cursor_version, claim_contract_version)
     VALUES (?, ?, ?, ?, 0, 'complete', ?, ?, ?, ?, NULL, 0, 1, 1, 1)`
  ).run(runId, projectId, repositoryId, now, now, leaseUntil, now, ref);
  database.prepare(
    `INSERT INTO github_sync_dispatches
     (dispatch_id, credential_version, workflow_instance_id, scheduled_for,
      utc_date, status, created_at, completed_at)
     VALUES (?, ?, ?, ?, '2026-07-25', 'complete', ?, ?)`
  ).run(dispatchId, credentialVersion, dispatchWorkflowId, now, now, now);
  database.prepare(
    `INSERT INTO github_sync_dispatch_items
     (item_id, dispatch_id, project_id, repository_id, ref, scheduled_for,
      full_reconciliation, repository_configuration_version, cursor_version,
      selected_head_manifest_id, selected_head_version, repository_updated_at,
      cursor_status, cursor_updated_at, workflow_instance_id, status, run_id,
      created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, NULL, 0, ?, 'complete', ?, ?,
             'complete', ?, ?, ?)`
  ).run(
    itemId,
    dispatchId,
    projectId,
    repositoryId,
    ref,
    now,
    now,
    now,
    refWorkflowId,
    runId,
    now,
    now
  );
  database.prepare(
    `INSERT INTO github_sync_dispatch_items
     (item_id, dispatch_id, project_id, repository_id, ref, scheduled_for,
      full_reconciliation, repository_configuration_version, cursor_version,
      selected_head_manifest_id, selected_head_version, repository_updated_at,
      cursor_status, cursor_updated_at, workflow_instance_id, status, run_id,
      created_at, completed_at, last_error_code)
     VALUES (?, ?, ?, ?, 'refs/heads/rejected', ?, 0, 1, 1, NULL, 0, ?,
             'complete', ?, ?, 'failed', NULL, ?, ?,
             'GITHUB_RECONCILIATION_REQUIRED')`
  ).run(
    rejectedItemId,
    dispatchId,
    projectId,
    repositoryId,
    now,
    now,
    now,
    rejectedWorkflowId,
    now,
    now
  );
  database.prepare(
    `INSERT INTO github_repository_sync_finish_receipts
     (receipt_id, run_id, dispatch_item_id, project_id, repository_id, ref,
      status, last_error_code, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'complete', NULL, ?)`
  ).run(receiptId, runId, itemId, projectId, repositoryId, ref, now);
  database.prepare(
    `INSERT INTO github_sync_dispatch_item_rejection_receipts
     (receipt_id, dispatch_item_id, dispatch_id, credential_version,
      project_id, repository_id, ref, last_error_code, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'refs/heads/rejected',
             'GITHUB_RECONCILIATION_REQUIRED', ?)`
  ).run(
    rejectionReceiptId,
    rejectedItemId,
    dispatchId,
    credentialVersion,
    projectId,
    repositoryId,
    now
  );
  database.prepare(
    `INSERT INTO github_sync_dispatch_materialization_receipts
     (receipt_id, dispatch_id, item_count, completed_at)
     VALUES (?, ?, 2, ?)`
  ).run(materializationReceiptId, dispatchId, now);
  database.prepare(
    `INSERT INTO github_credential_sync_lane
     (credential_version, holder_kind, holder_id, lease_claim_id, lease_epoch,
      lease_until, available_after, updated_at)
     VALUES (?, 'ref', ?, ?, 1, ?, ?, ?)`
  ).run(credentialVersion, itemId, laneClaimId, leaseUntil, now, now);
  database.prepare(
    `INSERT INTO github_credential_sync_lane_release_receipts
     (receipt_id, credential_version, holder_kind, holder_id, lease_claim_id,
      lease_epoch, lease_until, released_at, available_after)
     VALUES (?, ?, 'ref', ?, ?, 1, ?, ?, '2026-07-25T00:00:00.080Z')`
  ).run(laneReceiptId, credentialVersion, itemId, laneClaimId, leaseUntil, now);
  database.prepare(
    `UPDATE github_credential_sync_lane
     SET holder_kind = NULL, holder_id = NULL, lease_claim_id = NULL,
         lease_until = NULL, available_after = '2026-07-25T00:00:00.080Z',
         updated_at = ?
     WHERE credential_version = ? AND holder_kind = 'ref' AND holder_id = ?
       AND lease_claim_id = ? AND lease_epoch = 1 AND lease_until = ?`
  ).run(now, credentialVersion, itemId, laneClaimId, leaseUntil);
}

function seedRepositoryScopedRows(
  database: DatabaseSync,
  projectId: string,
  principalId: string,
  externalRepositoryId: number
): void {
  const now = "2026-07-25T00:00:00.000Z";
  const repositoryId = `${projectId}-repository`;
  const sessionId = `${projectId}-session`;
  const repositoryRef = "refs/heads/feature";
  const worktreeId = `${projectId}-worktree`;
  database.prepare(
    `INSERT INTO repositories
     (repository_id, project_id, provider, external_id, expected_owner_external_id,
      owner, name, default_branch, tracked_refs_json, sync_enabled, created_at, updated_at)
     VALUES (?, ?, 'github', ?, 1, 'synthetic-owner', ?, 'main', ?, 1, ?, ?)`
  ).run(
    repositoryId,
    projectId,
    externalRepositoryId,
    repositoryId,
    JSON.stringify([repositoryRef]),
    now,
    now
  );
  database.prepare(
    `INSERT INTO sessions
     (session_id, project_id, principal_id, session_version, status, agent_meta_json,
      worktree_meta_json, opened_at, repository_id, repository_ref, worktree_id)
     VALUES (?, ?, ?, 1, 'open', '{}', ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    projectId,
    principalId,
    JSON.stringify({
      repository_id: repositoryId,
      repository_ref: repositoryRef,
      worktree_id: worktreeId
    }),
    now,
    repositoryId,
    repositoryRef,
    worktreeId
  );
  database.prepare(
    `INSERT INTO project_grants
     (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
     VALUES (?, ?, ?, 'writer', 'repository', ?, ?)`
  ).run(`${projectId}-repository-grant`, projectId, principalId, repositoryId, now);
  database.prepare(
    `INSERT INTO sync_cursors
     (project_id, repository_id, ref, observed_sha, status, updated_at)
     VALUES (?, ?, ?, 'synthetic-sha', 'complete', ?)`
  ).run(projectId, repositoryId, repositoryRef, now);
  database.prepare(
    `INSERT INTO github_repository_sync_runs
     (run_id, project_id, repository_id, scheduled_for, full_reconciliation,
      status, started_at, lease_expires_at, completed_at)
     VALUES (?, ?, ?, ?, 0, 'complete', ?, '2026-07-26T00:00:00.000Z', ?)`
  ).run(`${projectId}-sync-run`, projectId, repositoryId, now, now, now);
  const manifestId = createHash("sha256").update(projectId).digest("hex");
  const pathDigest = "b".repeat(64);
  const entriesChecksum = "c".repeat(64);
  const blobSha = "d".repeat(40);
  database.prepare(
    `INSERT INTO github_tree_manifests
     (manifest_id, project_id, repository_id, ref, observed_sha, tree_sha,
      repository_authority, collection_key, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'tracked_ref', ?, 'staging', ?)`
  ).run(
    manifestId,
    projectId,
    repositoryId,
    repositoryRef,
    "e".repeat(40),
    "f".repeat(40),
    now,
    now
  );
  database.prepare(
    `INSERT INTO github_tree_manifest_entries
     (project_id, manifest_id, path_digest, safe_path, blob_sha, byte_size, disposition)
     VALUES (?, ?, ?, 'README.md', ?, 12, 'text')`
  ).run(projectId, manifestId, pathDigest, blobSha);
  database.prepare(
    `UPDATE github_tree_manifests
     SET status = 'complete', entry_count = 1, entries_checksum = ?, completed_at = ?
     WHERE project_id = ? AND manifest_id = ?`
  ).run(entriesChecksum, now, projectId, manifestId);
  database.prepare(
    `INSERT INTO github_tree_manifest_deltas
     (delta_id, project_id, repository_id, ref, old_manifest_id, new_manifest_id,
      path_digest, safe_path, change_kind, old_blob_sha, new_blob_sha,
      old_disposition, new_disposition, affected_memory_ids_json,
      idempotency_key, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'README.md', 'added', NULL, ?, NULL,
             'text', '[]', ?, ?)`
  ).run(
    `${projectId}-tree-delta`,
    projectId,
    repositoryId,
    repositoryRef,
    manifestId,
    pathDigest,
    blobSha,
    `${projectId}-tree-idempotency`,
    now
  );
  database.prepare(
    `INSERT INTO github_tree_ref_heads
     (project_id, repository_id, ref, manifest_id, head_version, activated_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).run(projectId, repositoryId, repositoryRef, manifestId, now, now);
  const failedManifestId = createHash("sha256")
    .update(`${projectId}\nfailed`)
    .digest("hex");
  const failedPathDigest = createHash("sha256")
    .update(`${projectId}\nfailed-path`)
    .digest("hex");
  const failedEntriesChecksum = createHash("sha256")
    .update(`${projectId}\nfailed-entries`)
    .digest("hex");
  database.prepare(
    `INSERT INTO github_tree_manifests
     (manifest_id, project_id, repository_id, ref, observed_sha, tree_sha,
      repository_authority, collection_key, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'tracked_ref', ?, 'staging', ?)`
  ).run(
    failedManifestId,
    projectId,
    repositoryId,
    repositoryRef,
    "1".repeat(40),
    "2".repeat(40),
    `${now}.failed`,
    now
  );
  database.prepare(
    `INSERT INTO github_tree_manifest_entries
     (project_id, manifest_id, path_digest, safe_path, blob_sha, byte_size, disposition)
     VALUES (?, ?, ?, 'failed.md', ?, 12, 'partial')`
  ).run(projectId, failedManifestId, failedPathDigest, blobSha);
  database.prepare(
    `UPDATE github_tree_manifests
     SET status = 'failed', entry_count = 1, entries_checksum = ?,
         failed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         failure_code = 'GITHUB_PARTIAL_SYNC'
     WHERE project_id = ? AND manifest_id = ?`
  ).run(failedEntriesChecksum, projectId, failedManifestId);
  const lifecycleEventId = createHash("sha256")
    .update(`${projectId}\nfailed-lifecycle`)
    .digest("hex");
  const lifecycleRequestDigest = createHash("sha256")
    .update(`${projectId}\nfailed-request`)
    .digest("hex");
  database.prepare(
    `INSERT INTO github_tree_manifest_lifecycle_events
     (event_id, project_id, manifest_id, retention_version, event_type,
      failure_code, entry_count, entries_checksum, request_digest, recorded_at)
     SELECT ?, project_id, manifest_id, retention_version, 'failed',
            failure_code, entry_count, entries_checksum, ?, failed_at
     FROM github_tree_manifests
     WHERE project_id = ? AND manifest_id = ?`
  ).run(
    lifecycleEventId,
    lifecycleRequestDigest,
    projectId,
    failedManifestId
  );
  database.prepare(
    `INSERT INTO memories
     (memory_id, project_id, memory_version, kind, memory_class, scope, scope_id,
      status, created_at, updated_at)
     VALUES (?, ?, 0, 'fact', 'semantic', 'repository', ?, 'active', ?, ?)`
  ).run(`${projectId}-repository-memory`, projectId, repositoryId, now, now);
  database.prepare(
    `INSERT INTO evidence
     (evidence_id, project_id, source_type, locator, repository_id, excerpt_hash,
      sensitivity_status, recorded_at, repository_ref, repository_authority)
     VALUES (?, ?, 'repository_file', ?, ?, 'synthetic-excerpt-sha', 'clear', ?, ?,
             'agent_supplied')`
  ).run(
    `${projectId}-repository-evidence`,
    projectId,
    `repository:${repositoryId}:README.md`,
    repositoryId,
    now,
    repositoryRef
  );
}

function repositoryScopedCounts(
  database: DatabaseSync,
  projectId: string
): Record<string, number> {
  return database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM repositories WHERE project_id = ?) AS repositories,
       (SELECT COUNT(*) FROM sessions
        WHERE project_id = ? AND repository_id IS NOT NULL) AS repository_sessions,
       (SELECT COUNT(*) FROM project_grant_repository_contexts
        WHERE project_id = ?) AS grant_contexts,
       (SELECT COUNT(*) FROM memory_repository_contexts
        WHERE project_id = ?) AS memory_contexts,
       (SELECT COUNT(*) FROM sync_cursors WHERE project_id = ?) AS sync_cursors,
       (SELECT COUNT(*) FROM github_repository_sync_runs
        WHERE project_id = ?) AS sync_runs,
       (SELECT COUNT(*) FROM github_tree_manifests
        WHERE project_id = ?) AS tree_manifests,
       (SELECT COUNT(*) FROM github_tree_manifest_lifecycle_events
        WHERE project_id = ?) AS tree_lifecycle_events,
       (SELECT COUNT(*) FROM github_tree_manifest_entries
        WHERE project_id = ?) AS tree_entries,
       (SELECT COUNT(*) FROM github_tree_manifest_deltas
        WHERE project_id = ?) AS tree_deltas,
       (SELECT COUNT(*) FROM github_tree_ref_heads
        WHERE project_id = ?) AS tree_heads`
  ).get(
    projectId,
    projectId,
    projectId,
    projectId,
    projectId,
    projectId,
    projectId,
    projectId,
    projectId,
    projectId,
    projectId
  ) as Record<string, number>;
}

function seedSearch(database: DatabaseSync): void {
  seedSearchProjection(
    database,
    GENERATION_ID,
    PROJECT_ID,
    "synthetic-memory",
    REVISION_ID
  );
}

function seedVectorCleanupJanitorCursor(
  database: DatabaseSync,
  projectId: string
): void {
  database.prepare(
    `UPDATE memory_search_vector_cleanup_janitor_state
     SET cursor_generation_id = ?, cursor_project_id = ?, cursor_memory_id = ?,
         updated_at = '2026-07-25T00:00:00.000Z'
     WHERE state_id = 1`
  ).run(GENERATION_ID, projectId, "cursor-memory");
}

function readVectorCleanupJanitorCursor(database: DatabaseSync) {
  return database.prepare(
    `SELECT cursor_generation_id, cursor_project_id, cursor_memory_id, updated_at
     FROM memory_search_vector_cleanup_janitor_state
     WHERE state_id = 1`
  ).get();
}

function seedSearchProjection(
  database: DatabaseSync,
  generationId: string,
  projectId: string,
  memoryId: string,
  revisionId: string
): string {
  const vectorId = testVectorId(generationId, projectId, revisionId, "chunk-0");
  seedProjectionWriteLease(
    database,
    projectId,
    memoryId,
    revisionId,
    generationId
  );
  database.prepare(
    `INSERT INTO memory_projection_heads
     (generation_id, project_id, memory_id, project_version, revision_id,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, 1, ?, '*', 1)`
  ).run(generationId, projectId, memoryId, revisionId);
  database.prepare(
    `INSERT INTO memory_fts_chunk_ledger
     (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
     VALUES (?, ?, ?, ?, 'chunk-0', ?)`
  ).run(generationId, projectId, memoryId, revisionId, vectorId);
  database.prepare(
    `INSERT INTO memory_fts
     (rowid, generation_id, project_id, memory_id, revision_id, chunk_id, status, kind,
      memory_class, scope, scope_id, content)
     SELECT fts_rowid, generation_id, project_id, memory_id, revision_id, chunk_id,
            'active', 'fact', 'semantic', 'project', ?, 'synthetic content'
     FROM memory_fts_chunk_ledger
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  ).run(projectId, generationId, projectId, memoryId);
  database.prepare(
    `DELETE FROM memory_search_projection_write_leases
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?`
  ).run(generationId, projectId, memoryId);
  return vectorId;
}

function seedRetiredGeneration(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO search_generations
     (generation_id, embedding_model, embedding_dimensions, distance_metric,
      instruction_version, chunk_schema_version, reranker_model, status,
      created_at, activated_at)
     VALUES (?, 'synthetic-embedding', 1024, 'cosine', 'synthetic-instruction',
             'synthetic-chunks', 'synthetic-reranker', 'retired',
             '2026-07-25T00:00:00.000Z', NULL)`
  ).run(RETIRED_GENERATION_ID);
}

function seedVectorCleanupReceipt(
  database: DatabaseSync,
  projectId: string,
  memoryId: string,
  revisionId: string,
  vectorId: string
): void {
  database.prepare(
    `INSERT INTO memory_search_vector_cleanup_receipts
     (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
     VALUES (?, ?, ?, ?, 'chunk-0', ?)`
  ).run(RETIRED_GENERATION_ID, projectId, memoryId, revisionId, vectorId);
}

function seedProjectionDeletionReceipt(
  database: DatabaseSync,
  projectId: string,
  memoryId: string,
  revisionId: string
): void {
  database.prepare(
    `INSERT INTO memory_search_projection_deletions
     (generation_id, project_id, memory_id, revision_id, project_version, chunk_count)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(RETIRED_GENERATION_ID, projectId, memoryId, revisionId);
}

function seedProjectionWriteLease(
  database: DatabaseSync,
  projectId: string,
  memoryId: string,
  revisionId: string,
  generationId = RETIRED_GENERATION_ID
): void {
  database.prepare(
    `INSERT INTO memory_search_projection_write_leases
     (generation_id, project_id, memory_id, revision_id, project_version,
      repository_partition, chunk_count)
     VALUES (?, ?, ?, ?, 1, '*', 1)`
  ).run(generationId, projectId, memoryId, revisionId);
}

function testVectorId(
  generationId: string,
  projectId: string,
  revisionId: string,
  chunkId: string
): string {
  return createHash("sha256")
    .update(`${generationId}\n${projectId}\n${revisionId}\n${chunkId}`)
    .digest("hex");
}

class AsyncStatement {
  readonly bindings: SQLInputValue[];

  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    bindings: SQLInputValue[] = []
  ) {
    this.bindings = bindings;
  }

  bind(...bindings: SQLInputValue[]): AsyncStatement {
    return new AsyncStatement(this.database, this.sql, bindings);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement().all(...this.bindings) as T[] };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.bindings) as T | undefined) ?? null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.statement().run(...this.bindings);
    return { meta: { changes: Number(result.changes) } };
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

class AsyncDatabase {
  constructor(readonly database: DatabaseSync) {}

  withSession(_constraint: "first-primary"): AsyncDatabase {
    return this;
  }

  prepare(sql: string): AsyncStatement {
    return new AsyncStatement(this.database, sql);
  }

  async batch(statements: AsyncStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN");
    try {
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class FakeR2 {
  readonly keys = new Set<string>();
  readonly listPrefixes: string[] = [];
  failDelete = false;

  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    this.listPrefixes.push(options.prefix);
    const matching = [...this.keys].filter((key) => key.startsWith(options.prefix)).sort();
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    const page = matching.slice(offset, offset + 1);
    const next = offset + page.length;
    return next < matching.length
      ? {
          objects: page.map((key) => ({ key })),
          delimitedPrefixes: [],
          truncated: true as const,
          cursor: String(next)
        }
      : {
          objects: page.map((key) => ({ key })),
          delimitedPrefixes: [],
          truncated: false as const
        };
  }

  async delete(keys: string | string[]): Promise<void> {
    if (this.failDelete) {
      throw new Error("synthetic R2 failure");
    }
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.keys.delete(key);
    }
  }
}

class FakeVectors {
  readonly ids = new Set<string>();
  retainAfterDelete = false;
  readonly getByIds = vi.fn(async (ids: string[]) =>
    ids.filter((id) => this.ids.has(id)).map((id) => ({ id }))
  );
  readonly deleteByIds = vi.fn(async (ids: string[]): Promise<unknown> => {
    if (!this.retainAfterDelete) {
      for (const id of ids) {
        this.ids.delete(id);
      }
    }
    return { mutationId: "synthetic-mutation" };
  });
}

class FakeWorkflow {
  readonly terminated: string[] = [];
  observedFence = false;

  constructor(readonly memory: DatabaseSync) {}

  async get(id: string) {
    let status = "running";
    return {
      status: async () => ({ status }),
      terminate: async () => {
        const row = this.memory.prepare(
          `SELECT cleanup_fenced_at FROM synthetic_cleanup_registry
           WHERE project_id = ?`
        ).get(PROJECT_ID) as { cleanup_fenced_at: string | null } | undefined;
        this.observedFence = row?.cleanup_fenced_at !== null && row !== undefined;
        this.terminated.push(id);
        status = "terminated";
      }
    };
  }
}

function count(
  database: DatabaseSync,
  table: string,
  where: string,
  value: string
): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get(value) as { count: number };
  return row.count;
}
