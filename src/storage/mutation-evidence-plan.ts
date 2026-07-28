import type { SqlStatement } from "./mutation-plan";

export interface MutationEvidenceRecord {
  evidenceId: string;
  sourceType: string;
  locator: string;
  commitSha: string | null;
  excerptHash: string;
  repositoryId: string | null;
  repositoryRef: string | null;
  repositoryAuthority: "agent_supplied" | null;
}

export interface StoredMutationEvidenceProvenance {
  commit_sha: string | null;
  repository_id: string | null;
  repository_ref: string | null;
  repository_path: string | null;
  repository_authority: string | null;
  sensitivity_status: string;
}

interface MutationEvidencePlanInput {
  projectId: string;
  expectedProjectVersion: number;
  revisionId: string;
  recordedAt: string;
  evidence: readonly MutationEvidenceRecord[];
}

export interface MutationEvidencePlan {
  evidenceStatements: readonly SqlStatement[];
  linkStatements: readonly SqlStatement[];
}

export function sameMutationEvidenceProvenance(
  expected: MutationEvidenceRecord,
  stored: StoredMutationEvidenceProvenance
): boolean {
  return (
    stored.commit_sha === expected.commitSha &&
    stored.repository_id === expected.repositoryId &&
    stored.repository_ref === expected.repositoryRef &&
    stored.repository_path === null &&
    stored.repository_authority === expected.repositoryAuthority &&
    stored.sensitivity_status === "clear"
  );
}

export function buildMutationEvidencePlan(
  input: MutationEvidencePlanInput
): MutationEvidencePlan {
  const evidenceStatements: SqlStatement[] = [];
  const linkStatements: SqlStatement[] = [];

  for (const evidence of input.evidence) {
    evidenceStatements.push({
      sql: `INSERT INTO evidence
            (evidence_id, project_id, source_type, locator, commit_sha, excerpt_hash,
             sensitivity_status, recorded_at, repository_id, repository_ref,
             repository_path, repository_authority)
            SELECT ?, ?, ?, ?, ?, ?, 'clear', ?, ?, ?, NULL, ?
            WHERE EXISTS (
              SELECT 1 FROM projects WHERE project_id = ? AND project_version = ?
            )
            /*
             * Atomic compare-and-abort guard: immutable evidence triggers accept an
             * exact replay and abort the whole transaction if provenance changed after
             * the first-primary preflight.
             */
            ON CONFLICT(project_id, source_type, locator, excerpt_hash) DO UPDATE SET
              commit_sha = excluded.commit_sha,
              repository_id = excluded.repository_id,
              repository_ref = excluded.repository_ref,
              repository_path = excluded.repository_path,
              repository_authority = excluded.repository_authority`,
      bindings: [
        evidence.evidenceId,
        input.projectId,
        evidence.sourceType,
        evidence.locator,
        evidence.commitSha,
        evidence.excerptHash,
        input.recordedAt,
        evidence.repositoryId,
        evidence.repositoryRef,
        evidence.repositoryAuthority,
        input.projectId,
        input.expectedProjectVersion
      ]
    });
    linkStatements.push({
      sql: `INSERT INTO version_evidence (project_id, revision_id, evidence_id)
            SELECT ?, ?, evidence_id
            FROM evidence
            WHERE project_id = ? AND source_type = ? AND locator = ? AND excerpt_hash = ?
              AND commit_sha IS ?
              AND repository_id IS ? AND repository_ref IS ?
              AND repository_path IS NULL AND repository_authority IS ?
              AND EXISTS (
                SELECT 1 FROM projects WHERE project_id = ? AND project_version = ?
              )`,
      bindings: [
        input.projectId,
        input.revisionId,
        input.projectId,
        evidence.sourceType,
        evidence.locator,
        evidence.excerptHash,
        evidence.commitSha,
        evidence.repositoryId,
        evidence.repositoryRef,
        evidence.repositoryAuthority,
        input.projectId,
        input.expectedProjectVersion
      ]
    });
  }

  return { evidenceStatements, linkStatements };
}
