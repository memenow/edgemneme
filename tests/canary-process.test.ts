import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error The JavaScript runtime helper has no separate declaration file.
import * as canaryProcess from "../scripts/canary-process.mjs";

const {
  canaryUuid,
  clientEnvironment,
  createPinnedGatewayFetch,
  requireGatewayUrl,
  runProcessCaptureIfFound,
  waitForCredentialPropagation
} = canaryProcess;

const GATEWAY_URL = "https://trusted-gateway.workers.dev/mcp";
const GATEWAY_HOST = "trusted-gateway.workers.dev";
const GATEWAY_VERSION = "123e4567-e89b-42d3-a456-426614174000";

function gatewayResponse(
  options: {
    body?: string;
    contentType?: string;
    redirected?: boolean;
    status?: number;
    type?: ResponseType;
    url?: string;
    version?: string | null;
  } = {}
): Response {
  const headers = new Headers();
  if (options.contentType !== undefined) {
    headers.set("content-type", options.contentType);
  }
  if (options.version !== null) {
    headers.set(
      "x-edgemneme-worker-version",
      options.version ?? GATEWAY_VERSION
    );
  }
  const response = new Response(options.body ?? "", {
    status: options.status ?? 200,
    headers
  });
  Object.defineProperties(response, {
    redirected: { value: options.redirected ?? false },
    type: { value: options.type ?? "default" },
    url: { value: options.url ?? GATEWAY_URL }
  });
  return response;
}

function cloudflare1104Response(): Response {
  return gatewayResponse({
    body: JSON.stringify({
      type: "https://developers.cloudflare.com/workers/observability/errors/#error-1104",
      title: "Error 1104: Script not found",
      status: 500,
      detail: "The Worker script required to render this page could not be found.",
      error_code: 1104,
      error_name: "worker_script_not_found",
      error_category: "worker",
      cloudflare_error: true
    }),
    contentType: "application/json",
    status: 500,
    version: null
  });
}

