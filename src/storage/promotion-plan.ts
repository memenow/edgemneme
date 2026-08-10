import type { MemoryClass, MemoryKind, MemoryScope } from "../contracts/taxonomy";
import type { RepositoryAuthority } from "../contracts/repository-context";
import { requireValidValidityInterval } from "../contracts/validity";
import type { SqlStatement } from "./mutation-plan";

export interface PromotionEvidence {
  evidenceId: string;
  sourceType: string;
  locator: string;
  excerptHash: string;
  commitSha?: string;
  repositoryId?: string;
  repositoryRef?: string;
  repositoryPath?: string;
  repositoryAuthority?: RepositoryAuthority;
}

interface CandidatePromotionInput {
  projectId: string;
  expectedProjectVersion: number;
  candidateId: string;
  expectedCandidateVersion: number;
  reviewRequestId: string;
  decisionId: string;
  memoryId: string;
  revisionId: string;
  actorPrincipalId: string;
  requestDigest: string;
  idempotencyKey: string;
  reason: string;
  content: string;
  contentSha256: string;
  kind: MemoryKind;
  memoryClass: MemoryClass;
  scope: MemoryScope;
  scopeId: string;
  repositoryId?: string;
  validFrom?: string;
  validUntil?: string;
  evidence: readonly PromotionEvidence[];
  previousAuditHash: string | null;
  auditHash: string;
  now: string;
}

export interface CandidatePromotionResponse {
  candidate_id: string;
  candidate_version: number;
  status: "promoted";
  memory_id: string;
  memory_version: 1;
  revision_id: string;
  project_version: number;
}

export interface CandidatePromotionPlan {
  nextProjectVersion: number;
  nextCandidateVersion: number;
  response: CandidatePromotionResponse;
  statements: readonly SqlStatement[];
}

