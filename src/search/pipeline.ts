import { detectExactReferences } from "./exact";
import { normalizeLexicalQuery } from "./lexical";
import { passesHardFilters, planHardFilters } from "./planning";
import {
  deduplicateCandidates,
  fuseReciprocalRanks,
  selectWithMmr
} from "./ranking";
import type {
  AbstentionReason,
  CurrentHeadValidator,
  RecallProvider,
  RecallSet,
  Reranker,
  SearchPipelineInput,
  SearchPipelineResult,
  SearchResultMemory,
  ValidatedSearchCandidate
} from "./types";

interface SearchPipelineDependencies {
  exact?: RecallProvider;
  lexical?: RecallProvider;
  semantic?: RecallProvider;
  headValidator: CurrentHeadValidator;
  reranker: Reranker;
}

const RECALL_LIMIT = 20;
const RERANK_LIMIT = 20;
const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 10;
const DEFAULT_CONTEXT_TOKENS = 2_500;
const MAX_CONTEXT_TOKENS = 8_000;
const DEFAULT_MINIMUM_RELEVANCE = 0.35;

export class SearchPipeline {
  private readonly dependencies: SearchPipelineDependencies;

  constructor(dependencies: SearchPipelineDependencies) {
    this.dependencies = dependencies;
  }

  async search(input: SearchPipelineInput): Promise<SearchPipelineResult> {
    const query = input.query.normalize("NFKC").trim();
    const principalId = requireIdentifier(input.principalId, "principalId");
    const snapshotVersion = requireSnapshotVersion(input.snapshotVersion);
    const resultLimit = normalizeResultLimit(input.limit);
    const tokenBudget = normalizeTokenBudget(input.maximumContextTokens);
    const minimumRelevance = normalizeMinimumRelevance(input.minimumRelevance);
    const filters = planHardFilters({
      projectId: input.projectId,
      authorizedRepositoryIds: input.authorizedRepositoryIds,
      statuses: input.statuses,
      kinds: input.kinds,
      memoryClasses: input.memoryClasses,
      scope: input.scope,
      validAt: input.now ?? input.validAt,
      indexGeneration: input.indexGeneration
    });
    const exactReferences = detectExactReferences(query);
    const lexical = normalizeLexicalQuery(query);
    const recallInput = {
      query,
      lexicalQuery: lexical.ftsQuery,
      exactReferences,
      filters,
      limit: RECALL_LIMIT
    };
    const recallTasks: Array<Promise<RecallSet>> = [];
    if (this.dependencies.exact !== undefined && exactReferences.length > 0) {
      recallTasks.push(
        this.dependencies.exact
          .recall(recallInput)
          .then((hits) => ({ channel: "exact" as const, weight: 4, hits }))
      );
    }
    if (this.dependencies.lexical !== undefined && lexical.ftsQuery !== null) {
      recallTasks.push(
        this.dependencies.lexical
          .recall(recallInput)
          .then((hits) => ({ channel: "lexical" as const, weight: 1, hits }))
      );
    }
    if (this.dependencies.semantic !== undefined && query !== "") {
      recallTasks.push(
        this.dependencies.semantic
          .recall(recallInput)
          .then((hits) => ({ channel: "semantic" as const, weight: 1, hits }))
      );
    }
    const fused = fuseReciprocalRanks(await Promise.all(recallTasks), input.indexGeneration);
    if (fused.length === 0) {
      return abstain(input, "NO_RECALL");
    }
    const authoritative = await this.dependencies.headValidator.validate({
      projectId: filters.projectId,
      principalId,
      snapshotVersion,
      filters,
      candidates: fused
    });
    const recalled = new Map(
      fused.map((candidate) => [candidateIdentity(candidate), candidate] as const)
    );
    const current = authoritative
      .filter((candidate) => passesHardFilters(candidate, filters))
      .flatMap((candidate) => {
        const recall = recalled.get(candidateIdentity(candidate));
        return recall === undefined
          ? []
          : [{ ...candidate, retrievalScore: recall.retrievalScore }];
      });
    if (current.length === 0) {
      return abstain(input, "NO_CURRENT_HEAD_MATCH");
    }
    const evidenceBacked = deduplicateCandidates(current).filter(
      (candidate) => candidate.evidenceIds.length > 0
    );
    if (evidenceBacked.length === 0) {
      return abstain(input, "NO_EVIDENCE_BACKED_MATCH");
    }
    const diversified = selectWithMmr(evidenceBacked, {
      limit: Math.min(RERANK_LIMIT, evidenceBacked.length),
      lambda: 0.7
    });
    const reranked = await this.dependencies.reranker.rerank({
      query,
      candidates: diversified
    });
    const diversifiedByIdentity = new Map(
      diversified.map((candidate) => [candidateIdentity(candidate), candidate] as const)
    );
    const relevanceByIdentity = new Map<
      string,
      { candidate: (typeof diversified)[number]; relevance: number }
    >();
    for (const item of reranked) {
      const identity = candidateIdentity(item.candidate);
      const candidate = diversifiedByIdentity.get(identity);
      const existing = relevanceByIdentity.get(identity);
      if (
        candidate !== undefined &&
        Number.isFinite(item.relevance) &&
        item.relevance >= minimumRelevance &&
        (existing === undefined || item.relevance > existing.relevance)
      ) {
        relevanceByIdentity.set(identity, { candidate, relevance: item.relevance });
      }
    }
    const relevant = [...relevanceByIdentity.values()]
      .sort(
        (left, right) =>
          right.relevance - left.relevance ||
          right.candidate.retrievalScore - left.candidate.retrievalScore ||
          left.candidate.memoryId.localeCompare(right.candidate.memoryId)
      );
    if (relevant.length === 0) {
      return abstain(input, "LOW_RELEVANCE");
    }
    const memories: SearchResultMemory[] = [];
    let consumedTokens = 0;
    for (const item of relevant) {
      if (memories.length === resultLimit) {
        break;
      }
      const separatorTokens = memories.length === 0 ? 0 : estimateTokens("\n\n");
      const budgeted = fitMemoryToContextBudget(
        item.candidate,
        item.relevance,
        tokenBudget - consumedTokens - separatorTokens
      );
      if (budgeted === null) {
        continue;
      }
      memories.push(budgeted.memory);
      consumedTokens += separatorTokens + budgeted.estimatedTokens;
    }
    if (memories.length === 0) {
      return abstain(input, "CONTEXT_BUDGET_EXCEEDED");
    }
    return {
      snapshotVersion: input.snapshotVersion,
      indexGeneration: input.indexGeneration,
      abstained: false,
      abstentionReason: null,
      memories,
      contextPack: buildContextPack(memories)
    };
  }
}

