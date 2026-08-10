import type { QualityEvaluationInput } from "../../src/quality/evaluation";

const CHECKSUM_A = "a".repeat(64);
const CHECKSUM_B = "b".repeat(64);

export const SYNTHETIC_BILINGUAL_GOLD_SET: QualityEvaluationInput = {
  candidates: [
    {
      id: "synthetic-en-promote-1",
      language: "en",
      goldPromotable: true,
      goldShouldAbstain: false,
      decision: "promote"
    },
    {
      id: "synthetic-en-promote-2",
      language: "en",
      goldPromotable: true,
      goldShouldAbstain: false,
      decision: "promote"
    },
    {
      id: "synthetic-en-reject",
      language: "en",
      goldPromotable: false,
      goldShouldAbstain: false,
      decision: "reject"
    },
    {
      id: "synthetic-en-abstain",
      language: "en",
      goldPromotable: false,
      goldShouldAbstain: true,
      decision: "abstain"
    },
    {
      id: "synthetic-zh-promote",
      language: "zh",
      goldPromotable: true,
      goldShouldAbstain: false,
      decision: "promote"
    },
    {
      id: "synthetic-zh-false-promotion",
      language: "zh",
      goldPromotable: false,
      goldShouldAbstain: false,
      decision: "promote"
    },
    {
      id: "synthetic-zh-abstain",
      language: "zh",
      goldPromotable: false,
      goldShouldAbstain: true,
      decision: "abstain"
    },
    {
      id: "synthetic-zh-reject",
      language: "zh",
      goldPromotable: false,
      goldShouldAbstain: false,
      decision: "reject"
    }
  ],
  retrieval: [
    {
      queryId: "synthetic-en-query",
      language: "en",
      rankedMemoryIds: ["en-a", "en-b", "en-c", "en-d", "en-e"],
      relevance: {
        "en-a": 3,
        "en-b": 2,
        "en-c": 2,
        "en-d": 1,
        "en-e": 1
      }
    },
    {
      queryId: "synthetic-zh-query",
      language: "zh",
      rankedMemoryIds: ["zh-a", "noise-1", "zh-b", "zh-c", "zh-d", "zh-e"],
      relevance: {
        "zh-a": 3,
        "zh-b": 2,
        "zh-c": 2,
        "zh-d": 1,
        "zh-e": 1
      }
    }
  ],
  artifacts: [
    {
      memoryId: "synthetic-memory-a",
      evidenceIds: ["synthetic-evidence-a"],
      revisionId: "synthetic-revision-a",
      checksum: CHECKSUM_A
    },
    {
      memoryId: "synthetic-memory-b",
      evidenceIds: [],
      revisionId: "",
      checksum: "not-a-sha256"
    },
    {
      memoryId: "synthetic-memory-c",
      evidenceIds: ["synthetic-evidence-c"],
      revisionId: "synthetic-revision-c",
      checksum: CHECKSUM_B
    }
  ],
  defaultResults: [
    {
      resultId: "synthetic-active-result",
      projectMatches: true,
      status: "active",
      stale: false
    },
    {
      resultId: "synthetic-cross-project-result",
      projectMatches: false,
      status: "active",
      stale: false
    },
    {
      resultId: "synthetic-invalidated-result",
      projectMatches: true,
      status: "invalidated",
      stale: false
    },
    {
      resultId: "synthetic-stale-result",
      projectMatches: true,
      status: "active",
      stale: true
    },
    {
      resultId: "synthetic-contested-result",
      projectMatches: true,
      status: "contested",
      stale: false
    }
  ],
  noise10x: {
    baselineCorpusSize: 20,
    noisyCorpusSize: 200,
    retrieval: [
      {
        queryId: "synthetic-en-query",
        language: "en",
        rankedMemoryIds: [
          "en-a",
          "noise-en-1",
          "en-b",
          "en-c",
          "en-d",
          "en-e",
          "noise-en-2"
        ],
        relevance: {
          "en-a": 3,
          "en-b": 2,
          "en-c": 2,
          "en-d": 1,
          "en-e": 1
        }
      },
      {
        queryId: "synthetic-zh-query",
        language: "zh",
        rankedMemoryIds: [
          "zh-a",
          "noise-zh-1",
          "noise-zh-2",
          "zh-b",
          "zh-c",
          "zh-d",
          "zh-e"
        ],
        relevance: {
          "zh-a": 3,
          "zh-b": 2,
          "zh-c": 2,
          "zh-d": 1,
          "zh-e": 1
        }
      }
    ]
  }
};
