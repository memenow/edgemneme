import { describe, expect, it } from "vitest";
import {
  evaluateGoldSet,
  evaluateRemoteCanary,
  normalizedDiscountedCumulativeGainAt,
  precisionAt,
  recallAt
} from "../src/quality/evaluation";
import { SYNTHETIC_BILINGUAL_GOLD_SET } from "./quality/gold-set";

describe("retrieval quality metrics", () => {
  const rankedMemoryIds = ["a", "noise", "b", "c", "missing"];
  const relevance = { a: 3, b: 2, c: 1 };

  it("calculates P@5 with a fixed five-result denominator", () => {
    expect(precisionAt(rankedMemoryIds, relevance, 5)).toBe(0.6);
    expect(precisionAt(["a"], relevance, 5)).toBe(0.2);
  });

  it("calculates Recall@10 against every relevant gold item", () => {
    expect(recallAt(rankedMemoryIds, relevance, 10)).toBe(1);
    expect(recallAt(["a"], relevance, 10)).toBeCloseTo(1 / 3);
  });

  it("calculates graded nDCG@10 using exponential gain", () => {
    expect(
      normalizedDiscountedCumulativeGainAt(rankedMemoryIds, relevance, 10)
    ).toBeCloseTo(0.9508, 4);
  });

  it("returns zero when an input has no measurable denominator", () => {
    expect(precisionAt([], {}, 5)).toBe(0);
    expect(recallAt([], {}, 10)).toBe(0);
    expect(normalizedDiscountedCumulativeGainAt([], {}, 10)).toBe(0);
  });

  it("rejects invalid cutoffs and relevance grades", () => {
    expect(() => precisionAt(["a"], { a: 1 }, 0)).toThrow("positive integer");
    expect(() => precisionAt(["a"], { a: 1 }, 1.5)).toThrow("positive integer");
    expect(() => recallAt(["a"], { a: -1 }, 10)).toThrow("non-negative integer");
    expect(() => recallAt(["a"], { a: 0.5 }, 10)).toThrow("non-negative integer");
  });
});

