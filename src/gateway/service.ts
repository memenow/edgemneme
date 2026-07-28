import type { AuthenticatedPrincipal } from "../security/auth";
import {
  hierarchicalMemoryAccessPredicate,
  requireProjectRole,
  requireRepositoryRole,
  requireRole
} from "../security/auth";
import { EdgeMnemeError } from "../contracts/errors";
import {
  inspectMemoryModelInput,
  inspectMemoryModelValue,
  inspectModelInput,
  inspectPersistedValue
} from "../quality/sensitive-content";
import { sha256 } from "../security/crypto";
import { canonicalJson } from "../security/canonical-json";
import { createPageToken, readPageToken } from "../security/page-token";
import { createCloudflareSearchPipeline } from "../search/cloudflare";
import { readGatewayResource } from "./resources";
import type { GatewayEnv } from "./types";
import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES
} from "../contracts/taxonomy";
import { resolveMemoryChangeRepositoryContext } from "../contracts/repository-context";

export interface CandidateEvidenceInput {
  source_type: string;
  locator: string;
  commit_sha?: string | undefined;
  excerpt_hash?: string | undefined;
}

export interface CandidateReviewEdits {
  content?: string | undefined;
  kind?: string | undefined;
  memory_class?: string | undefined;
  scope?: string | undefined;
  scope_id?: string | undefined;
  valid_from?: string | null | undefined;
  valid_until?: string | null | undefined;
}

interface SessionRepositoryContext {
  repositoryId: string | null;
  repositoryRef: string | null;
  worktreeId: string | null;
  status: "open" | "closed" | "expired";
}

interface NormalizedWorktreeContext {
  repositoryId: string | null;
  repositoryRef: string | null;
  worktreeId: string | null;
}

export type { GatewayEnv } from "./types";

export type MemoryEvent =
  | {
      type: "candidate.submitted";
      eventId: string;
      projectId: string;
      candidateId: string;
      idempotencyKey: string;
    }
  | {
      type: "session.consolidation.requested";
      eventId: string;
      projectId: string;
      sessionId: string;
      idempotencyKey: string;
    }
  | {
      type: "github.sync.requested";
      eventId: string;
      projectId: string;
      repositoryId: string;
      externalRepositoryId: number;
      ref: string;
      observedSha: string;
      idempotencyKey: string;
    }
  | {
      type: "candidate.reviewed";
      eventId: string;
      projectId: string;
      candidateId: string;
      projectVersion: number;
    };

export class GatewayService {
  constructor(
    private readonly env: GatewayEnv,
    private readonly principal: AuthenticatedPrincipal
  ) {}

  async resolveProject(locator: string): Promise<Record<string, unknown>> {
    const row = await this.env.MEMORY_DB.prepare(
      `SELECT project_id, project_ref, display_name, project_version
       FROM projects
       WHERE project_id = ? AND (project_ref = ? OR locator = ?)
       LIMIT 1`
    )
      .bind(this.principal.projectId, locator, locator)
      .first<Record<string, unknown>>();
    if (row === null) {
      throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
    }
    return row;
  }

  async openSession(input: {
    projectRef: string;
    agentMeta: Record<string, unknown>;
    worktreeMeta?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    requireRole(this.principal, "writer");
    assertSafeMemoryModelValue(input.agentMeta, 16 * 1024);
    assertSafeMemoryModelValue(input.worktreeMeta ?? null, 16 * 1024);
    const context = normalizeWorktreeContext(input.worktreeMeta);
    const persistedWorktreeContext = persistedWorktreeMetadata(context);
    await this.requireContextRole(context.repositoryId, "writer");
    await this.assertProjectRef(input.projectRef);
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      const results = await this.env.MEMORY_DB.batch([
        this.projectMutationGuard(),
        this.env.MEMORY_DB.prepare(
          `INSERT INTO sessions
           (session_id, project_id, principal_id, session_version, status, agent_meta_json,
            worktree_meta_json, repository_id, repository_ref, worktree_id, opened_at)
           SELECT ?, ?, ?, 1, 'open', ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM project_grants session_grant
             LEFT JOIN project_grant_repository_contexts session_grant_context
               ON session_grant_context.project_id = session_grant.project_id
              AND session_grant_context.grant_id = session_grant.grant_id
             WHERE session_grant.project_id = ? AND session_grant.principal_id = ?
               AND session_grant.revoked_at IS NULL
               AND session_grant.role IN ('writer', 'maintainer')
               AND (
                 (
                   session_grant.scope_kind = 'project'
                   AND session_grant.scope_id = session_grant.project_id
                 )
                 OR (? IS NOT NULL AND session_grant_context.repository_id = ?)
               )
           )`
        ).bind(
          sessionId,
          this.principal.projectId,
          this.principal.principalId,
          JSON.stringify(input.agentMeta),
          JSON.stringify(persistedWorktreeContext),
          context.repositoryId,
          context.repositoryRef,
          context.worktreeId,
          now,
          this.principal.projectId,
          this.principal.principalId,
          context.repositoryId,
          context.repositoryId
        )
      ]);
      assertMutationGuardResult(results[0]);
      if ((results[1]?.meta.changes ?? 0) !== 1) {
        await this.requireContextRole(context.repositoryId, "writer");
        throw new EdgeMnemeError("INTERNAL", "The session could not be opened.");
      }
    } catch (error) {
      throw await this.translateGatewayMutationError(error);
    }
    return { session_id: sessionId, session_version: 1, opened_at: now };
  }

