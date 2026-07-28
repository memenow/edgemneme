import { GitHubSyncError } from "./client";
import { sha256 } from "../security/crypto";

interface StoredPathDigestRow {
  path_digest: string;
}

export interface ManifestPurgeClaim {
  readonly projectId: string;
  readonly manifestId: string;
  readonly purgeToken: string;
  readonly retentionVersion: number;
  readonly retentionAttempt: number;
}

const DELETE_CHUNK_SIZE = 500;
const ERROR_BACKOFF_BASE_MILLISECONDS = 12 * 60 * 60 * 1_000;
const ERROR_BACKOFF_MAX_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export async function deferFailedPurgeClaim(
  database: D1Database,
  claim: ManifestPurgeClaim
): Promise<void> {
  const exponent = Math.min(Math.max(claim.retentionAttempt - 1, 0), 10);
  const backoffMilliseconds = Math.min(
    ERROR_BACKOFF_BASE_MILLISECONDS * 2 ** exponent,
    ERROR_BACKOFF_MAX_MILLISECONDS
  );
  const backoffModifier = `+${backoffMilliseconds / 1_000} seconds`;
  await database
    .prepare(
      `UPDATE github_tree_manifests
       SET retention_next_attempt_at = strftime(
         '%Y-%m-%dT%H:%M:%fZ', 'now', ?
       )
       WHERE project_id = ? AND manifest_id = ? AND status = 'purging'
         AND purge_token = ? AND retention_version = ?
         AND retention_attempt = ?`
    )
    .bind(
      backoffModifier,
      claim.projectId,
      claim.manifestId,
      claim.purgeToken,
      claim.retentionVersion,
      claim.retentionAttempt
    )
    .run();
}

