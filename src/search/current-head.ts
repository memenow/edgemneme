import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES
} from "../contracts/taxonomy";
import { hierarchicalMemoryAccessPredicate } from "../security/auth";
import type {
  CurrentHeadValidator,
  FusedRecallHit,
  HardFilterPlan,
  HeadValidationInput,
  ValidatedSearchCandidate
} from "./types";

interface CurrentHeadRow {
  project_id: string;
  memory_id: string;
  revision_id: string;
  memory_version: number;
  content: string;
  content_sha256: string;
  kind: string;
  memory_class: string;
  scope: string;
  scope_id: string;
  status: string;
  valid_from: string | null;
  valid_until: string | null;
  evidence_ids: string | null;
}

export class D1CurrentHeadValidator implements CurrentHeadValidator {
  constructor(private readonly database: D1Database) {}

  async validate(input: HeadValidationInput): Promise<ValidatedSearchCandidate[]> {
    validateAuthorityInput(input);
    if (input.candidates.length === 0) {
      return [];
    }
    const candidates = uniqueCandidates(input.candidates);
    const requestedPairs = uniquePairs(candidates);
    const pairSql = requestedPairs
      .map(() => "(m.memory_id = ? AND v.revision_id = ?)")
      .join(" OR ");
    const pairBindings = requestedPairs.flatMap((pair) => [pair.memoryId, pair.revisionId]);
    const hardFilters = authoritativeFilters(input.filters);
    const repositoryCeiling = authoritativeRepositoryCeiling(input.filters);
    const session = this.database.withSession("first-primary");
    const result = await session
      .prepare(
        `SELECT m.project_id, m.memory_id, v.revision_id, m.memory_version,
                v.content, v.content_sha256, m.kind, m.memory_class, m.scope, m.scope_id,
                m.status, v.valid_from, v.valid_until,
                group_concat(CASE WHEN e.sensitivity_status = 'clear'
                                  THEN e.evidence_id END) AS evidence_ids
         FROM projects project
         JOIN project_grants grant_row
           ON grant_row.project_id = project.project_id
          AND grant_row.principal_id = ?
          AND grant_row.revoked_at IS NULL
         JOIN principals principal
           ON principal.principal_id = grant_row.principal_id
          AND principal.revoked_at IS NULL
         JOIN memories m ON m.project_id = project.project_id
         JOIN memory_versions v
           ON v.project_id = m.project_id
          AND v.memory_id = m.memory_id
          AND v.revision_id = m.current_revision_id
         LEFT JOIN version_evidence ve
           ON ve.project_id = m.project_id AND ve.revision_id = v.revision_id
         LEFT JOIN evidence e
           ON e.project_id = ve.project_id AND e.evidence_id = ve.evidence_id
         WHERE project.project_id = ? AND project.project_version = ?
           AND ${hierarchicalMemoryAccessPredicate("grant_row", "m")}
           AND ${repositoryCeiling.sql}
           AND ${hardFilters.sql} AND (${pairSql})
         GROUP BY m.project_id, m.memory_id, v.revision_id, m.memory_version,
                  v.content, v.content_sha256, m.kind, m.memory_class, m.scope,
                  m.scope_id, m.status, v.valid_from, v.valid_until
         ORDER BY m.memory_id ASC, v.revision_id ASC`
      )
      .bind(
        input.principalId,
        input.projectId,
        input.snapshotVersion,
        ...repositoryCeiling.bindings,
        ...hardFilters.bindings,
        ...pairBindings
      )
      .all<CurrentHeadRow>();
    return validateCurrentHeads(result.results, candidates, input);
  }
}

function authoritativeRepositoryCeiling(filters: HardFilterPlan): {
  sql: string;
  bindings: unknown[];
} {
  if (filters.authorizedRepositoryIds === undefined) {
    return { sql: "1 = 1", bindings: [] };
  }
  const projectMemory = "(m.scope = 'project' AND m.scope_id = m.project_id)";
  if (filters.authorizedRepositoryIds.length === 0) {
    return { sql: projectMemory, bindings: [] };
  }
  return {
    sql:
      `(${projectMemory} OR EXISTS (` +
      `SELECT 1 FROM memory_repository_contexts AS request_memory_context ` +
      `WHERE request_memory_context.project_id = m.project_id ` +
      `AND request_memory_context.memory_id = m.memory_id ` +
      `AND request_memory_context.repository_id IN (` +
      filters.authorizedRepositoryIds.map(() => "?").join(", ") +
      ")))" ,
    bindings: [...filters.authorizedRepositoryIds]
  };
}

function authoritativeFilters(filters: HardFilterPlan): {
  sql: string;
  bindings: unknown[];
} {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  appendInFilter(conditions, bindings, "m.status", filters.statuses);
  appendInFilter(conditions, bindings, "m.kind", filters.kinds);
  appendInFilter(conditions, bindings, "m.memory_class", filters.memoryClasses);
  if (filters.scope !== undefined) {
    conditions.push("m.scope = ?");
    bindings.push(filters.scope.type);
    appendInFilter(conditions, bindings, "m.scope_id", filters.scope.ids);
  }
  conditions.push("(v.valid_from IS NULL OR julianday(v.valid_from) <= julianday(?))");
  conditions.push("(v.valid_until IS NULL OR julianday(v.valid_until) > julianday(?))");
  bindings.push(filters.validAt, filters.validAt);
  return { sql: conditions.join(" AND "), bindings };
}

