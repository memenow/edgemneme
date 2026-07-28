import {
  MEMORY_CLASSES,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  type MemoryClass,
  type MemoryKind,
  type MemoryStatus
} from "../contracts/taxonomy";
import { sha256 } from "../security/crypto";
import {
  buildProjectionHeadObject,
  buildProjectionObject,
  canonicalMemoryUri,
  normalizeEvidenceIds,
  pathSegment,
  projectionPrefix,
  revisionMemoryUri,
  validateProjectionMemory,
  type ProjectionMemory,
  type ProjectionMemoryWrite,
  type ProjectionWrite
} from "./markdown";
import type {
  ProjectionSnapshotInput,
  ProjectionSnapshotWritePlan
} from "./types";

interface ProjectionIndexEntry {
  memory_id: string;
  revision_id: string;
  memory_version: number;
  kind: MemoryKind;
  memory_class: MemoryClass;
  scope: ProjectionMemory["scope"];
  scope_id: string;
  status: MemoryStatus;
  valid_from: string | null;
  valid_until: string | null;
  canonical_uri: string;
  revision_uri: string;
  object_key: string;
  revision_key: string;
  content_sha256: string;
  object_sha256: string;
  revision_sha256: string;
}

interface ProjectionRevisionEntry {
  memory_id: string;
  revision_id: string;
  memory_version: number;
  valid_from: string | null;
  valid_until: string | null;
  revision_uri: string;
  revision_key: string;
  content_sha256: string;
  revision_sha256: string;
}

interface ManifestFile {
  key: string;
  sha256: string;
  content_type: ProjectionWrite["contentType"];
  bytes: number;
}

export async function buildProjectionSnapshotPlan(
  input: ProjectionSnapshotInput
): Promise<ProjectionSnapshotWritePlan> {
  validateSnapshotInput(input);
  const prefix = projectionPrefix(input.projectId, input.snapshotId);
  const sortedHeads = [...input.heads].sort(compareMemoryHeads);
  const sortedRevisions = [...input.revisions].sort(compareMemoryRevisions);
  const revisionWrites = await Promise.all(sortedRevisions.map(buildProjectionObject));
  const headWrites = await Promise.all(sortedHeads.map(buildProjectionHeadObject));
  const revisionWriteById = new Map(
    sortedRevisions.map((revision, index) => [
      revision.revisionId,
      requiredAt(revisionWrites, index, "revision write")
    ])
  );
  const headWriteByMemoryId = new Map(
    sortedHeads.map((head, index) => [
      head.memoryId,
      requiredAt(headWrites, index, "head write")
    ])
  );
  const indexEntries = sortedHeads.map((head) =>
    buildIndexEntry(
      head,
      requiredMapValue(headWriteByMemoryId, head.memoryId, "head write"),
      requiredMapValue(revisionWriteById, head.revisionId, "revision write")
    )
  );
  const revisionEntries = sortedRevisions.map((revision) =>
    buildRevisionEntry(
      revision,
      requiredMapValue(revisionWriteById, revision.revisionId, "revision write")
    )
  );
  const writes: ProjectionWrite[] = [...headWrites, ...revisionWrites];

  writes.push(
    await buildTextWrite(
      `${prefix}README.md`,
      buildReadme(input, indexEntries, revisionEntries),
      "text/markdown; charset=utf-8"
    )
  );
  await appendTaxonomyIndexes(writes, prefix, input, sortedHeads, indexEntries);
  await appendScopeIndexes(writes, prefix, input, sortedHeads, indexEntries);

  writes.sort(compareWrites);
  assertUniqueWriteKeys(writes);
  const manifestBody = stableJson({
    schema_version: 1,
    project_id: input.projectId,
    project_version: input.projectVersion,
    snapshot_id: input.snapshotId,
    memories: indexEntries,
    revisions: revisionEntries,
    files: writes.map(toManifestFile)
  });
  const manifest = await buildTextWrite(
    `${prefix}manifest.json`,
    manifestBody,
    "application/json"
  );
  writes.push(manifest);
  writes.sort(compareWrites);

  return {
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    snapshotId: input.snapshotId,
    prefix,
    manifestKey: manifest.key,
    manifestSha256: manifest.sha256,
    writes
  };
}

