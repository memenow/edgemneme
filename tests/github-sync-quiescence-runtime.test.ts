import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DATABASE_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "synthetic-cloudflare-token";
const CONFIG = "wrangler/.wrangler/github-sync.generated.jsonc";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => JSON.stringify({
      d1_databases: [{
        binding: "MEMORY_DB",
        database_id: "22222222-2222-4222-8222-222222222222"
      }]
    }))
  };
});

// The deployment runtime is plain ESM so GitHub Actions can run it without a TS runtime.
// @ts-expect-error The JavaScript module has no separate declaration file.
import { createD1RestRuntime } from "../scripts/github-sync-quiescence-runtime.mjs";
// @ts-expect-error The JavaScript module has no separate declaration file.
import { batchWithVerification } from "../scripts/github-sync-quiescence-contracts.mjs";

describe("GitHub sync quiescence D1 REST runtime", () => {
  beforeEach(() => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT_ID);
    vi.stubEnv("CLOUDFLARE_API_TOKEN", TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the fixed D1 endpoint and preserves native scalar parameters", async () => {
    let requestBody: unknown;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}` +
        `/d1/database/${DATABASE_ID}/query`
      );
      expect(init).toMatchObject({ method: "POST", redirect: "manual" });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      requestBody = JSON.parse(String(init?.body));
      const count = (requestBody as { batch: unknown[] }).batch.length;
      return response({
        success: true,
        result: Array.from({ length: count }, () => primaryResult([]))
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = createD1RestRuntime(CONFIG);
    await runtime.batch(
      [
        { sql: "SELECT typeof(?), typeof(?)", params: [1, null] },
        { sql: "SELECT 1", params: [] }
      ],
      "Verify native D1 parameters"
    );

    expect(requestBody).toEqual({
      batch: [
        { sql: "SELECT typeof(?), typeof(?)", params: [1, null] },
        { sql: "SELECT 1" }
      ]
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns primary SELECT rows unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      success: true,
      result: [primaryResult([{ number_type: "integer", null_type: "null" }])]
    })));
    await expect(
      createD1RestRuntime(CONFIG).query(
        "SELECT typeof(?) AS number_type, typeof(?) AS null_type",
        [1, null],
        "Read primary scalar types"
      )
    ).resolves.toMatchObject({
      results: [{ number_type: "integer", null_type: "null" }],
      meta: { served_by_primary: true }
    });
  });

  it.each([
    {
      name: "redirect",
      makeResponse: () => response({}, 302),
      message: "HTTP 302"
    },
    {
      name: "non-success HTTP",
      makeResponse: () => response({ detail: "sensitive-upstream-body" }, 503),
      message: "HTTP 503"
    },
    {
      name: "failed envelope",
      makeResponse: () => response({ success: false, result: [] }),
      message: "invalid Cloudflare D1 envelope"
    },
    {
      name: "malformed JSON",
      makeResponse: () => new Response("{"),
      message: "invalid Cloudflare D1 JSON"
    },
    {
      name: "wrong result count",
      makeResponse: () => response({ success: true, result: [] }),
      message: "invalid Cloudflare D1 envelope"
    },
    {
      name: "failed statement",
      makeResponse: () => response({
        success: true,
        result: [{ success: false, results: [], meta: { served_by_primary: true } }]
      }),
      message: "invalid Cloudflare D1 statement result"
    },
    {
      name: "mutation result without rows",
      makeResponse: () => response({
        success: true,
        result: [{ success: true, meta: { served_by_primary: true } }]
      }),
      message: "invalid Cloudflare D1 statement result"
    },
    {
      name: "non-primary statement",
      makeResponse: () => response({
        success: true,
        result: [{ success: true, results: [], meta: { served_by_primary: false } }]
      }),
      message: "invalid Cloudflare D1 statement result"
    }
  ])("fails closed on $name without exposing credentials", async ({ makeResponse, message }) => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResponse()));
    const runtime = createD1RestRuntime(CONFIG);
    let caught: unknown;
    try {
      await runtime.query("SELECT ?", ["sensitive-parameter"], "Bounded D1 check");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(message);
    expect((caught as Error).message).not.toContain(TOKEN);
    expect((caught as Error).message).not.toContain("sensitive-parameter");
    expect((caught as Error).message).not.toContain("sensitive-upstream-body");
  });

  it("uses a timeout signal and redacts fetch failures", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new Error(`network failure ${TOKEN}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createD1RestRuntime(CONFIG).query("SELECT ?", ["private-row"], "Timed request")
    ).rejects.toThrow("did not receive a valid Cloudflare D1 response");
    try {
      await createD1RestRuntime(CONFIG).query("SELECT ?", ["private-row"], "Timed request");
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN);
      expect((error as Error).message).not.toContain("private-row");
    }
  });

  it("rejects oversized declared and streamed responses", async () => {
    const declared = response(
      { success: true, result: [primaryResult([])] },
      200,
      { "content-length": "1048577" }
    );
    const cancel = vi.spyOn(declared.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn(async () => declared));
    await expect(
      createD1RestRuntime(CONFIG).query("SELECT 1", [], "Declared response cap")
    ).rejects.toThrow("oversized Cloudflare D1 response");
    expect(cancel).toHaveBeenCalledOnce();

    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(1_048_577))));
    await expect(
      createD1RestRuntime(CONFIG).query("SELECT 1", [], "Streamed response cap")
    ).rejects.toThrow("oversized Cloudflare D1 response");
  });

  it("recovers an ambiguous mutation response only through an exact primary read", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        result: [{ success: true, meta: { served_by_primary: true } }]
      }))
      .mockResolvedValueOnce(response({
        success: true,
        result: [primaryResult([{ matches: 1 }])]
      }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createD1RestRuntime(CONFIG);
    await expect(batchWithVerification(
      runtime,
      [{ sql: "UPDATE synthetic SET value = 1", params: [] }],
      "Ambiguous mutation",
      async () => {
        const exact = await runtime.query(
          "SELECT 1 AS matches",
          [],
          "Verify ambiguous mutation"
        );
        return exact.results.length === 1 && exact.results[0]?.matches === 1;
      }
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("enforces batch, SQL, scalar, and aggregate request bounds before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createD1RestRuntime(CONFIG);

    await expect(runtime.batch([], "Empty batch")).rejects.toThrow("between 1 and 64");
    await expect(runtime.batch(
      Array.from({ length: 65 }, () => ({ sql: "SELECT 1", params: [] })),
      "Large batch"
    )).rejects.toThrow("between 1 and 64");
    await expect(runtime.query("x".repeat(100_001), [], "Large SQL")).rejects.toThrow(
      "bounded SQL"
    );
    await expect(runtime.query(
      "SELECT 1",
      Array.from({ length: 101 }, () => 1),
      "Many parameters"
    )).rejects.toThrow("bounded SQL");
    await expect(runtime.query(
      "SELECT ?",
      ["界".repeat(2_731)],
      "Multibyte parameter"
    )).rejects.toThrow("bounded SQL");
    await expect(runtime.batch(
      Array.from({ length: 64 }, (_, index) => ({
        sql: `SELECT '${String(index).padStart(2, "0")}${"x".repeat(17_000)}'`,
        params: []
      })),
      "Aggregate request"
    )).rejects.toThrow("bounded Cloudflare D1 request size");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unapproved config paths, placeholder IDs, and missing secrets", () => {
    expect(() => createD1RestRuntime("wrangler/github-sync.jsonc")).toThrow(
      "approved generated Wrangler config"
    );
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({
      d1_databases: [{
        binding: "MEMORY_DB",
        database_id: "00000000-0000-0000-0000-000000000000"
      }]
    }));
    expect(() => createD1RestRuntime(CONFIG)).toThrow("non-placeholder UUID");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "0".repeat(32));
    expect(() => createD1RestRuntime(CONFIG)).toThrow("placeholder value");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT_ID);
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    expect(() => createD1RestRuntime(CONFIG)).toThrow(
      "CLOUDFLARE_API_TOKEN must be provided"
    );
  });
});

function primaryResult(results: unknown[]) {
  return { success: true, results, meta: { served_by_primary: true } };
}

function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}
