import type { TrustedScopeEvidence } from "../quality/scope-options";

export interface CandidateEvidenceRow {
  content: string;
  session_id: string;
  evidence_id: string | null;
  repository_id: string | null;
  repository_ref: string | null;
  repository_authority: string | null;
  source_type: string | null;
}

interface ConsolidationSourceRow {
  source_id: string;
  evidence_id: string | null;
  evidence_repository_id: string | null;
  evidence_repository_ref: string | null;
  evidence_repository_authority: string | null;
  evidence_source_type: string | null;
  session_repository_id: string | null;
  session_repository_ref: string | null;
}

interface ConsolidationScopeInput {
  input_kind: "summary" | "candidate";
  source_id: string;
}

export interface SessionContextRow {
  principal_id: string;
  repository_id: string | null;
  repository_ref: string | null;
}

const REPOSITORY_EVIDENCE_AUTHORITIES = new Set([
  "default_branch",
  "tracked_ref",
  "agent_supplied"
]);

export async function loadRegisteredRepositoryIds(
  database: D1Database,
  projectId: string
): Promise<string[]> {
  const repositories = await database.prepare(
    `SELECT repository_id FROM repositories
     WHERE project_id = ?
     ORDER BY repository_id ASC`
  )
    .bind(projectId)
    .all<{ repository_id: string }>();
  return repositories.results.map((repository) => repository.repository_id);
}

export function candidateScopeEvidence(
  rows: readonly CandidateEvidenceRow[]
): TrustedScopeEvidence[] {
  const evidence = new Map<string, TrustedScopeEvidence>();
  for (const row of rows) {
    if (
      row.evidence_id === null ||
      row.source_type === null ||
      !hasTrustedEvidenceContext(row)
    ) {
      continue;
    }
    evidence.set(row.evidence_id, {
      evidenceId: row.evidence_id,
      repositoryId: row.repository_id,
      sourceType: row.source_type,
      ref: row.repository_ref,
      authority: "ordinary"
    });
  }
  return [...evidence.values()];
}

export function modelEvidenceSources(rows: readonly CandidateEvidenceRow[]): Array<{
  evidence_source_id: string;
  source_type: string;
  repository_authority: string | null;
  repository_ref: string | null;
  has_repository_context: boolean;
}> {
  const sources = new Map<
    string,
    {
      evidence_source_id: string;
      source_type: string;
      repository_authority: string | null;
      repository_ref: string | null;
      has_repository_context: boolean;
    }
  >();
  for (const row of rows) {
    if (
      row.evidence_id === null ||
      row.source_type === null ||
      !hasTrustedEvidenceContext(row)
    ) {
      continue;
    }
    sources.set(row.evidence_id, {
      evidence_source_id: row.evidence_id,
      source_type: row.source_type,
      repository_authority: row.repository_authority,
      repository_ref: row.repository_ref,
      has_repository_context: row.repository_id !== null
    });
  }
  return [...sources.values()];
}

export async function loadConsolidationSourceRows(
  database: D1Database,
  projectId: string,
  consolidationId: string,
  sessionId: string
): Promise<ConsolidationSourceRow[]> {
  const rows = await database.prepare(
    `SELECT frozen_input.source_id,
            evidence_record.evidence_id,
            evidence_record.repository_id AS evidence_repository_id,
            evidence_record.repository_ref AS evidence_repository_ref,
            evidence_record.repository_authority AS evidence_repository_authority,
            evidence_record.source_type AS evidence_source_type,
            source_session.repository_id AS session_repository_id,
            source_session.repository_ref AS session_repository_ref
     FROM consolidation_inputs AS frozen_input
     LEFT JOIN observations AS source_candidate
       ON frozen_input.input_kind = 'candidate'
      AND source_candidate.project_id = frozen_input.project_id
      AND source_candidate.observation_id = frozen_input.source_id
     LEFT JOIN sessions AS source_session
       ON source_session.project_id = source_candidate.project_id
      AND source_session.session_id = source_candidate.session_id
     LEFT JOIN observation_evidence AS source_link
       ON source_link.project_id = source_candidate.project_id
      AND source_link.observation_id = source_candidate.observation_id
     LEFT JOIN evidence AS evidence_record
       ON evidence_record.project_id = source_link.project_id
      AND evidence_record.evidence_id = source_link.evidence_id
      AND evidence_record.sensitivity_status = 'clear'
     WHERE frozen_input.project_id = ?
       AND frozen_input.consolidation_id = ?
       AND EXISTS (
         SELECT 1 FROM session_consolidations AS consolidation
         WHERE consolidation.project_id = frozen_input.project_id
           AND consolidation.consolidation_id = frozen_input.consolidation_id
           AND consolidation.session_id = ?
       )
     ORDER BY frozen_input.input_order ASC, evidence_record.evidence_id ASC`
  )
    .bind(projectId, consolidationId, sessionId)
    .all<ConsolidationSourceRow>();
  return rows.results;
}

export function buildConsolidationScopeEvidence(
  inputs: readonly ConsolidationScopeInput[],
  sourceRows: readonly ConsolidationSourceRow[],
  session: SessionContextRow
): TrustedScopeEvidence[] {
  return inputs.flatMap((input) => {
    if (input.input_kind === "summary") {
      return session.repository_id === null
        ? []
        : [
            {
              evidenceId: input.source_id,
              repositoryId: session.repository_id,
              sourceType: "session_summary",
              ref: session.repository_ref,
              authority: "ordinary" as const
            }
          ];
    }

    const rows = sourceRows.filter((row) => row.source_id === input.source_id);
    const trustedEvidenceRows = rows.filter((row) =>
      hasTrustedEvidenceContext({
        repository_id: row.evidence_repository_id,
        repository_ref: row.evidence_repository_ref,
        repository_authority: row.evidence_repository_authority
      })
    );
    const evidenceRepositoryIds = uniqueNonNull(
      trustedEvidenceRows.map((row) => row.evidence_repository_id)
    );
    const sessionRepositoryIds = uniqueNonNull(
      rows.map((row) => row.session_repository_id)
    );
    const repositoryIds =
      evidenceRepositoryIds.length > 0 ? evidenceRepositoryIds : sessionRepositoryIds;
    if (repositoryIds.length !== 1) {
      return [];
    }
    const repositoryId = repositoryIds[0];
    if (repositoryId === undefined) {
      return [];
    }
    const evidenceRow = trustedEvidenceRows.find(
      (row) => row.evidence_repository_id === repositoryId
    );
    const sessionRow = rows.find((row) => row.session_repository_id === repositoryId);
    return [
      {
        evidenceId: input.source_id,
        repositoryId,
        sourceType: evidenceRow?.evidence_source_type ?? "candidate",
        ref:
          evidenceRow?.evidence_repository_ref ??
          sessionRow?.session_repository_ref ??
          null,
        authority: "ordinary" as const
      }
    ];
  });
}

function hasTrustedEvidenceContext(
  row: Pick<
    CandidateEvidenceRow,
    "repository_id" | "repository_ref" | "repository_authority"
  >
): boolean {
  return row.repository_id === null
    ? row.repository_ref === null && row.repository_authority === null
    : row.repository_authority !== null &&
        REPOSITORY_EVIDENCE_AUTHORITIES.has(row.repository_authority);
}

function uniqueNonNull(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}