function validateSnapshotInput(input: ProjectionSnapshotInput): void {
  projectionPrefix(input.projectId, input.snapshotId);
  if (!Number.isSafeInteger(input.projectVersion) || input.projectVersion < 0) {
    throw new Error("Project version must be a nonnegative safe integer.");
  }
  const headByMemoryId = new Map<string, ProjectionMemory>();
  for (const head of input.heads) {
    validateMemoryForSnapshot(input, head);
    if (headByMemoryId.has(head.memoryId)) {
      throw new Error(`Duplicate head memory ID: ${head.memoryId}`);
    }
    headByMemoryId.set(head.memoryId, head);
  }
  const revisionById = new Map<string, ProjectionMemory>();
  const revisionVersionKeys = new Set<string>();
  for (const revision of input.revisions) {
    validateMemoryForSnapshot(input, revision);
    if (revisionById.has(revision.revisionId)) {
      throw new Error(`Duplicate revision ID: ${revision.revisionId}`);
    }
    const versionKey = `${revision.memoryId}\0${revision.memoryVersion}`;
    if (revisionVersionKeys.has(versionKey)) {
      throw new Error(
        `Duplicate memory revision version: ${revision.memoryId}:${revision.memoryVersion}`
      );
    }
    const head = headByMemoryId.get(revision.memoryId);
    if (head === undefined) {
      throw new Error(`Revision has no canonical head: ${revision.revisionId}`);
    }
    if (revision.memoryVersion > head.memoryVersion) {
      throw new Error(`Revision is newer than its canonical head: ${revision.revisionId}`);
    }
    revisionById.set(revision.revisionId, revision);
    revisionVersionKeys.add(versionKey);
  }
  for (const head of input.heads) {
    const matchingRevision = revisionById.get(head.revisionId);
    if (matchingRevision === undefined) {
      throw new Error(`Head revision is missing from revisions: ${head.revisionId}`);
    }
    if (!sameProjectionMemory(head, matchingRevision)) {
      throw new Error(`Head and revision metadata differ: ${head.revisionId}`);
    }
  }
}

function validateMemoryForSnapshot(
  input: ProjectionSnapshotInput,
  memory: ProjectionMemory
): void {
  validateProjectionMemory(memory);
  if (
    memory.projectId !== input.projectId ||
    memory.projectVersion !== input.projectVersion ||
    memory.snapshotId !== input.snapshotId
  ) {
    throw new Error(`Projection memory is outside the requested snapshot: ${memory.revisionId}`);
  }
}

async function appendTaxonomyIndexes(
  writes: ProjectionWrite[],
  prefix: string,
  input: ProjectionSnapshotInput,
  sortedHeads: readonly ProjectionMemory[],
  entries: readonly ProjectionIndexEntry[]
): Promise<void> {
  for (const kind of MEMORY_KINDS) {
    await appendDualIndex(
      writes,
      prefix,
      input,
      "kind",
      kind,
      entriesForKind(entries, sortedHeads, kind)
    );
  }
  for (const memoryClass of MEMORY_CLASSES) {
    await appendDualIndex(
      writes,
      prefix,
      input,
      "class",
      memoryClass,
      entriesForClass(entries, sortedHeads, memoryClass)
    );
  }
  for (const status of MEMORY_STATUSES) {
    const statusEntries = sortedHeads
      .map((head, index) => ({ head, entry: requiredAt(entries, index, "index entry") }))
      .filter(({ head }) => head.status === status)
      .map(({ entry }) => entry);
    writes.push(
      await buildJsonIndexWrite(
        `${prefix}indexes/by-status/${pathSegment(status)}/index.json`,
        input,
        "status",
        status,
        statusEntries
      )
    );
  }
}

