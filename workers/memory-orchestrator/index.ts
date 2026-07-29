import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { z } from "zod";
import { EdgeMnemeError, errorBody } from "../../src/contracts/errors";
import type { MemoryEvent } from "../../src/gateway/service";
import { canonicalJson } from "../../src/security/canonical-json";
import { sha256 } from "../../src/security/crypto";
import {
  buildMutationEvidencePlan,
  sameMutationEvidenceProvenance,
  type MutationEvidenceRecord,
  type StoredMutationEvidenceProvenance
} from "../../src/storage/mutation-evidence-plan";
import { buildMemoryMutationPlan } from "../../src/storage/mutation-plan";
import { buildCandidatePromotionPlan } from "../../src/storage/promotion-plan";
import { buildCandidateReviewPlan } from "../../src/storage/review-plan";
import {
  inspectMemoryModelInput,
  inspectMemoryModelValue,
  MEMORY_MODEL_INPUT_MAX_BYTES
} from "../../src/quality/sensitive-content";
import {
  consolidateSession,
  processCandidateSubmission,
  type CandidateAnalysisDiagnosticCode
} from "../../src/workflows/quality";
import {
  ensureWorkflowWithRepair,
  WorkflowControlPlaneStatusError,
  WorkflowRepairExhaustedError
} from "../../src/workflows/recovery";
import {
  isProjectWorkAdmitted,
  reapExpiredSyntheticProjects
} from "../../src/workflows/synthetic-cleanup";
import { publishProjectProjection } from "../../src/projection/cloudflare";
import {
  publishMemorySearchProjection,
  SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT
} from "../../src/search/indexing";
import { reapSearchVectorCleanupReceipts } from "../../src/search/vector-cleanup-janitor";
import {
  calculateProjectionSnapshotCapacityAfterChange,
  checkProjectionSnapshotCapacity,
  readProjectionSnapshotAuthority,
  runProjectionRebuild,
  type ProjectionRebuildRequest
} from "../../src/projection/rebuild";
import {
  parseProjectionRebuildDispatch,
  PROJECTION_REBUILD_OUTBOX_DISPATCH_LIMIT,
  throttleProjectionWorkflowStart
} from "../../src/projection/rebuild-dispatch";
import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryScope
} from "../../src/contracts/taxonomy";
import { isValidValidityInterval } from "../../src/contracts/validity";
import {
  parseRefScopeId,
  parseWorktreeScopeId
} from "../../src/contracts/scope";
import {
  REPOSITORY_AUTHORITIES,
  resolveMemoryChangeRepositoryContext,
  resolveScopeRepositoryOwnership,
  type MemoryChangeRepositoryContext,
  type RepositoryAuthority
} from "../../src/contracts/repository-context";

interface WorkflowPayload {
  eventId: string;
  projectId: string;
  type: MemoryEvent["type"] | "memory.changed" | "projection.rebuild.requested";
  subjectId: string;
  observedSha?: string;
  ref?: string;
  projectVersion?: number;
  projectionRebuild?: ProjectionRebuildRequest;
}

const PROJECTION_REBUILD_RECONCILIATION_LIMIT = 20;
const PROJECTION_REBUILD_RECONCILIATION_DELAY_MS = 5 * 60 * 1_000;
const PROJECTION_REBUILD_UNKNOWN_ALERT_THRESHOLD = 12;
const PROJECTION_REBUILD_UNKNOWN_ERROR_CODE =
  "PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN";
const PROJECTION_WORKFLOW_MAX_REPAIRS = 3;
const PROJECTION_REBUILD_TERMINAL_STATUSES = new Set(["complete", "failed", "terminated"]);
const PROJECTION_WORKFLOW_REPAIRABLE_TERMINAL_STATUSES = new Set([
  "errored",
  "terminated"
]);
const PROJECTION_WORKFLOW_KNOWN_NONTERMINAL_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused"
]);
const ORDINARY_WORKFLOW_RECONCILIATION_LIMIT = 20;
const ORDINARY_WORKFLOW_RECONCILIATION_DELAY_MS = 5 * 60 * 1_000;
const ORDINARY_WORKFLOW_MAX_REPAIRS = 3;
const ORDINARY_WORKFLOW_KNOWN_NONTERMINAL_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused"
]);

interface Env {
  MEMORY_DB: D1Database;
  SEARCH_DB: D1Database;
  PROJECTIONS: R2Bucket;
  MEMORY_VECTORS: VectorizeIndex;
  AI: Ai;
  MEMORY_WORKFLOW: Workflow<WorkflowPayload>;
  MEMORY_OUTBOX: Queue<MemoryEvent>;
}


const mutationRepositoryContextSchema = z
  .object({
    scope: z.enum(MEMORY_SCOPES),
    scope_id: z.string().min(1).max(2048),
    repository_id: z.string().min(1).nullable(),
    repository_ref: z.string().min(1).max(2048).nullable(),
    session_id: z.string().min(1).max(2048).nullable(),
    worktree_id: z.string().min(1).max(2048).nullable()
  })
  .strict();

const mutationSchema = z.object({
  operation: z.enum(["correct", "invalidate", "rollback"]),
  target_memory_id: z.string().uuid(),
  expected_memory_version: z.number().int().positive(),
  expected_project_version: z.number().int().nonnegative(),
  project_id: z.string().min(1),
  actor_principal_id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  evidence: z
    .array(
      z.object({
        source_type: z.string().min(1).max(64),
        locator: z.string().min(1).max(2048),
        commit_sha: z.string().regex(/^[A-Fa-f0-9]{40,64}$/u).optional(),
        excerpt_hash: z.string().regex(/^[A-Fa-f0-9]{64}$/u).optional()
      })
    )
    .min(1)
    .max(50),
  target_repository_context: mutationRepositoryContextSchema.optional(),
  idempotency_key: z.string().min(8).max(256)
});

const candidateReviewSchema = z.object({
  candidate_id: z.string().uuid(),
  expected_candidate_version: z.number().int().positive(),
  decision: z.enum(["approve", "reject", "request_changes"]),
  reason: z.string().min(1).max(4096),
  edits: z
    .object({
      content: z.string().min(1).max(65_536).optional(),
      kind: z.enum(MEMORY_KINDS).optional(),
      memory_class: z.enum(MEMORY_CLASSES).optional(),
      scope: z.enum(MEMORY_SCOPES).optional(),
      scope_id: z.string().min(1).max(2048).optional(),
      valid_from: z.iso.datetime({ offset: true }).nullable().optional(),
      valid_until: z.iso.datetime({ offset: true }).nullable().optional()
    })
    .strict()
    .nullable(),
  idempotency_key: z.string().min(8).max(256),
  project_id: z.string().min(1),
  actor_principal_id: z.string().min(1)
});

const candidateReviewEvidenceSchema = z
  .object({
    persistent_value: z.literal(true),
    evidence_source_ids: z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(50)
      .refine(
        (evidenceIds) => new Set(evidenceIds).size === evidenceIds.length,
        "Cited evidence IDs must be unique."
      )
  })
  .passthrough();

interface CandidateSessionProvenance {
  sessionId: string;
  repositoryId: string | null;
  repositoryRef: string | null;
  worktreeId: string | null;
}

interface CandidateEvidenceProvenance {
  evidenceId: string;
  repositoryId: string | null;
  repositoryRef: string | null;
  repositoryPath: string | null;
  repositoryAuthority: RepositoryAuthority | null;
}

interface CandidatePromotionProvenanceInput {
  scope: MemoryScope;
  scopeId: string;
  targetRepositoryId: string | null;
  candidateSession: CandidateSessionProvenance | null;
  evidence: readonly CandidateEvidenceProvenance[];
}

export function requireCandidatePromotionProvenance(
  input: CandidatePromotionProvenanceInput
): string | null {
  if (input.evidence.length === 0) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "Approval requires at least one clear evidence record."
    );
  }

  if (input.scope === "project") {
    return null;
  }
  const targetRepositoryId = input.targetRepositoryId;
  if (targetRepositoryId === null) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "The formal memory scope has no trusted repository ownership."
    );
  }

  const session = input.candidateSession;
  if (
    session !== null &&
    session.repositoryId !== null &&
    session.repositoryId !== targetRepositoryId
  ) {
    throw scopeProvenanceConflict(input.scope);
  }

  let hasTrustedRepositoryContext = session?.repositoryId === targetRepositoryId;
  for (const evidence of input.evidence) {
    if (
      evidence.repositoryId === null &&
      (evidence.repositoryRef !== null ||
        evidence.repositoryPath !== null ||
        evidence.repositoryAuthority !== null)
    ) {
      throw new EdgeMnemeError(
        "VALIDATION_FAILED",
        "The candidate evidence has an incomplete repository context."
      );
    }
    if (evidence.repositoryId !== null && evidence.repositoryAuthority === null) {
      throw new EdgeMnemeError(
        "VALIDATION_FAILED",
        "The candidate evidence has an incomplete repository context."
      );
    }
    if (evidence.repositoryId !== null && evidence.repositoryId !== targetRepositoryId) {
      throw scopeProvenanceConflict(input.scope);
    }
    hasTrustedRepositoryContext ||= evidence.repositoryId === targetRepositoryId;
  }

  if (!hasTrustedRepositoryContext) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "Repository-scoped approval requires trusted repository provenance."
    );
  }

  if (input.scope === "repository") {
    return targetRepositoryId;
  }
  if (input.scope === "ref") {
    const parsed = parseRefScopeId(input.scopeId);
    if (parsed === null || parsed.repositoryId !== targetRepositoryId) {
      throw scopeProvenanceConflict("ref");
    }
    let hasExactRef = false;
    if (session?.repositoryId === targetRepositoryId && session.repositoryRef !== null) {
      if (session.repositoryRef !== parsed.ref) {
        throw scopeProvenanceConflict("ref");
      }
      hasExactRef = true;
    }
    for (const evidence of input.evidence) {
      if (evidence.repositoryId === targetRepositoryId && evidence.repositoryRef !== null) {
        if (evidence.repositoryRef !== parsed.ref) {
          throw scopeProvenanceConflict("ref");
        }
        hasExactRef = true;
      }
    }
    if (!hasExactRef) {
      throw new EdgeMnemeError(
        "VALIDATION_FAILED",
        "Ref-scoped approval requires exact trusted ref provenance."
      );
    }
    return targetRepositoryId;
  }
  if (input.scope === "session") {
    if (
      session === null ||
      session.sessionId !== input.scopeId ||
      session.repositoryId !== targetRepositoryId
    ) {
      throw scopeProvenanceConflict("session");
    }
    return targetRepositoryId;
  }

  const parsed = parseWorktreeScopeId(input.scopeId);
  if (
    parsed === null ||
    session === null ||
    session.sessionId !== parsed.sessionId ||
    session.worktreeId !== parsed.worktreeId ||
    session.repositoryId !== targetRepositoryId
  ) {
    throw scopeProvenanceConflict("worktree");
  }
  return targetRepositoryId;
}

