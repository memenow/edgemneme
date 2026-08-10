import { beforeEach, describe, expect, it, vi } from "vitest";

// The operator CLI contract is plain ESM so deployment can run it without a TS runtime.
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as projectionRebuildSupport from "../scripts/projection-rebuild-support.mjs";

const { projectionRebuildDescriptors, projectionRebuildEvent } = projectionRebuildSupport;

const mocks = vi.hoisted(() => ({
  deleteMemorySearchProjection: vi.fn(),
  isProjectWorkAdmitted: vi.fn(),
  publishMemorySearchProjection: vi.fn(),
  publishProjectProjection: vi.fn(),
  readActiveSearchGeneration: vi.fn()
}));

vi.mock("../src/workflows/synthetic-cleanup", () => ({
  isProjectWorkAdmitted: mocks.isProjectWorkAdmitted
}));
vi.mock("../src/search/indexing", () => ({
  deleteMemorySearchProjection: mocks.deleteMemorySearchProjection,
  publishMemorySearchProjection: mocks.publishMemorySearchProjection,
  SEARCH_VECTOR_CLEANUP_HOLDER_TIMEOUT: "15 minutes"
}));
vi.mock("../src/projection/cloudflare", () => ({
  publishProjectProjection: mocks.publishProjectProjection
}));
vi.mock("../src/search/cloudflare", () => ({
  readActiveSearchGeneration: mocks.readActiveSearchGeneration
}));

import {
  PROJECTION_REBUILD_MAX_SNAPSHOT_CONTENT_BYTES,
  PROJECTION_REBUILD_SAFE_SUBREQUEST_LIMIT,
  PROJECTION_REBUILD_STEP_ATTEMPTS,
  PROJECTION_REBUILD_WORKFLOW_SUBREQUEST_LIMIT,
  runProjectionRebuild
} from "../src/projection/rebuild";
import { parseProjectionRebuildDispatch } from "../src/projection/rebuild-dispatch";

const PROJECT_ID = "project-alpha";
const PROJECT_VERSION = 17;
const GENERATION_ID = "generation-alpha";
const MEMORY_ID = "memory-alpha";
const REVISION_ID = "revision-alpha";
const SNAPSHOT_HEADS = [
  {
    memory_id: MEMORY_ID,
    revision_id: REVISION_ID,
    scope: "project",
    scope_id: PROJECT_ID,
    repository_id: null,
    repository_partition: "*"
  },
  {
    memory_id: "memory-beta",
    revision_id: "revision-beta",
    scope: "repository",
    scope_id: "repository-beta",
    repository_id: "repository-beta",
    repository_partition: "repository-beta"
  }
] as const;
const SNAPSHOT_HEAD_DIGEST = projectionRebuildDescriptors({
  project_id: PROJECT_ID,
  project_version: PROJECT_VERSION,
  search_generation_id: GENERATION_ID,
  memory_count: 2,
  revision_count: 2,
  scope_count: 2,
  content_bytes: 2_048,
  memory_heads: SNAPSHOT_HEADS.map((head) => ({
    memory_id: head.memory_id,
    revision_id: head.revision_id,
    repository_partition: head.repository_partition
  })),
  search_heads: []
})[0].headDigest;

