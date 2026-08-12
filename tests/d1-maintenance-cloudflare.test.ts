import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => JSON.stringify({
      d1_databases: [
        {
          binding: "MEMORY_DB",
          database_id: "44444444-4444-4444-8444-444444444444"
        },
        {
          binding: "SEARCH_DB",
          database_id: "55555555-5555-4555-8555-555555555555"
        }
      ]
    }))
  };
});

// The maintenance verifier is plain ESM so GitHub Actions can execute it directly.
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as maintenanceCloudflareModule from "../scripts/d1-maintenance-cloudflare.mjs";
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as maintenanceCloudflareClientModule from "../scripts/d1-maintenance-cloudflare-client.mjs";
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as maintenanceAdmissionModule from "../scripts/d1-maintenance-admission.mjs";

const {
  NONTERMINAL_WORKFLOW_STATUSES,
  observeCloudflareMaintenance,
  scanWorkflowInstances
} = maintenanceCloudflareModule;
const { createCloudflareMaintenanceClient } = maintenanceCloudflareClientModule;
const { maintenanceViolationCodes } = maintenanceAdmissionModule;

const ACCOUNT_ID = "a".repeat(32);
const TOKEN = "synthetic-cloudflare-token";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DRIFT_VERSION_ID = "88888888-8888-4888-8888-888888888888";
const DEPLOYMENT_ID = "66666666-6666-4666-8666-666666666666";
const MEMORY_DATABASE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_DATABASE_ID = "77777777-7777-4777-8777-777777777777";
const BACKUP_BUCKET = "edgemneme-d1-migration-backups";
const RENAMED_WORKER = "renamed-memory-orchestrator";
const environment = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: TOKEN,
  D1_MIGRATION_BACKUP_R2_BUCKET: BACKUP_BUCKET
};

const envelope = (result: unknown, resultInfo?: unknown) => ({
  success: true,
  result,
  ...(resultInfo === undefined ? {} : { result_info: resultInfo })
});

const response = (body: unknown, status = 200) => new Response(
  status === 204 ? null : JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } }
);

const emptyPage = (page: number, perPage: number) => envelope([], {
  count: 0,
  page,
  per_page: perPage,
  total_count: 0,
  total_pages: 0
});

function workerControlPlane(
  bindings: Record<string, unknown>[],
  percentages = [100],
  activeVersionIds = [VERSION_ID],
  queueConsumer?: Record<string, unknown>
) {
  const requests: URL[] = [];
  let deploymentQueryCount = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    const path = url.pathname;
    if (path.endsWith("/workers/scripts")) {
      return response(envelope([{ id: RENAMED_WORKER }]));
    }
    if (path.endsWith(`/${RENAMED_WORKER}/deployments`)) {
      const activeVersionId = activeVersionIds[
        Math.min(deploymentQueryCount, activeVersionIds.length - 1)
      ];
      deploymentQueryCount += 1;
      return response(envelope({
        deployments: [{
          id: DEPLOYMENT_ID,
          created_on: "2026-08-10T12:00:00.000Z",
          source: "api",
          strategy: "percentage",
          versions: percentages.map((percentage) => ({
            percentage,
            version_id: activeVersionId
          }))
        }]
      }));
    }
    if (path.endsWith(`/${RENAMED_WORKER}/versions/${VERSION_ID}`)) {
      return response(envelope({
        id: VERSION_ID,
        resources: { bindings }
      }));
    }
    if (path.endsWith("/schedules") ||
        path.endsWith("/subdomain") && path.includes("/workers/scripts/")) {
      return response({}, 404);
    }
    if (path.endsWith("/workers/domains")) {
      return response(envelope([], { count: 0, total_count: 0, total_pages: 0 }));
    }
    if (path === "/client/v4/zones") return response(emptyPage(1, 50));
    if (path.endsWith("/queues")) {
      if (queueConsumer === undefined) return response(emptyPage(1, 100));
      return response(envelope([{
        queue_id: "b".repeat(32),
        queue_name: "dev-yinyang-agent-email-delivery",
        consumers_total_count: 1,
        producers_total_count: 0,
        producers: []
      }], {
        count: 1,
        page: 1,
        per_page: 100,
        total_count: 1,
        total_pages: 1
      }));
    }
    if (path.endsWith("/consumers") && queueConsumer !== undefined) {
      return response(envelope([queueConsumer]));
    }
    if (path.endsWith("/workflows")) return response(emptyPage(1, 100));
    throw new Error(`Unexpected maintenance request ${url}`);
  });
  return { fetchMock, requests };
}