function appendInFilter(
  conditions: string[],
  bindings: unknown[],
  column: string,
  values: readonly string[] | undefined
): void {
  if (values === undefined) {
    return;
  }
  if (values.length === 0) {
    throw new TypeError(`${column} requires at least one filter value.`);
  }
  conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  bindings.push(...values);
}

function validateAuthorityInput(input: HeadValidationInput): void {
  requireIdentifier(input.projectId, "project ID");
  requireIdentifier(input.principalId, "principal ID");
  if (!Number.isSafeInteger(input.snapshotVersion) || input.snapshotVersion < 0) {
    throw new TypeError("The snapshot version must be a nonnegative safe integer.");
  }
  if (input.filters.projectId !== input.projectId) {
    throw new Error("The authority filter crossed its project boundary.");
  }
  for (const candidate of input.candidates) {
    if (
      candidate.projectId !== input.projectId ||
      candidate.indexGeneration !== input.filters.indexGeneration
    ) {
      throw new Error("A recall candidate crossed its project or generation boundary.");
    }
    requireIdentifier(candidate.memoryId, "memory ID");
    requireIdentifier(candidate.revisionId, "revision ID");
    requireIdentifier(candidate.chunkId, "chunk ID");
  }
}

function validateCurrentHeads(
  rows: readonly CurrentHeadRow[],
  candidates: readonly FusedRecallHit[],
  input: HeadValidationInput
): ValidatedSearchCandidate[] {
  const candidatesByPair = new Map<string, FusedRecallHit[]>();
  for (const candidate of candidates) {
    const key = pairKey(candidate.memoryId, candidate.revisionId);
    const existing = candidatesByPair.get(key) ?? [];
    existing.push(candidate);
    candidatesByPair.set(key, existing);
  }
  const validated: ValidatedSearchCandidate[] = [];
  for (const row of rows) {
    if (row.project_id !== input.projectId) {
      throw new Error("A current-head row crossed its project boundary.");
    }
    const memoryId = requireIdentifier(row.memory_id, "memory ID");
    const revisionId = requireIdentifier(row.revision_id, "revision ID");
    const matching = candidatesByPair.get(pairKey(memoryId, revisionId));
    if (matching === undefined) {
      throw new Error("A current-head row did not match a recalled revision.");
    }
    const common = validateCurrentHeadRow(row);
    for (const candidate of matching) {
      validated.push({
        ...common,
        projectId: input.projectId,
        memoryId,
        revisionId,
        chunkId: candidate.chunkId,
        retrievalScore: candidate.retrievalScore,
        indexGeneration: input.filters.indexGeneration
      });
    }
  }
  return validated;
}

function validateCurrentHeadRow(
  row: CurrentHeadRow
): Omit<
  ValidatedSearchCandidate,
  | "projectId"
  | "memoryId"
  | "revisionId"
  | "chunkId"
  | "retrievalScore"
  | "indexGeneration"
> {
  if (!Number.isSafeInteger(row.memory_version) || row.memory_version < 1) {
    throw new Error("A current-head row contained an invalid memory version.");
  }
  const kind = requireEnum(row.kind, MEMORY_KINDS, "memory kind");
  const memoryClass = requireEnum(row.memory_class, MEMORY_CLASSES, "memory class");
  const scope = requireEnum(row.scope, MEMORY_SCOPES, "memory scope");
  const status = requireEnum(row.status, MEMORY_STATUSES, "memory status");
  if (!isNullableTimestamp(row.valid_from) || !isNullableTimestamp(row.valid_until)) {
    throw new Error("A current-head row contained an invalid validity timestamp.");
  }
  const evidenceIds = [
    ...new Set(
      (row.evidence_ids ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ].sort();
  return {
    memoryVersion: row.memory_version,
    content: requireIdentifier(row.content, "memory content"),
    contentSha256: requireIdentifier(row.content_sha256, "content checksum"),
    kind,
    memoryClass,
    scope,
    scopeId: requireIdentifier(row.scope_id, "scope ID"),
    status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    evidenceIds
  };
}

function uniqueCandidates(candidates: readonly FusedRecallHit[]): FusedRecallHit[] {
  const unique = new Map<string, FusedRecallHit>();
  for (const candidate of candidates) {
    const key = `${pairKey(candidate.memoryId, candidate.revisionId)}\u0000${candidate.chunkId}`;
    const existing = unique.get(key);
    if (existing === undefined || candidate.retrievalScore > existing.retrievalScore) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

function uniquePairs(candidates: readonly FusedRecallHit[]): Array<{
  memoryId: string;
  revisionId: string;
}> {
  const pairs = new Map<string, { memoryId: string; revisionId: string }>();
  for (const candidate of candidates) {
    pairs.set(pairKey(candidate.memoryId, candidate.revisionId), {
      memoryId: candidate.memoryId,
      revisionId: candidate.revisionId
    });
  }
  return [...pairs.values()];
}

function pairKey(memoryId: string, revisionId: string): string {
  return `${memoryId}\u0000${revisionId}`;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 65_536) {
    throw new TypeError(`The ${label} must be a non-empty string.`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  label: string
): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`A current-head row contained an invalid ${label}.`);
  }
  return value as T;
}

function isNullableTimestamp(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T/iu.test(value) &&
      Number.isFinite(Date.parse(value)))
  );
}
