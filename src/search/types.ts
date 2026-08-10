import type {
  MemoryClass,
  MemoryKind,
  MemoryScope,
  MemoryStatus
} from "../contracts/taxonomy";

declare const INDEX_GENERATION_BRAND: unique symbol;

export type IndexGeneration = string & {
  readonly [INDEX_GENERATION_BRAND]: true;
};

export interface IndexGenerationMetadata {
  id: IndexGeneration;
  embeddingModel: string;
  embeddingDimensions: number;
  distanceMetric: "cosine";
  instructionVersion: string;
  chunkSchemaVersion: string;
  rerankerModel: string;
}

export interface SearchScopeFilter {
  type: MemoryScope;
  ids: readonly string[];
}

export interface HardFilterInput {
  projectId: string;
  /** Undefined means project-wide access; an empty list permits project memory only. */
  authorizedRepositoryIds?: readonly string[] | undefined;
  statuses?: readonly MemoryStatus[] | undefined;
  kinds?: readonly MemoryKind[] | undefined;
  memoryClasses?: readonly MemoryClass[] | undefined;
  scope?: SearchScopeFilter | undefined;
  validAt?: string | undefined;
  indexGeneration?: string | IndexGeneration | undefined;
}

export interface HardFilterPlan {
  projectId: string;
  authorizedRepositoryIds?: string[];
  statuses: MemoryStatus[];
  kinds?: MemoryKind[];
  memoryClasses?: MemoryClass[];
  scope?: {
    type: MemoryScope;
    ids: string[];
  };
  validAt: string;
  currentHeadsOnly: true;
  excludeExpired: true;
  indexGeneration: IndexGeneration;
}

export type ExactReferenceType = "memory_id" | "path" | "sha" | "symbol";

export interface ExactReference {
  type: ExactReferenceType;
  value: string;
}

export type RecallChannel = "exact" | "lexical" | "semantic";

export interface RecallHit {
  projectId: string;
  memoryId: string;
  revisionId: string;
  chunkId: string;
  indexGeneration: IndexGeneration;
  sourceScore?: number;
  channel?: RecallChannel;
}

export interface RecallInput {
  query: string;
  lexicalQuery: string | null;
  exactReferences: ExactReference[];
  filters: HardFilterPlan;
  limit: number;
}

export interface RecallProvider {
  recall(input: RecallInput): Promise<RecallHit[]>;
}

export interface RecallSet {
  channel: RecallChannel;
  weight: number;
  hits: readonly RecallHit[];
}

export interface FusedRecallHit extends RecallHit {
  retrievalScore: number;
  channels: RecallChannel[];
}

export interface ValidatedSearchCandidate {
  projectId: string;
  memoryId: string;
  revisionId: string;
  memoryVersion: number;
  chunkId: string;
  /** The exact chunk recomputed from the authoritative current revision. */
  chunkContent: string;
  /** SHA-256 of the complete authoritative revision, not the chunk or excerpt. */
  contentSha256: string;
  kind: MemoryKind;
  memoryClass: MemoryClass;
  scope: MemoryScope;
  scopeId: string;
  status: MemoryStatus;
  validFrom: string | null;
  validUntil: string | null;
  evidenceIds: string[];
  retrievalScore: number;
  embedding?: number[];
  indexGeneration: IndexGeneration;
}

export interface HeadValidationInput {
  projectId: string;
  principalId: string;
  snapshotVersion: number;
  filters: HardFilterPlan;
  candidates: FusedRecallHit[];
}

export interface CurrentHeadValidator {
  validate(input: HeadValidationInput): Promise<ValidatedSearchCandidate[]>;
}

export interface RerankInput {
  query: string;
  candidates: ValidatedSearchCandidate[];
}

export interface RerankedCandidate {
  candidate: ValidatedSearchCandidate;
  relevance: number;
}

export interface Reranker {
  rerank(input: RerankInput): Promise<RerankedCandidate[]>;
}

export interface SearchPipelineInput extends HardFilterInput {
  principalId: string;
  snapshotVersion: number;
  query: string;
  indexGeneration: IndexGeneration;
  limit?: number;
  minimumRelevance?: number;
  maximumContextTokens?: number;
  now?: string;
}

export type SearchResultMemory = Omit<
  ValidatedSearchCandidate,
  "embedding" | "chunkContent"
> & {
  /** An authoritative chunk excerpt sized for this response's context budget. */
  excerpt: string;
  /** True when the authoritative chunk was shortened to fit the context budget. */
  excerptTruncated: boolean;
  relevance: number;
};

export type AbstentionReason =
  | "NO_RECALL"
  | "NO_CURRENT_HEAD_MATCH"
  | "NO_EVIDENCE_BACKED_MATCH"
  | "LOW_RELEVANCE"
  | "CONTEXT_BUDGET_EXCEEDED";

export interface SearchPipelineResult {
  snapshotVersion: number;
  indexGeneration: IndexGeneration;
  abstained: boolean;
  abstentionReason: AbstentionReason | null;
  memories: SearchResultMemory[];
  contextPack: string;
}
