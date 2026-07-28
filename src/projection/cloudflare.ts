import type {
  MemoryClass,
  MemoryKind,
  MemoryScope,
  MemoryStatus
} from "../contracts/taxonomy";
import { sha256 } from "../security/crypto";
import type { ProjectionMemory } from "./markdown";
import {
  buildProjectionSnapshotPlan,
  validateProjectionSnapshotPlan
} from "./snapshot";

export interface ProjectionPreparedStatementLike<TSelf> {
  bind(...values: unknown[]): TSelf;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface ProjectionDatabaseLike<
  TStatement extends ProjectionPreparedStatementLike<TStatement>
> {
  withSession(constraint: "first-primary"): {
    prepare(query: string): TStatement;
  };
  prepare(query: string): TStatement;
  batch(statements: TStatement[]): Promise<Array<{ meta: { changes: number } }>>;
}

export interface ProjectionBucketLike {
  head(key: string): Promise<{ customMetadata?: Record<string, string> } | null>;
  put(
    key: string,
    value: string,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
      onlyIf: { etagDoesNotMatch: string };
    }
  ): Promise<unknown | null>;
}

export interface PublishProjectProjectionInput<
  TStatement extends ProjectionPreparedStatementLike<TStatement>
> {
  memoryDb: ProjectionDatabaseLike<TStatement>;
  projections: ProjectionBucketLike;
  projectId: string;
  projectVersion: number;
  now?: () => string;
}

export type PublishProjectProjectionResult =
  | {
      status: "activated";
      snapshotId: string;
      manifestKey: string;
      manifestSha256: string;
      writeCount: number;
    }
  | {
      status: "stale";
      phase: "before-read" | "after-read" | "activation";
      snapshotId: string;
      expectedProjectVersion: number;
      observedProjectVersion: number | null;
      writeCount: number;
    };

interface ProjectVersionRow {
  project_version: number;
}

interface ProjectionHeadRow {
  memory_id: string;
  current_revision_id: string | null;
  memory_version: number;
  kind: MemoryKind;
  memory_class: MemoryClass;
  scope: MemoryScope;
  scope_id: string;
  status: MemoryStatus;
}

interface ProjectionRevisionRow {
  memory_id: string;
  revision_id: string;
  memory_version: number;
  content: string;
  content_sha256: string;
  valid_from: string | null;
  valid_until: string | null;
  kind: MemoryKind;
  memory_class: MemoryClass;
  scope: MemoryScope;
  scope_id: string;
  status: MemoryStatus;
}

interface ProjectionEvidenceRow {
  revision_id: string;
  evidence_id: string;
}

const PROJECT_VERSION_SQL =
  "SELECT project_version FROM projects WHERE project_id = ?";

const HEADS_SQL = `SELECT m.memory_id, m.current_revision_id, m.memory_version, m.kind,
                          m.memory_class, m.scope, m.scope_id, m.status
                   FROM memories m
                   WHERE m.project_id = ?
                   ORDER BY m.memory_id ASC`;

const REVISIONS_SQL = `SELECT v.memory_id, v.revision_id, v.memory_version,
                              v.content, v.content_sha256, v.valid_from,
                              v.valid_until,
                              m.kind, m.memory_class, m.scope, m.scope_id, m.status
                       FROM memory_versions v
                       JOIN memories m
                         ON m.project_id = v.project_id
                        AND m.memory_id = v.memory_id
                       WHERE v.project_id = ?
                       ORDER BY v.memory_id ASC, v.memory_version ASC,
                                v.revision_id ASC`;

const EVIDENCE_SQL = `SELECT ve.revision_id, ve.evidence_id
                      FROM version_evidence ve
                      JOIN memory_versions v
                        ON v.project_id = ve.project_id
                       AND v.revision_id = ve.revision_id
                      WHERE ve.project_id = ?
                      ORDER BY ve.revision_id ASC, ve.evidence_id ASC`;

export async function publishProjectProjection<
  TStatement extends ProjectionPreparedStatementLike<TStatement>