  async search(input: {
    projectRef: string;
    query?: string;
    filters?: {
      kind?: string;
      memory_class?: string;
      scope?: string;
      scope_id?: string;
      status?: string;
    };
    limit?: number;
    pageToken?: string;
    sessionId?: string;
  }): Promise<Record<string, unknown>> {
    await this.assertProjectRef(input.projectRef);
    const hasQuery = input.query !== undefined && input.query.trim() !== "";
    if (
      hasQuery &&
      !inspectModelInput(input.query ?? "", { maxBytes: 4 * 1024 }).accepted
    ) {
      throw new EdgeMnemeError(
        "VALIDATION_FAILED",
        "The search query cannot be processed safely."
      );
    }
    if (input.filters?.scope !== undefined && input.filters.scope_id === undefined) {
      throw new EdgeMnemeError(
        "VALIDATION_FAILED",
        "A scope filter requires scope_id."
      );
    }
    const authorizedRepositoryIds = await this.resolveSearchRepositoryAccess(
      input.sessionId
    );
    const maximum = hasQuery ? 10 : 50;
    const limit = Math.min(Math.max(input.limit ?? (hasQuery ? 5 : 20), 1), maximum);
    const snapshotVersion = await this.projectVersion();
    if (hasQuery) {
      if (input.pageToken !== undefined) {
        throw new EdgeMnemeError(
          "PAGE_TOKEN_INVALID",
          "Recall search returns a bounded context pack and does not use page tokens."
        );
      }
      try {
        const runtime = await createCloudflareSearchPipeline({
          searchDatabase: this.env.SEARCH_DB,
          memoryDatabase: this.env.MEMORY_DB,
          vectors: this.env.MEMORY_VECTORS,
          ai: this.env.AI
        });
        const result = await runtime.pipeline.search({
          projectId: this.principal.projectId,
          principalId: this.principal.principalId,
          authorizedRepositoryIds,
          snapshotVersion,
          query: input.query ?? "",
          indexGeneration: runtime.generation.id,
          limit,
          now: new Date().toISOString(),
          ...(input.filters?.status === undefined
            ? {}
            : { statuses: [parseTaxonomy(input.filters.status, MEMORY_STATUSES, "status")] }),
          ...(input.filters?.kind === undefined
            ? {}
            : { kinds: [parseTaxonomy(input.filters.kind, MEMORY_KINDS, "kind")] }),
          ...(input.filters?.memory_class === undefined
            ? {}
            : {
                memoryClasses: [
                  parseTaxonomy(input.filters.memory_class, MEMORY_CLASSES, "memory class")
                ]
              }),
          ...(input.filters?.scope === undefined
            ? {}
            : {
                scope: {
                  type: parseTaxonomy(input.filters.scope, MEMORY_SCOPES, "scope"),
                  ids: [input.filters.scope_id ?? ""]
                }
              })
        });
        return {
          snapshot_version: result.snapshotVersion,
          index_generation: result.indexGeneration,
          abstained: result.abstained,
          abstention_reason: result.abstentionReason,
          memories: result.memories,
          context_pack: result.contextPack,
          next_page_token: null
        };
      } catch (error) {
        if (error instanceof EdgeMnemeError) {
          throw error;
        }
        throw new EdgeMnemeError(
          "RESOURCE_UNAVAILABLE",
          "The current search projection is unavailable.",
          { retryable: true }
        );
      }
    }
    const conditions = [
      "m.project_id = ?",
      `EXISTS (
        SELECT 1 FROM project_grants grant_row
        WHERE grant_row.project_id = m.project_id
          AND grant_row.principal_id = ? AND grant_row.revoked_at IS NULL
          AND ${hierarchicalMemoryAccessPredicate("grant_row", "m")}
      )`
    ];
    const bindings: unknown[] = [this.principal.projectId, this.principal.principalId];
    if (input.sessionId !== undefined) {
      if (authorizedRepositoryIds === undefined) {
        throw new EdgeMnemeError("INTERNAL", "The session scope could not be resolved.");
      }
      if (authorizedRepositoryIds.length === 0) {
        conditions.push("m.scope = 'project'");
      } else {
        conditions.push(
          `(m.scope = 'project' OR EXISTS (
            SELECT 1 FROM memory_repository_contexts session_memory_context
            WHERE session_memory_context.project_id = m.project_id
              AND session_memory_context.memory_id = m.memory_id
              AND session_memory_context.repository_id IN (${authorizedRepositoryIds
                .map(() => "?")
                .join(", ")})
          ))`
        );
        bindings.push(...authorizedRepositoryIds);
      }
    }
    if (input.filters?.status === undefined) {
      conditions.push("m.status = 'active'");
    }
    if (input.filters?.scope_id !== undefined) {
      conditions.push("m.scope_id = ?");
      bindings.push(input.filters.scope_id);
    }
    const filterColumns = {
      kind: "m.kind",
      memory_class: "m.memory_class",
      scope: "m.scope",
      status: "m.status"
    } as const;
    for (const [name, column] of Object.entries(filterColumns)) {
      const value = input.filters?.[name as keyof typeof filterColumns];
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        bindings.push(value);
      }
    }
    const queryDigest = await sha256(
      canonicalJson({
        query: input.query ?? null,
        filters: input.filters ?? {},
        limit,
        principalId: this.principal.principalId,
        sessionId: input.sessionId ?? null,
        authorizedRepositoryIds: authorizedRepositoryIds ?? null
      })
    );
    let validAt = new Date().toISOString();
    let cursor: Awaited<ReturnType<typeof readPageToken>> | undefined;
    if (input.pageToken !== undefined) {
      cursor = await readPageToken(
        input.pageToken,
        new TextEncoder().encode(this.env.PAGE_TOKEN_HMAC_KEY),
        {
          projectId: this.principal.projectId,
          queryDigest,
          nowEpochSeconds: Math.floor(Date.now() / 1000)
        }
      );
      if (cursor.snapshotVersion !== snapshotVersion) {
        throw new EdgeMnemeError(
          "PAGE_TOKEN_INVALID",
          "The page token no longer matches the project snapshot."
        );
      }
      validAt = cursor.validAt;
    }
    conditions.push("(v.valid_from IS NULL OR julianday(v.valid_from) <= julianday(?))");
    conditions.push("(v.valid_until IS NULL OR julianday(v.valid_until) > julianday(?))");
    bindings.push(validAt, validAt);
    if (cursor !== undefined) {
      const separator = cursor.lastSortKey.indexOf("|");
      if (separator < 1) {
        throw new EdgeMnemeError("PAGE_TOKEN_INVALID", "The page token is invalid.");
      }
      const updatedAt = cursor.lastSortKey.slice(0, separator);
      const memoryId = cursor.lastSortKey.slice(separator + 1);
      conditions.push("(m.updated_at < ? OR (m.updated_at = ? AND m.memory_id > ?))");
      bindings.push(updatedAt, updatedAt, memoryId);
    }
    const result = await this.env.MEMORY_DB.prepare(
      `SELECT m.memory_id, m.memory_version, m.kind, m.memory_class, m.scope, m.scope_id,
              m.status, m.updated_at, v.revision_id, v.content, v.content_sha256,
              v.valid_from, v.valid_until
       FROM memories m
       JOIN memory_versions v ON v.revision_id = m.current_revision_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.updated_at DESC, m.memory_id ASC
       LIMIT ?`
    )
      .bind(...bindings, limit)
      .all<Record<string, unknown>>();
    const versionAfterRead = await this.projectVersion();
    if (versionAfterRead !== snapshotVersion) {
      throw new EdgeMnemeError(
        "VERSION_CONFLICT",
        "The project changed while the page was being read.",
        { retryable: true }
      );
    }
    const last = result.results.at(-1);
    const nextPageToken =
      result.results.length === limit &&
      typeof last?.updated_at === "string" &&
      typeof last.memory_id === "string"
        ? await createPageToken(
            {
              projectId: this.principal.projectId,
              queryDigest,
              snapshotVersion,
              lastSortKey: `${last.updated_at}|${last.memory_id}`,
              validAt,
              expiresAt: Math.floor(Date.now() / 1000) + 15 * 60
            },
            new TextEncoder().encode(this.env.PAGE_TOKEN_HMAC_KEY)
          )
        : null;
    return {
      snapshot_version: snapshotVersion,
      memories: result.results,
      next_page_token: nextPageToken
    };
  }

  async submitCandidate(input: {
    projectRef: string;
    sessionId: string;
    content: string;
    evidence: CandidateEvidenceInput[];
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    requireRole(this.principal, "writer");
    const evidence = normalizeCandidateEvidence(input.evidence);
    assertSafeMemoryModelValue(evidence, 32 * 1024);
    assertAgentEvidenceSources(evidence);
    await this.assertProjectRef(input.projectRef);
    const session = await this.readOwnedSession(input.sessionId);
    await this.requireContextRole(session.repositoryId, "writer");
    const payloadDigest = await sha256(
      canonicalJson({
        sessionId: input.sessionId,
        content: input.content,
        evidence
      })
    );
    const existing = await this.readAuthoritativeIdempotency(
      "candidate_submit",
      input.idempotencyKey
    );
    if (existing !== null) {
      if (existing.request_digest !== payloadDigest) {
        throw new EdgeMnemeError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used with a different payload."
        );
      }
      return JSON.parse(existing.response_json) as Record<string, unknown>;
    }
    if (session.status !== "open") {
      throw new EdgeMnemeError(
        "VALIDATION_FAILED",
        "The session is unavailable or closed."
      );
    }
    await this.assertProjectMutationAdmitted();

    const inspection = inspectMemoryModelInput(input.content);
    const candidateId = crypto.randomUUID();
    const now = new Date().toISOString();
    const response = {
      candidate_id: candidateId,
      candidate_version: 1,
      status: inspection.accepted ? "queued" : "rejected_sensitive",
      workflow_id: inspection.accepted ? candidateId : null
    };
    const candidateContentSha = inspection.accepted ? await sha256(input.content) : null;
    const evidenceStatements: D1PreparedStatement[] = [];
    const evidenceLinkStatements: D1PreparedStatement[] = [];
    if (inspection.accepted && candidateContentSha !== null) {
      for (const item of evidence) {
        const locator = namespaceEvidenceLocator(item.locator, session.repositoryId);
        const excerptHash =
          item.excerpt_hash ??
          (await sha256(`${locator}\n${candidateContentSha}`));
        const evidenceId = await sha256(
          `${this.principal.projectId}\n${item.source_type}\n${locator}\n${excerptHash}`
        );
        evidenceStatements.push(
          this.env.MEMORY_DB.prepare(
            `INSERT INTO evidence
             (evidence_id, project_id, source_type, locator, commit_sha, excerpt_hash,
              sensitivity_status, recorded_at, repository_id, repository_ref,
              repository_path, repository_authority)
             SELECT ?, ?, ?, ?, ?, ?, 'clear', ?, ?, ?, NULL, ?
             WHERE EXISTS (
               SELECT 1 FROM observations
               WHERE project_id = ? AND principal_id = ? AND session_id = ?
                 AND observation_id = ?
             )
             ON CONFLICT(project_id, source_type, locator, excerpt_hash) DO NOTHING`
          ).bind(
            evidenceId,
            this.principal.projectId,
            item.source_type,
            locator,
            item.commit_sha ?? null,
            excerptHash,
            now,
            session.repositoryId,
            session.repositoryRef,
            session.repositoryId === null ? null : "agent_supplied",
            this.principal.projectId,
            this.principal.principalId,
            input.sessionId,
            candidateId
          )
        );
        evidenceLinkStatements.push(
          this.env.MEMORY_DB.prepare(
            `INSERT INTO observation_evidence
             (project_id, observation_id, evidence_id, created_at)
             SELECT ?, ?, evidence_id, ? FROM evidence
             WHERE project_id = ? AND source_type = ? AND locator = ? AND excerpt_hash = ?
               AND EXISTS (
                 SELECT 1 FROM observations
                 WHERE project_id = ? AND principal_id = ? AND session_id = ?
                   AND observation_id = ?
               )`
          ).bind(
            this.principal.projectId,
            candidateId,
            now,
            this.principal.projectId,
            item.source_type,
            locator,
            excerptHash,
            this.principal.projectId,
            this.principal.principalId,
            input.sessionId,
            candidateId
          )
        );
      }
    }
    let results: D1Result[];
    try {
      results = await this.env.MEMORY_DB.batch([
        this.projectMutationGuard(),
        this.env.MEMORY_DB.prepare(
          `INSERT INTO observations
           (observation_id, project_id, session_id, principal_id, candidate_version, status,
            content, content_sha256, evidence_json, created_at)
           SELECT ?, session.project_id, session.session_id, session.principal_id,
                  1, ?, ?, ?, ?, ?
           FROM sessions session
           WHERE session.project_id = ? AND session.principal_id = ?
             AND session.session_id = ? AND session.status = 'open'
             AND ${sessionWriterAuthorizationPredicate("session")}`
        ).bind(
          candidateId,
          response.status,
          inspection.accepted ? input.content : null,
          candidateContentSha,
          inspection.accepted ? canonicalJson(evidence) : "[]",
          now,
          this.principal.projectId,
          this.principal.principalId,
          input.sessionId
        ),
        ...evidenceStatements,
        ...evidenceLinkStatements,
        this.env.MEMORY_DB.prepare(
          `INSERT INTO idempotency_records
           (project_id, principal_id, operation, idempotency_key, request_digest,
            response_json, created_at)
           SELECT ?, ?, 'candidate_submit', ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM observations
             WHERE project_id = ? AND principal_id = ? AND session_id = ?
               AND observation_id = ?
           )`
        ).bind(
          this.principal.projectId,
          this.principal.principalId,
          input.idempotencyKey,
          payloadDigest,
          JSON.stringify(response),
          now,
          this.principal.projectId,
          this.principal.principalId,
          input.sessionId,
          candidateId
        ),
        this.env.MEMORY_DB.prepare(
          `INSERT INTO outbox_events
           (event_id, project_id, project_version, event_type, payload_digest,
            payload_json, created_at)
           SELECT ?, ?, project_version, 'candidate.submitted', ?, ?, ?
           FROM projects
           WHERE project_id = ? AND ? = 1
             AND EXISTS (
               SELECT 1 FROM observations
               WHERE project_id = ? AND principal_id = ? AND session_id = ?
                 AND observation_id = ?
             )`
        ).bind(
          candidateId,
          this.principal.projectId,
          payloadDigest,
          JSON.stringify({
            type: "candidate.submitted",
            eventId: candidateId,
            projectId: this.principal.projectId,
            candidateId,
            idempotencyKey: input.idempotencyKey
          }),
          now,
          this.principal.projectId,
          inspection.accepted ? 1 : 0,
          this.principal.projectId,
          this.principal.principalId,
          input.sessionId,
          candidateId
        )
      ]);
      assertMutationGuardResult(results[0]);
    } catch (error) {
      const mutationError = await this.translateGatewayMutationError(error);
      if (
        mutationError instanceof EdgeMnemeError &&
        mutationError.code === "PROJECT_UNAVAILABLE"
      ) {
        throw mutationError;
      }
      const authoritative = await this.readAuthoritativeIdempotency(
        "candidate_submit",
        input.idempotencyKey
      );
      if (authoritative === null) {
        throw mutationError;
      }
      if (authoritative.request_digest !== payloadDigest) {
        throw new EdgeMnemeError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used with a different payload."
        );
      }
      return JSON.parse(authoritative.response_json) as Record<string, unknown>;
    }
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      const authoritative = await this.readAuthoritativeIdempotency(
        "candidate_submit",
        input.idempotencyKey
      );
      if (authoritative !== null) {
        if (authoritative.request_digest !== payloadDigest) {
          throw new EdgeMnemeError(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used with a different payload."
          );
        }
        return JSON.parse(authoritative.response_json) as Record<string, unknown>;
      }
      await this.requireContextRole(session.repositoryId, "writer");
      throw new EdgeMnemeError(
        "VALIDATION_FAILED",
        "The session is unavailable or closed."
      );
    }
    return response;
  }

  async submitMemoryChange(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    requireRole(this.principal, "maintainer");
    await requireProjectRole(this.env.MEMORY_DB, this.principal, "maintainer");
    assertSafe(input.payload, 64 * 1024);
    assertSafeMemoryModelValue(input.evidence, 32 * 1024);
    assertAgentEvidenceSources(input.evidence);
    await this.assertProjectMutationAdmitted();
    if (typeof input.target_memory_id !== "string") {
      throw new EdgeMnemeError("VALIDATION_FAILED", "A target memory is required.");
    }
    const targetRepositoryContext = await resolveMemoryChangeRepositoryContext(
      this.env.MEMORY_DB,
      this.principal.projectId,
      input.target_memory_id
    );
    if (targetRepositoryContext === null) {
      throw new EdgeMnemeError(
        "RESOURCE_UNAVAILABLE",
        "The target memory repository context is unavailable."
      );
    }
    const stub = this.env.PROJECT_COORDINATOR.get(
      this.env.PROJECT_COORDINATOR.idFromName(this.principal.projectId)
    );
    const response = await stub.fetch("https://project-coordinator/mutate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        project_id: this.principal.projectId,
        actor_principal_id: this.principal.principalId,
        target_repository_context: {
          scope: targetRepositoryContext.scope,
          scope_id: targetRepositoryContext.scopeId,
          repository_id: targetRepositoryContext.repositoryId,
          repository_ref: targetRepositoryContext.repositoryRef,
          session_id: targetRepositoryContext.sessionId,
          worktree_id: targetRepositoryContext.worktreeId
        }
      })
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new EdgeMnemeError(
        (body.code as
          | "PROJECT_UNAVAILABLE"
          | "RESOURCE_UNAVAILABLE"
          | "VALIDATION_FAILED"
          | "VERSION_CONFLICT"
          | "IDEMPOTENCY_CONFLICT"
          | "INTERNAL") ??
          "INTERNAL",
        String(body.message ?? "The memory change failed.")
      );
    }
    return body;
  }

  async reviewCandidate(input: {
    candidateId: string;
    expectedCandidateVersion: number;
    decision: "approve" | "reject" | "request_changes";
    reason: string;
    edits?: CandidateReviewEdits;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    requireRole(this.principal, "maintainer");
    await requireProjectRole(this.env.MEMORY_DB, this.principal, "maintainer");
    assertSafe(input.reason, 4 * 1024);
    assertSafe(input.edits ?? null, 64 * 1024);
    await this.assertProjectMutationAdmitted();
    const stub = this.env.PROJECT_COORDINATOR.get(
      this.env.PROJECT_COORDINATOR.idFromName(this.principal.projectId)
    );
    const response = await stub.fetch("https://project-coordinator/candidate-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalJson({
        candidate_id: input.candidateId,
        expected_candidate_version: input.expectedCandidateVersion,
        decision: input.decision,
        reason: input.reason,
        edits: input.edits ?? null,
        idempotency_key: input.idempotencyKey,
        project_id: this.principal.projectId,
        actor_principal_id: this.principal.principalId
      })
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new EdgeMnemeError(
        (body.code as
          | "PROJECT_UNAVAILABLE"
          | "VERSION_CONFLICT"
          | "IDEMPOTENCY_CONFLICT"
          | "VALIDATION_FAILED"
          | "INTERNAL") ??
          "INTERNAL",
        String(body.message ?? "The candidate review failed.")
      );
    }
    return body;
  }

  async closeSession(input: {
    sessionId: string;
    expectedSessionVersion: number;
    summary?: string;
    triggerConsolidation: boolean;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    requireRole(this.principal, "writer");
    assertSafeMemoryModelValue(input.summary ?? null, 8 * 1024);
    const session = await this.readOwnedSession(input.sessionId);
    await this.requireContextRole(session.repositoryId, "writer");
    await this.assertProjectMutationAdmitted();
    const now = new Date().toISOString();
    const payloadDigest = await sha256(canonicalJson(input));
    const existing = await this.readIdempotency("session_close", input.idempotencyKey);
    if (existing !== null) {
      if (existing.request_digest !== payloadDigest) {
        throw new EdgeMnemeError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used with a different payload."
        );
      }
      return parseSessionCloseResponse(existing.response_json);
    }
    const eventId = crypto.randomUUID();
    const response = {
      session_id: input.sessionId,
      session_version: input.expectedSessionVersion + 1,
      status: "closed",
      workflow_id: input.triggerConsolidation ? eventId : null
    };
    const responseJson = JSON.stringify({ ...response, _claim_event_id: eventId });
    const closedAt = sessionCloseClaimTimestamp(now, eventId);
    const event = {
      type: "session.consolidation.requested" as const,
      eventId,
      projectId: this.principal.projectId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey
    };
    let results: D1Result[];
    try {
      results = await this.env.MEMORY_DB.batch([
        this.projectMutationGuard(),
        this.env.MEMORY_DB.prepare(
          `INSERT INTO idempotency_records
           (project_id, principal_id, operation, idempotency_key, request_digest,
            response_json, created_at)
           SELECT ?, ?, 'session_close', ?, ?, ?, ?
           FROM sessions session
           WHERE session.project_id = ? AND session.principal_id = ?
             AND session.session_id = ?
             AND ${sessionWriterAuthorizationPredicate("session")}
           ON CONFLICT(project_id, principal_id, operation, idempotency_key) DO NOTHING`
        ).bind(
          this.principal.projectId,
          this.principal.principalId,
          input.idempotencyKey,
          payloadDigest,
          responseJson,
          now,
          this.principal.projectId,
          this.principal.principalId,
          input.sessionId
        ),
        this.env.MEMORY_DB.prepare(
          `UPDATE sessions
           SET session_version = ?, status = 'closed', summary = ?, closed_at = ?
           WHERE project_id = ? AND principal_id = ? AND session_id = ?
             AND session_version = ? AND status = 'open'
             AND EXISTS (
               SELECT 1 FROM idempotency_records
               WHERE project_id = ? AND principal_id = ? AND operation = 'session_close'
                 AND idempotency_key = ? AND request_digest = ? AND response_json = ?
             )`
        ).bind(
          input.expectedSessionVersion + 1,
          input.summary ?? null,
          closedAt,
          this.principal.projectId,
          this.principal.principalId,
          input.sessionId,
          input.expectedSessionVersion,
          this.principal.projectId,
          this.principal.principalId,
          input.idempotencyKey,
          payloadDigest,
          responseJson
        ),
        this.env.MEMORY_DB.prepare(
          `INSERT INTO session_consolidations
           (consolidation_id, project_id, session_id, session_version, status,
            input_digest, created_at, updated_at)
           SELECT ?, session.project_id, session.session_id, session.session_version,
                  'queued', ?, ?, ?
           FROM sessions session
           WHERE session.project_id = ? AND session.principal_id = ?
             AND session.session_id = ? AND session.session_version = ?
             AND session.status = 'closed' AND session.closed_at = ?
             AND EXISTS (
               SELECT 1 FROM idempotency_records
               WHERE project_id = ? AND principal_id = ? AND operation = 'session_close'
                 AND idempotency_key = ? AND request_digest = ? AND response_json = ?
             )
           UNION ALL
           SELECT ?, ?, ?, 1, 'queued', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM idempotency_records
             WHERE project_id = ? AND principal_id = ? AND operation = 'session_close'
               AND idempotency_key = ? AND request_digest = ? AND response_json = ?
           ) AND NOT EXISTS (
             SELECT 1 FROM sessions session
             WHERE session.project_id = ? AND session.principal_id = ?
               AND session.session_id = ? AND session.session_version = ?
               AND session.status = 'closed' AND session.closed_at = ?
           )`
        ).bind(
          eventId,
          payloadDigest,
          now,
          now,
          this.principal.projectId,
          this.principal.principalId,
          input.sessionId,
          input.expectedSessionVersion + 1,
          closedAt,
          this.principal.projectId,
          this.principal.principalId,
          input.idempotencyKey,
          payloadDigest,
          responseJson,
          eventId,
          this.principal.projectId,
          input.sessionId,
          payloadDigest,
          now,
          now,
          this.principal.projectId,
          this.principal.principalId,
          input.idempotencyKey,
          payloadDigest,
          responseJson,
          this.principal.projectId,
          this.principal.principalId,
          input.sessionId,
          input.expectedSessionVersion + 1,
          closedAt
        ),
        this.env.MEMORY_DB.prepare(
          `INSERT INTO consolidation_inputs
           (project_id, consolidation_id, input_order, input_kind, source_id,
            content, content_sha256)
           SELECT consolidation.project_id, consolidation.consolidation_id, 0,
                  'summary', session.session_id, ?, ?
           FROM session_consolidations consolidation
           JOIN sessions session
             ON session.project_id = consolidation.project_id
            AND session.session_id = consolidation.session_id
            AND session.session_version = consolidation.session_version
           WHERE consolidation.project_id = ? AND consolidation.consolidation_id = ?
             AND session.principal_id = ? AND session.status = 'closed'
             AND ? = 1 AND ? IS NOT NULL AND trim(?) != ''`
        ).bind(
          input.summary ?? null,
          input.summary === undefined ? null : await sha256(input.summary),
          this.principal.projectId,
          eventId,
          this.principal.principalId,
          input.triggerConsolidation ? 1 : 0,
          input.summary ?? null,
          input.summary ?? null
        ),
        this.env.MEMORY_DB.prepare(
          `INSERT INTO consolidation_inputs
           (project_id, consolidation_id, input_order, input_kind, source_id,
            content, content_sha256)
           SELECT consolidation.project_id, consolidation.consolidation_id,
                  row_number() OVER (
                    ORDER BY observation.created_at ASC, observation.observation_id ASC
                  ),
                  'candidate', observation.observation_id, observation.content,
                  observation.content_sha256
           FROM session_consolidations consolidation
           JOIN sessions session
             ON session.project_id = consolidation.project_id
            AND session.session_id = consolidation.session_id
            AND session.session_version = consolidation.session_version
           JOIN observations observation
             ON observation.project_id = session.project_id
            AND observation.session_id = session.session_id
           WHERE consolidation.project_id = ? AND consolidation.consolidation_id = ?
             AND session.principal_id = ? AND session.status = 'closed'
             AND observation.content IS NOT NULL
             AND observation.content_sha256 IS NOT NULL
             AND observation.status IN ('queued', 'pending_review', 'request_changes')
             AND ? = 1`
        ).bind(
          this.principal.projectId,
          eventId,
          this.principal.principalId,
          input.triggerConsolidation ? 1 : 0
        ),
        this.env.MEMORY_DB.prepare(
          `INSERT INTO outbox_events
           (event_id, project_id, project_version, event_type, payload_digest,
            payload_json, created_at)
           SELECT ?, project.project_id, project.project_version,
                  'session.consolidation.requested', ?, ?, ?
           FROM session_consolidations consolidation
           JOIN sessions session
             ON session.project_id = consolidation.project_id
            AND session.session_id = consolidation.session_id
            AND session.session_version = consolidation.session_version
           JOIN projects project ON project.project_id = consolidation.project_id
           WHERE consolidation.project_id = ? AND consolidation.consolidation_id = ?
             AND session.principal_id = ? AND session.status = 'closed' AND ? = 1`
        ).bind(
          eventId,
          payloadDigest,
          JSON.stringify(event),
          now,
          this.principal.projectId,
          eventId,
          this.principal.principalId,
          input.triggerConsolidation ? 1 : 0
        ),
        this.env.MEMORY_DB.prepare(
          `DELETE FROM session_consolidations
           WHERE project_id = ? AND consolidation_id = ? AND ? = 0`
        ).bind(
          this.principal.projectId,
          eventId,
          input.triggerConsolidation ? 1 : 0
        )
      ]);
    } catch (error) {
      const mutationError = await this.translateGatewayMutationError(error);
      if (
        mutationError instanceof EdgeMnemeError &&
        mutationError.code === "PROJECT_UNAVAILABLE"
      ) {
        throw mutationError;
      }
      if (
        mutationError instanceof Error &&
        (mutationError.message.includes("stale session head") ||
          mutationError.message.includes("session_version >= 2"))
      ) {
        throw new EdgeMnemeError("VERSION_CONFLICT", "The session version is stale.");
      }
      await this.requireContextRole(session.repositoryId, "writer");
      throw mutationError;
    }
    assertMutationGuardResult(results[0]);
    const authoritative = await this.readAuthoritativeIdempotency(
      "session_close",
      input.idempotencyKey
    );
    if (authoritative === null) {
      await this.requireContextRole(session.repositoryId, "writer");
      throw new EdgeMnemeError("VERSION_CONFLICT", "The session version is stale.");
    }
    if (authoritative.request_digest !== payloadDigest) {
      throw new EdgeMnemeError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used with a different payload."
      );
    }
    return parseSessionCloseResponse(authoritative.response_json);
  }

  async getWorkflow(projectRef: string, workflowId: string): Promise<Record<string, unknown>> {
    await this.assertProjectRef(projectRef);
    await requireProjectRole(this.env.MEMORY_DB, this.principal, "reader");
    const row = await this.env.MEMORY_DB.prepare(
      `SELECT workflow_id, root_workflow_id, status, attempt, last_error_code,
              created_at, updated_at
       FROM workflow_runs
       WHERE project_id = ? AND (workflow_id = ? OR root_workflow_id = ?)
       ORDER BY updated_at DESC, workflow_id DESC LIMIT 1`
    )
      .bind(this.principal.projectId, workflowId, workflowId)
      .first<Record<string, unknown>>();
    if (row === null) {
      throw new EdgeMnemeError("RESOURCE_UNAVAILABLE", "The workflow is unavailable.");
    }
    return row;
  }

  async readResource(uri: URL, values: Record<string, string>): Promise<string> {
    const projectRef = values.project_ref;
    if (projectRef !== undefined) {
      await this.assertProjectRef(projectRef);
    }
    return readGatewayResource(this.env, this.principal, uri, values);
  }

  private async assertProjectRef(projectRef: string): Promise<void> {
    const row = await this.env.MEMORY_DB.prepare(
      "SELECT 1 AS allowed FROM projects WHERE project_id = ? AND project_ref = ?"
    )
      .bind(this.principal.projectId, projectRef)
      .first();
    if (row === null) {
      throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
    }
  }

  private async readOwnedSession(sessionId: string): Promise<SessionRepositoryContext> {
    const row = await this.env.MEMORY_DB.withSession("first-primary")
      .prepare(
        `SELECT repository_id, repository_ref, worktree_id, status
         FROM sessions
         WHERE project_id = ? AND principal_id = ? AND session_id = ?`
      )
      .bind(this.principal.projectId, this.principal.principalId, sessionId)
      .first<{
        repository_id: string | null;
        repository_ref: string | null;
        worktree_id: string | null;
        status: "open" | "closed" | "expired";
      }>();
    if (row === null) {
      throw new EdgeMnemeError("VALIDATION_FAILED", "The session is unavailable.");
    }
    return {
      repositoryId: row.repository_id,
      repositoryRef: row.repository_ref,
      worktreeId: row.worktree_id,
      status: row.status
    };
  }

  private async requireContextRole(
    repositoryId: string | null,
    role: "reader" | "writer"
  ): Promise<void> {
    if (repositoryId === null) {
      await requireProjectRole(this.env.MEMORY_DB, this.principal, role);
      return;
    }
    await requireRepositoryRole(
      this.env.MEMORY_DB,
      this.principal,
      role,
      repositoryId
    );
  }

  private async resolveSearchRepositoryAccess(
    sessionId: string | undefined
  ): Promise<string[] | undefined> {
    const grantRows = await this.env.MEMORY_DB.withSession("first-primary")
      .prepare(
        `SELECT grant_record.scope_kind, grant_record.scope_id,
                grant_context.repository_id
         FROM project_grants grant_record
         LEFT JOIN project_grant_repository_contexts grant_context
           ON grant_context.project_id = grant_record.project_id
          AND grant_context.grant_id = grant_record.grant_id
         WHERE grant_record.project_id = ? AND grant_record.principal_id = ?
           AND grant_record.revoked_at IS NULL`
      )
      .bind(this.principal.projectId, this.principal.principalId)
      .all<{
        scope_kind: string;
        scope_id: string;
        repository_id: string | null;
      }>();
    let projectWide = false;
    const repositories = new Set<string>();
    for (const row of grantRows.results) {
      if (row.scope_kind === "project" && row.scope_id === this.principal.projectId) {
        projectWide = true;
      } else if (row.repository_id !== null) {
        repositories.add(row.repository_id);
      }
    }
    if (!projectWide && repositories.size === 0) {
      throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
    }
    if (sessionId === undefined) {
      return projectWide ? undefined : [...repositories].sort();
    }
    const session = await this.readOwnedSession(sessionId);
    if (session.repositoryId === null) {
      return [];
    }
    return projectWide || repositories.has(session.repositoryId)
      ? [session.repositoryId]
      : [];
  }

  private async projectVersion(): Promise<number> {
    const row = await this.env.MEMORY_DB.withSession("first-primary")
      .prepare("SELECT project_version FROM projects WHERE project_id = ?")
      .bind(this.principal.projectId)
      .first<{ project_version: number }>();
    if (row === null) {
      throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
    }
    return row.project_version;
  }

  private projectMutationGuard(): D1PreparedStatement {
    return this.env.MEMORY_DB.prepare(
      "UPDATE projects SET updated_at = updated_at WHERE project_id = ?"
    ).bind(this.principal.projectId);
  }

  private async assertProjectMutationAdmitted(): Promise<void> {
    try {
      const results = await this.env.MEMORY_DB.batch([this.projectMutationGuard()]);
      assertMutationGuardResult(results[0]);
    } catch (error) {
      throw await this.translateGatewayMutationError(error);
    }
  }

  private async translateGatewayMutationError(error: unknown): Promise<unknown> {
    const isFenceError =
      error instanceof Error &&
      error.message.includes("synthetic cleanup is fenced");
    try {
      const projectState = await this.env.MEMORY_DB.withSession("first-primary")
        .prepare(
          `SELECT project.project_id, cleanup.cleanup_fenced_at
           FROM projects project
           LEFT JOIN synthetic_cleanup_registry cleanup
             ON cleanup.project_id = project.project_id
           WHERE project.project_id = ?`
        )
        .bind(this.principal.projectId)
        .first<{ project_id: string; cleanup_fenced_at: string | null }>();
      if (projectState === null || projectState.cleanup_fenced_at !== null) {
        return new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
      }
    } catch {
      return isFenceError
        ? new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.")
        : error;
    }
    return isFenceError
      ? new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.")
      : error;
  }

  private async readIdempotency(
    operation: string,
    key: string
  ): Promise<{ request_digest: string; response_json: string } | null> {
    return this.env.MEMORY_DB.prepare(
      `SELECT request_digest, response_json FROM idempotency_records
       WHERE project_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?`
    )
      .bind(this.principal.projectId, this.principal.principalId, operation, key)
      .first<{ request_digest: string; response_json: string }>();
  }

  private async readAuthoritativeIdempotency(
    operation: string,
    key: string
  ): Promise<{ request_digest: string; response_json: string } | null> {
    return this.env.MEMORY_DB.withSession("first-primary")
      .prepare(
        `SELECT request_digest, response_json FROM idempotency_records
         WHERE project_id = ? AND principal_id = ? AND operation = ? AND idempotency_key = ?`
      )
      .bind(this.principal.projectId, this.principal.principalId, operation, key)
      .first<{ request_digest: string; response_json: string }>();
  }
}

