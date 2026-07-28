import type { ExactReference, ExactReferenceType } from "./types";

const MEMORY_URI =
  /memory:\/\/projects\/[^/\s]+\/memories\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})/gu;
const EXPLICIT_ID =
  /\b(?:memory(?:_id)?|id)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{1,255})\b/giu;
const PREFIXED_MEMORY_ID = /\b(?:memory|mem)[_:-][A-Za-z0-9][A-Za-z0-9._:-]{0,255}\b/giu;
const POSIX_PATH =
  /(?:^|[\s("'`])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)(?=$|[\s,;:)'"])/gu;
const COMMIT_SHA = /\b[a-f0-9]{7,64}\b/giu;
const CALLABLE_SYMBOL =
  /\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)\s*\(\)/gu;
const SCOPED_SYMBOL =
  /\b([A-Za-z_$][A-Za-z0-9_$]*(?:::[A-Za-z_$][A-Za-z0-9_$]*)+)\b/gu;

export function detectExactReferences(query: string): ExactReference[] {
  const detected: ExactReference[] = [];
  const seen = new Set<string>();
  addMatches(detected, seen, "memory_id", query, MEMORY_URI, 1);
  addMatches(detected, seen, "memory_id", query, EXPLICIT_ID, 1);
  addMatches(detected, seen, "memory_id", query, PREFIXED_MEMORY_ID);
  addMatches(detected, seen, "path", query, POSIX_PATH, 1);
  addMatches(detected, seen, "sha", query, COMMIT_SHA);
  addMatches(detected, seen, "symbol", query, CALLABLE_SYMBOL, 1);
  addMatches(detected, seen, "symbol", query, SCOPED_SYMBOL, 1);
  return detected;
}

function addMatches(
  output: ExactReference[],
  seen: Set<string>,
  type: ExactReferenceType,
  query: string,
  pattern: RegExp,
  capture = 0
): void {
  pattern.lastIndex = 0;
  for (const match of query.matchAll(pattern)) {
    const value = match[capture];
    if (value === undefined) {
      continue;
    }
    const normalized = normalizeReference(type, value);
    const key = `${type}:${normalized}`;
    if (!seen.has(key)) {
      output.push({ type, value: normalized });
      seen.add(key);
    }
  }
}

function normalizeReference(type: ExactReferenceType, value: string): string {
  if (type === "sha") {
    return value.toLowerCase();
  }
  if (type === "path") {
    return value.normalize("NFKC").replace(/\.+$/u, "");
  }
  return value.normalize("NFKC");
}
