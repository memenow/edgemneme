import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error The JavaScript CLI has no separate declaration file.
import * as deploymentStateModule from "../scripts/capture-deployment-state.mjs";
// @ts-expect-error The JavaScript CLI has no separate declaration file.
import * as gatewayTriggerModule from "../scripts/gateway-trigger-state.mjs";

const {
  captureDeploymentState,
  deploymentConfigurationFingerprint,
  verifyDeploymentState,
  writeGitHubOutputs
} = deploymentStateModule;
const { encodeGatewayTriggerState, gatewayTriggerFingerprint } = gatewayTriggerModule;

const ORCHESTRATOR_VERSION = "11111111-1111-4111-8111-111111111111";
const GATEWAY_VERSION = "22222222-2222-4222-8222-222222222222";
const GITHUB_SYNC_VERSION = "33333333-3333-4333-8333-333333333333";
const PRESENT_GATEWAY_TRIGGER = {
  schema: 1,
  script: "edgemneme-memory-gateway",
  worker_present: true,
  workers_dev: { enabled: true, previews_enabled: false },
  custom_domains: [],
  routes: []
};
const ABSENT_GATEWAY_TRIGGER = {
  schema: 1,
  script: "edgemneme-memory-gateway",
  worker_present: false,
  workers_dev: null,
  custom_domains: [],
  routes: []
};

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
    CLOUDFLARE_API_TOKEN: "synthetic-token",
    CF_D1_MEMORY_DATABASE_ID: "memory-database",
    CF_D1_SEARCH_DATABASE_ID: "search-database",
    CF_RATE_LIMIT_NAMESPACE_EDGE: "edge-rate-limit",
    CF_RATE_LIMIT_NAMESPACE_CLIENT: "client-rate-limit",
    CF_RATE_LIMIT_NAMESPACE_PRINCIPAL: "principal-rate-limit",
    ENABLE_GITHUB_SYNC: "true",
    GITHUB_CREDENTIAL_VERSION: "synthetic-credential-version",
    EDGEMNEME_DEPLOYMENT_MODE: "normal",
    GITHUB_EVENT_NAME: "push",
    ...overrides
  };
}

function deployment(versionId: string, percentage = 100): Record<string, unknown> {
  return {
    created_on: "2026-07-31T12:00:00.000Z",
    versions: [{ version_id: versionId, percentage }]
  };
}

function cloudflareFetch(options: {
  absentWorkers?: ReadonlySet<string>;
  versions?: Readonly<Record<string, string>>;
  githubPercentage?: number;
  schedules?: ReadonlyArray<Record<string, unknown>>;
  secrets?: ReadonlyArray<Record<string, unknown>>;
  requests?: string[];
} = {}): typeof fetch {
  const versions: Record<string, string> = {
    "edgemneme-memory-orchestrator": ORCHESTRATOR_VERSION,
    "edgemneme-memory-gateway": GATEWAY_VERSION,
    "edgemneme-github-sync": GITHUB_SYNC_VERSION,
    ...options.versions
  };
  return (async (input, init) => {
    const url = new URL(String(input));
    options.requests?.push(url.toString());
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(init?.redirect).toBe("manual");

    const deploymentMatch = url.pathname.match(/\/workers\/scripts\/([^/]+)\/deployments$/u);
    if (deploymentMatch !== null) {
      const workerName = decodeURIComponent(deploymentMatch[1] ?? "");
      if (options.absentWorkers?.has(workerName) === true) {
        return new Response(null, { status: 404 });
      }
      const version = versions[workerName];
      if (version === undefined) {
        throw new Error(`Unexpected synthetic Worker ${workerName}.`);
      }
      const percentage =
        workerName === "edgemneme-github-sync" ? options.githubPercentage : undefined;
      return Response.json({
        success: true,
        result: { deployments: [deployment(version, percentage)] }
      });
    }
    if (url.pathname.endsWith("/workers/scripts/edgemneme-github-sync/schedules")) {
      return Response.json({
        success: true,
        result: { schedules: options.schedules ?? [{ cron: "0 */6 * * *" }] }
      });
    }
    if (url.pathname.endsWith("/workers/scripts/edgemneme-github-sync/secrets")) {
      return Response.json({
        success: true,
        result: options.secrets ?? [
          { name: "GITHUB_CLASSIC_TOKEN", type: "secret_text" }
        ]
      });
    }
    if (url.pathname === "/client/v4/zones") {
      expect(url.searchParams.get("account.id")).toBe("synthetic-account");
      return Response.json({
        success: true,
        result: [],
        result_info: {
          page: 1,
          per_page: 50,
          count: 0,
          total_count: 0,
          total_pages: 0
        }
      });
    }
    if (url.pathname.endsWith("/workers/domains")) {
      expect(url.searchParams.get("service")).toBe("edgemneme-memory-gateway");
      return Response.json({
        success: true,
        result: [],
        result_info: {
          count: 0,
          page: 1,
          per_page: 0,
          total_count: 2_000,
          total_pages: 100
        }
      });
    }
    if (url.pathname.endsWith("/workers/scripts/edgemneme-memory-gateway/subdomain")) {
      if (options.absentWorkers?.has("edgemneme-memory-gateway") === true) {
        return new Response(null, { status: 404 });
      }
      return Response.json({
        success: true,
        result: { enabled: true, previews_enabled: false }
      });
    }
    if (url.pathname.endsWith("/workers/subdomain")) {
      return Response.json({ success: true, result: { subdomain: "synthetic-account" } });
    }
    throw new Error(`Unexpected synthetic Cloudflare request ${url.pathname}.`);
  }) as typeof fetch;
}