describe("fanout projection rebuild Workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteMemorySearchProjection.mockResolvedValue(true);
    mocks.isProjectWorkAdmitted.mockResolvedValue(true);
    mocks.publishProjectProjection.mockResolvedValue({
      status: "activated",
      snapshotId: `${PROJECT_ID}:${PROJECT_VERSION}`
    });
    mocks.publishMemorySearchProjection.mockResolvedValue(true);
    mocks.readActiveSearchGeneration.mockResolvedValue({ id: GENERATION_ID });
  });

  it("uses an explicit paid-plan subrequest budget and total-attempt retry count", () => {
    expect(PROJECTION_REBUILD_STEP_ATTEMPTS).toBe(3);
    expect(PROJECTION_REBUILD_SAFE_SUBREQUEST_LIMIT).toBeLessThan(
      PROJECTION_REBUILD_WORKFLOW_SUBREQUEST_LIMIT
    );
    expect(PROJECTION_REBUILD_WORKFLOW_SUBREQUEST_LIMIT).toBe(50_000);
  });

  it("rebuilds one project snapshot without publishing per-memory search state", async () => {
    const steps = new RetryingWorkflowStep();
    await runProjectionRebuild(
      environment(new ProjectionRebuildMemoryDb()),
      snapshotPayload(2),
      steps as never
    );

    expect(steps.names).toEqual(["rebuild project snapshot"]);
    expect(mocks.publishProjectProjection).toHaveBeenCalledOnce();
    expect(mocks.publishMemorySearchProjection).not.toHaveBeenCalled();
    expect(mocks.deleteMemorySearchProjection).not.toHaveBeenCalled();
  });

  it("runs the exact CLI snapshot event through dispatch and Workflow authority", async () => {
    const [descriptor] = projectionRebuildDescriptors({
      project_id: PROJECT_ID,
      project_version: PROJECT_VERSION,
      search_generation_id: GENERATION_ID,
      memory_count: 2,
      revision_count: 2,
      scope_count: 2,
      content_bytes: 2_048,
      memory_heads: SNAPSHOT_HEADS.map((head) => ({
        memory_id: head.memory_id,
        revision_id: head.revision_id,
        repository_partition: head.repository_partition
      })),
      search_heads: []
    });
    const event = projectionRebuildEvent(descriptor, 0);
    const parsed = await parseProjectionRebuildDispatch({
      event_id: event.eventId,
      project_id: PROJECT_ID,
      project_version: PROJECT_VERSION,
      event_type: "projection.rebuild.requested",
      payload_digest: event.payloadDigest,
      payload_json: JSON.stringify(event.payload)
    }, event.payload);
    expect(parsed).not.toBeNull();

    const steps = new RetryingWorkflowStep();
    await runProjectionRebuild(
      environment(new ProjectionRebuildMemoryDb()),
      {
        projectId: PROJECT_ID,
        projectVersion: parsed!.projectVersion,
        projectionRebuild: parsed!.request
      },
      steps as never
    );
    expect(steps.names).toEqual(["rebuild project snapshot"]);
    expect(mocks.publishProjectProjection).toHaveBeenCalledOnce();
  });

  it("rebuilds one exact search head without republishing the project snapshot", async () => {
    const steps = new RetryingWorkflowStep();
    await runProjectionRebuild(
      environment(new ProjectionRebuildMemoryDb()),
      searchPayload(),
      steps as never
    );

    expect(steps.names).toEqual(["rebuild memory search projection"]);
    expect(steps.options.get("rebuild memory search projection")).toMatchObject({
      timeout: "15 minutes"
    });
    expect(mocks.publishMemorySearchProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        projectVersion: PROJECT_VERSION,
        memoryId: MEMORY_ID
      })
    );
    expect(mocks.publishProjectProjection).not.toHaveBeenCalled();
  });

  it("checks the authoritative repository partition before and after search publication", async () => {
    const repositoryDb = new ProjectionRebuildMemoryDb({
      scope: "repository",
      scopeId: "repository-1",
      repositoryId: "repository-1"
    });
    await expect(
      runProjectionRebuild(
        environment(repositoryDb),
        searchPayload("repository-1"),
        new RetryingWorkflowStep(1) as never
      )
    ).resolves.toBeUndefined();

    await expect(
      runProjectionRebuild(
        environment(repositoryDb),
        searchPayload("repository-wrong"),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/authority changed/iu);

    const driftingDb = new ProjectionRebuildMemoryDb({
      scope: "ref",
      scopeId: "repository:repository-1:ref:refs%2Fheads%2Fmain",
      repositoryId: "repository-1"
    });
    mocks.publishMemorySearchProjection.mockImplementationOnce(async () => {
      driftingDb.repositoryId = "repository-2";
      return true;
    });
    await expect(
      runProjectionRebuild(
        environment(driftingDb),
        searchPayload("repository-1"),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/authority changed/iu);
  });

  it("deletes only an exact orphan search head", async () => {
    const database = new ProjectionRebuildMemoryDb({ currentRevisionId: null });
    const steps = new RetryingWorkflowStep();
    await runProjectionRebuild(
      environment(database),
      deletePayload(),
      steps as never
    );

    expect(mocks.deleteMemorySearchProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: GENERATION_ID,
        projectId: PROJECT_ID,
        memoryId: MEMORY_ID,
        revisionId: REVISION_ID,
        projectVersion: PROJECT_VERSION - 1
      })
    );
    expect(steps.options.get("delete orphan search projection")).toMatchObject({
      timeout: "15 minutes"
    });
    expect(mocks.publishProjectProjection).not.toHaveBeenCalled();
    expect(mocks.publishMemorySearchProjection).not.toHaveBeenCalled();
  });

  it("treats an invalidated D1 head as absent when deleting its old Search projection", async () => {
    const database = new ProjectionRebuildMemoryDb({ memoryStatus: "invalidated" });

    await runProjectionRebuild(
      environment(database),
      deletePayload(),
      new RetryingWorkflowStep() as never
    );

    expect(mocks.deleteMemorySearchProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: GENERATION_ID,
        projectId: PROJECT_ID,
        memoryId: MEMORY_ID,
        revisionId: REVISION_ID,
        projectVersion: PROJECT_VERSION - 1
      })
    );
    expect(mocks.publishMemorySearchProjection).not.toHaveBeenCalled();
  });

  it("fails closed when the exact orphan search head cannot be deleted", async () => {
    mocks.deleteMemorySearchProjection.mockResolvedValue(false);

    await expect(
      runProjectionRebuild(
        environment(new ProjectionRebuildMemoryDb({ currentRevisionId: null })),
        deletePayload(),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/changed before deletion/iu);
  });

  it("retries only the failed head operation", async () => {
    mocks.publishMemorySearchProjection
      .mockRejectedValueOnce(new Error("transient Vectorize failure"))
      .mockResolvedValue(true);
    const steps = new RetryingWorkflowStep();

    await runProjectionRebuild(
      environment(new ProjectionRebuildMemoryDb()),
      searchPayload(),
      steps as never
    );

    expect(mocks.publishMemorySearchProjection).toHaveBeenCalledTimes(2);
    expect(mocks.publishProjectProjection).not.toHaveBeenCalled();
    expect(steps.attempts.get("rebuild memory search projection")).toBe(2);
  });

  it("fails closed when generation or authoritative head drifts", async () => {
    mocks.readActiveSearchGeneration.mockResolvedValueOnce({ id: "generation-next" });
    await expect(
      runProjectionRebuild(
        environment(new ProjectionRebuildMemoryDb()),
        searchPayload(),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/active search generation changed/iu);

    mocks.readActiveSearchGeneration.mockResolvedValue({ id: GENERATION_ID });
    await expect(
      runProjectionRebuild(
        environment(new ProjectionRebuildMemoryDb({ currentRevisionId: "revision-next" })),
        searchPayload(),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/authority changed/iu);
    expect(mocks.publishMemorySearchProjection).not.toHaveBeenCalled();
  });

  it("rejects a same-version snapshot whose exact authoritative head set drifted", async () => {
    const database = new ProjectionRebuildMemoryDb({
      snapshotHeads: [
        { ...SNAPSHOT_HEADS[0] },
        { ...SNAPSHOT_HEADS[1], revision_id: "revision-drifted" }
      ]
    });

    await expect(
      runProjectionRebuild(
        environment(database),
        snapshotPayload(2),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/authority changed/iu);
    expect(mocks.publishProjectProjection).not.toHaveBeenCalled();
  });

  it("does not delete a head when D1 still contains that memory", async () => {
    await expect(
      runProjectionRebuild(
        environment(new ProjectionRebuildMemoryDb()),
        deletePayload(),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/authority changed/iu);
    expect(mocks.deleteMemorySearchProjection).not.toHaveBeenCalled();
  });

  it("does not publish search state when the snapshot cannot activate exactly", async () => {
    mocks.publishProjectProjection.mockResolvedValue({
      status: "stale",
      phase: "activation",
      snapshotId: `${PROJECT_ID}:${PROJECT_VERSION}`,
      expectedProjectVersion: PROJECT_VERSION,
      observedProjectVersion: PROJECT_VERSION + 1,
      writeCount: 1
    });

    await expect(
      runProjectionRebuild(
        environment(new ProjectionRebuildMemoryDb()),
        snapshotPayload(2),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/project version became stale/iu);
    expect(mocks.publishMemorySearchProjection).not.toHaveBeenCalled();
  });

  it("rejects malformed mode-specific requests before side effects", async () => {
    for (const request of [
      { ...snapshotPayload(0), projectId: `${PROJECT_ID}\nother` },
      {
        ...snapshotPayload(0),
        projectionRebuild: { ...snapshotPayload(0).projectionRebuild, headDigest: "bad" }
      },
      {
        ...searchPayload(),
        projectionRebuild: { ...searchPayload().projectionRebuild, revisionId: "" }
      },
      {
        ...deletePayload(),
        projectionRebuild: { ...deletePayload().projectionRebuild, searchProjectVersion: -1 }
      }
    ]) {
      await expect(
        runProjectionRebuild(
          environment(new ProjectionRebuildMemoryDb()),
          request as never,
          new RetryingWorkflowStep() as never
        )
      ).rejects.toThrow(/invalid/iu);
    }
    expect(mocks.publishProjectProjection).not.toHaveBeenCalled();
    expect(mocks.publishMemorySearchProjection).not.toHaveBeenCalled();
    expect(mocks.deleteMemorySearchProjection).not.toHaveBeenCalled();
  });

  it("rejects oversized content and non-current snapshot revision authority", async () => {
    await expect(
      runProjectionRebuild(
        environment(
          new ProjectionRebuildMemoryDb({
            contentBytes: PROJECTION_REBUILD_MAX_SNAPSHOT_CONTENT_BYTES + 1
          })
        ),
        snapshotPayload(2, {
          revisionCount: 2,
          scopeCount: 2,
          contentBytes: PROJECTION_REBUILD_MAX_SNAPSHOT_CONTENT_BYTES + 1
        }),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/content bytes/iu);

    await expect(
      runProjectionRebuild(
        environment(
          new ProjectionRebuildMemoryDb({ revisionCount: 20_000, contentBytes: 0 })
        ),
        snapshotPayload(2),
        new RetryingWorkflowStep(1) as never
      )
    ).rejects.toThrow(/authority changed/iu);
    expect(mocks.publishProjectProjection).not.toHaveBeenCalled();
  });
});

function snapshotPayload(
  memoryCount: number,
  authority: {
    revisionCount?: number;
    scopeCount?: number;
    contentBytes?: number;
  } = {}
) {
  const revisionCount = authority.revisionCount ?? memoryCount;
  return {
    projectId: PROJECT_ID,
    projectVersion: PROJECT_VERSION,
    projectionRebuild: {
      mode: "snapshot" as const,
      searchGenerationId: GENERATION_ID,
      memoryCount,
      revisionCount,
      scopeCount: authority.scopeCount ?? Math.min(memoryCount, 2),
      contentBytes: authority.contentBytes ?? revisionCount * 1_024,
      headDigest: SNAPSHOT_HEAD_DIGEST
    }
  };
}

function searchPayload(repositoryPartition = "*") {
  return {
    projectId: PROJECT_ID,
    projectVersion: PROJECT_VERSION,
    projectionRebuild: {
      mode: "search" as const,
      searchGenerationId: GENERATION_ID,
      memoryId: MEMORY_ID,
      revisionId: REVISION_ID,
      repositoryPartition
    }
  };
}

function deletePayload() {
  return {
    projectId: PROJECT_ID,
    projectVersion: PROJECT_VERSION,
    projectionRebuild: {
      mode: "delete" as const,
      searchGenerationId: GENERATION_ID,
      memoryId: MEMORY_ID,
      revisionId: REVISION_ID,
      searchProjectVersion: PROJECT_VERSION - 1
    }
  };
}

function environment(memoryDb: ProjectionRebuildMemoryDb) {
  return {
    MEMORY_DB: memoryDb as unknown as D1Database,
    SEARCH_DB: {} as D1Database,
    PROJECTIONS: {} as R2Bucket,
    MEMORY_VECTORS: {} as VectorizeIndex,
    AI: {} as Ai
  };
}

class ProjectionRebuildMemoryDb {
  readonly projectVersion: number;
  readonly currentRevisionId: string | null;
  readonly memoryCount: number;
  readonly revisionCount: number;
  readonly scopeCount: number;
  readonly contentBytes: number;
  readonly snapshotHeads: Array<{
    memory_id: string;
    revision_id: string;
    scope: string;
    scope_id: string;
    repository_id: string | null;
  }>;
  repositoryId: string | null;
  scope: string;
  scopeId: string;
  memoryStatus: string;

  constructor(options: {
    projectVersion?: number;
    currentRevisionId?: string | null;
    memoryCount?: number;
    revisionCount?: number;
    scopeCount?: number;
    contentBytes?: number;
    snapshotHeads?: Array<{
      memory_id: string;
      revision_id: string;
      scope: string;
      scope_id: string;
      repository_id: string | null;
    }>;
    repositoryId?: string | null;
    scope?: string;
    scopeId?: string;
    memoryStatus?: string;
  } = {}) {
    this.projectVersion = options.projectVersion ?? PROJECT_VERSION;
    this.currentRevisionId =
      options.currentRevisionId === undefined ? REVISION_ID : options.currentRevisionId;
    this.memoryCount = options.memoryCount ?? 2;
    this.revisionCount = options.revisionCount ?? this.memoryCount;
    this.scopeCount = options.scopeCount ?? Math.min(this.memoryCount, 2);
    this.contentBytes = options.contentBytes ?? this.revisionCount * 1_024;
    this.snapshotHeads = options.snapshotHeads ?? SNAPSHOT_HEADS.map((head) => ({ ...head }));
    this.repositoryId = options.repositoryId ?? null;
    this.scope = options.scope ?? "project";
    this.scopeId = options.scopeId ?? PROJECT_ID;
    this.memoryStatus = options.memoryStatus ?? "active";
  }

  withSession(_constraint: "first-primary") {
    return this;
  }

  prepare(sql: string) {
    const database = this;
    return {
      bind() {
        return this;
      },
      async first() {
        if (sql.includes("AS memory_count")) {
          return {
            project_version: database.projectVersion,
            memory_count: database.memoryCount,
            revision_count: database.revisionCount,
            scope_count: database.scopeCount,
            content_bytes: database.contentBytes
          };
        }
        if (sql.includes("LEFT JOIN memories")) {
          const projectedRevisionId =
            sql.includes("m.status IN ('active', 'contested')") &&
            database.memoryStatus === "invalidated"
              ? null
              : database.currentRevisionId;
          return {
            project_version: database.projectVersion,
            revision_id: projectedRevisionId,
            scope: projectedRevisionId === null ? null : database.scope,
            scope_id: projectedRevisionId === null ? null : database.scopeId,
            repository_id: projectedRevisionId === null ? null : database.repositoryId
          };
        }
        throw new Error(`Unexpected projection rebuild query: ${sql}`);
      },
      async all() {
        if (sql.includes("current_revision_id AS revision_id")) {
          return { results: database.snapshotHeads };
        }
        throw new Error(`Unexpected projection rebuild query: ${sql}`);
      }
    };
  }
}

class RetryingWorkflowStep {
  readonly names: string[] = [];
  readonly attempts = new Map<string, number>();
  readonly options = new Map<string, unknown>();

  constructor(private readonly maximumAttempts = PROJECTION_REBUILD_STEP_ATTEMPTS) {}

  async do(name: string, ...values: unknown[]) {
    if (values.length > 1) {
      this.options.set(name, values[0]);
    }
    const callback = values.at(-1);
    if (typeof callback !== "function") {
      throw new TypeError("The Workflow step callback is missing.");
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      this.names.push(name);
      this.attempts.set(name, attempt);
      try {
        return await callback();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}
