import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error The JavaScript CLI has no separate declaration file.
import * as deploymentTargetModule from "../scripts/gateway-deployment-target.mjs";
// @ts-expect-error The JavaScript CLI has no separate declaration file.
import * as triggerStateModule from "../scripts/gateway-trigger-state.mjs";

const {
  captureGatewayCanaryTarget,
  captureGatewayRollbackCurrent,
  verifyGatewayCanaryTarget,
  verifyGatewayPredeploy
} = deploymentTargetModule;
const {
  encodeGatewayTriggerState,
  gatewayTriggerFingerprint,
  observeGatewayTriggerState,
  restoreGatewayTriggerState
} = triggerStateModule;

const GATEWAY = "edgemneme-memory-gateway";
const ACTIVE_VERSION = "22222222-2222-4222-8222-222222222222";
const DRIFTED_VERSION = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_TAG = "github-123-1-gateway";

type Domain = {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
  environment: string;
};

type Route = { id: string; pattern: string; script: string };

type RemoteState = {
  workersDev: { enabled: boolean; previews_enabled: boolean } | null;
  domains: Domain[];
  routes: Route[];
  accountSubdomain: string;
  returnWrongDomainScript?: boolean;
  subdomainDeleteLeavesDisabled?: boolean;
};

function workersDevState() {
  return {
    schema: 1,
    script: GATEWAY,
    worker_present: true,
    workers_dev: { enabled: true, previews_enabled: false },
    custom_domains: [],
    routes: []
  };
}

function customDomainState(hostname = "memory.example.com") {
  return {
    schema: 1,
    script: GATEWAY,
    worker_present: true,
    workers_dev: { enabled: false, previews_enabled: false },
    custom_domains: [
      {
        hostname,
        zone_id: "zone-one",
        zone_name: "example.com",
        environment: "production"
      }
    ],
    routes: []
  };
}

function absentState() {
  return {
    schema: 1,
    script: GATEWAY,
    worker_present: false,
    workers_dev: null,
    custom_domains: [],
    routes: []
  };
}

function environment(state: Record<string, unknown>, overrides: Record<string, string> = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: "account-one",
    CLOUDFLARE_API_TOKEN: "synthetic-token",
    EXPECTED_GATEWAY_TRIGGER_STATE: encodeGatewayTriggerState(state),
    EXPECTED_GATEWAY_TRIGGER_FINGERPRINT: gatewayTriggerFingerprint(state),
    EXPECTED_GATEWAY_DEPLOYMENT_TAG: DEPLOYMENT_TAG,
    EDGEMNEME_BOOTSTRAP_MODE: "false",
    ...overrides
  };
}

function restoreOptions(
  expectedCurrent: Record<string, unknown>,
  gatewayAdvancedByRun: boolean,
  allowDetachedAbsent = false
) {
  return {
    expectedCurrentEncodedState: encodeGatewayTriggerState(expectedCurrent),
    expectedCurrentFingerprint: gatewayTriggerFingerprint(expectedCurrent),
    gatewayAdvancedByRun,
    allowDetachedAbsent
  };
}

function gatewayConfig(directory: string, options: { domain?: string; name?: string } = {}) {
  const path = join(directory, "gateway.jsonc");
  const config = options.domain === undefined
    ? {
        name: options.name ?? GATEWAY,
        preview_urls: false,
        workers_dev: true
      }
    : {
        name: options.name ?? GATEWAY,
        preview_urls: false,
        workers_dev: false,
        routes: [{ pattern: options.domain, custom_domain: true }]
      };
  writeFileSync(path, `${JSON.stringify(config)}\n`);
  return path;
}

function wranglerRunner(version = ACTIVE_VERSION, tag = DEPLOYMENT_TAG) {
  return (args: string[]) => {
    if (args[0] === "deployments") {
      return [
        {
          created_on: "2026-08-10T12:00:00.000Z",
          versions: [{ version_id: version, percentage: 100 }]
        }
      ];
    }
    if (args[0] === "versions") {
      expect(args[2]).toBe(version);
      return { id: version, annotations: { "workers/tag": tag } };
    }
    throw new Error(`Unexpected Wrangler request ${args.join(" ")}.`);
  };
}

