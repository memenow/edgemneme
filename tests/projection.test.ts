import { describe, expect, it } from "vitest";
import {
  buildProjectionHeadObject,
  buildProjectionObject,
  type ProjectionMemory
} from "../src/projection/markdown";
import {
  buildProjectionSnapshotPlan,
  validateProjectionSnapshotPlan
} from "../src/projection/snapshot";
import { sha256 } from "../src/security/crypto";

const DECISION: ProjectionMemory = {
  projectId: "project-1",
  projectVersion: 9,
  snapshotId: "snapshot-9",
  memoryId: "memory-1",
  revisionId: "revision-2",
  memoryVersion: 2,
  kind: "decision",
  memoryClass: "semantic",
  scope: "project",
  scopeId: "project-1",
  status: "active",
  validFrom: "2026-07-25T00:00:00.000Z",
  validUntil: null,
  evidenceIds: ["evidence-2", "evidence-1", "evidence-1"],
  content: "Use D1 as the only source of truth."
};

const PROCEDURE: ProjectionMemory = {
  projectId: "project-1",
  projectVersion: 9,
  snapshotId: "snapshot-9",
  memoryId: "memory-2",
  revisionId: "revision-3",
  memoryVersion: 1,
  kind: "procedure",
  memoryClass: "procedural",
  scope: "repository",
  scopeId: "repository/42",
  status: "contested",
  validFrom: "2026-07-24T00:00:00.000Z",
  validUntil: "2026-08-25T00:00:00.000Z",
  evidenceIds: [],
  content: "Run the focused checks before the full suite."
};

const HISTORICAL_DECISION: ProjectionMemory = {
  ...DECISION,
  revisionId: "revision-1",
  memoryVersion: 1,
  status: "superseded",
  validUntil: "2026-07-25T00:00:00.000Z",
  evidenceIds: ["evidence-0"],
  content: "Use a durable store."
};

describe("R2 projection objects", () => {
  it("builds an immutable revision object with canonical URIs and checksums", async () => {
    const object = await buildProjectionObject(DECISION);

    expect(object.key).toBe(
      "projects/project-1/projections/snapshot-9/revisions/8e/memory-1/revision-2.md"
    );
    expect(object.contentSha256).toBe(
      "e77a80c844fff1713e657f3c14b31ad7334abd2efb76f40ea441fe963804a7f7"
    );
    expect(object.sha256).toBe(await sha256(object.body));
    expect(object.body).toContain('canonical_uri: "memory://projects/project-1/memories/memory-1"');
    expect(object.body).toContain(
      'revision_uri: "memory://projects/project-1/memories/memory-1/versions/2"'
    );
    expect(object.body).toContain('evidence_ids: ["evidence-1", "evidence-2"]');
    expect(object.body).toContain(`sha256: ${object.contentSha256}`);
    expect(object.body.endsWith("\n\nUse D1 as the only source of truth.\n")).toBe(true);
  });

  it("builds a canonical head object under the immutable snapshot prefix", async () => {
    const object = await buildProjectionHeadObject(DECISION);

    expect(object.key).toBe(
      "projects/project-1/projections/snapshot-9/objects/8e/memory-1.md"
    );
    expect(object.body).toContain("projection_object: head");
    expect(object.contentSha256).toBe(await sha256(DECISION.content));
  });

  it.each([
    [{ ...DECISION, projectVersion: -1 }, "Project version"],
    [{ ...DECISION, memoryVersion: 0 }, "Memory version"],
    [{ ...DECISION, kind: "unknown" as ProjectionMemory["kind"] }, "kind"],
    [{ ...DECISION, memoryClass: "unknown" as ProjectionMemory["memoryClass"] }, "class"],
    [{ ...DECISION, scope: "unknown" as ProjectionMemory["scope"] }, "scope"],
    [{ ...DECISION, status: "unknown" as ProjectionMemory["status"] }, "status"],
    [{ ...DECISION, scopeId: "" }, "scope ID"],
    [{ ...DECISION, evidenceIds: ["bad\0evidence"] }, "evidence ID"],
    [{ ...DECISION, validFrom: "" }, "valid_from"],
    [{ ...DECISION, validUntil: "" }, "valid_until"]
  ])("rejects malformed projection memory metadata", async (memory, message) => {
    await expect(buildProjectionObject(memory)).rejects.toThrow(message);
  });

  it("serializes an unbounded validity start as YAML null", async () => {
    const object = await buildProjectionObject({
      ...DECISION,
      validFrom: null,
      validUntil: "2026-08-25T00:00:00.000Z"
    });

    expect(object.body).toContain("\nvalid_from: null\n");
    expect(object.body).toContain(
      '\nvalid_until: "2026-08-25T00:00:00.000Z"\n'
    );
  });
});