function violationCodes(cloudflare: unknown) {
  return maintenanceViolationCodes({
    cloudflare,
    d1: {
      memory: { inflight: 0, production_rows: 0 },
      search: { inflight: 0, production_rows: 0 }
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare production maintenance observation", () => {
  it("accepts optional pagination fields for an empty filtered gateway domain inventory", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(init === undefined ? { url } : { url, init });
      const path = url.pathname;
      if (path.endsWith("/workers/scripts")) return response(envelope([]));
      if (path.endsWith("/deployments")) return response({}, 404);
      if (path.endsWith("/schedules")) return response({}, 404);
      if (path.endsWith("/subdomain") && path.includes("/workers/scripts/")) {
        return response({}, 404);
      }
      if (path.endsWith("/workers/domains")) {
        return response(envelope([], {
          count: 0,
          page: 1,
          per_page: 0,
          total_count: 0
        }));
      }
      if (path === "/client/v4/zones") return response(emptyPage(1, 50));
      if (path.endsWith("/queues")) return response(emptyPage(1, 100));
      if (path.endsWith("/workflows")) return response(emptyPage(1, 100));
      throw new Error(`Unexpected maintenance request ${url}`);
    });

    await expect(observeCloudflareMaintenance(environment, fetchMock)).resolves.toMatchObject({
      workers: [],
      core_versions: {
        "edgemneme-github-sync": "absent",
        "edgemneme-memory-gateway": "absent",
        "edgemneme-memory-orchestrator": "absent"
      },
      binding_targets: {
        d1_databases: {
          MEMORY_DB: MEMORY_DATABASE_ID,
          SEARCH_DB: "55555555-5555-4555-8555-555555555555"
        },
        backup_r2_bucket: BACKUP_BUCKET
      },
      worker_bindings: [],
      gateway_ingress: { workers_dev: null, custom_domains: [], routes: [] },
      queues: [],
      workflows: []
    });
    expect(requests.length).toBeGreaterThanOrEqual(9);
    expect(requests.every(({ init }) => init?.method === "GET")).toBe(true);
    expect(requests.every(({ init }) => init?.redirect === "manual")).toBe(true);
    expect(requests.every(({ url }) => !url.pathname.endsWith("/settings"))).toBe(true);
    expect(requests.some(({ url }) =>
      url.pathname.endsWith("/workers/domains") &&
      url.searchParams.get("service") === "edgemneme-memory-gateway"
    )).toBe(true);
  });

  it("records stable non-target resources from the immutable active version", async () => {
    const { fetchMock, requests } = workerControlPlane([
      {
        name: "OTHER_DB",
        type: "d1",
        database_id: OTHER_DATABASE_ID
      },
      {
        name: "PROJECTIONS",
        type: "r2_bucket",
        bucket_name: "edgemneme-projections"
      },
      {
        name: "CACHE",
        type: "kv_namespace",
        namespace_id: "a".repeat(32)
      }
    ]);

    await expect(observeCloudflareMaintenance(environment, fetchMock)).resolves.toMatchObject({
      worker_bindings: [{
        script: RENAMED_WORKER,
        version_id: VERSION_ID,
        bindings: [
          { name: "CACHE", type: "kv_namespace" },
          {
            name: "OTHER_DB",
            type: "d1",
            database_id: OTHER_DATABASE_ID,
            target: null
          },
          {
            name: "PROJECTIONS",
            type: "r2_bucket",
            bucket_name: "edgemneme-projections",
            jurisdiction: null,
            backup_bucket: false
          }
        ]
      }]
    });
    expect(requests.filter((url) => url.pathname.endsWith("/deployments"))).toHaveLength(2);
    expect(requests.filter((url) => url.pathname.includes("/versions/"))).toHaveLength(1);
    expect(requests.some((url) => url.pathname.endsWith("/settings"))).toBe(false);
  });

  it.each([
    ["live", { script: "dev-yinyang-agent" }],
    ["service", { service: "dev-yinyang-agent", environment: "production" }],
    ["documented", { script_name: "dev-yinyang-agent" }],
    ["consistent", {
      script: "dev-yinyang-agent",
      service: "dev-yinyang-agent",
      script_name: "dev-yinyang-agent"
    }]
  ])("records the %s Queue worker consumer identity shape", async (_shape, identity) => {
    const { fetchMock } = workerControlPlane([], [100], [VERSION_ID], {
      consumer_id: "c".repeat(32),
      type: "worker",
      ...identity
    });

    await expect(observeCloudflareMaintenance(environment, fetchMock)).resolves.toMatchObject({
      queues: [{
        name: "dev-yinyang-agent-email-delivery",
        consumers: [{
          id: "c".repeat(32),
          type: "worker",
          script: "dev-yinyang-agent"
        }]
      }]
    });
  });

  it("rejects conflicting Queue worker consumer identities", async () => {
    const { fetchMock } = workerControlPlane([], [100], [VERSION_ID], {
      consumer_id: "c".repeat(32),
      type: "worker",
      script: "dev-yinyang-agent",
      script_name: "another-worker"
    });

    await expect(observeCloudflareMaintenance(environment, fetchMock)).rejects.toThrow(
      "consumer script is invalid"
    );
  });

  it("rejects a Queue worker consumer without an identity", async () => {
    const { fetchMock } = workerControlPlane([], [100], [VERSION_ID], {
      consumer_id: "c".repeat(32),
      type: "worker"
    });

    await expect(observeCloudflareMaintenance(environment, fetchMock)).rejects.toThrow(
      "consumer script is invalid"
    );
  });

  it("detects a core Worker through the Queue service identity shape", async () => {
    const { fetchMock } = workerControlPlane([], [100], [VERSION_ID], {
      consumer_id: "c".repeat(32),
      type: "worker",
      service: "edgemneme-memory-orchestrator",
      environment: "production"
    });

    const observation = await observeCloudflareMaintenance(environment, fetchMock);
    expect(violationCodes(observation)).toContain("QUEUE_CONSUMER_ACTIVE");
  });

  it("records an HTTP pull Queue consumer without a Worker identity", async () => {
    const { fetchMock } = workerControlPlane([], [100], [VERSION_ID], {
      consumer_id: "c".repeat(32),
      type: "http_pull"
    });

    await expect(observeCloudflareMaintenance(environment, fetchMock)).resolves.toMatchObject({
      queues: [{ consumers: [{ type: "http_pull", script: null }] }]
    });
  });

  it("validates the backup-only R2 target before reading the live inventory", async () => {
    const fetchMock = vi.fn();
    await expect(observeCloudflareMaintenance({
      ...environment,
      D1_MIGRATION_BACKUP_R2_BUCKET: "Invalid_Backup_Bucket"
    }, fetchMock)).rejects.toThrow("valid 3-63 character R2 bucket name");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "target D1",
      binding: { name: "DB", type: "d1", database_id: MEMORY_DATABASE_ID },
      code: "TARGET_D1_BINDING_ACTIVE"
    },
    {
      label: "backup R2",
      binding: { name: "BACKUPS", type: "r2_bucket", bucket_name: BACKUP_BUCKET },
      code: "BACKUP_R2_BINDING_ACTIVE"
    },
    {
      label: "gateway service",
      binding: { name: "GATEWAY", type: "service", service: "edgemneme-memory-gateway" },
      code: "INBOUND_GATEWAY_SERVICE_BINDING_ACTIVE"
    }
  ])("blocks a stable renamed Worker with a $label binding", async ({ binding, code }) => {
    const { fetchMock, requests } = workerControlPlane([binding]);
    const observation = await observeCloudflareMaintenance(environment, fetchMock);
    expect(violationCodes(observation)).toContain(code);
    expect(requests.filter((url) => url.pathname.endsWith("/deployments"))).toHaveLength(2);
    expect(requests.filter((url) => url.pathname.includes("/versions/"))).toHaveLength(1);
    expect(requests.some((url) => url.pathname.endsWith("/settings"))).toBe(false);
  });

  it.each([{ percentages: [99] }, { percentages: [50, 50] }])(
    "rejects active deployment percentages $percentages",
    async ({ percentages }) => {
      const { fetchMock } = workerControlPlane([], percentages);
      await expect(observeCloudflareMaintenance(environment, fetchMock)).rejects.toThrow(
        "one stable 100% active version"
      );
    }
  );

  it("rejects active-version drift after immutable bindings were read", async () => {
    const { fetchMock } = workerControlPlane(
      [{ name: "CACHE", type: "kv_namespace", namespace_id: "a".repeat(32) }],
      [100],
      [VERSION_ID, DRIFT_VERSION_ID]
    );
    await expect(observeCloudflareMaintenance(environment, fetchMock)).rejects.toThrow(
      "inventory or active versions changed"
    );
  });

  it("fails closed on an unresolved inherited active-version binding", async () => {
    const { fetchMock } = workerControlPlane([{
      name: "DB",
      type: "inherit",
      version_id: "latest"
    }]);
    await expect(observeCloudflareMaintenance(environment, fetchMock)).rejects.toThrow(
      "unresolved inherited binding"
    );
  });

  it.each([301, 401, 403, 404, 429, 503])(
    "fails closed on HTTP %s from an authoritative inventory",
    async (status) => {
      const client = createCloudflareMaintenanceClient({
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
        CLOUDFLARE_API_TOKEN: TOKEN
      }, vi.fn(async () => response({}, status)));
      await expect(client.get(client.accountPath("/queues"), {
        label: "Queue inventory"
      })).rejects.toThrow(`HTTP ${status}`);
    }
  );

  it("rejects malformed or incomplete pagination metadata", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/workers/scripts")) return response(envelope([]));
      if (url.pathname.endsWith("/deployments") || url.pathname.endsWith("/schedules") ||
          url.pathname.endsWith("/subdomain")) return response({}, 404);
      if (url.pathname.endsWith("/workers/domains")) {
        return response(envelope([], { count: 0, total_count: 0, total_pages: 0 }));
      }
      if (url.pathname === "/client/v4/zones") {
        return response(envelope([], {
          count: 0,
          page: 1,
          per_page: 50,
          total_count: 1,
          total_pages: 1
        }));
      }
      if (url.pathname.endsWith("/queues") || url.pathname.endsWith("/workflows")) {
        return response(emptyPage(1, 100));
      }
      throw new Error(`Unexpected request ${url}`);
    });
    await expect(observeCloudflareMaintenance(environment, fetchMock)).rejects.toThrow(
      /pagination|incomplete/iu
    );
  });
});

