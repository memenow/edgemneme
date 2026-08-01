import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CONSOLIDATION_BATCH_SUBREQUEST_BUDGET,
  CONSOLIDATION_MAX_BATCH_D1_QUERY_BUDGET,
  CONSOLIDATION_MINIMUM_WORKFLOW_STEP_BUDGET,
  CONSOLIDATION_MINIMUM_WORKFLOW_SUBREQUEST_BUDGET,
  finishConsolidation,
  listConsolidationBatchIndexes,
  MAX_CONSOLIDATION_WORKFLOW_BATCHES,
  validateConsolidationBatchInputShape,
  validateConsolidationWorkflowBatchIndexes
} from "../src/workflows/quality";

describe("consolidation Workflow batch limits", () => {
  it("reserves a retry-aware platform budget for every admitted batch", () => {
    const config = JSON.parse(
      readFileSync("wrangler/memory-orchestrator.jsonc", "utf8")
    ) as {
      limits: { subrequests: number };
      workflows: Array<{ class_name: string; limits: { steps: number } }>;
    };
    const workflow = config.workflows.find(
      (candidate) => candidate.class_name === "MemoryWorkflow"
    );

    expect(CONSOLIDATION_BATCH_SUBREQUEST_BUDGET).toBe(128);
    expect(CONSOLIDATION_MINIMUM_WORKFLOW_SUBREQUEST_BUDGET).toBe(1_152_068);
    expect(CONSOLIDATION_MINIMUM_WORKFLOW_STEP_BUDGET).toBe(9_009);
    expect(CONSOLIDATION_MAX_BATCH_D1_QUERY_BUDGET).toBe(123);
    expect(CONSOLIDATION_MAX_BATCH_D1_QUERY_BUDGET).toBeLessThanOrEqual(1_000);
    expect(config.limits.subrequests).toBeGreaterThanOrEqual(
      CONSOLIDATION_MINIMUM_WORKFLOW_SUBREQUEST_BUDGET
    );
    expect(config.limits.subrequests).toBeLessThanOrEqual(10_000_000);
    expect(workflow?.limits.steps).toBeGreaterThanOrEqual(
      CONSOLIDATION_MINIMUM_WORKFLOW_STEP_BUDGET
    );
  });

  it("accepts at most one summary in a frozen batch", () => {
    expect(() =>
      validateConsolidationBatchInputShape(0, [
        { input_order: 0, input_kind: "summary" },
        { input_order: 1, input_kind: "candidate" }
      ])
    ).not.toThrow();
    expect(() =>
      validateConsolidationBatchInputShape(0, [
        { input_order: 0, input_kind: "candidate" }
      ])
    ).not.toThrow();
    expect(() =>
      validateConsolidationBatchInputShape(0, [
        { input_order: 1, input_kind: "candidate" }
      ])
    ).not.toThrow();
    expect(() =>
      validateConsolidationBatchInputShape(1, [
        { input_order: 50, input_kind: "candidate" }
      ])
    ).not.toThrow();

    expect(() =>
      validateConsolidationBatchInputShape(0, [
        { input_order: 0, input_kind: "summary" },
        { input_order: 1, input_kind: "summary" }
      ])
    ).toThrow(/only one summary/iu);
  });

  it("accepts the reserved 9,000-batch boundary", () => {
    const batchIndexes = Array.from(
      { length: MAX_CONSOLIDATION_WORKFLOW_BATCHES },
      (_, batchIndex) => batchIndex
    );

    expect(validateConsolidationWorkflowBatchIndexes(batchIndexes)).toEqual(
      batchIndexes
    );
    expect(new TextEncoder().encode(JSON.stringify(batchIndexes)).byteLength).toBeLessThan(
      1024 * 1024
    );
  });

  it("fails closed instead of truncating a batch beyond the reserved boundary", () => {
    const batchIndexes = Array.from(
      { length: MAX_CONSOLIDATION_WORKFLOW_BATCHES + 1 },
      (_, batchIndex) => batchIndex
    );

    expect(() => validateConsolidationWorkflowBatchIndexes(batchIndexes)).toThrow(
      /requires manual review.*Workflow batch limit/iu
    );
  });

  it.each([
    [MAX_CONSOLIDATION_WORKFLOW_BATCHES, false],
    [MAX_CONSOLIDATION_WORKFLOW_BATCHES + 1, true]
  ] as const)(
    "queries the %i-batch SQL sentinel without truncation",
    async (resultCount, shouldReject) => {
      const all = vi.fn().mockResolvedValue({
        results: Array.from({ length: resultCount }, (_, batchIndex) => ({
          batch_index: batchIndex
        }))
      });
      const bind = vi.fn(() => ({ all }));
      const prepare = vi.fn(() => ({ bind }));
      const database = {
        withSession: vi.fn(() => ({ prepare }))
      } as unknown as D1Database;

      const result = listConsolidationBatchIndexes(
        database,
        "project-1",
        "consolidation-1"
      );
      if (shouldReject) {
        await expect(result).rejects.toThrow(/Workflow batch limit/iu);
      } else {
        await expect(result).resolves.toHaveLength(resultCount);
      }
      expect(prepare).toHaveBeenCalledWith(expect.stringContaining("LIMIT ?"));
      expect(bind).toHaveBeenCalledWith(
        "project-1",
        "consolidation-1",
        MAX_CONSOLIDATION_WORKFLOW_BATCHES + 1
      );
    }
  );

  it("finishes the 9,000-batch boundary from one scalar receipt summary", async () => {
    const runFinish = async (batchCount: number) => {
      const batchIndexes = Array.from(
        { length: batchCount },
        (_, batchIndex) => batchIndex
      );
      let compactReceiptSql = "";
      let compactReceiptBindings: unknown[] = [];
      const database = {
        withSession: vi.fn(() => ({
          prepare(sql: string) {
            let bindings: unknown[] = [];
            const statement = {
              bind(...values: unknown[]) {
                bindings = values;
                return statement;
              },
              async first<T>() {
                if (sql.includes("AS invalid_receipt_count")) {
                  compactReceiptSql = sql;
                  compactReceiptBindings = bindings;
                  return {
                    receipt_post_state_valid: 1,
                    expected_batch_count: batchCount,
                    receipt_count: batchCount,
                    distinct_receipt_count: batchCount,
                    suggestion_count: 0,
                    output_count: 0,
                    missing_receipt_count: 0,
                    orphan_receipt_count: 0,
                    invalid_receipt_count: 0
                  } as T;
                }
                if (sql.includes("SELECT lease_expires_at")) {
                  return { lease_expires_at: "2099-08-01T00:20:00.000Z" } as T;
                }
                return {
                  status: "running",
                  lease_owner: "workflow-1",
                  lease_claim_id: "11111111-1111-4111-8111-111111111111",
                  lease_expires_at: "2099-08-01T00:20:00.000Z",
                  lease_operation_id: null,
                  lease_epoch: 1,
                  has_outputs: 0
                } as T;
              },
              async all(): Promise<never> {
                throw new Error("finish must not materialize receipt rows");
              },
              async run() {
                return { meta: { changes: 1 } };
              }
            };
            return statement;
          }
        }))
      } as unknown as D1Database;

      await finishConsolidation(
        database,
        "project-1",
        "consolidation-1",
        {
          owner: "workflow-1",
          claimId: "11111111-1111-4111-8111-111111111111",
          epoch: 1
        },
        batchIndexes
      );
      return { compactReceiptSql, compactReceiptBindings };
    };

    const oneBatch = await runFinish(1);
    const maximum = await runFinish(MAX_CONSOLIDATION_WORKFLOW_BATCHES);

    expect(maximum.compactReceiptSql).toBe(oneBatch.compactReceiptSql);
    expect(maximum.compactReceiptSql).toContain("AS invalid_receipt_count");
    expect(maximum.compactReceiptSql).not.toMatch(/output_manifest_json|json_each/iu);
    expect(maximum.compactReceiptSql.match(/\?/gu)).toHaveLength(2);
    expect(maximum.compactReceiptBindings).toEqual([
      "project-1",
      "consolidation-1"
    ]);
  });

  it.each<[string, number[]]>([
    ["duplicate", [0, 0]],
    ["descending", [1, 0]],
    ["unsafe output coordinate", [0, Number.MAX_SAFE_INTEGER]]
  ])("rejects a %s batch list", (_label, batchIndexes) => {
    expect(() => validateConsolidationWorkflowBatchIndexes(batchIndexes)).toThrow();
  });
});