describe("R2 projection snapshot plan", () => {
  it("builds every required object in deterministic key and index order", async () => {
    const plan = await buildProjectionSnapshotPlan({
      projectId: "project-1",
      projectVersion: 9,
      snapshotId: "snapshot-9",
      heads: [PROCEDURE, DECISION],
      revisions: [PROCEDURE, DECISION, HISTORICAL_DECISION]
    });

    expect(plan.prefix).toBe("projects/project-1/projections/snapshot-9/");
    expect(plan.writes.map((write) => write.key)).toEqual(
      [...plan.writes.map((write) => write.key)].sort()
    );
    expect(plan.writes).toHaveLength(36);
    expect(findWrite(plan, "README.md").body).toContain("Project version: `9`");
    expect(findWrite(plan, "indexes/by-kind/reference/index.json")).toBeDefined();
    expect(findWrite(plan, "indexes/by-class/episodic/index.md")).toBeDefined();
    expect(findWrite(plan, "indexes/by-status/archived/index.json")).toBeDefined();
    expect(
      findWrite(plan, "indexes/by-scope/repository%2F42/index.json")
    ).toBeDefined();

    const decisionIndex = findWrite(plan, "indexes/by-kind/decision/index.json").body;
    expect(JSON.parse(decisionIndex).memories.map((entry: { memory_id: string }) => entry.memory_id))
      .toEqual(["memory-1"]);
    const decisionMarkdown = findWrite(plan, "indexes/by-kind/decision/index.md").body;
    expect(decisionMarkdown).toContain("memory://projects/project-1/memories/memory-1");
    expect(decisionMarkdown).not.toContain(DECISION.content);

    const manifest = JSON.parse(findWrite(plan, "manifest.json").body) as {
      memories: Array<{
        memory_id: string;
        valid_from: string | null;
        valid_until: string | null;
      }>;
      revisions: Array<{
        memory_id: string;
        memory_version: number;
        valid_from: string | null;
        valid_until: string | null;
      }>;
      files: Array<{ key: string }>;
    };
    expect(manifest.memories.map((entry) => entry.memory_id)).toEqual([
      "memory-1",
      "memory-2"
    ]);
    expect(manifest.memories[0]).toMatchObject({
      valid_from: "2026-07-25T00:00:00.000Z",
      valid_until: null
    });
    expect(
      manifest.revisions.map((entry) => `${entry.memory_id}:${entry.memory_version}`)
    ).toEqual(["memory-1:1", "memory-1:2", "memory-2:1"]);
    expect(manifest.revisions[0]).toMatchObject({
      valid_from: "2026-07-25T00:00:00.000Z",
      valid_until: "2026-07-25T00:00:00.000Z"
    });
    expect(manifest.files).toHaveLength(plan.writes.length - 1);
    expect(manifest.files.some((entry) => entry.key.endsWith("/manifest.json"))).toBe(false);

    const reversePlan = await buildProjectionSnapshotPlan({
      projectId: "project-1",
      projectVersion: 9,
      snapshotId: "snapshot-9",
      heads: [DECISION, PROCEDURE],
      revisions: [HISTORICAL_DECISION, DECISION, PROCEDURE]
    });
    expect(reversePlan).toEqual(plan);
    await expect(validateProjectionSnapshotPlan(plan)).resolves.toEqual({
      valid: true,
      errors: []
    });
  });

  it("reports a body checksum mismatch after a write is tampered with", async () => {
    const plan = await buildProjectionSnapshotPlan({
      projectId: "project-1",
      projectVersion: 9,
      snapshotId: "snapshot-9",
      heads: [DECISION],
      revisions: [DECISION]
    });
    const tampered = structuredClone(plan);
    const head = tampered.writes.find((write) => write.key.includes("/objects/"));
    if (head === undefined) {
      throw new Error("Synthetic head fixture is missing.");
    }
    head.body += "tampered";

    const validation = await validateProjectionSnapshotPlan(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(`Checksum mismatch: ${head.key}`);
  });

  it("detects content tampering even when the object checksum is recomputed", async () => {
    const plan = await buildProjectionSnapshotPlan({
      projectId: "project-1",
      projectVersion: 9,
      snapshotId: "snapshot-9",
      heads: [DECISION],
      revisions: [DECISION]
    });
    const tampered = structuredClone(plan);
    const head = tampered.writes.find((write) => write.key.includes("/objects/"));
    if (head === undefined) {
      throw new Error("Synthetic head fixture is missing.");
    }
    head.body = head.body.replace(DECISION.content, "Tampered content.");
    head.sha256 = await sha256(head.body);

    const validation = await validateProjectionSnapshotPlan(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(`Content checksum mismatch: ${head.key}`);
  });

  it("detects a missing required taxonomy index", async () => {
    const plan = await buildProjectionSnapshotPlan({
      projectId: "project-1",
      projectVersion: 9,
      snapshotId: "snapshot-9",
      heads: [DECISION],
      revisions: [DECISION]
    });
    const incomplete = structuredClone(plan);
    const missingKey = `${incomplete.prefix}indexes/by-status/archived/index.json`;
    incomplete.writes = incomplete.writes.filter((write) => write.key !== missingKey);

    const validation = await validateProjectionSnapshotPlan(incomplete);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain(`Required projection index is missing: ${missingKey}`);
  });

  it("rejects duplicate heads and head revisions missing from the revision set", async () => {
    await expect(
      buildProjectionSnapshotPlan({
        projectId: "project-1",
        projectVersion: 9,
        snapshotId: "snapshot-9",
        heads: [DECISION, DECISION],
        revisions: [DECISION]
      })
    ).rejects.toThrow("Duplicate head memory ID: memory-1");

    await expect(
      buildProjectionSnapshotPlan({
        projectId: "project-1",
        projectVersion: 9,
        snapshotId: "snapshot-9",
        heads: [DECISION],
        revisions: [HISTORICAL_DECISION]
      })
    ).rejects.toThrow("Head revision is missing from revisions: revision-2");
  });

  it("rejects inconsistent revision identity, version, and snapshot metadata", async () => {
    await expect(
      buildProjectionSnapshotPlan({
        projectId: "project-1",
        projectVersion: 9,
        snapshotId: "snapshot-9",
        heads: [DECISION],
        revisions: [DECISION, { ...HISTORICAL_DECISION, revisionId: DECISION.revisionId }]
      })
    ).rejects.toThrow("Duplicate revision ID");

    await expect(
      buildProjectionSnapshotPlan({
        projectId: "project-1",
        projectVersion: 9,
        snapshotId: "snapshot-9",
        heads: [DECISION],
        revisions: [
          DECISION,
          { ...HISTORICAL_DECISION, revisionId: "other-revision", memoryVersion: 2 }
        ]
      })
    ).rejects.toThrow("Duplicate memory revision version");

    await expect(
      buildProjectionSnapshotPlan({
        projectId: "project-1",
        projectVersion: 9,
        snapshotId: "snapshot-9",
        heads: [DECISION],
        revisions: [{ ...PROCEDURE, projectId: "project-1" }]
      })
    ).rejects.toThrow("Revision has no canonical head");

    await expect(
      buildProjectionSnapshotPlan({
        projectId: "project-1",
        projectVersion: 9,
        snapshotId: "snapshot-9",
        heads: [HISTORICAL_DECISION],
        revisions: [HISTORICAL_DECISION, DECISION]
      })
    ).rejects.toThrow("Revision is newer than its canonical head");

    await expect(
      buildProjectionSnapshotPlan({
        projectId: "project-1",
        projectVersion: 9,
        snapshotId: "snapshot-9",
        heads: [DECISION],
        revisions: [{ ...DECISION, content: "Different content." }]
      })
    ).rejects.toThrow("Head and revision metadata differ");

    await expect(
      buildProjectionSnapshotPlan({
        projectId: "project-1",
        projectVersion: 9,
        snapshotId: "snapshot-9",
        heads: [{ ...DECISION, snapshotId: "different" }],
        revisions: []
      })
    ).rejects.toThrow("outside the requested snapshot");
  });

  it("reports malformed plan envelopes and manifest references", async () => {
    const original = await buildProjectionSnapshotPlan({
      projectId: "project-1",
      projectVersion: 9,
      snapshotId: "snapshot-9",
      heads: [DECISION],
      revisions: [DECISION]
    });

    const badEnvelope = structuredClone(original);
    const head = badEnvelope.writes.find((write) => write.key.includes("/objects/"));
    if (head === undefined) {
      throw new Error("Synthetic head fixture is missing.");
    }
    head.body = "invalid";
    head.sha256 = await sha256(head.body);
    expect((await validateProjectionSnapshotPlan(badEnvelope)).errors).toContain(
      `Invalid Markdown envelope: ${head.key}`
    );

    const badIdentity = structuredClone(original);
    await mutateManifest(badIdentity, (manifest) => {
      manifest.project_id = "different";
      manifest.memories = [null];
      manifest.revisions = [null];
    });
    const identityErrors = (await validateProjectionSnapshotPlan(badIdentity)).errors;
    expect(identityErrors).toContain("Manifest identity does not match the projection plan.");
    expect(identityErrors).toContain("Manifest contains an invalid memory entry.");
    expect(identityErrors).toContain("Manifest revision entry references a missing object.");

    const missingReferences = structuredClone(original);
    await mutateManifest(missingReferences, (manifest) => {
      const memory = (manifest.memories as Array<Record<string, unknown>>)[0];
      const revision = (manifest.revisions as Array<Record<string, unknown>>)[0];
      if (memory === undefined || revision === undefined) {
        throw new Error("Synthetic manifest fixture is missing.");
      }
      memory.object_key = "missing";
      revision.revision_key = "missing";
    });
    const referenceErrors = (await validateProjectionSnapshotPlan(missingReferences)).errors;
    expect(referenceErrors).toContain("Manifest memory entry references a missing object.");
    expect(referenceErrors).toContain("Manifest revision entry references a missing object.");

    const invalidJson = structuredClone(original);
    const manifestWrite = invalidJson.writes.find(
      (write) => write.key === invalidJson.manifestKey
    );
    if (manifestWrite === undefined) {
      throw new Error("Synthetic manifest fixture is missing.");
    }
    manifestWrite.body = "{";
    manifestWrite.sha256 = await sha256(manifestWrite.body);
    invalidJson.manifestSha256 = manifestWrite.sha256;
    expect((await validateProjectionSnapshotPlan(invalidJson)).errors).toContain(
      "Manifest body is not valid JSON."
    );
  });

  it("reports plan key, ordering, inventory, and checksum metadata corruption", async () => {
    const original = await buildProjectionSnapshotPlan({
      projectId: "project-1",
      projectVersion: 9,
      snapshotId: "snapshot-9",
      heads: [DECISION],
      revisions: [DECISION]
    });
    const corrupted = structuredClone(original);
    corrupted.prefix = "projects/wrong/projections/9/";
    corrupted.manifestKey = `${corrupted.prefix}manifest.json`;
    corrupted.manifestSha256 = "0".repeat(64);
    corrupted.writes.reverse();
    corrupted.writes.push({
      ...corrupted.writes[0]!,
      key: "outside/snapshot.json"
    });

    const errors = (await validateProjectionSnapshotPlan(corrupted)).errors;
    expect(errors).toContain("Projection prefix does not match the plan identifiers.");
    expect(errors).toContain("Projection writes are not sorted by key.");
    expect(errors).toContain("Write is outside the snapshot prefix: outside/snapshot.json");
    expect(errors).toContain("Manifest key does not match the snapshot prefix.");

    const duplicate = structuredClone(original);
    duplicate.writes.push(structuredClone(duplicate.writes[0]!));
    expect((await validateProjectionSnapshotPlan(duplicate)).errors).toContain(
      "Projection write keys are not unique."
    );

    const wrongManifestChecksum = structuredClone(original);
    wrongManifestChecksum.manifestSha256 = "0".repeat(64);
    expect((await validateProjectionSnapshotPlan(wrongManifestChecksum)).errors).toContain(
      "Manifest checksum does not match the manifest write."
    );

    const missingManifest = structuredClone(original);
    missingManifest.writes = missingManifest.writes.filter(
      (write) => write.key !== missingManifest.manifestKey
    );
    expect((await validateProjectionSnapshotPlan(missingManifest)).errors).toContain(
      "Manifest write is missing."
    );

    const missingReadme = structuredClone(original);
    missingReadme.writes = missingReadme.writes.filter(
      (write) => write.key !== `${missingReadme.prefix}README.md`
    );
    const readmeErrors = (await validateProjectionSnapshotPlan(missingReadme)).errors;
    expect(readmeErrors).toContain("Projection README is missing.");
    expect(readmeErrors).toContain("Manifest file inventory does not match the write plan.");
  });

  it("supports an empty project snapshot without inventing scope indexes", async () => {
    const plan = await buildProjectionSnapshotPlan({
      projectId: "empty-project",
      projectVersion: 0,
      snapshotId: "0",
      heads: [],
      revisions: []
    });

    expect(plan.writes.some((write) => write.key.includes("/by-scope/"))).toBe(false);
    expect(JSON.parse(findWrite(plan, "manifest.json").body).memories).toEqual([]);
    await expect(validateProjectionSnapshotPlan(plan)).resolves.toMatchObject({ valid: true });
  });
});

function findWrite(
  plan: { prefix: string; writes: Array<{ key: string; body: string }> },
  suffix: string
): { key: string; body: string } {
  const write = plan.writes.find((candidate) => candidate.key === `${plan.prefix}${suffix}`);
  if (write === undefined) {
    throw new Error(`Synthetic projection write is missing: ${suffix}`);
  }
  return write;
}

async function mutateManifest(
  plan: {
    manifestKey: string;
    manifestSha256: string;
    writes: Array<{ key: string; body: string; sha256: string }>;
  },
  mutate: (manifest: Record<string, unknown>) => void
): Promise<void> {
  const write = plan.writes.find((candidate) => candidate.key === plan.manifestKey);
  if (write === undefined) {
    throw new Error("Synthetic manifest fixture is missing.");
  }
  const manifest = JSON.parse(write.body) as Record<string, unknown>;
  mutate(manifest);
  write.body = `${JSON.stringify(manifest, null, 2)}\n`;
  write.sha256 = await sha256(write.body);
  plan.manifestSha256 = write.sha256;
}
