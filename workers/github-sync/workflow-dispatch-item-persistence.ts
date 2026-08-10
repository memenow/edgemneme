// Owns guarded, fenced persistence for pending dispatch items.
import { GitHubSyncError } from "../../src/github/client";
import {
  chunkWorkflowBatch,
  githubRefWorkflowIdentity
} from "../../src/github/sync-scheduling";
import {
  requiresFullReconciliation,
  type GitHubDispatchWorkflowPayload,
  type GuardedScheduledRefRow
} from "./index";

interface PersistedDispatchItem {
  itemId: string;
  workflowInstanceId: string;
  selected: GuardedScheduledRefRow;
  fullReconciliation: boolean;
}

const DISPATCH_ITEM_GUARD_CTES = `WITH payload AS (
  SELECT json(?) AS value
), expected AS (
  SELECT item.value, payload.value AS payload
  FROM payload, json_each(payload.value, '$.items') AS item
), guarded AS (
  SELECT expected.value
  FROM expected
  JOIN github_sync_dispatches AS dispatch
    ON dispatch.dispatch_id =
         json_extract(expected.payload, '$.dispatch.dispatch_id')
   AND dispatch.credential_version =
         json_extract(expected.payload, '$.dispatch.credential_version')
   AND dispatch.scheduled_for =
         json_extract(expected.payload, '$.dispatch.scheduled_for')
   AND dispatch.utc_date = json_extract(expected.payload, '$.dispatch.utc_date')
   AND dispatch.created_at =
         json_extract(expected.payload, '$.dispatch.created_at')
   AND dispatch.status = 'materialized'
  JOIN repositories AS repository
    ON repository.project_id =
         json_extract(expected.payload, '$.repository.project_id')
   AND repository.repository_id =
         json_extract(expected.payload, '$.repository.repository_id')
   AND lower(repository.provider) = 'github'
   AND repository.sync_enabled = 1
   AND repository.external_id =
         json_extract(expected.payload, '$.repository.external_id')
   AND repository.expected_owner_external_id IS
         json_extract(
           expected.payload,
           '$.repository.expected_owner_external_id'
         )
   AND repository.owner = json_extract(expected.payload, '$.repository.owner')
   AND repository.name = json_extract(expected.payload, '$.repository.name')
   AND repository.default_branch IS
         json_extract(expected.payload, '$.repository.default_branch')
   AND repository.tracked_refs_json =
         json_extract(expected.payload, '$.repository.tracked_refs_json')
   AND repository.github_sync_configuration_version =
         json_extract(
           expected.payload,
           '$.repository.repository_configuration_version'
         )
   AND repository.updated_at =
         json_extract(expected.payload, '$.repository.repository_updated_at')
  JOIN sync_cursors AS cursor
    ON cursor.project_id = repository.project_id
   AND cursor.repository_id = repository.repository_id
   AND cursor.ref = json_extract(expected.value, '$.ref')
  LEFT JOIN github_tree_ref_heads AS head
    ON head.project_id = cursor.project_id
   AND head.repository_id = cursor.repository_id
   AND head.ref = cursor.ref
  WHERE json_array(
          cursor.observed_sha, cursor.status, cursor.etag,
          cursor.last_sync_at, cursor.next_sync_at,
          cursor.history_gap_possible, cursor.credential_status,
          cursor.last_error_code, cursor.updated_at, cursor.ref_scope_id,
          cursor.cursor_version
        ) IS json_extract(expected.value, '$.cursor_state_json')
    AND json_array(
          head.manifest_id, head.head_version, head.activated_at,
          head.updated_at
        ) IS json_extract(expected.value, '$.head_state_json')
    AND (
      SELECT COUNT(*)
      FROM github_sync_dispatch_items AS active_item
      WHERE active_item.project_id = cursor.project_id
        AND active_item.repository_id = cursor.repository_id
        AND active_item.ref = cursor.ref
        AND active_item.status IN ('pending', 'running')
        AND active_item.item_id <> json_extract(expected.value, '$.item_id')
    ) = json_extract(expected.value, '$.active_item_count')
), item_state_guard AS (
  SELECT 1 AS admitted
  WHERE (SELECT COUNT(*) FROM expected) > 0
    AND (SELECT COUNT(*) FROM expected) = (SELECT COUNT(*) FROM guarded)
    AND (SELECT COUNT(*) FROM expected) = (
      SELECT COUNT(DISTINCT json_extract(value, '$.item_id')) FROM expected
    )
    AND (SELECT COUNT(*) FROM expected) = (
      SELECT COUNT(DISTINCT json_extract(value, '$.ref')) FROM expected
    )
)`;

