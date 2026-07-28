import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import gatewayWorker from "../workers/memory-gateway/index";

describe("stateless MCP handler", () => {
  it("supports a complete SDK initialization across independent HTTP requests", async () => {
    const methods: string[] = [];
    const sessionHeaders: Array<string | null> = [];
    const env = gatewayEnvironment();
    const context = {
      waitUntil() {},
      passThroughOnException() {}
    } as unknown as ExecutionContext;
    const transport = new StreamableHTTPClientTransport(
      new URL("https://memory.example/mcp"),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${"t".repeat(48)}` }
        },
        fetch: async (url, init) => {
          const request = new Request(url, init);
          methods.push(request.method);
          const response = await gatewayWorker.fetch(request, env, context);
          sessionHeaders.push(response.headers.get("mcp-session-id"));
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
    } finally {
      await client.close();
    }
  });
});

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