function assertMutationGuardResult(result: D1Result | undefined): void {
  if ((result?.meta.changes ?? 0) !== 1) {
    throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
  }
}

function sessionCloseClaimTimestamp(recordedAt: string, eventId: string): string {
  const eventSequence = BigInt(`0x${eventId.replaceAll("-", "")}`).toString();
  return `${recordedAt.slice(0, -1)}${eventSequence}Z`;
}

function parseSessionCloseResponse(responseJson: string): Record<string, unknown> {
  const response = JSON.parse(responseJson) as Record<string, unknown>;
  delete response._claim_event_id;
  return response;
}

function assertSafe(value: unknown, maxBytes: number): void {
  const inspection = inspectPersistedValue(value, { maxBytes });
  if (!inspection.accepted) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "The submitted data cannot be persisted safely."
    );
  }
}

function assertSafeMemoryModelValue(value: unknown, maxBytes: number): void {
  const inspection = inspectMemoryModelValue(value, { maxBytes });
  if (!inspection.accepted) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "The submitted data cannot be persisted safely."
    );
  }
}

function parseTaxonomy<const T extends string>(
  value: string,
  allowed: readonly T[],
  label: string
): T {
  if (!allowed.includes(value as T)) {
    throw new EdgeMnemeError("VALIDATION_FAILED", `Unsupported ${label}.`);
  }
  return value as T;
}