const DISPATCH_ITEM_FENCE_SQL = `${DISPATCH_ITEM_GUARD_CTES}
SELECT COUNT(*) AS mismatch_count
FROM expected
LEFT JOIN guarded
  ON json_extract(guarded.value, '$.item_id') =
       json_extract(expected.value, '$.item_id')
LEFT JOIN item_state_guard ON item_state_guard.admitted = 1
LEFT JOIN github_sync_dispatch_items AS item
  ON item.item_id = json_extract(expected.value, '$.item_id')
WHERE item_state_guard.admitted IS NULL
   OR guarded.value IS NULL
   OR item.item_id IS NULL
   OR item.dispatch_id <>
        json_extract(expected.payload, '$.dispatch.dispatch_id')
   OR item.project_id <>
        json_extract(expected.payload, '$.repository.project_id')
   OR item.repository_id <>
        json_extract(expected.payload, '$.repository.repository_id')
   OR item.ref <> json_extract(expected.value, '$.ref')
   OR item.scheduled_for <>
        json_extract(expected.payload, '$.dispatch.scheduled_for')
   OR item.full_reconciliation <>
        json_extract(expected.value, '$.full_reconciliation')
   OR item.repository_configuration_version <>
        json_extract(
          expected.payload,
          '$.repository.repository_configuration_version'
        )
   OR item.cursor_version <> json_extract(expected.value, '$.cursor_version')
   OR item.selected_head_manifest_id IS NOT
        json_extract(expected.value, '$.selected_head_manifest_id')
   OR item.selected_head_version <>
        json_extract(expected.value, '$.selected_head_version')
   OR item.repository_updated_at <>
        json_extract(expected.payload, '$.repository.repository_updated_at')
   OR item.cursor_status <> json_extract(expected.value, '$.cursor_status')
   OR item.cursor_updated_at <>
        json_extract(expected.value, '$.cursor_updated_at')
   OR item.workflow_instance_id <>
        json_extract(expected.value, '$.workflow_instance_id')
   OR item.status <> 'pending'
   OR item.run_id IS NOT NULL
   OR item.github_request_count <> 0
   OR item.github_request_overflow_count <> 0
   OR item.created_at <>
        json_extract(expected.payload, '$.dispatch.scheduled_for')
   OR item.completed_at IS NOT NULL
   OR item.last_error_code IS NOT NULL`;

