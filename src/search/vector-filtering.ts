import {
  deriveVectorScopeKey,
  requireVectorTimestamp
} from "./vector-metadata";
import type { HardFilterPlan } from "./types";

export const MAX_VECTORIZE_FILTER_BYTES = 2_048;

type VectorizeMetadataFilter = NonNullable<VectorizeQueryOptions["filter"]>;

interface StringFilterDimension {
  field: string;
  values: readonly string[];
}

export async function planSemanticVectorFilters(
  filters: HardFilterPlan
): Promise<VectorizeMetadataFilter[]> {
  const validAtEpochMilliseconds = requireVectorTimestamp(filters.validAt, "validAt");
  const base: VectorizeMetadataFilter = {
    model_generation: filters.indexGeneration,
    status: compactStringFilter(filters.statuses),
    ...(filters.kinds === undefined
      ? {}
      : { kind: compactStringFilter(filters.kinds) }),
    ...(filters.memoryClasses === undefined
      ? {}
      : { memory_class: compactStringFilter(filters.memoryClasses) }),
    valid_from_epoch_ms: { $lte: validAtEpochMilliseconds },
    valid_until_epoch_ms: { $gt: validAtEpochMilliseconds }
  };
  const scopeKeys =
    filters.scope === undefined
      ? undefined
      : [
          ...new Set(
            await Promise.all(
              filters.scope.ids.map((scopeId) =>
                deriveVectorScopeKey(filters.scope!.type, scopeId)
              )
            )
          )
        ].sort(compareIdentifiers);
  const scopeDimensions =
    scopeKeys === undefined
      ? []
      : [{ field: "scope_key", values: scopeKeys } satisfies StringFilterDimension];

  if (filters.authorizedRepositoryIds === undefined) {
    return planFilterDimensionProduct(base, scopeDimensions);
  }

  const projectMemoryFilters = planFilterDimensionProduct(
    { ...base, repository_partition: "*" },
    scopeDimensions
  );
  if (filters.authorizedRepositoryIds.length === 0) {
    return projectMemoryFilters;
  }
  const repositoryIds = [...new Set(filters.authorizedRepositoryIds)].sort(
    compareIdentifiers
  );
  return [
    ...projectMemoryFilters,
    ...planFilterDimensionProduct(base, [
      { field: "repository_partition", values: repositoryIds },
      ...scopeDimensions
    ])
  ];
}

export function vectorizeFilterByteLength(filter: VectorizeMetadataFilter): number {
  return new TextEncoder().encode(JSON.stringify(filter)).byteLength;
}

export function vectorMetadataMatchesFilter(
  metadata: Record<string, unknown>,
  filter: VectorizeMetadataFilter
): boolean {
  return Object.entries(filter).every(([field, constraint]) =>
    matchesConstraint(metadata[field], constraint)
  );
}

function planFilterDimensionProduct(
  base: VectorizeMetadataFilter,
  dimensions: readonly StringFilterDimension[]
): VectorizeMetadataFilter[] {
  if (dimensions.length === 0) {
    return [requireVectorizeFilterSize(base)];
  }
  const emptyDimensionFilter: VectorizeMetadataFilter = { ...base };
  for (const dimension of dimensions) {
    if (dimension.values.length === 0) {
      throw new TypeError(`The ${dimension.field} Vectorize filter cannot be empty.`);
    }
    emptyDimensionFilter[dimension.field] = { $in: [] };
  }
  const emptyBytes = vectorizeFilterByteLength(emptyDimensionFilter);
  const availableValueBytes = MAX_VECTORIZE_FILTER_BYTES - 1 - emptyBytes;
  if (availableValueBytes < dimensions.length) {
    throw new TypeError("The semantic Vectorize filter base exceeds the 2048-byte limit.");
  }
  const baseBudget = Math.floor(availableValueBytes / dimensions.length);
  const extraBudget = availableValueBytes % dimensions.length;
  const dimensionBatches = dimensions.map((dimension, index) => ({
    field: dimension.field,
    batches: batchStringValues(
      dimension.values,
      baseBudget + (index < extraBudget ? 1 : 0),
      dimension.field
    )
  }));
  let planned: VectorizeMetadataFilter[] = [{ ...base }];
  for (const dimension of dimensionBatches) {
    planned = planned.flatMap((partial) =>
      dimension.batches.map((batch) => ({
        ...partial,
        [dimension.field]: compactStringFilter(batch)
      }))
    );
  }
  return planned.map(requireVectorizeFilterSize);
}

function batchStringValues(
  values: readonly string[],
  serializedValueBudget: number,
  field: string
): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const value of values) {
    const candidate = [...batch, value];
    if (serializedArrayContribution(candidate) <= serializedValueBudget) {
      batch = candidate;
      continue;
    }
    if (batch.length === 0) {
      throw new TypeError(`A ${field} value exceeds the Vectorize filter limit.`);
    }
    batches.push(batch);
    batch = [value];
    if (serializedArrayContribution(batch) > serializedValueBudget) {
      throw new TypeError(`A ${field} value exceeds the Vectorize filter limit.`);
    }
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

function serializedArrayContribution(values: readonly string[]): number {
  return new TextEncoder().encode(JSON.stringify(values)).byteLength - 2;
}

function compactStringFilter(values: readonly string[]): string | { $in: string[] } {
  if (values.length === 0) {
    throw new TypeError("A Vectorize string filter cannot be empty.");
  }
  return values.length === 1 ? values[0]! : { $in: [...values] };
}

function requireVectorizeFilterSize(
  filter: VectorizeMetadataFilter
): VectorizeMetadataFilter {
  if (vectorizeFilterByteLength(filter) >= MAX_VECTORIZE_FILTER_BYTES) {
    throw new TypeError("A semantic Vectorize filter exceeds the 2048-byte limit.");
  }
  return filter;
}

function matchesConstraint(value: unknown, constraint: unknown): boolean {
  if (
    constraint === null ||
    typeof constraint === "string" ||
    typeof constraint === "number" ||
    typeof constraint === "boolean"
  ) {
    return value === constraint;
  }
  if (typeof constraint !== "object" || Array.isArray(constraint)) {
    return false;
  }
  return Object.entries(constraint).every(([operator, operand]) => {
    if (operator === "$in") {
      return Array.isArray(operand) && operand.includes(value);
    }
    if (operator === "$nin") {
      return Array.isArray(operand) && !operand.includes(value);
    }
    if (operator === "$eq") {
      return value === operand;
    }
    if (operator === "$ne") {
      return value !== operand;
    }
    if (
      (typeof value !== "number" && typeof value !== "string") ||
      typeof operand !== typeof value
    ) {
      return false;
    }
    if (operator === "$lt") {
      return value < operand;
    }
    if (operator === "$lte") {
      return value <= operand;
    }
    if (operator === "$gt") {
      return value > operand;
    }
    if (operator === "$gte") {
      return value >= operand;
    }
    return false;
  });
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
