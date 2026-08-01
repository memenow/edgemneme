import { describe, expect, it } from "vitest";
import {
  CANDIDATE_ANALYSIS_MAX_UTF8_BYTES,
  CONSOLIDATION_SUGGESTIONS_MAX_UTF8_BYTES,
  MODEL_RESPONSE_TRANSPORT_MAX_BYTES,
  extractVerbatimIsoOffsetTimestamps,
  hasVerbatimTemporalEvidence,
  parseModelCandidateAnalysis,
  parseModelConsolidationSuggestions,
  readModelFunctionArguments,
  readModelJson
} from "../src/quality/model-analysis";

describe("model analysis validation", () => {
  it("extracts a bounded, sorted set of verbatim ISO timestamps with offsets", () => {
    const timestamps = Array.from(
      { length: 40 },
      (_, index) => `2026-07-28T12:00:${String(index).padStart(2, "0")}Z`
    );
    const extracted = extractVerbatimIsoOffsetTimestamps([
      `Later 2027-01-01T00:00:00+05:30; earlier ${timestamps[0]}.`,
      `Duplicate ${timestamps[0]}; invalid 2026-99-99T25:61:61Z; no offset 2026-07-28T12:00:00.`
    ]);

    expect(extracted).toEqual([
      "2026-07-28T12:00:00Z",
      "2027-01-01T00:00:00+05:30"
    ]);
    expect(extracted).not.toContain("2026-99-99T25:61:61Z");
    expect(extracted).not.toContain("2026-07-28T12:00:00");
    expect(extractVerbatimIsoOffsetTimestamps([timestamps.join(" ")])).toEqual(
      timestamps.slice(0, 32)
    );
  });

  it("requires model-proposed validity timestamps to appear verbatim in evidence", () => {
    expect(
      hasVerbatimTemporalEvidence(
        { valid_from: "2026-07-25T00:00:00Z", valid_until: null },
        ["Effective at 2026-07-25T00:00:00Z for all repositories."],
        ["2026-07-25T00:00:00Z"]
      )
    ).toBe(true);
    expect(
      hasVerbatimTemporalEvidence(
        { valid_from: "2026-07-25T00:00:00Z", valid_until: null },
        ["No effective timestamp was supplied."],
        ["2026-07-25T00:00:00Z"]
      )
    ).toBe(false);
    expect(
      hasVerbatimTemporalEvidence(
        { valid_from: null, valid_until: null },
        ["No effective timestamp was supplied."],
        []
      )
    ).toBe(true);
  });

  it("requires timestamps to be standalone values in the current tool whitelist", () => {
    const timestamp = "2026-07-25T00:00:00Z";

    expect(
      hasVerbatimTemporalEvidence(
        { valid_from: timestamp, valid_until: null },
        [`prefixA${timestamp}Bsuffix`],
        [timestamp]
      )
    ).toBe(false);
    expect(
      hasVerbatimTemporalEvidence(
        { valid_from: timestamp, valid_until: null },
        [`Effective at ${timestamp}.`],
        []
      )
    ).toBe(false);
  });

  it("accepts an opaque scope option and rejects direct model-provided scope IDs", () => {
    expect(
      parseModelCandidateAnalysis({
        persistent_value: true,
        kind: "decision",
        memory_class: "semantic",
        scope_option_id: "scope-option-1",
        evidence_source_ids: ["evidence-1"],
        confidence: 0.98
      })
    ).toMatchObject({ kind: "decision", confidence: 0.98 });
    expect(() =>
      parseModelCandidateAnalysis({
        persistent_value: true,
        kind: "decision",
        memory_class: "semantic",
        scope: "project",
        scope_id: "project-1",
        scope_option_id: "scope-option-1",
        evidence_source_ids: ["evidence-1"],
        confidence: 1
      })
    ).toThrow();
  });

  it("requires persistent proposals to cite evidence and select a server option", () => {
    expect(() =>
      parseModelCandidateAnalysis({
        persistent_value: true,
        kind: "decision",
        memory_class: "semantic",
        confidence: 0.9
      })
    ).toThrow("scope option");
    expect(
      parseModelCandidateAnalysis({
        persistent_value: false,
        confidence: 0.2
      })
    ).toEqual({
      persistent_value: false,
      kind: null,
      memory_class: null,
      scope_option_id: null,
      evidence_source_ids: null,
      valid_from: null,
      valid_until: null,
      confidence: 0.2
    });
    expect(() =>
      parseModelCandidateAnalysis({
        persistent_value: false,
        kind: "decision",
        memory_class: "semantic",
        scope_option_id: "scope-option-1",
        evidence_source_ids: ["evidence-1"],
        valid_from: "2026-07-25T00:00:00Z",
        valid_until: null,
        confidence: 0.2
      })
    ).toThrow("Non-persistent proposals");
    expect(() =>
      parseModelCandidateAnalysis({
        persistent_value: true,
        kind: null,
        memory_class: null,
        scope_option_id: null,
        evidence_source_ids: null,
        valid_from: null,
        valid_until: null,
        confidence: 0.9
      })
    ).toThrow("scope option");
  });

  it("normalizes exact string nulls observed in GLM forced-function arguments", () => {
    const candidateArguments = readModelFunctionArguments(
      functionResponse("candidate_analysis", {
        persistent_value: false,
        kind: "null",
        memory_class: "null",
        scope_option_id: "null",
        evidence_source_ids: "null",
        valid_from: "null",
        valid_until: "null",
        confidence: 0.2
      }),
      "candidate_analysis"
    );
    expect(parseModelCandidateAnalysis(candidateArguments)).toEqual({
      persistent_value: false,
      kind: null,
      memory_class: null,
      scope_option_id: null,
      evidence_source_ids: null,
      valid_from: null,
      valid_until: null,
      confidence: 0.2
    });

    const consolidationArguments = readModelFunctionArguments(
      functionResponse("consolidation_suggestions", {
        suggestions: [
          {
            content: "Use D1 as the authority.",
            kind: "decision",
            memory_class: "semantic",
            scope_option_id: "scope-option-1",
            valid_from: "null",
            valid_until: "null",
            evidence_source_ids: ["candidate-1"],
            confidence: 0.9
          }
        ]
      }),
      "consolidation_suggestions"
    );
    expect(
      parseModelConsolidationSuggestions(
        consolidationArguments,
        new Set(["candidate-1"])
      )
    ).toEqual([
      expect.objectContaining({ valid_from: null, valid_until: null })
    ]);
  });

  it("rejects non-exact null-like strings instead of coercing them", () => {
    const nullableCandidateFields = [
      "kind",
      "memory_class",
      "scope_option_id",
      "evidence_source_ids",
      "valid_from",
      "valid_until"
    ] as const;
    const exactStringNullCandidate = {
      persistent_value: false,
      kind: "null",
      memory_class: "null",
      scope_option_id: "null",
      evidence_source_ids: "null",
      valid_from: "null",
      valid_until: "null",
      confidence: 0.2
    };
    for (const field of nullableCandidateFields) {
      expect(() =>
        parseModelCandidateAnalysis({
          ...exactStringNullCandidate,
          [field]: "NULL"
        })
      ).toThrow();
    }

    for (const value of ["Null", " null", "null "]) {
      expect(() =>
        parseModelConsolidationSuggestions(
          {
            suggestions: [
              {
                content: "Use D1 as the authority.",
                kind: "decision",
                memory_class: "semantic",
                scope_option_id: "scope-option-1",
                valid_from: value,
                valid_until: "null",
                evidence_source_ids: ["candidate-1"],
                confidence: 0.9
              }
            ]
          },
          new Set(["candidate-1"])
        )
      ).toThrow();
    }
  });

  it("requires consolidation evidence to be a subset of frozen inputs", () => {
    const valid = parseModelConsolidationSuggestions(
      {
        suggestions: [
          {
            content: "Use D1 as the authority.",
            kind: "decision",
            memory_class: "semantic",
            scope_option_id: "scope-option-1",
            evidence_source_ids: ["candidate-1"],
            confidence: 0.9
          }
        ]
      },
      new Set(["candidate-1"])
    );
    expect(valid).toHaveLength(1);
    expect(() =>
      parseModelConsolidationSuggestions(
        {
          suggestions: [
            {
              ...valid[0],
              evidence_source_ids: ["invented"]
            }
          ]
        },
        new Set(["candidate-1"])
      )
    ).toThrow("frozen");
    expect(() =>
      parseModelConsolidationSuggestions(
        {
          suggestions: [
            {
              ...valid[0],
              scope: "project",
              scope_id: "project-1"
            }
          ]
        },
        new Set(["candidate-1"])
      )
    ).toThrow();
  });

  it("extracts JSON only from supported non-streaming model responses", () => {
    expect(readModelJson('{"persistent_value":false}')).toEqual({
      persistent_value: false
    });
    expect(
      readModelJson({ choices: [{ message: { content: '{"persistent_value":false}' } }] })
    ).toEqual({ persistent_value: false });
    expect(readModelJson({ response: { persistent_value: false } })).toEqual({
      persistent_value: false
    });
    expect(readModelJson({ response: '{"persistent_value":false}' })).toEqual({
      persistent_value: false
    });
    expect(() => readModelJson({ response: "untrusted" })).toThrow("model response");
  });

  it("extracts one exact forced function call", () => {
    expect(
      readModelFunctionArguments(
        functionResponse("candidate_analysis", {
          persistent_value: false,
          confidence: 0.9
        }),
        "candidate_analysis"
      )
    ).toEqual({ persistent_value: false, confidence: 0.9 });
  });

  it("rejects the wrong function name and multiple function calls", () => {
    expect(() =>
      readModelFunctionArguments(
        functionResponse("invented_analysis", { persistent_value: false }),
        "candidate_analysis"
      )
    ).toThrow("model function response");
    expect(() =>
      readModelFunctionArguments(
        {
          choices: [
            {
              message: {
                tool_calls: [
                  functionCall("candidate_analysis", "{}"),
                  functionCall("candidate_analysis", "{}")
                ]
              }
            }
          ]
        },
        "candidate_analysis"
      )
    ).toThrow("model function response");
  });

  it("rejects non-JSON function arguments", () => {
    expect(() =>
      readModelFunctionArguments(
        functionResponse("candidate_analysis", "not-json", true),
        "candidate_analysis"
      )
    ).toThrow("model function response");
  });

  it("accepts exactly 1 MiB of function arguments and rejects one byte more", () => {
    const emptyObjectBytes = new TextEncoder().encode(JSON.stringify({ value: "" })).byteLength;
    const boundaryValue = "x".repeat(
      MODEL_RESPONSE_TRANSPORT_MAX_BYTES - emptyObjectBytes
    );
    const boundaryArguments = JSON.stringify({ value: boundaryValue });
    const oversizedArguments = JSON.stringify({ value: `${boundaryValue}x` });

    expect(new TextEncoder().encode(boundaryArguments)).toHaveLength(
      MODEL_RESPONSE_TRANSPORT_MAX_BYTES
    );
    expect(
      readModelFunctionArguments(
        functionResponse("candidate_analysis", boundaryArguments, true),
        "candidate_analysis"
      )
    ).toEqual({ value: boundaryValue });
    expect(() =>
      readModelFunctionArguments(
        functionResponse("candidate_analysis", oversizedArguments, true),
        "candidate_analysis"
      )
    ).toThrow("model function response");
  });

  it("measures the function-argument transport boundary in UTF-8 bytes", () => {
    const emptyObjectBytes = new TextEncoder().encode(JSON.stringify({ value: "" })).byteLength;
    const availableBytes = MODEL_RESPONSE_TRANSPORT_MAX_BYTES - emptyObjectBytes;
    expect(availableBytes % 4).toBe(0);
    const boundaryValue = "😀".repeat(availableBytes / 4);
    const boundaryArguments = JSON.stringify({ value: boundaryValue });

    expect(boundaryValue).toHaveLength((availableBytes / 4) * 2);
    expect(new TextEncoder().encode(boundaryArguments)).toHaveLength(
      MODEL_RESPONSE_TRANSPORT_MAX_BYTES
    );
    expect(
      readModelFunctionArguments(
        functionResponse("candidate_analysis", boundaryArguments, true),
        "candidate_analysis"
      )
    ).toEqual({ value: boundaryValue });
    expect(() =>
      readModelFunctionArguments(
        functionResponse(
          "candidate_analysis",
          `${boundaryArguments.slice(0, -2)}😀"}`,
          true
        ),
        "candidate_analysis"
      )
    ).toThrow("model function response");
  });

  it("applies separate semantic UTF-8 JSON bounds after schema parsing", () => {
    const evidenceIds = Array.from(
      { length: 50 },
      (_, index) => `${String(index).padStart(2, "0")}-${"界".repeat(509)}`
    );
    const candidate = parseModelCandidateAnalysis({
      persistent_value: true,
      kind: "decision",
      memory_class: "semantic",
      scope_option_id: "scope-option-1",
      evidence_source_ids: evidenceIds,
      confidence: 0.9
    });
    expect(new TextEncoder().encode(JSON.stringify(candidate)).byteLength).toBeLessThan(
      CANDIDATE_ANALYSIS_MAX_UTF8_BYTES
    );

    const suggestion = {
      // Each astral character occupies two JavaScript code units but four UTF-8 bytes.
      content: "😀".repeat(32_768),
      kind: "decision" as const,
      memory_class: "semantic" as const,
      scope_option_id: "scope-option-1",
      evidence_source_ids: ["candidate-1"],
      confidence: 0.9
    };
    const accepted = { suggestions: Array.from({ length: 7 }, () => suggestion) };
    expect(new TextEncoder().encode(JSON.stringify(accepted)).byteLength).toBeLessThan(
      CONSOLIDATION_SUGGESTIONS_MAX_UTF8_BYTES
    );
    expect(
      parseModelConsolidationSuggestions(accepted, new Set(["candidate-1"]))
    ).toHaveLength(7);

    const oversized = { suggestions: Array.from({ length: 8 }, () => suggestion) };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(
      CONSOLIDATION_SUGGESTIONS_MAX_UTF8_BYTES
    );
    expect(() =>
      parseModelConsolidationSuggestions(oversized, new Set(["candidate-1"]))
    ).toThrow(/1048576-byte UTF-8 JSON limit/iu);
  });
});

function functionResponse(name: string, value: unknown, raw = false): Record<string, unknown> {
  const argumentsText = raw && typeof value === "string" ? value : JSON.stringify(value);
  return {
    choices: [
      {
        message: {
          tool_calls: [functionCall(name, argumentsText)]
        }
      }
    ]
  };
}

function functionCall(name: string, argumentsText: string): Record<string, unknown> {
  return {
    type: "function",
    function: { name, arguments: argumentsText }
  };
}
