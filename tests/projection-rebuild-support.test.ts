import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// The production rebuild CLI is plain ESM so it can run without a TypeScript runtime.
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as projectionRebuildSupport from "../scripts/projection-rebuild-support.mjs";
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as projectionRebuildCli from "../scripts/enqueue-projection-rebuild.mjs";

const {
  PROJECTION_REBUILD_SQL_BATCH_SIZE,
  PROJECTION_REBUILD_QUERY_BATCH_SIZE,
  PROJECTION_REBUILD_EVENT_TYPE,
  assertProjectionRebuildWaitBudget,
  buildProjectionRebuildSql,
  decodeD1Rows,
  estimateProjectionRebuildEtaSeconds,
  projectionRebuildDescriptors,
  projectionRebuildEnqueueIssues,
  projectionRebuildEvent,
  requireActiveSearchGeneration,
  sameProjectionRebuildTargets,
  selectLatestProjectionRebuildEvents,
  selectProjectionRebuildEvents,
  splitProjectionRebuildBatches,
  splitProjectionRebuildQueryBatches,
  summarizeProjectionRebuildPlan,
  summarizeProjectionRebuildVerification
} = projectionRebuildSupport;
const {
  ACTIVE_SEARCH_GENERATION_QUERY,
  PROJECTION_REBUILD_PAGE_SIZE,
  loadRebuildTargets,
  parseProjectionRebuildArguments,
  projectionRebuildCleanupDebtQuery,
  projectionRebuildHeadQuery,
  projectionRebuildHistoryQuery,
  projectionRebuildSearchHeadQuery,
  projectionRebuildTargetQuery,
  withProjectionRebuildEnumerationBudget
} = projectionRebuildCli;
const target = {
  project_id: "project:alpha",
  project_version: 17,
  search_generation_id: "generation-alpha",
  memory_count: 2,
  revision_count: 2,
  scope_count: 2,
  content_bytes: 9,
  memory_heads: [
    {
      memory_id: "memory-alpha",
      revision_id: "revision-alpha",
      repository_partition: "*"
    },
    {
      memory_id: "memory-beta",
      revision_id: "revision-beta",
      repository_partition: "repository-beta"
    }
  ],
  search_heads: [
    {
      generation_id: "generation-alpha",
      memory_id: "memory-alpha",
      project_version: 17,
      revision_id: "revision-alpha",
      repository_partition: "*",
      chunk_count: 2
    },
    {
      generation_id: "generation-alpha",
      memory_id: "memory-beta",
      project_version: 16,
      revision_id: "revision-old",
      repository_partition: "*",
      chunk_count: 1
    },
    {
      generation_id: "generation-alpha",
      memory_id: "memory-orphan",
      project_version: 15,
      revision_id: "revision-orphan",
      repository_partition: "repository:old",
      chunk_count: 3
    }
  ]
};

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      project_ref TEXT NOT NULL UNIQUE,
      project_version INTEGER NOT NULL
    );
    CREATE TABLE synthetic_cleanup_registry (
      project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
      cleanup_fenced_at TEXT
    );
    CREATE TABLE memories (
      memory_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      current_revision_id TEXT,
      scope TEXT NOT NULL DEFAULT 'project',
      scope_id TEXT NOT NULL DEFAULT 'project:alpha',
      UNIQUE (project_id, memory_id)
    );
    CREATE TABLE memory_repository_contexts (
      project_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      PRIMARY KEY (project_id, memory_id)
    ) WITHOUT ROWID;
    CREATE TABLE memory_versions (
      revision_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      memory_id TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE INDEX memory_versions_by_memory
      ON memory_versions (project_id, memory_id, revision_id);
    CREATE TABLE outbox_events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      project_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      dispatched_at TEXT,
      next_attempt_at TEXT,
      failed_at TEXT,
      last_error_code TEXT,
      projection_unknown_count INTEGER NOT NULL DEFAULT 0,
      projection_unknown_first_observed_at TEXT,
      projection_unknown_last_observed_at TEXT,
      projection_unknown_alerted_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE workflow_runs (
      workflow_id TEXT PRIMARY KEY,
      root_workflow_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO projects (project_id, project_ref, project_version)
    VALUES ('project:alpha', 'project.alpha', 17);
    INSERT INTO memories
      (memory_id, project_id, current_revision_id, scope, scope_id)
    VALUES ('memory-alpha', 'project:alpha', 'revision-alpha', 'project', 'project:alpha'),
           ('memory-beta', 'project:alpha', 'revision-beta',
            'repository', 'repository-beta');
    INSERT INTO memory_repository_contexts (project_id, memory_id, repository_id)
    VALUES ('project:alpha', 'memory-beta', 'repository-beta');
    INSERT INTO memory_versions (revision_id, project_id, memory_id, content)
    VALUES ('revision-alpha', 'project:alpha', 'memory-alpha', 'alpha'),
           ('revision-beta', 'project:alpha', 'memory-beta', 'beta');
  `);
  return database;
}

function historyRow(
  descriptor: ReturnType<typeof projectionRebuildDescriptors>[number],
  executionOrdinal: number,
  overrides: Record<string, unknown> = {}
) {
  const event = projectionRebuildEvent(descriptor, executionOrdinal);
  return {
    event_id: event.eventId,
    project_id: descriptor.projectId,
    project_version: descriptor.projectVersion,
    event_type: PROJECTION_REBUILD_EVENT_TYPE,
    payload_digest: event.payloadDigest,
    payload_json: JSON.stringify(event.payload),
    projection_target_id: descriptor.projectionTargetId,
    execution_ordinal: executionOrdinal,
    dispatched_at: null,
    failed_at: null,
    last_error_code: null,
    projection_unknown_count: 0,
    projection_unknown_first_observed_at: null,
    projection_unknown_last_observed_at: null,
    projection_unknown_alerted_at: null,
    workflow_status: null,
    workflow_updated_at: null,
    ...overrides
  };
}
function exactSnapshotRow() {
  return {
    project_id: target.project_id,
    project_version: target.project_version,
    active_snapshot_id: `${target.project_id}:${target.project_version}`,
    snapshot_id: `${target.project_id}:${target.project_version}`,
    status: "active",
    manifest_key: "projects/project-alpha/projections/17/manifest.json",
    manifest_sha256: "a".repeat(64)
  };
}
function exactSearchRows() {
  return target.memory_heads.map((head) => ({
    generation_id: target.search_generation_id,
    project_id: target.project_id,
    memory_id: head.memory_id,
    project_version: target.project_version,
    revision_id: head.revision_id,
    repository_partition: head.repository_partition,
    chunk_count: 1
  }));
}

function noCleanupDebt() {
  return { vectorCleanupCount: 0, projectionDeletionCount: 0 };
}

describe("projection rebuild fanout support", () => {
  it("creates stable snapshot, search, and orphan-delete descriptors", () => {
    const descriptors = projectionRebuildDescriptors(target);

    expect(descriptors.map((descriptor: { projectionMode: string }) => descriptor.projectionMode))
      .toEqual(["snapshot", "search", "search", "delete"]);
    expect(descriptors.every((descriptor: { projectionTargetId: string }) =>
      /^[a-f0-9]{64}$/u.test(descriptor.projectionTargetId)
    )).toBe(true);
    expect(descriptors[2]).toMatchObject({
      projectionMode: "search",
      memoryId: "memory-beta",
      revisionId: "revision-beta",
      repositoryPartition: "repository-beta"
    });
    expect(descriptors[3]).toMatchObject({
      projectionMode: "delete",
      memoryId: "memory-orphan",
      revisionId: "revision-orphan",
      searchProjectVersion: 15
    });
    expect(descriptors.filter((descriptor: { projectionMode: string }) =>
      descriptor.projectionMode === "delete"
    )).toHaveLength(1);
    expect(projectionRebuildDescriptors(structuredClone(target))).toEqual(descriptors);
  });

  it("rejects oversized Vectorize namespace and metadata values on every rebuild boundary", () => {
    const oversized = "仓".repeat(22);
    expect(() => projectionRebuildDescriptors({
      ...structuredClone(target),
      project_id: oversized
    })).toThrow(/64 UTF-8 bytes/iu);
    expect(() => projectionRebuildDescriptors({
      ...structuredClone(target),
      search_generation_id: oversized
    })).toThrow(/64 UTF-8 bytes/iu);

    const oversizedPartition = structuredClone(target);
    oversizedPartition.memory_heads[1]!.repository_partition = oversized;
    expect(() => projectionRebuildDescriptors(oversizedPartition))
      .toThrow(/64 UTF-8 bytes/iu);

    const [descriptor] = projectionRebuildDescriptors(target);
    expect(() => projectionRebuildEvent({
      ...descriptor,
      projectId: oversized
    }, 0)).toThrow(/64 UTF-8 bytes/iu);
    expect(() => projectionRebuildEvent({
      ...descriptor,
      searchGenerationId: oversized
    }, 0)).toThrow(/64 UTF-8 bytes/iu);

    const searchDescriptor = projectionRebuildDescriptors(target)[1];
    expect(() => projectionRebuildEvent({
      ...searchDescriptor,
      repositoryPartition: oversized
    }, 0)).toThrow(/64 UTF-8 bytes/iu);
  });

  it("strictly binds event identity and payload to its logical target and ordinal", () => {
    const [snapshot, search, , deletion] = projectionRebuildDescriptors(target);
    const snapshotEvent = projectionRebuildEvent(snapshot, 0);
    const retry = projectionRebuildEvent(snapshot, 1);

    expect(PROJECTION_REBUILD_EVENT_TYPE).toBe("projection.rebuild.requested");
    expect(snapshotEvent.eventId).toMatch(/^projection-rebuild:snapshot:[a-f0-9]{64}$/u);
    expect(retry.eventId).not.toBe(snapshotEvent.eventId);
    expect(retry.payload.projectionTargetId).toBe(snapshotEvent.payload.projectionTargetId);
    expect(snapshotEvent.payload).toEqual({
      type: PROJECTION_REBUILD_EVENT_TYPE,
      eventId: snapshotEvent.eventId,
      projectId: target.project_id,
      projectVersion: target.project_version,
      projectionMode: "snapshot",
      searchGenerationId: target.search_generation_id,
      projectionTargetId: snapshot.projectionTargetId,
      executionOrdinal: 0,
      memoryCount: 2,
      revisionCount: 2,
      scopeCount: 2,
      contentBytes: 9,
      headDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(Object.keys(projectionRebuildEvent(search, 0).payload)).toEqual([
      "type",
      "eventId",
      "projectId",
      "projectVersion",
      "projectionMode",
      "searchGenerationId",
      "projectionTargetId",
      "executionOrdinal",
      "memoryId",
      "revisionId",
      "repositoryPartition"
    ]);
    expect(projectionRebuildEvent(deletion, 0).payload).toMatchObject({
      projectionMode: "delete",
      memoryId: "memory-orphan",
      revisionId: "revision-orphan",
      searchProjectVersion: 15
    });
    expect(() => projectionRebuildEvent(snapshot, -1)).toThrow(/ordinal/iu);
    expect(() => projectionRebuildEvent(snapshot, 10_000)).toThrow(/ordinal/iu);
    expect(() => projectionRebuildDescriptors({
      ...target,
      memory_heads: [{
        memory_id: " memory-alpha",
        revision_id: "revision-alpha",
        repository_partition: "*"
      }]
    })).toThrow(/memory ID/iu);
    expect(() => projectionRebuildDescriptors({
      ...target,
      memory_heads: [{
        memory_id: "memory\nalpha",
        revision_id: "revision-alpha",
        repository_partition: "*"
      }]
    })).toThrow(/memory ID/iu);
  });

  it("enqueues ordinal zero idempotently with mode-specific authority guards", () => {
    const database = createDatabase();
    const events = projectionRebuildDescriptors(target).map(
      (descriptor: unknown) => projectionRebuildEvent(descriptor, 0)
    );
    const createdAt = "2026-07-27T21:00:00.000Z";

    database.exec(buildProjectionRebuildSql(events, { createdAt }));
    database.exec(buildProjectionRebuildSql(events, { createdAt }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_events").get())
      .toEqual({ count: 4 });

    const sql = buildProjectionRebuildSql(events, { createdAt });
    expect(sql).toContain("p.project_version = 17");
    expect(sql).toContain("COUNT(*) FROM memories");
    expect(sql).toContain("COUNT(*) FROM memory_versions");
    expect(sql).toContain("COUNT(DISTINCT m.scope_id)");
    expect(sql).toContain("SUM(length(CAST(v.content AS BLOB)))");
    expect(sql).toContain("m.current_revision_id = 'revision-alpha'");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("ON CONFLICT(event_id) DO NOTHING");
    expect(sql).not.toContain("DO UPDATE");
  });

  it("does not enqueue stale, mismatched, or cleanup-fenced work", () => {
    const createdAt = "2026-07-27T21:00:00.000Z";
    const descriptors = projectionRebuildDescriptors(target);

    const staleSnapshot = createDatabase();
    staleSnapshot.prepare("UPDATE projects SET project_version = 18").run();
    staleSnapshot.exec(buildProjectionRebuildSql([
      projectionRebuildEvent(descriptors[0], 0)
    ], { createdAt }));
    expect(staleSnapshot.prepare("SELECT COUNT(*) AS count FROM outbox_events").get())
      .toEqual({ count: 0 });

    const capacityDrift = createDatabase();
    capacityDrift.prepare(
      `INSERT INTO memory_versions (revision_id, project_id, memory_id, content)
       VALUES ('revision-history', 'project:alpha', 'memory-alpha', 'history')`
    ).run();
    capacityDrift.exec(buildProjectionRebuildSql([
      projectionRebuildEvent(descriptors[0], 0)
    ], { createdAt }));
    expect(capacityDrift.prepare("SELECT COUNT(*) AS count FROM outbox_events").get())
      .toEqual({ count: 0 });

    const staleSearch = createDatabase();
    staleSearch.prepare(
      "UPDATE memories SET current_revision_id = 'revision-next' WHERE memory_id = 'memory-alpha'"
    ).run();
    staleSearch.exec(buildProjectionRebuildSql([
      projectionRebuildEvent(descriptors[1], 0)
    ], { createdAt }));
    expect(staleSearch.prepare("SELECT COUNT(*) AS count FROM outbox_events").get())
      .toEqual({ count: 0 });

    const noLongerOrphan = createDatabase();
    noLongerOrphan.prepare(
      "INSERT INTO memories (memory_id, project_id, current_revision_id) VALUES (?, ?, ?)"
    ).run("memory-orphan", target.project_id, "revision-live");
    noLongerOrphan.exec(buildProjectionRebuildSql([
      projectionRebuildEvent(descriptors[3], 0)
    ], { createdAt }));
    expect(noLongerOrphan.prepare("SELECT COUNT(*) AS count FROM outbox_events").get())
      .toEqual({ count: 0 });

    const nullHead = createDatabase();
    nullHead.prepare(
      "INSERT INTO memories (memory_id, project_id, current_revision_id) VALUES (?, ?, NULL)"
    ).run("memory-orphan", target.project_id);
    nullHead.exec(buildProjectionRebuildSql([
      projectionRebuildEvent(descriptors[3], 0)
    ], { createdAt }));
    expect(nullHead.prepare("SELECT COUNT(*) AS count FROM outbox_events").get())
      .toEqual({ count: 1 });

    const fenced = createDatabase();
    fenced.prepare("UPDATE projects SET project_ref = 'system.synthetic.expired'").run();
    fenced.prepare(
      "INSERT INTO synthetic_cleanup_registry (project_id, cleanup_fenced_at) VALUES (?, ?)"
    ).run(target.project_id, createdAt);
    fenced.exec(buildProjectionRebuildSql([
      projectionRebuildEvent(descriptors[0], 0)
    ], { createdAt }));
    expect(fenced.prepare("SELECT COUNT(*) AS count FROM outbox_events").get())
      .toEqual({ count: 0 });
  });

  it("creates a new ordinal only after the latest execution is terminal", () => {
    const [descriptor] = projectionRebuildDescriptors(target);

    expect(selectProjectionRebuildEvents([descriptor], [], { resume: true }).events[0]
      .executionOrdinal).toBe(0);
    expect(() => selectProjectionRebuildEvents(
      [descriptor],
      [historyRow(descriptor, 0)],
      { resume: true }
    )).toThrow(/pending/iu);
    expect(() => selectProjectionRebuildEvents(
      [descriptor],
      [historyRow(descriptor, 0, {
        dispatched_at: "2026-07-27T21:05:00.000Z",
        workflow_status: "running"
      })],
      { resume: true }
    )).toThrow(/running|pending/iu);

    for (const terminal of [
      { failed_at: "2026-07-27T21:05:00.000Z" },
      {
        dispatched_at: "2026-07-27T21:05:00.000Z",
        workflow_status: "complete"
      },
      {
        dispatched_at: "2026-07-27T21:05:00.000Z",
        workflow_status: "failed"
      },
      {
        dispatched_at: "2026-07-27T21:05:00.000Z",
        workflow_status: "terminated"
      }
    ]) {
      expect(selectProjectionRebuildEvents(
        [descriptor],
        [historyRow(descriptor, 0, terminal)],
        { resume: true }
      ).events[0].executionOrdinal).toBe(1);
    }

    expect(() => selectProjectionRebuildEvents(
      [descriptor],
      [historyRow(descriptor, 9_999, { failed_at: "2026-07-27T21:05:00.000Z" })],
      { resume: true }
    )).toThrow(/ordinal capacity/iu);
  });

  it("allows an explicit resume after project-unavailable dispatch terminalization", () => {
    const [descriptor] = projectionRebuildDescriptors(target);
    const resumed = selectProjectionRebuildEvents(
      [descriptor],
      [historyRow(descriptor, 0, {
        failed_at: "2026-07-27T21:05:00.000Z",
        last_error_code: "PROJECTION_REBUILD_PROJECT_UNAVAILABLE"
      })],
      { resume: true }
    );

    expect(resumed.events).toHaveLength(1);
    expect(resumed.events[0].executionOrdinal).toBe(1);
    expect(resumed.pendingCount).toBe(1);
  });

  it("resumes by inserting a new immutable outbox row without rewriting failure fields", () => {
    const database = createDatabase();
    const [descriptor] = projectionRebuildDescriptors(target);
    const original = projectionRebuildEvent(descriptor, 0);
    const createdAt = "2026-07-27T21:00:00.000Z";
    database.exec(buildProjectionRebuildSql([original], { createdAt }));
    database.prepare(
      "UPDATE outbox_events SET failed_at = ?, last_error_code = ? WHERE event_id = ?"
    ).run(createdAt, "OUTBOX_DISPATCH_FAILED", original.eventId);

    const selection = selectProjectionRebuildEvents(
      [descriptor],
      [historyRow(descriptor, 0, { failed_at: createdAt })],
      { resume: true }
    );
    const resumeSql = buildProjectionRebuildSql(selection.events, { createdAt });
    expect(resumeSql).not.toContain("last_error_code");
    expect(resumeSql).not.toContain("DO UPDATE");
    database.exec(resumeSql);

    expect(database.prepare(
      "SELECT event_id, failed_at, last_error_code FROM outbox_events ORDER BY event_id"
    ).all()).toEqual(expect.arrayContaining([
      {
        event_id: original.eventId,
        failed_at: createdAt,
        last_error_code: "OUTBOX_DISPATCH_FAILED"
      },
      {
        event_id: selection.events[0].eventId,
        failed_at: null,
        last_error_code: null
      }
    ]));
  });

  it("keeps ordinary enqueue on ordinal zero and verification on the latest ordinal", () => {
    const [descriptor] = projectionRebuildDescriptors(target);
    const rows = [
      historyRow(descriptor, 0, {
        dispatched_at: "2026-07-27T21:05:00.000Z",
        workflow_status: "failed"
      }),
      historyRow(descriptor, 1, {
        dispatched_at: "2026-07-27T21:06:00.000Z",
        workflow_status: "complete"
      })
    ];

    expect(selectProjectionRebuildEvents([descriptor], rows, { resume: false }).events[0]
      .executionOrdinal).toBe(0);
    expect(selectLatestProjectionRebuildEvents([descriptor], rows).events[0]
      .executionOrdinal).toBe(1);
  });

  it("builds bounded keyset queries without consulting FTS5", () => {
    const projectQuery = projectionRebuildTargetQuery({
      projectId: "project:o'hare",
      cursor: { projectId: "project:alpha" },
      limit: 25
    });
    expect(projectQuery).toContain("p.project_id = 'project:o''hare'");
    expect(projectQuery).toContain("p.project_id > 'project:alpha'");
    expect(projectQuery).toContain("registry.cleanup_fenced_at IS NULL");
    expect(projectQuery).not.toContain("JOIN memories");
    expect(projectQuery).toContain("AS memory_count");
    expect(projectQuery).toContain("AS revision_count");
    expect(projectQuery).toContain("COUNT(DISTINCT m.scope_id)");
    expect(projectQuery).toContain("length(CAST(v.content AS BLOB))");
    expect(projectQuery).toContain("LIMIT 25");
    expect(createDatabase().prepare(projectionRebuildTargetQuery({
      projectId: target.project_id,
      limit: PROJECTION_REBUILD_PAGE_SIZE
    })).all()).toEqual([{
      project_id: target.project_id,
      project_version: target.project_version,
      memory_count: 2,
      revision_count: 2,
      scope_count: 2,
      content_bytes: 9
    }]);

    const headQuery = projectionRebuildHeadQuery({
      projectId: "project:o'hare",
      cursor: { projectId: "project:alpha", memoryId: "memory-zulu" },
      limit: 10
    });
    expect(headQuery).toContain("p.project_id, p.project_version");
    expect(headQuery).toContain("m.project_id > 'project:alpha'");
    expect(headQuery).toContain("m.memory_id > 'memory-zulu'");
    expect(headQuery).toContain("ORDER BY m.project_id ASC, m.memory_id ASC");
    expect(headQuery).toContain("registry.cleanup_fenced_at IS NULL");
    expect(headQuery).toContain("LIMIT 10");

    const searchQuery = projectionRebuildSearchHeadQuery({
      projectId: "project:o'hare",
      searchGenerationId: "generation-alpha",
      cursor: { projectId: "project:alpha", memoryId: "memory-zulu" },
      limit: 10
    });
    expect(searchQuery).toContain("h.generation_id = 'generation-alpha'");
    expect(searchQuery).toContain("g.status = 'active'");
    expect(searchQuery).toContain("h.project_id > 'project:alpha'");
    expect(searchQuery).toContain("h.memory_id > 'memory-zulu'");
    expect(searchQuery).toContain("h.chunk_count");
    expect(searchQuery).toContain("ORDER BY h.project_id ASC, h.memory_id ASC");
    expect(searchQuery).not.toContain("memory_fts");

    for (const query of [
      () => projectionRebuildTargetQuery({ limit: 0 }),
      () => projectionRebuildTargetQuery({ limit: 1_001 }),
      () => projectionRebuildHeadQuery({
        projectId: "project:alpha",
        limit: 0
      }),
      () => projectionRebuildSearchHeadQuery({
        projectId: "project:alpha",
        searchGenerationId: "generation-alpha",
        limit: 0
      })
    ]) {
      expect(query).toThrow(/limit/iu);
    }
    expect(() => projectionRebuildHeadQuery({
      cursor: { memoryId: "memory-alpha" }
    })).toThrow(/cursor project ID/iu);
    const oversized = "仓".repeat(22);
    for (const query of [
      () => projectionRebuildTargetQuery({ projectId: oversized }),
      () => projectionRebuildHeadQuery({ projectId: oversized }),
      () => projectionRebuildSearchHeadQuery({
        projectId: oversized,
        searchGenerationId: "generation-alpha"
      }),
      () => projectionRebuildCleanupDebtQuery({
        projectId: oversized,
        searchGenerationId: "generation-alpha"
      }),
      () => projectionRebuildTargetQuery({
        cursor: { projectId: oversized }
      })
    ]) {
      expect(query).toThrow(/64 UTF-8 bytes/iu);
    }

    const memoryPlan = createDatabase().prepare(
      `EXPLAIN QUERY PLAN ${projectionRebuildHeadQuery({
        cursor: { projectId: "project:alpha", memoryId: "memory-alpha" },
        limit: 200
      })}`
    ).all().map((row) => String(row.detail)).join("\n");
    expect(memoryPlan).toMatch(/SEARCH m USING INDEX .*memories/iu);
    expect(memoryPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    const searchDatabase = new DatabaseSync(":memory:");
    searchDatabase.exec(`
      CREATE TABLE search_generations (
        generation_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE memory_projection_heads (
        generation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        project_version INTEGER NOT NULL,
        revision_id TEXT NOT NULL,
        repository_partition TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        PRIMARY KEY (generation_id, project_id, memory_id)
      ) WITHOUT ROWID;
    `);
    const searchPlan = searchDatabase.prepare(
      `EXPLAIN QUERY PLAN ${projectionRebuildSearchHeadQuery({
        searchGenerationId: "generation-alpha",
        cursor: { projectId: "project:alpha", memoryId: "memory-alpha" },
        limit: 200
      })}`
    ).all().map((row) => String(row.detail)).join("\n");
    expect(searchPlan).toMatch(/SEARCH h USING PRIMARY KEY .*generation_id/iu);
    expect(searchPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("loads many projects with globally paged calls instead of per-project calls", () => {
    const projects = Array.from({ length: 1_000 }, (_, index) => ({
      project_id: `project:${String(index).padStart(4, "0")}`,
      project_version: index,
      memory_count: 1,
      revision_count: 1,
      scope_count: 1,
      content_bytes: 1
    }));
    const memoryRows = projects.map((project) => ({
      ...project,
      memory_id: `memory:${project.project_id}`,
      revision_id: `revision:${project.project_id}`,
      scope: "project",
      scope_id: project.project_id,
      repository_id: null
    }));
    const searchRows = projects.map((project) => ({
      generation_id: "generation-alpha",
      project_id: project.project_id,
      memory_id: `memory:${project.project_id}`,
      project_version: project.project_version,
      revision_id: `revision:${project.project_id}`,
      repository_partition: "*",
      chunk_count: 1
    }));
    const calls: string[] = [];
    const pageSize = PROJECTION_REBUILD_PAGE_SIZE;
    const projectPages = Array.from({ length: 3 }, (_, index) =>
      projects.slice(index * pageSize, (index + 1) * pageSize)
    );
    const memoryPages = Array.from({ length: 3 }, (_, index) =>
      memoryRows.slice(index * pageSize, (index + 1) * pageSize)
    );
    const searchPages = Array.from({ length: 3 }, (_, index) =>
      searchRows.slice(index * pageSize, (index + 1) * pageSize)
    );
    let projectCall = 0;
    let memoryCall = 0;
    let searchCall = 0;
    const targets = loadRebuildTargets("config.jsonc", undefined, {
      pageSize,
      runQuery: (_database: string, _sql: string, _config: string, label: string) => {
        calls.push(label);
        if (label === "Load active search generation") {
          return [{ generation_id: "generation-alpha" }];
        }
        if (label === "Load authoritative projection rebuild targets") {
          const page = projectPages[projectCall % projectPages.length];
          projectCall += 1;
          return page;
        }
        if (label === "Load authoritative projection rebuild memory heads") {
          const page = memoryPages[memoryCall];
          memoryCall += 1;
          return page;
        }
        if (label === "Load active search projection ledger heads") {
          const page = searchPages[searchCall];
          searchCall += 1;
          return page;
        }
        throw new Error(`Unexpected query label: ${label}`);
      }
    });

    expect(targets).toHaveLength(1_000);
    expect(targets[999]).toMatchObject({
      project_id: "project:0999",
      memory_heads: [{
        memory_id: "memory:project:0999",
        repository_partition: "*"
      }],
      search_heads: [{ memory_id: "memory:project:0999" }]
    });
    expect(PROJECTION_REBUILD_PAGE_SIZE).toBe(500);
    expect(calls).toHaveLength(14);
    expect(calls.filter((label) => label.includes("memory heads"))).toHaveLength(3);
    expect(calls.filter((label) => label.includes("ledger heads"))).toHaveLength(3);
  });

  it("fails closed when a global memory page observes another project version", () => {
    let projectCall = 0;
    expect(() => loadRebuildTargets("config.jsonc", "project:alpha", {
      pageSize: 10,
      runQuery: (_database: string, _sql: string, _config: string, label: string) => {
        if (label === "Load active search generation") {
          return [{ generation_id: "generation-alpha" }];
        }
        if (label === "Load authoritative projection rebuild targets") {
          projectCall += 1;
          return projectCall === 1
            ? [{ ...target, memory_heads: undefined, search_heads: undefined }]
            : [{ ...target, memory_heads: undefined, search_heads: undefined }];
        }
        if (label === "Load authoritative projection rebuild memory heads") {
          return [{
            project_id: "project:alpha",
            project_version: 18,
            memory_id: "memory-alpha",
            revision_id: "revision-alpha"
          }];
        }
        return [];
      }
    })).toThrow(/project version changed/iu);
  });

  it("queries execution history by stable logical target with the latest workflow state", () => {
    const descriptors = projectionRebuildDescriptors(target);
    const query = projectionRebuildHistoryQuery(
      descriptors.map((descriptor: { projectionTargetId: string }) =>
        descriptor.projectionTargetId
      )
    );

    expect(query).toContain("json_extract(e.payload_json, '$.projectionTargetId')");
    expect(query).toContain("json_extract(e.payload_json, '$.executionOrdinal')");
    expect(query).toContain("FROM workflow_runs wr");
    expect(query).toContain("wr.root_workflow_id = e.event_id");
    expect(query).toContain("ORDER BY wr.updated_at DESC");
    expect(query).toContain("first.event_id GLOB 'projection-rebuild:*'");
    expect(query).toContain("latest.event_id GLOB 'projection-rebuild:*'");
    expect(query).toContain("IN ('snapshot', 'search', 'delete')");
    expect(query).toContain("WITH requested_targets(projection_target_id)");
    expect(query).toContain("first.event_type = 'projection.rebuild.requested'");
    expect(query).toContain("latest.event_type = 'projection.rebuild.requested'");
    expect(query).not.toContain("memory.changed");
    expect(query).toContain("$.executionOrdinal') = 0");
    expect(query).toContain("ORDER BY json_extract(latest.payload_json");
    expect(query).not.toContain("memory_fts");

    const database = createDatabase();
    const descriptor = descriptors[0];
    const createdAt = "2026-07-27T21:00:00.000Z";
    database.exec(buildProjectionRebuildSql([0, 1, 2].map((ordinal) =>
      projectionRebuildEvent(descriptor, ordinal)
    ), { createdAt }));
    const rows = database.prepare(
      projectionRebuildHistoryQuery([descriptor.projectionTargetId])
    ).all();
    expect(rows.map((row) => row.execution_ordinal)).toEqual([0, 2]);
  });

  it("keeps 250-target history queries inside the D1 statement limit", () => {
    const targetIds = Array.from(
      { length: PROJECTION_REBUILD_QUERY_BATCH_SIZE },
      (_, index) => index.toString(16).padStart(64, "0")
    );
    const query = projectionRebuildHistoryQuery(targetIds);

    expect(Buffer.byteLength(query, "utf8")).toBeLessThan(100_000);
    expect(createDatabase().prepare(query).all()).toEqual([]);
    expect(() => projectionRebuildHistoryQuery([...targetIds, "f".repeat(64)]))
      .toThrow(/between 1 and 250/iu);
  });

  it("verifies exact snapshot and bidirectional active-generation search state", () => {
    const descriptors = projectionRebuildDescriptors(target);
    const events = descriptors.map((descriptor: unknown) =>
      projectionRebuildEvent(descriptor, 0)
    );
    const outboxRows = descriptors.map((descriptor: unknown) =>
      historyRow(descriptor, 0, {
        dispatched_at: "2026-07-27T21:05:00.000Z",
        workflow_status: "complete"
      })
    );
    const summary = summarizeProjectionRebuildVerification({
      targets: [target],
      events,
      outboxRows,
      snapshotRows: [exactSnapshotRow()],
      searchRows: exactSearchRows(),
      cleanupDebt: noCleanupDebt()
    });

    expect(summary).toEqual({
      complete: true,
      totalCount: 4,
      projectCount: 1,
      searchCount: 2,
      deleteCount: 1,
      vectorCleanupDebtCount: 0,
      projectionDeletionDebtCount: 0,
      pendingCount: 0,
      issues: []
    });
  });

  it("checks high-cardinality exact search sets in linear project partitions", () => {
    const projectCount = 200;
    let projectReads = 0;
    const targets = Array.from({ length: projectCount }, (_, index) => ({
      project_id: `project-${index.toString().padStart(4, "0")}`,
      project_version: 1,
      search_generation_id: "generation-scale",
      memory_count: 1,
      revision_count: 1,
      scope_count: 1,
      content_bytes: 1,
      memory_heads: [{
        memory_id: "memory-1",
        revision_id: `revision-${index}`,
        repository_partition: "*"
      }],
      search_heads: []
    }));
    const descriptors = targets.flatMap(projectionRebuildDescriptors);
    const searchRows = targets.map((project) => ({
      generation_id: project.search_generation_id,
      get project_id() {
        projectReads += 1;
        return project.project_id;
      },
      memory_id: "memory-1",
      project_version: 1,
      revision_id: project.memory_heads[0]!.revision_id,
      repository_partition: "*",
      chunk_count: 1
    }));

    const summary = summarizeProjectionRebuildVerification({
      targets,
      events: descriptors.map((descriptor) => projectionRebuildEvent(descriptor, 0)),
      outboxRows: descriptors.map((descriptor) =>
        historyRow(descriptor, 0, {
          dispatched_at: "2026-07-27T21:05:00.000Z",
          workflow_status: "complete"
        })
      ),
      snapshotRows: targets.map((project) => ({
        project_id: project.project_id,
        project_version: 1,
        active_snapshot_id: `${project.project_id}:1`,
        snapshot_id: `${project.project_id}:1`,
        status: "active",
        manifest_key: `projects/${project.project_id}/projections/1/manifest.json`,
        manifest_sha256: "a".repeat(64)
      })),
      searchRows,
      cleanupDebt: noCleanupDebt()
    });

    expect(summary.complete).toBe(true);
    expect(projectReads).toBeLessThan(projectCount * 10);
  });

  it("reports failed dispatches and every incomplete search-ledger boundary", () => {
    const descriptors = projectionRebuildDescriptors(target);
    const events = descriptors.map((descriptor: unknown) =>
      projectionRebuildEvent(descriptor, 0)
    );
    const outboxRows = descriptors.map((descriptor: unknown, index: number) =>
      historyRow(descriptor, 0, index === 0
        ? { failed_at: "2026-07-27T21:05:00.000Z" }
        : { dispatched_at: "2026-07-27T21:05:00.000Z" })
    );
    const searchRows = [
      {
        ...exactSearchRows()[0],
        repository_partition: "repository-wrong",
        chunk_count: 1
      },
      {
        ...exactSearchRows()[1],
        revision_id: "revision-wrong"
      },
      {
        ...exactSearchRows()[0],
        memory_id: "memory-unexpected"
      },
      {
        ...target.search_heads[2],
        project_id: target.project_id
      }
    ];
    const summary = summarizeProjectionRebuildVerification({
      targets: [target],
      events,
      outboxRows,
      snapshotRows: [],
      searchRows,
      cleanupDebt: noCleanupDebt()
    });

    expect(summary.complete).toBe(false);
    expect(summary.pendingCount).toBeGreaterThan(0);
    expect(summary.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("outbox event failed"),
      expect.stringContaining("project snapshot is not active"),
      expect.stringContaining("search projection head is not current"),
      expect.stringContaining("orphan search projection head still exists"),
      expect.stringContaining("unexpected active search projection head")
    ]));
  });

  it("does not accept a merely dispatched workflow when projections were already current", () => {
    const descriptors = projectionRebuildDescriptors(target);
    const events = descriptors.map((descriptor: unknown) =>
      projectionRebuildEvent(descriptor, 0)
    );
    const summary = summarizeProjectionRebuildVerification({
      targets: [target],
      events,
      outboxRows: descriptors.map((descriptor: unknown) => historyRow(descriptor, 0, {
        dispatched_at: "2026-07-27T21:05:00.000Z",
        workflow_status: "running"
      })),
      snapshotRows: [exactSnapshotRow()],
      searchRows: exactSearchRows(),
      cleanupDebt: noCleanupDebt()
    });

    expect(summary.complete).toBe(false);
    expect(summary.pendingCount).toBe(4);
    expect(summary.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("workflow is running, not complete")
    ]));
  });

  it("reports the nonterminal control-plane unknown threshold and keeps resume blocked", () => {
    const descriptors = projectionRebuildDescriptors(target);
    const events = descriptors.map((descriptor: unknown) =>
      projectionRebuildEvent(descriptor, 0)
    );
    const unknown = historyRow(descriptors[0], 0, {
      dispatched_at: "2026-07-27T21:05:00.000Z",
      last_error_code: "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN",
      projection_unknown_count: 12,
      projection_unknown_first_observed_at: "2026-07-27T21:10:00.000Z",
      projection_unknown_last_observed_at: "2026-07-27T22:05:00.000Z",
      projection_unknown_alerted_at: "2026-07-27T22:05:00.000Z"
    });
    const summary = summarizeProjectionRebuildVerification({
      targets: [target],
      events,
      outboxRows: [
        unknown,
        ...descriptors.slice(1).map((descriptor: unknown) =>
          historyRow(descriptor, 0, {
            dispatched_at: "2026-07-27T21:05:00.000Z",
            workflow_status: "complete"
          })
        )
      ],
      snapshotRows: [exactSnapshotRow()],
      searchRows: exactSearchRows(),
      cleanupDebt: noCleanupDebt()
    });

    expect(summary.complete).toBe(false);
    expect(summary.pendingCount).toBe(1);
    expect(summary.issues).toEqual([
      expect.stringMatching(
        /control-plane status remained unknown after 12 consecutive.*reconciliation remains active.*resume is unsafe.*require inspection/iu
      )
    ]);
    expect(() =>
      selectProjectionRebuildEvents([descriptors[0]], [unknown], { resume: true })
    ).toThrow(/resume is not safe while work is pending/iu);
  });

  it("selects exact enqueue state and rejects corrupted history", () => {
    const [descriptor] = projectionRebuildDescriptors(target);
    const event = projectionRebuildEvent(descriptor, 0);
    expect(projectionRebuildEnqueueIssues([event], [])).toEqual([
      `${event.eventId}: outbox event is missing.`
    ]);
    expect(projectionRebuildEnqueueIssues([event], [historyRow(descriptor, 0)]))
      .toEqual([]);
    expect(() => selectProjectionRebuildEvents([descriptor], [
      historyRow(descriptor, 0, { payload_digest: "b".repeat(64) })
    ], { resume: false })).toThrow(/stable payload/iu);
  });

  it("plans deterministic batches, throughput ETA, and pending work", () => {
    const descriptors = projectionRebuildDescriptors(target);
    const selection = selectProjectionRebuildEvents(descriptors, [], { resume: false });
    const summary = summarizeProjectionRebuildPlan([target], selection);

    expect(PROJECTION_REBUILD_SQL_BATCH_SIZE).toBe(50);
    expect(PROJECTION_REBUILD_QUERY_BATCH_SIZE).toBe(250);
    expect(splitProjectionRebuildBatches(Array.from({ length: 101 }, (_, index) => index)))
      .toEqual([
        Array.from({ length: 50 }, (_, index) => index),
        Array.from({ length: 50 }, (_, index) => index + 50),
        [100]
      ]);
    expect(splitProjectionRebuildQueryBatches(
      Array.from({ length: 10_001 }, (_, index) => index)
    )).toHaveLength(41);
    expect(splitProjectionRebuildQueryBatches(
      Array.from({ length: 10_001 }, (_, index) => index)
    ).at(-1)).toEqual([10_000]);
    expect(summary).toEqual({
      totalCount: 4,
      projectCount: 1,
      searchCount: 2,
      deleteCount: 1,
      pendingCount: 4,
      etaSeconds: 660
    });
    expect(estimateProjectionRebuildEtaSeconds(250)).toBe(660);
    expect(estimateProjectionRebuildEtaSeconds(251)).toBe(720);
    expect(estimateProjectionRebuildEtaSeconds(10_001)).toBe(3_060);
    expect(estimateProjectionRebuildEtaSeconds(0)).toBe(0);
    expect(() => assertProjectionRebuildWaitBudget(summary, 659))
      .toThrow(/no events were enqueued/iu);
    expect(assertProjectionRebuildWaitBudget(summary, 660)).toBeUndefined();
    const budgeted = withProjectionRebuildEnumerationBudget(summary, {
      queryCount: 26,
      elapsedMilliseconds: 1_001
    });
    expect(budgeted).toMatchObject({
      rebuildEtaSeconds: 660,
      enumerationQueryCount: 26,
      enumerationSeconds: 2,
      etaSeconds: 662
    });
    expect(() => assertProjectionRebuildWaitBudget(budgeted, 661))
      .toThrow(/no events were enqueued/iu);

    const completed = selectProjectionRebuildEvents(
      descriptors,
      descriptors.map((descriptor: unknown) => historyRow(descriptor, 0, {
        dispatched_at: "2026-07-27T21:05:00.000Z",
        workflow_status: "complete"
      })),
      { resume: false }
    );
    expect(summarizeProjectionRebuildPlan([target], completed)).toMatchObject({
      pendingCount: 0,
      etaSeconds: 0
    });
  });

  it("parses plan and bounded wait options without changing existing command arguments", () => {
    expect(parseProjectionRebuildArguments([
      "plan",
      "--config",
      "wrangler/generated.jsonc",
      "--project-id",
      "project:alpha",
      "--resume",
      "--max-wait-seconds",
      "900"
    ])).toEqual({
      command: "plan",
      config: "wrangler/generated.jsonc",
      projectId: "project:alpha",
      resume: true,
      waitSeconds: 0,
      maxWaitSeconds: 900
    });
    expect(parseProjectionRebuildArguments([
      "enqueue",
      "--max-wait-seconds",
      "1200"
    ])).toMatchObject({ command: "enqueue", maxWaitSeconds: 1200 });
    expect(parseProjectionRebuildArguments(["verify", "--wait-seconds", "45"]))
      .toMatchObject({ command: "verify", waitSeconds: 45, resume: false });
    expect(() => parseProjectionRebuildArguments(["verify", "--resume"]))
      .toThrow(/plan or enqueue/iu);
    expect(() => parseProjectionRebuildArguments(["verify", "--max-wait-seconds", "1"]))
      .toThrow(/plan or enqueue/iu);
    expect(() => parseProjectionRebuildArguments(["plan", "--wait-seconds", "1"]))
      .toThrow(/verify/iu);
    expect(() => parseProjectionRebuildArguments(["enqueue", "--max-wait-seconds", "-1"]))
      .toThrow(/maximum wait/iu);
    expect(() => parseProjectionRebuildArguments([
      "plan",
      "--project-id",
      "仓".repeat(22)
    ])).toThrow(/64 UTF-8 bytes/iu);
  });

  it("keeps real pnpm script argument forwarding intact", () => {
    const missingConfig = join(tmpdir(), `edgemneme-missing-${randomUUID()}.jsonc`);
    for (const invocation of [
      ["projection:rebuild:plan", "--max-wait-seconds", "3600"],
      ["projection:rebuild:verify", "--wait-seconds", "900"],
      ["projection:rebuild:enqueue", "--resume", "--max-wait-seconds", "900"]
    ]) {
      const result = spawnSync("pnpm", [...invocation, "--config", missingConfig], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      expect(result.status).toBe(1);
      expect(output).toContain("The rendered Wrangler config does not exist");
      expect(output).not.toContain("Unknown projection rebuild argument");
    }
  });

  it("loads active generation and D1 JSON fail closed", () => {
    expect(ACTIVE_SEARCH_GENERATION_QUERY).toContain("status = 'active'");
    expect(requireActiveSearchGeneration([{ generation_id: "generation-alpha" }]))
      .toBe("generation-alpha");
    expect(() => requireActiveSearchGeneration([])).toThrow(/exactly one/iu);
    expect(() => requireActiveSearchGeneration([
      { generation_id: "generation-alpha" },
      { generation_id: "generation-beta" }
    ])).toThrow(/exactly one/iu);
    expect(() => requireActiveSearchGeneration([
      { generation_id: "仓".repeat(22) }
    ])).toThrow(/64 UTF-8 bytes/iu);
    expect(decodeD1Rows(JSON.stringify([
      { success: true, results: [{ project_id: "project:alpha" }] }
    ]))).toEqual([{ project_id: "project:alpha" }]);
    expect(() => decodeD1Rows("not-json")).toThrow(/valid D1 JSON/iu);
    expect(() => decodeD1Rows(JSON.stringify([{ success: false, results: [] }])))
      .toThrow(/failed/iu);
  });

  it("compares post-enqueue authority without treating expected search convergence as drift", () => {
    const converged = structuredClone(target);
    converged.search_heads = exactSearchRows().map((row) => ({
      generation_id: row.generation_id,
      memory_id: row.memory_id,
      project_version: row.project_version,
      revision_id: row.revision_id,
      repository_partition: row.repository_partition,
      chunk_count: row.chunk_count
    }));
    expect(sameProjectionRebuildTargets([target], [converged])).toBe(true);
    expect(sameProjectionRebuildTargets(
      [target],
      [{ ...converged, project_version: 18 }]
    )).toBe(false);
    expect(sameProjectionRebuildTargets(
      [target],
      [{ ...converged, search_generation_id: "generation-beta" }]
    )).toBe(false);
    const capacityChanged = { ...converged, content_bytes: 10 };
    expect(sameProjectionRebuildTargets([target], [capacityChanged])).toBe(false);
    expect(projectionRebuildDescriptors(capacityChanged)[0]?.projectionTargetId)
      .not.toBe(projectionRebuildDescriptors(converged)[0]?.projectionTargetId);
    const partitionChanged = structuredClone(converged);
    partitionChanged.memory_heads[1]!.repository_partition = "repository-next";
    expect(sameProjectionRebuildTargets([target], [partitionChanged])).toBe(false);
    expect(projectionRebuildDescriptors(partitionChanged)[0]?.projectionTargetId)
      .not.toBe(projectionRebuildDescriptors(converged)[0]?.projectionTargetId);
    expect(sameProjectionRebuildTargets(
      [target],
      [{
        ...converged,
        memory_heads: [
          converged.memory_heads[0],
          {
            memory_id: "memory-beta",
            revision_id: "revision-next",
            repository_partition: "repository-beta"
          }
        ]
      }]
    )).toBe(false);
  });

  it("contains no FTS verification fallback in the production CLI", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/enqueue-projection-rebuild.mjs"),
      "utf8"
    );
    expect(source).not.toContain("memory_fts");
    expect(source).toContain("pending=");
    expect(source).toContain("--max-wait-seconds");
  });
});
