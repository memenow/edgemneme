export const SCOPE_EVIDENCE_AUTHORITIES = [
  "ordinary",
  "trusted_maintainer_project_decision",
  "project_policy"
] as const;

export type ScopeEvidenceAuthority = (typeof SCOPE_EVIDENCE_AUTHORITIES)[number];

export interface TrustedScopeEvidence {
  readonly evidenceId: string;
  readonly repositoryId: string | null;
  readonly sourceType: string;
  readonly ref: string | null;
  readonly authority: ScopeEvidenceAuthority;
}

export type ScopeOptionAuthority =
  | "repository_evidence"
  | "advisory_generalization"
  | "multi_repository_evidence"
  | "trusted_maintainer_project_decision"
  | "project_policy";

export interface ScopeOption {
  readonly optionId: string;
  readonly scope: "project" | "repository";
  readonly scopeId: string;
  readonly evidenceIds: readonly string[];
  readonly authority: ScopeOptionAuthority;
  readonly requiresMaintainerReview: boolean;
}

export interface ModelScopeOption {
  option_id: string;
  scope: "project" | "repository";
  authority: ScopeOptionAuthority;
  requires_maintainer_review: boolean;
  evidence_source_ids: readonly string[];
  selection_guidance: string;
}

export interface ResolvedModelScopeOption {
  optionId: string;
  scope: "project" | "repository";
  scopeId: string;
  evidenceIds: readonly string[];
  authority: ScopeOptionAuthority;
  requiresMaintainerReview: boolean;
}

interface ScopeOptionMetadata {
  evidenceById: ReadonlyMap<string, TrustedScopeEvidence>;
}

const metadataByOption = new WeakMap<ScopeOption, ScopeOptionMetadata>();

export function buildCandidateScopeOptions(input: {
  projectId: string;
  registeredRepositoryIds: readonly string[];
  evidence: readonly TrustedScopeEvidence[];
}): readonly ScopeOption[] {
  requireIdentifier(input.projectId, "Project ID", 512);
  const registeredRepositories = new Set<string>();
  for (const repositoryId of input.registeredRepositoryIds) {
    requireIdentifier(repositoryId, "Repository ID", 512);
    if (registeredRepositories.has(repositoryId)) {
      throw new TypeError("Registered repository IDs must be unique.");
    }
    registeredRepositories.add(repositoryId);
  }

  const evidenceById = validateEvidence(input.evidence, registeredRepositories);
  const trustedEvidence = [...evidenceById.values()];
  const repositoryEvidence = new Map<string, TrustedScopeEvidence[]>();
  for (const item of trustedEvidence) {
    if (item.repositoryId === null) {
      continue;
    }
    const current = repositoryEvidence.get(item.repositoryId) ?? [];
    current.push(item);
    repositoryEvidence.set(item.repositoryId, current);
  }

  const options: ScopeOption[] = [];
  const addOption = (
    scope: ScopeOption["scope"],
    scopeId: string,
    evidence: readonly TrustedScopeEvidence[],
    authority: ScopeOptionAuthority
  ): void => {
    const option = Object.freeze({
      optionId: `scope-option-${crypto.randomUUID()}`,
      scope,
      scopeId,
      evidenceIds: Object.freeze(evidence.map((item) => item.evidenceId)),
      authority,
      requiresMaintainerReview: scope === "project"
    });
    metadataByOption.set(option, { evidenceById });
    options.push(option);
  };

  for (const repositoryId of [...repositoryEvidence.keys()].sort()) {
    const scopedEvidence = repositoryEvidence.get(repositoryId) ?? [];
    addOption("repository", repositoryId, scopedEvidence, "repository_evidence");
    addOption("project", input.projectId, scopedEvidence, "advisory_generalization");
  }

  if (repositoryEvidence.size >= 2) {
    addOption(
      "project",
      input.projectId,
      trustedEvidence.filter((item) => item.repositoryId !== null),
      "multi_repository_evidence"
    );
  }

  for (const authority of [
    "trusted_maintainer_project_decision",
    "project_policy"
  ] as const) {
    const authoritativeEvidence = trustedEvidence.filter((item) => item.authority === authority);
    if (authoritativeEvidence.length > 0) {
      addOption("project", input.projectId, authoritativeEvidence, authority);
    }
  }

  return Object.freeze(options);
}

export function toModelScopeOptions(options: readonly ScopeOption[]): ModelScopeOption[] {
  return options.map((option) => {
    requireServerOption(option);
    return {
      option_id: option.optionId,
      scope: option.scope,
      authority: option.authority,
      requires_maintainer_review: option.requiresMaintainerReview,
      evidence_source_ids: [...option.evidenceIds],
      selection_guidance: selectionGuidance(option)
    };
  });
}