function requireCandidateCitedEvidenceIds(analysisJson: string | null): string[] {
  if (analysisJson === null) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "Approval requires a validated evidence citation set."
    );
  }
  try {
    return candidateReviewEvidenceSchema.parse(JSON.parse(analysisJson)).evidence_source_ids;
  } catch {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "Approval requires a validated evidence citation set."
    );
  }
}

function scopeProvenanceConflict(scope: MemoryScope): EdgeMnemeError {
  return new EdgeMnemeError(
    "VALIDATION_FAILED",
    `The candidate provenance conflicts with the requested ${scope} scope.`
  );
}

function sameMutationRepositoryContext(
  trusted: MemoryChangeRepositoryContext,
  supplied: z.infer<typeof mutationRepositoryContextSchema>
): boolean {
  return (
    trusted.scope === supplied.scope &&
    trusted.scopeId === supplied.scope_id &&
    trusted.repositoryId === supplied.repository_id &&
    trusted.repositoryRef === supplied.repository_ref &&
    trusted.sessionId === supplied.session_id &&
    trusted.worktreeId === supplied.worktree_id
  );
}

function namespaceMutationEvidenceLocator(
  locator: string,
  projectId: string,
  context: MemoryChangeRepositoryContext
): string {
  const owner =
    context.repositoryId === null
      ? `project:${encodeURIComponent(projectId)}`
      : `repository:${encodeURIComponent(context.repositoryId)}`;
  return `${owner}:scope:${context.scope}:${encodeURIComponent(context.scopeId)}:${locator}`;
}

function mutationEvidenceConflict(): EdgeMnemeError {
  return new EdgeMnemeError(
    "VALIDATION_FAILED",
    "The submitted evidence conflicts with existing immutable provenance."
  );
}

function projectionCapacityExceeded(): EdgeMnemeError {
  return new EdgeMnemeError(
    "VALIDATION_FAILED",
    "The project cannot accept this formal memory because projection capacity would be exceeded."
  );
}

async function requireFormalProjectionCapacity(input: {
  database: D1Database;
  projectId: string;
  expectedProjectVersion: number;
  content: string;
  addsMemory: boolean;
  scopeId: string | null;
}): Promise<void> {
  const authority = await readProjectionSnapshotAuthority(
    input.database.withSession("first-primary"),
    input.projectId,
    input.expectedProjectVersion,
    input.scopeId
  );
  if (authority === null) {
    throw new EdgeMnemeError("VERSION_CONFLICT", "The expected version is stale.");
  }
  if (authority.scope_exists !== 0 && authority.scope_exists !== 1) {
    throw projectionCapacityExceeded();
  }
  try {
    const capacity = calculateProjectionSnapshotCapacityAfterChange(authority, {
      memoryCount: input.addsMemory ? 1 : 0,
      revisionCount: 1,
      scopeCount: input.addsMemory && authority.scope_exists === 0 ? 1 : 0,
      contentBytes: new TextEncoder().encode(input.content).byteLength
    });
    if (!capacity.accepted) {
      throw projectionCapacityExceeded();
    }
  } catch (error) {
    if (error instanceof EdgeMnemeError) {
      throw error;
    }
    throw projectionCapacityExceeded();
  }
}

