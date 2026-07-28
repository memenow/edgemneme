import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// @ts-expect-error The JavaScript runtime helper has no separate declaration file.
import * as syntheticCanarySupport from "../scripts/synthetic-canary-support.mjs";

const {
  assertAiAnalysis,
  assertSyntheticMemoryObjects,
  assertSyntheticVectorProjection,
  decodeSyntheticClientResult,
  decodeD1Rows,
  executeSyntheticCleanup,
  expectedProjectionObjectKeys,
  projectionObjectKeys,
  syntheticAiAnalysisVerificationSql,
  syntheticSearchProjectionVerificationSql,
  validateSyntheticCleanupLedger,
  vectorIdsFromProjectionRows
} = syntheticCanarySupport;

const SEARCH_MIGRATIONS = [
  "migrations/search/0001_fts.sql",
  "migrations/search/0002_activate_qwen_generation.sql",
  "migrations/search/0003_projection_heads.sql",
  "migrations/search/0004_repository_partition.sql",
  "migrations/search/0005_memory_fts_chunk_ledger.sql"
] as const;

describe("synthetic production canary support", () => {
  it("requires a successful structured Workers AI analysis", () => {
    expect(() =>
      assertAiAnalysis([{ ai_verified: 1, diagnostic_code: null }])
    ).not.toThrow();
    expect(() =>
      assertAiAnalysis([
        {
          ai_verified: 0,
          diagnostic_code: "AI_ANALYSIS_DEFERRED_TEMPORAL"
        }
      ])
    ).toThrow("AI_ANALYSIS_DEFERRED_TEMPORAL");
    expect(() =>
      assertAiAnalysis([{ ai_verified: 0, diagnostic_code: "fake-secret" }])
    ).not.toThrow("fake-secret");
    expect(() => assertAiAnalysis([])).toThrow(/Workers AI/iu);
  });

  it("verifies only the candidate ID returned by candidate_submit", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE observations (
        observation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        kind TEXT,
        memory_class TEXT,
        scope TEXT,
        scope_id TEXT,
        analysis_json TEXT
      );
      CREATE TABLE workflow_runs (
        workflow_id TEXT NOT NULL,
        root_workflow_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workflow_type TEXT NOT NULL,
        last_error_code TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO observations VALUES
        ('candidate-target', 'project-1', 'session-1', 'noop', NULL, NULL, NULL, NULL,
         '{"persistent_value":false,"confidence":0.9}'),
        ('candidate-decoy', 'project-1', 'session-2', 'pending_review', 'fact', 'semantic',
         'repository', 'repository-1', '{"persistent_value":true,"confidence":0.99}');
      INSERT INTO workflow_runs VALUES
        ('workflow-target', 'workflow-target', 'project-1', 'candidate.submitted', NULL,
         '2026-07-28T00:00:00.000Z');
    `);

    const rows = database
      .prepare(
        syntheticAiAnalysisVerificationSql(
          "project-1",
          "candidate-target",
          "workflow-target"
        )
      )
      .all();
    expect(rows).toEqual([{ ai_verified: 1, diagnostic_code: null }]);
    expect(() => assertAiAnalysis(rows)).not.toThrow();

    database
      .prepare(
        `UPDATE observations
         SET status = 'pending_review', kind = NULL, memory_class = NULL,
             scope = NULL, scope_id = NULL, analysis_json = NULL
         WHERE observation_id = 'candidate-target'`
      )
      .run();
    database
      .prepare(
        `UPDATE workflow_runs
         SET last_error_code = 'AI_ANALYSIS_DEFERRED_TEMPORAL'
         WHERE workflow_id = 'workflow-target'`
      )
      .run();
    const deferredRows = database
      .prepare(
        syntheticAiAnalysisVerificationSql(
          "project-1",
          "candidate-target",
          "workflow-target"
        )
      )
      .all();
    expect(deferredRows).toEqual([
      {
        ai_verified: 0,
        diagnostic_code: "AI_ANALYSIS_DEFERRED_TEMPORAL"
      }
    ]);
    expect(() => assertAiAnalysis(deferredRows)).toThrow(
      "AI_ANALYSIS_DEFERRED_TEMPORAL"
    );

    database
      .prepare(
        `UPDATE workflow_runs SET last_error_code = 'fake-secret'
         WHERE workflow_id = 'workflow-target'`
      )
      .run();
    const sanitizedRows = database
      .prepare(
        syntheticAiAnalysisVerificationSql(
          "project-1",
          "candidate-target",
          "workflow-target"
        )
      )
      .all();
    expect(sanitizedRows).toEqual([{ ai_verified: 0, diagnostic_code: null }]);
    expect(() => assertAiAnalysis(sanitizedRows)).not.toThrow("fake-secret");

    expect(
      database
        .prepare(
          syntheticAiAnalysisVerificationSql(
            "project-1",
            "candidate-missing",
            "workflow-target"
          )
        )
        .all()
    ).toEqual([]);
  });

  it("accepts only strict UUID candidate and workflow results from the synthetic client", () => {
    const candidateId = "44444444-4444-4444-8444-444444444444";
    const workflowId = "55555555-5555-4555-8555-555555555555";
    expect(
      decodeSyntheticClientResult(
        JSON.stringify({ candidate_id: candidateId, workflow_id: workflowId })
      )
    ).toEqual({ candidateId, workflowId });
    expect(() => decodeSyntheticClientResult("not-json")).toThrow(/client result/iu);
    expect(() =>
      decodeSyntheticClientResult(
        JSON.stringify({ candidate_id: candidateId, workflow_id: "workflow-1" })
      )
    ).toThrow(/client result/iu);
    expect(() =>
      decodeSyntheticClientResult(
        JSON.stringify({
          candidate_id: candidateId,
          workflow_id: workflowId,
          content: "must-not-cross-the-result-boundary"
        })
      )
    ).toThrow(/client result/iu);
  });

  it("decodes only successful Wrangler D1 JSON results", () => {
    expect(
      decodeD1Rows(
        JSON.stringify([
          { success: true, results: [{ value: 1 }] },
          { success: true, results: [{ value: 2 }] }
        ]),
        "query"
      )
    ).toEqual([{ value: 1 }, { value: 2 }]);
    expect(() =>
      decodeD1Rows(JSON.stringify([{ success: false, results: [] }]), "query")
    ).toThrow(/query failed/iu);
  });

  it("derives the exact Vectorize identifiers used by the indexer", () => {
    const rows = [
      {
        generation_id: "generation-2026-07-25",
        revision_id: "revision-1",
        chunk_id: "chunk-0"
      }
    ];
    const expected = createHash("sha256")
      .update("generation-2026-07-25\nproject-1\nrevision-1\nchunk-0")
      .digest("hex");

    expect(vectorIdsFromProjectionRows("project-1", rows)).toEqual([expected]);
    expect(() =>
      vectorIdsFromProjectionRows("project-1", [
        { generation_id: "", revision_id: "revision-1", chunk_id: "chunk-0" }
      ])
    ).toThrow(/projection row/iu);
  });

  it("verifies FTS ownership through the projection head and chunk ledger", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON;");
    for (const migration of SEARCH_MIGRATIONS) {
      database.exec(readFileSync(migration, "utf8"));
    }

    const generationId = "qwen3-embedding-0.6b-chunk-2026-07-25";
    const projectId = "project-1";
    const memoryId = "memory-1";
    const revisionId = "revision-1";
    const chunkId = "chunk-0";
    const vectorId = createHash("sha256")
      .update(`${generationId}\n${projectId}\n${revisionId}\n${chunkId}`)
      .digest("hex");
    database
      .prepare(
        `INSERT INTO memory_search_projection_write_leases
         (generation_id, project_id, memory_id, revision_id, project_version,
          repository_partition, chunk_count)
         VALUES (?, ?, ?, ?, 1, '*', 1)`
      )
      .run(generationId, projectId, memoryId, revisionId);
    database
      .prepare(
        `INSERT INTO memory_projection_heads
         (generation_id, project_id, memory_id, project_version, revision_id,
          repository_partition, chunk_count)
         VALUES (?, ?, ?, 1, ?, '*', 1)`
      )
      .run(generationId, projectId, memoryId, revisionId);
    database
      .prepare(
        `INSERT INTO memory_fts_chunk_ledger
         (generation_id, project_id, memory_id, revision_id, chunk_id, vector_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(generationId, projectId, memoryId, revisionId, chunkId, vectorId);
    const ledger = database
      .prepare(
        `SELECT fts_rowid FROM memory_fts_chunk_ledger
         WHERE generation_id = ? AND project_id = ? AND memory_id = ?
           AND revision_id = ? AND chunk_id = ?`
      )
      .get(generationId, projectId, memoryId, revisionId, chunkId) as {
      fts_rowid: number;
    };
    database
      .prepare(
        `INSERT INTO memory_fts
         (rowid, generation_id, project_id, memory_id, revision_id, chunk_id,
          status, kind, memory_class, scope, scope_id, content)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 'fact', 'semantic', 'project', ?, ?)`
      )
      .run(
        ledger.fts_rowid,
        generationId,
        projectId,
        memoryId,
        revisionId,
        chunkId,
        projectId,
        syntheticCanarySupport.SYNTHETIC_FORMAL_MEMORY_CONTENT
      );

    expect(() =>
      database.prepare("SELECT f.repository_partition FROM memory_fts AS f").all()
    ).toThrow(/repository_partition/iu);

    const rows = database
      .prepare(syntheticSearchProjectionVerificationSql(projectId))
      .all();
    expect(rows).toEqual([
      {
        generation_id: generationId,
        project_id: projectId,
        memory_id: memoryId,
        revision_id: revisionId,
        chunk_id: chunkId,
        status: "active",
        kind: "fact",
        memory_class: "semantic",
        scope: "project",
        scope_id: projectId,
        content: syntheticCanarySupport.SYNTHETIC_FORMAL_MEMORY_CONTENT,
        generation_status: "active",
        repository_partition: "*",
        chunk_count: 1,
        fts_rowid: ledger.fts_rowid,
        ledger_vector_id: vectorId
      }
    ]);
    expect(vectorIdsFromProjectionRows(projectId, rows)).toEqual([vectorId]);
  });

  it("requires the synthetic vector and filter match to retain the project partition", () => {
    const expected = {
      id: "vector-1",
      projectId: "project-1",
      memoryId: "memory-1",
      revisionId: "revision-1",
      chunkId: "chunk-0",
      generationId: "generation-1",
      repositoryPartition: "*"
    };
    const vector = {
      id: "vector-1",
      namespace: "project-1",
      values: Array.from({ length: 1_024 }, () => 0.25),
      metadata: {
        project_id: "project-1",
        memory_id: "memory-1",
        revision_id: "revision-1",
        chunk_id: "chunk-0",
        model_generation: "generation-1",
        status: "active",
        repository_partition: "*"
      }
    };

    expect(() => assertSyntheticVectorProjection(vector, expected)).not.toThrow();
    expect(() =>
      assertSyntheticVectorProjection(
        {
          ...vector,
          metadata: { ...vector.metadata, repository_partition: "repository-1" }
        },
        expected
      )
    ).toThrow(/Vectorize metadata/iu);
    expect(() =>
      assertSyntheticVectorProjection(
        { ...vector, values: undefined },
        expected,
        { requireValues: false }
      )
    ).not.toThrow();
  });

  it("validates checksummed R2 bodies using the serialized frontmatter format", () => {
    const objectBody = `---\nmemory_id: "memory-1"\n---\n\n${syntheticCanarySupport.SYNTHETIC_FORMAL_MEMORY_CONTENT}\n`;
    const revisionBody = `---\nrevision_id: "revision-1"\n---\n\n${syntheticCanarySupport.SYNTHETIC_FORMAL_MEMORY_CONTENT}\n`;
    const memory = {
      memory_id: "memory-1",
      revision_id: "revision-1",
      object_sha256: createHash("sha256").update(objectBody).digest("hex"),
      revision_sha256: createHash("sha256").update(revisionBody).digest("hex")
    };

    expect(() =>
      assertSyntheticMemoryObjects(objectBody, revisionBody, memory)
    ).not.toThrow();
    expect(() =>
      assertSyntheticMemoryObjects(objectBody.replace('"memory-1"', "memory-1"), revisionBody, memory)
    ).toThrow(/R2 memory objects/iu);
  });

  it("limits R2 cleanup to the exact synthetic snapshot prefix", () => {
    const manifestKey = "projects/project-1/projections/1/manifest.json";
    expect(
      projectionObjectKeys(
        "project-1",
        1,
        manifestKey,
        JSON.stringify({
          project_id: "project-1",
          project_version: 1,
          files: [
            {
              key: "projects/project-1/projections/1/README.md",
              sha256: "a".repeat(64)
            }
          ]
        })
      )
    ).toEqual(["projects/project-1/projections/1/README.md", manifestKey]);
    expect(() =>
      projectionObjectKeys(
        "project-1",
        1,
        manifestKey,
        JSON.stringify({
          project_id: "project-1",
          project_version: 1,
          files: [{ key: "projects/other/secret", sha256: "b".repeat(64) }]
        })
      )
    ).toThrow(/snapshot prefix/iu);
  });

  it("derives a complete exact-prefix cleanup plan without a manifest", () => {
    const keys = expectedProjectionObjectKeys("project.1", 1, [
      { memory_id: "memory-1", revision_id: "revision-1", scope_id: "project.1" }
    ]) as string[];

    expect(keys).toContain("projects/project%2E1/projections/1/manifest.json");
    expect(keys).toContain("projects/project%2E1/projections/1/indexes/by-kind/fact/index.json");
    expect(keys).toContain(
      "projects/project%2E1/projections/1/indexes/by-scope/project%2E1/index.json"
    );
    expect(keys.some((key) => key.endsWith("/memory-1/revision-1.md"))).toBe(true);
    expect(keys.every((key) => key.startsWith("projects/project%2E1/projections/1/"))).toBe(
      true
    );
  });

  it("rejects cleanup ledgers that escape the exact synthetic project prefix", () => {
    const ledger = {
      project_id: "project-1",
      principal_id: "principal-1",
      vector_ids: ["a".repeat(64)],
      r2_keys: ["projects/project-1/projections/1/manifest.json"]
    };
    expect(() =>
      validateSyntheticCleanupLedger(ledger, "project-1", "principal-1")
    ).not.toThrow();
    expect(() =>
      validateSyntheticCleanupLedger(
        { ...ledger, r2_keys: ["projects/other/projections/1/manifest.json"] },
        "project-1",
        "principal-1"
      )
    ).toThrow(/exact project scope/iu);
  });

  it("never deletes authority when external projection cleanup fails", async () => {
    const calls: string[] = [];
    await expect(
      executeSyntheticCleanup({
        claimAdmissionFence: async () => calls.push("fence"),
        waitForQuiescence: async () => calls.push("quiescence"),
        loadLedger: () => null,
        createLedger: () => ({ vector_ids: [], r2_keys: [] }),
        writeLedger: () => calls.push("ledger"),
        deleteSearchProjection: () => calls.push("search"),
        deleteR2Projections: () => {
          calls.push("r2");
          throw new Error("R2 unavailable");
        },
        verifyProjectionCleanup: () => calls.push("verify projection"),
        deleteAuthority: () => calls.push("authority"),
        verifyAuthorityCleanup: () => calls.push("verify authority"),
        removeLedger: () => calls.push("remove ledger")
      })
    ).rejects.toThrow(/R2 unavailable/iu);
    expect(calls).toEqual(["fence", "quiescence", "ledger", "search", "r2"]);
  });

  it("does not inspect or delete projections when the admission fence cannot be claimed", async () => {
    const calls: string[] = [];
    await expect(
      executeSyntheticCleanup({
        claimAdmissionFence: async () => {
          calls.push("fence");
          throw new Error("claim conflict");
        },
        waitForQuiescence: async () => calls.push("quiescence"),
        loadLedger: () => null,
        createLedger: () => ({ vector_ids: [], r2_keys: [] }),
        writeLedger: () => calls.push("ledger"),
        deleteSearchProjection: () => calls.push("search"),
        deleteR2Projections: () => calls.push("r2"),
        verifyProjectionCleanup: () => calls.push("verify projection"),
        deleteAuthority: () => calls.push("authority"),
        verifyAuthorityCleanup: () => calls.push("verify authority"),
        removeLedger: () => calls.push("remove ledger")
      })
    ).rejects.toThrow(/claim conflict/iu);
    expect(calls).toEqual(["fence"]);
  });
});
