import { pendingGitHubSyncActivationGuardSql } from "./sync-activation-fence";

export function addedDeltaSql(): string {
  return `INSERT INTO github_tree_manifest_deltas
    (delta_id, project_id, repository_id, ref, old_manifest_id, new_manifest_id,
     path_digest, safe_path, change_kind, old_blob_sha, new_blob_sha,
     affected_memory_ids_json, idempotency_key, created_at)
   SELECT 'github-tree-delta:added:' || ? || ':' || new_entry.path_digest,
          ?, ?, ?, ?, ?, new_entry.path_digest, new_entry.safe_path, 'added',
          NULL, new_entry.blob_sha, '[]',
          json_array(?, ?, ?, ?, ?, new_entry.path_digest), ?
   FROM github_tree_manifest_entries AS new_entry
   WHERE new_entry.project_id = ? AND new_entry.manifest_id = ?
     AND (? IS NULL OR NOT EXISTS (
       SELECT 1 FROM github_tree_manifest_entries AS old_entry
       WHERE old_entry.project_id = new_entry.project_id
         AND old_entry.manifest_id = ?
         AND old_entry.path_digest = new_entry.path_digest
     ))
     AND (${coordinateActivationGuardSql()})
   ON CONFLICT(delta_id) DO UPDATE SET delta_id = excluded.delta_id`;
}

export function changedDeltaSql(): string {
  return `INSERT INTO github_tree_manifest_deltas
    (delta_id, project_id, repository_id, ref, old_manifest_id, new_manifest_id,
     path_digest, safe_path, change_kind, old_blob_sha, new_blob_sha,
     affected_memory_ids_json, idempotency_key, created_at)
   SELECT 'github-tree-delta:changed:' || ? || ':' || ? || ':' || new_entry.path_digest,
          ?, ?, ?, ?, ?, new_entry.path_digest, new_entry.safe_path, 'changed',
          old_entry.blob_sha, new_entry.blob_sha, '[]',
          json_array(?, ?, ?, ?, ?, new_entry.path_digest), ?
   FROM github_tree_manifest_entries AS new_entry
   JOIN github_tree_manifest_entries AS old_entry
     ON old_entry.project_id = new_entry.project_id
    AND old_entry.manifest_id = ?
    AND old_entry.path_digest = new_entry.path_digest
   WHERE new_entry.project_id = ? AND new_entry.manifest_id = ?
     AND old_entry.blob_sha <> new_entry.blob_sha
     AND (${coordinateActivationGuardSql()})
   ON CONFLICT(delta_id) DO UPDATE SET delta_id = excluded.delta_id`;
}

export function deletedDeltaSql(): string {
  return `INSERT INTO github_tree_manifest_deltas
    (delta_id, project_id, repository_id, ref, old_manifest_id, new_manifest_id,
     path_digest, safe_path, change_kind, old_blob_sha, new_blob_sha,
     affected_memory_ids_json, idempotency_key, created_at)
   SELECT 'github-tree-delta:deleted:' || ? || ':' || ? || ':' || old_entry.path_digest,
          ?, ?, ?, ?, ?, old_entry.path_digest, old_entry.safe_path, 'deleted',
          old_entry.blob_sha, NULL,
          COALESCE((
            SELECT json_group_array(affected.memory_id)
            FROM (
              SELECT DISTINCT memory.memory_id
              FROM memories AS memory
              JOIN memory_versions AS revision
                ON revision.project_id = memory.project_id
               AND revision.revision_id = memory.current_revision_id
              JOIN version_evidence AS revision_evidence
                ON revision_evidence.project_id = revision.project_id
               AND revision_evidence.revision_id = revision.revision_id
              JOIN evidence AS evidence_record
                ON evidence_record.project_id = revision_evidence.project_id
               AND evidence_record.evidence_id = revision_evidence.evidence_id
              WHERE memory.project_id = ?
                AND memory.status IN ('active', 'contested')
                AND evidence_record.repository_id = ?
                AND evidence_record.repository_ref = ?
                AND (
                  (old_entry.safe_path IS NOT NULL
                    AND evidence_record.repository_path = old_entry.safe_path)
                  OR
                  (old_entry.safe_path IS NULL
                    AND instr(
                      evidence_record.locator,
                      '/path-sha256/' || old_entry.path_digest
                    ) > 0)
                  OR
                  (old_entry.safe_path IS NULL
                    AND evidence_record.repository_path IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM github_tree_manifest_entries AS historical_entry
                      JOIN github_tree_manifests AS historical_manifest
                        ON historical_manifest.project_id = historical_entry.project_id
                       AND historical_manifest.manifest_id =
                         historical_entry.manifest_id
                      WHERE historical_entry.project_id = old_entry.project_id
                        AND historical_entry.path_digest = old_entry.path_digest
                        AND historical_entry.safe_path =
                          evidence_record.repository_path
                        AND historical_manifest.repository_id =
                          evidence_record.repository_id
                        AND historical_manifest.ref =
                          evidence_record.repository_ref
                        AND historical_manifest.status = 'complete'
                    ))
                )
              ORDER BY memory.memory_id
            ) AS affected
          ), '[]'),
          json_array(?, ?, ?, ?, ?, old_entry.path_digest), ?
   FROM github_tree_manifest_entries AS old_entry
   LEFT JOIN github_tree_manifest_entries AS new_entry
     ON new_entry.project_id = old_entry.project_id
    AND new_entry.manifest_id = ?
    AND new_entry.path_digest = old_entry.path_digest
   WHERE old_entry.project_id = ? AND old_entry.manifest_id = ?
     AND new_entry.path_digest IS NULL
     AND (${coordinateActivationGuardSql()})
   ON CONFLICT(delta_id) DO UPDATE SET delta_id = excluded.delta_id`;
}