export class ProjectCoordinator extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const path = new URL(request.url).pathname;
      if (request.method !== "POST" || !["/mutate", "/candidate-review"].includes(path)) {
        return new Response("Not Found", { status: 404 });
      }
      if (path === "/candidate-review") {
        return Response.json(await this.reviewCandidate(await request.json()));
      }
      const input = mutationSchema.parse(await request.json());
      await requireProjectMaintainer(
        this.env.MEMORY_DB,
        input.project_id,
        input.actor_principal_id
      );
      const targetRepositoryContext = await resolveMemoryChangeRepositoryContext(
        this.env.MEMORY_DB,
        input.project_id,
        input.target_memory_id
      );
      if (
        targetRepositoryContext === null ||
        (input.target_repository_context !== undefined &&
          !sameMutationRepositoryContext(
            targetRepositoryContext,
            input.target_repository_context
          ))
      ) {
        throw new EdgeMnemeError(
          "VALIDATION_FAILED",
          "The target memory repository context is invalid."
        );
      }
      const { target_repository_context: _serverContext, ...clientMutation } = input;
      const payloadDigest = await sha256(canonicalJson(clientMutation));
      const existing = await this.env.MEMORY_DB.prepare(
        `SELECT request_digest, response_json FROM idempotency_records
         WHERE project_id = ? AND principal_id = ? AND operation = ?
           AND idempotency_key = ?`
      )
        .bind(
          input.project_id,
          input.actor_principal_id,
          `memory_${input.operation}`,
          input.idempotency_key
        )
        .first<{ request_digest: string; response_json: string }>();
      if (existing !== null) {
        if (existing.request_digest !== payloadDigest) {
          throw new EdgeMnemeError(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used with a different payload."
          );
        }
        const response = JSON.parse(existing.response_json) as {
          memory_id: string;
          project_version: number;
        };
        await ensureProjectionWorkflow(
          this.env,
          input.project_id,
          response.memory_id,
          response.project_version
        );
        return Response.json(response);
      }

      const current = await this.env.MEMORY_DB.withSession("first-primary")
        .prepare(
          `SELECT p.project_version, p.audit_head_hash, m.memory_version, v.content,
                  v.valid_from, v.valid_until
           FROM projects p JOIN memories m ON m.project_id = p.project_id
           JOIN memory_versions v ON v.revision_id = m.current_revision_id
           WHERE p.project_id = ? AND m.memory_id = ?`
        )
        .bind(input.project_id, input.target_memory_id)
        .first<{
          project_version: number;
          audit_head_hash: string | null;
          memory_version: number;
          content: string;
          valid_from: string | null;
          valid_until: string | null;
        }>();
      if (
        current === null ||
        current.project_version !== input.expected_project_version ||
        current.memory_version !== input.expected_memory_version
      ) {
        throw new EdgeMnemeError("VERSION_CONFLICT", "The expected version is stale.");
      }

      const revision = await resolveMutationRevision(input, current, this.env.MEMORY_DB);
      if (!inspectMemoryModelInput(revision.content).accepted) {
        throw new EdgeMnemeError(
          "VALIDATION_FAILED",
          "The submitted data cannot be persisted safely."
        );
      }
      await requireFormalProjectionCapacity({
        database: this.env.MEMORY_DB,
        projectId: input.project_id,
        expectedProjectVersion: input.expected_project_version,
        content: revision.content,
        addsMemory: false,
        scopeId: null
      });
      const now = new Date().toISOString();
      const revisionId = crypto.randomUUID();
      const nextProjectVersion = input.expected_project_version + 1;
      const auditHash = await sha256(
        `${current.audit_head_hash ?? ""}\n${payloadDigest}\n${nextProjectVersion}`
      );
      const plan = buildMemoryMutationPlan({
        operation: input.operation,
        projectId: input.project_id,
        expectedProjectVersion: input.expected_project_version,
        memoryId: input.target_memory_id,
        expectedMemoryVersion: input.expected_memory_version,
        revisionId,
        actorPrincipalId: input.actor_principal_id,
        requestDigest: payloadDigest,
        content: revision.content,
        contentSha256: await sha256(revision.content),
        validFrom: revision.validFrom,
        validUntil: revision.validUntil,
        now,
        idempotencyKey: input.idempotency_key,
        nextStatus: input.operation === "invalidate" ? "invalidated" : "active",
        previousAuditHash: current.audit_head_hash,
        auditHash
      });
      const repositoryAuthority =
        targetRepositoryContext.repositoryId === null ? null : "agent_supplied";
      const evidenceByTuple = new Map<string, MutationEvidenceRecord>();
      for (const item of input.evidence) {
        const locator = namespaceMutationEvidenceLocator(
          item.locator,
          input.project_id,
          targetRepositoryContext
        );
        const excerptHash = item.excerpt_hash ?? (await sha256(locator));
        const tupleKey = canonicalJson([item.source_type, locator, excerptHash]);
        const record: MutationEvidenceRecord = {
          evidenceId: await sha256(
            `${input.project_id}\n${item.source_type}\n${locator}\n${excerptHash}`
          ),
          sourceType: item.source_type,
          locator,
          commitSha: item.commit_sha ?? null,
          excerptHash,
          repositoryId: targetRepositoryContext.repositoryId,
          repositoryRef: targetRepositoryContext.repositoryRef,
          repositoryAuthority
        };
        const duplicate = evidenceByTuple.get(tupleKey);
        if (duplicate !== undefined) {
          if (!sameMutationEvidenceProvenance(record, {
            commit_sha: duplicate.commitSha,
            repository_id: duplicate.repositoryId,
            repository_ref: duplicate.repositoryRef,
            repository_path: null,
            repository_authority: duplicate.repositoryAuthority,
            sensitivity_status: "clear"
          })) {
            throw mutationEvidenceConflict();
          }
          continue;
        }
        evidenceByTuple.set(tupleKey, record);
      }
      const evidenceRecords = [...evidenceByTuple.values()];
      const primaryDatabase = this.env.MEMORY_DB.withSession("first-primary");
      await Promise.all(
        evidenceRecords.map(async (record) => {
          const stored = await primaryDatabase.prepare(
            `SELECT commit_sha, repository_id, repository_ref, repository_path,
                    repository_authority, sensitivity_status
             FROM evidence
             WHERE project_id = ? AND source_type = ? AND locator = ? AND excerpt_hash = ?`
          )
            .bind(
              input.project_id,
              record.sourceType,
              record.locator,
              record.excerptHash
            )
            .first<StoredMutationEvidenceProvenance>();
          if (stored !== null && !sameMutationEvidenceProvenance(record, stored)) {
            throw mutationEvidenceConflict();
          }
        })
      );

      const evidencePlan = buildMutationEvidencePlan({
        projectId: input.project_id,
        expectedProjectVersion: input.expected_project_version,
        revisionId,
        recordedAt: now,
        evidence: evidenceRecords
      });
      const evidenceStatements = evidencePlan.evidenceStatements.map((statement) =>
        this.env.MEMORY_DB.prepare(statement.sql).bind(...statement.bindings)
      );
      const evidenceLinkStatements = evidencePlan.linkStatements.map((statement) =>
        this.env.MEMORY_DB.prepare(statement.sql).bind(...statement.bindings)
      );
      const preparedPlan = plan.statements.map((statement) =>
        this.env.MEMORY_DB.prepare(statement.sql).bind(...statement.bindings)
      );
      preparedPlan.splice(1, 0, ...evidenceStatements);
      preparedPlan.splice(2 + evidenceStatements.length, 0, ...evidenceLinkStatements);
      let results: D1Result[];
      try {
        results = await this.env.MEMORY_DB.batch(preparedPlan);
      } catch (error) {
        throw translateCoordinatorDatabaseError(error, "The expected version is stale.");
      }
      const headUpdate = results.at(-1);
      if ((headUpdate?.meta.changes ?? 0) !== 1) {
        throw new EdgeMnemeError("VERSION_CONFLICT", "The expected version is stale.");
      }
      const evidenceLinkOffset = 2 + evidenceStatements.length;
      if (
        results
          .slice(evidenceLinkOffset, evidenceLinkOffset + evidenceLinkStatements.length)
          .some((result) => (result.meta.changes ?? 0) !== 1)
      ) {
        throw mutationEvidenceConflict();
      }
      return Response.json({
        memory_id: input.target_memory_id,
        memory_version: plan.nextMemoryVersion,
        project_version: plan.nextProjectVersion,
        revision_id: revisionId
      });
    } catch (error) {
      const body = errorBody(error, requestId);
      const status =
        error instanceof EdgeMnemeError
          ? error.code === "VERSION_CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT"
            ? 409
            : error.code === "PROJECT_UNAVAILABLE"
              ? 404
              : error.code === "VALIDATION_FAILED"
                ? 400
                : 500
          : 500;
      return Response.json(body, { status });
    }
  }

  private async reviewCandidate(rawInput: unknown): Promise<Record<string, unknown>> {
    const input = candidateReviewSchema.parse(rawInput);
    await requireProjectMaintainer(
      this.env.MEMORY_DB,
      input.project_id,
      input.actor_principal_id
    );
    const payloadDigest = await sha256(canonicalJson(input));
    const existing = await this.env.MEMORY_DB.prepare(
      `SELECT request_digest, response_json FROM idempotency_records
       WHERE project_id = ? AND principal_id = ? AND operation = 'candidate_review'
         AND idempotency_key = ?`
    )
      .bind(input.project_id, input.actor_principal_id, input.idempotency_key)
      .first<{ request_digest: string; response_json: string }>();
    if (existing !== null) {
      if (existing.request_digest !== payloadDigest) {
        throw new EdgeMnemeError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used with a different payload."
        );
      }
      const response = JSON.parse(existing.response_json) as Record<string, unknown>;
      if (
        typeof response.memory_id === "string" &&
        typeof response.project_version === "number"
      ) {
        await ensureProjectionWorkflow(
          this.env,
          input.project_id,
          response.memory_id,
          response.project_version
        );
      }
      return response;
    }

    if (
      !inspectMemoryModelValue(
        { reason: input.reason, edits: input.edits },
        { maxBytes: MEMORY_MODEL_INPUT_MAX_BYTES }
      ).accepted
    ) {
      throw new EdgeMnemeError(
        "VALIDATION_FAILED",
        "The candidate review data cannot be persisted safely."
      );
    }

    const current = await this.env.MEMORY_DB.withSession("first-primary")
      .prepare(
        `SELECT p.project_version, p.audit_head_hash,
                o.candidate_version, o.status, o.content, o.reviewed_content,
                o.kind, o.memory_class, o.scope, o.scope_id, o.valid_from, o.valid_until,
                o.analysis_json,
                o.session_id, session_record.repository_id AS session_repository_id,
                session_record.repository_ref AS session_repository_ref,
                session_record.worktree_id AS session_worktree_id,
                rr.review_request_id
         FROM projects p
         JOIN observations o ON o.project_id = p.project_id
         LEFT JOIN sessions AS session_record
           ON session_record.project_id = o.project_id
          AND session_record.session_id = o.session_id
         LEFT JOIN review_requests rr
           ON rr.project_id = o.project_id AND rr.candidate_id = o.observation_id
         WHERE p.project_id = ? AND o.observation_id = ?`
      )
      .bind(input.project_id, input.candidate_id)
      .first<{
        project_version: number;
        audit_head_hash: string | null;
        candidate_version: number;
        status: string;
        content: string | null;
        reviewed_content: string | null;
        kind: string | null;
        memory_class: string | null;
        scope: string | null;
        scope_id: string | null;
        valid_from: string | null;
        valid_until: string | null;
        analysis_json: string | null;
        session_id: string | null;
        session_repository_id: string | null;
        session_repository_ref: string | null;
        session_worktree_id: string | null;
        review_request_id: string | null;
      }>();
    if (
      current === null ||
      current.candidate_version !== input.expected_candidate_version ||
      !["pending_review", "request_changes"].includes(current.status)
    ) {
      throw new EdgeMnemeError("VERSION_CONFLICT", "The candidate version is stale.");
    }
    if (current.review_request_id === null) {
      throw new EdgeMnemeError(
        "VALIDATION_FAILED",
        "The candidate has no pending review request."
      );
    }

    const now = new Date().toISOString();
    const nextProjectVersion = current.project_version + 1;
    const auditHash = await sha256(
      `${current.audit_head_hash ?? ""}\n${payloadDigest}\n${nextProjectVersion}`
    );
    const decisionId = crypto.randomUUID();
    let plan:
      | ReturnType<typeof buildCandidatePromotionPlan>
      | ReturnType<typeof buildCandidateReviewPlan>;
    if (input.decision === "approve") {
      const content = input.edits?.content ?? current.reviewed_content ?? current.content;
      const kind = input.edits?.kind ?? current.kind;
      const memoryClass = input.edits?.memory_class ?? current.memory_class;
      const scope = input.edits?.scope ?? current.scope;
      const scopeId = input.edits?.scope_id ?? current.scope_id;
      const parsedKind = z.enum(MEMORY_KINDS).safeParse(kind);
      const parsedClass = z.enum(MEMORY_CLASSES).safeParse(memoryClass);
      const parsedScope = z.enum(MEMORY_SCOPES).safeParse(scope);
      if (
        typeof content !== "string" ||
        !inspectMemoryModelInput(content).accepted ||
        !parsedKind.success ||
        !parsedClass.success ||
        !parsedScope.success ||
        typeof scopeId !== "string" ||
        scopeId.trim() === ""
      ) {
        throw new EdgeMnemeError(
          "VALIDATION_FAILED",
          "Approval requires safe content and a complete taxonomy proposal."
        );
      }
      const scopeOwnership = await resolveScopeRepositoryOwnership(
        this.env.MEMORY_DB,
        input.project_id,
        parsedScope.data,
        scopeId
      );
      if (scopeOwnership === null) {
        throw new EdgeMnemeError(
          "VALIDATION_FAILED",
          "The formal memory scope does not belong to the project."
        );
      }
      const citedEvidenceIds = requireCandidateCitedEvidenceIds(current.analysis_json);
      const evidencePlaceholders = citedEvidenceIds.map(() => "?").join(", ");
      const evidence = await this.env.MEMORY_DB.prepare(
        `SELECT e.evidence_id, e.source_type, e.locator, e.commit_sha, e.excerpt_hash,
                e.repository_id, e.repository_ref, e.repository_path,
                e.repository_authority
         FROM observation_evidence oe
         JOIN evidence e
           ON e.project_id = oe.project_id AND e.evidence_id = oe.evidence_id
         WHERE oe.project_id = ? AND oe.observation_id = ?
           AND e.sensitivity_status = 'clear'
           AND e.evidence_id IN (${evidencePlaceholders})
         ORDER BY e.evidence_id ASC`
      )
        .bind(input.project_id, input.candidate_id, ...citedEvidenceIds)
        .all<{
          evidence_id: string;
          source_type: string;
          locator: string;
          commit_sha: string | null;
          excerpt_hash: string;
          repository_id: string | null;
          repository_ref: string | null;
          repository_path: string | null;
          repository_authority: string | null;
        }>();
      const evidenceById = new Map(evidence.results.map((item) => [item.evidence_id, item]));
      if (evidenceById.size !== citedEvidenceIds.length) {
        throw new EdgeMnemeError(
          "VALIDATION_FAILED",
          "The candidate cited evidence is unavailable."
        );
      }
      const citedEvidence = citedEvidenceIds.map((evidenceId) => {
        const item = evidenceById.get(evidenceId);
        if (item === undefined) {
          throw new EdgeMnemeError(
            "VALIDATION_FAILED",
            "The candidate cited evidence is unavailable."
          );
        }
        return item;
      });
      const evidenceWithAuthority = citedEvidence.map((item) => ({
        ...item,
        repositoryAuthority: z
          .enum(REPOSITORY_AUTHORITIES)
          .nullable()
          .parse(item.repository_authority)
      }));
      const repositoryId = requireCandidatePromotionProvenance({
        scope: parsedScope.data,
        scopeId,
        targetRepositoryId: scopeOwnership.repositoryId,
        candidateSession:
          current.session_id === null
            ? null
            : {
                sessionId: current.session_id,
                repositoryId: current.session_repository_id,
                repositoryRef: current.session_repository_ref,
                worktreeId: current.session_worktree_id
              },
        evidence: evidenceWithAuthority.map((item) => ({
          evidenceId: item.evidence_id,
          repositoryId: item.repository_id,
          repositoryRef: item.repository_ref,
          repositoryPath: item.repository_path,
          repositoryAuthority: item.repositoryAuthority
        }))
      });
      const memoryId = crypto.randomUUID();
      const revisionId = crypto.randomUUID();
      const validFrom = input.edits?.valid_from ?? current.valid_from;
      const validUntil = input.edits?.valid_until ?? current.valid_until;
      if (!isValidValidityInterval({ validFrom, validUntil })) {
        throw new EdgeMnemeError(
          "VALIDATION_FAILED",
          "The memory validity interval is invalid."
        );
      }
      await requireFormalProjectionCapacity({
        database: this.env.MEMORY_DB,
        projectId: input.project_id,
        expectedProjectVersion: current.project_version,
        content,
        addsMemory: true,
        scopeId
      });
      plan = buildCandidatePromotionPlan({
        projectId: input.project_id,
        expectedProjectVersion: current.project_version,
        candidateId: input.candidate_id,
        expectedCandidateVersion: input.expected_candidate_version,
        reviewRequestId: current.review_request_id,
        decisionId,
        memoryId,
        revisionId,
        actorPrincipalId: input.actor_principal_id,
        requestDigest: payloadDigest,
        idempotencyKey: input.idempotency_key,
        reason: input.reason,
        content,
        contentSha256: await sha256(content),
        kind: parsedKind.data,
        memoryClass: parsedClass.data,
        scope: parsedScope.data,
        scopeId,
        ...(repositoryId === null ? {} : { repositoryId }),
        ...(validFrom === null ? {} : { validFrom }),
        ...(validUntil === null ? {} : { validUntil }),
        evidence: evidenceWithAuthority.map((item) => ({
          evidenceId: item.evidence_id,
          sourceType: item.source_type,
          locator: item.locator,
          excerptHash: item.excerpt_hash,
          ...(item.commit_sha === null ? {} : { commitSha: item.commit_sha }),
          ...(item.repository_id === null ? {} : { repositoryId: item.repository_id }),
          ...(item.repository_ref === null ? {} : { repositoryRef: item.repository_ref }),
          ...(item.repository_path === null ? {} : { repositoryPath: item.repository_path }),
          ...(item.repositoryAuthority === null
            ? {}
            : { repositoryAuthority: item.repositoryAuthority })
        })),
        previousAuditHash: current.audit_head_hash,
        auditHash,
        now
      });
    } else {
      plan = buildCandidateReviewPlan({
        projectId: input.project_id,
        expectedProjectVersion: current.project_version,
        candidateId: input.candidate_id,
        expectedCandidateVersion: input.expected_candidate_version,
        reviewRequestId: current.review_request_id,
        decisionId,
        actorPrincipalId: input.actor_principal_id,
        requestDigest: payloadDigest,
        idempotencyKey: input.idempotency_key,
        decision: input.decision,
        reason: input.reason,
        ...(input.edits === null ? {} : { editsJson: canonicalJson(input.edits) }),
        ...(input.decision === "request_changes" && input.edits?.content !== undefined
          ? { reviewedContent: input.edits.content }
          : {}),
        previousAuditHash: current.audit_head_hash,
        auditHash,
        now
      });
    }
    let results: D1Result[];
    try {
      results = await this.env.MEMORY_DB.batch(
        plan.statements.map((statement) =>
          this.env.MEMORY_DB.prepare(statement.sql).bind(...statement.bindings)
        )
      );
    } catch (error) {
      throw translateCoordinatorDatabaseError(error, "The candidate version is stale.");
    }
    if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
      throw new EdgeMnemeError("VERSION_CONFLICT", "The candidate version is stale.");
    }
    if ("memory_id" in plan.response) {
      await ensureProjectionWorkflow(
        this.env,
        input.project_id,
        plan.response.memory_id,
        plan.response.project_version
      );
    }
    return { ...plan.response };
  }
}

