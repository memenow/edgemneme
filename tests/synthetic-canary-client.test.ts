import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const canaryState = vi.hoisted(() => ({
  events: [] as string[],
  calls: [] as Array<{ name: string; arguments?: Record<string, unknown> }>,
  resources: new Map<string, Record<string, unknown>>(),
  transport: null as null | {
    url: string;
    options: {
      fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      requestInit?: RequestInit;
    };
  }
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect() {
      canaryState.events.push("connect");
    }

    async close() {
      canaryState.events.push("close");
    }

    async listTools() {
      return {
        tools: [
          "project_resolve",
          "session_open",
          "memory_search",
          "candidate_submit",
          "memory_change_submit",
          "candidate_review",
          "session_close",
          "workflow_get"
        ].map((name) => ({ name }))
      };
    }

    async callTool(input: { name: string; arguments?: Record<string, unknown> }) {
      canaryState.events.push(`tool:${input.name}`);
      canaryState.calls.push(input);
      const result = (() => {
        switch (input.name) {
          case "project_resolve":
            return { project_id: PROJECT_ID };
          case "session_open":
            return { session_id: SESSION_ID };
          case "memory_search":
            return input.arguments?.query === undefined
              ? { memories: [] }
              : {
                  abstained: false,
                  memories: [{ memoryId: MEMORY_ID, revisionId: REVISION_ID }]
                };
          case "candidate_submit":
            return {
              candidate_id: ANALYSIS_CANDIDATE_ID,
              status: "queued",
              workflow_id: QUALITY_WORKFLOW_ID
            };
          case "workflow_get":
            return { status: "complete" };
          case "candidate_review":
            return {
              status: "promoted",
              memory_version: 1,
              project_version: 1,
              memory_id: MEMORY_ID,
              revision_id: REVISION_ID
            };
          case "session_close":
            return { status: "closed", session_version: 2 };
          default:
            throw new Error(`Unexpected tool ${input.name}.`);
        }
      })();
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }

    async readResource(input: { uri: string }) {
      canaryState.events.push(`resource:${input.uri}`);
      const resource = canaryState.resources.get(input.uri);
      return resource === undefined
        ? { contents: [] }
        : { contents: [{ uri: input.uri, text: JSON.stringify(resource) }] };
    }
  }
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(
      url: URL,
      options: {
        fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        requestInit?: RequestInit;
      }
    ) {
      canaryState.transport = { url: url.toString(), options };
    }
  }
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_REF = `system.synthetic.${PROJECT_ID}`;
const REPOSITORY_ID = "33333333-3333-4333-8333-333333333333";
const ANALYSIS_CANDIDATE_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "session-1";
const PROMOTION_CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
const QUALITY_WORKFLOW_ID = "55555555-5555-4555-8555-555555555555";
const MEMORY_ID = "memory-1";
const REVISION_ID = "revision-1";
const FORMAL_CONTENT =
  "EdgeMneme stores formal memory in D1 and treats search indexes as rebuildable projections.";
let temporaryDirectory: string | undefined;

describe("synthetic MCP canary client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    canaryState.transport = null;
    canaryState.calls.length = 0;
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  it("verifies every MCP resource template before reporting success", async () => {
    const networkFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://edgemneme-test.workers.dev/mcp"
    });
    vi.stubGlobal("fetch", networkFetch);
    vi.stubEnv("EDGEMNEME_GATEWAY_URL", "https://edgemneme-test.workers.dev/mcp");
    vi.stubEnv("EDGEMNEME_GATEWAY_EXPECTED_HOST", "edgemneme-test.workers.dev");
    vi.stubEnv("EDGEMNEME_CANARY_TOKEN", "synthetic-token");
    vi.stubEnv("EDGEMNEME_CANARY_PROJECT_REF", PROJECT_REF);
    vi.stubEnv("EDGEMNEME_CANARY_PROJECT_ID", PROJECT_ID);
    vi.stubEnv("EDGEMNEME_CANARY_REPOSITORY_ID", REPOSITORY_ID);
    vi.stubEnv("EDGEMNEME_CANARY_PROMOTION_CANDIDATE_ID", PROMOTION_CANDIDATE_ID);
    temporaryDirectory = mkdtempSync(join(tmpdir(), "edgemneme-canary-client-test-"));
    const resultFile = join(temporaryDirectory, "result.json");
    vi.stubEnv("EDGEMNEME_CANARY_RESULT_FILE", resultFile);
    const formalEvidenceLocator = `${PROJECT_REF}/formal-promotion`;
    const formalEvidenceId = createHash("sha256")
      .update(`${PROJECT_ID}\nsynthetic_canary\n${formalEvidenceLocator}`)
      .digest("hex");
    const indexedMemory = {
      memory_id: MEMORY_ID,
      revision_id: REVISION_ID,
      memory_version: 1
    };
    const expectedResourceUris = [
      `memory://projects/${PROJECT_REF}/manifest`,
      `memory://projects/${PROJECT_REF}/memories/${MEMORY_ID}`,
      `memory://projects/${PROJECT_REF}/indexes/by-kind/fact`,
      `memory://projects/${PROJECT_REF}/indexes/by-class/semantic`,
      `memory://projects/${PROJECT_REF}/memories/${MEMORY_ID}/versions/1`,
      `memory://projects/${PROJECT_REF}/candidates/${PROMOTION_CANDIDATE_ID}`,
      `memory://projects/${PROJECT_REF}/evidence/${formalEvidenceId}`,
      `memory://projects/${PROJECT_REF}/workflows/${QUALITY_WORKFLOW_ID}`,
      `memory://projects/${PROJECT_REF}/audit/${PROJECT_ID}:1`
    ];
    const resources = [
      {
        project_id: PROJECT_ID,
        project_version: 1,
        memories: [indexedMemory]
      },
      {
        revision_id: REVISION_ID,
        memory_version: 1,
        content: FORMAL_CONTENT
      },
      {
        project_id: PROJECT_ID,
        project_version: 1,
        dimension: { type: "kind", value: "fact" },
        memories: [indexedMemory]
      },
      {
        project_id: PROJECT_ID,
        project_version: 1,
        dimension: { type: "class", value: "semantic" },
        memories: [indexedMemory]
      },
      {
        memory_id: MEMORY_ID,
        revision_id: REVISION_ID,
        memory_version: 1,
        content: FORMAL_CONTENT
      },
      {
        observation_id: PROMOTION_CANDIDATE_ID,
        candidate_version: 2,
        status: "promoted"
      },
      {
        evidence_id: formalEvidenceId,
        source_type: "synthetic_canary",
        locator: formalEvidenceLocator,
        sensitivity_status: "clear"
      },
      {
        workflow_id: QUALITY_WORKFLOW_ID,
        root_workflow_id: QUALITY_WORKFLOW_ID,
        workflow_type: "candidate.submitted",
        status: "complete"
      },
      {
        audit_id: `${PROJECT_ID}:1`,
        sequence: 1,
        event_type: "candidate_promoted"
      }
    ];
    canaryState.resources = new Map(
      expectedResourceUris.map((uri, index) => [uri, resources[index] ?? {}])
    );
    const log = vi.spyOn(console, "log").mockImplementation((message) => {
      canaryState.events.push(`log:${String(message)}`);
    });

    // @ts-expect-error The production canary is an executable JavaScript module.
    await import("../scripts/synthetic-canary-client.mjs");

    expect(canaryState.transport?.url).toBe(
      "https://edgemneme-test.workers.dev/mcp"
    );
    expect(canaryState.transport?.options.requestInit).toEqual({
      headers: { authorization: "Bearer synthetic-token" }
    });
    expect(canaryState.calls.find((call) => call.name === "session_open")).toEqual({
      name: "session_open",
      arguments: {
        project_ref: PROJECT_REF,
        agent_meta: { agent: "synthetic-canary", purpose: "production-readiness" },
        worktree_meta: {
          repository_id: REPOSITORY_ID,
          repository_ref: "refs/heads/main"
        }
      }
    });
    expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({
      candidate_id: ANALYSIS_CANDIDATE_ID,
      workflow_id: QUALITY_WORKFLOW_ID
    });
    expect(statSync(resultFile).mode & 0o777).toBe(0o600);
    const transportFetch = canaryState.transport?.options.fetch;
    expect(transportFetch).toBeTypeOf("function");
    if (transportFetch === undefined) {
      throw new Error("Synthetic transport did not receive a pinned fetch implementation.");
    }
    const methodInputs = [
      {
        input: new Request("https://edgemneme-test.workers.dev/mcp"),
        method: "GET"
      },
      { input: new URL("https://edgemneme-test.workers.dev/mcp"), method: "POST" },
      { input: "https://edgemneme-test.workers.dev/mcp", method: "DELETE" }
    ];
    for (const { input, method } of methodInputs) {
      await expect(
        transportFetch(input, { method })
      ).resolves.toMatchObject({ ok: true });
    }
    expect(
      networkFetch.mock.calls.slice(0, 3).map(([, init]) => ({
        method: init?.method,
        redirect: init?.redirect
      }))
    ).toEqual([
      { method: "GET", redirect: "manual" },
      { method: "POST", redirect: "manual" },
      { method: "DELETE", redirect: "manual" }
    ]);

    const networkCallCount = networkFetch.mock.calls.length;
    await expect(
      transportFetch("https://credential-capture.attacker.workers.dev/mcp", {
        method: "POST"
      })
    ).rejects.toThrow(/expected HTTPS \/mcp endpoint/iu);
    expect(networkFetch).toHaveBeenCalledTimes(networkCallCount);

    networkFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      url: "https://edgemneme-test.workers.dev/mcp"
    });
    await expect(
      transportFetch("https://edgemneme-test.workers.dev/mcp", { method: "GET" })
    ).rejects.toThrow(/redirect/iu);

    networkFetch.mockResolvedValueOnce({
      ok: true,
      redirected: true,
      status: 200,
      type: "basic",
      url: "https://edgemneme-test.workers.dev/mcp"
    });
    await expect(
      transportFetch("https://edgemneme-test.workers.dev/mcp", { method: "POST" })
    ).rejects.toThrow(/redirect/iu);

    networkFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "https://credential-capture.attacker.workers.dev/mcp"
    });
    await expect(
      transportFetch("https://edgemneme-test.workers.dev/mcp", { method: "DELETE" })
    ).rejects.toThrow(/unexpected URL/iu);

    expect(
      canaryState.events.filter((event) => event.startsWith("resource:"))
    ).toEqual(expectedResourceUris.map((uri) => `resource:${uri}`));
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "Synthetic MCP lane passed with all tools and resource templates verified."
    );
    const successIndex = canaryState.events.findIndex((event) => event.startsWith("log:"));
    expect(successIndex).toBeGreaterThan(
      canaryState.events.indexOf(`resource:${expectedResourceUris.at(-1)}`)
    );
  });
});