export function deletionEvidenceSql(): string {
  return `INSERT INTO evidence
    (evidence_id, project_id, source_type, locator, repository_id, repository_ref,
     repository_path, repository_authority, commit_sha, excerpt_hash, object_uri,
     sensitivity_status, recorded_at)
   SELECT 'github-path-absent-evidence:' || delta.old_manifest_id || ':' ||
            delta.new_manifest_id || ':' || delta.path_digest,
          delta.project_id, 'repository_path_absent',
          'github://' || repository.external_id || '/' || manifest.observed_sha ||
            '/ref-sha256/' || ? || '/path-sha256/' || delta.path_digest,
          delta.repository_id, delta.ref, delta.safe_path,
          manifest.repository_authority, manifest.observed_sha, delta.path_digest,
          NULL, 'tombstone', ?
   FROM github_tree_manifest_deltas AS delta
   JOIN github_tree_manifests AS manifest
     ON manifest.project_id = delta.project_id
    AND manifest.manifest_id = delta.new_manifest_id
   JOIN repositories AS repository
     ON repository.project_id = delta.project_id
    AND repository.repository_id = delta.repository_id
   WHERE delta.project_id = ? AND delta.repository_id = ? AND delta.ref = ?
     AND delta.new_manifest_id = ? AND delta.change_kind = 'deleted'
     AND (${activationGuardSql()})
   ON CONFLICT(project_id, source_type, locator, excerpt_hash) DO UPDATE SET
     sensitivity_status = CASE
       WHEN evidence.evidence_id IS excluded.evidence_id
        AND evidence.repository_id IS excluded.repository_id
        AND evidence.repository_ref IS excluded.repository_ref
        AND evidence.repository_path IS excluded.repository_path
        AND evidence.repository_authority IS excluded.repository_authority
        AND evidence.commit_sha IS excluded.commit_sha
        AND evidence.object_uri IS excluded.object_uri
        AND evidence.sensitivity_status IS excluded.sensitivity_status
       THEN evidence.sensitivity_status
       ELSE 'github_activation_conflict'
     END`;
}

