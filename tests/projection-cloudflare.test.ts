import { describe, expect, it } from "vitest";
import type { MemoryClass, MemoryKind, MemoryScope, MemoryStatus } from "../src/contracts/taxonomy";
import {
  publishProjectProjection,
  type ProjectionBucketLike,
  type ProjectionDatabaseLike,
  type ProjectionPreparedStatementLike
} from "../src/projection/cloudflare";
import { sha256 } from "../src/security/crypto";

type D1Compatible = D1Database extends ProjectionDatabaseLike<D1PreparedStatement> ? true : false;
type R2Compatible = R2Bucket extends ProjectionBucketLike ? true : false;

const D1_COMPATIBLE: D1Compatible = true;
const R2_COMPATIBLE: R2Compatible = true;

describe("Cloudflare projection publisher", () => {
  it("reads current authoritative heads through first-primary and activates the snapshot", async () => {
    expect(D1_COMPATIBLE).toBe(true);
    expect(R2_COMPATIBLE).toBe(true);
    const database = await createDatabase();
    const bucket = new FakeBucket();

    const result = await publishProjectProjection({
      memoryDb: database,
      projections: bucket,
      projectId: "project-1",
      projectVersion: 9,
      now: () => "2026-07-26T00:00:00.000Z"
    });

    expect(result).toEqual({
      status: "activated",
      snapshotId: "project-1:9",
      manifestKey: "projects/project-1/projections/9/manifest.json",
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      writeCount: 32
    });
    expect(database.sessionConstraints).toEqual([
      "first-primary",
      "first-primary",
      "first-primary",
      "first-primary",
      "first-primary"
    ]);
    expect(database.batchCalls).toHaveLength(1);
    expect(database.batchCalls[0]).toHaveLength(4);
    expect(database.batchCalls[0]?.[0]?.query).toContain("INSERT INTO projection_snapshots");
    expect(database.batchCalls[0]?.[2]?.query).toContain("UPDATE projects");
    expect(database.batchCalls[0]?.[2]?.bindings).toEqual([
      "project-1:9",
      "2026-07-26T00:00:00.000Z",
      "project-1",
      9,
      "project-1:9"
    ]);
    expect(bucket.objects.size).toBe(32);
    expect(bucket.objects.has("projects/project-1/projections/9/README.md")).toBe(true);
    expect(bucket.objects.has("projects/project-1/projections/9/objects/8e/memory-1.md")).toBe(
      true
    );
    expect(
      bucket.objects.has(
        "projects/project-1/projections/9/revisions/8e/memory-1/revision-1.md"
      )
    ).toBe(false);
    expect(
      bucket.objects.has(
        "projects/project-1/projections/9/revisions/8e/memory-1/revision-2.md"
      )
    ).toBe(true);
    expect(
      bucket.objects.get(
        "projects/project-1/projections/9/revisions/8e/memory-1/revision-2.md"
      )?.body
    ).toContain('evidence_ids: ["evidence-a", "evidence-b"]');
    if (result.status !== "activated") {
      throw new Error("Synthetic projection was not activated.");
    }
    const manifest = bucket.objects.get(result.manifestKey);
    expect(manifest?.options.httpMetadata.contentType).toBe("application/json");
    expect(manifest?.options.customMetadata).toEqual({
      sha256: result.manifestSha256,
      projectVersion: "9",
      snapshotId: "project-1:9"
    });
    const manifestBody = JSON.parse(manifest?.body ?? "null") as {
      memories: Array<{ valid_from: string | null; valid_until: string | null }>;
      revisions: Array<{
        revision_id: string;
        valid_from: string | null;
        valid_until: string | null;
      }>;
    };
    expect(manifestBody.memories[0]).toMatchObject({
      valid_from: "2026-07-25T00:00:00.000Z",
      valid_until: null
    });
    expect(manifestBody.revisions.map((revision) => revision.revision_id)).toEqual([
      "revision-2"
    ]);
  });

  it("omits an invalidated memory, all of its revisions, and its evidence", async () => {
    const database = await createDatabase();
    const invalidatedContent = "Historical content that must not remain in the current snapshot.";
    database.heads.push({
      memory_id: "memory-invalidated",
      current_revision_id: "revision-invalidated",
      memory_version: 1,
      kind: "fact",
      memory_class: "semantic",
      scope: "project",
      scope_id: "project-1",
      status: "invalidated"
    });
    database.revisions.push({
      memory_id: "memory-invalidated",
      revision_id: "revision-invalidated",
      memory_version: 1,
      content: invalidatedContent,
      content_sha256: await sha256(invalidatedContent),
      valid_from: null,
      valid_until: null,
      kind: "fact",
      memory_class: "semantic",
      scope: "project",
      scope_id: "project-1",
      status: "invalidated"
    });
    database.evidence.push({
      revision_id: "revision-invalidated",
      evidence_id: "evidence-invalidated"
    });
    const bucket = new FakeBucket();

    const result = await publishProjectProjection({
      memoryDb: database,
      projections: bucket,
      projectId: "project-1",
      projectVersion: 9
    });

    expect(result).toMatchObject({ status: "activated", writeCount: 32 });
    expect(database.allQueries).toHaveLength(3);
    expect(database.allQueries.every((query) => query.includes("m.status IN ('active', 'contested')")))
      .toBe(true);
    const published = [...bucket.objects.values()].map((object) => object.body).join("\n");
    expect(published).not.toContain("memory-invalidated");
    expect(published).not.toContain("revision-invalidated");
    expect(published).not.toContain("evidence-invalidated");
    expect(published).not.toContain(invalidatedContent);
  });

  it("reactivates a safely corrected head without republishing unsafe legacy history", async () => {
    const database = await createDatabase();
    const unsafeLegacyContent = "<script>legacy scanner-flagged content</script>";
    database.revisions[0]!.content = unsafeLegacyContent;
    database.revisions[0]!.content_sha256 = await sha256(unsafeLegacyContent);
    const bucket = new FakeBucket();

    const result = await publishProjectProjection({
      memoryDb: database,
      projections: bucket,
      projectId: "project-1",
      projectVersion: 9
    });

    expect(result).toMatchObject({ status: "activated", writeCount: 32 });
    const published = [...bucket.objects.values()].map((object) => object.body).join("\n");
    expect(published).toContain("Use D1 as the only source of truth.");
    expect(published).not.toContain(unsafeLegacyContent);
    expect(published).not.toContain("revision-1");
    expect(published).not.toContain("evidence-old");
  });

  it("returns stale before reading memories when the requested version is already old", async () => {
    const database = await createDatabase({ projectVersionReads: [10] });
    const bucket = new FakeBucket();

    const result = await publishProjectProjection({
      memoryDb: database,
      projections: bucket,
      projectId: "project-1",
      projectVersion: 9
    });

    expect(result).toEqual({
      status: "stale",
      phase: "before-read",
      snapshotId: "project-1:9",
      expectedProjectVersion: 9,
      observedProjectVersion: 10,
      writeCount: 0
    });
    expect(database.allQueries).toEqual([]);
    expect(database.batchCalls).toEqual([]);
    expect(bucket.objects.size).toBe(0);
  });

  it("returns stale without writing when the project changes during authoritative reads", async () => {
    const database = await createDatabase({ projectVersionReads: [9, 10] });
    const bucket = new FakeBucket();

    const result = await publishProjectProjection({
      memoryDb: database,
      projections: bucket,
      projectId: "project-1",
      projectVersion: 9
    });

    expect(result).toEqual({
      status: "stale",
      phase: "after-read",
      snapshotId: "project-1:9",
      expectedProjectVersion: 9,
      observedProjectVersion: 10,
      writeCount: 0
    });
    expect(database.allQueries).toHaveLength(3);
    expect(database.batchCalls).toEqual([]);
    expect(bucket.objects.size).toBe(0);
  });

  it("leaves late immutable R2 objects inactive when the final D1 CAS loses", async () => {
    const database = await createDatabase({ activationChanges: [0, 0, 0, 0] });
    const bucket = new FakeBucket();

    const result = await publishProjectProjection({
      memoryDb: database,
      projections: bucket,
      projectId: "project-1",
      projectVersion: 9
    });

    expect(result).toEqual({
      status: "stale",
      phase: "activation",
      snapshotId: "project-1:9",
      expectedProjectVersion: 9,
      observedProjectVersion: null,
      writeCount: 32
    });
    expect(bucket.objects.size).toBe(32);
    expect(database.batchCalls).toHaveLength(1);
  });

  it("does not activate a partial snapshot when an R2 write fails", async () => {
    const database = await createDatabase();
    const bucket = new FakeBucket(3);

    await expect(
      publishProjectProjection({
        memoryDb: database,
        projections: bucket,
        projectId: "project-1",
        projectVersion: 9
      })
    ).rejects.toThrow("Synthetic R2 failure.");
    expect(bucket.objects.size).toBe(2);
    expect(database.batchCalls).toEqual([]);
  });

  it("reuses byte-identical immutable R2 objects without overwriting them", async () => {
    const database = await createDatabase({ projectVersionReads: [9, 9, 9, 9] });
    const bucket = new FakeBucket();

    await publishProjectProjection({
      memoryDb: database,
      projections: bucket,
      projectId: "project-1",
      projectVersion: 9
    });
    await publishProjectProjection({
      memoryDb: database,
      projections: bucket,
      projectId: "project-1",
      projectVersion: 9
    });

    expect(bucket.objects.size).toBe(32);
    expect(bucket.putCount).toBe(64);
    expect(bucket.headCount).toBe(32);
    expect(database.batchCalls).toHaveLength(2);
  });

  it("fails closed when an immutable R2 key already has different bytes", async () => {
    const database = await createDatabase();
    const bucket = new FakeBucket();
    bucket.seed("projects/project-1/projections/9/README.md", "different", "0".repeat(64));

    await expect(
      publishProjectProjection({
        memoryDb: database,
        projections: bucket,
        projectId: "project-1",
        projectVersion: 9
      })
    ).rejects.toThrow(
      "Immutable R2 projection collision: projects/project-1/projections/9/README.md"
    );
    expect(database.batchCalls).toEqual([]);
  });

  it("rejects a D1 revision whose stored content checksum has drifted", async () => {
    const database = await createDatabase();
    database.revisions[1]!.content_sha256 = "0".repeat(64);
    const bucket = new FakeBucket();

    await expect(
      publishProjectProjection({
        memoryDb: database,
        projections: bucket,
        projectId: "project-1",
        projectVersion: 9
      })
    ).rejects.toThrow("D1 content checksum mismatch: revision-2");
    expect(bucket.objects.size).toBe(0);
    expect(database.batchCalls).toEqual([]);
  });

  it("rejects a head whose authoritative current revision is missing", async () => {
    const missingRevision = await createDatabase();
    missingRevision.heads[0]!.current_revision_id = "missing-revision";
    await expect(
      publishProjectProjection({
        memoryDb: missingRevision,
        projections: new FakeBucket(),
        projectId: "project-1",
        projectVersion: 9
      })
    ).rejects.toThrow("Current revision is missing from project history: missing-revision");
  });

  it.each([
    ["", 9, "Project ID"],
    ["project-1", -1, "Project version"]
  ])("rejects malformed publish coordinates", async (projectId, projectVersion, message) => {
    const database = await createDatabase();
    await expect(
      publishProjectProjection({
        memoryDb: database,
        projections: new FakeBucket(),
        projectId,
        projectVersion
      })
    ).rejects.toThrow(message);
    expect(database.sessionConstraints).toEqual([]);
  });
});

