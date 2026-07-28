import {
  GITHUB_SYNC_ERROR_CODES,
  GitHubSyncError,
  type GitHubSyncErrorCode
} from "./client";
import type {
  GitHubTreeManifestDescriptor,
  GitHubTreeManifestEntry
} from "./tree-manifest";
import {
  deferFailedPurgeClaim,
  purgeClaimedManifestEntries,
  type ManifestPurgeClaim
} from "./tree-manifest-purge";
import { sha256 } from "../security/crypto";

interface ManifestStateRow {
  manifest_id: string;
  project_id: string;
  repository_id: string;
  ref: string;
  observed_sha: string;
  tree_sha: string;
  repository_authority: string;
  collection_key: string;
  created_at: string;
  status: string;
  failure_code: string | null;
}

interface StoredEntryRow {
  path_digest: string;
  safe_path: string | null;
  blob_sha: string;
  byte_size: number;
  disposition: GitHubTreeManifestEntry["disposition"];
}

interface RetentionCandidateRow {
  manifest_id: string;
  project_id: string;
  repository_id: string;
  ref: string;
  observed_sha: string;
  tree_sha: string;
  repository_authority: "default_branch" | "tracked_ref";
  collection_key: string;
  created_at: string;
  status: "staging" | "failed" | "purging";
  retention_version: number;
  retention_attempt: number;
  purge_lease_until: string | null;
  eligible: number;
}

type RetentionCursorLane = "staging" | "failed";

interface RetentionCursorRow {
  lane: RetentionCursorLane;
  after_project_id: string;
  after_manifest_id: string;
  cursor_version: number;
}

export interface GitHubTreeManifestRetentionResult {
  failedStaging: number;
  claimed: number;
  entriesDeleted: number;
  purged: number;
  errors: number;
}

export interface GitHubTreeManifestRetentionOptions {
  maxPerState?: number;
  maxChunksPerManifest?: number;
  purgeLeaseMilliseconds?: number;
}

export type GitHubTreeManifestFailureResult =
  | "failed"
  | "already_failed"
  | "complete";

const ENTRY_PAGE_SIZE = 500;
const RETENTION_MAX_PER_STATE = 25;
const RETENTION_PROJECT_QUOTA = 2;
const RETENTION_SCAN_MULTIPLIER = 4;
const RETENTION_MAX_SCAN_ROWS =
  RETENTION_MAX_PER_STATE * RETENTION_SCAN_MULTIPLIER;
const RETENTION_MAX_CHUNKS_PER_MANIFEST = 4;
const RETENTION_PURGE_LEASE_MILLISECONDS = 10 * 60 * 1_000;
const RETENTION_MAX_PURGE_LEASE_MILLISECONDS = 30 * 60 * 1_000;
const FAILED_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const GITHUB_SYNC_ERROR_CODE_SET = new Set<string>(GITHUB_SYNC_ERROR_CODES);