describe("deployment state capture", () => {
  it("writes the bounded state as GitHub job outputs", () => {
    const directory = mkdtempSync(join(tmpdir(), "edgemneme-state-"));
    const outputPath = join(directory, "github-output");
    try {
      writeGitHubOutputs(outputPath, {
        orchestrator_version: ORCHESTRATOR_VERSION,
        bootstrap_mode: "false"
      });
      expect(readFileSync(outputPath, "utf8")).toBe(
        `orchestrator_version=${ORCHESTRATOR_VERSION}\nbootstrap_mode=false\n`
      );
      expect(() =>
        writeGitHubOutputs(outputPath, { invalid: "line-one\nline-two" })
      ).toThrow("output invalid is invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("captures immutable rollback inputs before an enabled deployment", async () => {
    const captureEnvironment = environment();
    const state = await captureDeploymentState(captureEnvironment, cloudflareFetch());

    expect(state).toEqual({
      orchestrator_version: ORCHESTRATOR_VERSION,
      gateway_version: GATEWAY_VERSION,
      gateway_trigger_state: encodeGatewayTriggerState(PRESENT_GATEWAY_TRIGGER),
      gateway_trigger_fingerprint: gatewayTriggerFingerprint(PRESENT_GATEWAY_TRIGGER),
      github_sync_version: GITHUB_SYNC_VERSION,
      github_sync_state: "present",
      github_sync_schedule_state: "enabled",
      github_sync_secret_state: "present",
      bootstrap_mode: "false",
      configuration_fingerprint: deploymentConfigurationFingerprint(captureEnvironment)
    });
  });

  it("binds rollback to the exact non-secret production configuration", () => {
    const production = environment();
    const matchingRollback = environment({ CLOUDFLARE_API_TOKEN: "different-token" });
    const wrongDatabase = environment({ CF_D1_MEMORY_DATABASE_ID: "wrong-database" });
    const wrongSyncTarget = environment({ ENABLE_GITHUB_SYNC: "false" });

    expect(deploymentConfigurationFingerprint(matchingRollback)).toBe(
      deploymentConfigurationFingerprint(production)
    );
    expect(deploymentConfigurationFingerprint(wrongDatabase)).not.toBe(
      deploymentConfigurationFingerprint(production)
    );
    expect(deploymentConfigurationFingerprint(wrongSyncTarget)).not.toBe(
      deploymentConfigurationFingerprint(production)
    );
  });

  it("captures lifecycle metadata even when sync is disabled", async () => {
    const requests: string[] = [];
    const state = await captureDeploymentState(
      environment({ ENABLE_GITHUB_SYNC: "false" }),
      cloudflareFetch({ requests })
    );

    expect(state.github_sync_state).toBe("present");
    expect(state.github_sync_version).toBe(GITHUB_SYNC_VERSION);
    expect(state.github_sync_schedule_state).toBe("enabled");
    expect(state.github_sync_secret_state).toBe("present");
    expect(requests.some((request) => request.endsWith("/schedules"))).toBe(true);
    expect(requests.some((request) => request.endsWith("/secrets"))).toBe(true);
  });

  it("permits bootstrap-empty only when all enabled Workers are absent", async () => {
    const absentWorkers = new Set([
      "edgemneme-memory-orchestrator",
      "edgemneme-memory-gateway",
      "edgemneme-github-sync",
    ]);
    const state = await captureDeploymentState(
      environment({
        EDGEMNEME_DEPLOYMENT_MODE: "bootstrap-empty",
        GITHUB_EVENT_NAME: "workflow_dispatch"
      }),
      cloudflareFetch({ absentWorkers })
    );

    expect(state.orchestrator_version).toBe("");
    expect(state.gateway_version).toBe("");
    expect(state.gateway_trigger_state).toBe(
      encodeGatewayTriggerState(ABSENT_GATEWAY_TRIGGER)
    );
    expect(state.github_sync_state).toBe("absent");
    expect(state.bootstrap_mode).toBe("true");
  });

  it("captures the existing orchestrator for a manual gateway recovery", async () => {
    const absentWorkers = new Set([
      "edgemneme-memory-gateway",
      "edgemneme-github-sync",
    ]);
    const state = await captureDeploymentState(
      environment({
        EDGEMNEME_DEPLOYMENT_MODE: "bootstrap-recover-gateway",
        GITHUB_EVENT_NAME: "workflow_dispatch"
      }),
      cloudflareFetch({ absentWorkers })
    );

    expect(state.orchestrator_version).toBe(ORCHESTRATOR_VERSION);
    expect(state.gateway_version).toBe("");
    expect(state.gateway_trigger_state).toBe(
      encodeGatewayTriggerState(ABSENT_GATEWAY_TRIGGER)
    );
    expect(state.github_sync_state).toBe("absent");
    expect(state.bootstrap_mode).toBe("true");
  });

  it("defaults to normal deployment mode", async () => {
    const captureEnvironment = environment();
    delete captureEnvironment.EDGEMNEME_DEPLOYMENT_MODE;

    await expect(
      captureDeploymentState(captureEnvironment, cloudflareFetch())
    ).resolves.toMatchObject({
      orchestrator_version: ORCHESTRATOR_VERSION,
      gateway_version: GATEWAY_VERSION,
      bootstrap_mode: "false"
    });
  });

  it("rejects unsupported deployment modes before querying Cloudflare", async () => {
    let queried = false;
    const fetchImpl = (async () => {
      queried = true;
      throw new Error("unexpected query");
    }) as typeof fetch;

    await expect(
      captureDeploymentState(
        environment({ EDGEMNEME_DEPLOYMENT_MODE: "bootstrap" }),
        fetchImpl
      )
    ).rejects.toThrow("must be exactly normal, bootstrap-empty, or bootstrap-recover-gateway");
    expect(queried).toBe(false);
  });

  it.each(["bootstrap-empty", "bootstrap-recover-gateway"])(
    "rejects %s outside workflow_dispatch",
    async (deploymentMode) => {
      const absentWorkers =
        deploymentMode === "bootstrap-empty"
          ? new Set([
              "edgemneme-memory-orchestrator",
              "edgemneme-memory-gateway",
              "edgemneme-github-sync"
            ])
          : new Set(["edgemneme-memory-gateway", "edgemneme-github-sync"]);

      await expect(
        captureDeploymentState(
          environment({ EDGEMNEME_DEPLOYMENT_MODE: deploymentMode }),
          cloudflareFetch({ absentWorkers })
        )
      ).rejects.toThrow("allowed only from a manual workflow_dispatch run");
    }
  );

  it.each([
    {
      label: "the orchestrator exists",
      absentWorkers: new Set(["edgemneme-memory-gateway", "edgemneme-github-sync"]),
    },
    {
      label: "the gateway exists",
      absentWorkers: new Set(["edgemneme-memory-orchestrator", "edgemneme-github-sync"]),
    },
  ])("rejects bootstrap-empty when $label", async ({ absentWorkers }) => {
    await expect(
      captureDeploymentState(
        environment({
          EDGEMNEME_DEPLOYMENT_MODE: "bootstrap-empty",
          GITHUB_EVENT_NAME: "workflow_dispatch",
        }),
        cloudflareFetch({ absentWorkers }),
      ),
    ).rejects.toThrow("bootstrap-empty expected both core Workers to be absent");
  });

  it.each([
    {
      label: "the orchestrator is absent",
      absentWorkers: new Set([
        "edgemneme-memory-orchestrator",
        "edgemneme-memory-gateway",
        "edgemneme-github-sync",
      ]),
    },
    {
      label: "the gateway exists",
      absentWorkers: new Set(["edgemneme-github-sync"]),
    },
  ])("rejects gateway recovery when $label", async ({ absentWorkers }) => {
    await expect(
      captureDeploymentState(
        environment({
          EDGEMNEME_DEPLOYMENT_MODE: "bootstrap-recover-gateway",
          GITHUB_EVENT_NAME: "workflow_dispatch",
        }),
        cloudflareFetch({ absentWorkers }),
      ),
    ).rejects.toThrow(
      "bootstrap-recover-gateway expected the orchestrator Worker to be present and the gateway Worker to be absent",
    );
  });

  it.each(["bootstrap-empty", "bootstrap-recover-gateway"])(
    "rejects an enabled GitHub sync Worker during %s",
    async (deploymentMode) => {
      const absentWorkers =
        deploymentMode === "bootstrap-empty"
          ? new Set(["edgemneme-memory-orchestrator", "edgemneme-memory-gateway"])
          : new Set(["edgemneme-memory-gateway"]);

      await expect(
        captureDeploymentState(
          environment({
            EDGEMNEME_DEPLOYMENT_MODE: deploymentMode,
            GITHUB_EVENT_NAME: "workflow_dispatch",
          }),
          cloudflareFetch({ absentWorkers }),
        ),
      ).rejects.toThrow("expected the enabled GitHub sync Worker to be absent");
    }
  );

  it("rejects absent core Workers in normal mode", async () => {
    await expect(
      captureDeploymentState(
        environment(),
        cloudflareFetch({ absentWorkers: new Set(["edgemneme-memory-gateway"]) })
      )
    ).rejects.toThrow("Deployment mode normal requires both core Workers to be present");
  });

  it("rejects non-atomic active deployments", async () => {
    await expect(
      captureDeploymentState(environment(), cloudflareFetch({ githubPercentage: 50 }))
    ).rejects.toThrow("not a single 100% version");
  });

  it("rejects missing or unexpected enabled credential bindings", async () => {
    await expect(
      captureDeploymentState(environment(), cloudflareFetch({ secrets: [] }))
    ).rejects.toThrow("missing its credential binding");

    await expect(
      captureDeploymentState(
        environment(),
        cloudflareFetch({
          secrets: [
            { name: "GITHUB_CLASSIC_TOKEN", type: "secret_text" },
            { name: "UNEXPECTED_SECRET", type: "secret_text" }
          ]
        })
      )
    ).rejects.toThrow("unexpected secret binding");
  });

  it("rejects redirects instead of forwarding Cloudflare authorization", async () => {
    const redirectingFetch = (async () => new Response(null, { status: 302 })) as typeof fetch;

    await expect(
      captureDeploymentState(environment(), redirectingFetch)
    ).rejects.toThrow("HTTP 302");
  });

  it("rejects selected Worker state that drifted after capture", async () => {
    await expect(
      verifyDeploymentState(
        ["orchestrator_version", "gateway_version"],
        environment({
          EXPECTED_ORCHESTRATOR_VERSION: ORCHESTRATOR_VERSION,
          EXPECTED_GATEWAY_VERSION: GATEWAY_VERSION
        }),
        cloudflareFetch()
      )
    ).resolves.toMatchObject({ gateway_version: GATEWAY_VERSION });

    await expect(
      verifyDeploymentState(
        ["gateway_version"],
        environment({ EXPECTED_GATEWAY_VERSION: ORCHESTRATOR_VERSION }),
        cloudflareFetch()
      )
    ).rejects.toThrow("gateway_version changed");
  });
});