function normalizeWorktreeContext(
  worktreeMeta: Record<string, unknown> | undefined
): NormalizedWorktreeContext {
  if (worktreeMeta === undefined) {
    return { repositoryId: null, repositoryRef: null, worktreeId: null };
  }
  const repositoryId = optionalContextString(
    worktreeMeta.repository_id,
    "repository_id"
  );
  const repositoryRef = optionalContextString(
    worktreeMeta.repository_ref,
    "repository_ref"
  );
  const refAlias = optionalContextString(worktreeMeta.ref, "ref");
  const worktreeId = optionalContextString(worktreeMeta.worktree_id, "worktree_id");
  if (
    repositoryRef !== null &&
    refAlias !== null &&
    repositoryRef !== refAlias
  ) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "repository_ref and ref must identify the same repository ref."
    );
  }
  if (repositoryId === null && (repositoryRef !== null || refAlias !== null || worktreeId !== null)) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "Repository ref and worktree metadata require repository_id."
    );
  }
  return {
    repositoryId,
    repositoryRef: repositoryRef ?? refAlias,
    worktreeId
  };
}

function optionalContextString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      `${name} must be a non-empty normalized string.`
    );
  }
  return value;
}

function persistedWorktreeMetadata(
  context: NormalizedWorktreeContext
): Record<string, string> | null {
  if (
    context.repositoryId === null &&
    context.repositoryRef === null &&
    context.worktreeId === null
  ) {
    return null;
  }
  return {
    ...(context.repositoryId === null ? {} : { repository_id: context.repositoryId }),
    ...(context.repositoryRef === null ? {} : { repository_ref: context.repositoryRef }),
    ...(context.worktreeId === null ? {} : { worktree_id: context.worktreeId })
  };
}