export function resolveModelScopeOption(
  options: readonly ScopeOption[],
  proposal: { optionId: string; evidenceIds: readonly string[] }
): ResolvedModelScopeOption {
  requireIdentifier(proposal.optionId, "Scope option ID", 128);
  if (proposal.evidenceIds.length === 0) {
    throw new TypeError("A scope proposal must cite at least one evidence source.");
  }
  if (proposal.evidenceIds.length > 50) {
    throw new TypeError("A scope proposal may cite at most 50 evidence sources.");
  }
  const citedEvidence = new Set<string>();
  for (const evidenceId of proposal.evidenceIds) {
    requireIdentifier(evidenceId, "Evidence ID", 512);
    if (citedEvidence.has(evidenceId)) {
      throw new TypeError("Cited evidence IDs must be unique.");
    }
    citedEvidence.add(evidenceId);
  }

  const selected = options.find((option) => option.optionId === proposal.optionId);
  if (selected === undefined) {
    throw new TypeError("The scope option was not offered by the server.");
  }
  const metadata = requireServerOption(selected);
  const allowedEvidence = new Set(selected.evidenceIds);
  for (const evidenceId of citedEvidence) {
    if (!allowedEvidence.has(evidenceId)) {
      throw new TypeError("Model evidence must be bound to the selected scope option.");
    }
  }

  if (selected.authority === "multi_repository_evidence") {
    const citedRepositories = new Set(
      [...citedEvidence].flatMap((evidenceId) => {
        const repositoryId = metadata.evidenceById.get(evidenceId)?.repositoryId;
        return repositoryId === null || repositoryId === undefined ? [] : [repositoryId];
      })
    );
    if (citedRepositories.size < 2) {
      throw new TypeError(
        "A multi-repository project proposal must cite at least two registered repositories."
      );
    }
  }

  return {
    optionId: selected.optionId,
    scope: selected.scope,
    scopeId: selected.scopeId,
    evidenceIds: [...proposal.evidenceIds],
    authority: selected.authority,
    requiresMaintainerReview: selected.requiresMaintainerReview
  };
}

function validateEvidence(
  evidence: readonly TrustedScopeEvidence[],
  registeredRepositories: ReadonlySet<string>
): ReadonlyMap<string, TrustedScopeEvidence> {
  const evidenceById = new Map<string, TrustedScopeEvidence>();
  for (const item of evidence) {
    requireIdentifier(item.evidenceId, "Evidence ID", 512);
    requireIdentifier(item.sourceType, "Evidence source type", 128);
    if (!SCOPE_EVIDENCE_AUTHORITIES.includes(item.authority)) {
      throw new TypeError("Evidence authority is unsupported.");
    }
    if (item.repositoryId !== null) {
      requireIdentifier(item.repositoryId, "Repository ID", 512);
      if (!registeredRepositories.has(item.repositoryId)) {
        throw new TypeError("Evidence must belong to a registered repository.");
      }
    }
    if (item.ref !== null) {
      requireIdentifier(item.ref, "Evidence ref", 2048);
      if (item.repositoryId === null) {
        throw new TypeError("Ref evidence must identify its registered repository.");
      }
    }
    if (evidenceById.has(item.evidenceId)) {
      throw new TypeError("Evidence IDs must be unique.");
    }
    evidenceById.set(
      item.evidenceId,
      Object.freeze({
        evidenceId: item.evidenceId,
        repositoryId: item.repositoryId,
        sourceType: item.sourceType,
        ref: item.ref,
        authority: item.authority
      })
    );
  }
  return evidenceById;
}

function requireServerOption(option: ScopeOption): ScopeOptionMetadata {
  const metadata = metadataByOption.get(option);
  if (metadata === undefined) {
    throw new TypeError("Scope options must be generated and offered by the server.");
  }
  return metadata;
}

function selectionGuidance(option: ScopeOption): string {
  if (option.scope === "repository") {
    return "Choose for code facts, paths, symbols, behavior, or rules specific to the evidence repository.";
  }
  if (option.authority === "advisory_generalization") {
    return "Choose only when the claim is repository-independent and explicitly reusable across every repository in the project; formal maintainer review is required.";
  }
  if (option.authority === "multi_repository_evidence") {
    return "Choose only when citations from at least two repositories support the same repository-independent claim; formal maintainer review is required.";
  }
  return "Choose only for an explicitly project-wide decision or policy; formal maintainer review is required.";
}

function requireIdentifier(value: string, label: string, maximumLength: number): void {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} must be nonempty canonical text.`);
  }
}