interface HeadRow {
  memory_id: string;
  current_revision_id: string | null;
  memory_version: number;
  kind: MemoryKind;
  memory_class: MemoryClass;
  scope: MemoryScope;
  scope_id: string;
  status: MemoryStatus;
}

interface RevisionRow {
  memory_id: string;
  revision_id: string;
  memory_version: number;
  content: string;
  content_sha256: string;
  valid_from: string | null;
  valid_until: string | null;
  kind: MemoryKind;
  memory_class: MemoryClass;
  scope: MemoryScope;
  scope_id: string;
  status: MemoryStatus;
}

interface EvidenceRow {
  revision_id: string;
  evidence_id: string;
}

class FakeStatement implements ProjectionPreparedStatementLike<FakeStatement> {
  bindings: unknown[] = [];

  constructor(
    readonly database: FakeDatabase,
    readonly query: string
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.bindings = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.database.first(this.query) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.database.all(this.query) as T[] };
  }
}

class FakeDatabase implements ProjectionDatabaseLike<FakeStatement> {
  readonly sessionConstraints: string[] = [];
  readonly allQueries: string[] = [];
  readonly batchCalls: FakeStatement[][] = [];
  private versionReadIndex = 0;

  constructor(
    readonly heads: HeadRow[],
    readonly revisions: RevisionRow[],
    readonly evidence: EvidenceRow[],
    private readonly projectVersionReads: Array<number | null>,
    private readonly activationChanges: number[]
  ) {}

