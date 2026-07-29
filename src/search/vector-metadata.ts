import { MEMORY_SCOPES, type MemoryScope } from "../contracts/taxonomy";
import { sha256 } from "../security/crypto";

export const MAX_VECTORIZE_INDEXED_STRING_BYTES = 64;
export const VECTORIZE_UNBOUNDED_VALID_FROM_EPOCH_MS = Number.MIN_SAFE_INTEGER;
export const VECTORIZE_UNBOUNDED_VALID_UNTIL_EPOCH_MS = Number.MAX_SAFE_INTEGER;
const VECTOR_SCOPE_DOMAIN = "edgemneme.vector.scope";

const encoder = new TextEncoder();

export function requireVectorizeIndexedString(value: string, label: string): string {
  if (encoder.encode(value).byteLength > MAX_VECTORIZE_INDEXED_STRING_BYTES) {
    throw new TypeError(`The ${label} must not exceed 64 UTF-8 bytes.`);
  }
  return value;
}

export async function deriveVectorScopeKey(
  scope: string,
  scopeId: string
): Promise<string> {
  if (!MEMORY_SCOPES.includes(scope as MemoryScope)) {
    throw new TypeError(`Unsupported memory scope: ${scope}`);
  }
  const normalizedScopeId = requireScopeId(scopeId);
  return sha256(JSON.stringify([VECTOR_SCOPE_DOMAIN, scope, normalizedScopeId]));
}

export function vectorizeValidFromEpochMs(value: string | null): number {
  return value === null
    ? VECTORIZE_UNBOUNDED_VALID_FROM_EPOCH_MS
    : requireVectorTimestamp(value, "valid_from");
}

export function vectorizeValidUntilEpochMs(value: string | null): number {
  return value === null
    ? VECTORIZE_UNBOUNDED_VALID_UNTIL_EPOCH_MS
    : requireVectorTimestamp(value, "valid_until");
}

export function requireVectorTimestamp(value: string, label: string): number {
  const epochMilliseconds = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T/iu.test(value) ||
    !Number.isSafeInteger(epochMilliseconds)
  ) {
    throw new TypeError(`The ${label} must be an ISO-8601 timestamp.`);
  }
  return epochMilliseconds;
}

function requireScopeId(value: string): string {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("The memory scope ID is invalid.");
  }
  return value;
}