export async function purgeClaimedManifestEntries(
  database: D1Database,
  claim: ManifestPurgeClaim,
  maxChunks: number
): Promise<{ entriesDeleted: number; purged: boolean }> {
  let entriesDeleted = 0;
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const chunkRows = await database
      .withSession("first-primary")
      .prepare(
        `SELECT entry.path_digest
         FROM github_tree_manifest_entries AS entry
         JOIN github_tree_manifests AS manifest
           ON manifest.project_id = entry.project_id
          AND manifest.manifest_id = entry.manifest_id
         JOIN projects AS project ON project.project_id = manifest.project_id
         WHERE entry.project_id = ? AND entry.manifest_id = ?
           AND manifest.status = 'purging'
           AND manifest.purge_token = ?
           AND manifest.retention_version = ?
           AND manifest.retention_attempt = ?
           AND julianday(manifest.purge_lease_until) > julianday('now')
           AND julianday('now') >= julianday(manifest.failed_at, '+30 days')
           AND project.project_ref NOT GLOB 'system.synthetic.*'
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
           )
         ORDER BY entry.path_digest
         LIMIT ?`
      )
      .bind(
        claim.projectId,
        claim.manifestId,
        claim.purgeToken,
        claim.retentionVersion,
        claim.retentionAttempt,
        DELETE_CHUNK_SIZE
      )
      .all<StoredPathDigestRow>();
    const pathDigests = chunkRows.results.map((row) => row.path_digest);
    if (pathDigests.length === 0) {
      break;
    }

    const chunkDigest = await sha256(pathDigests.join("\n"));
    const eventId = await sha256(
      [
        "github.tree.manifest.lifecycle",
        claim.projectId,
        claim.manifestId,
        "purge_chunk",
        String(claim.retentionVersion),
        chunkDigest
      ].join("\n")
    );
    const requestDigest = await sha256(
      [
        claim.projectId,
        claim.manifestId,
        String(claim.retentionVersion),
        String(claim.retentionAttempt),
        String(pathDigests.length),
        chunkDigest
      ].join("\n")
    );
    const pathDigestsJson = JSON.stringify(pathDigests);
    const statements = await database.batch([
      database
        .prepare(
          `INSERT INTO github_tree_manifest_lifecycle_events
           (event_id, project_id, manifest_id, retention_version, event_type,
            failure_code, entry_count, entries_checksum, chunk_entry_count,
            chunk_digest, request_digest, recorded_at)
           SELECT ?, manifest.project_id, manifest.manifest_id,
                  manifest.retention_version, 'purge_chunk',
                  manifest.failure_code, manifest.entry_count,
                  manifest.entries_checksum, ?, ?, ?,
                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           FROM github_tree_manifests AS manifest
           JOIN projects AS project ON project.project_id = manifest.project_id
           WHERE manifest.project_id = ? AND manifest.manifest_id = ?
             AND manifest.status = 'purging'
             AND manifest.purge_token = ?
             AND manifest.retention_version = ?
             AND manifest.retention_attempt = ?
             AND julianday(manifest.purge_lease_until) > julianday('now')
             AND julianday('now') >= julianday(manifest.failed_at, '+30 days')
             AND project.project_ref NOT GLOB 'system.synthetic.*'
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
             )
             AND ? = (
               SELECT COUNT(*)
               FROM github_tree_manifest_entries AS entry
               JOIN json_each(?) AS selected
                 ON selected.value = entry.path_digest
               WHERE entry.project_id = manifest.project_id
                 AND entry.manifest_id = manifest.manifest_id
             )`
        )
        .bind(
          eventId,
          pathDigests.length,
          chunkDigest,
          requestDigest,
          claim.projectId,
          claim.manifestId,
          claim.purgeToken,
          claim.retentionVersion,
          claim.retentionAttempt,
          pathDigests.length,
          pathDigestsJson
        ),
      database
        .prepare(
          `DELETE FROM github_tree_manifest_entries
           WHERE project_id = ? AND manifest_id = ?
             AND path_digest IN (SELECT value FROM json_each(?))
             AND EXISTS (
               SELECT 1 FROM github_tree_manifests AS manifest
               JOIN projects AS project
                 ON project.project_id = manifest.project_id
               WHERE manifest.project_id = github_tree_manifest_entries.project_id
                 AND manifest.manifest_id = github_tree_manifest_entries.manifest_id
                 AND manifest.status = 'purging'
                 AND manifest.purge_token = ?
                 AND manifest.retention_version = ?
                 AND manifest.retention_attempt = ?
                 AND julianday(manifest.purge_lease_until) > julianday('now')
                 AND julianday('now') >= julianday(manifest.failed_at, '+30 days')
                 AND project.project_ref NOT GLOB 'system.synthetic.*'
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
                 )
             )
             AND EXISTS (
               SELECT 1 FROM github_tree_manifest_lifecycle_events AS event
               WHERE event.project_id = github_tree_manifest_entries.project_id
                 AND event.manifest_id = github_tree_manifest_entries.manifest_id
                 AND event.event_id = ?
                 AND event.event_type = 'purge_chunk'
                 AND event.retention_version = ?
                 AND event.chunk_entry_count = ?
                 AND event.chunk_digest = ?
             )`
        )
        .bind(
          claim.projectId,
          claim.manifestId,
          pathDigestsJson,
          claim.purgeToken,
          claim.retentionVersion,
          claim.retentionAttempt,
          eventId,
          claim.retentionVersion,
          pathDigests.length,
          chunkDigest
        )
    ]);
    const eventChanges = statements[0]?.meta.changes ?? 0;
    const deleted = statements[1]?.meta.changes ?? 0;
    if (eventChanges !== 1 || deleted !== pathDigests.length) {
      throw reconciliationRequired();
    }
    entriesDeleted += deleted;
    if (deleted < DELETE_CHUNK_SIZE) {
      break;
    }
  }

  const purgedRetentionVersion = claim.retentionVersion + 1;
  const eventId = await sha256(
    [
      "github.tree.manifest.lifecycle",
      claim.projectId,
      claim.manifestId,
      "purged",
      String(purgedRetentionVersion)
    ].join("\n")
  );
  const requestDigest = await sha256(
    [
      claim.projectId,
      claim.manifestId,
      String(purgedRetentionVersion),
      String(claim.retentionAttempt)
    ].join("\n")
  );
  const completion = await database.batch([
    database
      .prepare(
        `UPDATE github_tree_manifests
         SET status = 'purged', retention_version = retention_version + 1,
             retention_next_attempt_at = NULL, purge_token = NULL,
             purge_lease_until = NULL,
             purged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE project_id = ? AND manifest_id = ? AND status = 'purging'
           AND purge_token = ? AND retention_version = ?
           AND retention_attempt = ?
           AND julianday(purge_lease_until) > julianday('now')
           AND julianday('now') >= julianday(failed_at, '+30 days')
           AND EXISTS (
             SELECT 1 FROM projects AS project
             WHERE project.project_id = github_tree_manifests.project_id
               AND project.project_ref NOT GLOB 'system.synthetic.*'
           )
           AND NOT EXISTS (
             SELECT 1 FROM github_tree_manifest_entries AS entry
             WHERE entry.project_id = github_tree_manifests.project_id
               AND entry.manifest_id = github_tree_manifests.manifest_id
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
        claim.projectId,
        claim.manifestId,
        claim.purgeToken,
        claim.retentionVersion,
        claim.retentionAttempt
      ),
    database
      .prepare(
        `INSERT INTO github_tree_manifest_lifecycle_events
         (event_id, project_id, manifest_id, retention_version, event_type,
          failure_code, entry_count, entries_checksum, request_digest,
          recorded_at)
         SELECT ?, manifest.project_id, manifest.manifest_id,
                manifest.retention_version, 'purged', manifest.failure_code,
                manifest.entry_count, manifest.entries_checksum, ?,
                manifest.purged_at
         FROM github_tree_manifests AS manifest
         WHERE manifest.project_id = ? AND manifest.manifest_id = ?
           AND manifest.status = 'purged'
           AND manifest.retention_version = ?
           AND manifest.retention_attempt = ?
           AND NOT EXISTS (
             SELECT 1 FROM github_tree_manifest_lifecycle_events AS event
             WHERE event.event_id = ?
           )`
      )
      .bind(
        eventId,
        requestDigest,
        claim.projectId,
        claim.manifestId,
        purgedRetentionVersion,
        claim.retentionAttempt,
        eventId
      )
  ]);
  const stateChanges = completion[0]?.meta.changes ?? 0;
  const eventChanges = completion[1]?.meta.changes ?? 0;
  if (stateChanges !== eventChanges || stateChanges > 1) {
    throw reconciliationRequired();
  }
  return {
    entriesDeleted,
    purged: stateChanges === 1
  };
}

function reconciliationRequired(): GitHubSyncError {
  return new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
}