export async function failGitHubTreeManifest(
  database: D1Database,
  descriptor: GitHubTreeManifestDescriptor,
  failureCode: GitHubSyncErrorCode
): Promise<GitHubTreeManifestFailureResult> {
  if (!GITHUB_SYNC_ERROR_CODE_SET.has(failureCode)) {
    throw reconciliationRequired();
  }
  const manifest = await readManifestState(
    database,
    descriptor.projectId,
    descriptor.manifestId
  );
  if (manifest === null || !sameManifestIdentity(manifest, descriptor)) {
    throw reconciliationRequired();
  }
  if (manifest.status === "complete") {
    return "complete";
  }
  if (
    manifest.status === "failed" ||
    manifest.status === "purging" ||
    manifest.status === "purged"
  ) {
    if (
      manifest.failure_code === null ||
      !GITHUB_SYNC_ERROR_CODE_SET.has(manifest.failure_code)
    ) {
      throw reconciliationRequired();
    }
    return "already_failed";
  }
  if (manifest.status !== "staging") {
    throw reconciliationRequired();
  }

  const entries = await readManifestEntries(
    database,
    descriptor.projectId,
    descriptor.manifestId
  );
  const checksum = await entriesChecksum(entries);
  const eventId = await sha256(
    [
      "github.tree.manifest.lifecycle",
      descriptor.projectId,
      descriptor.manifestId,
      "failed"
    ].join("\n")
  );
  const requestDigest = await sha256(
    [
      descriptor.projectId,
      descriptor.manifestId,
      failureCode,
      String(entries.length),
      checksum
    ].join("\n")
  );
  try {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE github_tree_manifests
           SET status = 'failed', entry_count = ?, entries_checksum = ?,
               failed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               failure_code = ?
           WHERE project_id = ? AND manifest_id = ? AND status = 'staging'`
        )
        .bind(
          entries.length,
          checksum,
          failureCode,
          descriptor.projectId,
          descriptor.manifestId
        ),
      database
        .prepare(
          `INSERT INTO github_tree_manifest_lifecycle_events
           (event_id, project_id, manifest_id, retention_version, event_type,
            failure_code, entry_count, entries_checksum, request_digest,
            recorded_at)
           SELECT ?, manifest.project_id, manifest.manifest_id,
                  manifest.retention_version, 'failed', manifest.failure_code,
                  manifest.entry_count, manifest.entries_checksum, ?,
                  manifest.failed_at
           FROM github_tree_manifests AS manifest
           WHERE manifest.project_id = ? AND manifest.manifest_id = ?
             AND manifest.status = 'failed'`
        )
        .bind(
          eventId,
          requestDigest,
          descriptor.projectId,
          descriptor.manifestId
        )
    ]);
    if (
      (results[0]?.meta.changes ?? 0) === 1 &&
      (results[1]?.meta.changes ?? 0) === 1
    ) {
      return "failed";
    }
  } catch {
    const raced = await readManifestState(
      database,
      descriptor.projectId,
      descriptor.manifestId
    );
    if (
      raced !== null &&
      sameManifestIdentity(raced, descriptor) &&
      (raced.status === "failed" ||
        raced.status === "purging" ||
        raced.status === "purged")
    ) {
      return "already_failed";
    }
    throw reconciliationRequired();
  }

  const current = await readManifestState(
    database,
    descriptor.projectId,
    descriptor.manifestId
  );
  if (current?.status === "complete") {
    return "complete";
  }
  if (
    current !== null &&
    sameManifestIdentity(current, descriptor) &&
    (current.status === "failed" ||
      current.status === "purging" ||
      current.status === "purged") &&
    current.failure_code !== null &&
    GITHUB_SYNC_ERROR_CODE_SET.has(current.failure_code)
  ) {
    return "already_failed";
  }
  throw reconciliationRequired();
}

export async function maintainGitHubTreeManifestRetention(
  database: D1Database,
  scheduledTime: number,
  options: GitHubTreeManifestRetentionOptions = {}
): Promise<GitHubTreeManifestRetentionResult> {
  if (!Number.isFinite(scheduledTime)) {
    throw reconciliationRequired();
  }
  const scheduledAt = new Date(scheduledTime).toISOString();
  const maxPerState = requireBoundedInteger(
    options.maxPerState ?? RETENTION_MAX_PER_STATE,
    1,
    RETENTION_MAX_PER_STATE
  );
  const maxChunksPerManifest = requireBoundedInteger(
    options.maxChunksPerManifest ?? RETENTION_MAX_CHUNKS_PER_MANIFEST,
    1,
    RETENTION_MAX_CHUNKS_PER_MANIFEST
  );
  const purgeLeaseMilliseconds = requireBoundedInteger(
    options.purgeLeaseMilliseconds ?? RETENTION_PURGE_LEASE_MILLISECONDS,
    1,
    RETENTION_MAX_PURGE_LEASE_MILLISECONDS
  );
  const result: GitHubTreeManifestRetentionResult = {
    failedStaging: 0,
    claimed: 0,
    entriesDeleted: 0,
    purged: 0,
    errors: 0
  };

  const stagingCursor = await readRetentionCursor(database, "staging");
  const stagingScan = await loadRetentionCandidates(
    database,
    "staging",
    stagingCursor,
    scheduledAt,
    maxPerState
  );
  await advanceRetentionCursor(
    database,
    stagingCursor,
    stagingScan.cursorCandidate
  );
  for (const candidate of stagingScan.candidates) {
    try {
      const failure = await failGitHubTreeManifest(
        database,
        retentionDescriptor(candidate),
        "GITHUB_RECONCILIATION_REQUIRED"
      );
      if (failure === "failed") {
        result.failedStaging += 1;
      }
    } catch {
      result.errors += 1;
    }
  }

  const cutoffAt = new Date(
    scheduledTime - FAILED_RETENTION_MILLISECONDS
  ).toISOString();
  const failedCursor = await readRetentionCursor(database, "failed");
  const failedScan = await loadRetentionCandidates(
    database,
    "failed",
    failedCursor,
    cutoffAt,
    maxPerState
  );
  await advanceRetentionCursor(
    database,
    failedCursor,
    failedScan.cursorCandidate
  );
  for (const candidate of failedScan.candidates) {
    let claim: ManifestPurgeClaim | null = null;
    try {
      claim = await claimFailedManifest(
        database,
        candidate,
        cutoffAt,
        scheduledAt,
        purgeLeaseMilliseconds
      );
      if (claim === null) {
        continue;
      }
      result.claimed += 1;
      const purge = await purgeClaimedManifestEntries(
        database,
        claim,
        maxChunksPerManifest
      );
      result.entriesDeleted += purge.entriesDeleted;
      if (purge.purged) {
        result.purged += 1;
      }
    } catch {
      if (claim !== null) {
        await deferFailedPurgeClaim(database, claim).catch(() => undefined);
      }
      result.errors += 1;
    }
  }
  return result;
}

async function loadRetentionCandidates(
  database: D1Database,
  lane: RetentionCursorLane,
  cursor: RetentionCursorRow,
  eligibilityCutoff: string,
  maxCandidates: number
): Promise<{
  candidates: RetentionCandidateRow[];
  cursorCandidate: RetentionCandidateRow | undefined;
}> {
  const scanLimit = Math.min(
    RETENTION_MAX_SCAN_ROWS,
    maxCandidates * RETENTION_SCAN_MULTIPLIER
  );
  const afterCursor = await readRetentionCandidatePage(
    database,
    lane,
    eligibilityCutoff,
    cursor.after_project_id,
    cursor.after_manifest_id,
    null,
    scanLimit
  );
  const scanned = [...afterCursor];
  const remaining = scanLimit - scanned.length;
  if (remaining > 0 && cursor.after_project_id !== "") {
    scanned.push(
      ...(await readRetentionCandidatePage(
        database,
        lane,
        eligibilityCutoff,
        "",
        "",
        {
          projectId: cursor.after_project_id,
          manifestId: cursor.after_manifest_id
        },
        remaining
      ))
    );
  }
  if (scanned.length > scanLimit) {
    throw reconciliationRequired();
  }

  const projectCounts = new Map<string, number>();
  const candidates: RetentionCandidateRow[] = [];
  let cursorCandidate: RetentionCandidateRow | undefined;
  for (const candidate of scanned) {
    cursorCandidate = candidate;
    if (candidate.eligible !== 1) {
      continue;
    }
    const projectCount = projectCounts.get(candidate.project_id) ?? 0;
    if (projectCount >= RETENTION_PROJECT_QUOTA) {
      continue;
    }
    projectCounts.set(candidate.project_id, projectCount + 1);
    candidates.push(candidate);
    if (candidates.length === maxCandidates) {
      break;
    }
  }
  return { candidates, cursorCandidate };
}

async function readRetentionCandidatePage(
  database: D1Database,
  lane: RetentionCursorLane,
  eligibilityCutoff: string,
  afterProjectId: string,
  afterManifestId: string,
  upperBound: { projectId: string; manifestId: string } | null,
  limit: number
): Promise<RetentionCandidateRow[]> {
  const staging = lane === "staging";
  const indexName = staging
    ? "github_tree_manifests_staging_keyset"
    : "github_tree_manifests_failed_keyset";
  const statusPredicate = staging
    ? "manifest.status = 'staging'"
    : "manifest.status IN ('failed', 'purging')";
  const eligibility = staging
    ? `EXISTS (
         SELECT 1 FROM projects AS project
         WHERE project.project_id = manifest.project_id
           AND project.project_ref NOT GLOB 'system.synthetic.*'
       )
       AND julianday(manifest.created_at) <= julianday(?)
       AND NOT EXISTS (
         SELECT 1 FROM github_repository_sync_runs AS sync_run
         WHERE sync_run.project_id = manifest.project_id
           AND sync_run.repository_id = manifest.repository_id
           AND sync_run.scheduled_for = manifest.collection_key
           AND sync_run.status = 'running'
           AND julianday(sync_run.lease_expires_at) > julianday(?)
       )`
    : `EXISTS (
         SELECT 1 FROM projects AS project
         WHERE project.project_id = manifest.project_id
           AND project.project_ref NOT GLOB 'system.synthetic.*'
       )
       AND julianday(manifest.failed_at) <= julianday(?)
       AND (
         manifest.retention_next_attempt_at IS NULL
         OR julianday(manifest.retention_next_attempt_at) <= julianday('now')
       )
       AND (
         manifest.status = 'failed'
         OR julianday(manifest.purge_lease_until) <= julianday('now')
       )
       AND NOT EXISTS (
         SELECT 1 FROM github_tree_ref_heads AS head
         WHERE head.project_id = manifest.project_id
           AND head.manifest_id = manifest.manifest_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM github_tree_manifest_deltas AS delta
         WHERE delta.project_id = manifest.project_id
           AND (
             delta.old_manifest_id = manifest.manifest_id
             OR delta.new_manifest_id = manifest.manifest_id
           )
       )`;
  const upperBoundSql = upperBound === null
    ? ""
    : "AND (manifest.project_id, manifest.manifest_id) <= (?, ?)";
  const statement = database.withSession("first-primary").prepare(
    `SELECT manifest.manifest_id, manifest.project_id,
            manifest.repository_id, manifest.ref, manifest.observed_sha,
            manifest.tree_sha, manifest.repository_authority,
            manifest.collection_key, manifest.created_at, manifest.status,
            manifest.retention_version, manifest.retention_attempt,
            manifest.purge_lease_until,
            CASE WHEN ${eligibility} THEN 1 ELSE 0 END AS eligible
     FROM github_tree_manifests AS manifest INDEXED BY ${indexName}
     WHERE ${statusPredicate}
       AND (manifest.project_id, manifest.manifest_id) > (?, ?)
       ${upperBoundSql}
     ORDER BY manifest.project_id, manifest.manifest_id
     LIMIT ?`
  );
  const eligibilityBindings = staging
    ? [eligibilityCutoff, eligibilityCutoff]
    : [eligibilityCutoff];
  const rangeBindings = upperBound === null
    ? [afterProjectId, afterManifestId]
    : [
        afterProjectId,
        afterManifestId,
        upperBound.projectId,
        upperBound.manifestId
      ];
  const page = await statement
    .bind(...eligibilityBindings, ...rangeBindings, limit)
    .all<RetentionCandidateRow>();
  if (page.results.length > limit) {
    throw reconciliationRequired();
  }
  const seen = new Set<string>();
  for (const row of page.results) {
    const expectedStatus = staging
      ? row.status === "staging"
      : row.status === "failed" || row.status === "purging";
    if (
      !expectedStatus ||
      (row.eligible !== 0 && row.eligible !== 1) ||
      seen.has(row.manifest_id)
    ) {
      throw reconciliationRequired();
    }
    seen.add(row.manifest_id);
  }
  return page.results;
}

async function readRetentionCursor(
  database: D1Database,
  lane: RetentionCursorLane
): Promise<RetentionCursorRow> {
  const cursor = await database
    .withSession("first-primary")
    .prepare(
      `SELECT lane, after_project_id, after_manifest_id, cursor_version
       FROM github_tree_manifest_retention_cursors
       WHERE lane = ?`
    )
    .bind(lane)
    .first<RetentionCursorRow>();
  if (
    cursor === null ||
    cursor.lane !== lane ||
    typeof cursor.after_project_id !== "string" ||
    typeof cursor.after_manifest_id !== "string" ||
    !Number.isSafeInteger(cursor.cursor_version) ||
    cursor.cursor_version < 0 ||
    cursor.cursor_version >= Number.MAX_SAFE_INTEGER ||
    ((cursor.after_project_id === "") !==
      (cursor.after_manifest_id === "")) ||
    (cursor.after_manifest_id !== "" &&
      !/^[0-9a-f]{64}$/u.test(cursor.after_manifest_id))
  ) {
    throw reconciliationRequired();
  }
  return cursor;
}

async function advanceRetentionCursor(
  database: D1Database,
  cursor: RetentionCursorRow,
  candidate: RetentionCandidateRow | undefined
): Promise<void> {
  if (candidate === undefined) {
    return;
  }
  const update = await database
    .prepare(
      `UPDATE github_tree_manifest_retention_cursors
       SET after_project_id = ?, after_manifest_id = ?,
           cursor_version = cursor_version + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE lane = ? AND cursor_version = ?
         AND after_project_id = ? AND after_manifest_id = ?`
    )
    .bind(
      candidate.project_id,
      candidate.manifest_id,
      cursor.lane,
      cursor.cursor_version,
      cursor.after_project_id,
      cursor.after_manifest_id
    )
    .run();
  const changes = update.meta.changes ?? 0;
  if (changes !== 0 && changes !== 1) {
    throw reconciliationRequired();
  }
}

async function claimFailedManifest(
  database: D1Database,
  candidate: RetentionCandidateRow,
  cutoffAt: string,
  scheduledAt: string,
  purgeLeaseMilliseconds: number
): Promise<ManifestPurgeClaim | null> {
  if (
    !Number.isSafeInteger(candidate.retention_version) ||
    candidate.retention_version < 0 ||
    candidate.retention_version >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(candidate.retention_attempt) ||
    candidate.retention_attempt < 0 ||
    candidate.retention_attempt >= Number.MAX_SAFE_INTEGER
  ) {
    throw reconciliationRequired();
  }
  const claimedAt = new Date().toISOString();
  const purgeLeaseModifier = `+${purgeLeaseMilliseconds / 1_000} seconds`;
  const retentionVersion = candidate.retention_version + 1;
  const retentionAttempt = candidate.retention_attempt + 1;
  const purgeToken = await sha256(
    [
      "github.tree.manifest.purge",
      candidate.project_id,
      candidate.manifest_id,
      String(retentionVersion),
      scheduledAt,
      claimedAt
    ].join("\n")
  );
  const claim = await database
    .prepare(
      `UPDATE github_tree_manifests
       SET status = 'purging', retention_version = retention_version + 1,
           retention_attempt = retention_attempt + 1,
           retention_next_attempt_at = strftime(
             '%Y-%m-%dT%H:%M:%fZ', 'now', ?
           ), purge_token = ?,
           purge_lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
       WHERE project_id = ? AND manifest_id = ?
         AND status = ? AND retention_version = ?
         AND retention_attempt = ?
         AND julianday(failed_at) <= julianday(?)
         AND (
           retention_next_attempt_at IS NULL
           OR julianday(retention_next_attempt_at) <= julianday('now')
         )
         AND (
           status = 'failed'
           OR julianday(purge_lease_until) <= julianday('now')
         )
         AND EXISTS (
           SELECT 1 FROM projects AS project
           WHERE project.project_id = github_tree_manifests.project_id
             AND project.project_ref NOT GLOB 'system.synthetic.*'
         )
         AND NOT EXISTS (
           SELECT 1 FROM github_tree_ref_heads AS head
           WHERE head.project_id = github_tree_manifests.project_id
             AND head.manifest_id = github_tree_manifests.manifest_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM github_tree_manifest_deltas AS delta
           WHERE delta.project_id = github_tree_manifests.project_id
             AND (
               delta.old_manifest_id = github_tree_manifests.manifest_id
               OR delta.new_manifest_id = github_tree_manifests.manifest_id
             )
         )`
    )
    .bind(
      purgeLeaseModifier,
      purgeToken,
      purgeLeaseModifier,
      candidate.project_id,
      candidate.manifest_id,
      candidate.status,
      candidate.retention_version,
      candidate.retention_attempt,
      cutoffAt
    )
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    return null;
  }
  return {
    projectId: candidate.project_id,
    manifestId: candidate.manifest_id,
    purgeToken,
    retentionVersion,
    retentionAttempt
  };
}

async function readManifestState(
  database: D1Database,
  projectId: string,
  manifestId: string
): Promise<ManifestStateRow | null> {
  return await database
    .withSession("first-primary")
    .prepare(
      `SELECT manifest_id, project_id, repository_id, ref, observed_sha,
              tree_sha, repository_authority, collection_key, created_at,
              status, failure_code
       FROM github_tree_manifests
       WHERE project_id = ? AND manifest_id = ?`
    )
    .bind(projectId, manifestId)
    .first<ManifestStateRow>();
}

async function readManifestEntries(
  database: D1Database,
  projectId: string,
  manifestId: string
): Promise<StoredEntryRow[]> {
  const entries: StoredEntryRow[] = [];
  let afterPathDigest = "";
  while (true) {
    const page = await database
      .withSession("first-primary")
      .prepare(
        `SELECT path_digest, safe_path, blob_sha, byte_size, disposition
         FROM github_tree_manifest_entries
         WHERE project_id = ? AND manifest_id = ? AND path_digest > ?
         ORDER BY path_digest
         LIMIT ?`
      )
      .bind(projectId, manifestId, afterPathDigest, ENTRY_PAGE_SIZE)
      .all<StoredEntryRow>();
    entries.push(...page.results);
    if (page.results.length < ENTRY_PAGE_SIZE) {
      break;
    }
    const last = page.results.at(-1);
    if (last === undefined || last.path_digest <= afterPathDigest) {
      throw reconciliationRequired();
    }
    afterPathDigest = last.path_digest;
  }
  return entries;
}

async function entriesChecksum(entries: readonly StoredEntryRow[]): Promise<string> {
  return await sha256(
    entries
      .map((entry) =>
        JSON.stringify([
          entry.path_digest,
          entry.safe_path,
          entry.blob_sha,
          entry.byte_size,
          entry.disposition
        ])
      )
      .join("\n")
  );
}

function retentionDescriptor(
  row: RetentionCandidateRow
): GitHubTreeManifestDescriptor {
  return {
    manifestId: row.manifest_id,
    projectId: row.project_id,
    repositoryId: row.repository_id,
    ref: row.ref,
    observedSha: row.observed_sha,
    treeSha: row.tree_sha,
    repositoryAuthority: row.repository_authority,
    collectionKey: row.collection_key,
    createdAt: row.created_at
  };
}

function sameManifestIdentity(
  row: ManifestStateRow,
  descriptor: GitHubTreeManifestDescriptor
): boolean {
  return (
    row.manifest_id === descriptor.manifestId &&
    row.project_id === descriptor.projectId &&
    row.repository_id === descriptor.repositoryId &&
    row.ref === descriptor.ref &&
    row.observed_sha === descriptor.observedSha &&
    row.tree_sha === descriptor.treeSha &&
    row.repository_authority === descriptor.repositoryAuthority &&
    row.collection_key === descriptor.collectionKey &&
    row.created_at === descriptor.createdAt
  );
}

function requireBoundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw reconciliationRequired();
  }
  return value;
}

function reconciliationRequired(): GitHubSyncError {
  return new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
}
