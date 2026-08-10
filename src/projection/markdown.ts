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
import { sha256 } from "../security/crypto";

export interface ProjectionMemory {
  projectId: string;
  projectVersion: number;
  snapshotId: string;
  memoryId: string;
  revisionId: string;
  memoryVersion: number;
  kind: MemoryKind;
  memoryClass: MemoryClass;
  scope: MemoryScope;
  scopeId: string;
  status: MemoryStatus;
  validFrom: string | null;
  validUntil: string | null;
  evidenceIds: string[];
  content: string;
}

export interface ProjectionWrite {
  key: string;
  body: string;
  sha256: string;
  contentType: "application/json" | "text/markdown; charset=utf-8";
}

export interface ProjectionMemoryWrite extends ProjectionWrite {
  contentSha256: string;
}

const R2_OBJECT_KEY_MAX_UTF8_BYTES = 1_024;

export async function buildProjectionObject(
  memory: ProjectionMemory
): Promise<ProjectionMemoryWrite> {
  return buildMemoryObject(memory, "revision");
}

export async function buildProjectionHeadObject(
  memory: ProjectionMemory
): Promise<ProjectionMemoryWrite> {
  return buildMemoryObject(memory, "head");
}

export function canonicalMemoryUri(projectId: string, memoryId: string): string {
  return `memory://projects/${pathSegment(projectId)}/memories/${pathSegment(memoryId)}`;
}

export function revisionMemoryUri(
  projectId: string,
  memoryId: string,
  memoryVersion: number
): string {
  return `${canonicalMemoryUri(projectId, memoryId)}/versions/${memoryVersion}`;
}

export function projectionPrefix(
  projectId: string,
  snapshotId: string
): string {
  return `projects/${pathSegment(projectId)}/projections/${pathSegment(snapshotId)}/`;
}

export function projectionScopeIndexKey(
  projectId: string,
  snapshotId: string,
  scopeId: string
): string {
  const key =
    `${projectionPrefix(projectId, snapshotId)}indexes/by-scope/` +
    `${pathSegment(scopeId)}/index.json`;
  const keyBytes = new TextEncoder().encode(key).byteLength;
  if (keyBytes > R2_OBJECT_KEY_MAX_UTF8_BYTES) {
    throw new RangeError(
      `Projection scope index key is ${keyBytes} UTF-8 bytes; ` +
        `R2 allows at most ${R2_OBJECT_KEY_MAX_UTF8_BYTES} bytes.`
    );
  }
  return key;
}

export function pathSegment(value: string): string {
  requireNonempty("path segment", value);
  return encodeURIComponent(value).replaceAll(".", "%2E");
}

export function normalizeEvidenceIds(evidenceIds: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const evidenceId of evidenceIds) {
    requireNonempty("evidence ID", evidenceId);
    normalized.add(evidenceId);
  }
  return [...normalized].sort(compareText);
}

export function validateProjectionMemory(memory: ProjectionMemory): void {
  requireNonempty("project ID", memory.projectId);
  requireNonempty("snapshot ID", memory.snapshotId);
  requireNonempty("memory ID", memory.memoryId);
  requireNonempty("revision ID", memory.revisionId);
  requireNonempty("scope ID", memory.scopeId);
  if (memory.validFrom !== null) {
    requireNonempty("valid_from", memory.validFrom);
  }
  if (!Number.isSafeInteger(memory.projectVersion) || memory.projectVersion < 0) {
    throw new Error("Project version must be a nonnegative safe integer.");
  }
  if (!Number.isSafeInteger(memory.memoryVersion) || memory.memoryVersion < 1) {
    throw new Error("Memory version must be a positive safe integer.");
  }
  if (!MEMORY_KINDS.includes(memory.kind)) {
    throw new Error(`Unsupported memory kind: ${String(memory.kind)}`);
  }
  if (!MEMORY_CLASSES.includes(memory.memoryClass)) {
    throw new Error(`Unsupported memory class: ${String(memory.memoryClass)}`);
  }
  if (!MEMORY_SCOPES.includes(memory.scope)) {
    throw new Error(`Unsupported memory scope: ${String(memory.scope)}`);
  }
  if (!MEMORY_STATUSES.includes(memory.status)) {
    throw new Error(`Unsupported memory status: ${String(memory.status)}`);
  }
  if (memory.validUntil !== null) {
    requireNonempty("valid_until", memory.validUntil);
  }
  normalizeEvidenceIds(memory.evidenceIds);
}

async function buildMemoryObject(
  memory: ProjectionMemory,
  objectType: "head" | "revision"
): Promise<ProjectionMemoryWrite> {
  validateProjectionMemory(memory);
  const contentSha256 = await sha256(memory.content);
  const hashPrefix = (await sha256(memory.memoryId)).slice(0, 2);
  const prefix = projectionPrefix(memory.projectId, memory.snapshotId);
  const memoryId = pathSegment(memory.memoryId);
  const key =
    objectType === "head"
      ? `${prefix}objects/${hashPrefix}/${memoryId}.md`
      : `${prefix}revisions/${hashPrefix}/${memoryId}/${pathSegment(memory.revisionId)}.md`;
  const frontmatter = [
    "---",
    `projection_object: ${objectType}`,
    `project_id: ${yaml(memory.projectId)}`,
    `project_version: ${memory.projectVersion}`,
    `memory_id: ${yaml(memory.memoryId)}`,
    `revision_id: ${yaml(memory.revisionId)}`,
    `memory_version: ${memory.memoryVersion}`,
    `canonical_uri: ${yaml(canonicalMemoryUri(memory.projectId, memory.memoryId))}`,
    `revision_uri: ${yaml(
      revisionMemoryUri(memory.projectId, memory.memoryId, memory.memoryVersion)
    )}`,
    `kind: ${memory.kind}`,
    `memory_class: ${memory.memoryClass}`,
    `scope: ${memory.scope}`,
    `scope_id: ${yaml(memory.scopeId)}`,
    `status: ${memory.status}`,
    `valid_from: ${memory.validFrom === null ? "null" : yaml(memory.validFrom)}`,
    `valid_until: ${memory.validUntil === null ? "null" : yaml(memory.validUntil)}`,
    `evidence_ids: [${normalizeEvidenceIds(memory.evidenceIds).map(yaml).join(", ")}]`,
    `sha256: ${contentSha256}`,
    "---"
  ].join("\n");
  const body = `${frontmatter}\n\n${memory.content}\n`;
  return {
    key,
    body,
    sha256: await sha256(body),
    contentSha256,
    contentType: "text/markdown; charset=utf-8"
  };
}

function requireNonempty(label: string, value: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a nonempty string without null bytes.`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function yaml(value: string): string {
  return JSON.stringify(value);
}
