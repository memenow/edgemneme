import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import gatewayWorker from "../workers/memory-gateway/index";

describe("stateless MCP handler", () => {
  it("supports a complete SDK initialization across independent HTTP requests", async () => {
    const methods: string[] = [];
    const sessionHeaders: Array<string | null> = [];
    const corsOrigins: Array<string | null> = [];
    const env = gatewayEnvironment();
    env.ALLOWED_ORIGINS = "https://console.example";
    const context = {
      waitUntil() {},
      passThroughOnException() {}
    } as unknown as ExecutionContext;
    const transport = new StreamableHTTPClientTransport(
      new URL("https://memory.example/mcp"),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${"t".repeat(48)}`,
            Origin: "https://console.example"
          }
        },
        fetch: async (url, init) => {
          const request = new Request(url, init);
          methods.push(request.method);
          const response = await gatewayWorker.fetch(request, env, context);
          sessionHeaders.push(response.headers.get("mcp-session-id"));
          corsOrigins.push(response.headers.get("access-control-allow-origin"));
          return response;
        }
      }
    );
    const client = new Client(
      { name: "EdgeMneme test client", version: "2026-07-25" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
      const tools = await client.listTools();

      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "project_resolve",
          "session_open",
          "memory_search",
          "candidate_submit",
          "memory_change_submit",
          "candidate_review",
          "session_close",
          "workflow_get"
        ])
      );
      expect(methods.filter((method) => method === "POST").length).toBeGreaterThanOrEqual(3);
      expect(sessionHeaders).toEqual(sessionHeaders.map(() => null));
      expect(corsOrigins).toEqual(corsOrigins.map(() => "https://console.example"));
    } finally {
      await client.close();
    }
  });

  it("answers an allowed CORS preflight before rate limiting or authentication", async () => {
    let limiterCalls = 0;
    const env = gatewayEnvironment();
    env.ALLOWED_ORIGINS = "https://console.example";
    env.MCP_EDGE_LIMITER = countingLimiter(() => {
      limiterCalls += 1;
    });
    env.MCP_CLIENT_LIMITER = countingLimiter(() => {
      limiterCalls += 1;
    });
    env.MCP_PRINCIPAL_LIMITER = countingLimiter(() => {
      limiterCalls += 1;
    });
    env.MEMORY_DB = authenticationTrap();

    const response = await gatewayWorker.fetch(
      new Request("https://memory.example/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "https://console.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type"
        }
      }),
      env,
      executionContext()
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://console.example"
    );
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.get("vary")).toContain("Access-Control-Request-Method");
    expect(limiterCalls).toBe(0);
  });

  it("rejects a preflight from an untrusted origin without CORS response headers", async () => {
    const env = gatewayEnvironment();
    env.ALLOWED_ORIGINS = "https://console.example";
    env.MEMORY_DB = authenticationTrap();

    const response = await gatewayWorker.fetch(
      new Request("https://memory.example/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST"
        }
      }),
      env,
      executionContext()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("adds readable CORS headers to errors for an allowed origin", async () => {
    const env = gatewayEnvironment();
    env.ALLOWED_ORIGINS = "https://console.example";

    const response = await gatewayWorker.fetch(
      new Request("https://memory.example/mcp", {
        headers: { Origin: "https://console.example" }
      }),
      env,
      executionContext()
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://console.example"
    );
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "MCP-Session-Id"
    );
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("does not add MCP CORS headers outside the MCP route", async () => {
    const response = await gatewayWorker.fetch(
      new Request("https://memory.example/health", {
        method: "OPTIONS",
        headers: {
          Origin: "https://console.example",
          "Access-Control-Request-Method": "POST"
        }
      }),
      gatewayEnvironment(),
      executionContext()
    );

    expect(response.status).toBe(404);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
});

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
}

function countingLimiter(onLimit: () => void): RateLimit {
  return {
    async limit() {
      onLimit();
      return { success: true };
    }
  } as unknown as RateLimit;
}

function authenticationTrap(): D1Database {
  return {
    withSession() {
      throw new Error("Authentication must not run for a CORS preflight.");
    }
  } as unknown as D1Database;
}

function gatewayEnvironment(): Parameters<typeof gatewayWorker.fetch>[1] {
  const database = {
    withSession(consistency: string) {
      expect(consistency).toBe("first-primary");
      return {
        prepare() {
          return {
            bind() {
              return this;
            },
            async first() {
              return {
                principal_id: "principal-1",
                project_id: "project-1",
                role: "maintainer"
              };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
  const limiter = {
    async limit() {
      return { success: true };
    }
  } as unknown as RateLimit;

  return {
    TOKEN_DIGEST_PEPPER: "p".repeat(48),
    ALLOWED_ORIGINS: "",
    MCP_EDGE_LIMITER: limiter,
    MCP_CLIENT_LIMITER: limiter,
    MCP_PRINCIPAL_LIMITER: limiter,
    MEMORY_DB: database
  } as Parameters<typeof gatewayWorker.fetch>[1];
}
