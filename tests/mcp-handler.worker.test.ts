import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import gatewayWorker, {
  boundMcpPostRequest,
  MCP_POST_BODY_MAX_BYTES
} from "../workers/memory-gateway/index";

const DELETION_CANDIDATE_ID =
  `github-path-absent-observation:${"a".repeat(64)}:` +
  `${"b".repeat(64)}:${"c".repeat(64)}`;

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

  it("accepts a GitHub path-absence candidate review through the MCP schema", async () => {
    const fixture = mutationGatewayEnvironment();

    await withClient(fixture.env, async (client) => {
      const result = await client.callTool({
        name: "candidate_review",
        arguments: {
          candidate_id: DELETION_CANDIDATE_ID,
          expected_candidate_version: 1,
          decision: "reject",
          reason: "The repository path is no longer authoritative.",
          idempotency_key: "review-deleted-repository-path"
        }
      });

      expect(result.isError).not.toBe(true);
      expect(fixture.coordinatorInputs).toEqual([
        expect.objectContaining({
          candidate_id: DELETION_CANDIDATE_ID,
          decision: "reject"
        })
      ]);
    });
  });

  it("returns the unified validation error for an invalid candidate identifier", async () => {
    const fixture = mutationGatewayEnvironment();

    await withClient(fixture.env, async (client) => {
      const result = await client.callTool({
        name: "candidate_review",
        arguments: {
          candidate_id: "not-a-candidate-id",
          expected_candidate_version: 1,
          decision: "reject",
          reason: "The identifier is malformed.",
          idempotency_key: "review-malformed-candidate"
        }
      });

      expect(result.isError).toBe(true);
      const content = Array.isArray(result.content)
        ? (result.content[0] as unknown)
        : undefined;
      if (
        typeof content !== "object" ||
        content === null ||
        !("type" in content) ||
        content.type !== "text" ||
        !("text" in content) ||
        typeof content.text !== "string"
      ) {
        throw new Error("Expected a text tool result.");
      }
      expect(JSON.parse(content.text)).toMatchObject({
        code: "VALIDATION_FAILED",
        message: "The candidate identifier is invalid.",
        retryable: false,
        request_id: expect.stringMatching(/\S/u)
      });
      expect(fixture.projectRefReads).toBe(0);
      expect(fixture.coordinatorInputs).toEqual([]);
    });
  });

  it("rejects an oversized candidate identifier before project lookup", async () => {
    const fixture = mutationGatewayEnvironment();

    await withClient(fixture.env, async (client) => {
      const result = await client.callTool({
        name: "candidate_review",
        arguments: {
          candidate_id: "x".repeat(DELETION_CANDIDATE_ID.length + 1),
          expected_candidate_version: 1,
          decision: "reject",
          reason: "The identifier exceeds the public contract limit.",
          idempotency_key: "review-oversized-candidate"
        }
      });

      expect(result.isError).toBe(true);
      const content = Array.isArray(result.content)
        ? (result.content[0] as unknown)
        : undefined;
      if (
        typeof content !== "object" ||
        content === null ||
        !("type" in content) ||
        content.type !== "text" ||
        !("text" in content) ||
        typeof content.text !== "string"
      ) {
        throw new Error("Expected a text tool result.");
      }
      expect(JSON.parse(content.text)).toMatchObject({
        code: "VALIDATION_FAILED",
        message: "The candidate identifier is invalid.",
        retryable: false,
        request_id: expect.stringMatching(/\S/u)
      });
      expect(fixture.projectRefReads).toBe(0);
      expect(fixture.coordinatorInputs).toEqual([]);
    });
  });

  it.each([
    ["scope only", { scope: "repository" }],
    ["scope ID only", { scope_id: "repository-a" }]
  ])("rejects memory_search filters with %s as a JSON tool error", async (_label, filters) => {
    const fixture = mutationGatewayEnvironment();

    await withClient(fixture.env, async (client) => {
      const result = await client.callTool({
        name: "memory_search",
        arguments: {
          project_ref: "project:one",
          filters
        }
      });

      expect(result.isError).toBe(true);
      const content = Array.isArray(result.content)
        ? (result.content[0] as unknown)
        : undefined;
      if (
        typeof content !== "object" ||
        content === null ||
        !("type" in content) ||
        content.type !== "text" ||
        !("text" in content) ||
        typeof content.text !== "string"
      ) {
        throw new Error("Expected a text tool result.");
      }
      expect(JSON.parse(content.text)).toMatchObject({
        code: "VALIDATION_FAILED",
        message: "The scope and scope_id filters must be provided together.",
        retryable: false,
        request_id: expect.stringMatching(/\S/u)
      });
      expect(fixture.projectRefReads).toBe(0);
    });
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

describe("MCP POST request body limit", () => {
  it("fast-rejects a declared oversized body without reading its stream", async () => {
    const tracked = trackedBodyStream(MCP_POST_BODY_MAX_BYTES + 1, "bytes");
    const request = authenticatedPostRequest(tracked.stream, {
      "content-length": String(MCP_POST_BODY_MAX_BYTES + 1)
    });
    const pullsBeforeFetch = tracked.pulls;

    const response = await gatewayWorker.fetch(
      request,
      gatewayEnvironment(),
      executionContext()
    );

    expect(response.status).toBe(413);
    expect(tracked.pulls).toBe(pullsBeforeFetch);
    expect(tracked.cancels).toBe(0);
  });

  it("fast-rejects an extreme decimal Content-Length without constructing an unbounded BigInt", async () => {
    const tracked = trackedBodyStream(1, "bytes");
    const request = authenticatedPostRequest(tracked.stream, {
      "content-length": "9".repeat(32 * 1024)
    });
    const pullsBeforeFetch = tracked.pulls;

    const response = await gatewayWorker.fetch(
      request,
      gatewayEnvironment(),
      executionContext()
    );

    expect(response.status).toBe(413);
    expect(tracked.pulls).toBe(pullsBeforeFetch);
  });

  it.each([
    ["an absent Content-Length through BYOB", "bytes", undefined],
    ["a falsely low Content-Length through the default fallback", "default", "1"]
  ] as const)("rejects cap plus one byte with %s and cancels the body", async (
    _label,
    streamKind,
    contentLength
  ) => {
    const tracked = trackedBodyStream(MCP_POST_BODY_MAX_BYTES + 1, streamKind);
    const response = await gatewayWorker.fetch(
      authenticatedPostRequest(tracked.stream, {
        Origin: "https://console.example",
        ...(contentLength === undefined ? {} : { "content-length": contentLength })
      }),
      gatewayEnvironment({ allowedOrigins: "https://console.example" }),
      executionContext()
    );

    expect(response.status).toBe(413);
    expect(tracked.cancels).toBe(1);
    if (streamKind === "bytes") {
      expect(tracked.maximumByobViewBytes).toBeGreaterThan(0);
      expect(tracked.maximumByobViewBytes).toBeLessThanOrEqual(64 * 1024);
    }
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://console.example"
    );
    expect(response.headers.has("retry-after")).toBe(false);
    const payload = (await response.json()) as {
      jsonrpc: string;
      id: unknown;
      error: {
        code: number;
        message: string;
        data: Record<string, unknown>;
      };
    };
    expect(payload).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: `The MCP request body exceeds the ${MCP_POST_BODY_MAX_BYTES}-byte limit.`,
        data: {
          code: "VALIDATION_FAILED",
          retryable: false,
          request_id: expect.stringMatching(/\S/u)
        }
      }
    });
    expect(payload.error.data).not.toHaveProperty("retry_after_ms");
  });

  it("accepts exactly the cap and rebuilds the request with its headers and signal", async () => {
    const controller = new AbortController();
    const tracked = trackedBodyStream(MCP_POST_BODY_MAX_BYTES, "bytes");
    const request = authenticatedPostRequest(
      tracked.stream,
      {
        "content-length": String(MCP_POST_BODY_MAX_BYTES),
        "content-encoding": "identity",
        "x-request-marker": "preserved"
      },
      controller.signal
    );

    const bounded = await boundMcpPostRequest(request);

    expect(bounded).not.toBe(request);
    expect(bounded.headers.get("content-length")).toBe(String(MCP_POST_BODY_MAX_BYTES));
    expect(bounded.headers.get("content-encoding")).toBe("identity");
    expect(bounded.headers.get("x-request-marker")).toBe("preserved");
    expect(await requestBodyByteLength(bounded)).toBe(MCP_POST_BODY_MAX_BYTES);
    expect(tracked.cancels).toBe(0);
    expect(tracked.maximumByobViewBytes).toBeLessThanOrEqual(64 * 1024);
    controller.abort();
    expect(bounded.signal.aborted).toBe(true);
  });

  it.each(["-1", "+1", "1.5", "1e3", "1, 1"])(
    "rejects malformed Content-Length %j before reading the body",
    async (contentLength) => {
      const tracked = trackedBodyStream(1, "bytes");
      const request = authenticatedPostRequest(tracked.stream, {
        "content-length": contentLength
      });
      const pullsBeforeFetch = tracked.pulls;

      const response = await gatewayWorker.fetch(
        request,
        gatewayEnvironment(),
        executionContext()
      );

      expect(response.status).toBe(400);
      expect(tracked.pulls).toBe(pullsBeforeFetch);
      await expect(response.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          data: { code: "VALIDATION_FAILED", retryable: false }
        }
      });
    }
  );

  it.each(["gzip", "br", "identity, gzip", ""])(
    "rejects unsupported Content-Encoding %j before reading the body",
    async (contentEncoding) => {
      const tracked = trackedBodyStream(1, "bytes");
      const request = authenticatedPostRequest(tracked.stream, {
        "content-encoding": contentEncoding
      });
      const pullsBeforeFetch = tracked.pulls;

      const response = await gatewayWorker.fetch(
        request,
        gatewayEnvironment(),
        executionContext()
      );

      expect(response.status).toBe(415);
      expect(tracked.pulls).toBe(pullsBeforeFetch);
      await expect(response.json()).resolves.toMatchObject({
        error: { data: { code: "VALIDATION_FAILED" } }
      });
    }
  );

  it("keeps origin rejection ahead of the body gate", async () => {
    const tracked = trackedBodyStream(MCP_POST_BODY_MAX_BYTES + 1, "bytes");
    const request = authenticatedPostRequest(tracked.stream, {
      Origin: "https://attacker.example",
      "content-length": String(MCP_POST_BODY_MAX_BYTES + 1)
    });
    const pullsBeforeFetch = tracked.pulls;

    const response = await gatewayWorker.fetch(
      request,
      gatewayEnvironment({ allowedOrigins: "https://console.example" }),
      executionContext()
    );

    expect(response.status).toBe(401);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(tracked.pulls).toBe(pullsBeforeFetch);
  });

  it("keeps authentication rejection ahead of the body gate", async () => {
    const tracked = trackedBodyStream(MCP_POST_BODY_MAX_BYTES + 1, "bytes");
    const request = new Request("https://memory.example/mcp", {
      method: "POST",
      headers: { "content-length": String(MCP_POST_BODY_MAX_BYTES + 1) },
      body: tracked.stream
    });
    const pullsBeforeFetch = tracked.pulls;

    const response = await gatewayWorker.fetch(
      request,
      gatewayEnvironment(),
      executionContext()
    );

    expect(response.status).toBe(401);
    expect(tracked.pulls).toBe(pullsBeforeFetch);
  });

  it("keeps principal rate limiting ahead of the body gate", async () => {
    const tracked = trackedBodyStream(MCP_POST_BODY_MAX_BYTES + 1, "bytes");
    const env = gatewayEnvironment();
    env.MCP_PRINCIPAL_LIMITER = {
      async limit() {
        return { success: false };
      }
    } as unknown as RateLimit;
    const request = authenticatedPostRequest(tracked.stream, {
      "content-length": String(MCP_POST_BODY_MAX_BYTES + 1)
    });
    const pullsBeforeFetch = tracked.pulls;

    const response = await gatewayWorker.fetch(request, env, executionContext());

    expect(response.status).toBe(429);
    expect(tracked.pulls).toBe(pullsBeforeFetch);
  });

  it("keeps CORS preflight ahead of body headers and all limiters", async () => {
    let limiterCalls = 0;
    const env = gatewayEnvironment({ allowedOrigins: "https://console.example" });
    env.MCP_EDGE_LIMITER = countingLimiter(() => {
      limiterCalls += 1;
    });
    env.MCP_CLIENT_LIMITER = countingLimiter(() => {
      limiterCalls += 1;
    });
    env.MCP_PRINCIPAL_LIMITER = countingLimiter(() => {
      limiterCalls += 1;
    });

    const response = await gatewayWorker.fetch(
      new Request("https://memory.example/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "https://console.example",
          "Access-Control-Request-Method": "POST",
          "Content-Length": String(MCP_POST_BODY_MAX_BYTES + 1),
          "Content-Encoding": "gzip"
        }
      }),
      env,
      executionContext()
    );

    expect(response.status).toBe(204);
    expect(limiterCalls).toBe(0);
  });

  it.each(["GET", "DELETE", "OPTIONS"])(
    "does not apply the POST body gate to %s",
    async (method) => {
      const request = new Request("https://memory.example/mcp", {
        method,
        headers: {
          "content-length": "malformed",
          "content-encoding": "gzip"
        }
      });

      await expect(boundMcpPostRequest(request)).resolves.toBe(request);
    }
  );
});

