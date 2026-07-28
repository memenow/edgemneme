import {
  GITHUB_SYNC_ERROR_CODES,
  GitHubSyncError,
  type GitHubSyncErrorCode
} from "./client";
import type { GitHubBlobDisposition } from "./content-policy";
import { sha256 } from "../security/crypto";
import {
  addedDeltaSql,
  changedDeltaSql,
  deletedDeltaSql,
  deletionEvidenceSql,
  deletionObservationEvidenceSql,
  deletionObservationSql,
  deletionReviewRequestSql
} from "./tree-manifest-sql";

export type GitHubTreeManifestDisposition =
  | GitHubBlobDisposition
  | "sensitive_tombstone";

export interface GitHubTreeManifestEntry {
  pathDigest: string;
  safePath: string | null;
  blobSha: string;
  byteSize: number;
  disposition: GitHubTreeManifestDisposition;
}

export interface GitHubTreeManifestDescriptor {
  manifestId: string;
  projectId: string;
  repositoryId: string;
  ref: string;
  observedSha: string;
  treeSha: string;
  repositoryAuthority: "default_branch" | "tracked_ref";
  collectionKey: string;
  createdAt: string;
}

export interface GitHubTreeHead {
  manifestId: string;
  observedSha: string;
}

interface StoredManifestRow {
  manifest_id: string;
  project_id: string;
  repository_id: string;
  ref: string;
  observed_sha: string;
  tree_sha: string;
  repository_authority: string;
  collection_key: string;
  status: string;
  entry_count: number | null;
  entries_checksum: string | null;
  failed_at: string | null;
  failure_code: string | null;
  purged_at: string | null;
}

interface StoredEntryRow {
  path_digest: string;
  safe_path: string | null;
  blob_sha: string;
  byte_size: number;
  disposition: string;
}

const ENTRY_BATCH_SIZE = 500;
const ENTRY_BATCH_BYTES = 256 * 1024;
const ENTRY_PAGE_SIZE = 500;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9A-Fa-f]{40,128}$/u;
const GITHUB_SYNC_ERROR_CODE_SET = new Set<string>(GITHUB_SYNC_ERROR_CODES);
const DISPOSITIONS = new Set<GitHubTreeManifestDisposition>([
  "text",
  "binary_excluded",
  "generated_excluded",
  "sensitive_tombstone",
  "partial"
]);

export async function buildGitHubTreeManifestDescriptor(input: {
  projectId: string;
  repositoryId: string;
  ref: string;
  observedSha: string;
  treeSha: string;
  repositoryAuthority: "default_branch" | "tracked_ref";
  collectionKey: string;
  createdAt: string;
}): Promise<GitHubTreeManifestDescriptor> {
  const manifestId = await sha256(
    [
      "github.tree.manifest",
      input.projectId,
      input.repositoryId,
      input.ref,
      input.observedSha,
      input.treeSha,
      input.collectionKey
    ].join("\n")
  );
  return { manifestId, ...input };
}

export async function beginGitHubTreeManifest(
  database: D1Database,
  descriptor: GitHubTreeManifestDescriptor
): Promise<"staging" | "complete"> {
  await database
    .prepare(
      `INSERT INTO github_tree_manifests
       (manifest_id, project_id, repository_id, ref, observed_sha, tree_sha,
        repository_authority, collection_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?)
       ON CONFLICT DO NOTHING`
    )
    .bind(
      descriptor.manifestId,
      descriptor.projectId,
      descriptor.repositoryId,
      descriptor.ref,
      descriptor.observedSha,
      descriptor.treeSha,
      descriptor.repositoryAuthority,
      descriptor.collectionKey,
      descriptor.createdAt
    )
    .run();
  const row = await readManifest(database, descriptor.manifestId, descriptor.projectId);
  if (row === null || !sameManifestIdentity(row, descriptor)) {
    throw reconciliationRequired();
  }
  if (row.status !== "staging" && row.status !== "complete") {
    throw storedManifestFailure(row);
  }
  return row.status;
}

