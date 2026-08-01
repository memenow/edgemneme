import { describe, expect, it } from "vitest";
import {
  buildConsolidationScopeEvidence,
  candidateScopeEvidence,
  loadConsolidationSourceRows,
  loadRegisteredRepositoryIds,
  modelEvidenceSources,
  type CandidateEvidenceRow
} from "../src/workflows/quality-provenance";

describe("quality workflow provenance", () => {
  it("accepts only complete trusted candidate evidence and deduplicates IDs", () => {
    const rows: CandidateEvidenceRow[] = [
      candidateRow({ evidence_id: null }),
      candidateRow({ evidence_id: "missing-source", source_type: null }),
      candidateRow({
        evidence_id: "incomplete-project",
        repository_id: null,
        repository_ref: "refs/heads/main"
      }),
      candidateRow({
        evidence_id: "incomplete-repository",
        repository_id: "repository-a",
        repository_authority: null
      }),
      candidateRow({
        evidence_id: "unknown-authority",
        repository_id: "repository-a",
        repository_authority: "invented"
      }),
      candidateRow({ evidence_id: "project-evidence" }),
      candidateRow({
        evidence_id: "repository-evidence",
        repository_id: "repository-a",
        repository_ref: "refs/heads/main",
        repository_authority: "default_branch"
      }),
      candidateRow({
        evidence_id: "repository-evidence",
        repository_id: "repository-a",
        repository_ref: "refs/heads/main",
        repository_authority: "default_branch"
      })
    ];

    expect(candidateScopeEvidence(rows)).toEqual([
      {
        evidenceId: "project-evidence",
        repositoryId: null,
        sourceType: "repository_file",
        ref: null,
        authority: "ordinary"
      },
      {
        evidenceId: "repository-evidence",
        repositoryId: "repository-a",
        sourceType: "repository_file",
        ref: "refs/heads/main",
        authority: "ordinary"
      }
    ]);
    expect(modelEvidenceSources(rows)).toEqual([
      {
        evidence_source_id: "project-evidence",
        source_type: "repository_file",
        repository_authority: null,
        has_repository_context: false
      },
      {
        evidence_source_id: "repository-evidence",
        source_type: "repository_file",
        repository_authority: "default_branch",
        has_repository_context: true
      }
    ]);
  });

  it("derives repository scope evidence from summaries, evidence, or session fallback", () => {
    const inputs = [
      { input_kind: "summary" as const, source_id: "summary" },
      { input_kind: "candidate" as const, source_id: "candidate-evidence" },
      { input_kind: "candidate" as const, source_id: "candidate-session" },
      { input_kind: "candidate" as const, source_id: "candidate-conflict" },
      { input_kind: "candidate" as const, source_id: "candidate-missing" }
    ];
    const rows = [
      sourceRow({
        source_id: "candidate-evidence",
        evidence_id: "evidence-a",
        evidence_repository_id: "repository-a",
        evidence_repository_ref: "refs/heads/main",
        evidence_repository_authority: "tracked_ref",
        evidence_source_type: "github_blob"
      }),
      sourceRow({
        source_id: "candidate-session",
        session_repository_id: "repository-a",
        session_repository_ref: "refs/heads/feature"
      }),
      sourceRow({
        source_id: "candidate-conflict",
        evidence_id: "evidence-a",
        evidence_repository_id: "repository-a",
        evidence_repository_authority: "agent_supplied"
      }),
      sourceRow({
        source_id: "candidate-conflict",
        evidence_id: "evidence-b",
        evidence_repository_id: "repository-b",
        evidence_repository_authority: "agent_supplied"
      })
    ];

    expect(
      buildConsolidationScopeEvidence(inputs, rows, {
        principal_id: "principal-1",
        repository_id: "repository-a",
        repository_ref: "refs/heads/main"
      })
    ).toEqual([
      {
        evidenceId: "summary",
        repositoryId: "repository-a",
        sourceType: "session_summary",
        ref: "refs/heads/main",
        authority: "ordinary"
      },
      {
        evidenceId: "candidate-evidence",
        repositoryId: "repository-a",
        sourceType: "github_blob",
        ref: "refs/heads/main",
        authority: "ordinary"
      },
      {
        evidenceId: "candidate-session",
        repositoryId: "repository-a",
        sourceType: "candidate",
        ref: "refs/heads/feature",
        authority: "ordinary"
      }
    ]);
    expect(
      buildConsolidationScopeEvidence(
        [{ input_kind: "summary", source_id: "summary" }],
        [],
        { principal_id: "principal-1", repository_id: null, repository_ref: null }
      )
    ).toEqual([]);
  });

  it("loads registered repositories and frozen source provenance with bound IDs", async () => {
    const records: Array<{ sql: string; bindings: unknown[] }> = [];
    const database = {
      prepare(sql: string) {
        const record = { sql, bindings: [] as unknown[] };
        records.push(record);
        return {
          bind(...bindings: unknown[]) {
            record.bindings = bindings;
            return this;
          },
          async all<T>() {
            return {
              results: (sql.includes("FROM repositories")
                ? [{ repository_id: "repository-a" }]
                : [sourceRow({ source_id: "candidate-1" })]) as T[]
            };
          }
        };
      }
    } as unknown as D1Database;

    await expect(loadRegisteredRepositoryIds(database, "project-1")).resolves.toEqual([
      "repository-a"
    ]);
    await expect(
      loadConsolidationSourceRows(
        database,
        "project-1",
        "consolidation-1",
        "session-1",
        50,
        99
      )
    ).resolves.toEqual([sourceRow({ source_id: "candidate-1" })]);
    expect(records[0]?.bindings).toEqual(["project-1"]);
    expect(records[1]?.sql).toContain(
      "frozen_input.input_order BETWEEN ? AND ?"
    );
    expect(records[1]?.bindings).toEqual([
      "project-1",
      "consolidation-1",
      50,
      99,
      "session-1"
    ]);
  });
});

function candidateRow(
  overrides: Partial<CandidateEvidenceRow>
): CandidateEvidenceRow {
  return {
    content: "Synthetic candidate.",
    session_id: "session-1",
    evidence_id: "evidence-1",
    repository_id: null,
    repository_ref: null,
    repository_authority: null,
    source_type: "repository_file",
    ...overrides
  };
}

function sourceRow(overrides: Record<string, string | null>) {
  return {
    source_id: "candidate-1",
    evidence_id: null,
    evidence_repository_id: null,
    evidence_repository_ref: null,
    evidence_repository_authority: null,
    evidence_source_type: null,
    session_repository_id: null,
    session_repository_ref: null,
    ...overrides
  };
}