async function appendScopeIndexes(
  writes: ProjectionWrite[],
  prefix: string,
  input: ProjectionSnapshotInput,
  sortedHeads: readonly ProjectionMemory[],
  entries: readonly ProjectionIndexEntry[]
): Promise<void> {
  const scopeIds = [...new Set(sortedHeads.map((head) => head.scopeId))].sort(compareText);
  for (const scopeId of scopeIds) {
    const scopeEntries = sortedHeads
      .map((head, index) => ({ head, entry: requiredAt(entries, index, "index entry") }))
      .filter(({ head }) => head.scopeId === scopeId)
      .map(({ entry }) => entry);
    writes.push(
      await buildJsonIndexWrite(
        `${prefix}indexes/by-scope/${pathSegment(scopeId)}/index.json`,
        input,
        "scope",
        scopeId,
        scopeEntries
      )
    );
  }
}

function entriesForKind(
  entries: readonly ProjectionIndexEntry[],
  sortedHeads: readonly ProjectionMemory[],
  kind: MemoryKind
): ProjectionIndexEntry[] {
  return sortedHeads
    .map((head, index) => ({ head, entry: requiredAt(entries, index, "index entry") }))
    .filter(({ head }) => head.kind === kind)
    .map(({ entry }) => entry);
}

function entriesForClass(
  entries: readonly ProjectionIndexEntry[],
  sortedHeads: readonly ProjectionMemory[],
  memoryClass: MemoryClass
): ProjectionIndexEntry[] {
  return sortedHeads
    .map((head, index) => ({ head, entry: requiredAt(entries, index, "index entry") }))
    .filter(({ head }) => head.memoryClass === memoryClass)
    .map(({ entry }) => entry);
}

async function appendDualIndex(
  writes: ProjectionWrite[],
  prefix: string,
  input: ProjectionSnapshotInput,
  dimension: "kind" | "class",
  value: string,
  entries: readonly ProjectionIndexEntry[]
): Promise<void> {
  const indexPrefix = `${prefix}indexes/by-${dimension}/${pathSegment(value)}/index`;
  writes.push(
    await buildJsonIndexWrite(`${indexPrefix}.json`, input, dimension, value, entries),
    await buildTextWrite(
      `${indexPrefix}.md`,
      buildMarkdownIndex(input, dimension, value, entries),
      "text/markdown; charset=utf-8"
    )
  );
}

async function buildJsonIndexWrite(
  key: string,
  input: ProjectionSnapshotInput,
  dimension: "kind" | "class" | "scope" | "status",
  value: string,
  entries: readonly ProjectionIndexEntry[]
): Promise<ProjectionWrite> {
  return buildTextWrite(
    key,
    stableJson({
      schema_version: 1,
      project_id: input.projectId,
      project_version: input.projectVersion,
      snapshot_id: input.snapshotId,
      dimension: { type: dimension, value },
      memories: entries
    }),
    "application/json"
  );
}

function buildMarkdownIndex(
  input: ProjectionSnapshotInput,
  dimension: "kind" | "class",
  value: string,
  entries: readonly ProjectionIndexEntry[]
): string {
  const rows =
    entries.length === 0
      ? ["_No memories._"]
      : [
          "| Memory | Version | Status | Canonical URI |",
          "| --- | ---: | --- | --- |",
          ...entries.map(
            (entry) =>
              `| ${escapeTableCell(entry.memory_id)} | ${entry.memory_version} | ` +
              `${entry.status} | ${entry.canonical_uri} |`
          )
        ];
  return [
    `# Memories by ${dimension}: ${value}`,
    "",
    `Project: \`${input.projectId}\``,
    "",
    `Project version: \`${input.projectVersion}\``,
    "",
    ...rows,
    ""
  ].join("\n");
}

function buildReadme(
  input: ProjectionSnapshotInput,
  memories: readonly ProjectionIndexEntry[],
  revisions: readonly ProjectionRevisionEntry[]
): string {
  const kinds = MEMORY_KINDS.map(
    (kind) => `- [${kind}](indexes/by-kind/${pathSegment(kind)}/index.md)`
  );
  const classes = MEMORY_CLASSES.map(
    (memoryClass) =>
      `- [${memoryClass}](indexes/by-class/${pathSegment(memoryClass)}/index.md)`
  );
  return [
    "# EdgeMneme Projection",
    "",
    `Project: \`${input.projectId}\``,
    "",
    `Project version: \`${input.projectVersion}\``,
    "",
    `Snapshot: \`${input.snapshotId}\``,
    "",
    `Canonical memories: \`${memories.length}\``,
    "",
    `Immutable revisions: \`${revisions.length}\``,
    "",
    "## Kinds",
    "",
    ...kinds,
    "",
    "## Classes",
    "",
    ...classes,
    ""
  ].join("\n");
}