export function deletionObservationSql(): string {
  return `INSERT INTO observations
    (observation_id, project_id, candidate_version, status, content, content_sha256,
     evidence_json, kind, memory_class, scope, scope_id, analysis_json,
     review_reason, created_at, updated_at)
   SELECT 'github-path-absent-observation:' || delta.old_manifest_id || ':' ||
            delta.new_manifest_id || ':' || delta.path_digest,
          delta.project_id, 1, 'pending_review', NULL, NULL,
          json_array(json_object(
            'source_type', 'repository_path_absent',
            'locator', evidence_record.locator,
            'commit_sha', evidence_record.commit_sha,
            'excerpt_hash', evidence_record.excerpt_hash
          )),
          'fact', 'semantic',
          CASE manifest.repository_authority
            WHEN 'default_branch' THEN 'repository'
            ELSE 'ref'
          END,
          CASE manifest.repository_authority
            WHEN 'default_branch' THEN delta.repository_id
            ELSE (
              SELECT ownership.scope_id
              FROM canonical_repository_scope_ownership AS ownership
              WHERE ownership.project_id = delta.project_id
                AND ownership.repository_id = delta.repository_id
                AND ownership.scope_kind = 'ref'
                AND ownership.source_id = delta.ref
            )
          END,
          json_object(
            'schema', 'github.repository_path_absent',
            'repository_id', delta.repository_id,
            'repository_ref', delta.ref,
            'old_manifest_id', delta.old_manifest_id,
            'new_manifest_id', delta.new_manifest_id,
            'path_digest', delta.path_digest,
            'safe_path', delta.safe_path,
            'old_blob_sha', delta.old_blob_sha,
            'affected_memory_ids', json(delta.affected_memory_ids_json),
            'suggested_operation', 'invalidate'
          ),
          'A repository path disappeared. A maintainer must review any affected formal memories.',
          ?, ?
   FROM github_tree_manifest_deltas AS delta
   JOIN github_tree_manifests AS manifest
     ON manifest.project_id = delta.project_id
    AND manifest.manifest_id = delta.new_manifest_id
   JOIN evidence AS evidence_record
     ON evidence_record.project_id = delta.project_id
    AND evidence_record.evidence_id =
      'github-path-absent-evidence:' || delta.old_manifest_id || ':' ||
      delta.new_manifest_id || ':' || delta.path_digest
   WHERE delta.project_id = ? AND delta.repository_id = ? AND delta.ref = ?
     AND delta.new_manifest_id = ? AND delta.change_kind = 'deleted'
     AND (${activationGuardSql()})
   ON CONFLICT(project_id, observation_id) DO UPDATE SET
     candidate_version = CASE
       WHEN observations.session_id IS excluded.session_id
        AND observations.principal_id IS excluded.principal_id
        AND observations.candidate_version IS excluded.candidate_version
        AND observations.status IS excluded.status
        AND observations.content IS excluded.content
        AND observations.content_sha256 IS excluded.content_sha256
        AND observations.evidence_json IS excluded.evidence_json
        AND observations.kind IS excluded.kind
        AND observations.memory_class IS excluded.memory_class
        AND observations.scope IS excluded.scope
        AND observations.scope_id IS excluded.scope_id
        AND observations.valid_from IS excluded.valid_from
        AND observations.valid_until IS excluded.valid_until
        AND observations.analysis_json IS excluded.analysis_json
        AND observations.review_reason IS excluded.review_reason
        AND observations.reviewed_content IS excluded.reviewed_content
        AND observations.promoted_memory_id IS excluded.promoted_memory_id
        AND observations.promoted_revision_id IS excluded.promoted_revision_id
        AND observations.source_consolidation_id IS
          excluded.source_consolidation_id
       THEN observations.candidate_version
       ELSE 0
     END`;
}

export function deletionObservationEvidenceSql(): string {
  return `INSERT INTO observation_evidence
    (project_id, observation_id, evidence_id, created_at)
   SELECT delta.project_id,
          'github-path-absent-observation:' || delta.old_manifest_id || ':' ||
            delta.new_manifest_id || ':' || delta.path_digest,
          'github-path-absent-evidence:' || delta.old_manifest_id || ':' ||
            delta.new_manifest_id || ':' || delta.path_digest,
          ?
   FROM github_tree_manifest_deltas AS delta
   WHERE delta.project_id = ? AND delta.repository_id = ? AND delta.ref = ?
     AND delta.new_manifest_id = ? AND delta.change_kind = 'deleted'
     AND (${activationGuardSql()})
   ON CONFLICT(project_id, observation_id, evidence_id) DO UPDATE SET
     created_at = excluded.created_at`;
}

export function deletionReviewRequestSql(): string {
  return `INSERT INTO review_requests
    (review_request_id, project_id, candidate_id, conflict_id, status,
     required_role, audit_id, created_at, updated_at)
   SELECT 'github-path-absent-review:' || delta.old_manifest_id || ':' ||
            delta.new_manifest_id || ':' || delta.path_digest,
          delta.project_id,
          'github-path-absent-observation:' || delta.old_manifest_id || ':' ||
            delta.new_manifest_id || ':' || delta.path_digest,
          NULL, 'pending', 'maintainer', NULL, ?, ?
   FROM github_tree_manifest_deltas AS delta
   WHERE delta.project_id = ? AND delta.repository_id = ? AND delta.ref = ?
     AND delta.new_manifest_id = ? AND delta.change_kind = 'deleted'
     AND (${activationGuardSql()})
   ON CONFLICT(project_id, candidate_id) DO UPDATE SET
     status = CASE
       WHEN review_requests.review_request_id IS excluded.review_request_id
        AND review_requests.conflict_id IS excluded.conflict_id
        AND review_requests.status IS excluded.status
        AND review_requests.required_role IS excluded.required_role
        AND review_requests.audit_id IS excluded.audit_id
       THEN review_requests.status
       ELSE 'github_activation_conflict'
     END`;
}

function activationGuardSql(): string {
  return pendingGitHubSyncActivationGuardSql();
}

function coordinateActivationGuardSql(): string {
  return pendingGitHubSyncActivationGuardSql();
}
