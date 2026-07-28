import { describe, expect, it, vi } from "vitest";
import {
  parseProjectionRebuildDispatch,
  PROJECTION_REBUILD_OUTBOX_DISPATCH_LIMIT,
  PROJECTION_REBUILD_WORKFLOW_STARTS_PER_SECOND,
  throttleProjectionWorkflowStart
} from "../src/projection/rebuild-dispatch";
import { sha256 } from "../src/security/crypto";
// The operator CLI contract is plain ESM so deployment can run it without a TS runtime.
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as projectionRebuildSupport from "../scripts/projection-rebuild-support.mjs";

const { projectionRebuildDescriptors, projectionRebuildEvent } = projectionRebuildSupport;

const PROJECT_ID = "project-alpha";
const PROJECT_VERSION = 17;
const GENERATION_ID = "generation-alpha";

describe("projection rebuild dispatch", () => {
  it("validates stable snapshot, search, and delete event identities", async () => {
    const inputs = [
      {
        mode: "snapshot" as const,
        memoryCount: 2,
        revisionCount: 2,
        scopeCount: 2,
        contentBytes: 9,
        headDigest: "a".repeat(64)
      },
      {
        mode: "search" as const,
        memoryId: "memory-alpha",
        revisionId: "revision-alpha",
        repositoryPartition: "*"
      },
      {
        mode: "delete" as const,
        memoryId: "memory-orphan",
        revisionId: "revision-orphan",
        searchProjectVersion: 16
      }
    ];

    for (const input of inputs) {
      const { row, payload } = await rebuildEvent(input, 3);
      await expect(parseProjectionRebuildDispatch(row, payload)).resolves.toMatchObject({
        projectVersion: PROJECT_VERSION,
        request: { ...input, searchGenerationId: GENERATION_ID }
      });
    }
  });

  it("accepts the exact repository-bound search event emitted by the operator CLI", async () => {
    const descriptors = projectionRebuildDescriptors({
      project_id: PROJECT_ID,
      project_version: PROJECT_VERSION,
      search_generation_id: GENERATION_ID,
      memory_count: 1,
      revision_count: 1,
      scope_count: 1,
      content_bytes: 9,
      memory_heads: [{
        memory_id: "memory-alpha",
        revision_id: "revision-alpha",
        repository_partition: "repository-alpha"
      }],
      search_heads: []
    });
    const descriptor = descriptors.find(
      (candidate: { projectionMode: string }) => candidate.projectionMode === "search"
    );
    const event = projectionRebuildEvent(descriptor, 2);
    await expect(parseProjectionRebuildDispatch({
      event_id: event.eventId,
      project_id: PROJECT_ID,
      project_version: PROJECT_VERSION,
      event_type: "projection.rebuild.requested",
      payload_digest: event.payloadDigest,
      payload_json: JSON.stringify(event.payload)
    }, event.payload)).resolves.toEqual({
      projectVersion: PROJECT_VERSION,
      request: {
        mode: "search",
        searchGenerationId: GENERATION_ID,
        memoryId: "memory-alpha",
        revisionId: "revision-alpha",
        repositoryPartition: "repository-alpha"
      }
    });
  });

  it("accepts the exact capacity-bound snapshot event emitted by the operator CLI", async () => {
    const [descriptor] = projectionRebuildDescriptors({
      project_id: PROJECT_ID,
      project_version: PROJECT_VERSION,
      search_generation_id: GENERATION_ID,
      memory_count: 1,
      revision_count: 3,
      scope_count: 1,
      content_bytes: 4_096,
      memory_heads: [{
        memory_id: "memory-alpha",
        revision_id: "revision-alpha",
        repository_partition: "*"
      }],
      search_heads: []
    });
    const event = projectionRebuildEvent(descriptor, 2);

    await expect(parseProjectionRebuildDispatch({
      event_id: event.eventId,
      project_id: PROJECT_ID,
      project_version: PROJECT_VERSION,
      event_type: "projection.rebuild.requested",
      payload_digest: event.payloadDigest,
      payload_json: JSON.stringify(event.payload)
    }, event.payload)).resolves.toEqual({
      projectVersion: PROJECT_VERSION,
      request: {
        mode: "snapshot",
        searchGenerationId: GENERATION_ID,
        memoryCount: 1,
        revisionCount: 3,
        scopeCount: 1,
        contentBytes: 4_096,
        headDigest: descriptor.headDigest
      }
    });
  });

  it("rejects payload, D1 row, digest, and execution identity drift", async () => {
    const valid = await rebuildEvent(
      {
        mode: "search",
        memoryId: "memory-alpha",
        revisionId: "revision-alpha",
        repositoryPartition: "*"
      },
      0
    );
    const invalid = [
      { row: { ...valid.row, project_id: `${PROJECT_ID}\nother` }, payload: valid.payload },
      { row: { ...valid.row, project_version: PROJECT_VERSION + 1 }, payload: valid.payload },
      { row: { ...valid.row, payload_digest: "b".repeat(64) }, payload: valid.payload },
      { row: valid.row, payload: { ...valid.payload, unexpected: true } },
      { row: valid.row, payload: { ...valid.payload, executionOrdinal: 10_000 } },
      { row: valid.row, payload: { ...valid.payload, revisionId: "revision-next" } }
    ];

    for (const value of invalid) {
      await expect(parseProjectionRebuildDispatch(value.row, value.payload)).rejects.toThrow(
        /projection rebuild outbox/iu
      );
    }
  });

  it("leaves ordinary outbox payloads on the existing dispatch path", async () => {
    await expect(
      parseProjectionRebuildDispatch(
        {
          event_id: "audit-alpha",
          project_id: PROJECT_ID,
          project_version: PROJECT_VERSION,
          event_type: "memory.changed",
          payload_digest: "not-a-projection-digest",
          payload_json: "{}"
        },
        {
          type: "memory.changed",
          eventId: "audit-alpha",
          projectId: PROJECT_ID,
          projectVersion: PROJECT_VERSION,
          memoryId: "memory-alpha"
        }
      )
    ).resolves.toBeNull();
  });

  it("bounds dispatcher pages and throttles below the Workflow creation limit", async () => {
    expect(PROJECTION_REBUILD_OUTBOX_DISPATCH_LIMIT).toBe(250);
    expect(PROJECTION_REBUILD_WORKFLOW_STARTS_PER_SECOND).toBeLessThan(100);
    const delay = vi.fn(async () => undefined);
    const now = vi.fn().mockReturnValueOnce(1_500).mockReturnValueOnce(2_000);

    await expect(
      throttleProjectionWorkflowStart(
        1_000,
        PROJECTION_REBUILD_WORKFLOW_STARTS_PER_SECOND,
        { now, delay }
      )
    ).resolves.toEqual({
      workflowWindowStartedAt: 2_000,
      workflowStartsInWindow: 1
    });
    expect(delay).toHaveBeenCalledWith(500);
  });
});

