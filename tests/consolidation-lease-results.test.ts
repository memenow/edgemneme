import { describe, expect, it } from "vitest";
import {
  claimConsolidationLease,
  failConsolidation,
  finishConsolidation,
  type ConsolidationLeaseToken
} from "../src/workflows/quality";

const PROJECT_ID = "project-1";
const CONSOLIDATION_ID = "consolidation-1";
const SESSION_ID = "session-1";
const CLAIM_ID = "00000000-0000-4000-8000-000000000001";
const LEASE: ConsolidationLeaseToken = {
  owner: "workflow-1",
  claimId: CLAIM_ID,
  epoch: 1
};

describe("consolidation lease D1 result fences", () => {
  it("fails closed when a normal claim response reports more than one change", async () => {
    const state = {
      status: "running",
      lease_owner: LEASE.owner,
      lease_claim_id: LEASE.claimId,
      lease_expires_at: "2099-01-01T00:00:00.000Z",
      lease_operation_id: null,
      lease_epoch: LEASE.epoch,
      lease_active: 1
    };
    const database = {
      withSession() {
        return {
          prepare: preparedStatement,
          async batch() {
            return [d1Result(2), { ...d1Result(0), results: [state] }];
          }
        };
      }
    } as unknown as D1Database;

    await expect(
      claimConsolidationLease(
        database,
        PROJECT_ID,
        CONSOLIDATION_ID,
        SESSION_ID,
        LEASE.owner,
        LEASE.claimId
      )
    ).rejects.toThrow("unexpected number of rows");
  });

  it("fails closed when a normal renewal response reports more than one change", async () => {
    const database = {
      withSession() {
        return {
          prepare(sql: string) {
            return {
              bind() {
                return this;
              },
              async run() {
                return d1Result(2);
              },
              async first() {
                return sql.includes("SELECT lease_expires_at")
                  ? { lease_expires_at: "2099-01-01T00:00:00.000Z" }
                  : null;
              }
            };
          }
        };
      }
    } as unknown as D1Database;

    await expect(
      finishConsolidation(database, PROJECT_ID, CONSOLIDATION_ID, LEASE, [])
    ).rejects.toThrow("unexpected number of rows");
  });

  it("fails closed when a normal failure release reports more than one change", async () => {
    const database = {
      withSession() {
        return {
          prepare() {
            return {
              bind() {
                return this;
              },
              async run() {
                return d1Result(2);
              },
              async first() {
                return null;
              }
            };
          }
        };
      }
    } as unknown as D1Database;

    await expect(
      failConsolidation(database, PROJECT_ID, CONSOLIDATION_ID, LEASE)
    ).rejects.toThrow("unexpected number of rows");
  });
});

function preparedStatement() {
  return {
    bind() {
      return this;
    }
  };
}

function d1Result(changes: number) {
  return {
    success: true,
    results: [],
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes
    }
  };
}
