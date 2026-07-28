import { describe, expect, it } from "vitest";
import { detectExactReferences } from "../src/search/exact";
import { normalizeLexicalQuery } from "../src/search/lexical";
import { passesHardFilters, planHardFilters } from "../src/search/planning";
import { asIndexGeneration } from "../src/search/ranking";
import type { ValidatedSearchCandidate } from "../src/search/types";

describe("search planning", () => {
  it("defaults to current active facts and preserves explicit scope and time filters", () => {
    expect(
      planHardFilters({
        projectId: "project-1",
        statuses: undefined,
        authorizedRepositoryIds: ["repo-2", "repo-1", "repo-2"],
        scope: { type: "repository", ids: ["repo-2", "repo-1", "repo-2"] },
        validAt: "2026-07-25T12:00:00.000Z",
        indexGeneration: "generation-blue"
      })
    ).toEqual({
      projectId: "project-1",
      statuses: ["active"],
      authorizedRepositoryIds: ["repo-1", "repo-2"],
      scope: { type: "repository", ids: ["repo-1", "repo-2"] },
      validAt: "2026-07-25T12:00:00.000Z",
      currentHeadsOnly: true,
      excludeExpired: true,
      indexGeneration: "generation-blue"
    });
  });

  it("rejects invalid projects, dates, statuses, and scope identifiers", () => {
    expect(() => planHardFilters({ projectId: "" })).toThrow("projectId");
    expect(() =>
      planHardFilters({ projectId: "project-1", validAt: "not-a-date" })
    ).toThrow("validAt");
    expect(() =>
      planHardFilters({
        projectId: "project-1",
        statuses: ["active", "unknown" as "active"]
      })
    ).toThrow("status");
    expect(() =>
      planHardFilters({
        projectId: "project-1",
        scope: { type: "ref", ids: [] }
      })
    ).toThrow("scope");
    expect(
      planHardFilters({ projectId: "project-1", authorizedRepositoryIds: [] })
        .authorizedRepositoryIds
    ).toEqual([]);
  });

  it("detects exact memory IDs, paths, SHAs, and symbols without treating prose as exact", () => {
    const references = detectExactReferences(
      "Check memory-018fd, src/search/pipeline.ts, commit deadbeefcafebabe and SearchPipeline.run()."
    );

    expect(references).toEqual([
      { type: "memory_id", value: "memory-018fd" },
      { type: "path", value: "src/search/pipeline.ts" },
      { type: "sha", value: "deadbeefcafebabe" },
      { type: "symbol", value: "SearchPipeline.run" }
    ]);
    expect(detectExactReferences("remember how the search pipeline works")).toEqual([]);
    expect(detectExactReferences("Open src/search/pipeline.ts.")).toEqual([
      { type: "path", value: "src/search/pipeline.ts" }
    ]);
    expect(
      detectExactReferences(
        "memory://projects/demo/memories/memory-2 id:memory-2 Namespace::handler"
      )
    ).toEqual([
      { type: "memory_id", value: "memory-2" },
      { type: "symbol", value: "Namespace::handler" }
    ]);
  });

  it("normalizes Unicode lexical input into an operator-safe FTS expression", () => {
    expect(normalizeLexicalQuery('  Decision OR "D1" 删除 memory_fts*  ')).toEqual({
      normalizedText: 'decision or "d1" 删除 memory_fts*',
      tokens: ["decision", "or", "d1", "删除", "memory_fts"],
      ftsQuery: '"decision" AND "or" AND "d1" AND "删除" AND "memory_fts"'
    });
  });

  it("caps lexical tokens and returns no FTS expression for punctuation-only input", () => {
    expect(normalizeLexicalQuery(" && || !!! ")).toEqual({
      normalizedText: "&& || !!!",
      tokens: [],
      ftsQuery: null
    });
    const normalized = normalizeLexicalQuery(
      Array.from({ length: 40 }, (_, index) => `term${index}`).join(" ")
    );
    expect(normalized.tokens).toHaveLength(20);
  });

  it("defensively applies project, generation, taxonomy, scope, and validity filters", () => {
    const generation = asIndexGeneration("generation-blue");
    const filters = planHardFilters({
      projectId: "project-1",
      kinds: ["decision"],
      memoryClasses: ["semantic"],
      scope: { type: "repository", ids: ["repo-1"] },
      validAt: "2026-07-25T12:00:00.000Z",
      indexGeneration: generation
    });
    const candidate: ValidatedSearchCandidate = {
      projectId: "project-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      memoryVersion: 1,
      chunkId: "chunk-1",
      content: "Synthetic fixture.",
      contentSha256: "sha",
      kind: "decision",
      memoryClass: "semantic",
      scope: "repository",
      scopeId: "repo-1",
      status: "active",
      validFrom: "2026-07-01T00:00:00.000Z",
      validUntil: "2026-08-01T00:00:00.000Z",
      evidenceIds: ["evidence-1"],
      retrievalScore: 1,
      indexGeneration: generation
    };

    expect(passesHardFilters(candidate, filters)).toBe(true);
    expect(passesHardFilters({ ...candidate, projectId: "project-2" }, filters)).toBe(false);
    expect(
      passesHardFilters({ ...candidate, indexGeneration: asIndexGeneration("stale") }, filters)
    ).toBe(false);
    expect(
      passesHardFilters({ ...candidate, validUntil: "2026-07-25T12:00:00.000Z" }, filters)
    ).toBe(false);
    expect(passesHardFilters({ ...candidate, validFrom: "invalid" }, filters)).toBe(false);
    expect(passesHardFilters({ ...candidate, kind: "fact" }, filters)).toBe(false);
    expect(passesHardFilters({ ...candidate, memoryClass: "episodic" }, filters)).toBe(false);
    expect(passesHardFilters({ ...candidate, scopeId: "repo-2" }, filters)).toBe(false);
  });
});
