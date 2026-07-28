import type { SqlStatement } from "./mutation-plan";

interface CandidateReviewInput {
  projectId: string;
  expectedProjectVersion: number;
  candidateId: string;
  expectedCandidateVersion: number;
  reviewRequestId: string;
  decisionId: string;
  actorPrincipalId: string;
  requestDigest: string;
  idempotencyKey: string;
  decision: "reject" | "request_changes";
  reason: string;
  editsJson?: string;
  reviewedContent?: string;
  previousAuditHash: string | null;
  auditHash: string;
  now: string;
}

export interface CandidateReviewResponse {
  candidate_id: string;
  candidate_version: number;
  status: "rejected" | "request_changes";
  project_version: number;
}

export interface CandidateReviewPlan {
  nextProjectVersion: number;
  nextCandidateVersion: number;
  response: CandidateReviewResponse;
  statements: readonly SqlStatement[];
}

export function buildCandidateReviewPlan(input: CandidateReviewInput): CandidateReviewPlan {
  const nextProjectVersion = input.expectedProjectVersion + 1;
  const nextCandidateVersion = input.expectedCandidateVersion + 1;
  const auditId = `${input.projectId}:${nextProjectVersion}`;
  const status = input.decision === "reject" ? "rejected" : "request_changes";
  const reviewStatus = input.decision === "reject" ? "rejected" : "changes_requested";
  const guard =
    "EXISTS (SELECT 1 FROM projects WHERE project_id = ? AND project_version = ?)";
  const candidateGuard =
    "EXISTS (SELECT 1 FROM observations WHERE project_id = ? AND observation_id = ? " +
    "AND candidate_version = ? AND status IN ('pending_review', 'request_changes'))";
  const reviewedGuard =
    "EXISTS (SELECT 1 FROM observations WHERE project_id = ? AND observation_id = ? " +
    "AND candidate_version = ? AND status = ?)";
  const guardBindings = [input.projectId, input.expectedProjectVersion] as const;
  const response: CandidateReviewResponse = {
    candidate_id: input.candidateId,
    candidate_version: nextCandidateVersion,
    status,
    project_version: nextProjectVersion
  };
  const statements: SqlStatement[] = [
    {
      sql:
        `INSERT INTO audit_events
         (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
          previous_event_hash, event_hash, recorded_at)
         SELECT ?, ?, ?, 'candidate_reviewed', ?, ?, ?, ?, ?
         WHERE ${guard} AND ${candidateGuard}`,
      bindings: [
        auditId,
        input.projectId,
        nextProjectVersion,
        input.actorPrincipalId,
        input.requestDigest,
        input.previousAuditHash,
        input.auditHash,
        input.now,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        input.expectedCandidateVersion
      ]
    },
    {
      sql:
        `INSERT INTO review_decisions
         (decision_id, project_id, review_request_id, candidate_id, candidate_version,
          decision, reason, edits_json, actor_principal_id, audit_id, request_digest, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${guard} AND ${candidateGuard}
           AND EXISTS (
             SELECT 1 FROM review_requests
             WHERE project_id = ? AND review_request_id = ? AND candidate_id = ?
               AND status IN ('pending', 'changes_requested')
           )`,
      bindings: [
        input.decisionId,
        input.projectId,
        input.reviewRequestId,
        input.candidateId,
        nextCandidateVersion,
        input.decision,
        input.reason,
        input.editsJson ?? null,
        input.actorPrincipalId,
        auditId,
        input.requestDigest,
        input.now,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        input.expectedCandidateVersion,
        input.projectId,
        input.reviewRequestId,
        input.candidateId
      ]
    },
    {
      sql:
        `UPDATE review_requests SET status = ?, audit_id = ?, updated_at = ?
         WHERE project_id = ? AND review_request_id = ? AND candidate_id = ?
           AND status IN ('pending', 'changes_requested')
           AND ${guard} AND ${candidateGuard}`,
      bindings: [
        reviewStatus,
        auditId,
        input.now,
        input.projectId,
        input.reviewRequestId,
        input.candidateId,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        input.expectedCandidateVersion
      ]
    },
    {
      sql:
        `UPDATE observations
         SET candidate_version = ?, status = ?, review_reason = ?,
             reviewed_content = COALESCE(?, reviewed_content),
             updated_at = ?
         WHERE project_id = ? AND observation_id = ? AND candidate_version = ?
           AND status IN ('pending_review', 'request_changes') AND ${guard}`,
      bindings: [
        nextCandidateVersion,
        status,
        input.reason,
        input.reviewedContent ?? null,
        input.now,
        input.projectId,
        input.candidateId,
        input.expectedCandidateVersion,
        ...guardBindings
      ]
    },
    {
      sql:
        `INSERT INTO idempotency_records
         (project_id, principal_id, operation, idempotency_key, request_digest,
          response_json, audit_id, created_at)
         SELECT ?, ?, 'candidate_review', ?, ?, ?, ?, ?
         WHERE ${guard} AND ${reviewedGuard}`,
      bindings: [
        input.projectId,
        input.actorPrincipalId,
        input.idempotencyKey,
        input.requestDigest,
        JSON.stringify(response),
        auditId,
        input.now,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        nextCandidateVersion,
        status
      ]
    },
    {
      sql:
        `INSERT INTO outbox_events
         (event_id, project_id, project_version, event_type, payload_digest,
          payload_json, created_at)
         SELECT ?, ?, ?, 'candidate.reviewed', ?, ?, ?
         WHERE ${guard} AND ${reviewedGuard}`,
      bindings: [
        auditId,
        input.projectId,
        nextProjectVersion,
        input.requestDigest,
        JSON.stringify({
          type: "candidate.reviewed",
          eventId: auditId,
          projectId: input.projectId,
          candidateId: input.candidateId,
          projectVersion: nextProjectVersion
        }),
        input.now,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        nextCandidateVersion,
        status
      ]
    },
    {
      sql:
        `UPDATE projects SET project_version = ?, audit_head_hash = ?, updated_at = ?
         WHERE project_id = ? AND project_version = ?
           AND ${guard} AND ${reviewedGuard}`,
      bindings: [
        nextProjectVersion,
        input.auditHash,
        input.now,
        input.projectId,
        input.expectedProjectVersion,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        nextCandidateVersion,
        status
      ]
    }
  ];
  return { nextProjectVersion, nextCandidateVersion, response, statements };
}