describe("Cloudflare Workflow cursor admission", () => {
  const definition = {
    id: WORKFLOW_ID,
    name: "edgemneme-memory-workflow"
  };

  it("enumerates all six nonterminal status filters", async () => {
    const statuses: string[] = [];
    const client = {
      accountPath(path: string) {
        return `/accounts/${ACCOUNT_ID}${path}`;
      },
      async get(path: string) {
        const url = new URL(`https://api.example${path}`);
        const status = url.searchParams.get("status")!;
        statuses.push(status);
        return envelope([{
          id: `${status}-instance`,
          status,
          workflow_id: WORKFLOW_ID,
          version_id: VERSION_ID
        }], { count: 1 });
      }
    };
    await expect(scanWorkflowInstances(client, definition)).resolves.toHaveLength(6);
    expect(statuses).toEqual(NONTERMINAL_WORKFLOW_STATUSES);
  });

  it("fails on cursor cycles instead of trusting total_count", async () => {
    const client = {
      accountPath(path: string) {
        return `/accounts/${ACCOUNT_ID}${path}`;
      },
      async get() {
        return envelope([], { count: 0, cursor: "repeated-cursor" });
      }
    };
    await expect(scanWorkflowInstances(client, definition)).rejects.toThrow(
      "cursor is invalid or repeated"
    );
  });
});
