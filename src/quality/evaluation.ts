export type EvaluationLanguage = "en" | "zh";
export type CandidateDecision = "promote" | "reject" | "abstain";
export type EvaluatedMemoryStatus =
  | "active"
  | "contested"
  | "superseded"
  | "invalidated"
  | "archived";

export interface CandidateJudgment {
  id: string;
  language: EvaluationLanguage;
  goldPromotable: boolean;
  goldShouldAbstain: boolean;
  decision: CandidateDecision;
}

export interface RetrievalJudgment {
  queryId: string;
  language: EvaluationLanguage;
  rankedMemoryIds: readonly string[];
  relevance: Readonly<Record<string, number>>;
}

export interface ArtifactJudgment {
  memoryId: string;
  evidenceIds: readonly string[];
  revisionId: string;
  checksum: string;
}

export interface DefaultResultJudgment {
  resultId: string;
  projectMatches: boolean;
  status: EvaluatedMemoryStatus;
  stale: boolean;
}

export interface QualityEvaluationInput {
  candidates: readonly CandidateJudgment[];
  retrieval: readonly RetrievalJudgment[];
  artifacts: readonly ArtifactJudgment[];
  defaultResults: readonly DefaultResultJudgment[];
  noise10x: {
    baselineCorpusSize: number;
    noisyCorpusSize: number;
    retrieval: readonly RetrievalJudgment[];
  };
}

export interface CoreQualityMetrics {
  promotionPrecision: number;
  precisionAt5: number;
  recallAt10: number;
  ndcgAt10: number;
  abstentionPrecision: number;
}

export interface RetrievalQualityMetrics {
  precisionAt5: number;
  recallAt10: number;
  ndcgAt10: number;
}

export interface QualityEvaluationReport extends CoreQualityMetrics {
  byLanguage: Record<EvaluationLanguage, CoreQualityMetrics>;
  languageGap: CoreQualityMetrics & { maximum: number };
  completeness: {
    evidence: number;
    revision: number;
    checksum: number;
  };
  leakage: {
    count: number;
    rate: number;
  };
  noise10xDegradation: RetrievalQualityMetrics & { maximum: number };
}

export interface QualityCanarySource {
  loadSyntheticEvaluationInput(): Promise<QualityEvaluationInput>;
}

export function precisionAt(
  rankedMemoryIds: readonly string[],
  relevance: Readonly<Record<string, number>>,
  cutoff: number
): number {
  validateMetricInput(relevance, cutoff);
  const relevant = rankedMemoryIds
    .slice(0, cutoff)
    .filter((memoryId) => (relevance[memoryId] ?? 0) > 0).length;
  return relevant / cutoff;
}

export function recallAt(
  rankedMemoryIds: readonly string[],
  relevance: Readonly<Record<string, number>>,
  cutoff: number
): number {
  validateMetricInput(relevance, cutoff);
  const relevantGoldIds = Object.entries(relevance)
    .filter(([, grade]) => grade > 0)
    .map(([memoryId]) => memoryId);
  if (relevantGoldIds.length === 0) {
    return 0;
  }
  const retrieved = new Set(rankedMemoryIds.slice(0, cutoff));
  const matched = relevantGoldIds.filter((memoryId) => retrieved.has(memoryId)).length;
  return matched / relevantGoldIds.length;
}

export function normalizedDiscountedCumulativeGainAt(
  rankedMemoryIds: readonly string[],
  relevance: Readonly<Record<string, number>>,
  cutoff: number
): number {
  validateMetricInput(relevance, cutoff);
  const observedGrades = rankedMemoryIds
    .slice(0, cutoff)
    .map((memoryId) => relevance[memoryId] ?? 0);
  const idealGrades = Object.values(relevance)
    .filter((grade) => grade > 0)
    .sort((left, right) => right - left)
    .slice(0, cutoff);
  const ideal = discountedCumulativeGain(idealGrades);
  return ideal === 0 ? 0 : discountedCumulativeGain(observedGrades) / ideal;
}

