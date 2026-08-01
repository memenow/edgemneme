export interface OrphanRecoveryItem {
  item_id: string;
  project_id: string;
  repository_id: string;
  ref: string;
  scheduled_for: string;
}

export async function finishRejectedUnboundRepositoryRun(
  database: D1Database,
  item: OrphanRecoveryItem,
  runId: string | null,
  completedAt: string
): Promise<boolean> {
  const candidate = `SELECT run.run_id
     FROM github_repository_sync_runs AS run
     JOIN github_sync_dispatch_items AS rejected
       ON rejected.project_id = run.project_id
      AND rejected.repository_id = run.repository_id
      AND rejected.ref = run.claimed_ref
      AND rejected.scheduled_for = run.scheduled_for
     JOIN github_sync_dispatches AS dispatch
       ON dispatch.dispatch_id = rejected.dispatch_id
     JOIN github_sync_dispatch_item_rejection_receipts AS receipt
       ON receipt.dispatch_item_id = rejected.item_id
      AND receipt.dispatch_id = rejected.dispatch_id
      AND receipt.credential_version = dispatch.credential_version
      AND receipt.project_id = rejected.project_id
      AND receipt.repository_id = rejected.repository_id
      AND receipt.ref = rejected.ref
      AND receipt.last_error_code = rejected.last_error_code
      AND receipt.completed_at = rejected.completed_at
     WHERE run.project_id = ? AND run.repository_id = ? AND run.claimed_ref = ?
       AND run.status = 'running'
       AND rejected.status = 'failed' AND rejected.run_id IS NULL
       AND run.full_reconciliation = rejected.full_reconciliation
       AND run.repository_configuration_version =
           rejected.repository_configuration_version
       AND run.cursor_version = rejected.cursor_version
       AND run.claimed_head_manifest_id IS rejected.selected_head_manifest_id
       AND run.claimed_head_version = rejected.selected_head_version
       AND run.claim_contract_version = 1
       AND NOT EXISTS (
         SELECT 1 FROM github_sync_dispatch_items AS bound
         WHERE bound.run_id = run.run_id
       )
       AND ((? IS NOT NULL AND run.run_id = ? AND rejected.item_id = ?)
         OR (? IS NULL AND rejected.item_id <> ?
           AND rejected.scheduled_for <= ?))
     ORDER BY rejected.scheduled_for, rejected.item_id LIMIT 1`;
  const bindings = [
    item.project_id,
    item.repository_id,
    item.ref,
    runId,
    runId,
    item.item_id,
    runId,
    item.item_id,
    item.scheduled_for
  ] as const;
  const failedCandidate = candidate.replace(
    "run.status = 'running'",
    "run.status = 'failed'"
  );
  const hasExactFailure = async (): Promise<boolean> => {
    const exact = await database.withSession("first-primary").prepare(
      `SELECT 1 AS matches FROM github_repository_sync_runs
       WHERE run_id = (${failedCandidate}) AND status = 'failed'
         AND completed_at = ?
         AND last_error_code = 'GITHUB_RECONCILIATION_REQUIRED'
       LIMIT 1`
    ).bind(...bindings, completedAt).first<{ matches: number }>();
    return exact?.matches === 1;
  };
  try {
    const result = await database.withSession("first-primary").prepare(
      `UPDATE github_repository_sync_runs
       SET status = 'failed', completed_at = ?,
           last_error_code = 'GITHUB_RECONCILIATION_REQUIRED'
       WHERE run_id = (${candidate}) AND status = 'running'`
    ).bind(completedAt, ...bindings).run();
    return (result.meta.changes ?? 0) === 1 || await hasExactFailure();
  } catch (error) {
    if (await hasExactFailure()) return true;
    throw error;
  }
}
