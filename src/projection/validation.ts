import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_STATUSES
} from "../contracts/taxonomy";
import { sha256 } from "../security/crypto";
import {
  pathSegment,
  projectionPrefix,
  type ProjectionWrite
} from "./markdown";
import type { ProjectionSnapshotWritePlan } from "./types";

export interface ProjectionValidationResult {
  valid: boolean;
  errors: string[];
}

interface ManifestFile {
  key: string;
  sha256: string;
  content_type: ProjectionWrite["contentType"];
  bytes: number;
}

export async function validateProjectionSnapshotPlan(
  plan: ProjectionSnapshotWritePlan
): Promise<ProjectionValidationResult> {
  const errors: string[] = [];
  let expectedPrefix: string;
  try {
    expectedPrefix = projectionPrefix(plan.projectId, plan.snapshotId);
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "Invalid projection plan identifiers."]
    };
  }
  if (plan.prefix !== expectedPrefix) {
    errors.push("Projection prefix does not match the plan identifiers.");
  }
  const keys = plan.writes.map((write) => write.key);
  if (!isStrictlySorted(keys)) {
    errors.push("Projection writes are not sorted by key.");
  }
  if (new Set(keys).size !== keys.length) {
    errors.push("Projection write keys are not unique.");
  }
  for (const write of plan.writes) {
    if (!write.key.startsWith(expectedPrefix)) {
      errors.push(`Write is outside the snapshot prefix: ${write.key}`);
    }
    if ((await sha256(write.body)) !== write.sha256) {
      errors.push(`Checksum mismatch: ${write.key}`);
    }
  }
  const expectedManifestKey = `${expectedPrefix}manifest.json`;
  if (plan.manifestKey !== expectedManifestKey) {
    errors.push("Manifest key does not match the snapshot prefix.");
  }
  const manifestWrite = plan.writes.find((write) => write.key === expectedManifestKey);
  if (manifestWrite === undefined) {
    errors.push("Manifest write is missing.");
    return finishValidation(errors);
  }
  if (plan.manifestSha256 !== manifestWrite.sha256) {
    errors.push("Manifest checksum does not match the manifest write.");
  }
  validateManifest(plan, manifestWrite, errors);
  await validateMemoryObjectChecksums(plan.writes, errors);
  return finishValidation(errors);
}

function validateManifest(
  plan: ProjectionSnapshotWritePlan,
  manifestWrite: ProjectionWrite,
  errors: string[]
): void {
  let manifest: {
    schema_version?: unknown;
    project_id?: unknown;
    project_version?: unknown;
    snapshot_id?: unknown;
    memories?: unknown;
    revisions?: unknown;
    files?: unknown;
  };
  try {
    manifest = JSON.parse(manifestWrite.body) as typeof manifest;
  } catch {
    errors.push("Manifest body is not valid JSON.");
    return;
  }
  if (
    manifest.schema_version !== 1 ||
    manifest.project_id !== plan.projectId ||
    manifest.project_version !== plan.projectVersion ||
    manifest.snapshot_id !== plan.snapshotId
  ) {
    errors.push("Manifest identity does not match the projection plan.");
  }
  if (!Array.isArray(manifest.memories) || !Array.isArray(manifest.revisions)) {
    errors.push("Manifest memory and revision lists are invalid.");
  }
  const expectedFiles = plan.writes
    .filter((write) => write.key !== plan.manifestKey)
    .map(toManifestFile);
  if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
    errors.push("Manifest file inventory does not match the write plan.");
  }
  if (!plan.writes.some((write) => write.key === `${plan.prefix}README.md`)) {
    errors.push("Projection README is missing.");
  }
  validateManifestReferences(plan, manifest.memories, manifest.revisions, errors);
  validateRequiredIndexes(plan, manifest.memories, errors);
}

function validateManifestReferences(
  plan: ProjectionSnapshotWritePlan,
  memories: unknown,
  revisions: unknown,
  errors: string[]
): void {
  const keys = new Set(plan.writes.map((write) => write.key));
  for (const entry of Array.isArray(memories) ? memories : []) {
    if (!isRecord(entry)) {
      errors.push("Manifest contains an invalid memory entry.");
      continue;
    }
    if (
      typeof entry.object_key !== "string" ||
      !keys.has(entry.object_key) ||
      typeof entry.revision_key !== "string" ||
      !keys.has(entry.revision_key)
    ) {
      errors.push("Manifest memory entry references a missing object.");
    }
  }
  for (const entry of Array.isArray(revisions) ? revisions : []) {
    if (
      !isRecord(entry) ||
      typeof entry.revision_key !== "string" ||
      !keys.has(entry.revision_key)
    ) {
      errors.push("Manifest revision entry references a missing object.");
    }
  }
}

function validateRequiredIndexes(
  plan: ProjectionSnapshotWritePlan,
  memories: unknown,
  errors: string[]
): void {
  const keys = new Set(plan.writes.map((write) => write.key));
  const requiredKeys = [
    ...MEMORY_KINDS.flatMap((kind) => [
      `${plan.prefix}indexes/by-kind/${pathSegment(kind)}/index.json`,
      `${plan.prefix}indexes/by-kind/${pathSegment(kind)}/index.md`
    ]),
    ...MEMORY_CLASSES.flatMap((memoryClass) => [
      `${plan.prefix}indexes/by-class/${pathSegment(memoryClass)}/index.json`,
      `${plan.prefix}indexes/by-class/${pathSegment(memoryClass)}/index.md`
    ]),
    ...MEMORY_STATUSES.map(
      (status) => `${plan.prefix}indexes/by-status/${pathSegment(status)}/index.json`
    )
  ];
  if (Array.isArray(memories)) {
    const scopeIds = new Set<string>();
    for (const memory of memories) {
      if (isRecord(memory) && typeof memory.scope_id === "string") {
        scopeIds.add(memory.scope_id);
      }
    }
    for (const scopeId of [...scopeIds].sort(compareText)) {
      requiredKeys.push(
        `${plan.prefix}indexes/by-scope/${pathSegment(scopeId)}/index.json`
      );
    }
  }
  for (const key of requiredKeys) {
    if (!keys.has(key)) {
      errors.push(`Required projection index is missing: ${key}`);
    }
  }
}

async function validateMemoryObjectChecksums(
  writes: readonly ProjectionWrite[],
  errors: string[]
): Promise<void> {
  const memoryWrites = writes.filter(
    (write) => write.key.includes("/objects/") || write.key.includes("/revisions/")
  );
  for (const write of memoryWrites) {
    const endOfFrontmatter = write.body.indexOf("\n---\n\n", 4);
    if (!write.body.startsWith("---\n") || endOfFrontmatter === -1 || !write.body.endsWith("\n")) {
      errors.push(`Invalid Markdown envelope: ${write.key}`);
      continue;
    }
    const frontmatter = write.body.slice(4, endOfFrontmatter);
    const checksum = /^sha256: ([a-f0-9]{64})$/mu.exec(frontmatter)?.[1];
    const content = write.body.slice(endOfFrontmatter + 6, -1);
    if (checksum === undefined || (await sha256(content)) !== checksum) {
      errors.push(`Content checksum mismatch: ${write.key}`);
    }
  }
}

function toManifestFile(write: ProjectionWrite): ManifestFile {
  return {
    key: write.key,
    sha256: write.sha256,
    content_type: write.contentType,
    bytes: new TextEncoder().encode(write.body).byteLength
  };
}

function isStrictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || requiredAt(values, index - 1) < value);
}

function requiredAt(values: readonly string[], index: number): string {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing key at index ${index}.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finishValidation(errors: string[]): ProjectionValidationResult {
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}
