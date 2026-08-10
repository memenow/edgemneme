import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_STATUSES
} from "../src/contracts/taxonomy";
import { D1CurrentHeadValidator } from "../src/search/cloudflare";
import { SearchPipeline } from "../src/search/pipeline";
import { planHardFilters } from "../src/search/planning";
import { asIndexGeneration } from "../src/search/ranking";
import type { FusedRecallHit } from "../src/search/types";

const NOW = "2026-07-27T00:00:00.000Z";
const GENERATION = asIndexGeneration("generation-blue");

describe("D1 current-head repository authorization", () => {
  it("lets a repository principal read project-shared and same-repository memory only", async () => {
    const fixture = createFixture();

    const results = await validate(fixture.database, "principal-a", ["repository-a"]);

    expect(results.map((result) => result.memoryId)).toEqual([
      "memory-a",
      "memory-shared"
    ]);
    expect(results.every((result) => result.evidenceIds.length === 1)).toBe(true);
  });

  it("lets a project principal read every repository while a session ceiling narrows it", async () => {
    const fixture = createFixture();

    const projectResults = await validate(fixture.database, "principal-project", undefined);
    const repositoryResults = await validate(
      fixture.database,
      "principal-project",
      ["repository-b"]
    );
    const projectOnlyResults = await validate(fixture.database, "principal-project", []);

    expect(projectResults.map((result) => result.memoryId)).toEqual([
      "memory-a",
      "memory-b",
      "memory-shared"
    ]);
    expect(repositoryResults.map((result) => result.memoryId)).toEqual([
      "memory-b",
      "memory-shared"
    ]);
    expect(projectOnlyResults.map((result) => result.memoryId)).toEqual([
      "memory-shared"
    ]);
  });

  it("rejects a recalled candidate from another project before querying authority", async () => {
    const fixture = createFixture();
    const filters = planHardFilters({
      projectId: "project-1",
      indexGeneration: GENERATION,
      validAt: NOW
    });

    await expect(
      new D1CurrentHeadValidator(
        new SqliteD1(fixture.database) as unknown as D1Database
      ).validate({
        projectId: "project-1",
        principalId: "principal-project",
        snapshotVersion: 3,
        filters,
        candidates: [hit("memory-x")]
      })
    ).rejects.toThrow("project or generation boundary");
  });

  it("executes compact JSON filters for maximum legal filter lists", async () => {
    const fixture = createFixture();
    const repositoryIds = [
      "repository-a",
      ...Array.from(
        { length: 49 },
        (_, index) => `repository-extra-${String(index).padStart(2, "0")}`
      )
    ];
    const results = await new D1CurrentHeadValidator(
      new SqliteD1(fixture.database) as unknown as D1Database
    ).validate({
      projectId: "project-1",
      principalId: "principal-a",
      snapshotVersion: 3,
      filters: planHardFilters({
        projectId: "project-1",
        authorizedRepositoryIds: repositoryIds,
        statuses: MEMORY_STATUSES,
        kinds: MEMORY_KINDS,
        memoryClasses: MEMORY_CLASSES,
        scope: { type: "repository", ids: repositoryIds },
        indexGeneration: GENERATION,
        validAt: NOW
      }),
      candidates: [hit("memory-a")]
    });

    expect(results.map((result) => result.memoryId)).toEqual(["memory-a"]);
  });

  it("abstains for quarantined or tombstone-only evidence and accepts a clear citation", async () => {
    const fixture = createFixture();
    fixture.database
      .prepare(
        `UPDATE evidence SET sensitivity_status = ?
         WHERE project_id = 'project-1' AND evidence_id = ?`
      )
      .run("quarantined", "evidence-memory-shared");
    fixture.database
      .prepare(
        `UPDATE evidence SET sensitivity_status = ?
         WHERE project_id = 'project-1' AND evidence_id = ?`
      )
      .run("tombstone", "evidence-memory-a");

    await expect(search(fixture.database)).resolves.toMatchObject({
      abstained: true,
      abstentionReason: "NO_EVIDENCE_BACKED_MATCH",
      memories: []
    });

    const clearEvidenceId = "evidence-clear-memory-a";
    fixture.database
      .prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, excerpt_hash,
          sensitivity_status, recorded_at)
         VALUES (?, 'project-1', 'test', ?, ?, 'clear', ?)`
      )
      .run(
        clearEvidenceId,
        "test://memory-a/clear",
        "clear-memory-a".padEnd(64, "0").slice(0, 64),
        NOW
      );
    fixture.database
      .prepare(
        `INSERT INTO version_evidence (project_id, revision_id, evidence_id)
         VALUES ('project-1', 'revision-memory-a', ?)`
      )
      .run(clearEvidenceId);

    const accepted = await search(fixture.database);
    expect(accepted.abstained).toBe(false);
    expect(accepted.memories).toEqual([
      expect.objectContaining({
        memoryId: "memory-a",
        evidenceIds: [clearEvidenceId]
      })
    ]);
    expect(accepted.contextPack).not.toContain("evidence-memory-a");
    expect(accepted.contextPack).not.toContain("evidence-memory-shared");
  });
});

async function validate(
  database: DatabaseSync,
  principalId: string,
  authorizedRepositoryIds: readonly string[] | undefined
) {
  const candidates = ["memory-shared", "memory-a", "memory-b"].map(hit);
  return new D1CurrentHeadValidator(
    new SqliteD1(database) as unknown as D1Database
  ).validate({
    projectId: "project-1",
    principalId,
    snapshotVersion: 3,
    filters: planHardFilters({
      projectId: "project-1",
      ...(authorizedRepositoryIds === undefined ? {} : { authorizedRepositoryIds }),
      indexGeneration: GENERATION,
      validAt: NOW
    }),
    candidates
  });
}

async function search(database: DatabaseSync) {
  const candidates = ["memory-shared", "memory-a"].map(hit);
  return new SearchPipeline({
    semantic: {
      async recall() {
        return candidates;
      }
    },
    headValidator: new D1CurrentHeadValidator(
      new SqliteD1(database) as unknown as D1Database
    ),
    reranker: {
      async rerank(input) {
        return input.candidates.map((candidate) => ({ candidate, relevance: 1 }));
      }
    }
  }).search({
    projectId: "project-1",
    principalId: "principal-a",
    snapshotVersion: 3,
    query: "authoritative project memory",
    authorizedRepositoryIds: ["repository-a"],
    indexGeneration: GENERATION,
    now: NOW
  });
}

function hit(memoryId: string): FusedRecallHit {
  return {
    projectId: memoryId === "memory-x" ? "project-2" : "project-1",
    memoryId,
    revisionId: `revision-${memoryId}`,
    chunkId: "chunk-0",
    indexGeneration: GENERATION,
    retrievalScore: 0.5,
    channels: ["semantic"]
  };
}

function createFixture(): { database: DatabaseSync } {
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
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, project_version, created_at, updated_at)
    VALUES
      ('project-1', 'project:one', 'locator-one', 'Project One', 0, '${NOW}', '${NOW}'),
      ('project-2', 'project:two', 'locator-two', 'Project Two', 0, '${NOW}', '${NOW}');

    INSERT INTO repositories
      (repository_id, project_id, provider, external_id, owner, name, default_branch,
       created_at, updated_at)
    VALUES
      ('repository-a', 'project-1', 'github', 101, 'memenow', 'repo-a', 'main', '${NOW}', '${NOW}'),
      ('repository-b', 'project-1', 'github', 102, 'memenow', 'repo-b', 'main', '${NOW}', '${NOW}'),
      ('repository-x', 'project-2', 'github', 201, 'other', 'repo-x', 'main', '${NOW}', '${NOW}');

    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('principal-project', 'test', 'principal-project', 'digest-project', '${NOW}'),
      ('principal-a', 'test', 'principal-a', 'digest-a', '${NOW}'),
      ('maintainer-1', 'test', 'maintainer-1', 'digest-maintainer-1', '${NOW}'),
      ('maintainer-2', 'test', 'maintainer-2', 'digest-maintainer-2', '${NOW}');

    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES
      ('grant-project', 'project-1', 'principal-project', 'reader', 'project', 'project-1', '${NOW}'),
      ('grant-a', 'project-1', 'principal-a', 'reader', 'repository', 'repository-a', '${NOW}'),
      ('grant-maintainer-1', 'project-1', 'maintainer-1', 'maintainer', 'project', 'project-1', '${NOW}'),
      ('grant-maintainer-2', 'project-2', 'maintainer-2', 'maintainer', 'project', 'project-2', '${NOW}');

    INSERT INTO project_grant_repository_contexts
      (project_id, grant_id, repository_id, created_at)
    VALUES ('project-1', 'grant-a', 'repository-a', '${NOW}');
  `);
  seedMemory(database, {
    projectId: "project-1",
    memoryId: "memory-shared",
    scope: "project",
    scopeId: "project-1",
    repositoryId: null,
    actorId: "maintainer-1",
    auditSequence: 1
  });
  seedMemory(database, {
    projectId: "project-1",
    memoryId: "memory-a",
    scope: "repository",
    scopeId: "repository-a",
    repositoryId: "repository-a",
    actorId: "maintainer-1",
    auditSequence: 2
  });
  seedMemory(database, {
    projectId: "project-1",
    memoryId: "memory-b",
    scope: "repository",
    scopeId: "repository-b",
    repositoryId: "repository-b",
    actorId: "maintainer-1",
    auditSequence: 3
  });
  seedMemory(database, {
    projectId: "project-2",
    memoryId: "memory-x",
    scope: "repository",
    scopeId: "repository-x",
    repositoryId: "repository-x",
    actorId: "maintainer-2",
    auditSequence: 1
  });
  return { database };
}

function seedMemory(
  database: DatabaseSync,
  input: {
    projectId: string;
    memoryId: string;
    scope: "project" | "repository";
    scopeId: string;
    repositoryId: string | null;
    actorId: string;
    auditSequence: number;
  }
): void {
  const auditId = `audit-${input.memoryId}`;
  const revisionId = `revision-${input.memoryId}`;
  const evidenceId = `evidence-${input.memoryId}`;
  const hash = input.memoryId.padEnd(64, "0").slice(0, 64);
  const projectHead = database.prepare(
    "SELECT project_version, audit_head_hash FROM projects WHERE project_id = ?"
  ).get(input.projectId) as { project_version: number; audit_head_hash: string | null };
  database.prepare(
    `INSERT INTO audit_events
     (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
      previous_event_hash, event_hash, recorded_at)
     VALUES (?, ?, ?, 'memory.created', ?, ?, ?, ?, ?)`
  ).run(
    auditId,
    input.projectId,
    projectHead.project_version + 1,
    input.actorId,
    hash,
    projectHead.audit_head_hash,
    hash,
    NOW
  );
  database.prepare(
    `INSERT INTO memories
     (memory_id, project_id, memory_version, kind, memory_class, scope, scope_id,
      status, created_at, updated_at)
     VALUES (?, ?, 0, 'fact', 'semantic', ?, ?, 'active', ?, ?)`
  ).run(input.memoryId, input.projectId, input.scope, input.scopeId, NOW, NOW);
  if (input.repositoryId !== null) {
    database.prepare(
      `INSERT INTO memory_repository_contexts
       (project_id, memory_id, repository_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(input.projectId, input.memoryId, input.repositoryId, NOW);
  }
  database.prepare(
    `INSERT INTO memory_versions
     (revision_id, project_id, memory_id, memory_version, content, content_sha256,
      audit_id, recorded_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(
    revisionId,
    input.projectId,
    input.memoryId,
    `Content for ${input.memoryId}.`,
    hash,
    auditId,
    NOW
  );
  database.prepare(
    `UPDATE memories SET current_revision_id = ?, memory_version = 1
     WHERE project_id = ? AND memory_id = ?`
  ).run(revisionId, input.projectId, input.memoryId);
  database.prepare(
    `INSERT INTO evidence
     (evidence_id, project_id, source_type, locator, excerpt_hash,
      sensitivity_status, recorded_at)
     VALUES (?, ?, 'test', ?, ?, 'clear', ?)`
  ).run(evidenceId, input.projectId, `test://${input.memoryId}`, hash, NOW);
  database.prepare(
    `INSERT INTO version_evidence (project_id, revision_id, evidence_id)
     VALUES (?, ?, ?)`
  ).run(input.projectId, revisionId, evidenceId);
  database.prepare(
    `UPDATE projects SET project_version = ?, audit_head_hash = ?, updated_at = ?
     WHERE project_id = ? AND project_version = ?`
  ).run(
    projectHead.project_version + 1,
    hash,
    NOW,
    input.projectId,
    projectHead.project_version
  );
}

class SqliteD1Statement {
  private bindings: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string
  ) {}

  bind(...bindings: unknown[]): SqliteD1Statement {
    this.bindings = bindings as SQLInputValue[];
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch<T>(
    statements: SqliteD1Statement[]
  ): Promise<Array<{ results: T[] }>> {
    this.database.exec("BEGIN");
    try {
      const results: Array<{ results: T[] }> = [];
      for (const statement of statements) {
        results.push(await statement.all<T>());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  withSession(_constraint: "first-primary"): SqliteD1 {
    return this;
  }
}