export function evaluateGoldSet(input: QualityEvaluationInput): QualityEvaluationReport {
  validateGoldSet(input);
  const overall = scoreCore(input.candidates, input.retrieval);
  const byLanguage = {
    en: scoreLanguage(input, "en"),
    zh: scoreLanguage(input, "zh")
  };
  const languageGap = calculateLanguageGap(byLanguage);
  const baselineRetrieval = scoreRetrieval(input.retrieval);
  const noisyRetrieval = scoreRetrieval(input.noise10x.retrieval);
  return {
    ...overall,
    byLanguage,
    languageGap,
    completeness: scoreCompleteness(input.artifacts),
    leakage: scoreLeakage(input.defaultResults),
    noise10xDegradation: calculateNoiseDegradation(
      baselineRetrieval,
      noisyRetrieval
    )
  };
}

export async function evaluateRemoteCanary(
  source: QualityCanarySource
): Promise<QualityEvaluationReport> {
  return evaluateGoldSet(await source.loadSyntheticEvaluationInput());
}

function scoreLanguage(
  input: QualityEvaluationInput,
  language: EvaluationLanguage
): CoreQualityMetrics {
  return scoreCore(
    input.candidates.filter((candidate) => candidate.language === language),
    input.retrieval.filter((query) => query.language === language)
  );
}

function scoreCore(
  candidates: readonly CandidateJudgment[],
  retrieval: readonly RetrievalJudgment[]
): CoreQualityMetrics {
  const promoted = candidates.filter((candidate) => candidate.decision === "promote");
  const abstained = candidates.filter((candidate) => candidate.decision === "abstain");
  return {
    promotionPrecision: ratio(
      promoted.filter((candidate) => candidate.goldPromotable).length,
      promoted.length
    ),
    ...scoreRetrieval(retrieval),
    abstentionPrecision: ratio(
      abstained.filter((candidate) => candidate.goldShouldAbstain).length,
      abstained.length
    )
  };
}

function scoreRetrieval(
  retrieval: readonly RetrievalJudgment[]
): RetrievalQualityMetrics {
  return {
    precisionAt5: mean(
      retrieval.map((query) =>
        precisionAt(query.rankedMemoryIds, query.relevance, 5)
      )
    ),
    recallAt10: mean(
      retrieval.map((query) => recallAt(query.rankedMemoryIds, query.relevance, 10))
    ),
    ndcgAt10: mean(
      retrieval.map((query) =>
        normalizedDiscountedCumulativeGainAt(
          query.rankedMemoryIds,
          query.relevance,
          10
        )
      )
    )
  };
}

function calculateLanguageGap(
  metrics: Record<EvaluationLanguage, CoreQualityMetrics>
): CoreQualityMetrics & { maximum: number } {
  const gaps: CoreQualityMetrics = {
    promotionPrecision: absoluteDifference(
      metrics.en.promotionPrecision,
      metrics.zh.promotionPrecision
    ),
    precisionAt5: absoluteDifference(
      metrics.en.precisionAt5,
      metrics.zh.precisionAt5
    ),
    recallAt10: absoluteDifference(metrics.en.recallAt10, metrics.zh.recallAt10),
    ndcgAt10: absoluteDifference(metrics.en.ndcgAt10, metrics.zh.ndcgAt10),
    abstentionPrecision: absoluteDifference(
      metrics.en.abstentionPrecision,
      metrics.zh.abstentionPrecision
    )
  };
  return {
    ...gaps,
    maximum: Math.max(...Object.values(gaps))
  };
}

function scoreCompleteness(
  artifacts: readonly ArtifactJudgment[]
): QualityEvaluationReport["completeness"] {
  return {
    evidence: ratio(
      artifacts.filter((artifact) =>
        artifact.evidenceIds.some((evidenceId) => evidenceId.trim().length > 0)
      ).length,
      artifacts.length
    ),
    revision: ratio(
      artifacts.filter((artifact) => artifact.revisionId.trim().length > 0).length,
      artifacts.length
    ),
    checksum: ratio(
      artifacts.filter((artifact) => /^[a-f0-9]{64}$/iu.test(artifact.checksum))
        .length,
      artifacts.length
    )
  };
}

function scoreLeakage(
  results: readonly DefaultResultJudgment[]
): QualityEvaluationReport["leakage"] {
  const count = results.filter(
    (result) =>
      !result.projectMatches || result.status !== "active" || result.stale
  ).length;
  return {
    count,
    rate: ratio(count, results.length)
  };
}