>(
  input: PublishProjectProjectionInput<TStatement>
): Promise<PublishProjectProjectionResult> {
  requirePublishInput(input.projectId, input.projectVersion);
  const projectionSnapshotId = String(input.projectVersion);
  const snapshotId = `${input.projectId}:${projectionSnapshotId}`;
  const before = await readProjectVersion(input.memoryDb, input.projectId);
  if (before !== input.projectVersion) {
    return staleResult("before-read", snapshotId, input.projectVersion, before, 0);
  }

  const [headRows, revisionRows, evidenceRows] = await Promise.all([
    readAllFirstPrimary<ProjectionHeadRow, TStatement>(
      input.memoryDb,
      HEADS_SQL,
      input.projectId
    ),
    readAllFirstPrimary<ProjectionRevisionRow, TStatement>(
      input.memoryDb,
      REVISIONS_SQL,
      input.projectId
    ),
    readAllFirstPrimary<ProjectionEvidenceRow, TStatement>(
      input.memoryDb,
      EVIDENCE_SQL,
      input.projectId
    )
  ]);
  const after = await readProjectVersion(input.memoryDb, input.projectId);
  if (after !== input.projectVersion) {
    return staleResult("after-read", snapshotId, input.projectVersion, after, 0);
  }

  const { heads, revisions } = await mapProjectionRows({
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    snapshotId: projectionSnapshotId,
    headRows,
    revisionRows,
    evidenceRows
  });
  const plan = await buildProjectionSnapshotPlan({
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    snapshotId: projectionSnapshotId,
    heads,
    revisions
  });
  const validation = await validateProjectionSnapshotPlan(plan);
  if (!validation.valid) {
    throw new Error(`Projection plan validation failed: ${validation.errors.join("; ")}`);
  }

  for (const write of plan.writes) {
    const stored = await input.projections.put(write.key, write.body, {
      httpMetadata: { contentType: write.contentType },
      customMetadata: {
        sha256: write.sha256,
        projectVersion: String(input.projectVersion),
        snapshotId
      },
      onlyIf: { etagDoesNotMatch: "*" }
    });
    if (stored === null) {
      const existing = await input.projections.head(write.key);
      if (existing?.customMetadata?.sha256 !== write.sha256) {
        throw new Error(`Immutable R2 projection collision: ${write.key}`);
      }
    }
  }

  const activated = await activateSnapshot({
    database: input.memoryDb,
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    snapshotId,
    manifestKey: plan.manifestKey,
    manifestSha256: plan.manifestSha256,
    now: input.now?.() ?? new Date().toISOString()
  });
  if (!activated) {
    return staleResult(
      "activation",
      snapshotId,
      input.projectVersion,
      null,
      plan.writes.length
    );
  }
  return {
    status: "activated",
    snapshotId,
    manifestKey: plan.manifestKey,
    manifestSha256: plan.manifestSha256,
    writeCount: plan.writes.length
  };
}

async function readProjectVersion<
  TStatement extends ProjectionPreparedStatementLike<TStatement>
>(
  database: ProjectionDatabaseLike<TStatement>,
  projectId: string
): Promise<number | null> {
  const row = await database
    .withSession("first-primary")
    .prepare(PROJECT_VERSION_SQL)
    .bind(projectId)
    .first<ProjectVersionRow>();
  return row?.project_version ?? null;
}

async function readAllFirstPrimary<
  TRow,
  TStatement extends ProjectionPreparedStatementLike<TStatement>
>(
  database: ProjectionDatabaseLike<TStatement>,
  query: string,
  projectId: string
): Promise<TRow[]> {
  const result = await database
    .withSession("first-primary")
    .prepare(query)
    .bind(projectId)
    .all<TRow>();
  return result.results;
}

async function mapProjectionRows(input: {
  projectId: string;
  projectVersion: number;
  snapshotId: string;
  headRows: ProjectionHeadRow[];
  revisionRows: ProjectionRevisionRow[];
  evidenceRows: ProjectionEvidenceRow[];
}): Promise<{ heads: ProjectionMemory[]; revisions: ProjectionMemory[] }> {
  const evidenceByRevision = new Map<string, string[]>();
  const revisionIds = new Set(input.revisionRows.map((row) => row.revision_id));
  for (const evidence of input.evidenceRows) {
    if (!revisionIds.has(evidence.revision_id)) {
      throw new Error(`Evidence references an unknown revision: ${evidence.revision_id}`);
    }
    const ids = evidenceByRevision.get(evidence.revision_id) ?? [];
    ids.push(evidence.evidence_id);
    evidenceByRevision.set(evidence.revision_id, ids);
  }
  const revisions = await Promise.all(
    input.revisionRows.map(async (row) => {
      if ((await sha256(row.content)) !== row.content_sha256.toLowerCase()) {
        throw new Error(`D1 content checksum mismatch: ${row.revision_id}`);
      }
      return rowToProjectionMemory(input, row, evidenceByRevision.get(row.revision_id) ?? []);
    })
  );
  const revisionById = new Map(revisions.map((revision) => [revision.revisionId, revision]));
  const heads = input.headRows.map((row) => {
    if (row.current_revision_id === null) {
      throw new Error(`Formal memory has no current revision: ${row.memory_id}`);
    }
    const revision = revisionById.get(row.current_revision_id);
    if (revision === undefined || revision.memoryId !== row.memory_id) {
      throw new Error(`Current revision is missing from project history: ${row.current_revision_id}`);
    }
    return {
      ...revision,
      memoryVersion: row.memory_version,
      kind: row.kind,
      memoryClass: row.memory_class,
      scope: row.scope,
      scopeId: row.scope_id,
      status: row.status
    };
  });
  return { heads, revisions };
}