function remoteFetch(state: RemoteState, requests: string[] = []): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(init?.redirect).toBe("manual");

    if (method === "GET" && url.pathname === "/client/v4/zones") {
      return Response.json({
        success: true,
        result: [{ id: "zone-one", name: "example.com", account: { id: "account-one" } }],
        result_info: {
          page: 1,
          per_page: 50,
          count: 1,
          total_count: 1,
          total_pages: 1
        }
      });
    }
    const routeListMatch = url.pathname.match(
      /^\/client\/v4\/zones\/([^/]+)\/workers\/routes$/u
    );
    if (method === "GET" && routeListMatch?.[1] !== undefined) {
      const zoneId = decodeURIComponent(routeListMatch[1]);
      return Response.json({
        success: true,
        result: zoneId === "zone-one" ? state.routes : []
      });
    }
    if (method === "DELETE" && url.pathname.includes("/workers/routes/")) {
      const id = url.pathname.split("/").at(-1);
      state.routes = state.routes.filter((route) => route.id !== id);
      return Response.json({ success: true, result: { id } });
    }
    if (method === "GET" && url.pathname.endsWith("/workers/domains")) {
      const requestedHostname = url.searchParams.get("hostname");
      const domains = requestedHostname === null
        ? state.returnWrongDomainScript
          ? state.domains
          : state.domains.filter((domain) => domain.service === url.searchParams.get("service"))
        : state.domains.filter((domain) => domain.hostname === requestedHostname);
      return Response.json({
        success: true,
        result: domains,
        result_info: { total_count: domains.length }
      });
    }
    if (method === "DELETE" && url.pathname.includes("/workers/domains/")) {
      const id = url.pathname.split("/").at(-1);
      state.domains = state.domains.filter((domain) => domain.id !== id);
      return Response.json({ success: true, result: {} });
    }
    if (method === "PUT" && url.pathname.endsWith("/workers/domains")) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      state.domains.push({
        id: "restored-domain",
        hostname: body.hostname ?? "",
        service: body.service ?? "",
        zone_id: body.zone_id ?? "",
        zone_name: body.zone_name ?? "",
        environment: "production"
      });
      return Response.json({ success: true, result: state.domains.at(-1) });
    }
    if (url.pathname.endsWith(`/workers/scripts/${GATEWAY}/subdomain`)) {
      if (method === "GET") {
        return state.workersDev === null
          ? new Response(null, { status: 404 })
          : Response.json({ success: true, result: state.workersDev });
      }
      if (method === "POST") {
        state.workersDev = JSON.parse(String(init?.body));
        return Response.json({ success: true, result: state.workersDev });
      }
      if (method === "DELETE") {
        state.workersDev = state.subdomainDeleteLeavesDisabled
          ? { enabled: false, previews_enabled: false }
          : null;
        return Response.json({
          success: true,
          result: { enabled: false, previews_enabled: false }
        });
      }
    }
    if (method === "GET" && url.pathname.endsWith("/workers/subdomain")) {
      return Response.json({ success: true, result: { subdomain: state.accountSubdomain } });
    }
    throw new Error(`Unexpected Cloudflare request ${method} ${url.pathname}.`);
  }) as typeof fetch;
}

function workersDevRemote(): RemoteState {
  return {
    workersDev: { enabled: true, previews_enabled: false },
    domains: [],
    routes: [],
    accountSubdomain: "account-workers"
  };
}