function authenticatedPostRequest(
  body: ReadableStream<Uint8Array>,
  headers: HeadersInit = {},
  signal?: AbortSignal
): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("authorization", `Bearer ${"t".repeat(48)}`);
  requestHeaders.set("content-type", "application/json");
  return new Request("https://memory.example/mcp", {
    method: "POST",
    headers: requestHeaders,
    body,
    ...(signal === undefined ? {} : { signal })
  });
}

async function requestBodyByteLength(request: Request): Promise<number> {
  const reader = request.body?.getReader();
  if (reader === undefined) {
    return 0;
  }
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return byteLength;
      }
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

function trackedBodyStream(
  totalBytes: number,
  kind: "bytes" | "default"
): {
  stream: ReadableStream<Uint8Array>;
  readonly pulls: number;
  readonly cancels: number;
  readonly maximumByobViewBytes: number;
} {
  let remainingBytes = totalBytes;
  let pulls = 0;
  let cancels = 0;
  let maximumByobViewBytes = 0;
  const stream =
    kind === "bytes"
      ? new ReadableStream({
          type: "bytes",
          pull(controller) {
            pulls += 1;
            if (remainingBytes === 0) {
              controller.close();
              return;
            }
            const byobRequest = controller.byobRequest;
            const view = byobRequest?.view;
            if (byobRequest !== null && view !== null && view !== undefined) {
              maximumByobViewBytes = Math.max(
                maximumByobViewBytes,
                view.byteLength
              );
              const byteLength = Math.min(view.byteLength, remainingBytes);
              new Uint8Array(view.buffer, view.byteOffset, byteLength).fill(32);
              remainingBytes -= byteLength;
              byobRequest.respond(byteLength);
              return;
            }
            const byteLength = Math.min(64 * 1024, remainingBytes);
            remainingBytes -= byteLength;
            controller.enqueue(new Uint8Array(byteLength).fill(32));
          },
          cancel() {
            cancels += 1;
          }
        } satisfies UnderlyingByteSource)
      : new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (remainingBytes === 0) {
              controller.close();
              return;
            }
            const byteLength = Math.min(128 * 1024, remainingBytes);
            remainingBytes -= byteLength;
            controller.enqueue(new Uint8Array(byteLength).fill(32));
          },
          cancel() {
            cancels += 1;
          }
        });
  return {
    stream,
    get pulls() {
      return pulls;
    },
    get cancels() {
      return cancels;
    },
    get maximumByobViewBytes() {
      return maximumByobViewBytes;
    }
  };
}

function executionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
}

async function withClient(
  env: Parameters<typeof gatewayWorker.fetch>[1],
  callback: (client: Client) => Promise<void>
): Promise<void> {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://memory.example/mcp"),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${"t".repeat(48)}` }
      },
      fetch: async (url, init) =>
        gatewayWorker.fetch(new Request(url, init), env, executionContext())
    }
  );
  const client = new Client(
    { name: "EdgeMneme contract test client", version: "2026-07-25" },
    { capabilities: {} }
  );
  try {
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    await callback(client);
  } finally {
    await client.close();
  }
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

function gatewayEnvironment(
  options: { allowedOrigins?: string } = {}
): Parameters<typeof gatewayWorker.fetch>[1] {
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
    ALLOWED_ORIGINS: options.allowedOrigins ?? "",
    MCP_EDGE_LIMITER: limiter,
    MCP_CLIENT_LIMITER: limiter,
    MCP_PRINCIPAL_LIMITER: limiter,
    MEMORY_DB: database
  } as Parameters<typeof gatewayWorker.fetch>[1];
}

function mutationGatewayEnvironment(): {
  env: Parameters<typeof gatewayWorker.fetch>[1];
  coordinatorInputs: Array<Record<string, unknown>>;
  readonly projectRefReads: number;
} {
  const coordinatorInputs: Array<Record<string, unknown>> = [];
  let projectRefReads = 0;
  const database = {
    withSession(consistency: string) {
      expect(consistency).toBe("first-primary");
      return this;
    },
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes("FROM principals p")) {
            return {
              principal_id: "principal-1",
              project_id: "project-1",
              role: "maintainer"
            };
          }
          if (sql.includes("SELECT 1 AS authorized")) {
            return { authorized: 1 };
          }
          if (sql.includes("SELECT 1 AS allowed")) {
            projectRefReads += 1;
            return { allowed: 1 };
          }
          return null;
        },
        async all() {
          return { results: [] };
        }
      };
    },
    async batch(statements: unknown[]) {
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  } as unknown as D1Database;
  const limiter = {
    async limit() {
      return { success: true };
    }
  } as unknown as RateLimit;
  const coordinator = {
    idFromName() {
      return { toString: () => "project-1" };
    },
    get() {
      return {
        async fetch(_url: string, init: RequestInit) {
          coordinatorInputs.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return Response.json({ accepted: true });
        }
      };
    }
  };
  return {
    env: {
      TOKEN_DIGEST_PEPPER: "p".repeat(48),
      ALLOWED_ORIGINS: "",
      MCP_EDGE_LIMITER: limiter,
      MCP_CLIENT_LIMITER: limiter,
      MCP_PRINCIPAL_LIMITER: limiter,
      MEMORY_DB: database,
      PROJECT_COORDINATOR: coordinator
    } as unknown as Parameters<typeof gatewayWorker.fetch>[1],
    coordinatorInputs,
    get projectRefReads() {
      return projectRefReads;
    }
  };
}