function rowToProjectionMemory(
  input: { projectId: string; projectVersion: number; snapshotId: string },
  row: ProjectionRevisionRow,
  evidenceIds: string[]
): ProjectionMemory {
  return {
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    snapshotId: input.snapshotId,
    memoryId: row.memory_id,
    revisionId: row.revision_id,
    memoryVersion: row.memory_version,
    kind: row.kind,
    memoryClass: row.memory_class,
    scope: row.scope,
    scopeId: row.scope_id,
    status: row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    evidenceIds,
    content: row.content
  };
}

async function activateSnapshot<
  TStatement extends ProjectionPreparedStatementLike<TStatement>
>(input: {
  database: ProjectionDatabaseLike<TStatement>;
  projectId: string;
  projectVersion: number;
  snapshotId: string;
  manifestKey: string;
  manifestSha256: string;
  now: string;
}): Promise<boolean> {
  const targetExists =
    "EXISTS (SELECT 1 FROM projection_snapshots WHERE snapshot_id = ? " +
    "AND status IN ('ready', 'active'))";
  const statements = [
    input.database
      .prepare(
        `INSERT INTO projection_snapshots
         (snapshot_id, project_id, project_version, status, manifest_key,
          manifest_sha256, created_at)
         SELECT ?, ?, ?, 'ready', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM projects WHERE project_id = ? AND project_version = ?
         )
         ON CONFLICT(project_id, project_version) DO UPDATE SET
           status = 'ready', manifest_key = excluded.manifest_key,
           manifest_sha256 = excluded.manifest_sha256
         WHERE projection_snapshots.status NOT IN ('active', 'superseded')
           AND EXISTS (
             SELECT 1 FROM projects WHERE project_id = ? AND project_version = ?
           )`
      )
      .bind(
        input.snapshotId,
        input.projectId,
        input.projectVersion,
        input.manifestKey,
        input.manifestSha256,
        input.now,
        input.projectId,
        input.projectVersion,
        input.projectId,
        input.projectVersion
      ),
    input.database
      .prepare(
        `UPDATE projection_snapshots SET status = 'superseded'
         WHERE project_id = ? AND status = 'active' AND snapshot_id <> ?
           AND EXISTS (
             SELECT 1 FROM projects WHERE project_id = ? AND project_version = ?
           )
           AND ${targetExists}`
      )
      .bind(
        input.projectId,
        input.snapshotId,
        input.projectId,
        input.projectVersion,
        input.snapshotId
      ),
    input.database
      .prepare(
        `UPDATE projects SET active_snapshot_id = ?, updated_at = ?
         WHERE project_id = ? AND project_version = ? AND ${targetExists}`
      )
      .bind(
        input.snapshotId,
        input.now,
        input.projectId,
        input.projectVersion,
        input.snapshotId
      ),
    input.database
      .prepare(
        `UPDATE projection_snapshots SET status = 'active', activated_at = ?
         WHERE snapshot_id = ?
           AND EXISTS (
             SELECT 1 FROM projects
             WHERE project_id = ? AND project_version = ?
               AND active_snapshot_id = ?
           )`
      )
      .bind(
        input.now,
        input.snapshotId,
        input.projectId,
        input.projectVersion,
        input.snapshotId
      )
  ];
  const results = await input.database.batch(statements);
  return results[2]?.meta.changes === 1 && results[3]?.meta.changes === 1;
}

function staleResult(
  phase: "before-read" | "after-read" | "activation",
  snapshotId: string,
  expectedProjectVersion: number,
  observedProjectVersion: number | null,
  writeCount: number
): PublishProjectProjectionResult {
  return {
    status: "stale",
    phase,
    snapshotId,
    expectedProjectVersion,
    observedProjectVersion,
    writeCount
  };
}

function requirePublishInput(projectId: string, projectVersion: number): void {
  if (projectId.length === 0 || projectId.includes("\0")) {
    throw new Error("Project ID must be a nonempty string without null bytes.");
  }
  if (!Number.isSafeInteger(projectVersion) || projectVersion < 0) {
    throw new Error("Project version must be a nonnegative safe integer.");
  }
}