function buildIndexEntry(
  memory: ProjectionMemory,
  headWrite: ProjectionMemoryWrite,
  revisionWrite: ProjectionMemoryWrite
): ProjectionIndexEntry {
  return {
    memory_id: memory.memoryId,
    revision_id: memory.revisionId,
    memory_version: memory.memoryVersion,
    kind: memory.kind,
    memory_class: memory.memoryClass,
    scope: memory.scope,
    scope_id: memory.scopeId,
    status: memory.status,
    valid_from: memory.validFrom,
    valid_until: memory.validUntil,
    canonical_uri: canonicalMemoryUri(memory.projectId, memory.memoryId),
    revision_uri: revisionMemoryUri(
      memory.projectId,
      memory.memoryId,
      memory.memoryVersion
    ),
    object_key: headWrite.key,
    revision_key: revisionWrite.key,
    content_sha256: headWrite.contentSha256,
    object_sha256: headWrite.sha256,
    revision_sha256: revisionWrite.sha256
  };
}

function buildRevisionEntry(
  memory: ProjectionMemory,
  revisionWrite: ProjectionMemoryWrite
): ProjectionRevisionEntry {
  return {
    memory_id: memory.memoryId,
    revision_id: memory.revisionId,
    memory_version: memory.memoryVersion,
    valid_from: memory.validFrom,
    valid_until: memory.validUntil,
    revision_uri: revisionMemoryUri(
      memory.projectId,
      memory.memoryId,
      memory.memoryVersion
    ),
    revision_key: revisionWrite.key,
    content_sha256: revisionWrite.contentSha256,
    revision_sha256: revisionWrite.sha256
  };
}

async function buildTextWrite(
  key: string,
  body: string,
  contentType: ProjectionWrite["contentType"]
): Promise<ProjectionWrite> {
  return { key, body, sha256: await sha256(body), contentType };
}

function toManifestFile(write: ProjectionWrite): ManifestFile {
  return {
    key: write.key,
    sha256: write.sha256,
    content_type: write.contentType,
    bytes: new TextEncoder().encode(write.body).byteLength
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sameProjectionMemory(left: ProjectionMemory, right: ProjectionMemory): boolean {
  return JSON.stringify(normalizedMemory(left)) === JSON.stringify(normalizedMemory(right));
}

function normalizedMemory(memory: ProjectionMemory): ProjectionMemory {
  return { ...memory, evidenceIds: normalizeEvidenceIds(memory.evidenceIds) };
}

function compareMemoryHeads(left: ProjectionMemory, right: ProjectionMemory): number {
  return compareText(left.memoryId, right.memoryId);
}

function compareMemoryRevisions(left: ProjectionMemory, right: ProjectionMemory): number {
  return (
    compareText(left.memoryId, right.memoryId) ||
    left.memoryVersion - right.memoryVersion ||
    compareText(left.revisionId, right.revisionId)
  );
}

function compareWrites(left: ProjectionWrite, right: ProjectionWrite): number {
  return compareText(left.key, right.key);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUniqueWriteKeys(writes: readonly ProjectionWrite[]): void {
  const seen = new Set<string>();
  for (const write of writes) {
    if (seen.has(write.key)) {
      throw new Error(`Duplicate projection write key: ${write.key}`);
    }
    seen.add(write.key);
  }
}

function requiredAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing ${label} at index ${index}.`);
  }
  return value;
}

function requiredMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export { validateProjectionSnapshotPlan } from "./validation";
export type { ProjectionValidationResult } from "./validation";
export type {
  ProjectionSnapshotInput,
  ProjectionSnapshotWritePlan
} from "./types";