describe("bilingual synthetic gold-set evaluation", () => {
  it("reports deterministic promotion, abstention, retrieval, and language metrics", () => {
    const report = evaluateGoldSet(SYNTHETIC_BILINGUAL_GOLD_SET);

    expect(report.promotionPrecision).toBe(0.75);
    expect(report.abstentionPrecision).toBe(1);
    expect(report.precisionAt5).toBe(0.9);
    expect(report.recallAt10).toBe(1);
    expect(report.ndcgAt10).toBeGreaterThan(0.9);

    expect(report.byLanguage.en.promotionPrecision).toBe(1);
    expect(report.byLanguage.zh.promotionPrecision).toBe(0.5);
    expect(report.languageGap.promotionPrecision).toBe(0.5);
    expect(report.languageGap.precisionAt5).toBeCloseTo(0.2);
    expect(report.languageGap.maximum).toBe(0.5);
  });

  it("reports evidence, revision, and SHA-256 checksum completeness separately", () => {
    const report = evaluateGoldSet(SYNTHETIC_BILINGUAL_GOLD_SET);

    expect(report.completeness).toEqual({
      evidence: 2 / 3,
      revision: 2 / 3,
      checksum: 2 / 3
    });
  });

  it("counts cross-project, invalidated, stale, and contested default leakage", () => {
    const report = evaluateGoldSet(SYNTHETIC_BILINGUAL_GOLD_SET);

    expect(report.leakage).toEqual({
      count: 4,
      rate: 0.8
    });
  });

  it("measures only downward retrieval degradation after tenfold unrelated noise", () => {
    const report = evaluateGoldSet(SYNTHETIC_BILINGUAL_GOLD_SET);

    expect(report.noise10xDegradation.precisionAt5).toBeCloseTo(0.2);
    expect(report.noise10xDegradation.recallAt10).toBe(0);
    expect(report.noise10xDegradation.ndcgAt10).toBeGreaterThan(0);
    expect(report.noise10xDegradation.maximum).toBeCloseTo(0.2);
  });

  it("is byte-for-byte deterministic for the same input", () => {
    const first = JSON.stringify(evaluateGoldSet(SYNTHETIC_BILINGUAL_GOLD_SET));
    const second = JSON.stringify(evaluateGoldSet(SYNTHETIC_BILINGUAL_GOLD_SET));

    expect(second).toBe(first);
  });

  it("fails closed when the noise corpus is not exactly tenfold", () => {
    const invalid = {
      ...SYNTHETIC_BILINGUAL_GOLD_SET,
      noise10x: {
        ...SYNTHETIC_BILINGUAL_GOLD_SET.noise10x,
        noisyCorpusSize: 180
      }
    };

    expect(() => evaluateGoldSet(invalid)).toThrow("exactly 10");
  });

  it("fails closed when noisy queries cannot be paired with the baseline", () => {
    const invalid = {
      ...SYNTHETIC_BILINGUAL_GOLD_SET,
      noise10x: {
        baselineCorpusSize: 20,
        noisyCorpusSize: 200,
        retrieval: SYNTHETIC_BILINGUAL_GOLD_SET.noise10x.retrieval.slice(1)
      }
    };

    expect(() => evaluateGoldSet(invalid)).toThrow("same query IDs");
  });

  it("fails closed when bilingual judgments are incomplete", () => {
    const missingChineseCandidates = {
      ...SYNTHETIC_BILINGUAL_GOLD_SET,
      candidates: SYNTHETIC_BILINGUAL_GOLD_SET.candidates.filter(
        (candidate) => candidate.language === "en"
      )
    };
    const missingChineseRetrieval = {
      ...SYNTHETIC_BILINGUAL_GOLD_SET,
      retrieval: SYNTHETIC_BILINGUAL_GOLD_SET.retrieval.filter(
        (query) => query.language === "en"
      ),
      noise10x: {
        baselineCorpusSize: 20,
        noisyCorpusSize: 200,
        retrieval: SYNTHETIC_BILINGUAL_GOLD_SET.noise10x.retrieval.filter(
          (query) => query.language === "en"
        )
      }
    };

    expect(() => evaluateGoldSet(missingChineseCandidates)).toThrow(
      "zh candidate judgments"
    );
    expect(() => evaluateGoldSet(missingChineseRetrieval)).toThrow(
      "zh retrieval judgments"
    );
  });

  it("rejects duplicate ranked IDs and changed noise relevance gold", () => {
    const baselineQuery = SYNTHETIC_BILINGUAL_GOLD_SET.retrieval[0]!;
    const duplicateRank = {
      ...SYNTHETIC_BILINGUAL_GOLD_SET,
      retrieval: [
        {
          ...baselineQuery,
          rankedMemoryIds: [
            baselineQuery.rankedMemoryIds[0]!,
            baselineQuery.rankedMemoryIds[0]!
          ]
        },
        SYNTHETIC_BILINGUAL_GOLD_SET.retrieval[1]!
      ]
    };
    const changedGold = {
      ...SYNTHETIC_BILINGUAL_GOLD_SET,
      noise10x: {
        baselineCorpusSize: 20,
        noisyCorpusSize: 200,
        retrieval: [
          {
            ...SYNTHETIC_BILINGUAL_GOLD_SET.noise10x.retrieval[0]!,
            relevance: { ...baselineQuery.relevance, "en-a": 2 }
          },
          SYNTHETIC_BILINGUAL_GOLD_SET.noise10x.retrieval[1]!
        ]
      }
    };

    expect(() => evaluateGoldSet(duplicateRank)).toThrow("must be unique");
    expect(() => evaluateGoldSet(changedGold)).toThrow(
      "share language and relevance gold"
    );
  });

  it("exposes a narrow asynchronous seam for the remote synthetic canary", async () => {
    const report = await evaluateRemoteCanary({
      async loadSyntheticEvaluationInput() {
        return SYNTHETIC_BILINGUAL_GOLD_SET;
      }
    });

    expect(report).toEqual(evaluateGoldSet(SYNTHETIC_BILINGUAL_GOLD_SET));
  });
});
