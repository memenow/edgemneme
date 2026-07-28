import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayService, type GatewayEnv } from "../src/gateway/service";
import type { AuthenticatedPrincipal } from "../src/security/auth";

interface QueryRecord {
  sql: string;
  bindings: unknown[];
}

const principal: AuthenticatedPrincipal = {
  principalId: "principal-1",
  projectId: "project-1",
  role: "reader"
};

describe("GatewayService memory browse", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses one signed validity instant across every page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    const records: QueryRecord[] = [];
    let browseCount = 0;
    const memoryDatabase = {
      withSession() {
        return this;
      },
      prepare(sql: string) {
        const record = { sql, bindings: [] as unknown[] };
        records.push(record);
        return {
          bind(...bindings: unknown[]) {
            record.bindings = bindings;
            return this;
          },
          async first() {
            if (sql.includes("SELECT project_version")) {
              return { project_version: 7 };
            }
            if (sql.includes("SELECT 1 AS allowed")) {
              return { allowed: 1 };
            }
            throw new Error(`Unexpected first query: ${sql}`);
          },
          async all() {
            if (sql.includes("FROM project_grants grant_record")) {
              return {
                results: [
                  {
                    scope_kind: "project",
                    scope_id: "project-1",
                    repository_id: null
                  }
                ],
                success: true,
                meta: {}
              };
            }
            if (!sql.includes("FROM memories m")) {
              throw new Error(`Unexpected all query: ${sql}`);
            }
            browseCount += 1;
            return {
              results:
                browseCount === 1
                  ? [
                      {
                        memory_id: "memory-1",
                        memory_version: 1,
                        kind: "fact",
                        memory_class: "semantic",
                        scope: "project",
                        scope_id: "project-1",
                        status: "active",
                        updated_at: "2026-07-25T11:00:00.000Z",
                        revision_id: "revision-1",
                        content: "D1 is authoritative.",
                        content_sha256: "sha-1",
                        valid_from: null,
                        valid_until: null
                      }
                    ]
                  : [],
              success: true,
              meta: {}
            };
          }
        };
      }
    } as unknown as D1Database;
    const service = new GatewayService(
      {
        MEMORY_DB: memoryDatabase,
        PAGE_TOKEN_HMAC_KEY: "synthetic-test-key-with-at-least-32-bytes"
      } as unknown as GatewayEnv,
      principal
    );

    const first = await service.search({ projectRef: "project:one", limit: 1 });
    expect(first.next_page_token).toEqual(expect.any(String));
    const firstBrowse = records.find((record) => record.sql.includes("FROM memories m"));
    expect(firstBrowse?.sql).toContain(
      "julianday(v.valid_from) <= julianday(?)"
    );
    expect(firstBrowse?.sql).toContain(
      "julianday(v.valid_until) > julianday(?)"
    );
    expect(firstBrowse?.bindings).toEqual([
      "project-1",
      "principal-1",
      "2026-07-25T12:00:00.000Z",
      "2026-07-25T12:00:00.000Z",
      1
    ]);

    vi.setSystemTime(new Date("2026-07-25T12:05:00.000Z"));
    await service.search({
      projectRef: "project:one",
      limit: 1,
      pageToken: first.next_page_token as string
    });
    const browseRecords = records.filter((record) => record.sql.includes("FROM memories m"));
    expect(browseRecords[1]?.bindings).toEqual([
      "project-1",
      "principal-1",
      "2026-07-25T12:00:00.000Z",
      "2026-07-25T12:00:00.000Z",
      "2026-07-25T11:00:00.000Z",
      "2026-07-25T11:00:00.000Z",
      "memory-1",
      1
    ]);
  });

  it.each([
    ["PII", "Find operator@example.com"],
    ["secret", `Find ${["sk", "test", "abcdefghijklmnopqrstuvwxyz123456"].join("-")}`],
    ["prompt transcript", "System: You are an assistant with private memory access."],
    [
      "raw log",
      "2026-07-27T12:00:00.000Z INFO request started"
    ]
  ])("rejects unsafe %s search text before the model pipeline runs", async (_label, query) => {
    const aiRun = vi.fn();
    const vectorQuery = vi.fn();
    const searchPrepare = vi.fn(() => {
      throw new Error("SEARCH_DB must not be read for unsafe model input.");
    });
    const memoryDatabase = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            if (sql.includes("SELECT 1 AS allowed")) {
              return { allowed: 1 };
            }
            throw new Error(`Unexpected memory query: ${sql}`);
          }
        };
      }
    } as unknown as D1Database;
    const service = new GatewayService(
      {
        MEMORY_DB: memoryDatabase,
        SEARCH_DB: { prepare: searchPrepare } as unknown as D1Database,
        MEMORY_VECTORS: { query: vectorQuery } as unknown as VectorizeIndex,
        AI: { run: aiRun } as unknown as Ai,
        PAGE_TOKEN_HMAC_KEY: "synthetic-test-key-with-at-least-32-bytes"
      } as unknown as GatewayEnv,
      principal
    );

    await expect(service.search({ projectRef: "project:one", query })).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
    expect(searchPrepare).not.toHaveBeenCalled();
    expect(vectorQuery).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });
});
