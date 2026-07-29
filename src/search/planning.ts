import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  type MemoryClass,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus
} from "../contracts/taxonomy";
import { asIndexGeneration } from "./ranking";
import { requireVectorizeIndexedString } from "./vector-metadata";
import type {
  HardFilterInput,
  HardFilterPlan,
  ValidatedSearchCandidate
} from "./types";

const MAX_FILTER_VALUES = 50;

export function planHardFilters(input: HardFilterInput): HardFilterPlan {
  const projectId = requireVectorizeIndexedString(
    requireIdentifier(input.projectId, "projectId"),
    "project namespace"
  );
  const authorizedRepositoryIds =
    input.authorizedRepositoryIds === undefined
      ? undefined
      : normalizeAuthorizedRepositoryIds(input.authorizedRepositoryIds);
  const statuses = normalizeEnumValues(
    input.statuses ?? ["active"],
    MEMORY_STATUSES,
    "status"
  );
  const kinds =
    input.kinds === undefined
      ? undefined
      : normalizeEnumValues(input.kinds, MEMORY_KINDS, "kind");
  const memoryClasses =
    input.memoryClasses === undefined
      ? undefined
      : normalizeEnumValues(input.memoryClasses, MEMORY_CLASSES, "memory class");
  const validAt = input.validAt ?? new Date().toISOString();
  if (!isTimestamp(validAt)) {
    throw new TypeError("validAt must be an ISO-8601 timestamp.");
  }
  const scope =
    input.scope === undefined
      ? undefined
      : {
          type: normalizeEnumValue(input.scope.type, MEMORY_SCOPES, "scope"),
          ids: normalizeIdentifiers(input.scope.ids, "scope", false, 2_048)
        };

  return {
    projectId,
    statuses,
    ...(authorizedRepositoryIds === undefined ? {} : { authorizedRepositoryIds }),
    ...(kinds === undefined ? {} : { kinds }),
    ...(memoryClasses === undefined ? {} : { memoryClasses }),
    ...(scope === undefined ? {} : { scope }),
    validAt: new Date(validAt).toISOString(),
    currentHeadsOnly: true,
    excludeExpired: true,
    indexGeneration: asIndexGeneration(
      requireVectorizeIndexedString(
        input.indexGeneration ?? "unconfigured",
        "index generation"
      )
    )
  };
}

export function passesHardFilters(
  candidate: ValidatedSearchCandidate,
  filters: HardFilterPlan
): boolean {
  if (
    candidate.projectId !== filters.projectId ||
    candidate.indexGeneration !== filters.indexGeneration ||
    !filters.statuses.includes(candidate.status)
  ) {
    return false;
  }
  if (filters.kinds !== undefined && !filters.kinds.includes(candidate.kind)) {
    return false;
  }
  if (
    filters.memoryClasses !== undefined &&
    !filters.memoryClasses.includes(candidate.memoryClass)
  ) {
    return false;
  }
  if (
    filters.scope !== undefined &&
    (candidate.scope !== filters.scope.type || !filters.scope.ids.includes(candidate.scopeId))
  ) {
    return false;
  }
  const validAt = Date.parse(filters.validAt);
  if (candidate.validFrom !== null) {
    if (!isTimestamp(candidate.validFrom) || Date.parse(candidate.validFrom) > validAt) {
      return false;
    }
  }
  return (
    candidate.validUntil === null ||
    (isTimestamp(candidate.validUntil) && Date.parse(candidate.validUntil) > validAt)
  );
}

function normalizeIdentifiers(
  values: readonly string[],
  name: string,
  allowEmpty = false,
  maximumIdentifierLength = 512
): string[] {
  const minimum = allowEmpty ? 0 : 1;
  if (values.length < minimum || values.length > MAX_FILTER_VALUES) {
    throw new TypeError(
      `${name} must contain between ${minimum} and ${MAX_FILTER_VALUES} identifiers.`
    );
  }
  return [
    ...new Set(
      values.map((value) =>
        requireIdentifier(value, name, maximumIdentifierLength)
      )
    )
  ].sort();
}

function normalizeAuthorizedRepositoryIds(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) =>
        requireVectorizeIndexedString(
          requireIdentifier(value, "authorized repository"),
          "authorized repository"
        )
      )
    )
  ].sort();
}

function requireIdentifier(
  value: string,
  name: string,
  maximumLength = 512
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new TypeError(`${name} must be a non-empty identifier.`);
  }
  return normalized;
}

function normalizeEnumValues<T extends string>(
  values: readonly T[],
  allowed: readonly T[],
  name: string
): T[] {
  if (values.length === 0 || values.length > MAX_FILTER_VALUES) {
    throw new TypeError(`${name} must contain between 1 and ${MAX_FILTER_VALUES} values.`);
  }
  return [...new Set(values.map((value) => normalizeEnumValue(value, allowed, name)))].sort();
}

function normalizeEnumValue<T extends string>(
  value: T,
  allowed: readonly T[],
  name: string
): T {
  if (!allowed.includes(value)) {
    throw new TypeError(`Unsupported ${name}: ${value}`);
  }
  return value;
}

function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/iu.test(value) && Number.isFinite(Date.parse(value));
}

export type { MemoryClass, MemoryKind, MemoryScope, MemoryStatus };