  withSession(constraint: "first-primary"): { prepare(query: string): FakeStatement } {
    this.sessionConstraints.push(constraint);
    return { prepare: (query) => new FakeStatement(this, query) };
  }

  prepare(query: string): FakeStatement {
    return new FakeStatement(this, query);
  }

  async batch(statements: FakeStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.batchCalls.push(statements);
    return this.activationChanges.map((changes) => ({ meta: { changes } }));
  }

  first(query: string): { project_version: number } | null {
    if (!query.includes("SELECT project_version FROM projects")) {
      throw new Error(`Unexpected synthetic first query: ${query}`);
    }
    const version = this.projectVersionReads[this.versionReadIndex++] ?? null;
    return version === null ? null : { project_version: version };
  }

  all(query: string): unknown[] {
    this.allQueries.push(query);
    const currentRevisionIds = new Set(
      this.heads
        .filter(
          (head) =>
            (head.status === "active" || head.status === "contested") &&
            head.current_revision_id !== null
        )
        .map((head) => head.current_revision_id)
    );
    if (query.includes("FROM memories m") && query.includes("current_revision_id")) {
      return this.heads.filter(
        (head) =>
          (head.status === "active" || head.status === "contested") &&
          head.current_revision_id !== null
      );
    }
    if (query.includes("FROM memory_versions v")) {
      return this.revisions.filter(
        (revision) =>
          (revision.status === "active" || revision.status === "contested") &&
          currentRevisionIds.has(revision.revision_id)
      );
    }
    if (query.includes("FROM version_evidence ve")) {
      const projectedRevisionIds = new Set(
        this.revisions
          .filter(
            (revision) =>
              (revision.status === "active" || revision.status === "contested") &&
              currentRevisionIds.has(revision.revision_id)
          )
          .map((revision) => revision.revision_id)
      );
      return this.evidence.filter((evidence) =>
        projectedRevisionIds.has(evidence.revision_id)
      );
    }
    throw new Error(`Unexpected synthetic all query: ${query}`);
  }
}

