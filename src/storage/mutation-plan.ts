import { requireValidValidityInterval } from "../contracts/validity";

export type MemoryChangeOperation = "correct" | "invalidate" | "rollback";

interface MutationInput {
  operation: MemoryChangeOperation;
  projectId: string;
  expectedProjectVersion: number;
  memoryId: string;
  expectedMemoryVersion: number;
  revisionId: string;
  actorPrincipalId: string;
  requestDigest: string;
  content: string;
  contentSha256: string;
  validFrom: string | null;
  validUntil: string | null;
  now: string;
  idempotencyKey?: string;
  nextStatus?: "active" | "invalidated";
  previousAuditHash?: string | null;
  auditHash?: string;
}

export interface SqlStatement {
  sql: string;
  bindings: readonly unknown[];
}

export interface MemoryMutationPlan {
  nextProjectVersion: number;
  nextMemoryVersion: number;
  statements: readonly SqlStatement[];
}

export function buildMemoryMutationPlan(input: MutationInput): MemoryMutationPlan {
  requireValidValidityInterval({
    validFrom: input.validFrom,
    validUntil: input.validUntil
  });
  const nextProjectVersion = input.expectedProjectVersion + 1;
  const nextMemoryVersion = input.expectedMemoryVersion + 1;
  const auditId = `${input.projectId}:${nextProjectVersion}`;
  const idempotencyKey = input.idempotencyKey ?? input.requestDigest;
  const nextStatus = input.nextStatus ?? "active";
  const previousAuditHash = input.previousAuditHash ?? null;
  const auditHash = input.auditHash ?? input.requestDigest;
  const guardBindings = [input.projectId, input.expectedProjectVersion] as const;
  const guard = "EXISTS (SELECT 1 FROM projects WHERE project_id = ? AND project_version = ?)";

  return {
    nextProjectVersion,
    nextMemoryVersion,
    statements: [
      {
        sql:
          `INSERT INTO audit_events
           (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
            previous_event_hash, event_hash, recorded_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        bindings: [
          auditId,
          input.projectId,
          nextProjectVersion,
          input.operation,
          input.actorPrincipalId,
          input.requestDigest,
          previousAuditHash,
          auditHash,
          input.now,
          ...guardBindings
        ]
      },
      {
        sql:
          `INSERT INTO memory_versions
           (revision_id, project_id, memory_id, memory_version, content, content_sha256,
            valid_from, valid_until, audit_id, recorded_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        bindings: [
          input.revisionId,
          input.projectId,
          input.memoryId,
          nextMemoryVersion,
          input.content,
          input.contentSha256,
          input.validFrom,
          input.validUntil,
          auditId,
          input.now,
          ...guardBindings
        ]
      },
      {
        sql:
          `UPDATE memories SET current_revision_id = ?, memory_version = ?, status = ?, updated_at = ? ` +
          `WHERE project_id = ? AND memory_id = ? AND memory_version = ? AND ${guard}`,
        bindings: [
          input.revisionId,
          nextMemoryVersion,
          nextStatus,
          input.now,
          input.projectId,
          input.memoryId,
          input.expectedMemoryVersion,
          ...guardBindings
        ]
      },
      {
        sql:
          `INSERT INTO idempotency_records
           (project_id, principal_id, operation, idempotency_key, request_digest, response_json, audit_id, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        bindings: [
          input.projectId,
          input.actorPrincipalId,
          `memory_${input.operation}`,
          idempotencyKey,
          input.requestDigest,
          JSON.stringify({
            memory_id: input.memoryId,
            memory_version: nextMemoryVersion,
            project_version: nextProjectVersion,
            revision_id: input.revisionId
          }),
          auditId,
          input.now,
          ...guardBindings
        ]
      },
      {
        sql:
          `INSERT INTO outbox_events
           (event_id, project_id, project_version, event_type, payload_digest, payload_json, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        bindings: [
          auditId,
          input.projectId,
          nextProjectVersion,
          "memory.changed",
          input.requestDigest,
          JSON.stringify({
            type: "memory.changed",
            eventId: auditId,
            projectId: input.projectId,
            memoryId: input.memoryId,
            projectVersion: nextProjectVersion
          }),
          input.now,
          ...guardBindings
        ]
      },
      {
        sql:
          `UPDATE projects SET project_version = ?, audit_head_hash = ?, updated_at = ? ` +
          `WHERE project_id = ? AND project_version = ? AND ${guard}`,
        bindings: [
          nextProjectVersion,
          auditHash,
          input.now,
          input.projectId,
          input.expectedProjectVersion,
          ...guardBindings
        ]
      }
    ]
  };
}
