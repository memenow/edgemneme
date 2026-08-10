import type { AuthenticatedPrincipal } from "../security/auth";
import {
  hierarchicalMemoryAccessPredicate,
  requireProjectRole
} from "../security/auth";
import type { GatewayEnv } from "./types";
import { EdgeMnemeError } from "../contracts/errors";
import { pathSegment } from "../projection/markdown";
import { sha256 } from "../security/crypto";

interface ActiveSnapshotRow {
  snapshot_id: string;
  project_version: number;
  manifest_key: string;
  manifest_sha256: string;
}

interface ProjectionManifest {
  schema_version: number;
  project_id: string;
  project_version: number;
  snapshot_id: string;
  files: Array<{ key: string; sha256: string }>;
}

export async function readGatewayResource(
  env: GatewayEnv,
  principal: AuthenticatedPrincipal,
  uri: URL,
  values: Record<string, string>
): Promise<string> {
  const path = uri.pathname;
  if (path.endsWith("/manifest")) {
    await requireProjectResourceRole(env.MEMORY_DB, principal);
    return readProjectionFile(env, principal.projectId, null);
  }
  if (values.kind !== undefined || values.memory_class !== undefined) {
    await requireProjectResourceRole(env.MEMORY_DB, principal);
    const category = values.kind === undefined ? "class" : "kind";
    const value = values.kind ?? values.memory_class ?? "";
    return readProjectionFile(
      env,
      principal.projectId,
      `indexes/by-${category}/${pathSegment(value)}/index.json`
    );
  }
  const memoryId = values.memory_id;
  if (memoryId !== undefined) {
    return readMemoryResource(env.MEMORY_DB, principal, memoryId, values.version);
  }
  const resourceQueries: Record<string, { id: string | undefined; sql: string }> = {
    candidates: {
      id: values.candidate_id,
      sql:
        "SELECT observation_id, candidate_version, status, review_reason, created_at, updated_at " +
        "FROM observations WHERE project_id = ? AND observation_id = ?"
    },
    evidence: {
      id: values.evidence_id,
      sql:
        "SELECT evidence_id, source_type, locator, repository_id, commit_sha, excerpt_hash, " +
        "sensitivity_status, recorded_at, repository_ref, repository_path, object_uri " +
        "FROM evidence WHERE project_id = ? AND evidence_id = ?"
    },
    workflows: {
      id: values.workflow_id,
      sql:
        "SELECT workflow_id, root_workflow_id, workflow_type, status, attempt, last_error_code, " +
        "created_at, updated_at FROM workflow_runs WHERE project_id = ? " +
        "AND (workflow_id = ? OR root_workflow_id = ?) " +
        "ORDER BY updated_at DESC, workflow_id DESC LIMIT 1"
    },
    audit: {
      id: values.audit_id,
      sql:
        "SELECT audit_id, sequence, event_type, actor_principal_id, request_digest, " +
        "previous_event_hash, event_hash, recorded_at FROM audit_events " +
        "WHERE project_id = ? AND audit_id = ?"
    }
  };
  for (const [segment, resource] of Object.entries(resourceQueries)) {
    if (path.includes(`/${segment}/`) && resource.id !== undefined) {
      await requireProjectResourceRole(env.MEMORY_DB, principal);
      const bindings =
        segment === "workflows"
          ? [principal.projectId, resource.id, resource.id]
          : [principal.projectId, resource.id];
      const row = await env.MEMORY_DB.prepare(resource.sql)
        .bind(...bindings)
        .first<Record<string, unknown>>();
      if (row === null) {
        unavailable();
      }
      if (segment === "evidence") {
        return serializeEvidenceResource(row);
      }
      return JSON.stringify(row, null, 2);
    }
  }
  return unavailable();
}

async function readMemoryResource(
  database: D1Database,
  principal: AuthenticatedPrincipal,
  memoryId: string,
  version: string | undefined
): Promise<string> {
  const versionNumber = version === undefined ? null : Number(version);
  if (
    version !== undefined &&
    (!Number.isSafeInteger(versionNumber) || Number(versionNumber) < 1)
  ) {
    return unavailable();
  }
  const versionClause = version === undefined ? "" : "AND v.memory_version = ?";
  const row = await database.withSession("first-primary").prepare(
    `SELECT m.memory_id, ${version === undefined ? "m" : "v"}.memory_version,
            m.kind, m.memory_class, m.scope, m.scope_id, m.status,
            v.revision_id, v.content, v.content_sha256, v.valid_from, v.valid_until
     FROM memories m
     JOIN memory_versions v ON v.project_id = m.project_id AND v.memory_id = m.memory_id
     WHERE m.project_id = ? AND m.memory_id = ? ${versionClause}
       ${version === undefined ? "AND v.revision_id = m.current_revision_id" : ""}
       AND EXISTS (
         SELECT 1 FROM project_grants grant_row
         WHERE grant_row.project_id = m.project_id
           AND grant_row.principal_id = ? AND grant_row.revoked_at IS NULL
           AND CASE grant_row.role
             WHEN 'maintainer' THEN 2
             WHEN 'writer' THEN 1
             WHEN 'reader' THEN 0
             ELSE -1
           END >= 0
           AND ${hierarchicalMemoryAccessPredicate("grant_row", "m")}
       )`
  )
    .bind(
      principal.projectId,
      memoryId,
      ...(versionNumber === null ? [] : [versionNumber]),
      principal.principalId
    )
    .first<Record<string, unknown>>();
  if (row === null) {
    return unavailable();
  }
  return JSON.stringify(row, null, 2);
}

