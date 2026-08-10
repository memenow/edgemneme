import { describe, expect, it } from "vitest";
import {
  buildCandidateScopeOptions,
  resolveModelScopeOption,
  toModelScopeOptions,
  type TrustedScopeEvidence
} from "../src/quality/scope-options";

const PROJECT_ID = "project-1";

function evidence(
  evidenceId: string,
  repositoryId: string | null,
  authority: TrustedScopeEvidence["authority"] = "ordinary"
): TrustedScopeEvidence {
  return {
    evidenceId,
    repositoryId,
    sourceType: repositoryId === null ? "maintainer_statement" : "github_commit",
    ref: repositoryId === null ? null : "refs/heads/main",
    authority
  };
}

describe("evidence-bound model scope options", () => {
  it("offers repository isolation and review-only project generalization for one repository", () => {
    const options = buildCandidateScopeOptions({
      projectId: PROJECT_ID,
      registeredRepositoryIds: ["repository-a", "repository-b"],
      evidence: [evidence("evidence-a", "repository-a")]
    });

    expect(options).toHaveLength(2);
    expect(options.map(({ scope, scopeId, authority, requiresMaintainerReview }) => ({
      scope,
      scopeId,
      authority,
      requiresMaintainerReview
    }))).toEqual([
      {
        scope: "repository",
        scopeId: "repository-a",
        authority: "repository_evidence",
        requiresMaintainerReview: false
      },
      {
        scope: "project",
        scopeId: PROJECT_ID,
        authority: "advisory_generalization",
        requiresMaintainerReview: true
      }
    ]);

    const modelOptions = toModelScopeOptions(options);
    expect(modelOptions).toEqual(
      options.map((option) => ({
        option_id: option.optionId,
        scope: option.scope,
        authority: option.authority,
        requires_maintainer_review: option.requiresMaintainerReview,
        evidence_source_ids: ["evidence-a"],
        selection_guidance: expect.any(String)
      }))
    );
    expect(JSON.stringify(modelOptions)).not.toContain(PROJECT_ID);
    expect(JSON.stringify(modelOptions)).not.toContain("repository-a");

    const projectGeneralization = options.find(
      (option) => option.authority === "advisory_generalization"
    );
    expect(
      resolveModelScopeOption(options, {
        optionId: projectGeneralization?.optionId ?? "missing",
        evidenceIds: ["evidence-a"]
      })
    ).toMatchObject({
      scope: "project",
      scopeId: PROJECT_ID,
      authority: "advisory_generalization",
      requiresMaintainerReview: true
    });
  });

  it("resolves only the evidence subset bound to the selected repository option", () => {
    const options = buildCandidateScopeOptions({
      projectId: PROJECT_ID,
      registeredRepositoryIds: ["repository-a", "repository-b"],
      evidence: [
        evidence("evidence-a", "repository-a"),
        evidence("evidence-b", "repository-b")
      ]
    });
    const repositoryA = options.find(
      (option) => option.scope === "repository" && option.scopeId === "repository-a"
    );
    expect(repositoryA).toBeDefined();

    expect(
      resolveModelScopeOption(options, {
        optionId: repositoryA?.optionId ?? "missing",
        evidenceIds: ["evidence-a"]
      })
    ).toMatchObject({
      scope: "repository",
      scopeId: "repository-a",
      evidenceIds: ["evidence-a"]
    });
    expect(() =>
      resolveModelScopeOption(options, {
        optionId: repositoryA?.optionId ?? "missing",
        evidenceIds: ["evidence-b"]
      })
    ).toThrow("bound to the selected scope option");
  });

  it("binds a multi-repository project option to citations from at least two repositories", () => {
    const options = buildCandidateScopeOptions({
      projectId: PROJECT_ID,
      registeredRepositoryIds: ["repository-a", "repository-b"],
      evidence: [
        evidence("evidence-a", "repository-a"),
        evidence("evidence-b", "repository-b")
      ]
    });
    const shared = options.find(
      (option) => option.scope === "project" && option.authority === "multi_repository_evidence"
    );
    expect(shared).toBeDefined();
    expect(toModelScopeOptions(options).find((option) => option.option_id === shared?.optionId))
      .toMatchObject({ selection_guidance: expect.stringContaining("two repositories") });

    expect(
      resolveModelScopeOption(options, {
        optionId: shared?.optionId ?? "missing",
        evidenceIds: ["evidence-b", "evidence-a"]
      })
    ).toMatchObject({
      scope: "project",
      scopeId: PROJECT_ID,
      authority: "multi_repository_evidence",
      requiresMaintainerReview: true
    });
    expect(() =>
      resolveModelScopeOption(options, {
        optionId: shared?.optionId ?? "missing",
        evidenceIds: ["evidence-a"]
      })
    ).toThrow("at least two registered repositories");
  });

  it.each([
    ["trusted_maintainer_project_decision", "trusted_maintainer_project_decision"],
    ["project_policy", "project_policy"]
  ] as const)("offers a review-only project option for %s authority", (authority, expected) => {
    const options = buildCandidateScopeOptions({
      projectId: PROJECT_ID,
      registeredRepositoryIds: ["repository-a"],
      evidence: [evidence("authority-evidence", null, authority)]
    });

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      scope: "project",
      scopeId: PROJECT_ID,
      evidenceIds: ["authority-evidence"],
      authority: expected,
      requiresMaintainerReview: true
    });
    expect(toModelScopeOptions(options)[0]?.selection_guidance).toContain(
      "project-wide decision or policy"
    );
  });

  it("rejects invented option IDs, empty citations, duplicate citations, and evidence outside the option", () => {
    const options = buildCandidateScopeOptions({
      projectId: PROJECT_ID,
      registeredRepositoryIds: ["repository-a"],
      evidence: [evidence("evidence-a", "repository-a")]
    });

    expect(() =>
      resolveModelScopeOption(options, {
        optionId: "scope-option-invented",
        evidenceIds: ["evidence-a"]
      })
    ).toThrow("offered by the server");
    expect(() =>
      resolveModelScopeOption(options, {
        optionId: options[0]?.optionId ?? "missing",
        evidenceIds: []
      })
    ).toThrow("at least one evidence source");
    expect(() =>
      resolveModelScopeOption(options, {
        optionId: options[0]?.optionId ?? "missing",
        evidenceIds: ["evidence-a", "evidence-a"]
      })
    ).toThrow("must be unique");
  });

  it("fails closed for duplicate evidence IDs and unregistered repository provenance", () => {
    expect(() =>
      buildCandidateScopeOptions({
        projectId: PROJECT_ID,
        registeredRepositoryIds: ["repository-a"],
        evidence: [
          evidence("evidence-a", "repository-a"),
          evidence("evidence-a", "repository-a")
        ]
      })
    ).toThrow("Evidence IDs must be unique");
    expect(() =>
      buildCandidateScopeOptions({
        projectId: PROJECT_ID,
        registeredRepositoryIds: ["repository-a"],
        evidence: [evidence("evidence-b", "repository-b")]
      })
    ).toThrow("registered repository");
  });

  it("fails closed for malformed provenance and excessive model citations", () => {
    expect(() =>
      buildCandidateScopeOptions({
        projectId: PROJECT_ID,
        registeredRepositoryIds: ["repository-a", "repository-a"],
        evidence: []
      })
    ).toThrow("Registered repository IDs must be unique");
    expect(() =>
      buildCandidateScopeOptions({
        projectId: PROJECT_ID,
        registeredRepositoryIds: [],
        evidence: [
          {
            ...evidence("evidence-a", null),
            ref: "refs/heads/main"
          }
        ]
      })
    ).toThrow("identify its registered repository");
    expect(() =>
      buildCandidateScopeOptions({
        projectId: PROJECT_ID,
        registeredRepositoryIds: [],
        evidence: [
          {
            ...evidence("evidence-a", null),
            authority: "invented"
          } as unknown as TrustedScopeEvidence
        ]
      })
    ).toThrow("authority is unsupported");

    const options = buildCandidateScopeOptions({
      projectId: PROJECT_ID,
      registeredRepositoryIds: ["repository-a"],
      evidence: [evidence("evidence-a", "repository-a")]
    });
    expect(() =>
      resolveModelScopeOption(options, {
        optionId: options[0]?.optionId ?? "missing",
        evidenceIds: Array.from({ length: 51 }, (_, index) => `evidence-${index}`)
      })
    ).toThrow("at most 50");
    expect(() =>
      toModelScopeOptions([
        {
          ...options[0],
          optionId: options[0]?.optionId ?? "missing",
          scopeId: "repository-b"
        } as (typeof options)[number]
      ])
    ).toThrow("generated and offered by the server");
  });

  it("snapshots trusted provenance so caller mutation cannot change resolution", () => {
    const evidenceA = evidence("evidence-a", "repository-a");
    const evidenceB = evidence("evidence-b", "repository-b");
    const options = buildCandidateScopeOptions({
      projectId: PROJECT_ID,
      registeredRepositoryIds: ["repository-a", "repository-b"],
      evidence: [evidenceA, evidenceB]
    });
    const shared = options.find((option) => option.authority === "multi_repository_evidence");
    (evidenceB as { repositoryId: string | null }).repositoryId = "repository-a";

    expect(
      resolveModelScopeOption(options, {
        optionId: shared?.optionId ?? "missing",
        evidenceIds: ["evidence-a", "evidence-b"]
      })
    ).toMatchObject({ authority: "multi_repository_evidence" });
  });
});