class FakeBucket implements ProjectionBucketLike {
  readonly objects = new Map<
    string,
    {
      body: string;
      options: {
        httpMetadata: { contentType: string };
        customMetadata: Record<string, string>;
        onlyIf: { etagDoesNotMatch: string };
      };
    }
  >();
  putCount = 0;
  headCount = 0;

  constructor(private readonly failAt?: number) {}

  async put(
    key: string,
    body: string,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
      onlyIf: { etagDoesNotMatch: string };
    }
  ): Promise<unknown> {
    this.putCount += 1;
    if (this.putCount === this.failAt) {
      throw new Error("Synthetic R2 failure.");
    }
    if (options.onlyIf.etagDoesNotMatch === "*" && this.objects.has(key)) {
      return null;
    }
    this.objects.set(key, { body, options });
    return { key };
  }

  async head(key: string): Promise<{ customMetadata?: Record<string, string> } | null> {
    this.headCount += 1;
    const object = this.objects.get(key);
    return object === undefined ? null : { customMetadata: object.options.customMetadata };
  }

  seed(key: string, body: string, checksum: string): void {
    this.objects.set(key, {
      body,
      options: {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        customMetadata: { sha256: checksum },
        onlyIf: { etagDoesNotMatch: "*" }
      }
    });
  }
}

async function createDatabase(options?: {
  projectVersionReads?: Array<number | null>;
  activationChanges?: number[];
}): Promise<FakeDatabase> {
  const firstContent = "Use a durable store.";
  const secondContent = "Use D1 as the only source of truth.";
  return new FakeDatabase(
    [
      {
        memory_id: "memory-1",
        current_revision_id: "revision-2",
        memory_version: 2,
        kind: "decision",
        memory_class: "semantic",
        scope: "project",
        scope_id: "project-1",
        status: "active"
      }
    ],
    [
      {
        memory_id: "memory-1",
        revision_id: "revision-1",
        memory_version: 1,
        content: firstContent,
        content_sha256: await sha256(firstContent),
        valid_from: null,
        valid_until: "2026-07-25T00:00:00.000Z",
        kind: "decision",
        memory_class: "semantic",
        scope: "project",
        scope_id: "project-1",
        status: "active"
      },
      {
        memory_id: "memory-1",
        revision_id: "revision-2",
        memory_version: 2,
        content: secondContent,
        content_sha256: await sha256(secondContent),
        valid_from: "2026-07-25T00:00:00.000Z",
        valid_until: null,
        kind: "decision",
        memory_class: "semantic",
        scope: "project",
        scope_id: "project-1",
        status: "active"
      }
    ],
    [
      { revision_id: "revision-2", evidence_id: "evidence-b" },
      { revision_id: "revision-1", evidence_id: "evidence-old" },
      { revision_id: "revision-2", evidence_id: "evidence-a" }
    ],
    options?.projectVersionReads ?? [9, 9],
    options?.activationChanges ?? [1, 1, 1, 1]
  );
}