async function rebuildEvent(
  input:
    | {
        mode: "snapshot";
        memoryCount: number;
        revisionCount: number;
        scopeCount: number;
        contentBytes: number;
        headDigest: string;
      }
    | {
        mode: "search";
        memoryId: string;
        revisionId: string;
        repositoryPartition: string;
      }
    | {
        mode: "delete";
        memoryId: string;
        revisionId: string;
        searchProjectVersion: number;
      },
  executionOrdinal: number
) {
  const modeFields =
    input.mode === "snapshot"
      ? [
          input.memoryCount,
          input.revisionCount,
          input.scopeCount,
          input.contentBytes,
          input.headDigest
        ]
      : input.mode === "search"
        ? [input.memoryId, input.revisionId, input.repositoryPartition]
        : [input.memoryId, input.revisionId, input.searchProjectVersion];
  const projectionTargetId = await sha256(
    [
      "edgemneme.projection-rebuild",
      input.mode,
      PROJECT_ID,
      String(PROJECT_VERSION),
      GENERATION_ID,
      ...modeFields.map(String)
    ].join("\n")
  );
  const eventId =
    `projection-rebuild:${input.mode}:` +
    (await sha256(`${projectionTargetId}\n${executionOrdinal}`));
  const payload = {
    type: "projection.rebuild.requested",
    eventId,
    projectId: PROJECT_ID,
    projectVersion: PROJECT_VERSION,
    projectionMode: input.mode,
    searchGenerationId: GENERATION_ID,
    projectionTargetId,
    executionOrdinal,
    ...(input.mode === "snapshot"
      ? {
          memoryCount: input.memoryCount,
          revisionCount: input.revisionCount,
          scopeCount: input.scopeCount,
          contentBytes: input.contentBytes,
          headDigest: input.headDigest
        }
      : input.mode === "search"
        ? {
            memoryId: input.memoryId,
            revisionId: input.revisionId,
            repositoryPartition: input.repositoryPartition
          }
        : {
            memoryId: input.memoryId,
            revisionId: input.revisionId,
            searchProjectVersion: input.searchProjectVersion
          })
  };
  const payloadJson = JSON.stringify(payload);
  return {
    payload,
    row: {
      event_id: eventId,
      project_id: PROJECT_ID,
      project_version: PROJECT_VERSION,
      event_type: "projection.rebuild.requested",
      payload_digest: await sha256(payloadJson),
      payload_json: payloadJson
    }
  };
}
