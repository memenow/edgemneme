import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error The JavaScript runtime helper has no separate declaration file.
import * as canaryProcess from "../scripts/canary-process.mjs";

const {
  canaryUuid,
  clientEnvironment,
  requireGatewayUrl,
  runProcessCaptureIfFound,
  waitForCredentialPropagation
} = canaryProcess;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("synthetic canary process boundary", () => {
  it("does not pass Cloudflare or application secrets to the MCP client", () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cloudflare-secret");
    vi.stubEnv("TOKEN_DIGEST_PEPPER", "pepper-secret");
    vi.stubEnv("PAGE_TOKEN_HMAC_KEY", "page-secret");
    vi.stubEnv("HOME", "/credential-bearing-home");
    vi.stubEnv("XDG_CONFIG_HOME", "/credential-bearing-config");
    vi.stubEnv("PNPM_HOME", "/package-manager-home");
    vi.stubEnv("COREPACK_HOME", "/corepack-home");

    const environment = clientEnvironment({ EDGEMNEME_GATEWAY_URL: "safe" });

    expect(environment.EDGEMNEME_GATEWAY_URL).toBe("safe");
    expect(environment).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(environment).not.toHaveProperty("TOKEN_DIGEST_PEPPER");
    expect(environment).not.toHaveProperty("PAGE_TOKEN_HMAC_KEY");
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://trusted-gateway.workers.dev/mcp"
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForCredentialPropagation(
        "https://trusted-gateway.workers.dev/mcp",
        "synthetic-bearer",
        "trusted-gateway.workers.dev"
      )
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://trusted-gateway.workers.dev/mcp",
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({ authorization: "Bearer synthetic-bearer" })
      })
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
        "https://trusted-gateway.workers.dev/mcp",
        "synthetic-bearer",
        "trusted-gateway.workers.dev"
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
        "https://trusted-gateway.workers.dev/mcp",
        "synthetic-bearer",
        "trusted-gateway.workers.dev"
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
