import type {
  FusedRecallHit,
  IndexGeneration,
  IndexGenerationMetadata,
  RecallSet,
  ValidatedSearchCandidate
} from "./types";

const DEFAULT_RRF_CONSTANT = 60;
const MAX_GENERATION_LENGTH = 256;

export function asIndexGeneration(value: string): IndexGeneration {
  if (
    value.length === 0 ||
    value.trim() === "" ||
    value.length > MAX_GENERATION_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("index generation must be a non-empty opaque identifier.");
  }
  return value as IndexGeneration;
}

export function defineIndexGenerationMetadata(
  metadata: Omit<IndexGenerationMetadata, "id"> & { id: string }
): IndexGenerationMetadata {
  if (
    metadata.embeddingDimensions < 1 ||
    !Number.isSafeInteger(metadata.embeddingDimensions) ||
    metadata.distanceMetric !== "cosine" ||
    metadata.embeddingModel.trim() === "" ||
    metadata.instructionVersion.trim() === "" ||
    metadata.chunkSchemaVersion.trim() === "" ||
    metadata.rerankerModel.trim() === ""
  ) {
    throw new TypeError("index generation metadata is invalid.");
  }
  return { ...metadata, id: asIndexGeneration(metadata.id) };
}

export function fuseReciprocalRanks(
  recallSets: readonly RecallSet[],
  activeGeneration: IndexGeneration,
  rrfConstant = DEFAULT_RRF_CONSTANT
): FusedRecallHit[] {
  if (!Number.isFinite(rrfConstant) || rrfConstant < 1) {
    throw new TypeError("rrfConstant must be at least 1.");
  }
  const fused = new Map<string, FusedRecallHit>();
  for (const recallSet of recallSets) {
    if (!Number.isFinite(recallSet.weight) || recallSet.weight <= 0) {
      throw new TypeError("recall weights must be positive.");
    }
    const seenInChannel = new Set<string>();
    recallSet.hits.forEach((hit, index) => {
      if (hit.indexGeneration !== activeGeneration) {
        return;
      }
      const key = recallIdentity(hit);
      if (seenInChannel.has(key)) {
        return;
      }
      seenInChannel.add(key);
      const contribution = recallSet.weight / (rrfConstant + index + 1);
      const existing = fused.get(key);
      if (existing === undefined) {
        fused.set(key, {
          ...hit,
          retrievalScore: contribution,
          channels: [recallSet.channel]
        });
      } else {
        existing.retrievalScore += contribution;
        if (!existing.channels.includes(recallSet.channel)) {
          existing.channels.push(recallSet.channel);
        }
      }
    });
  }
  return [...fused.values()].sort(
    (left, right) =>
      right.retrievalScore - left.retrievalScore ||
      left.memoryId.localeCompare(right.memoryId) ||
      left.revisionId.localeCompare(right.revisionId) ||
      left.chunkId.localeCompare(right.chunkId)
  );
}

export function deduplicateCandidates(
  candidates: readonly ValidatedSearchCandidate[]
): ValidatedSearchCandidate[] {
  const byMemory = new Map<string, ValidatedSearchCandidate>();
  for (const candidate of candidates) {
    const existing = byMemory.get(candidate.memoryId);
    if (
      existing === undefined ||
      candidate.memoryVersion > existing.memoryVersion ||
      (candidate.memoryVersion === existing.memoryVersion &&
        candidate.retrievalScore > existing.retrievalScore)
    ) {
      byMemory.set(candidate.memoryId, candidate);
    }
  }
  return [...byMemory.values()].sort(compareCandidates);
}

export function selectWithMmr(
  candidates: readonly ValidatedSearchCandidate[],
  options: { limit: number; lambda?: number }
): ValidatedSearchCandidate[] {
  const limit = Math.max(0, Math.min(options.limit, candidates.length));
  const lambda = options.lambda ?? 0.7;
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
    throw new TypeError("MMR lambda must be between 0 and 1.");
  }
  const remaining = [...candidates].sort(compareCandidates);
  const selected: ValidatedSearchCandidate[] = [];
  const maximumRetrievalScore = Math.max(
    0,
    ...remaining.map((candidate) => candidate.retrievalScore)
  );
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const [index, candidate] of remaining.entries()) {
      const redundancy =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((chosen) => candidateSimilarity(candidate, chosen)));
      const normalizedRelevance =
        maximumRetrievalScore === 0 ? 0 : candidate.retrievalScore / maximumRetrievalScore;
      const score = lambda * normalizedRelevance - (1 - lambda) * redundancy;
      const currentBest = remaining[bestIndex];
      if (
        score > bestScore ||
        (score === bestScore &&
          currentBest !== undefined &&
          candidate.memoryId.localeCompare(currentBest.memoryId) < 0)
      ) {
        bestIndex = index;
        bestScore = score;
      }
    }
    const chosen = remaining.splice(bestIndex, 1)[0];
    if (chosen !== undefined) {
      selected.push(chosen);
    }
  }
  return selected;
}

function recallIdentity(hit: {
  projectId: string;
  memoryId: string;
  revisionId: string;
  chunkId: string;
}): string {
  return `${hit.projectId}\u0000${hit.memoryId}\u0000${hit.revisionId}\u0000${hit.chunkId}`;
}

function compareCandidates(
  left: ValidatedSearchCandidate,
  right: ValidatedSearchCandidate
): number {
  return (
    right.retrievalScore - left.retrievalScore ||
    right.memoryVersion - left.memoryVersion ||
    left.memoryId.localeCompare(right.memoryId)
  );
}

function candidateSimilarity(
  left: ValidatedSearchCandidate,
  right: ValidatedSearchCandidate
): number {
  if (
    left.embedding !== undefined &&
    right.embedding !== undefined &&
    left.embedding.length > 0 &&
    left.embedding.length === right.embedding.length
  ) {
    return cosineSimilarity(left.embedding, right.embedding);
  }
  return lexicalSimilarity(left.chunkContent, right.chunkContent);
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

function lexicalSimilarity(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? []
  );
}