export async function persistGitHubTreeManifestEntries(
  database: D1Database,
  descriptor: GitHubTreeManifestDescriptor,
  entries: readonly GitHubTreeManifestEntry[]
): Promise<void> {
  const normalized = normalizeEntries(entries);
  const manifest = await readManifest(
    database,
    descriptor.manifestId,
    descriptor.projectId
  );
  if (manifest === null || !sameManifestIdentity(manifest, descriptor)) {
    throw reconciliationRequired();
  }
  if (manifest.status === "complete") {
    await verifyCompletedManifest(database, descriptor, normalized, manifest);
    return;
  }
  if (manifest.status !== "staging") {
    throw storedManifestFailure(manifest);
  }
  for (const payload of buildEntryPayloads(normalized)) {
    await database
      .prepare(
        `INSERT INTO github_tree_manifest_entries
         (project_id, manifest_id, path_digest, safe_path, blob_sha,
          byte_size, disposition)
         SELECT ?, ?,
                json_extract(value, '$[0]'), json_extract(value, '$[1]'),
                json_extract(value, '$[2]'), json_extract(value, '$[3]'),
                json_extract(value, '$[4]')
         FROM json_each(?)
         WHERE 1
         ON CONFLICT(project_id, manifest_id, path_digest) DO NOTHING`
      )
      .bind(descriptor.projectId, descriptor.manifestId, payload)
      .run();
  }
}

function buildEntryPayloads(
  entries: readonly GitHubTreeManifestEntry[]
): string[] {
  const encoder = new TextEncoder();
  const payloads: string[] = [];
  let rows: string[] = [];
  let encodedBytes = 2;
  for (const entry of entries) {
    const row = JSON.stringify([
      entry.pathDigest,
      entry.safePath,
      entry.blobSha,
      entry.byteSize,
      entry.disposition
    ]);
    const rowBytes = encoder.encode(row).byteLength;
    if (rowBytes + 2 > ENTRY_BATCH_BYTES) {
      throw reconciliationRequired();
    }
    const delimiterBytes = rows.length === 0 ? 0 : 1;
    if (
      rows.length > 0 &&
      (rows.length >= ENTRY_BATCH_SIZE ||
        encodedBytes + delimiterBytes + rowBytes > ENTRY_BATCH_BYTES)
    ) {
      payloads.push(`[${rows.join(",")}]`);
      rows = [];
      encodedBytes = 2;
    }
    rows.push(row);
    encodedBytes += (rows.length === 1 ? 0 : 1) + rowBytes;
  }
  if (rows.length > 0) {
    payloads.push(`[${rows.join(",")}]`);
  }
  return payloads;
}

export async function completeGitHubTreeManifest(
  database: D1Database,
  descriptor: GitHubTreeManifestDescriptor,
  entries: readonly GitHubTreeManifestEntry[],
  completedAt: string
): Promise<{ entryCount: number; entriesChecksum: string }> {
  const normalized = normalizeEntries(entries);
  if (normalized.some((entry) => entry.disposition === "partial")) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  const expectedChecksum = await entriesChecksum(normalized);
  const manifest = await readManifest(
    database,
    descriptor.manifestId,
    descriptor.projectId
  );
  if (manifest === null || !sameManifestIdentity(manifest, descriptor)) {
    throw reconciliationRequired();
  }
  if (manifest.status === "complete") {
    await verifyCompletedManifest(database, descriptor, normalized, manifest);
    return {
      entryCount: normalized.length,
      entriesChecksum: expectedChecksum
    };
  }
  if (manifest.status !== "staging") {
    throw storedManifestFailure(manifest);
  }
  const stored = await readManifestEntries(database, descriptor);
  if (
    stored.length !== normalized.length ||
    (await entriesChecksum(stored)) !== expectedChecksum
  ) {
    throw reconciliationRequired();
  }
  const result = await database
    .prepare(
      `UPDATE github_tree_manifests
       SET status = 'complete', entry_count = ?, entries_checksum = ?, completed_at = ?
       WHERE project_id = ? AND manifest_id = ? AND status = 'staging'`
    )
    .bind(
      normalized.length,
      expectedChecksum,
      completedAt,
      descriptor.projectId,
      descriptor.manifestId
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    const completed = await readManifest(
      database,
      descriptor.manifestId,
      descriptor.projectId
    );
    if (completed === null) {
      throw reconciliationRequired();
    }
    await verifyCompletedManifest(database, descriptor, normalized, completed);
  }
  return {
    entryCount: normalized.length,
    entriesChecksum: expectedChecksum
  };
}