function calculateNoiseDegradation(
  baseline: RetrievalQualityMetrics,
  noisy: RetrievalQualityMetrics
): QualityEvaluationReport["noise10xDegradation"] {
  const degradation: RetrievalQualityMetrics = {
    precisionAt5: downwardDifference(baseline.precisionAt5, noisy.precisionAt5),
    recallAt10: downwardDifference(baseline.recallAt10, noisy.recallAt10),
    ndcgAt10: downwardDifference(baseline.ndcgAt10, noisy.ndcgAt10)
  };
  return {
    ...degradation,
    maximum: Math.max(...Object.values(degradation))
  };
}

function validateGoldSet(input: QualityEvaluationInput): void {
  if (
    !Number.isInteger(input.noise10x.baselineCorpusSize) ||
    input.noise10x.baselineCorpusSize <= 0 ||
    !Number.isInteger(input.noise10x.noisyCorpusSize) ||
    input.noise10x.noisyCorpusSize !== input.noise10x.baselineCorpusSize * 10
  ) {
    throw new Error("The unrelated-noise corpus must be exactly 10x the baseline.");
  }
  validateUniqueIds(input.candidates.map((candidate) => candidate.id), "candidate");
  validateUniqueIds(input.retrieval.map((query) => query.queryId), "retrieval query");
  validateUniqueIds(
    input.noise10x.retrieval.map((query) => query.queryId),
    "noisy retrieval query"
  );
  validateBilingualCoverage(input);
  validateRetrievalQueries(input.retrieval);
  validateRetrievalQueries(input.noise10x.retrieval);
  validateNoisePairs(input.retrieval, input.noise10x.retrieval);
}

function validateBilingualCoverage(input: QualityEvaluationInput): void {
  for (const language of ["en", "zh"] as const) {
    if (!input.candidates.some((candidate) => candidate.language === language)) {
      throw new Error(`The gold set requires ${language} candidate judgments.`);
    }
    if (!input.retrieval.some((query) => query.language === language)) {
      throw new Error(`The gold set requires ${language} retrieval judgments.`);
    }
  }
}

function validateRetrievalQueries(queries: readonly RetrievalJudgment[]): void {
  for (const query of queries) {
    validateMetricInput(query.relevance, 10);
    validateUniqueIds(query.rankedMemoryIds, `ranked result for ${query.queryId}`);
  }
}

function validateNoisePairs(
  baseline: readonly RetrievalJudgment[],
  noisy: readonly RetrievalJudgment[]
): void {
  const baselineById = new Map(baseline.map((query) => [query.queryId, query]));
  if (
    baseline.length !== noisy.length ||
    noisy.some((query) => !baselineById.has(query.queryId))
  ) {
    throw new Error("Baseline and 10x-noise sets must contain the same query IDs.");
  }
  for (const noisyQuery of noisy) {
    const baselineQuery = baselineById.get(noisyQuery.queryId)!;
    if (
      baselineQuery.language !== noisyQuery.language ||
      canonicalRelevance(baselineQuery.relevance) !==
        canonicalRelevance(noisyQuery.relevance)
    ) {
      throw new Error(
        "Paired baseline and 10x-noise queries must share language and relevance gold."
      );
    }
  }
}

function validateMetricInput(
  relevance: Readonly<Record<string, number>>,
  cutoff: number
): void {
  if (!Number.isInteger(cutoff) || cutoff <= 0) {
    throw new Error("Metric cutoff must be a positive integer.");
  }
  if (
    Object.values(relevance).some(
      (grade) => !Number.isInteger(grade) || grade < 0
    )
  ) {
    throw new Error("Relevance grades must be non-negative integers.");
  }
}

function validateUniqueIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Every ${label} ID must be unique.`);
  }
}

function canonicalRelevance(relevance: Readonly<Record<string, number>>): string {
  return JSON.stringify(
    Object.entries(relevance).sort(([left], [right]) => left.localeCompare(right))
  );
}

function discountedCumulativeGain(grades: readonly number[]): number {
  return grades.reduce(
    (total, grade, index) =>
      total + (2 ** grade - 1) / Math.log2(index + 2),
    0
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function absoluteDifference(left: number, right: number): number {
  return Math.abs(left - right);
}

function downwardDifference(baseline: number, noisy: number): number {
  return Math.max(0, baseline - noisy);
}