async function requireProjectMaintainer(
  database: D1Database,
  projectId: string,
  principalId: string
): Promise<void> {
  const grant = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS authorized FROM project_grants grant_row
       JOIN projects project ON project.project_id = grant_row.project_id
       WHERE grant_row.project_id = ? AND grant_row.principal_id = ?
         AND grant_row.role = 'maintainer' AND grant_row.scope_kind = 'project'
         AND grant_row.scope_id = ? AND grant_row.revoked_at IS NULL
         AND (
           project.project_ref NOT GLOB 'system.synthetic.*'
           OR EXISTS (
             SELECT 1 FROM synthetic_cleanup_registry registry
             WHERE registry.project_id = project.project_id
               AND registry.cleanup_fenced_at IS NULL
           )
         )
       LIMIT 1`
    )
    .bind(projectId, principalId, projectId)
    .first();
  if (grant === null) {
    throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
  }
}

function translateCoordinatorDatabaseError(error: unknown, staleMessage: string): unknown {
  if (
    error instanceof Error &&
    (error.message.includes("project maintainer grant required") ||
      error.message.includes("synthetic cleanup is fenced"))
  ) {
    return new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
  }
  if (
    error instanceof Error &&
    (error.message.includes("stale candidate head") ||
      error.message.includes("stale memory head") ||
      error.message.includes("stale project head"))
  ) {
    return new EdgeMnemeError("VERSION_CONFLICT", staleMessage);
  }
  if (
    error instanceof Error &&
    (error.message.includes("evidence identity is immutable") ||
      error.message.includes("evidence repository context is immutable") ||
      error.message.includes("clear evidence is required for a memory version"))
  ) {
    return mutationEvidenceConflict();
  }
  return error;
}

interface WorkflowRunIdentity {
  workflowId: string;
  rootWorkflowId: string;
  projectId: string;
  workflowType: WorkflowPayload["type"];
  createdAt: string;
}

function workflowRunIdentity(event: WorkflowEvent<WorkflowPayload>): WorkflowRunIdentity {
  return {
    workflowId: event.instanceId,
    rootWorkflowId: event.payload.eventId,
    projectId: event.payload.projectId,
    workflowType: event.payload.type,
    createdAt: event.timestamp.toISOString()
  };
}

function unavailableProjectionRebuild(): EdgeMnemeError {
  return new EdgeMnemeError(
    "PROJECT_UNAVAILABLE",
    "The project is unavailable for projection rebuild."
  );
}

async function recordWorkflowRunStart(
  database: D1Database,
  identity: WorkflowRunIdentity,
  updatedAt: string
): Promise<void> {
  const result = await database.prepare(
    `INSERT INTO workflow_runs
     (workflow_id, root_workflow_id, project_id, workflow_type, status, attempt,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', 1, ?, ?)
     ON CONFLICT(workflow_id) DO UPDATE SET
       attempt = workflow_runs.attempt + 1,
       status = 'running',
       last_error_code = NULL,
       updated_at = excluded.updated_at
     WHERE workflow_runs.root_workflow_id = excluded.root_workflow_id
       AND workflow_runs.project_id = excluded.project_id
       AND workflow_runs.workflow_type = excluded.workflow_type
       AND workflow_runs.status NOT IN ('complete', 'terminated')`
  )
    .bind(
      identity.workflowId,
      identity.rootWorkflowId,
      identity.projectId,
      identity.workflowType,
      identity.createdAt,
      updatedAt
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error("The Workflow run identity conflicts with an existing terminal record.");
  }
}

async function recordWorkflowRunFailure(
  database: D1Database,
  identity: WorkflowRunIdentity,
  errorCode: string,
  updatedAt: string
): Promise<void> {
  const result = await database.prepare(
    `INSERT INTO workflow_runs
     (workflow_id, root_workflow_id, project_id, workflow_type, status, attempt,
      last_error_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'failed', 1, ?, ?, ?)
     ON CONFLICT(workflow_id) DO UPDATE SET
       status = 'failed',
       last_error_code = excluded.last_error_code,
       updated_at = excluded.updated_at
     WHERE workflow_runs.root_workflow_id = excluded.root_workflow_id
       AND workflow_runs.project_id = excluded.project_id
       AND workflow_runs.workflow_type = excluded.workflow_type
       AND workflow_runs.status NOT IN ('complete', 'terminated')`
  )
    .bind(
      identity.workflowId,
      identity.rootWorkflowId,
      identity.projectId,
      identity.workflowType,
      errorCode,
      identity.createdAt,
      updatedAt
    )
    .run();
  if ((result.meta.changes ?? 0) === 1) {
    return;
  }

  const existing = await database.withSession("first-primary").prepare(
    `SELECT root_workflow_id, project_id, workflow_type, status
     FROM workflow_runs
     WHERE workflow_id = ?
     LIMIT 1`
  )
    .bind(identity.workflowId)
    .first<{
      root_workflow_id: string;
      project_id: string;
      workflow_type: string;
      status: string;
    }>();
  if (
    existing !== null &&
    existing.root_workflow_id === identity.rootWorkflowId &&
    existing.project_id === identity.projectId &&
    existing.workflow_type === identity.workflowType &&
    (existing.status === "complete" || existing.status === "terminated")
  ) {
    return;
  }
  throw new Error("The Workflow run identity conflicts with an existing record.");
}

export class MemoryWorkflow extends WorkflowEntrypoint<Env, WorkflowPayload> {
  override async run(event: WorkflowEvent<WorkflowPayload>, step: WorkflowStep): Promise<void> {
    const identity = workflowRunIdentity(event);
    let qualityDiagnosticCode: CandidateAnalysisDiagnosticCode | null = null;
    try {
      const admitted = await step.do(
        "check workflow admission",
        { retries: { limit: 3, delay: "1 second", backoff: "exponential" } },
        () => isProjectWorkAdmitted(this.env.MEMORY_DB, event.payload.projectId)
      );
      if (!admitted) {
        if (event.payload.type === "projection.rebuild.requested") {
          throw unavailableProjectionRebuild();
        }
        return;
      }
      await step.do(
        "record workflow start",
        { retries: { limit: 3, delay: "1 second", backoff: "exponential" } },
        async () => {
          if (!(await isProjectWorkAdmitted(this.env.MEMORY_DB, event.payload.projectId))) {
            if (event.payload.type === "projection.rebuild.requested") {
              throw unavailableProjectionRebuild();
            }
            return;
          }
          await recordWorkflowRunStart(
            this.env.MEMORY_DB,
            identity,
            new Date().toISOString()
          );
        }
      );

      if (
        event.payload.type === "projection.rebuild.requested" &&
        event.payload.projectionRebuild !== undefined
      ) {
        await runProjectionRebuild(this.env, event.payload, step);
      } else {
        qualityDiagnosticCode = await step.do(
          "apply quality policy",
          {
            retries: { limit: 2, delay: "2 seconds", backoff: "exponential" },
            timeout: SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT
          },
          async () => {
          if (!(await isProjectWorkAdmitted(this.env.MEMORY_DB, event.payload.projectId))) {
            return null;
          }
          if (event.payload.type === "candidate.submitted") {
            return processCandidateSubmission(
              this.env,
              event.payload.projectId,
              event.payload.subjectId
            );
          } else if (event.payload.type === "github.sync.requested") {
            await this.env.MEMORY_DB.prepare(
              `UPDATE sync_cursors SET status = 'pending_review', updated_at = ?
               WHERE project_id = ? AND repository_id = ? AND ref = ? AND observed_sha = ?`
            )
              .bind(
                new Date().toISOString(),
                event.payload.projectId,
                event.payload.subjectId,
                event.payload.ref ?? "",
                event.payload.observedSha ?? ""
              )
              .run();
          } else if (event.payload.type === "candidate.reviewed") {
            return null;
          } else if (event.payload.type === "session.consolidation.requested") {
            await consolidateSession(
              this.env,
              event.payload.projectId,
              event.payload.eventId,
              event.payload.subjectId
            );
          } else if (
            event.payload.type === "memory.changed" &&
            event.payload.projectVersion !== undefined
          ) {
            const projectionCurrent = await checkProjectionSnapshotCapacity(
              this.env.MEMORY_DB,
              event.payload.projectId,
              event.payload.projectVersion
            );
            if (!projectionCurrent) {
              return null;
            }
            await publishProjectProjection({
              memoryDb: this.env.MEMORY_DB,
              projections: this.env.PROJECTIONS,
              projectId: event.payload.projectId,
              projectVersion: event.payload.projectVersion
            });
            await publishMemorySearchProjection({
              memoryDb: this.env.MEMORY_DB,
              searchDb: this.env.SEARCH_DB,
              vectors: this.env.MEMORY_VECTORS,
              ai: this.env.AI,
              projectId: event.payload.projectId,
              memoryId: event.payload.subjectId,
              projectVersion: event.payload.projectVersion
            });
          }
          return null;
          }
        );
      }

      await step.do("record workflow completion", async () => {
        await this.env.MEMORY_DB.prepare(
          `UPDATE workflow_runs
           SET status = 'complete', last_error_code = ?, updated_at = ?
           WHERE workflow_id = ? AND project_id = ?`
        )
          .bind(
            qualityDiagnosticCode,
            new Date().toISOString(),
            event.instanceId,
            event.payload.projectId
          )
          .run();
      });
    } catch (error) {
      await step.do(
        "record workflow failure",
        { retries: { limit: 3, delay: "1 second", backoff: "exponential" } },
        async () => {
          const updatedAt = new Date().toISOString();
          await recordWorkflowRunFailure(
            this.env.MEMORY_DB,
            identity,
            error instanceof EdgeMnemeError ? error.code : "INTERNAL",
            updatedAt
          );
          if (event.payload.type === "session.consolidation.requested") {
            await this.env.MEMORY_DB.prepare(
              `UPDATE session_consolidations SET status = 'failed', updated_at = ?
               WHERE project_id = ? AND consolidation_id = ? AND status = 'running'`
            )
              .bind(updatedAt, event.payload.projectId, event.payload.eventId)
              .run();
          }
        }
      );
      throw error;
    }
  }
}

export default {
  async queue(batch: MessageBatch<MemoryEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = message.body;
        if (!(await isProjectWorkAdmitted(env.MEMORY_DB, event.projectId))) {
          message.ack();
          continue;
        }
        const subjectId =
          event.type === "candidate.submitted"
            ? event.candidateId
            : event.type === "session.consolidation.requested"
              ? event.sessionId
              : event.type === "github.sync.requested"
                ? event.repositoryId
                : event.candidateId;
        await ensureWorkflowWithRepair(env.MEMORY_WORKFLOW, event.eventId, {
          eventId: event.eventId,
          projectId: event.projectId,
          type: event.type,
          subjectId,
          ...(event.type === "github.sync.requested"
            ? { observedSha: event.observedSha, ref: event.ref }
            : {})
        });
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await reapExpiredSyntheticProjects(
      {
        memoryDb: env.MEMORY_DB,
        searchDb: env.SEARCH_DB,
        projections: env.PROJECTIONS,
        vectors: env.MEMORY_VECTORS,
        workflow: env.MEMORY_WORKFLOW
      },
      { projectLimit: 1 }
    );
    let workflowWindowStartedAt = Date.now();
    let workflowStartsInWindow = 0;
    ({ workflowWindowStartedAt, workflowStartsInWindow } =
      await reconcileDispatchedProjectionRebuilds(env, {
        workflowWindowStartedAt,
        workflowStartsInWindow
      }));
    ({ workflowWindowStartedAt, workflowStartsInWindow } =
      await reconcileDispatchedOrdinaryWorkflows(env, {
        workflowWindowStartedAt,
        workflowStartsInWindow
      }));
    const pending = await env.MEMORY_DB.prepare(
      `SELECT event_id, project_id, project_version, event_type, payload_digest,
              payload_json, attempt
       FROM outbox_events
       WHERE dispatched_at IS NULL AND failed_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC, event_id ASC LIMIT ?`
    )
      .bind(new Date().toISOString(), PROJECTION_REBUILD_OUTBOX_DISPATCH_LIMIT)
      .all<{
        event_id: string;
        project_id: string;
        project_version: number;
        event_type: string;
        payload_digest: string;
        payload_json: string;
        attempt: number;
      }>();
    for (const row of pending.results) {
      let projectionRebuild: Awaited<ReturnType<typeof parseProjectionRebuildDispatch>> = null;
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (typeof payload.projectId !== "string" || payload.projectId !== row.project_id) {
          throw new Error("The outbox payload project does not match its authoritative row.");
        }
        if (
          typeof payload.eventId !== "string" ||
          payload.eventId !== row.event_id ||
          typeof payload.type !== "string" ||
          payload.type !== row.event_type
        ) {
          throw new Error("The outbox payload identity does not match its authoritative row.");
        }
        projectionRebuild = await parseProjectionRebuildDispatch(row, payload);
        if (!(await isProjectWorkAdmitted(env.MEMORY_DB, payload.projectId))) {
          if (projectionRebuild !== null) {
            await env.MEMORY_DB.prepare(
              `UPDATE outbox_events
               SET failed_at = ?, next_attempt_at = NULL, attempt = attempt + 1,
                   last_error_code = 'PROJECTION_REBUILD_PROJECT_UNAVAILABLE'
               WHERE event_id = ? AND project_id = ? AND payload_digest = ?
                 AND attempt = ? AND dispatched_at IS NULL AND failed_at IS NULL`
            )
              .bind(
                new Date().toISOString(),
                row.event_id,
                row.project_id,
                row.payload_digest,
                row.attempt
              )
              .run();
            continue;
          }
          await env.MEMORY_DB.prepare(
            `UPDATE outbox_events
             SET dispatched_at = ?, next_attempt_at = NULL, attempt = attempt + 1,
                 last_error_code = 'SYNTHETIC_CLEANUP_FENCED'
             WHERE event_id = ? AND dispatched_at IS NULL`
          )
            .bind(new Date().toISOString(), row.event_id)
            .run();
          continue;
        }
        if (projectionRebuild !== null) {
          ({ workflowWindowStartedAt, workflowStartsInWindow } =
            await throttleProjectionWorkflowStart(
              workflowWindowStartedAt,
              workflowStartsInWindow
            ));
          const workflowId = await ensureProjectionWorkflow(
            env,
            payload.projectId,
            payload.projectId,
            projectionRebuild.projectVersion,
            {
              eventId: row.event_id,
              request: projectionRebuild.request
            }
          );
          if (workflowId === null) {
            throw unavailableProjectionRebuild();
          }
        } else if (
          row.event_type === "memory.changed" &&
          typeof payload.projectId === "string" &&
          typeof payload.memoryId === "string" &&
          typeof payload.projectVersion === "number"
        ) {
          ({ workflowWindowStartedAt, workflowStartsInWindow } =
            await throttleProjectionWorkflowStart(
              workflowWindowStartedAt,
              workflowStartsInWindow
            ));
          await ensureProjectionWorkflow(
            env,
            payload.projectId,
            payload.memoryId,
            payload.projectVersion
          );
        } else {
          await env.MEMORY_OUTBOX.send(payload as unknown as MemoryEvent);
        }
        await env.MEMORY_DB.prepare(
          `UPDATE outbox_events
           SET dispatched_at = ?, next_attempt_at = NULL, attempt = attempt + 1,
               last_error_code = NULL
           WHERE event_id = ? AND dispatched_at IS NULL`
        )
          .bind(new Date().toISOString(), row.event_id)
          .run();
      } catch {
        const nextAttempt = row.attempt + 1;
        if (nextAttempt >= 10) {
          // Workflow creation and the D1 dispatch marker are not atomic. Only explicit
          // terminal failure for every stable Workflow ID makes a new execution safe.
          if (
            projectionRebuild !== null &&
            !(await projectionWorkflowRepairsExhausted(env, row.event_id))
          ) {
            try {
              await recoverAmbiguousProjectionRebuildDispatch(
                env.MEMORY_DB,
                row,
                nextAttempt,
                new Date().toISOString()
              );
            } catch {
              // Leave the row undispatched and retryable when even the recovery write is uncertain.
            }
            continue;
          }
          await env.MEMORY_DB.prepare(
            `UPDATE outbox_events
             SET attempt = ?, failed_at = ?, last_error_code = 'OUTBOX_DISPATCH_FAILED'
             WHERE event_id = ? AND project_id = ? AND payload_digest = ?
               AND attempt = ? AND dispatched_at IS NULL AND failed_at IS NULL`
          )
            .bind(
              nextAttempt,
              new Date().toISOString(),
              row.event_id,
              row.project_id,
              row.payload_digest,
              row.attempt
            )
            .run();
        } else {
          const delayMs = Math.min(60 * 60 * 1000, 2 ** row.attempt * 60 * 1000);
          await env.MEMORY_DB.prepare(
            `UPDATE outbox_events
             SET attempt = ?, next_attempt_at = ?, last_error_code = 'OUTBOX_RETRY_PENDING'
             WHERE event_id = ? AND dispatched_at IS NULL`
          )
            .bind(
              nextAttempt,
              new Date(Date.now() + delayMs).toISOString(),
              row.event_id
            )
            .run();
        }
      }
    }
    await reapSearchVectorCleanupReceipts(
      { searchDb: env.SEARCH_DB, vectors: env.MEMORY_VECTORS },
      { ownerLimit: 1, receiptLimit: 50 }
    );
  }
} satisfies ExportedHandler<Env, MemoryEvent>;

async function recoverAmbiguousProjectionRebuildDispatch(
  database: D1Database,
  row: {
    event_id: string;
    project_id: string;
    payload_digest: string;
    attempt: number;
  },
  nextAttempt: number,
  observedAt: string
): Promise<void> {
  await database.prepare(
    `UPDATE outbox_events
     SET dispatched_at = ?, next_attempt_at = NULL, attempt = ?, last_error_code = NULL
     WHERE event_id = ? AND project_id = ? AND payload_digest = ?
       AND attempt = ? AND dispatched_at IS NULL AND failed_at IS NULL`
  )
    .bind(
      observedAt,
      nextAttempt,
      row.event_id,
      row.project_id,
      row.payload_digest,
      row.attempt
    )
    .run();
}

interface OrdinaryWorkflowReconciliationRow {
  event_id: string;
  project_id: string;
  project_version: number;
  event_type: string;
  payload_digest: string;
  payload_json: string;
  created_at: string;
  dispatched_at: string;
  next_attempt_at: string | null;
  last_error_code: string | null;
  latest_workflow_status: string | null;
}

interface OrdinaryWorkflowRequest {
  baseId: string;
  params: WorkflowPayload;
}

interface ProjectionRebuildReconciliationRow {
  event_id: string;
  project_id: string;
  project_version: number;
  event_type: string;
  payload_digest: string;
  payload_json: string;
  dispatched_at: string;
  next_attempt_at: string | null;
  last_error_code: string | null;
  projection_unknown_count: number;
  latest_workflow_id: string | null;
  latest_workflow_status: string | null;
}

interface WorkflowThrottleState {
  workflowWindowStartedAt: number;
  workflowStartsInWindow: number;
}

async function reconcileDispatchedOrdinaryWorkflows(
  env: Env,
  throttle: WorkflowThrottleState
): Promise<WorkflowThrottleState> {
  const observedAt = new Date().toISOString();
  const rows = await env.MEMORY_DB.prepare(
    `/* ordinary_workflow_reconcile */
     SELECT e.event_id, e.project_id, e.project_version, e.event_type,
            e.payload_digest, e.payload_json, e.created_at, e.dispatched_at,
            e.next_attempt_at, e.last_error_code,
            latest.status AS latest_workflow_status
     FROM outbox_events AS e INDEXED BY outbox_ordinary_workflow_reconcile
     LEFT JOIN workflow_runs AS latest
       ON latest.workflow_id = (
         SELECT candidate.workflow_id
         FROM workflow_runs AS candidate
         WHERE candidate.project_id = e.project_id
           AND candidate.root_workflow_id = CASE
             WHEN e.event_type = 'memory.changed'
               THEN e.project_id || ':' || e.project_version
             ELSE e.event_id
           END
         ORDER BY candidate.updated_at DESC, candidate.workflow_id DESC
         LIMIT 1
       )
     WHERE e.event_type <> 'projection.rebuild.requested'
       AND e.event_type IN (
         'candidate.submitted', 'candidate.reviewed',
         'session.consolidation.requested', 'github.sync.requested', 'memory.changed'
       )
       AND e.dispatched_at IS NOT NULL AND e.failed_at IS NULL
       AND (
         e.last_error_code IS NULL
         OR e.last_error_code IN (
           'WORKFLOW_RECONCILIATION_PENDING', 'WORKFLOW_CONTROL_PLANE_UNKNOWN'
         )
       )
       AND COALESCE(e.next_attempt_at, '') <= ?
     ORDER BY COALESCE(e.next_attempt_at, ''), e.created_at, e.event_id
     LIMIT ?`
  )
    .bind(observedAt, ORDINARY_WORKFLOW_RECONCILIATION_LIMIT)
    .all<OrdinaryWorkflowReconciliationRow>();

  for (const row of rows.results) {
    let request: OrdinaryWorkflowRequest;
    try {
      request = parseOrdinaryWorkflowRequest(row);
    } catch {
      await failOrdinaryWorkflowReconciliation(
        env.MEMORY_DB,
        row,
        "WORKFLOW_RECONCILIATION_INVALID",
        observedAt
      );
      continue;
    }

    if (row.latest_workflow_status === "complete") {
      await markOrdinaryWorkflowTerminal(
        env.MEMORY_DB,
        row,
        "WORKFLOW_COMPLETE"
      );
      continue;
    }

    try {
      if (!(await isProjectWorkAdmitted(env.MEMORY_DB, row.project_id))) {
        await markOrdinaryWorkflowTerminal(
          env.MEMORY_DB,
          row,
          "SYNTHETIC_CLEANUP_FENCED"
        );
        continue;
      }
      ({ workflowWindowStartedAt: throttle.workflowWindowStartedAt,
        workflowStartsInWindow: throttle.workflowStartsInWindow } =
        await throttleProjectionWorkflowStart(
          throttle.workflowWindowStartedAt,
          throttle.workflowStartsInWindow
        ));
      const workflowId = await ensureWorkflowWithRepair(
        env.MEMORY_WORKFLOW,
        request.baseId,
        request.params,
        ORDINARY_WORKFLOW_MAX_REPAIRS
      );
      let status: { status: string };
      try {
        const workflow = await env.MEMORY_WORKFLOW.get(workflowId);
        status = await workflow.status();
      } catch {
        await deferOrdinaryWorkflowReconciliation(
          env.MEMORY_DB,
          row,
          observedAt,
          "WORKFLOW_CONTROL_PLANE_UNKNOWN"
        );
        continue;
      }
      if (status.status === "complete") {
        await recordReconciledOrdinaryWorkflowCompletion(
          env.MEMORY_DB,
          row,
          request,
          workflowId,
          observedAt
        );
        await markOrdinaryWorkflowTerminal(
          env.MEMORY_DB,
          row,
          "WORKFLOW_COMPLETE"
        );
        continue;
      }
      if (
        ORDINARY_WORKFLOW_KNOWN_NONTERMINAL_STATUSES.has(status.status) ||
        status.status === "errored" ||
        status.status === "terminated"
      ) {
        await deferOrdinaryWorkflowReconciliation(
          env.MEMORY_DB,
          row,
          observedAt,
          "WORKFLOW_RECONCILIATION_PENDING"
        );
        continue;
      }
      await deferOrdinaryWorkflowReconciliation(
        env.MEMORY_DB,
        row,
        observedAt,
        "WORKFLOW_CONTROL_PLANE_UNKNOWN"
      );
    } catch (error) {
      if (error instanceof WorkflowControlPlaneStatusError) {
        await deferOrdinaryWorkflowReconciliation(
          env.MEMORY_DB,
          row,
          observedAt,
          "WORKFLOW_CONTROL_PLANE_UNKNOWN"
        );
      } else if (error instanceof WorkflowRepairExhaustedError) {
        await failOrdinaryWorkflowReconciliation(
          env.MEMORY_DB,
          row,
          "WORKFLOW_REPAIR_EXHAUSTED",
          observedAt
        );
      } else {
        await deferOrdinaryWorkflowReconciliation(
          env.MEMORY_DB,
          row,
          observedAt,
          "WORKFLOW_RECONCILIATION_PENDING"
        );
      }
    }
  }
  return throttle;
}

function parseOrdinaryWorkflowRequest(
  row: OrdinaryWorkflowReconciliationRow
): OrdinaryWorkflowRequest {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  if (
    payload.eventId !== row.event_id ||
    payload.projectId !== row.project_id ||
    payload.type !== row.event_type
  ) {
    throw new Error("The ordinary outbox identity does not match its payload.");
  }
  const common = {
    eventId: row.event_id,
    projectId: row.project_id
  };
  if (row.event_type === "candidate.submitted") {
    return {
      baseId: row.event_id,
      params: {
        ...common,
        type: row.event_type,
        subjectId: requireOrdinaryWorkflowSubject(payload.candidateId)
      }
    };
  }
  if (row.event_type === "candidate.reviewed") {
    return {
      baseId: row.event_id,
      params: {
        ...common,
        type: row.event_type,
        subjectId: requireOrdinaryWorkflowSubject(payload.candidateId)
      }
    };
  }
  if (row.event_type === "session.consolidation.requested") {
    return {
      baseId: row.event_id,
      params: {
        ...common,
        type: row.event_type,
        subjectId: requireOrdinaryWorkflowSubject(payload.sessionId)
      }
    };
  }
  if (row.event_type === "github.sync.requested") {
    const observedSha = requireOrdinaryWorkflowSubject(payload.observedSha);
    const ref = requireOrdinaryWorkflowSubject(payload.ref);
    return {
      baseId: row.event_id,
      params: {
        ...common,
        type: row.event_type,
        subjectId: requireOrdinaryWorkflowSubject(payload.repositoryId),
        observedSha,
        ref
      }
    };
  }
  if (
    row.event_type === "memory.changed" &&
    Number.isSafeInteger(payload.projectVersion) &&
    payload.projectVersion === row.project_version
  ) {
    return {
      baseId: `projection-${row.project_id}-${row.project_version}`,
      params: {
        eventId: `${row.project_id}:${row.project_version}`,
        projectId: row.project_id,
        type: row.event_type,
        subjectId: requireOrdinaryWorkflowSubject(payload.memoryId),
        projectVersion: row.project_version
      }
    };
  }
  throw new Error("The ordinary outbox payload is invalid.");
}

function requireOrdinaryWorkflowSubject(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("The ordinary Workflow subject is invalid.");
  }
  return value;
}

async function recordReconciledOrdinaryWorkflowCompletion(
  database: D1Database,
  row: OrdinaryWorkflowReconciliationRow,
  request: OrdinaryWorkflowRequest,
  workflowId: string,
  observedAt: string
): Promise<void> {
  if (!isOrdinaryWorkflowId(workflowId, request.baseId)) {
    throw new Error("The reconciled ordinary Workflow identity is invalid.");
  }
  const result = await database.prepare(
    `INSERT INTO workflow_runs
     (workflow_id, root_workflow_id, project_id, workflow_type, status, attempt,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, 'complete', 1, ?, ?)
     ON CONFLICT(workflow_id) DO UPDATE SET
       status = 'complete', last_error_code = NULL, updated_at = excluded.updated_at
     WHERE workflow_runs.root_workflow_id = excluded.root_workflow_id
       AND workflow_runs.project_id = excluded.project_id
       AND workflow_runs.workflow_type = excluded.workflow_type
       AND workflow_runs.status NOT IN ('failed', 'terminated')`
  )
    .bind(
      workflowId,
      request.params.eventId,
      row.project_id,
      row.event_type,
      row.dispatched_at,
      observedAt
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error("The reconciled ordinary Workflow run conflicts with terminal state.");
  }
}

function isOrdinaryWorkflowId(workflowId: string, baseId: string): boolean {
  if (workflowId === baseId) {
    return true;
  }
  for (let repair = 1; repair <= ORDINARY_WORKFLOW_MAX_REPAIRS; repair += 1) {
    if (workflowId === `${baseId}-repair-${repair}`) {
      return true;
    }
  }
  return false;
}

async function deferOrdinaryWorkflowReconciliation(
  database: D1Database,
  row: OrdinaryWorkflowReconciliationRow,
  observedAt: string,
  errorCode: "WORKFLOW_RECONCILIATION_PENDING" | "WORKFLOW_CONTROL_PLANE_UNKNOWN"
): Promise<void> {
  await database.prepare(
    `/* ordinary_workflow_defer */
     UPDATE outbox_events
     SET next_attempt_at = ?, last_error_code = ?
     WHERE event_id = ? AND project_id = ? AND payload_digest = ?
       AND dispatched_at IS NOT NULL AND failed_at IS NULL
       AND next_attempt_at IS ? AND last_error_code IS ?
       AND (
         last_error_code IS NULL
         OR last_error_code IN (
           'WORKFLOW_RECONCILIATION_PENDING', 'WORKFLOW_CONTROL_PLANE_UNKNOWN'
         )
       )`
  )
    .bind(
      new Date(Date.parse(observedAt) + ORDINARY_WORKFLOW_RECONCILIATION_DELAY_MS).toISOString(),
      errorCode,
      row.event_id,
      row.project_id,
      row.payload_digest,
      row.next_attempt_at,
      row.last_error_code
    )
    .run();
}

async function markOrdinaryWorkflowTerminal(
  database: D1Database,
  row: OrdinaryWorkflowReconciliationRow,
  errorCode: "WORKFLOW_COMPLETE" | "SYNTHETIC_CLEANUP_FENCED"
): Promise<void> {
  await database.prepare(
    `/* ordinary_workflow_terminal */
     UPDATE outbox_events
     SET next_attempt_at = NULL, last_error_code = ?
     WHERE event_id = ? AND project_id = ? AND payload_digest = ?
       AND dispatched_at IS NOT NULL AND failed_at IS NULL
       AND next_attempt_at IS ? AND last_error_code IS ?
       AND (
         last_error_code IS NULL
         OR last_error_code IN (
           'WORKFLOW_RECONCILIATION_PENDING', 'WORKFLOW_CONTROL_PLANE_UNKNOWN'
         )
       )`
  )
    .bind(
      errorCode,
      row.event_id,
      row.project_id,
      row.payload_digest,
      row.next_attempt_at,
      row.last_error_code
    )
    .run();
}

async function failOrdinaryWorkflowReconciliation(
  database: D1Database,
  row: OrdinaryWorkflowReconciliationRow,
  errorCode: "WORKFLOW_RECONCILIATION_INVALID" | "WORKFLOW_REPAIR_EXHAUSTED",
  observedAt: string
): Promise<void> {
  await database.prepare(
    `/* ordinary_workflow_fail */
     UPDATE outbox_events
     SET failed_at = ?, next_attempt_at = NULL, last_error_code = ?
     WHERE event_id = ? AND project_id = ? AND payload_digest = ?
       AND dispatched_at IS NOT NULL AND failed_at IS NULL
       AND next_attempt_at IS ? AND last_error_code IS ?
       AND (
         last_error_code IS NULL
         OR last_error_code IN (
           'WORKFLOW_RECONCILIATION_PENDING', 'WORKFLOW_CONTROL_PLANE_UNKNOWN'
         )
       )`
  )
    .bind(
      observedAt,
      errorCode,
      row.event_id,
      row.project_id,
      row.payload_digest,
      row.next_attempt_at,
      row.last_error_code
    )
    .run();
}

async function reconcileDispatchedProjectionRebuilds(
  env: Env,
  throttle: WorkflowThrottleState
): Promise<WorkflowThrottleState> {
  const observedAt = new Date().toISOString();
  const rows = await env.MEMORY_DB.prepare(
    `SELECT e.event_id, e.project_id, e.project_version, e.event_type,
            e.payload_digest, e.payload_json, e.dispatched_at, e.next_attempt_at,
            e.last_error_code, e.projection_unknown_count,
            latest.workflow_id AS latest_workflow_id,
            latest.status AS latest_workflow_status
     FROM outbox_events AS e INDEXED BY outbox_projection_rebuild_reconcile
     LEFT JOIN workflow_runs AS latest
       ON latest.workflow_id = (
         SELECT candidate.workflow_id
         FROM workflow_runs AS candidate
         WHERE candidate.project_id = e.project_id
           AND candidate.root_workflow_id = e.event_id
         ORDER BY candidate.updated_at DESC, candidate.workflow_id DESC
         LIMIT 1
       )
     WHERE e.event_type = 'projection.rebuild.requested'
       AND e.event_id GLOB 'projection-rebuild:*'
       AND json_extract(e.payload_json, '$.projectionMode')
           IN ('snapshot', 'search', 'delete')
       AND e.dispatched_at IS NOT NULL
       AND e.failed_at IS NULL
       AND (
         e.last_error_code IS NULL
         OR e.last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'
       )
       AND COALESCE(e.next_attempt_at, '') <= ?
       AND (
         COALESCE(e.next_attempt_at, ''),
         json_extract(e.payload_json, '$.projectionTargetId'),
         json_extract(e.payload_json, '$.executionOrdinal'),
         e.event_id
       ) > (?, ?, ?, ?)
     ORDER BY
       COALESCE(e.next_attempt_at, ''),
       json_extract(e.payload_json, '$.projectionTargetId'),
       json_extract(e.payload_json, '$.executionOrdinal'),
       e.event_id
     LIMIT ?`
  )
    .bind(
      observedAt,
      "",
      "",
      -1,
      "",
      PROJECTION_REBUILD_RECONCILIATION_LIMIT
    )
    .all<ProjectionRebuildReconciliationRow>();

  for (const row of rows.results) {
    let payload: Record<string, unknown>;
    let rebuild: Awaited<ReturnType<typeof parseProjectionRebuildDispatch>>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      rebuild = await parseProjectionRebuildDispatch(row, payload);
      if (rebuild === null) {
        throw new Error("The projection rebuild reconciliation row is invalid.");
      }
    } catch {
      await failProjectionRebuildReconciliation(
        env.MEMORY_DB,
        row,
        "PROJECTION_REBUILD_INVALID",
        observedAt
      );
      continue;
    }

    const latestStatus = row.latest_workflow_status;
    if (latestStatus !== null && PROJECTION_REBUILD_TERMINAL_STATUSES.has(latestStatus)) {
      await markProjectionRebuildTerminal(env.MEMORY_DB, row, latestStatus);
      continue;
    }

    try {
      ({ workflowWindowStartedAt: throttle.workflowWindowStartedAt,
        workflowStartsInWindow: throttle.workflowStartsInWindow } =
        await throttleProjectionWorkflowStart(
          throttle.workflowWindowStartedAt,
          throttle.workflowStartsInWindow
        ));
      const workflowId = await ensureProjectionWorkflow(
        env,
        row.project_id,
        row.project_id,
        rebuild.projectVersion,
        { eventId: row.event_id, request: rebuild.request }
      );
      if (workflowId === null) {
        await failProjectionRebuildReconciliation(
          env.MEMORY_DB,
          row,
          "PROJECTION_REBUILD_PROJECT_UNAVAILABLE",
          observedAt
        );
        continue;
      }
      let workflowStatus: { status: string };
      try {
        const workflow = await env.MEMORY_WORKFLOW.get(workflowId);
        workflowStatus = await workflow.status();
      } catch {
        await observeUnknownProjectionRebuildStatus(env.MEMORY_DB, row, observedAt);
        continue;
      }
      if (workflowStatus.status === "complete") {
        await recordReconciledProjectionWorkflowCompletion(
          env.MEMORY_DB,
          row,
          workflowId,
          observedAt
        );
        await markProjectionRebuildTerminal(env.MEMORY_DB, row, "complete");
        continue;
      }
      if (PROJECTION_WORKFLOW_REPAIRABLE_TERMINAL_STATUSES.has(workflowStatus.status)) {
        if (await projectionWorkflowRepairsExhausted(env, row.event_id)) {
          await failProjectionRebuildReconciliation(
            env.MEMORY_DB,
            row,
            "PROJECTION_REBUILD_REPAIR_EXHAUSTED",
            observedAt
          );
        } else {
          await deferUncertainProjectionRebuildReconciliation(
            env.MEMORY_DB,
            row,
            observedAt
          );
        }
        continue;
      }
      if (
        !PROJECTION_WORKFLOW_KNOWN_NONTERMINAL_STATUSES.has(workflowStatus.status)
      ) {
        await observeUnknownProjectionRebuildStatus(env.MEMORY_DB, row, observedAt);
        continue;
      }
      await deferKnownProjectionRebuildReconciliation(env.MEMORY_DB, row, observedAt);
    } catch (error) {
      if (error instanceof WorkflowControlPlaneStatusError) {
        await observeUnknownProjectionRebuildStatus(env.MEMORY_DB, row, observedAt);
        continue;
      }
      if (await projectionWorkflowRepairsExhausted(env, row.event_id)) {
        await failProjectionRebuildReconciliation(
          env.MEMORY_DB,
          row,
          "PROJECTION_REBUILD_REPAIR_EXHAUSTED",
          observedAt
        );
      } else {
        await deferUncertainProjectionRebuildReconciliation(env.MEMORY_DB, row, observedAt);
      }
    }
  }
  return throttle;
}

async function recordReconciledProjectionWorkflowCompletion(
  database: D1Database,
  row: ProjectionRebuildReconciliationRow,
  workflowId: string,
  observedAt: string
): Promise<void> {
  const baseId = await projectionRebuildWorkflowId(row.event_id);
  if (!isProjectionWorkflowId(workflowId, baseId)) {
    throw new Error("The reconciled Workflow identity is invalid.");
  }
  const result = await database.prepare(
    `INSERT INTO workflow_runs
     (workflow_id, root_workflow_id, project_id, workflow_type, status, attempt,
      created_at, updated_at)
     VALUES (?, ?, ?, 'projection.rebuild.requested', 'complete', 1, ?, ?)
     ON CONFLICT(workflow_id) DO UPDATE SET
       status = 'complete', last_error_code = NULL, updated_at = excluded.updated_at
     WHERE workflow_runs.root_workflow_id = excluded.root_workflow_id
       AND workflow_runs.project_id = excluded.project_id
       AND workflow_runs.workflow_type = excluded.workflow_type
       AND workflow_runs.status NOT IN ('failed', 'terminated')`
  )
    .bind(workflowId, row.event_id, row.project_id, row.dispatched_at, observedAt)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error("The reconciled Workflow run conflicts with a terminal record.");
  }
}

async function markProjectionRebuildTerminal(
  database: D1Database,
  row: ProjectionRebuildReconciliationRow,
  status: string
): Promise<void> {
  const errorCode =
    status === "complete"
      ? "PROJECTION_REBUILD_COMPLETE"
      : status === "failed"
        ? "PROJECTION_REBUILD_WORKFLOW_FAILED"
        : "PROJECTION_REBUILD_WORKFLOW_TERMINATED";
  await database.prepare(
    `UPDATE outbox_events
     SET next_attempt_at = NULL, last_error_code = ?
     WHERE event_id = ? AND project_id = ? AND payload_digest = ?
       AND dispatched_at IS NOT NULL AND failed_at IS NULL
       AND (
         last_error_code IS NULL
         OR last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'
       )`
  )
    .bind(errorCode, row.event_id, row.project_id, row.payload_digest)
    .run();
}

async function observeUnknownProjectionRebuildStatus(
  database: D1Database,
  row: ProjectionRebuildReconciliationRow,
  observedAt: string
): Promise<void> {
  await database.prepare(
    `UPDATE outbox_events
     SET next_attempt_at = ?,
         projection_unknown_count = CASE
           WHEN projection_unknown_count < ? THEN projection_unknown_count + 1
           ELSE projection_unknown_count
         END,
         projection_unknown_first_observed_at = CASE
           WHEN projection_unknown_count = 0 THEN ?
           ELSE COALESCE(projection_unknown_first_observed_at, ?)
         END,
         projection_unknown_last_observed_at = ?,
         projection_unknown_alerted_at = CASE
           WHEN projection_unknown_count + 1 >= ?
             THEN COALESCE(projection_unknown_alerted_at, ?)
           ELSE projection_unknown_alerted_at
         END,
         last_error_code = CASE
           WHEN projection_unknown_count + 1 >= ? OR last_error_code = ? THEN ?
           ELSE NULL
         END
     WHERE event_id = ? AND project_id = ? AND payload_digest = ?
       AND dispatched_at IS NOT NULL AND failed_at IS NULL
       AND (last_error_code IS NULL OR last_error_code = ?)
       AND projection_unknown_count = ?
       AND next_attempt_at IS ?
       AND last_error_code IS ?`
  )
    .bind(
      new Date(Date.parse(observedAt) + PROJECTION_REBUILD_RECONCILIATION_DELAY_MS).toISOString(),
      PROJECTION_REBUILD_UNKNOWN_ALERT_THRESHOLD,
      observedAt,
      observedAt,
      observedAt,
      PROJECTION_REBUILD_UNKNOWN_ALERT_THRESHOLD,
      observedAt,
      PROJECTION_REBUILD_UNKNOWN_ALERT_THRESHOLD,
      PROJECTION_REBUILD_UNKNOWN_ERROR_CODE,
      PROJECTION_REBUILD_UNKNOWN_ERROR_CODE,
      row.event_id,
      row.project_id,
      row.payload_digest,
      PROJECTION_REBUILD_UNKNOWN_ERROR_CODE,
      row.projection_unknown_count,
      row.next_attempt_at,
      row.last_error_code
    )
    .run();
}

async function deferKnownProjectionRebuildReconciliation(
  database: D1Database,
  row: ProjectionRebuildReconciliationRow,
  observedAt: string
): Promise<void> {
  await database.prepare(
    `UPDATE outbox_events
     SET next_attempt_at = ?, last_error_code = NULL,
         projection_unknown_count = 0,
         projection_unknown_first_observed_at = NULL,
         projection_unknown_last_observed_at = NULL,
         projection_unknown_alerted_at = NULL
     WHERE event_id = ? AND project_id = ? AND payload_digest = ?
       AND dispatched_at IS NOT NULL AND failed_at IS NULL
       AND (
         last_error_code IS NULL
         OR last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'
       )
       AND projection_unknown_count = ?
       AND next_attempt_at IS ?
       AND last_error_code IS ?`
  )
    .bind(
      new Date(Date.parse(observedAt) + PROJECTION_REBUILD_RECONCILIATION_DELAY_MS).toISOString(),
      row.event_id,
      row.project_id,
      row.payload_digest,
      row.projection_unknown_count,
      row.next_attempt_at,
      row.last_error_code
    )
    .run();
}

async function deferUncertainProjectionRebuildReconciliation(
  database: D1Database,
  row: ProjectionRebuildReconciliationRow,
  observedAt: string
): Promise<void> {
  await database.prepare(
    `UPDATE outbox_events
     SET next_attempt_at = ?
     WHERE event_id = ? AND project_id = ? AND payload_digest = ?
       AND dispatched_at IS NOT NULL AND failed_at IS NULL
       AND (
         last_error_code IS NULL
         OR last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'
       )`
  )
    .bind(
      new Date(Date.parse(observedAt) + PROJECTION_REBUILD_RECONCILIATION_DELAY_MS).toISOString(),
      row.event_id,
      row.project_id,
      row.payload_digest
    )
    .run();
}

async function failProjectionRebuildReconciliation(
  database: D1Database,
  row: ProjectionRebuildReconciliationRow,
  errorCode: string,
  observedAt: string
): Promise<void> {
  await database.prepare(
    `UPDATE outbox_events
     SET failed_at = ?, next_attempt_at = NULL, last_error_code = ?
     WHERE event_id = ? AND project_id = ? AND payload_digest = ?
       AND dispatched_at IS NOT NULL AND failed_at IS NULL
       AND (
         last_error_code IS NULL
         OR last_error_code = 'PROJECTION_REBUILD_CONTROL_PLANE_UNKNOWN'
       )`
  )
    .bind(observedAt, errorCode, row.event_id, row.project_id, row.payload_digest)
    .run();
}

async function projectionWorkflowRepairsExhausted(env: Env, eventId: string): Promise<boolean> {
  if (!eventId.startsWith("projection-rebuild:")) {
    return false;
  }
  const baseId = await projectionRebuildWorkflowId(eventId);
  for (let repair = 0; repair <= PROJECTION_WORKFLOW_MAX_REPAIRS; repair += 1) {
    const workflowId = repair === 0 ? baseId : `${baseId}-repair-${repair}`;
    try {
      const instance = await env.MEMORY_WORKFLOW.get(workflowId);
      const status = await instance.status();
      if (status.status !== "errored" && status.status !== "terminated") {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function projectionRebuildWorkflowId(eventId: string): Promise<string> {
  return `projection-rebuild-${await sha256(eventId)}`;
}

function isProjectionWorkflowId(workflowId: string, baseId: string): boolean {
  if (workflowId === baseId) {
    return true;
  }
  for (let repair = 1; repair <= PROJECTION_WORKFLOW_MAX_REPAIRS; repair += 1) {
    if (workflowId === `${baseId}-repair-${repair}`) {
      return true;
    }
  }
  return false;
}

async function ensureProjectionWorkflow(
  env: Env,
  projectId: string,
  memoryId: string,
  projectVersion: number,
  rebuild?: {
    eventId: string;
    request: ProjectionRebuildRequest;
  }
): Promise<string | null> {
  if (!(await isProjectWorkAdmitted(env.MEMORY_DB, projectId))) {
    return null;
  }
  if (
    rebuild !== undefined &&
    !rebuild.eventId.startsWith("projection-rebuild:")
  ) {
    throw new Error("The projection rebuild identity and payload do not match.");
  }
  const id = rebuild === undefined
    ? `projection-${projectId}-${projectVersion}`
    : await projectionRebuildWorkflowId(rebuild.eventId);
  return ensureWorkflowWithRepair(
    env.MEMORY_WORKFLOW,
    id,
    {
      eventId: rebuild?.eventId ?? `${projectId}:${projectVersion}`,
      projectId,
      type: rebuild === undefined ? "memory.changed" : "projection.rebuild.requested",
      subjectId: memoryId,
      projectVersion,
      ...(rebuild === undefined ? {} : { projectionRebuild: rebuild.request })
    },
    PROJECTION_WORKFLOW_MAX_REPAIRS
  );
}

async function resolveMutationRevision(
  input: z.infer<typeof mutationSchema>,
  current: {
    content: string;
    valid_from: string | null;
    valid_until: string | null;
  },
  database: D1Database
): Promise<{ content: string; validFrom: string | null; validUntil: string | null }> {
  if (input.operation === "correct") {
    const content = input.payload.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new EdgeMnemeError("VALIDATION_FAILED", "A correction requires content.");
    }
    return {
      content,
      validFrom: current.valid_from,
      validUntil: current.valid_until
    };
  }
  if (input.operation === "invalidate") {
    return {
      content: current.content,
      validFrom: current.valid_from,
      validUntil: current.valid_until
    };
  }
  const rollbackVersion = input.payload.memory_version;
  if (!Number.isSafeInteger(rollbackVersion) || Number(rollbackVersion) < 1) {
    throw new EdgeMnemeError("VALIDATION_FAILED", "A rollback requires a memory version.");
  }
  const revision = await database
    .prepare(
      `SELECT content, valid_from, valid_until FROM memory_versions
       WHERE project_id = ? AND memory_id = ? AND memory_version = ?`
    )
    .bind(input.project_id, input.target_memory_id, rollbackVersion)
    .first<{ content: string; valid_from: string | null; valid_until: string | null }>();
  if (revision === null) {
    throw new EdgeMnemeError("RESOURCE_UNAVAILABLE", "The rollback version is unavailable.");
  }
  return {
    content: revision.content,
    validFrom: revision.valid_from,
    validUntil: revision.valid_until
  };
}
