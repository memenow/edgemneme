import { GitHubSyncError } from "./client";

interface ReviewCursorStateRow {
  cursor_observed_sha: string | null;
  status: string;
  cursor_version: number;
  head_manifest_id: string | null;
  manifest_observed_sha: string | null;
}

export async function markGitHubSyncPendingReview(
  database: D1Database,
  input: {
    projectId: string;
    repositoryId: string;
    ref: string;
    observedSha: string;
    manifestId: string;
    updatedAt: string;
  }
): Promise<void> {
  const result = await database
    .withSession("first-primary")
    .prepare(
      `UPDATE sync_cursors
       SET status = 'pending_review', updated_at = ?
       WHERE project_id = ? AND repository_id = ? AND ref = ?
         AND observed_sha = ?
         AND status = 'observed'
         AND EXISTS (
           SELECT 1
           FROM github_tree_ref_heads AS head
           JOIN github_tree_manifests AS manifest
             ON manifest.project_id = head.project_id
            AND manifest.repository_id = head.repository_id
            AND manifest.ref = head.ref
            AND manifest.manifest_id = head.manifest_id
           WHERE head.project_id = sync_cursors.project_id
             AND head.repository_id = sync_cursors.repository_id
             AND head.ref = sync_cursors.ref
             AND head.manifest_id = ?
             AND manifest.observed_sha = ?
         )`
    )
    .bind(
      input.updatedAt,
      input.projectId,
      input.repositoryId,
      input.ref,
      input.observedSha,
      input.manifestId,
      input.observedSha
    )
    .run();
  const changes = result.meta.changes ?? 0;
  if (changes === 1) {
    return;
  }
  if (changes !== 0) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }

  const current = await database
    .withSession("first-primary")
    .prepare(
      `SELECT cursor.observed_sha AS cursor_observed_sha,
              cursor.status, cursor.cursor_version,
              head.manifest_id AS head_manifest_id,
              manifest.observed_sha AS manifest_observed_sha
       FROM sync_cursors AS cursor
       LEFT JOIN github_tree_ref_heads AS head
         ON head.project_id = cursor.project_id
        AND head.repository_id = cursor.repository_id
        AND head.ref = cursor.ref
       LEFT JOIN github_tree_manifests AS manifest
         ON manifest.project_id = head.project_id
        AND manifest.repository_id = head.repository_id
        AND manifest.ref = head.ref
        AND manifest.manifest_id = head.manifest_id
        AND manifest.status = 'complete'
       WHERE cursor.project_id = ? AND cursor.repository_id = ?
         AND cursor.ref = ?`
    )
    .bind(input.projectId, input.repositoryId, input.ref)
    .first<ReviewCursorStateRow>();
  if (current === null || current.head_manifest_id === null) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  if (current.head_manifest_id !== input.manifestId) {
    return;
  }
  if (
    current.manifest_observed_sha !== input.observedSha ||
    current.cursor_observed_sha !== input.observedSha
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  if (current.status === "paused" || current.status === "pending_review") {
    return;
  }
  throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
}