export async function persistDispatchItems(
  database: D1Database,
  payload: GitHubDispatchWorkflowPayload,
  selectedRefs: GuardedScheduledRefRow[]
): Promise<number> {
  const items: PersistedDispatchItem[] = [];
  for (const selected of selectedRefs) {
    const fullReconciliation = requiresFullReconciliation(
      Date.parse(payload.scheduledFor),
      selected.last_sync_at
    );
    const identity = await githubRefWorkflowIdentity({
      dispatchId: payload.dispatchId,
      projectId: selected.project_id,
      repositoryId: selected.repository_id,
      ref: selected.ref,
      scheduledFor: payload.scheduledFor,
      fullReconciliation
    });
    items.push({
      itemId: identity.itemId,
      workflowInstanceId: identity.instanceId,
      selected,
      fullReconciliation
    });
  }
  const session = database.withSession("first-primary");
  for (const batch of chunkWorkflowBatch(items, 100)) {
    const first = batch[0];
    if (first === undefined) continue;
    if (
      batch.some(
        (item) =>
          item.selected.project_id !== first.selected.project_id ||
          item.selected.repository_id !== first.selected.repository_id
      )
    ) {
      throw new TypeError("A guarded dispatch item batch crossed repositories.");
    }
    const serialized = JSON.stringify({
      dispatch: {
        dispatch_id: payload.dispatchId,
        credential_version: payload.credentialVersion,
        scheduled_for: payload.scheduledFor,
        utc_date: payload.utcDate,
        created_at: payload.scheduledFor
      },
      repository: {
        project_id: first.selected.project_id,
        repository_id: first.selected.repository_id,
        external_id: first.selected.external_id,
        expected_owner_external_id:
          first.selected.expected_owner_external_id,
        owner: first.selected.owner,
        name: first.selected.name,
        default_branch: first.selected.default_branch,
        tracked_refs_json: first.selected.tracked_refs_json,
        repository_configuration_version:
          first.selected.repository_configuration_version,
        repository_updated_at: first.selected.repository_updated_at
      },
      items: batch.map((item) => ({
        item_id: item.itemId,
        ref: item.selected.ref,
        full_reconciliation: item.fullReconciliation ? 1 : 0,
        cursor_version: item.selected.cursor_version,
        selected_head_manifest_id: item.selected.selected_head_manifest_id,
        selected_head_version: item.selected.selected_head_version,
        cursor_status: item.selected.cursor_status,
        cursor_updated_at: item.selected.cursor_updated_at,
        cursor_state_json: item.selected.materialization_cursor_state_json,
        head_state_json: item.selected.materialization_head_state_json,
        active_item_count: item.selected.materialization_active_item_count,
        workflow_instance_id: item.workflowInstanceId
      }))
    });
    const insert = session.prepare(
      `${DISPATCH_ITEM_GUARD_CTES}
       INSERT INTO github_sync_dispatch_items
       (item_id, dispatch_id, project_id, repository_id, ref, scheduled_for,
        full_reconciliation, repository_configuration_version, cursor_version,
        selected_head_manifest_id, selected_head_version, repository_updated_at,
        cursor_status, cursor_updated_at, workflow_instance_id, status, created_at)
       SELECT json_extract(guarded.value, '$.item_id'),
              json_extract(expected.payload, '$.dispatch.dispatch_id'),
              json_extract(expected.payload, '$.repository.project_id'),
              json_extract(expected.payload, '$.repository.repository_id'),
              json_extract(guarded.value, '$.ref'),
              json_extract(expected.payload, '$.dispatch.scheduled_for'),
              json_extract(guarded.value, '$.full_reconciliation'),
              json_extract(
                expected.payload,
                '$.repository.repository_configuration_version'
              ),
              json_extract(guarded.value, '$.cursor_version'),
              json_extract(guarded.value, '$.selected_head_manifest_id'),
              json_extract(guarded.value, '$.selected_head_version'),
              json_extract(
                expected.payload,
                '$.repository.repository_updated_at'
              ),
              json_extract(guarded.value, '$.cursor_status'),
              json_extract(guarded.value, '$.cursor_updated_at'),
              json_extract(guarded.value, '$.workflow_instance_id'), 'pending',
              json_extract(expected.payload, '$.dispatch.scheduled_for')
       FROM guarded
       CROSS JOIN item_state_guard
       JOIN expected
         ON json_extract(expected.value, '$.item_id') =
              json_extract(guarded.value, '$.item_id')
       WHERE 1
       ON CONFLICT(item_id) DO NOTHING`
    ).bind(serialized);
    const fence = session.prepare(DISPATCH_ITEM_FENCE_SQL).bind(serialized);
    let mismatch: { mismatch_count: number } | null = null;
    try {
      const results = await session.batch<{ mismatch_count: number }>([
        insert,
        fence
      ]);
      mismatch = results[1]?.results[0] ?? null;
    } catch (error) {
      const recovered = await session.prepare(DISPATCH_ITEM_FENCE_SQL)
        .bind(serialized).first<{ mismatch_count: number }>();
      if (recovered?.mismatch_count === 0) continue;
      throw error;
    }
    if (mismatch?.mismatch_count !== 0) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
  }
  return items.length;
}
