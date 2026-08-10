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
  deletionReviewRequestSql,
  withdrawalEvidenceSql,
  withdrawalObservationEvidenceSql,
  withdrawalObservationSql,
  withdrawalReviewRequestSql,
  withdrawnDeltaSql
} from "./tree-manifest-sql";
import {
  pendingGitHubSyncActivationGuardBindings,
  pendingGitHubSyncActivationGuardSql,
  pendingGitHubSyncActivationPrestateGuardBindings,
  pendingGitHubSyncActivationPrestateGuardSql,
  type PendingGitHubSyncActivationFence
} from "./sync-activation-fence";

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
  headVersion: number;
}

export interface GitHubTreeManifestActivationClaim {
  runId: string;
  receiptId: string;
  activationToken: string;
  expectedExternalId: number;
  expectedOwnerExternalId: number;
  expectedOwner: string;
  expectedName: string;
  expectedDefaultBranch: string;
  expectedTrackedRefsJson: string;
  expectedRepositoryConfigurationVersion: number;
  expectedRepositoryUpdatedAt: string;
  expectedCursorStatus: string;
  expectedCursorUpdatedAt: string;
  expectedCursorVersion: number;
  expectedCursorObservedSha: string | null;
  fullReconciliation: boolean;
}

export async function createGitHubTreeManifestActivationAttempt(input: {
  runId: string;
  projectId: string;
  repositoryId: string;
  ref: string;
  manifestId: string;
}): Promise<{ receiptId: string; activationToken: string }> {
  const receiptId = await sha256(
    [
      "github.tree.activation.receipt",
      input.runId,
      input.projectId,
      input.repositoryId,
      input.ref,
      input.manifestId
    ].join("\n")
  );
  const activationToken = await sha256(
    [
      "github.tree.activation.attempt",
      receiptId,
      crypto.randomUUID()
    ].join("\n")
  );
  return { receiptId, activationToken };
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
  activationClaim: GitHubTreeManifestActivationClaim;
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
    activationClaim,
    historyGapPossible,
    credentialStatus,
    syncEvent
  } = input;
  if (!Number.isFinite(input.scheduledTime)) {
    throw reconciliationRequired();
  }
  const activationAt = new Date().toISOString();
  const scheduledAt = new Date(input.scheduledTime).toISOString();
  const parsedNextSyncAt = Date.parse(input.nextSyncAt);
  const expectedManifestId = expectedHead?.manifestId ?? null;
  const expectedHeadVersion = expectedHead?.headVersion ?? 0;
  const expectedReceiptId = await sha256(
    [
      "github.tree.activation.receipt",
      activationClaim.runId,
      descriptor.projectId,
      descriptor.repositoryId,
      descriptor.ref,
      descriptor.manifestId
    ].join("\n")
  );
  if (
    activationClaim.receiptId !== expectedReceiptId ||
    !DIGEST_PATTERN.test(activationClaim.activationToken) ||
    descriptor.collectionKey !== scheduledAt ||
    !Number.isFinite(parsedNextSyncAt) ||
    new Date(parsedNextSyncAt).toISOString() !== input.nextSyncAt ||
    syncEvent.payloadDigest !== (await sha256(syncEvent.payloadJson)) ||
    (expectedHead === null
      ? expectedHeadVersion !== 0
      : !Number.isSafeInteger(expectedHeadVersion) ||
        expectedHeadVersion < 1 ||
        expectedHeadVersion >= Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(
      activationClaim.expectedRepositoryConfigurationVersion
    ) ||
    activationClaim.expectedRepositoryConfigurationVersion < 1 ||
    activationClaim.expectedRepositoryConfigurationVersion >
      Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(activationClaim.expectedCursorVersion) ||
    activationClaim.expectedCursorVersion < 1 ||
    activationClaim.expectedCursorVersion >= Number.MAX_SAFE_INTEGER
  ) {
    throw reconciliationRequired();
  }
  const activationRequestDigest = await sha256(
    JSON.stringify([
      descriptor,
      expectedManifestId,
      expectedHeadVersion,
      activationClaim,
      scheduledAt,
      input.nextSyncAt,
      historyGapPossible,
      credentialStatus,
      input.etag,
      syncEvent.eventId,
      syncEvent.payloadDigest
    ])
  );
  if (
    await hasCommittedActivationReceipt(
      database,
      descriptor,
      expectedManifestId,
      expectedHeadVersion,
      activationClaim,
      scheduledAt,
      syncEvent,
      activationRequestDigest
    )
  ) {
    return;
  }
  if (expectedManifestId === descriptor.manifestId) {
    throw reconciliationRequired();
  }
  const refDigest = await sha256(["github.ref", descriptor.ref].join("\n"));
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

  const activationFence: PendingGitHubSyncActivationFence = {
    projectId: descriptor.projectId,
    repositoryId: descriptor.repositoryId,
    ref: descriptor.ref,
    manifestId: descriptor.manifestId,
    repositoryAuthority: descriptor.repositoryAuthority,
    runId: activationClaim.runId,
    receiptId: activationClaim.receiptId,
    activationToken: activationClaim.activationToken,
    scheduledFor: scheduledAt,
    fullReconciliation: activationClaim.fullReconciliation,
    expectedHeadManifestId: expectedManifestId,
    expectedHeadVersion,
    expectedExternalId: activationClaim.expectedExternalId,
    expectedOwnerExternalId: activationClaim.expectedOwnerExternalId,
    expectedOwner: activationClaim.expectedOwner,
    expectedName: activationClaim.expectedName,
    expectedDefaultBranch: activationClaim.expectedDefaultBranch,
    expectedTrackedRefsJson: activationClaim.expectedTrackedRefsJson,
    expectedRepositoryConfigurationVersion:
      activationClaim.expectedRepositoryConfigurationVersion,
    expectedRepositoryUpdatedAt:
      activationClaim.expectedRepositoryUpdatedAt,
    expectedCursorObservedSha: activationClaim.expectedCursorObservedSha,
    expectedCursorStatus: activationClaim.expectedCursorStatus,
    expectedCursorUpdatedAt: activationClaim.expectedCursorUpdatedAt,
    expectedCursorVersion: activationClaim.expectedCursorVersion
  };
  const guardSql = pendingGitHubSyncActivationGuardSql();
  const guardBindings =
    pendingGitHubSyncActivationGuardBindings(activationFence);
  const prestateGuardSql = pendingGitHubSyncActivationPrestateGuardSql();
  const prestateGuardBindings =
    pendingGitHubSyncActivationPrestateGuardBindings(activationFence);
  const witnessStatement = database
    .prepare(
      `INSERT INTO github_tree_activation_witnesses
       (activation_token, receipt_id, run_id, project_id, repository_id, ref,
        manifest_id, activation_request_digest, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${prestateGuardSql}`
    )
    .bind(
      activationClaim.activationToken,
      activationClaim.receiptId,
      activationClaim.runId,
      descriptor.projectId,
      descriptor.repositoryId,
      descriptor.ref,
      descriptor.manifestId,
      activationRequestDigest,
      activationAt,
      ...prestateGuardBindings
    );
  const headStatement = database
    .prepare(
      `INSERT INTO github_tree_ref_heads
       (project_id, repository_id, ref, manifest_id, head_version,
        activated_at, updated_at)
       SELECT ?, ?, ?, ?, 1, ?, ?
       WHERE ${guardSql}
       ON CONFLICT(project_id, repository_id, ref) DO UPDATE SET
         manifest_id = excluded.manifest_id,
         head_version = github_tree_ref_heads.head_version + 1,
         activated_at = excluded.activated_at,
         updated_at = excluded.updated_at
       WHERE github_tree_ref_heads.manifest_id IS ?
         AND github_tree_ref_heads.head_version = ?`
    )
    .bind(
      descriptor.projectId,
      descriptor.repositoryId,
      descriptor.ref,
      descriptor.manifestId,
      activationAt,
      activationAt,
      ...guardBindings,
      expectedManifestId,
      expectedHeadVersion
    );
  const statements: D1PreparedStatement[] = [
    witnessStatement,
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
        activationAt,
        descriptor.projectId,
        descriptor.manifestId,
        expectedManifestId,
        expectedManifestId,
        ...guardBindings
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
          activationAt,
          expectedManifestId,
          descriptor.projectId,
          descriptor.manifestId,
          ...guardBindings
        ),
      database
        .prepare(withdrawnDeltaSql())
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
          activationAt,
          expectedManifestId,
          descriptor.projectId,
          descriptor.manifestId,
          ...guardBindings
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
          activationAt,
          descriptor.manifestId,
          descriptor.projectId,
          expectedManifestId,
          ...guardBindings
        )
    );
  }
  statements.push(
    database
      .prepare(deletionEvidenceSql())
      .bind(
        refDigest,
        activationAt,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        ...guardBindings
      ),
    database
      .prepare(deletionObservationSql())
      .bind(
        activationAt,
        activationAt,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        ...guardBindings
      ),
    database
      .prepare(deletionObservationEvidenceSql())
      .bind(
        activationAt,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        ...guardBindings
      ),
    database
      .prepare(deletionReviewRequestSql())
      .bind(
        activationAt,
        activationAt,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        ...guardBindings
      ),
    database
      .prepare(withdrawalEvidenceSql())
      .bind(
        activationAt,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        ...guardBindings
      ),
    database
      .prepare(withdrawalObservationSql())
      .bind(
        activationAt,
        activationAt,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        ...guardBindings
      ),
    database
      .prepare(withdrawalObservationEvidenceSql())
      .bind(
        activationAt,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        ...guardBindings
      ),
    database
      .prepare(withdrawalReviewRequestSql())
      .bind(
        activationAt,
        activationAt,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        ...guardBindings
      )
  );
  statements.push(
    ...(input.candidateStatements ?? []),
    database
      .prepare(
        `INSERT INTO outbox_events
         (event_id, project_id, project_version, event_type, payload_digest,
          payload_json, created_at)
         SELECT ?, project.project_id, project.project_version,
                'github.sync.requested', ?, ?, ?
         FROM projects AS project
         WHERE project.project_id = ? AND ${guardSql}
         ON CONFLICT(event_id) DO UPDATE SET
           attempt = -1
         WHERE NOT (
           outbox_events.project_id IS excluded.project_id
           AND outbox_events.event_type IS excluded.event_type
           AND outbox_events.payload_digest IS excluded.payload_digest
           AND outbox_events.payload_json IS excluded.payload_json
         )`
      )
      .bind(
        syncEvent.eventId,
        syncEvent.payloadDigest,
        syncEvent.payloadJson,
        activationAt,
        descriptor.projectId,
        ...guardBindings
      ),
    headStatement,
    database
      .prepare(
        `UPDATE sync_cursors
         SET observed_sha = ?, status = 'observed', last_sync_at = ?,
             next_sync_at = ?, history_gap_possible = ?,
             credential_status = ?, etag = ?, last_error_code = NULL,
             updated_at = ?
         WHERE project_id = ? AND repository_id = ? AND ref = ?
           AND observed_sha IS ?
           AND status = ? AND status <> 'paused'
           AND updated_at = ? AND cursor_version = ?
           AND EXISTS (
             SELECT 1
             FROM repositories AS repository
             JOIN github_repository_sync_runs AS sync_run
               ON sync_run.run_id = ?
              AND sync_run.project_id = repository.project_id
              AND sync_run.repository_id = repository.repository_id
             JOIN github_tree_ref_heads AS head
               ON head.project_id = repository.project_id
              AND head.repository_id = repository.repository_id
              AND head.ref = sync_cursors.ref
             WHERE repository.project_id = sync_cursors.project_id
               AND repository.repository_id =
                 sync_cursors.repository_id
               AND lower(repository.provider) = 'github'
               AND repository.sync_enabled = 1
               AND repository.external_id = ?
               AND repository.expected_owner_external_id IS ?
               AND repository.owner = ? AND repository.name = ?
               AND repository.default_branch IS ?
               AND repository.tracked_refs_json = ?
               AND repository.github_sync_configuration_version = ?
               AND repository.updated_at = ?
               AND sync_run.claimed_ref = sync_cursors.ref
               AND sync_run.claimed_head_manifest_id IS ?
               AND sync_run.claimed_head_version = ?
               AND sync_run.scheduled_for = ?
               AND sync_run.full_reconciliation = ?
               AND sync_run.repository_configuration_version = ?
               AND sync_run.cursor_version = ?
               AND sync_run.claim_contract_version = 1
               AND sync_run.status = 'running'
               AND sync_run.completed_at IS NULL
               AND sync_run.lease_expires_at >
                 strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               AND EXISTS (
                 SELECT 1
                 FROM github_tree_activation_witnesses AS witness
                 WHERE witness.activation_token = ?
                   AND witness.receipt_id = ?
                   AND witness.run_id = sync_run.run_id
                   AND witness.project_id = repository.project_id
                   AND witness.repository_id = repository.repository_id
                   AND witness.ref = sync_cursors.ref
                   AND witness.manifest_id = ?
                   AND witness.activation_request_digest = ?
               )
               AND head.manifest_id = ?
               AND head.head_version = ?
           )`
      )
      .bind(
        descriptor.observedSha,
        scheduledAt,
        input.nextSyncAt,
        historyGapPossible ? 1 : 0,
        credentialStatus,
        input.etag,
        activationAt,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        activationClaim.expectedCursorObservedSha,
        activationClaim.expectedCursorStatus,
        activationClaim.expectedCursorUpdatedAt,
        activationClaim.expectedCursorVersion,
        activationClaim.runId,
        activationClaim.expectedExternalId,
        activationClaim.expectedOwnerExternalId,
        activationClaim.expectedOwner,
        activationClaim.expectedName,
        activationClaim.expectedDefaultBranch,
        activationClaim.expectedTrackedRefsJson,
        activationClaim.expectedRepositoryConfigurationVersion,
        activationClaim.expectedRepositoryUpdatedAt,
        expectedManifestId,
        expectedHeadVersion,
        scheduledAt,
        activationClaim.fullReconciliation ? 1 : 0,
        activationClaim.expectedRepositoryConfigurationVersion,
        activationClaim.expectedCursorVersion,
        activationClaim.activationToken,
        activationClaim.receiptId,
        descriptor.manifestId,
        activationRequestDigest,
        descriptor.manifestId,
        expectedHeadVersion + 1
      ),
    database
      .prepare(
        `UPDATE github_repository_sync_runs
         SET status = 'complete', completed_at = ?, last_error_code = NULL
         WHERE run_id = ? AND project_id = ? AND repository_id = ?
           AND claimed_ref = ? AND scheduled_for = ?
           AND claimed_head_manifest_id IS ?
           AND claimed_head_version = ?
           AND full_reconciliation = ?
           AND repository_configuration_version = ?
           AND cursor_version = ?
           AND claim_contract_version = 1
           AND status = 'running' AND completed_at IS NULL
           AND lease_expires_at >
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           AND EXISTS (
             SELECT 1
             FROM repositories AS repository
             WHERE repository.project_id =
                 github_repository_sync_runs.project_id
               AND repository.repository_id =
                 github_repository_sync_runs.repository_id
               AND lower(repository.provider) = 'github'
               AND repository.sync_enabled = 1
               AND repository.github_sync_configuration_version = ?
               AND repository.updated_at = ?
           )
           AND EXISTS (
             SELECT 1
             FROM github_tree_ref_heads AS head
             JOIN sync_cursors AS cursor
               ON cursor.project_id = head.project_id
              AND cursor.repository_id = head.repository_id
              AND cursor.ref = head.ref
              AND cursor.observed_sha = ?
              AND cursor.status = 'observed'
              AND cursor.updated_at = ?
              AND cursor.cursor_version = ?
             WHERE head.project_id =
                 github_repository_sync_runs.project_id
               AND head.repository_id =
                 github_repository_sync_runs.repository_id
               AND head.ref = github_repository_sync_runs.claimed_ref
               AND head.manifest_id = ?
               AND head.head_version = ?
           )
           AND EXISTS (
             SELECT 1
             FROM github_tree_activation_witnesses AS witness
             WHERE witness.activation_token = ?
               AND witness.receipt_id = ?
               AND witness.run_id = github_repository_sync_runs.run_id
               AND witness.project_id =
                 github_repository_sync_runs.project_id
               AND witness.repository_id =
                 github_repository_sync_runs.repository_id
               AND witness.ref = github_repository_sync_runs.claimed_ref
               AND witness.manifest_id = ?
               AND witness.activation_request_digest = ?
           )`
      )
      .bind(
        activationAt,
        activationClaim.runId,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        scheduledAt,
        expectedManifestId,
        expectedHeadVersion,
        activationClaim.fullReconciliation ? 1 : 0,
        activationClaim.expectedRepositoryConfigurationVersion,
        activationClaim.expectedCursorVersion,
        activationClaim.expectedRepositoryConfigurationVersion,
        activationClaim.expectedRepositoryUpdatedAt,
        descriptor.observedSha,
        activationAt,
        activationClaim.expectedCursorVersion + 1,
        descriptor.manifestId,
        expectedHeadVersion + 1,
        activationClaim.activationToken,
        activationClaim.receiptId,
        descriptor.manifestId,
        activationRequestDigest
      ),
    database
      .prepare(
        `INSERT INTO github_tree_activation_receipts
         (receipt_id, activation_token, project_id, repository_id, ref,
          manifest_id, run_id, expected_head_manifest_id,
          expected_head_version, activated_head_version,
          expected_cursor_observed_sha, expected_cursor_status,
          expected_cursor_updated_at, expected_cursor_version,
          activated_cursor_version,
          expected_repository_configuration_version,
          expected_repository_updated_at, observed_sha, sync_event_id,
          sync_event_payload_digest, activation_request_digest, scheduled_for,
          full_reconciliation, next_sync_at, history_gap_possible,
          credential_status, etag, activated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        activationClaim.receiptId,
        activationClaim.activationToken,
        descriptor.projectId,
        descriptor.repositoryId,
        descriptor.ref,
        descriptor.manifestId,
        activationClaim.runId,
        expectedManifestId,
        expectedHeadVersion,
        expectedHeadVersion + 1,
        activationClaim.expectedCursorObservedSha,
        activationClaim.expectedCursorStatus,
        activationClaim.expectedCursorUpdatedAt,
        activationClaim.expectedCursorVersion,
        activationClaim.expectedCursorVersion + 1,
        activationClaim.expectedRepositoryConfigurationVersion,
        activationClaim.expectedRepositoryUpdatedAt,
        descriptor.observedSha,
        syncEvent.eventId,
        syncEvent.payloadDigest,
        activationRequestDigest,
        scheduledAt,
        activationClaim.fullReconciliation ? 1 : 0,
        input.nextSyncAt,
        historyGapPossible ? 1 : 0,
        credentialStatus,
        input.etag,
        activationAt
      )
  );
  try {
    await database.batch(statements);
    return;
  } catch (error) {
    if (
      await hasCommittedActivationReceipt(
        database,
        descriptor,
        expectedManifestId,
        expectedHeadVersion,
        activationClaim,
        scheduledAt,
        syncEvent,
        activationRequestDigest
      )
    ) {
      return;
    }
    if (activationReceiptAssertionFailed(error)) {
      throw reconciliationRequired();
    }
    throw error;
  }
}

async function hasCommittedActivationReceipt(
  database: D1Database,
  descriptor: GitHubTreeManifestDescriptor,
  expectedHeadManifestId: string | null,
  expectedHeadVersion: number,
  activationClaim: GitHubTreeManifestActivationClaim,
  scheduledAt: string,
  syncEvent: {
    eventId: string;
    payloadDigest: string;
  },
  activationRequestDigest: string
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT receipt_id
       FROM github_tree_activation_receipts
       WHERE receipt_id = ? AND activation_token = ?
         AND project_id = ? AND repository_id = ?
         AND ref = ? AND manifest_id = ? AND run_id = ?
         AND expected_head_manifest_id IS ?
         AND expected_head_version = ?
         AND activated_head_version = ?
         AND expected_cursor_observed_sha IS ?
         AND expected_cursor_status = ?
         AND expected_cursor_updated_at = ?
         AND expected_cursor_version = ?
         AND expected_repository_configuration_version = ?
         AND expected_repository_updated_at = ?
         AND observed_sha = ?
         AND sync_event_id = ?
         AND sync_event_payload_digest = ?
         AND activation_request_digest = ?
         AND scheduled_for = ? AND full_reconciliation = ?
         AND activated_cursor_version = expected_cursor_version + 1`
    )
    .bind(
      activationClaim.receiptId,
      activationClaim.activationToken,
      descriptor.projectId,
      descriptor.repositoryId,
      descriptor.ref,
      descriptor.manifestId,
      activationClaim.runId,
      expectedHeadManifestId,
      expectedHeadVersion,
      expectedHeadVersion + 1,
      activationClaim.expectedCursorObservedSha,
      activationClaim.expectedCursorStatus,
      activationClaim.expectedCursorUpdatedAt,
      activationClaim.expectedCursorVersion,
      activationClaim.expectedRepositoryConfigurationVersion,
      activationClaim.expectedRepositoryUpdatedAt,
      descriptor.observedSha,
      syncEvent.eventId,
      syncEvent.payloadDigest,
      activationRequestDigest,
      scheduledAt,
      activationClaim.fullReconciliation ? 1 : 0
    )
    .first<{ receipt_id: string }>();
  return row !== null;
}

function activationReceiptAssertionFailed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("GitHub tree activation receipt final state is invalid") ||
    message.includes("github_tree_activation_receipts.") ||
    message.includes("github_tree_activation_witnesses.") ||
    message.includes("GitHub tree activation witness pre-state is invalid")
  );
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
      `SELECT head.manifest_id, head.head_version, manifest.observed_sha
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
    .first<{
      manifest_id: string;
      head_version: number;
      observed_sha: string;
    }>();
  return row === null
    ? null
    : {
        manifestId: row.manifest_id,
        observedSha: row.observed_sha,
        headVersion: row.head_version
      };
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
