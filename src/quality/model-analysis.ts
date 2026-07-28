import { z } from "zod";
import { MEMORY_CLASSES, MEMORY_KINDS, MEMORY_SCOPES } from "../contracts/taxonomy";
import { isValidValidityInterval } from "../contracts/validity";

const MODEL_JSON_MAX_BYTES = 256 * 1024;
const MAX_VERBATIM_TEMPORAL_VALUES = 32;
const ISO_OFFSET_TIMESTAMP_PATTERN =
  /(?:^|[^0-9A-Za-z])(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))(?=$|[^0-9A-Za-z])/gu;
const isoOffsetTimestampSchema = z.iso.datetime({ offset: true });

function normalizeExactNullString(value: unknown): unknown {
  return value === "null" ? null : value;
}

const candidateAnalysisSchema = z.object({
  persistent_value: z.boolean(),
  kind: z.enum(MEMORY_KINDS).optional(),
  memory_class: z.enum(MEMORY_CLASSES).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  scope_id: z.string().min(1).max(2048).optional(),
  valid_from: z.iso.datetime({ offset: true }).nullable().optional(),
  valid_until: z.iso.datetime({ offset: true }).nullable().optional(),
  confidence: z.number().min(0).max(1)
}).strict().superRefine((value, context) => {
  if (
    value.persistent_value &&
    (value.kind === undefined ||
      value.memory_class === undefined ||
      value.scope === undefined ||
      value.scope_id === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "Persistent proposals require complete taxonomy."
    });
  }
});

const modelCandidateAnalysisSchema = z.object({
  persistent_value: z.boolean(),
  kind: z.preprocess(
    normalizeExactNullString,
    z.enum(MEMORY_KINDS).nullable().optional()
  ),
  memory_class: z.preprocess(
    normalizeExactNullString,
    z.enum(MEMORY_CLASSES).nullable().optional()
  ),
  scope_option_id: z.preprocess(
    normalizeExactNullString,
    z.string().min(1).max(128).nullable().optional()
  ),
  evidence_source_ids: z.preprocess(
    normalizeExactNullString,
    z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(50)
      .nullable()
      .optional()
  ),
  valid_from: z.preprocess(
    normalizeExactNullString,
    z.iso.datetime({ offset: true }).nullable().optional()
  ),
  valid_until: z.preprocess(
    normalizeExactNullString,
    z.iso.datetime({ offset: true }).nullable().optional()
  ),
  confidence: z.number().min(0).max(1)
}).strict().superRefine((value, context) => {
  if (value.persistent_value) {
    if (
      value.kind == null ||
      value.memory_class == null ||
      value.scope_option_id == null ||
      value.evidence_source_ids == null
    ) {
      context.addIssue({
        code: "custom",
        message: "Persistent proposals require complete taxonomy, a scope option, and evidence."
      });
    }
    return;
  }

  if (
    value.kind != null ||
    value.memory_class != null ||
    value.scope_option_id != null ||
    value.evidence_source_ids != null ||
    value.valid_from != null ||
    value.valid_until != null
  ) {
    context.addIssue({
      code: "custom",
      message: "Non-persistent proposals cannot include taxonomy, scope, evidence, or timestamps."
    });
  }
}).transform((value) => ({
  ...value,
  kind: value.kind ?? null,
  memory_class: value.memory_class ?? null,
  scope_option_id: value.scope_option_id ?? null,
  evidence_source_ids: value.evidence_source_ids ?? null,
  valid_from: value.valid_from ?? null,
  valid_until: value.valid_until ?? null
}));

const suggestionSchema = z.object({
  content: z.string().min(1).max(65_536),
  kind: z.enum(MEMORY_KINDS),
  memory_class: z.enum(MEMORY_CLASSES),
  scope: z.enum(MEMORY_SCOPES),
  scope_id: z.string().min(1).max(2048),
  valid_from: z.iso.datetime({ offset: true }).nullable().optional(),
  valid_until: z.iso.datetime({ offset: true }).nullable().optional(),
  evidence_source_ids: z.array(z.string().min(1).max(512)).min(1).max(50),
  confidence: z.number().min(0).max(1)
}).strict();

const modelSuggestionSchema = z.object({
  content: z.string().min(1).max(65_536),
  kind: z.enum(MEMORY_KINDS),
  memory_class: z.enum(MEMORY_CLASSES),
  scope_option_id: z.string().min(1).max(128),
  valid_from: z.preprocess(
    normalizeExactNullString,
    z.iso.datetime({ offset: true }).nullable().optional()
  ),
  valid_until: z.preprocess(
    normalizeExactNullString,
    z.iso.datetime({ offset: true }).nullable().optional()
  ),
  evidence_source_ids: z.array(z.string().min(1).max(512)).min(1).max(50),
  confidence: z.number().min(0).max(1)
}).strict();

const consolidationSchema = z.object({
  suggestions: z.array(suggestionSchema).max(10)
}).strict();

const modelConsolidationSchema = z.object({
  suggestions: z.array(modelSuggestionSchema).max(10)
}).strict();

export type CandidateAnalysis = z.infer<typeof candidateAnalysisSchema>;
export type ModelCandidateAnalysis = z.infer<typeof modelCandidateAnalysisSchema>;
export type ConsolidationSuggestion = z.infer<typeof suggestionSchema>;
export type ModelConsolidationSuggestion = z.infer<typeof modelSuggestionSchema>;