function abstain(
  input: SearchPipelineInput,
  abstentionReason: AbstentionReason
): SearchPipelineResult {
  return {
    snapshotVersion: input.snapshotVersion,
    indexGeneration: input.indexGeneration,
    abstained: true,
    abstentionReason,
    memories: [],
    contextPack: ""
  };
}

function buildContextPack(memories: readonly SearchResultMemory[]): string {
  return memories.map(renderContextEntry).join("\n\n");
}

function renderContextEntry(memory: SearchResultMemory): string {
  return `${renderContextCitation(memory)} ${memory.excerpt}`;
}

function renderContextCitation(memory: {
  memoryId: string;
  revisionId: string;
  chunkId: string;
  evidenceIds: readonly string[];
}): string {
  const evidenceCitations = memory.evidenceIds
    .map((evidenceId) => `[evidence:${evidenceId}]`)
    .join(" ");
  return (
    `[memory:${memory.memoryId}] ` +
    `[revision:${memory.revisionId}] ` +
    `[chunk:${memory.chunkId}] ` +
    evidenceCitations
  );
}

function fitMemoryToContextBudget(
  candidate: ValidatedSearchCandidate,
  relevance: number,
  tokenBudget: number
): { memory: SearchResultMemory; estimatedTokens: number } | null {
  const citationPrefix = `${renderContextCitation(candidate)} `;
  const excerptBudget = tokenBudget - estimateTokens(citationPrefix);
  if (excerptBudget < 1) {
    return null;
  }
  const excerpt = truncateToTokenBudget(candidate.chunkContent, excerptBudget);
  if (excerpt === "") {
    return null;
  }
  const memory = withoutEmbedding(
    candidate,
    excerpt,
    excerpt !== candidate.chunkContent,
    relevance
  );
  const estimatedTokens = estimateTokens(renderContextEntry(memory));
  return estimatedTokens <= tokenBudget ? { memory, estimatedTokens } : null;
}

function truncateToTokenBudget(content: string, tokenBudget: number): string {
  if (estimateTokens(content) <= tokenBudget) {
    return content;
  }
  const codePoints = [...content];
  let lower = 0;
  let upper = codePoints.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    const candidate = codePoints.slice(0, midpoint).join("");
    if (estimateTokens(candidate) <= tokenBudget) {
      lower = midpoint;
    } else {
      upper = midpoint - 1;
    }
  }
  return codePoints.slice(0, lower).join("");
}

function estimateTokens(content: string): number {
  let estimatedTokens = 0;
  let asciiRunLength = 0;
  for (const codePoint of content) {
    const value = codePoint.codePointAt(0);
    if (value !== undefined && value <= 0x7f) {
      asciiRunLength += 1;
      continue;
    }
    estimatedTokens += Math.ceil(asciiRunLength / 4) + utf8ByteLength(value);
    asciiRunLength = 0;
  }
  return Math.max(1, estimatedTokens + Math.ceil(asciiRunLength / 4));
}

function utf8ByteLength(codePoint: number | undefined): number {
  if (codePoint === undefined) {
    return 0;
  }
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  if (codePoint <= 0xffff) {
    return 3;
  }
  return 4;
}

function normalizeResultLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_RESULT_LIMIT;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("limit must be a positive integer.");
  }
  return Math.min(value, MAX_RESULT_LIMIT);
}

function normalizeTokenBudget(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CONTEXT_TOKENS;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("maximumContextTokens must be a positive integer.");
  }
  return Math.min(value, MAX_CONTEXT_TOKENS);
}

function normalizeMinimumRelevance(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MINIMUM_RELEVANCE;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new TypeError("minimumRelevance must be between 0 and 1.");
  }
  return normalized;
}

function requireIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 512) {
    throw new TypeError(`${name} must be a non-empty identifier.`);
  }
  return normalized;
}

function requireSnapshotVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("snapshotVersion must be a nonnegative integer.");
  }
  return value;
}

function candidateIdentity(candidate: {
  projectId: string;
  memoryId: string;
  revisionId: string;
  chunkId: string;
}): string {
  return `${candidate.projectId}\u0000${candidate.memoryId}\u0000${candidate.revisionId}\u0000${candidate.chunkId}`;
}

function withoutEmbedding(
  candidate: ValidatedSearchCandidate,
  excerpt: string,
  excerptTruncated: boolean,
  relevance: number
): SearchResultMemory {
  const {
    embedding: _embedding,
    chunkContent: _chunkContent,
    ...publicCandidate
  } = candidate;
  return { ...publicCandidate, excerpt, excerptTruncated, relevance };
}