export function buildCandidatePromotionPlan(
  input: CandidatePromotionInput
): CandidatePromotionPlan {
  if (input.evidence.length === 0) {
    throw new Error("Candidate promotion requires evidence.");
  }
  if (input.scope === "project" && input.repositoryId !== undefined) {
    throw new Error("Project promotion cannot have a repository context.");
  }
  if (input.scope !== "project" && input.repositoryId === undefined) {
    throw new Error("Non-project promotion requires a repository context.");
  }
  if (input.scope === "repository" && input.scopeId !== input.repositoryId) {
    throw new Error("Repository scope must match its repository context.");
  }
  requireValidValidityInterval({
    validFrom: input.validFrom,
    validUntil: input.validUntil
  });
  const nextProjectVersion = input.expectedProjectVersion + 1;
  const nextCandidateVersion = input.expectedCandidateVersion + 1;
  const auditId = `${input.projectId}:${nextProjectVersion}`;
  const guard =
    "EXISTS (SELECT 1 FROM projects WHERE project_id = ? AND project_version = ?)";
  const candidateGuard =
    "EXISTS (SELECT 1 FROM observations WHERE project_id = ? AND observation_id = ? " +
    "AND candidate_version = ? AND status IN ('pending_review', 'request_changes'))";
  const promotedGuard =
    "EXISTS (SELECT 1 FROM observations WHERE project_id = ? AND observation_id = ? " +
    "AND candidate_version = ? AND status = 'promoted' AND promoted_memory_id = ?)";
  const guardBindings = [input.projectId, input.expectedProjectVersion] as const;
  const response: CandidatePromotionResponse = {
    candidate_id: input.candidateId,
    candidate_version: nextCandidateVersion,
    status: "promoted",
    memory_id: input.memoryId,
    memory_version: 1,
    revision_id: input.revisionId,
    project_version: nextProjectVersion
  };
  const statements: SqlStatement[] = [
    {
      sql:
        `INSERT INTO audit_events
         (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
          previous_event_hash, event_hash, recorded_at)
         SELECT ?, ?, ?, 'candidate_promoted', ?, ?, ?, ?, ?
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
        `INSERT INTO memories
         (memory_id, project_id, current_revision_id, memory_version, kind, memory_class,
          scope, scope_id, status, created_at, updated_at)
         SELECT ?, ?, NULL, 0, ?, ?, ?, ?, 'active', ?, ?
         WHERE ${guard} AND ${candidateGuard}`,
      bindings: [
        input.memoryId,
        input.projectId,
        input.kind,
        input.memoryClass,
        input.scope,
        input.scopeId,
        input.now,
        input.now,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        input.expectedCandidateVersion
      ]
    }
  ];

  if (input.repositoryId !== undefined) {
    statements.push({
      sql:
        `INSERT INTO memory_repository_contexts
         (project_id, memory_id, repository_id, created_at)
         SELECT ?, ?, ?, ?
         WHERE ${guard} AND ${candidateGuard}`,
      bindings: [
        input.projectId,
        input.memoryId,
        input.repositoryId,
        input.now,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        input.expectedCandidateVersion
      ]
    });
  }

  statements.push(
    {
      sql:
        `INSERT INTO memory_versions
         (revision_id, project_id, memory_id, memory_version, content, content_sha256,
          valid_from, valid_until, audit_id, source_observation_id, recorded_at)
         SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?
         WHERE ${guard} AND ${candidateGuard}`,
      bindings: [
        input.revisionId,
        input.projectId,
        input.memoryId,
        input.content,
        input.contentSha256,
        input.validFrom ?? null,
        input.validUntil ?? null,
        auditId,
        input.candidateId,
        input.now,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        input.expectedCandidateVersion
      ]
    },
    {
      sql:
        `UPDATE memories
         SET current_revision_id = ?, memory_version = 1, updated_at = ?
         WHERE project_id = ? AND memory_id = ? AND memory_version = 0
           AND ${guard} AND ${candidateGuard}`,
      bindings: [
        input.revisionId,
        input.now,
        input.projectId,
        input.memoryId,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        input.expectedCandidateVersion
      ]
    }
  );

  for (const evidence of input.evidence) {
    statements.push(
      {
        sql:
          `INSERT INTO evidence
           (evidence_id, project_id, source_type, locator, repository_id, commit_sha,
            excerpt_hash, sensitivity_status, recorded_at, repository_ref,
            repository_path, repository_authority)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'clear', ?, ?, ?, ?
           WHERE ${guard} AND ${candidateGuard}
           ON CONFLICT(project_id, source_type, locator, excerpt_hash) DO NOTHING`,
        bindings: [
          evidence.evidenceId,
          input.projectId,
          evidence.sourceType,
          evidence.locator,
          evidence.repositoryId ?? null,
          evidence.commitSha ?? null,
          evidence.excerptHash,
          input.now,
          evidence.repositoryRef ?? null,
          evidence.repositoryPath ?? null,
          evidence.repositoryAuthority ?? null,
          ...guardBindings,
          input.projectId,
          input.candidateId,
          input.expectedCandidateVersion
        ]
      },
      {
        sql:
          `INSERT INTO version_evidence (project_id, revision_id, evidence_id)
           SELECT ?, ?, evidence_id FROM evidence
           WHERE project_id = ? AND source_type = ? AND locator = ? AND excerpt_hash = ?
             AND ${guard} AND ${candidateGuard}`,
        bindings: [
          input.projectId,
          input.revisionId,
          input.projectId,
          evidence.sourceType,
          evidence.locator,
          evidence.excerptHash,
          ...guardBindings,
          input.projectId,
          input.candidateId,
          input.expectedCandidateVersion
        ]
      }
    );
  }

  statements.push(
    {
      sql:
        `INSERT INTO review_decisions
         (decision_id, project_id, review_request_id, candidate_id, candidate_version,
          decision, reason, edits_json, actor_principal_id, audit_id, request_digest, created_at)
         SELECT ?, ?, ?, ?, ?, 'approve', ?, ?, ?, ?, ?, ?
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
        input.reason,
        JSON.stringify({
          content: input.content,
          kind: input.kind,
          memory_class: input.memoryClass,
          scope: input.scope,
          scope_id: input.scopeId,
          valid_from: input.validFrom ?? null,
          valid_until: input.validUntil ?? null
        }),
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
        `UPDATE review_requests
         SET status = 'approved', audit_id = ?, updated_at = ?
         WHERE project_id = ? AND review_request_id = ? AND candidate_id = ?
           AND status IN ('pending', 'changes_requested')
           AND ${guard} AND ${candidateGuard}`,
      bindings: [
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
         SET candidate_version = ?, status = 'promoted', reviewed_content = ?,
             promoted_memory_id = ?, promoted_revision_id = ?, review_reason = ?, updated_at = ?
         WHERE project_id = ? AND observation_id = ? AND candidate_version = ?
           AND status IN ('pending_review', 'request_changes') AND ${guard}`,
      bindings: [
        nextCandidateVersion,
        input.content,
        input.memoryId,
        input.revisionId,
        input.reason,
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
         WHERE ${guard} AND ${promotedGuard}`,
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
        input.memoryId
      ]
    },
    {
      sql:
        `INSERT INTO outbox_events
         (event_id, project_id, project_version, event_type, payload_digest,
          payload_json, created_at)
         SELECT ?, ?, ?, 'memory.changed', ?, ?, ?
         WHERE ${guard} AND ${promotedGuard}`,
      bindings: [
        auditId,
        input.projectId,
        nextProjectVersion,
        input.requestDigest,
        JSON.stringify({
          type: "memory.changed",
          eventId: auditId,
          projectId: input.projectId,
          memoryId: input.memoryId,
          projectVersion: nextProjectVersion
        }),
        input.now,
        ...guardBindings,
        input.projectId,
        input.candidateId,
        nextCandidateVersion,
        input.memoryId
      ]
    },
    {
      sql:
        `UPDATE projects SET project_version = ?, audit_head_hash = ?, updated_at = ?
         WHERE project_id = ? AND project_version = ?
           AND ${guard} AND ${promotedGuard}`,
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
        input.memoryId
      ]
    }
  );

  return {
    nextProjectVersion,
    nextCandidateVersion,
    response,
    statements
  };
}