function namespaceEvidenceLocator(locator: string, repositoryId: string | null): string {
  return repositoryId === null
    ? locator
    : `repository:${encodeURIComponent(repositoryId)}:${locator}`;
}

function normalizeCandidateEvidence(
  evidence: CandidateEvidenceInput[]
): CandidateEvidenceInput[] {
  return evidence.map((item) => ({
    source_type: item.source_type,
    locator: item.locator,
    ...(item.commit_sha === undefined ? {} : { commit_sha: item.commit_sha }),
    ...(item.excerpt_hash === undefined ? {} : { excerpt_hash: item.excerpt_hash })
  }));
}

function assertAgentEvidenceSources(evidence: unknown): void {
  if (
    Array.isArray(evidence) &&
    evidence.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { source_type?: unknown }).source_type === "github_blob"
    )
  ) {
    throw new EdgeMnemeError(
      "VALIDATION_FAILED",
      "GitHub evidence can only be created by the repository synchronizer."
    );
  }
}

function sessionWriterAuthorizationPredicate(sessionAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(sessionAlias)) {
    throw new TypeError("SQL aliases must be simple identifiers.");
  }
  return `EXISTS (
    SELECT 1
    FROM project_grants session_grant
    LEFT JOIN project_grant_repository_contexts session_grant_context
      ON session_grant_context.project_id = session_grant.project_id
     AND session_grant_context.grant_id = session_grant.grant_id
    WHERE session_grant.project_id = ${sessionAlias}.project_id
      AND session_grant.principal_id = ${sessionAlias}.principal_id
      AND session_grant.revoked_at IS NULL
      AND session_grant.role IN ('writer', 'maintainer')
      AND (
        (
          session_grant.scope_kind = 'project'
          AND session_grant.scope_id = session_grant.project_id
        )
        OR (
          ${sessionAlias}.repository_id IS NOT NULL
          AND session_grant_context.repository_id = ${sessionAlias}.repository_id
        )
      )
  )`;
}
