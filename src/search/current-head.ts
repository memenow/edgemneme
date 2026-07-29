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

interface AuthorizedSnapshotRow {
  authorized_snapshot_version: number;
}

const D1_MAX_BINDINGS_PER_QUERY = 100;
const CURRENT_HEAD_AUTHORITY_BINDINGS = 3;
const CURRENT_HEAD_PAIR_BINDINGS = 2;

export class D1CurrentHeadValidator implements CurrentHeadValidator {
  constructor(private readonly database: D1Database) {}

  async validate(input: HeadValidationInput): Promise<ValidatedSearchCandidate[]> {
    validateAuthorityInput(input);
    if (input.candidates.length === 0) {
      return [];
    }
    const candidates = uniqueCandidates(input.candidates);
    const requestedPairs = uniquePairs(candidates);
    let hardFilters = authoritativeFilters(input.filters);
    let repositoryCeiling = authoritativeRepositoryCeiling(input.filters);
    if (
      availablePairBindings(hardFilters, repositoryCeiling) <
      CURRENT_HEAD_PAIR_BINDINGS
    ) {
      // Preserve every ACL and hard-filter value while reducing scalar bindings.
      hardFilters = authoritativeFilters(input.filters, true);
      repositoryCeiling = authoritativeRepositoryCeiling(input.filters, true);
    }
    const pairsPerBatch = Math.floor(
      availablePairBindings(hardFilters, repositoryCeiling) /
        CURRENT_HEAD_PAIR_BINDINGS
    );
    if (pairsPerBatch < 1) {
      throw new Error("The current-head filters exceed D1's binding limit.");
    }
    const session = this.database.withSession("first-primary");
    // Keep every pair query and the closing authority fence in one D1 transaction.
    const statements = chunkPairs(requestedPairs, pairsPerBatch).map((pairs) => {
      const pairSql = pairs
        .map(() => "(m.memory_id = ? AND v.revision_id = ?)")
        .join(" OR ");
      const pairBindings = pairs.flatMap((pair) => [pair.memoryId, pair.revisionId]);
      return session
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
        );
    });
    statements.push(
      session
        .prepare(
          `SELECT project.project_version AS authorized_snapshot_version
           FROM projects project
           JOIN project_grants grant_row
             ON grant_row.project_id = project.project_id
            AND grant_row.principal_id = ?
            AND grant_row.revoked_at IS NULL
           JOIN principals principal
             ON principal.principal_id = grant_row.principal_id
            AND principal.revoked_at IS NULL
           WHERE project.project_id = ? AND project.project_version = ?
           LIMIT 1`
        )
        .bind(input.principalId, input.projectId, input.snapshotVersion)
    );
    const results = await session.batch<CurrentHeadRow | AuthorizedSnapshotRow>(
      statements
    );
    const snapshotResult = results.at(-1);
    if (!confirmsAuthorizedSnapshot(snapshotResult?.results, input.snapshotVersion)) {
      return [];
    }
    const candidateResults = results.slice(0, -1);
    const rows = deduplicateAndSortCurrentHeadRows(
      candidateResults.flatMap((result) => result.results as CurrentHeadRow[]),
      candidateResults.length > 1
    );
    return validateCurrentHeads(rows, candidates, input);
  }
}

function availablePairBindings(
  hardFilters: { bindings: readonly unknown[] },
  repositoryCeiling: { bindings: readonly unknown[] }
): number {
  return (
    D1_MAX_BINDINGS_PER_QUERY -
    CURRENT_HEAD_AUTHORITY_BINDINGS -
    hardFilters.bindings.length -
    repositoryCeiling.bindings.length
  );
}

function authoritativeRepositoryCeiling(
  filters: HardFilterPlan,
  compactLists = false
): {
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
  const repositoryIds = compactLists
    ? {
        sql: "SELECT CAST(value AS TEXT) FROM json_each(?)",
        bindings: [JSON.stringify(filters.authorizedRepositoryIds)]
      }
    : {
        sql: filters.authorizedRepositoryIds.map(() => "?").join(", "),
        bindings: [...filters.authorizedRepositoryIds]
      };
  return {
    sql:
      `(${projectMemory} OR EXISTS (` +
      `SELECT 1 FROM memory_repository_contexts AS request_memory_context ` +
      `WHERE request_memory_context.project_id = m.project_id ` +
      `AND request_memory_context.memory_id = m.memory_id ` +
      `AND request_memory_context.repository_id IN (${repositoryIds.sql})))`,
    bindings: repositoryIds.bindings
  };
}

function authoritativeFilters(filters: HardFilterPlan, compactLists = false): {
  sql: string;
  bindings: unknown[];
} {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  appendInFilter(conditions, bindings, "m.status", filters.statuses, compactLists);
  appendInFilter(conditions, bindings, "m.kind", filters.kinds, compactLists);
  appendInFilter(
    conditions,
    bindings,
    "m.memory_class",
    filters.memoryClasses,
    compactLists
  );
  if (filters.scope !== undefined) {
    conditions.push("m.scope = ?");
    bindings.push(filters.scope.type);
    appendInFilter(
      conditions,
      bindings,
      "m.scope_id",
      filters.scope.ids,
      compactLists
    );
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
  values: readonly string[] | undefined,
  compact = false
): void {
  if (values === undefined) {
    return;
  }
  if (values.length === 0) {
    throw new TypeError(`${column} requires at least one filter value.`);
  }
  if (compact) {
    conditions.push(
      `${column} IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
    );
    bindings.push(JSON.stringify(values));
    return;
  }
  conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  bindings.push(...values);
}

function chunkPairs(
  pairs: readonly { memoryId: string; revisionId: string }[],
  size: number
): Array<Array<{ memoryId: string; revisionId: string }>> {
  const chunks: Array<Array<{ memoryId: string; revisionId: string }>> = [];
  for (let index = 0; index < pairs.length; index += size) {
    chunks.push(pairs.slice(index, index + size));
  }
  return chunks;
}

function confirmsAuthorizedSnapshot(
  rows: readonly (CurrentHeadRow | AuthorizedSnapshotRow)[] | undefined,
  expectedVersion: number
): boolean {
  if (rows?.length !== 1) {
    return false;
  }
  const row = rows[0] as Partial<AuthorizedSnapshotRow>;
  return row.authorized_snapshot_version === expectedVersion;
}

function deduplicateAndSortCurrentHeadRows(
  rows: readonly CurrentHeadRow[],
  sortGlobally: boolean
): CurrentHeadRow[] {
  const unique = new Map<string, CurrentHeadRow>();
  for (const row of rows) {
    const key = pairKey(String(row.memory_id), String(row.revision_id));
    if (unique.has(key)) {
      throw new Error("A current-head pair was returned more than once.");
    }
    unique.set(key, row);
  }
  const deduplicated = [...unique.values()];
  return sortGlobally
    ? deduplicated.sort(
        (left, right) =>
          compareIdentifiers(String(left.memory_id), String(right.memory_id)) ||
          compareIdentifiers(String(left.revision_id), String(right.revision_id))
      )
    : deduplicated;
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