async function requireProjectResourceRole(
  database: D1Database,
  principal: AuthenticatedPrincipal
): Promise<void> {
  try {
    await requireProjectRole(database, principal, "reader");
  } catch (error) {
    if (error instanceof EdgeMnemeError && error.code === "PROJECT_UNAVAILABLE") {
      return unavailable();
    }
    throw error;
  }
}

async function readProjectionFile(
  env: GatewayEnv,
  projectId: string,
  relativeKey: string | null
): Promise<string> {
  const snapshot = await env.MEMORY_DB.prepare(
    `SELECT ps.snapshot_id, ps.project_version, ps.manifest_key, ps.manifest_sha256
     FROM projects p JOIN projection_snapshots ps ON ps.snapshot_id = p.active_snapshot_id
     WHERE p.project_id = ? AND ps.project_id = p.project_id AND ps.status = 'active'`
  )
    .bind(projectId)
    .first<ActiveSnapshotRow>();
  if (snapshot === null) {
    return unavailable();
  }
  const snapshotSegment = requireCanonicalSnapshotPointer(projectId, snapshot);
  const manifestBody = await readCheckedObject(
    env.PROJECTIONS,
    snapshot.manifest_key,
    snapshot.manifest_sha256
  );
  const prefix =
    `projects/${pathSegment(projectId)}/projections/` +
    `${pathSegment(snapshotSegment)}/`;
  const manifest = parseProjectionManifest(
    manifestBody,
    projectId,
    snapshot,
    snapshotSegment,
    prefix
  );
  if (relativeKey === null) {
    return manifestBody;
  }
  const key = `${prefix}${relativeKey}`;
  const entry = manifest.files.find(
    (file) => file.key === key && /^[a-f0-9]{64}$/u.test(file.sha256)
  );
  if (entry === undefined) {
    return unavailable();
  }
  return readCheckedObject(env.PROJECTIONS, entry.key, entry.sha256);
}

function serializeEvidenceResource(row: Record<string, unknown>): string {
  if (
    typeof row.evidence_id !== "string" ||
    typeof row.sensitivity_status !== "string" ||
    typeof row.recorded_at !== "string"
  ) {
    return unavailable();
  }
  if (row.sensitivity_status === "clear") {
    return JSON.stringify(row, null, 2);
  }
  if (
    row.sensitivity_status !== "quarantined" &&
    row.sensitivity_status !== "tombstone"
  ) {
    return unavailable();
  }
  return JSON.stringify(
    {
      evidence_id: row.evidence_id,
      sensitivity_status: row.sensitivity_status,
      recorded_at: row.recorded_at
    },
    null,
    2
  );
}

function requireCanonicalSnapshotPointer(
  projectId: string,
  snapshot: ActiveSnapshotRow
): string {
  if (
    !Number.isSafeInteger(snapshot.project_version) ||
    snapshot.project_version < 0 ||
    !/^[a-f0-9]{64}$/u.test(snapshot.manifest_sha256)
  ) {
    return unavailable();
  }
  const snapshotSegment = String(snapshot.project_version);
  const expectedSnapshotId = `${projectId}:${snapshotSegment}`;
  const expectedManifestKey =
    `projects/${pathSegment(projectId)}/projections/` +
    `${pathSegment(snapshotSegment)}/manifest.json`;
  if (
    snapshot.snapshot_id !== expectedSnapshotId ||
    snapshot.manifest_key !== expectedManifestKey
  ) {
    return unavailable();
  }
  return snapshotSegment;
}

function parseProjectionManifest(
  body: string,
  projectId: string,
  snapshot: ActiveSnapshotRow,
  snapshotSegment: string,
  prefix: string
): ProjectionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unavailable();
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unavailable();
  }
  const manifest = parsed as Partial<ProjectionManifest>;
  if (
    manifest.schema_version !== 1 ||
    manifest.project_id !== projectId ||
    manifest.project_version !== snapshot.project_version ||
    manifest.snapshot_id !== snapshotSegment ||
    !Array.isArray(manifest.files)
  ) {
    return unavailable();
  }
  const keys = new Set<string>();
  for (const file of manifest.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.key !== "string" ||
      !isCanonicalProjectionFileKey(file.key, prefix) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      keys.has(file.key)
    ) {
      return unavailable();
    }
    keys.add(file.key);
  }
  return manifest as ProjectionManifest;
}

function isCanonicalProjectionFileKey(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix) || key === `${prefix}manifest.json`) {
    return false;
  }
  const segments = key.slice(prefix.length).split("/");
  return segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !segment.includes("\\") &&
      !segment.includes("\0")
  );
}

async function readCheckedObject(
  bucket: R2Bucket,
  key: string,
  expectedSha256: string
): Promise<string> {
  const object = await bucket.get(key);
  if (object === null) {
    return unavailable();
  }
  const body = await object.text();
  if (
    object.customMetadata?.sha256 !== expectedSha256 ||
    (await sha256(body)) !== expectedSha256
  ) {
    return unavailable();
  }
  return body;
}

function unavailable(): never {
  throw new EdgeMnemeError("RESOURCE_UNAVAILABLE", "The resource is unavailable.");
}