function readinessOptions(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { expectedVersion: GATEWAY_VERSION, ...overrides };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("synthetic canary process boundary", () => {
  it("does not pass Cloudflare or application secrets to the MCP client", () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cloudflare-secret");
    vi.stubEnv("TOKEN_DIGEST_PEPPER", "pepper-secret");
    vi.stubEnv("HOME", "/credential-bearing-home");
    vi.stubEnv("XDG_CONFIG_HOME", "/credential-bearing-config");
    vi.stubEnv("PNPM_HOME", "/package-manager-home");
    vi.stubEnv("COREPACK_HOME", "/corepack-home");

    const environment = clientEnvironment({ EDGEMNEME_GATEWAY_URL: "safe" });

    expect(environment.EDGEMNEME_GATEWAY_URL).toBe("safe");
    expect(environment).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(environment).not.toHaveProperty("TOKEN_DIGEST_PEPPER");
    expect(environment).not.toHaveProperty("HOME");
    expect(environment).not.toHaveProperty("XDG_CONFIG_HOME");
    expect(environment).not.toHaveProperty("PNPM_HOME");
    expect(environment).not.toHaveProperty("COREPACK_HOME");
  });

  it("requires deterministic cleanup identities and validates configured UUIDs", () => {
    vi.stubEnv("CANARY_TEST_UUID", "");
    expect(() => canaryUuid("CANARY_TEST_UUID", true)).toThrow(/cleanup-only/iu);

    vi.stubEnv("CANARY_TEST_UUID", "not-a-uuid");
    expect(() => canaryUuid("CANARY_TEST_UUID", false)).toThrow(/UUID/u);

    vi.stubEnv("CANARY_TEST_UUID", "5C630A77-2E9B-4BDF-991F-89141C2FB965");
    expect(canaryUuid("CANARY_TEST_UUID", true)).toBe(
      "5c630a77-2e9b-4bdf-991f-89141c2fb965"
    );
  });

  it("allows only the expected HTTPS MCP endpoint", () => {
    vi.stubEnv("CANARY_GATEWAY_URL", "https://edge.example.com/mcp");
    expect(requireGatewayUrl("CANARY_GATEWAY_URL", "edge.example.com")).toBe(
      "https://edge.example.com/mcp"
    );

    for (const unsafe of [
      "http://edge.example.com/mcp",
      "https://other.example.com/mcp",
      "https://user:password@edge.example.com/mcp",
      "https://edge.example.com/mcp?token=1",
      "https://edge.example.com/other"
    ]) {
      vi.stubEnv("CANARY_GATEWAY_URL", unsafe);
      expect(() => requireGatewayUrl("CANARY_GATEWAY_URL", "edge.example.com")).toThrow(
        /HTTPS \/mcp/iu
      );
    }
  });

  it("requires an explicit expected host instead of trusting a workers.dev suffix", () => {
    vi.stubEnv(
      "CANARY_GATEWAY_URL",
      "https://credential-capture.attacker.workers.dev/mcp"
    );
    vi.stubEnv("EDGEMNEME_GATEWAY_EXPECTED_HOST", "");

    expect(() => requireGatewayUrl("CANARY_GATEWAY_URL")).toThrow(
      /EXPECTED_HOST is required/u
    );
    expect(() =>
      requireGatewayUrl("CANARY_GATEWAY_URL", "trusted-gateway.workers.dev")
    ).toThrow(/HTTPS \/mcp/iu);
  });

  it("rejects malformed expected host values", () => {
    vi.stubEnv("CANARY_GATEWAY_URL", "https://trusted-gateway.workers.dev/mcp");

    for (const malformed of [
      "https://trusted-gateway.workers.dev",
      "user@trusted-gateway.workers.dev",
      "trusted-gateway.workers.dev:443",
      "trusted-gateway.workers.dev/path",
      "trusted-gateway.workers.dev?query",
      "trusted-gateway.workers.dev\n"
    ]) {
      expect(() => requireGatewayUrl("CANARY_GATEWAY_URL", malformed)).toThrow(
        /valid hostname/iu
      );
    }
  });

  it("does not send a bearer token when the propagation target is not host-bound", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForCredentialPropagation(
        "https://credential-capture.attacker.workers.dev/mcp",
        "synthetic-bearer",
        "trusted-gateway.workers.dev"
      )
    ).rejects.toThrow(/HTTPS \/mcp/iu);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the propagation probe only to the exact host without redirect following", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(gatewayResponse())
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForCredentialPropagation(
        GATEWAY_URL,
        "synthetic-bearer",
        GATEWAY_HOST,
        readinessOptions({
          consecutiveSuccesses: 3,
          maxAttempts: 3,
          retryDelayMs: 0,
          delayImplementation: vi.fn()
        })
      )
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      GATEWAY_URL,
      expect.objectContaining({
        redirect: "manual"
      })
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer synthetic-bearer");
    expect(headers.get("Cloudflare-Workers-Version-Overrides")).toBe(
      `edgemneme-memory-gateway="${GATEWAY_VERSION}"`
    );
  });

  it("retries an exact Cloudflare 500/1104 and requires a fresh stable success streak", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gatewayResponse())
      .mockResolvedValueOnce(gatewayResponse())
      .mockResolvedValueOnce(cloudflare1104Response())
      .mockImplementation(() => Promise.resolve(gatewayResponse()));
    const delayImplementation = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForCredentialPropagation(
        GATEWAY_URL,
        "synthetic-bearer",
        GATEWAY_HOST,
        readinessOptions({
          consecutiveSuccesses: 3,
          maxAttempts: 7,
          retryDelayMs: 5,
          delayImplementation
        })
      )
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(delayImplementation).toHaveBeenCalledTimes(5);
    expect(delayImplementation).toHaveBeenCalledWith(5);
  });

  it("fails when the gateway never sustains the required success streak", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(gatewayResponse())
      .mockResolvedValueOnce(cloudflare1104Response())
      .mockResolvedValueOnce(gatewayResponse())
      .mockResolvedValueOnce(cloudflare1104Response());
    const delayImplementation = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForCredentialPropagation(
        GATEWAY_URL,
        "synthetic-bearer",
        GATEWAY_HOST,
        readinessOptions({
          consecutiveSuccesses: 2,
          maxAttempts: 4,
          retryDelayMs: 0,
          delayImplementation
        })
      )
    ).rejects.toThrow(/propagation window/iu);
    expect(delayImplementation).toHaveBeenCalledTimes(3);
  });

  it("does not retry unrelated HTTP failures or transport timeouts", async () => {
    const unrelatedFailure = gatewayResponse({
      body: JSON.stringify({
        status: 500,
        error_code: 1104,
        error_name: "worker_script_not_found",
        cloudflare_error: false
      }),
      contentType: "application/json",
      status: 500,
      version: null
    });
    const fetchMock = vi.fn().mockResolvedValue(unrelatedFailure);
    const delayImplementation = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForCredentialPropagation(
        GATEWAY_URL,
        "synthetic-bearer",
        GATEWAY_HOST,
        readinessOptions({ delayImplementation })
      )
    ).rejects.toThrow(/expected Worker version/iu);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(delayImplementation).not.toHaveBeenCalled();

    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const timeoutFetch = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal("fetch", timeoutFetch);
    await expect(
      waitForCredentialPropagation(
        GATEWAY_URL,
        "synthetic-bearer",
        GATEWAY_HOST,
        readinessOptions({ delayImplementation })
      )
    ).rejects.toBe(timeout);
    expect(timeoutFetch).toHaveBeenCalledOnce();
    expect(delayImplementation).not.toHaveBeenCalled();
  });

  it("requires every pinned response to prove the exact gateway version", async () => {
    for (const version of [null, "987e6543-e21b-43d3-b654-426614174111"]) {
      const fetchMock = vi.fn().mockResolvedValue(gatewayResponse({ version }));
      const pinnedFetch = createPinnedGatewayFetch(
        GATEWAY_URL,
        GATEWAY_HOST,
        GATEWAY_VERSION,
        fetchMock
      );
      await expect(pinnedFetch(GATEWAY_URL)).rejects.toThrow(
        /expected Worker version/iu
      );
    }

    const exactFetch = vi.fn().mockResolvedValue(gatewayResponse());
    const pinnedFetch = createPinnedGatewayFetch(
      GATEWAY_URL,
      GATEWAY_HOST,
      GATEWAY_VERSION,
      exactFetch
    );
    await expect(
      pinnedFetch(new Request(GATEWAY_URL, { headers: { "x-request": "one" } }), {
        headers: { authorization: "Bearer synthetic-bearer" }
      })
    ).resolves.toMatchObject({ ok: true });
    const headers = exactFetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-request")).toBe("one");
    expect(headers.get("authorization")).toBe("Bearer synthetic-bearer");
    expect(headers.get("Cloudflare-Workers-Version-Overrides")).toBe(
      `edgemneme-memory-gateway="${GATEWAY_VERSION}"`
    );
  });

  it("refuses redirects and cross-origin responses at the bearer request boundary", async () => {
    const redirectFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      url: "https://trusted-gateway.workers.dev/mcp"
    });
    vi.stubGlobal("fetch", redirectFetch);

    await expect(
      waitForCredentialPropagation(
        GATEWAY_URL,
        "synthetic-bearer",
        GATEWAY_HOST,
        readinessOptions()
      )
    ).rejects.toThrow(/redirect/iu);
    expect(redirectFetch).toHaveBeenCalledOnce();
    expect(redirectFetch).toHaveBeenCalledWith(
      "https://trusted-gateway.workers.dev/mcp",
      expect.objectContaining({ redirect: "manual" })
    );

    const crossOriginFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://credential-capture.attacker.workers.dev/mcp"
    });
    vi.stubGlobal("fetch", crossOriginFetch);

    await expect(
      waitForCredentialPropagation(
        GATEWAY_URL,
        "synthetic-bearer",
        GATEWAY_HOST,
        readinessOptions()
      )
    ).rejects.toThrow(/unexpected URL/iu);
    expect(crossOriginFetch).toHaveBeenCalledOnce();
  });

  it("treats only the exact missing-object marker as an optional miss", () => {
    const environment = clientEnvironment({});
    expect(
      runProcessCaptureIfFound(
        process.execPath,
        ["-e", "process.stderr.write('not found marker'); process.exit(1)"],
        "probe",
        "not found marker",
        environment
      )
    ).toBeNull();
    expect(() =>
      runProcessCaptureIfFound(
        process.execPath,
        ["-e", "process.stderr.write('authorization failed'); process.exit(1)"],
        "probe",
        "not found marker",
        environment
      )
    ).toThrow(/probe failed/iu);
  });
});