export async function activateGitHubTreeManifest(input: {
  database: D1Database;
  descriptor: GitHubTreeManifestDescriptor;
  expectedHead: GitHubTreeHead | null;
  expectedCursorObservedSha: string | null;
  scheduledTime: number;
  nextSyncAt: string;
  historyGapPossible: boolean;
  credentialStatus: "active" | "expiring";
  etag: string | null;
  syncEvent: {
    eventId: string;
    payloadDigest: string;
    payloadJson: string;
  };
  candidateStatements?: readonly D1PreparedStatement[];
}): Promise<void> {
  const {
    database,
    descriptor,
    expectedHead,
    historyGapPossible,
    credentialStatus,
    syncEvent
  } = input;
  const now = new Date().toISOString();
  const scheduledAt = new Date(input.scheduledTime).toISOString();
  const expectedManifestId = expectedHead?.manifestId ?? null;
  if (descriptor.repositoryAuthority === "tracked_ref") {
    const ownership = await database
      .withSession("first-primary")
      .prepare(
        `SELECT scope_id FROM canonical_repository_scope_ownership
         WHERE project_id = ? AND repository_id = ?
           AND scope_kind = 'ref' AND source_id = ?`
      )
      .bind(descriptor.projectId, descriptor.repositoryId, descriptor.ref)
      .first<{ scope_id: string }>();
    if (ownership === null) {
      throw reconciliationRequired();
    }
  }

  const statements: D1PreparedStatement[] = [
    database
      .prepare(addedDeltaSql())
      .bind(
        descriptor.manifestId,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        expectedManifestId,
        descriptor.manifestId,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        expectedManifestId,
        descriptor.manifestId,
        now,
        descriptor.projectId,
        descriptor.manifestId,
        expectedManifestId,
        expectedManifestId,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId
      )
  ];
  if (expectedManifestId !== null) {
    statements.push(
      database
        .prepare(changedDeltaSql())
        .bind(
          expectedManifestId,
          descriptor.manifestId,
          descriptor.projectId,
          descriptor.repositoryId,
          descriptor.ref,
          expectedManifestId,
          descriptor.manifestId,
          descriptor.projectId,
          descriptor.repositoryId,
          descriptor.ref,
          expectedManifestId,
          descriptor.manifestId,
          now,
          expectedManifestId,
          descriptor.projectId,
          descriptor.manifestId,
          descriptor.projectId,
          descriptor.repositoryId,
          descriptor.ref,
          descriptor.manifestId
        ),
      database
        .prepare(deletedDeltaSql())
        .bind(
          expectedManifestId,
          descriptor.manifestId,
          descriptor.projectId,
          descriptor.repositoryId,
          descriptor.ref,
          expectedManifestId,
          descriptor.manifestId,
          descriptor.projectId,
          descriptor.repositoryId,
          descriptor.ref,
          descriptor.projectId,
          descriptor.repositoryId,
          descriptor.ref,
          expectedManifestId,
          descriptor.manifestId,
          now,
          descriptor.manifestId,
          descriptor.projectId,
          expectedManifestId,
          descriptor.projectId,
          descriptor.repositoryId,
          descriptor.ref,
          descriptor.manifestId
        )
    );
  }
  statements.push(
    database
      .prepare(deletionEvidenceSql())
      .bind(
        now,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        descriptor.manifestId
      ),
    database
      .prepare(deletionObservationSql())
      .bind(
        now,
        now,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        descriptor.manifestId
      ),
    database
      .prepare(deletionObservationEvidenceSql())
      .bind(
        now,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        descriptor.manifestId
      ),
    database
      .prepare(deletionReviewRequestSql())
      .bind(
        now,
        now,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        descriptor.manifestId
      )
  );
  const headInsertionIndex = statements.length;
  statements.push(
    database
      .prepare(
        `INSERT INTO github_tree_ref_heads
         (project_id, repository_id, ref, manifest_id, head_version,
          activated_at, updated_at)
         SELECT ?, ?, ?, ?, 1, ?, ?
         FROM github_tree_manifests AS manifest
         WHERE manifest.project_id = ? AND manifest.manifest_id = ?
           AND manifest.status = 'complete'
           AND (
             (? IS NULL AND NOT EXISTS (
               SELECT 1 FROM github_tree_ref_heads AS current_head
               WHERE current_head.project_id = manifest.project_id
                 AND current_head.repository_id = manifest.repository_id
                 AND current_head.ref = manifest.ref
             ))
             OR EXISTS (
               SELECT 1 FROM github_tree_ref_heads AS current_head
               WHERE current_head.project_id = manifest.project_id
                 AND current_head.repository_id = manifest.repository_id
                 AND current_head.ref = manifest.ref
                 AND current_head.manifest_id IS ?
             )
           )
           AND (
             (? IS NULL AND NOT EXISTS (
               SELECT 1 FROM sync_cursors AS current_cursor
               WHERE current_cursor.project_id = manifest.project_id
                 AND current_cursor.repository_id = manifest.repository_id
                 AND current_cursor.ref = manifest.ref
             ))
             OR EXISTS (
               SELECT 1 FROM sync_cursors AS current_cursor
               WHERE current_cursor.project_id = manifest.project_id
                 AND current_cursor.repository_id = manifest.repository_id
                 AND current_cursor.ref = manifest.ref
                 AND current_cursor.observed_sha IS ?
             )
           )
         ON CONFLICT(project_id, repository_id, ref) DO UPDATE SET
           manifest_id = excluded.manifest_id,
           head_version = github_tree_ref_heads.head_version + 1,
           activated_at = excluded.activated_at,
           updated_at = excluded.updated_at
         WHERE github_tree_ref_heads.manifest_id IS ?`
      )
      .bind(
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        now,
        now,
        descriptor.projectId,
        descriptor.manifestId,
        expectedManifestId,
        expectedManifestId,
        input.expectedCursorObservedSha,
        input.expectedCursorObservedSha,
        expectedManifestId
      ),
    ...(input.candidateStatements ?? []),
    database
      .prepare(
        `INSERT INTO sync_cursors
         (project_id, repository_id, ref, observed_sha, status, last_sync_at,
          next_sync_at, history_gap_possible, credential_status, etag,
          last_error_code, updated_at)
         SELECT ?, ?, ?, ?, 'observed', ?, ?, ?, ?, ?, NULL, ?
         FROM github_tree_ref_heads AS head
         WHERE head.project_id = ? AND head.repository_id = ? AND head.ref = ?
           AND head.manifest_id = ?
         ON CONFLICT(project_id, repository_id, ref) DO UPDATE SET
           observed_sha = excluded.observed_sha,
           status = excluded.status,
           last_sync_at = excluded.last_sync_at,
           next_sync_at = excluded.next_sync_at,
           history_gap_possible = excluded.history_gap_possible,
           credential_status = excluded.credential_status,
           etag = excluded.etag,
           last_error_code = NULL,
           updated_at = excluded.updated_at
         WHERE sync_cursors.observed_sha IS ?`
      )
      .bind(
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.observedSha,
        scheduledAt,
        input.nextSyncAt,
        historyGapPossible ? 1 : 0,
        credentialStatus,
        input.etag,
        now,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        input.expectedCursorObservedSha
      ),
    database
      .prepare(
        `INSERT INTO outbox_events
         (event_id, project_id, project_version, event_type, payload_digest,
          payload_json, created_at)
         SELECT ?, project.project_id, project.project_version,
                'github.sync.requested', ?, ?, ?
         FROM projects AS project
         JOIN github_tree_ref_heads AS head
           ON head.project_id = project.project_id
          AND head.repository_id = ? AND head.ref = ?
          AND head.manifest_id = ?
         WHERE project.project_id = ?
         ON CONFLICT(event_id) DO NOTHING`
      )
      .bind(
        syncEvent.eventId,
        syncEvent.payloadDigest,
        syncEvent.payloadJson,
        now,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        descriptor.projectId
      )
  );
  const [headStatement] = statements.splice(headInsertionIndex, 1);
  if (headStatement === undefined) {
    throw reconciliationRequired();
  }
  statements.unshift(headStatement);
  const headStatementIndex = 0;
  const results = await database.batch(statements);
  const headResult = results[headStatementIndex];
  if ((headResult?.meta.changes ?? 0) !== 1) {
    const current = await readActiveHead(database, descriptor);
    if (current?.manifestId !== descriptor.manifestId) {
      throw reconciliationRequired();
    }
  }
  const committed = await database
    .withSession("first-primary")
    .prepare(
      `SELECT head.manifest_id, cursor.observed_sha
       FROM github_tree_ref_heads AS head
       JOIN sync_cursors AS cursor
         ON cursor.project_id = head.project_id
        AND cursor.repository_id = head.repository_id
        AND cursor.ref = head.ref
       WHERE head.project_id = ? AND head.repository_id = ? AND head.ref = ?`
    )
    .bind(descriptor.projectId, descriptor.repositoryId, descriptor.ref)
    .first<{ manifest_id: string; observed_sha: string | null }>();
  if (
    committed?.manifest_id !== descriptor.manifestId ||
    committed.observed_sha !== descriptor.observedSha
  ) {
    throw reconciliationRequired();
  }
}

