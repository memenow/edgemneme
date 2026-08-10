export interface PendingGitHubSyncActivationFence {
  projectId: string;
  repositoryId: string;
  ref: string;
  manifestId: string;
  repositoryAuthority: "default_branch" | "tracked_ref";
  runId: string;
  receiptId: string;
  activationToken: string;
  scheduledFor: string;
  fullReconciliation: boolean;
  expectedHeadManifestId: string | null;
  expectedHeadVersion: number;
  expectedExternalId: number;
  expectedOwnerExternalId: number;
  expectedOwner: string;
  expectedName: string;
  expectedDefaultBranch: string;
  expectedTrackedRefsJson: string;
  expectedRepositoryConfigurationVersion: number;
  expectedRepositoryUpdatedAt: string;
  expectedCursorObservedSha: string | null;
  expectedCursorStatus: string;
  expectedCursorUpdatedAt: string;
  expectedCursorVersion: number;
}

export function pendingGitHubSyncActivationPrestateGuardSql(): string {
  return `EXISTS (
    SELECT 1
    FROM repositories AS activation_repository
    JOIN sync_cursors AS activation_cursor
      ON activation_cursor.project_id = activation_repository.project_id
     AND activation_cursor.repository_id =
       activation_repository.repository_id
     AND activation_cursor.ref = ?
    JOIN github_repository_sync_runs AS activation_run
      ON activation_run.run_id = ?
     AND activation_run.project_id = activation_repository.project_id
     AND activation_run.repository_id =
       activation_repository.repository_id
    JOIN github_tree_manifests AS activation_manifest
      ON activation_manifest.project_id = activation_repository.project_id
     AND activation_manifest.repository_id =
       activation_repository.repository_id
     AND activation_manifest.ref = activation_cursor.ref
     AND activation_manifest.manifest_id = ?
    WHERE activation_repository.project_id = ?
      AND activation_repository.repository_id = ?
      AND lower(activation_repository.provider) = 'github'
      AND activation_repository.sync_enabled = 1
      AND activation_repository.external_id = ?
      AND activation_repository.expected_owner_external_id IS ?
      AND activation_repository.owner = ?
      AND activation_repository.name = ?
      AND activation_repository.default_branch IS ?
      AND activation_repository.tracked_refs_json = ?
      AND activation_repository.github_sync_configuration_version = ?
      AND activation_repository.updated_at = ?
      AND activation_manifest.status = 'complete'
      AND activation_manifest.repository_authority = ?
      AND activation_manifest.collection_key = activation_run.scheduled_for
      AND (
        (
          activation_manifest.repository_authority = 'default_branch'
          AND activation_manifest.ref =
            'refs/heads/' || activation_repository.default_branch
        )
        OR (
          activation_manifest.repository_authority = 'tracked_ref'
          AND EXISTS (
            SELECT 1
            FROM json_each(
              activation_repository.tracked_refs_json
            ) AS activation_tracked_ref
            WHERE activation_tracked_ref.value = activation_manifest.ref
          )
        )
      )
      AND activation_cursor.observed_sha IS ?
      AND activation_cursor.status = ?
      AND activation_cursor.status <> 'paused'
      AND activation_cursor.updated_at = ?
      AND activation_cursor.cursor_version = ?
      AND activation_run.claimed_ref = activation_cursor.ref
      AND activation_run.claimed_head_manifest_id IS ?
      AND activation_run.claimed_head_version = ?
      AND activation_run.scheduled_for = ?
      AND activation_run.full_reconciliation = ?
      AND activation_run.repository_configuration_version = ?
      AND activation_run.cursor_version = ?
      AND activation_run.claim_contract_version = 1
      AND activation_run.status = 'running'
      AND activation_run.completed_at IS NULL
      AND activation_run.lease_expires_at >
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND (
        (
          ? = 0
          AND ? IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM github_tree_ref_heads AS activation_head
            WHERE activation_head.project_id =
                activation_repository.project_id
              AND activation_head.repository_id =
                activation_repository.repository_id
              AND activation_head.ref = activation_cursor.ref
          )
        )
        OR (
          ? >= 1
          AND EXISTS (
            SELECT 1
            FROM github_tree_ref_heads AS activation_head
            WHERE activation_head.project_id =
                activation_repository.project_id
              AND activation_head.repository_id =
                activation_repository.repository_id
              AND activation_head.ref = activation_cursor.ref
              AND activation_head.manifest_id IS ?
              AND activation_head.head_version = ?
          )
        )
      )
  )`;
}

export function pendingGitHubSyncActivationPrestateGuardBindings(
  fence: PendingGitHubSyncActivationFence
): unknown[] {
  return [
    fence.ref,
    fence.runId,
    fence.manifestId,
    fence.projectId,
    fence.repositoryId,
    fence.expectedExternalId,
    fence.expectedOwnerExternalId,
    fence.expectedOwner,
    fence.expectedName,
    fence.expectedDefaultBranch,
    fence.expectedTrackedRefsJson,
    fence.expectedRepositoryConfigurationVersion,
    fence.expectedRepositoryUpdatedAt,
    fence.repositoryAuthority,
    fence.expectedCursorObservedSha,
    fence.expectedCursorStatus,
    fence.expectedCursorUpdatedAt,
    fence.expectedCursorVersion,
    fence.expectedHeadManifestId,
    fence.expectedHeadVersion,
    fence.scheduledFor,
    fence.fullReconciliation ? 1 : 0,
    fence.expectedRepositoryConfigurationVersion,
    fence.expectedCursorVersion,
    fence.expectedHeadVersion,
    fence.expectedHeadManifestId,
    fence.expectedHeadVersion,
    fence.expectedHeadManifestId,
    fence.expectedHeadVersion
  ];
}

export function pendingGitHubSyncActivationGuardSql(): string {
  return `(${pendingGitHubSyncActivationPrestateGuardSql()})
    AND EXISTS (
      SELECT 1
      FROM github_tree_activation_witnesses AS activation_witness
      WHERE activation_witness.activation_token = ?
        AND activation_witness.receipt_id = ?
        AND activation_witness.run_id = ?
        AND activation_witness.project_id = ?
        AND activation_witness.repository_id = ?
        AND activation_witness.ref = ?
        AND activation_witness.manifest_id = ?
    )`;
}

export function pendingGitHubSyncActivationGuardBindings(
  fence: PendingGitHubSyncActivationFence
): unknown[] {
  return [
    ...pendingGitHubSyncActivationPrestateGuardBindings(fence),
    fence.activationToken,
    fence.receiptId,
    fence.runId,
    fence.projectId,
    fence.repositoryId,
    fence.ref,
    fence.manifestId
  ];
}