export function extractVerbatimIsoOffsetTimestamps(
  evidenceTexts: readonly string[]
): string[] {
  const timestamps = new Set<string>();
  for (const text of evidenceTexts) {
    const pattern = new RegExp(
      ISO_OFFSET_TIMESTAMP_PATTERN.source,
      ISO_OFFSET_TIMESTAMP_PATTERN.flags
    );
    for (const match of text.matchAll(pattern)) {
      const timestamp = match[1];
      if (
        timestamp !== undefined &&
        isoOffsetTimestampSchema.safeParse(timestamp).success &&
        isValidValidityInterval({ validFrom: timestamp, validUntil: null })
      ) {
        timestamps.add(timestamp);
      }
    }
  }
  return [...timestamps]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, MAX_VERBATIM_TEMPORAL_VALUES);
}

export function hasVerbatimTemporalEvidence(
  value: {
    valid_from?: string | null | undefined;
    valid_until?: string | null | undefined;
  },
  evidenceTexts: readonly string[],
  toolTimestampWhitelist: readonly string[]
): boolean {
  const allowedTimestamps = new Set(toolTimestampWhitelist);
  return (
    isValidValidityInterval({
      validFrom: value.valid_from,
      validUntil: value.valid_until
    }) &&
    [value.valid_from, value.valid_until].every(
      (timestamp) =>
        timestamp === undefined ||
        timestamp === null ||
        (allowedTimestamps.has(timestamp) &&
          evidenceTexts.some((text) => containsVerbatimTimestamp(text, timestamp)))
    )
  );
}

function containsVerbatimTimestamp(text: string, timestamp: string): boolean {
  const pattern = new RegExp(
    ISO_OFFSET_TIMESTAMP_PATTERN.source,
    ISO_OFFSET_TIMESTAMP_PATTERN.flags
  );
  for (const match of text.matchAll(pattern)) {
    if (match[1] === timestamp) {
      return true;
    }
  }
  return false;
}

export function parseCandidateAnalysis(value: unknown): CandidateAnalysis {
  return candidateAnalysisSchema.parse(value);
}

export function parseModelCandidateAnalysis(value: unknown): ModelCandidateAnalysis {
  return modelCandidateAnalysisSchema.parse(value);
}

export function parseConsolidationSuggestions(
  value: unknown,
  frozenSourceIds: ReadonlySet<string>
): ConsolidationSuggestion[] {
  const parsed = consolidationSchema.parse(value).suggestions;
  assertFrozenEvidenceSubset(parsed, frozenSourceIds);
  return parsed;
}

function assertFrozenEvidenceSubset(
  suggestions: ReadonlyArray<{ evidence_source_ids: readonly string[] }>,
  frozenSourceIds: ReadonlySet<string>
): void {
  for (const suggestion of suggestions) {
    if (suggestion.evidence_source_ids.some((sourceId) => !frozenSourceIds.has(sourceId))) {
      throw new Error("Model evidence must be a subset of frozen consolidation inputs.");
    }
  }
}

export function parseModelConsolidationSuggestions(
  value: unknown,
  frozenSourceIds: ReadonlySet<string>
): ModelConsolidationSuggestion[] {
  const parsed = modelConsolidationSchema.parse(value).suggestions;
  assertFrozenEvidenceSubset(parsed, frozenSourceIds);
  return parsed;
}

export function readModelJson(response: unknown): unknown {
  let text: string | undefined;
  if (typeof response === "string") {
    text = response;
  } else if (isRecord(response)) {
    if (typeof response.response === "string") {
      text = response.response;
    } else if (isRecord(response.response) || Array.isArray(response.response)) {
      return cloneBoundedJson(response.response);
    } else if (Array.isArray(response.choices)) {
      const first = response.choices[0];
      if (isRecord(first)) {
        if (isRecord(first.message) && typeof first.message.content === "string") {
          text = first.message.content;
        } else if (typeof first.text === "string") {
          text = first.text;
        }
      }
    }
  }
  if (text === undefined || new TextEncoder().encode(text).byteLength > MODEL_JSON_MAX_BYTES) {
    throw new Error("Unsupported model response.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Unsupported model response.");
  }
}

export function readModelFunctionArguments(
  response: unknown,
  expectedFunctionName: string
): unknown {
  if (
    expectedFunctionName.length === 0 ||
    expectedFunctionName.length > 64 ||
    !/^[A-Za-z0-9_-]+$/u.test(expectedFunctionName) ||
    !isRecord(response) ||
    !Array.isArray(response.choices) ||
    response.choices.length !== 1
  ) {
    throw new Error("Unsupported model function response.");
  }
  const choice = response.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new Error("Unsupported model function response.");
  }
  const toolCalls = choice.message.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
    throw new Error("Unsupported model function response.");
  }
  const toolCall = toolCalls[0];
  if (
    !isRecord(toolCall) ||
    toolCall.type !== "function" ||
    !isRecord(toolCall.function) ||
    toolCall.function.name !== expectedFunctionName ||
    typeof toolCall.function.arguments !== "string"
  ) {
    throw new Error("Unsupported model function response.");
  }
  const argumentsText = toolCall.function.arguments;
  if (new TextEncoder().encode(argumentsText).byteLength > MODEL_JSON_MAX_BYTES) {
    throw new Error("Unsupported model function response.");
  }
  try {
    return JSON.parse(argumentsText) as unknown;
  } catch {
    throw new Error("Unsupported model function response.");
  }
}

function cloneBoundedJson(value: Record<string, unknown> | unknown[]): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > MODEL_JSON_MAX_BYTES) {
      throw new Error("Unsupported model response.");
    }
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Unsupported model response.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