describe("gateway deployment target", () => {
  it("derives the canary endpoint from the verified script trigger instead of URL variables", async () => {
    const directory = mkdtempSync(join(tmpdir(), "edgemneme-gateway-target-"));
    try {
      const path = gatewayConfig(directory);
      const target = await captureGatewayCanaryTarget(
        path,
        environment(workersDevState(), {
          EDGEMNEME_GATEWAY_URL: "https://self-consistent-wrong.example/mcp",
          EDGEMNEME_GATEWAY_EXPECTED_HOST: "self-consistent-wrong.example"
        }),
        remoteFetch(workersDevRemote()),
        wranglerRunner()
      );

      expect(target.gateway_active_version).toBe(ACTIVE_VERSION);
      expect(target.gateway_host).toBe(`${GATEWAY}.account-workers.workers.dev`);
      expect(target.gateway_url).toBe(
        `https://${GATEWAY}.account-workers.workers.dev/mcp`
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a rendered trigger change and a custom domain returned for the wrong script", async () => {
    const directory = mkdtempSync(join(tmpdir(), "edgemneme-gateway-drift-"));
    try {
      await expect(
        verifyGatewayPredeploy(
          gatewayConfig(directory, { domain: "memory.example.com" }),
          environment(workersDevState()),
          remoteFetch(workersDevRemote())
        )
      ).rejects.toThrow("rendered gateway trigger differs");

      await expect(
        verifyGatewayPredeploy(
          gatewayConfig(directory, { name: "other-worker" }),
          environment(workersDevState()),
          remoteFetch(workersDevRemote())
        )
      ).rejects.toThrow("wrong script");

      const wrongScriptRemote: RemoteState = {
        workersDev: { enabled: false, previews_enabled: false },
        domains: [
          {
            id: "wrong-domain",
            hostname: "memory.example.com",
            service: "other-worker",
            zone_id: "zone-one",
            zone_name: "example.com",
            environment: "production"
          }
        ],
        routes: [],
        accountSubdomain: "account-workers",
        returnWrongDomainScript: true
      };
      await expect(
        observeGatewayTriggerState(environment(workersDevState()), remoteFetch(wrongScriptRemote))
      ).rejects.toThrow("wrong Worker script");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an invalid bootstrap trigger config before remote mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "edgemneme-gateway-bootstrap-config-"));
    try {
      const path = join(directory, "gateway.jsonc");
      writeFileSync(path, `${JSON.stringify({
        name: GATEWAY,
        preview_urls: true,
        workers_dev: true
      })}\n`);
      const absentRemote: RemoteState = {
        workersDev: null,
        domains: [],
        routes: [],
        accountSubdomain: "account-workers"
      };
      await expect(
        verifyGatewayPredeploy(
          path,
          environment(absentState(), { EDGEMNEME_BOOTSTRAP_MODE: "true" }),
          remoteFetch(absentRemote)
        )
      ).rejects.toThrow("preview contract");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("captures a rollback trigger only while the exact run tag stays active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "edgemneme-gateway-rollback-capture-"));
    try {
      const captured = await captureGatewayRollbackCurrent(
        gatewayConfig(directory),
        environment(workersDevState()),
        remoteFetch(workersDevRemote()),
        wranglerRunner()
      );
      expect(captured).toEqual({
        gateway_active_version: ACTIVE_VERSION,
        gateway_trigger_state: encodeGatewayTriggerState(workersDevState()),
        gateway_trigger_fingerprint: gatewayTriggerFingerprint(workersDevState())
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects version drift during rollback trigger capture", async () => {
    const directory = mkdtempSync(join(tmpdir(), "edgemneme-gateway-rollback-drift-"));
    let deploymentReads = 0;
    const driftingRunner = (args: string[]) => {
      if (args[0] === "deployments") {
        deploymentReads += 1;
        const version = deploymentReads === 1 ? ACTIVE_VERSION : DRIFTED_VERSION;
        return [{
          created_on: "2026-08-10T12:00:00.000Z",
          versions: [{ version_id: version, percentage: 100 }]
        }];
      }
      if (args[0] === "versions") {
        return { id: args[2], annotations: { "workers/tag": DEPLOYMENT_TAG } };
      }
      throw new Error(`Unexpected Wrangler request ${args.join(" ")}.`);
    };
    try {
      await expect(
        captureGatewayRollbackCurrent(
          gatewayConfig(directory),
          environment(workersDevState()),
          remoteFetch(workersDevRemote()),
          driftingRunner
        )
      ).rejects.toThrow("active gateway version changed during rollback trigger capture");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects active version drift after the canary target was captured", async () => {
    const directory = mkdtempSync(join(tmpdir(), "edgemneme-gateway-version-"));
    try {
      await expect(
        verifyGatewayCanaryTarget(
          gatewayConfig(directory),
          environment(workersDevState(), {
            EXPECTED_GATEWAY_ACTIVE_VERSION: ACTIVE_VERSION
          }),
          remoteFetch(workersDevRemote()),
          wranglerRunner(DRIFTED_VERSION)
        )
      ).rejects.toThrow("active gateway version changed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores the captured custom domain trigger after drift", async () => {
    const expected = customDomainState();
    const state = workersDevRemote();

    const restored = await restoreGatewayTriggerState(
      encodeGatewayTriggerState(expected),
      environment(expected),
      remoteFetch(state),
      restoreOptions(workersDevState(), true)
    );

    expect(restored.state).toEqual(expected);
    expect(state.workersDev).toEqual({ enabled: false, previews_enabled: false });
    expect(state.domains).toEqual([
      expect.objectContaining({ hostname: "memory.example.com", service: GATEWAY })
    ]);
  });

  it("removes only failed-bootstrap gateway triggers and preserves other scripts", async () => {
    const requests: string[] = [];
    const state: RemoteState = {
      workersDev: { enabled: true, previews_enabled: false },
      domains: [
        {
          id: "other-domain",
          hostname: "other.example.com",
          service: "other-worker",
          zone_id: "zone-one",
          zone_name: "example.com",
          environment: "production"
        }
      ],
      routes: [
        { id: "other-route", pattern: "other.example.com/*", script: "other-worker" }
      ],
      accountSubdomain: "account-workers"
    };

    const restored = await restoreGatewayTriggerState(
      encodeGatewayTriggerState(absentState()),
      environment(absentState()),
      remoteFetch(state, requests),
      restoreOptions(workersDevState(), true)
    );

    expect(restored.state).toEqual(absentState());
    expect(state.domains).toEqual([expect.objectContaining({ id: "other-domain" })]);
    expect(state.routes).toEqual([expect.objectContaining({ id: "other-route" })]);
    expect(requests).not.toContain(
      "DELETE /client/v4/accounts/account-one/workers/domains/other-domain"
    );
    expect(requests).not.toContain(
      "DELETE /client/v4/zones/zone-one/workers/routes/other-route"
    );
  });

  it("does not reassign a captured custom domain owned by another script", async () => {
    const expected = customDomainState();
    const state: RemoteState = {
      workersDev: { enabled: true, previews_enabled: false },
      domains: [
        {
          id: "other-domain",
          hostname: "memory.example.com",
          service: "other-worker",
          zone_id: "zone-one",
          zone_name: "example.com",
          environment: "production"
        }
      ],
      routes: [],
      accountSubdomain: "account-workers"
    };

    await expect(
      restoreGatewayTriggerState(
        encodeGatewayTriggerState(expected),
        environment(expected),
        remoteFetch(state),
        restoreOptions(workersDevState(), true)
      )
    ).rejects.toThrow("owned by another Worker script");
    expect(state.domains).toEqual([expect.objectContaining({ service: "other-worker" })]);
  });

  it("refuses to overwrite external trigger drift when this run did not advance gateway", async () => {
    const requests: string[] = [];
    const state: RemoteState = {
      workersDev: { enabled: false, previews_enabled: false },
      domains: [
        {
          id: "external-domain",
          hostname: "external.example.com",
          service: GATEWAY,
          zone_id: "zone-one",
          zone_name: "example.com",
          environment: "production"
        }
      ],
      routes: [],
      accountSubdomain: "account-workers"
    };

    await expect(
      restoreGatewayTriggerState(
        encodeGatewayTriggerState(workersDevState()),
        environment(workersDevState()),
        remoteFetch(state, requests),
        restoreOptions(workersDevState(), false)
      )
    ).rejects.toThrow("not owned by this deployment run");
    expect(requests.some((request) => /^(DELETE|POST|PUT) /u.test(request))).toBe(false);
    expect(state.domains).toEqual([
      expect.objectContaining({ id: "external-domain", hostname: "external.example.com" })
    ]);
    expect(state.workersDev).toEqual({ enabled: false, previews_enabled: false });
  });

  it("does not let run-advance proof bypass expected-current trigger CAS", async () => {
    const requests: string[] = [];
    const state: RemoteState = {
      workersDev: { enabled: false, previews_enabled: false },
      domains: [
        {
          id: "external-domain",
          hostname: "external.example.com",
          service: GATEWAY,
          zone_id: "zone-one",
          zone_name: "example.com",
          environment: "production"
        }
      ],
      routes: [],
      accountSubdomain: "account-workers"
    };

    await expect(
      restoreGatewayTriggerState(
        encodeGatewayTriggerState(absentState()),
        environment(absentState()),
        remoteFetch(state, requests),
        restoreOptions(workersDevState(), true, true)
      )
    ).rejects.toThrow("not owned by this deployment run");
    expect(requests.some((request) => /^(DELETE|POST|PUT) /u.test(request))).toBe(false);
    expect(state.domains).toEqual([expect.objectContaining({ id: "external-domain" })]);
  });

  it("verifies the detached bootstrap state before deleting the Worker script", async () => {
    const state = workersDevRemote();
    state.subdomainDeleteLeavesDisabled = true;
    const restored = await restoreGatewayTriggerState(
      encodeGatewayTriggerState(absentState()),
      environment(absentState()),
      remoteFetch(state),
      restoreOptions(workersDevState(), true, true)
    );

    expect(restored.state).toEqual({
      schema: 1,
      script: GATEWAY,
      worker_present: true,
      workers_dev: { enabled: false, previews_enabled: false },
      custom_domains: [],
      routes: []
    });
    expect(state.workersDev).toEqual({ enabled: false, previews_enabled: false });
  });

  it("requires explicit restore ownership proof before any trigger mutation", async () => {
    const requests: string[] = [];
    await expect(
      restoreGatewayTriggerState(
        encodeGatewayTriggerState(customDomainState()),
        environment(customDomainState()),
        remoteFetch(workersDevRemote(), requests)
      )
    ).rejects.toThrow("ownership proof is missing");
    expect(requests).toEqual([]);
  });
});