export async function readActiveGitHubTreeHead(
  database: D1Database,
  projectId: string,
  repositoryId: string,
  ref: string
): Promise<GitHubTreeHead | null> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT head.manifest_id, manifest.observed_sha
       FROM github_tree_ref_heads AS head
       JOIN github_tree_manifests AS manifest
         ON manifest.project_id = head.project_id
        AND manifest.repository_id = head.repository_id
        AND manifest.ref = head.ref
        AND manifest.manifest_id = head.manifest_id
       WHERE head.project_id = ? AND head.repository_id = ? AND head.ref = ?
         AND manifest.status = 'complete'`
    )
    .bind(projectId, repositoryId, ref)
    .first<{ manifest_id: string; observed_sha: string }>();
  return row === null
    ? null
    : { manifestId: row.manifest_id, observedSha: row.observed_sha };
}

async function readActiveHead(
  database: D1Database,
  descriptor: GitHubTreeManifestDescriptor
): Promise<GitHubTreeHead | null> {
  return await readActiveGitHubTreeHead(
    database,
    descriptor.projectId,
    descriptor.repositoryId,
    descriptor.ref
  );
}

async function readManifest(
  database: D1Database,
  manifestId: string,
  projectId: string
): Promise<StoredManifestRow | null> {
  return await database
    .withSession("first-primary")
    .prepare(
      `SELECT manifest_id, project_id, repository_id, ref, observed_sha, tree_sha,
              repository_authority, collection_key, status, entry_count,
              entries_checksum, failed_at, failure_code, purged_at
       FROM github_tree_manifests
       WHERE project_id = ? AND manifest_id = ?`
    )
    .bind(projectId, manifestId)
    .first<StoredManifestRow>();
}

async function readManifestEntries(
  database: D1Database,
  descriptor: GitHubTreeManifestDescriptor
): Promise<GitHubTreeManifestEntry[]> {
  const entries: GitHubTreeManifestEntry[] = [];
  let after = "";
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
      .bind(
        descriptor.projectId,
        descriptor.manifestId,
        after,
        ENTRY_PAGE_SIZE
      )
      .all<StoredEntryRow>();
    for (const row of page.results) {
      if (!DISPOSITIONS.has(row.disposition as GitHubTreeManifestDisposition)) {
        throw reconciliationRequired();
      }
      entries.push({
        pathDigest: row.path_digest,
        safePath: row.safe_path,
        blobSha: row.blob_sha,
        byteSize: row.byte_size,
        disposition: row.disposition as GitHubTreeManifestDisposition
      });
    }
    if (page.results.length < ENTRY_PAGE_SIZE) {
      break;
    }
    const last = page.results.at(-1);
    if (last === undefined || last.path_digest <= after) {
      throw reconciliationRequired();
    }
    after = last.path_digest;
  }
  return normalizeEntries(entries);
}

async function verifyCompletedManifest(
  database: D1Database,
  descriptor: GitHubTreeManifestDescriptor,
  expectedEntries: readonly GitHubTreeManifestEntry[],
  manifest: StoredManifestRow
): Promise<void> {
  const stored = await readManifestEntries(database, descriptor);
  const expectedChecksum = await entriesChecksum(expectedEntries);
  if (
    manifest.status !== "complete" ||
    manifest.entry_count !== expectedEntries.length ||
    manifest.entries_checksum !== expectedChecksum ||
    stored.length !== expectedEntries.length ||
    (await entriesChecksum(stored)) !== expectedChecksum
  ) {
    throw reconciliationRequired();
  }
}

function normalizeEntries(
  entries: readonly GitHubTreeManifestEntry[]
): GitHubTreeManifestEntry[] {
  const normalized = entries.map((entry) => {
    if (
      !DIGEST_PATTERN.test(entry.pathDigest) ||
      !SHA_PATTERN.test(entry.blobSha) ||
      !Number.isSafeInteger(entry.byteSize) ||
      entry.byteSize < 0 ||
      !DISPOSITIONS.has(entry.disposition) ||
      (entry.safePath !== null &&
        (entry.safePath.length === 0 ||
          entry.safePath.startsWith("/") ||
          entry.safePath.includes("\0") ||
          entry.safePath.includes("\\"))) ||
      (entry.disposition === "sensitive_tombstone" && entry.safePath !== null)
    ) {
      throw reconciliationRequired();
    }
    return { ...entry };
  });
  normalized.sort((left, right) => left.pathDigest.localeCompare(right.pathDigest));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.pathDigest === normalized[index]?.pathDigest) {
      throw reconciliationRequired();
    }
  }
  return normalized;
}

async function entriesChecksum(
  entries: readonly GitHubTreeManifestEntry[]
): Promise<string> {
  return await sha256(
    normalizeEntries(entries)
      .map((entry) =>
        JSON.stringify([
          entry.pathDigest,
          entry.safePath,
          entry.blobSha,
          entry.byteSize,
          entry.disposition
        ])
      )
      .join("\n")
  );
}

function sameManifestIdentity(
  row: StoredManifestRow,
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
    row.collection_key === descriptor.collectionKey
  );
}

function reconciliationRequired(): GitHubSyncError {
  return new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
}

function storedManifestFailure(row: StoredManifestRow): GitHubSyncError {
  if (
    (row.status === "failed" || row.status === "purging" || row.status === "purged") &&
    row.failure_code !== null &&
    GITHUB_SYNC_ERROR_CODE_SET.has(row.failure_code)
  ) {
    return new GitHubSyncError(row.failure_code as GitHubSyncErrorCode);
  }
  return reconciliationRequired();
}
