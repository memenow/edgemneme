import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

// The renderer is intentionally plain ESM so it can run in GitHub Actions
// without a TypeScript runtime.
// @ts-expect-error The JavaScript CLI has no separate declaration file.
import { generatedConfigPath, renderConfig } from "../scripts/render-wrangler-config.mjs";

const root = process.cwd();

const baseEnvironment = {
  CF_D1_MEMORY_DATABASE_ID: "123e4567-e89b-42d3-a456-426614174000",
  CF_D1_SEARCH_DATABASE_ID: "987e6543-e21b-43d3-b654-426614174111",
  CF_RATE_LIMIT_NAMESPACE_EDGE: "21001",
  CF_RATE_LIMIT_NAMESPACE_CLIENT: "21002",
  CF_RATE_LIMIT_NAMESPACE_PRINCIPAL: "21003",
  MEMORY_GATEWAY_ALLOWED_ORIGINS: "https://app.example.com, https://admin.example.com",
  MEMORY_GATEWAY_CUSTOM_DOMAIN: "memory.example.com",
  MEMORY_GATEWAY_EXPECTED_HOST: "edgemneme-gateway.example.workers.dev",
  GITHUB_CREDENTIAL_VERSION: "github-credential-next",
  ENABLE_GITHUB_SYNC: "true"
};

const githubSyncWorkflows = [
  {
    binding: "GITHUB_DISPATCH_WORKFLOW",
    name: "edgemneme-github-dispatch-workflow",
    class_name: "GitHubDispatchWorkflow",
    limits: { steps: 10_000 }
  },
  {
    binding: "GITHUB_REF_SYNC_WORKFLOW",
    name: "edgemneme-github-ref-sync-workflow",
    class_name: "GitHubRefSyncWorkflow",
    limits: { steps: 10_000 }
  },
  {
    binding: "GITHUB_RETENTION_WORKFLOW",
    name: "edgemneme-github-retention-workflow",
    class_name: "GitHubRetentionWorkflow",
    limits: { steps: 10_000 }
  }
] as const;

function sourceConfig(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "wrangler", `${name}.jsonc`), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("Wrangler deployment config renderer", () => {
  it("renders gateway resources, origins, rate-limit namespaces, and its custom domain", () => {
    const rendered = renderConfig("memory-gateway", sourceConfig("memory-gateway"), baseEnvironment);

    expect(rendered).toMatchObject({
      $schema: "../../node_modules/wrangler/config-schema.json",
      main: "../../workers/memory-gateway/index.ts",
      vars: {
        ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com"
      },
      version_metadata: { binding: "CF_VERSION_METADATA" },
      routes: [{ pattern: "memory.example.com", custom_domain: true }],
      d1_databases: [
        {
          binding: "MEMORY_DB",
          database_id: baseEnvironment.CF_D1_MEMORY_DATABASE_ID,
          migrations_dir: "../../migrations"
        },
        {
          binding: "SEARCH_DB",
          database_id: baseEnvironment.CF_D1_SEARCH_DATABASE_ID,
          migrations_dir: "../../migrations/search"
        }
      ],
      ratelimits: [
        { name: "MCP_EDGE_LIMITER", namespace_id: "21001" },
        { name: "MCP_CLIENT_LIMITER", namespace_id: "21002" },
        { name: "MCP_PRINCIPAL_LIMITER", namespace_id: "21003" }
      ]
    });
  });

  it("renders both D1 IDs for the orchestrator", () => {
    const rendered = renderConfig(
      "memory-orchestrator",
      sourceConfig("memory-orchestrator"),
      baseEnvironment
    );

    expect(rendered).toMatchObject({
      d1_databases: [
        { binding: "MEMORY_DB", database_id: baseEnvironment.CF_D1_MEMORY_DATABASE_ID },
        { binding: "SEARCH_DB", database_id: baseEnvironment.CF_D1_SEARCH_DATABASE_ID }
      ]
    });
  });

  it("rebases relative container image paths and preserves the Hermes binding", () => {
    const rendered = renderConfig(
      "memory-orchestrator",
      sourceConfig("memory-orchestrator"),
      baseEnvironment
    );

    expect(rendered).toMatchObject({
      vars: {
        MODEL_RUNNER: "workers-ai",
        HERMES_PROFILE: "meta-muse",
        HERMES_CREDENTIAL_VERSION: "unconfigured"
      },
      containers: [
        {
          class_name: "HermesContainer",
          image: "../../containers/hermes/Dockerfile",
          max_instances: 2
        }
      ],
      durable_objects: {
        bindings: [
          { name: "PROJECT_COORDINATOR", class_name: "ProjectCoordinator" },
          { name: "HERMES", class_name: "HermesContainer" }
        ]
      },
      exports: {
        ProjectCoordinator: {
          type: "durable-object",
          state: "created",
          storage: "sqlite"
        },
        HermesContainer: {
          type: "durable-object",
          state: "created",
          storage: "sqlite"
        }
      }
    });
  });

  it("leaves registry container image references untouched", () => {
    const config = sourceConfig("memory-orchestrator");
    config.containers = [
      { class_name: "HermesContainer", image: "registry.example.com/hermes:1.0" }
    ];

    const rendered = renderConfig("memory-orchestrator", config, baseEnvironment);

    expect(rendered).toMatchObject({
      containers: [{ image: "registry.example.com/hermes:1.0" }]
    });
  });

  it("uses workers.dev when no custom domain or browser origins are configured", () => {
    const rendered = renderConfig("memory-gateway", sourceConfig("memory-gateway"), {
      ...baseEnvironment,
      MEMORY_GATEWAY_ALLOWED_ORIGINS: "",
      MEMORY_GATEWAY_CUSTOM_DOMAIN: ""
    });

    expect(rendered).toMatchObject({
      workers_dev: true,
      vars: { ALLOWED_ORIGINS: "" }
    });
    expect(rendered).not.toHaveProperty("routes");
    expect(JSON.stringify(rendered)).not.toContain(baseEnvironment.MEMORY_GATEWAY_EXPECTED_HOST);
  });

  it("renders an enabled GitHub sync with one Cron Trigger and its required secret", () => {
    const rendered = renderConfig("github-sync", sourceConfig("github-sync"), baseEnvironment);

    expect(rendered).toMatchObject({
      vars: {
        GITHUB_SYNC_ENABLED: "true",
        GITHUB_CREDENTIAL_VERSION: "github-credential-next"
      },
      secrets: { required: ["GITHUB_CLASSIC_TOKEN"] },
      triggers: { crons: ["0 */6 * * *"] },
      workflows: githubSyncWorkflows,
      d1_databases: [
        { binding: "MEMORY_DB", database_id: baseEnvironment.CF_D1_MEMORY_DATABASE_ID }
      ]
    });
  });

  it("renders a disabled GitHub sync without a Cron Trigger or required secret", () => {
    const rendered = renderConfig("github-sync", sourceConfig("github-sync"), {
      ...baseEnvironment,
      ENABLE_GITHUB_SYNC: "false"
    });

    expect(rendered).toMatchObject({
      vars: {
        GITHUB_SYNC_ENABLED: "false",
        GITHUB_CREDENTIAL_VERSION: "unconfigured"
      },
      triggers: { crons: [] },
      workflows: githubSyncWorkflows,
      d1_databases: [
        { binding: "MEMORY_DB", database_id: baseEnvironment.CF_D1_MEMORY_DATABASE_ID }
      ]
    });
    expect(rendered).not.toHaveProperty("secrets");
    expect(rendered).not.toHaveProperty("queues");
  });

  it.each([
    ["a missing binding", (config: Record<string, unknown>) => {
      config.workflows = githubSyncWorkflows.slice(0, 2);
    }],
    ["an extra binding", (config: Record<string, unknown>) => {
      config.workflows = [...githubSyncWorkflows, githubSyncWorkflows[0]];
    }],
    ["a mismatched class", (config: Record<string, unknown>) => {
      config.workflows = githubSyncWorkflows.map((workflow, index) =>
        index === 0 ? { ...workflow, class_name: "LegacyDirectCronWorkflow" } : workflow
      );
    }],
    ["a cross-script binding", (config: Record<string, unknown>) => {
      config.workflows = githubSyncWorkflows.map((workflow, index) =>
        index === 0 ? { ...workflow, script_name: "another-worker" } : workflow
      );
    }],
    ["a direct Workflow schedule", (config: Record<string, unknown>) => {
      config.workflows = githubSyncWorkflows.map((workflow, index) =>
        index === 0 ? { ...workflow, schedules: [{ cron: "0 */6 * * *" }] } : workflow
      );
    }],
    ["a mismatched Workflow step limit", (config: Record<string, unknown>) => {
      config.workflows = githubSyncWorkflows.map((workflow, index) =>
        index === 0 ? { ...workflow, limits: { steps: 9_999 } } : workflow
      );
    }],
    ["a Queue surface", (config: Record<string, unknown>) => {
      config.queues = { producers: [] };
    }]
  ])("rejects github-sync config with %s", (_label, mutate) => {
    const config = sourceConfig("github-sync");
    mutate(config);

    expect(() => renderConfig("github-sync", config, baseEnvironment)).toThrow();
  });

  it("does not mutate the public source config or remove required secrets", () => {
    const source = sourceConfig("memory-gateway");
    const snapshot = structuredClone(source);
    const rendered = renderConfig("memory-gateway", source, baseEnvironment);

    expect(source).toEqual(snapshot);
    expect(rendered).toMatchObject({
      secrets: { required: ["TOKEN_DIGEST_PEPPER", "PAGE_TOKEN_HMAC_KEY"] },
      d1_databases: [{ binding: "MEMORY_DB" }, { binding: "SEARCH_DB" }]
    });
  });

  it.each([
    ["memory-gateway", "missing values", { ...baseEnvironment, CF_D1_MEMORY_DATABASE_ID: "" }],
    ["memory-gateway", "malformed UUIDs", {
      ...baseEnvironment,
      CF_D1_SEARCH_DATABASE_ID: "not-a-uuid"
    }],
    ["memory-gateway", "placeholder UUIDs", {
      ...baseEnvironment,
      CF_D1_MEMORY_DATABASE_ID: "00000000-0000-0000-0000-000000000000"
    }],
    ["memory-gateway", "invalid namespace IDs", {
      ...baseEnvironment,
      CF_RATE_LIMIT_NAMESPACE_EDGE: "0"
    }],
    ["memory-gateway", "public placeholder namespace IDs", {
      ...baseEnvironment,
      CF_RATE_LIMIT_NAMESPACE_EDGE: "10001"
    }],
    ["memory-gateway", "duplicate namespace IDs", {
      ...baseEnvironment,
      CF_RATE_LIMIT_NAMESPACE_CLIENT: baseEnvironment.CF_RATE_LIMIT_NAMESPACE_EDGE
    }],
    ["memory-gateway", "non-HTTPS origins", {
      ...baseEnvironment,
      MEMORY_GATEWAY_ALLOWED_ORIGINS: "http://app.example.com"
    }],
    ["memory-gateway", "origins with paths", {
      ...baseEnvironment,
      MEMORY_GATEWAY_ALLOWED_ORIGINS: "https://app.example.com/path"
    }],
    ["memory-gateway", "invalid custom domains", {
      ...baseEnvironment,
      MEMORY_GATEWAY_CUSTOM_DOMAIN: "https://memory.example.com"
    }],
    ["memory-gateway", "IP custom domains", {
      ...baseEnvironment,
      MEMORY_GATEWAY_CUSTOM_DOMAIN: "192.0.2.1"
    }],
    ["github-sync", "placeholder credential versions", {
      ...baseEnvironment,
      GITHUB_CREDENTIAL_VERSION: "unconfigured"
    }],
    ["github-sync", "an invalid lifecycle gate", {
      ...baseEnvironment,
      ENABLE_GITHUB_SYNC: "TRUE"
    }]
  ])("fails closed for %s %s", (worker, _label, environment) => {
    expect(() => renderConfig(worker, sourceConfig(worker), environment)).toThrow();
  });

  it("reports variable names without echoing their values", () => {
    const sensitiveValue = "https://should-never-appear.example.com/path";
    expect(() =>
      renderConfig("memory-gateway", sourceConfig("memory-gateway"), {
        ...baseEnvironment,
        MEMORY_GATEWAY_ALLOWED_ORIGINS: sensitiveValue
      })
    ).toThrowError(expect.objectContaining({ message: expect.not.stringContaining(sensitiveValue) }));
  });

  it("never copies runtime secrets from the environment into rendered config", () => {
    const sensitiveValue = "synthetic-secret-that-must-not-be-rendered";
    const rendered = renderConfig("memory-gateway", sourceConfig("memory-gateway"), {
      ...baseEnvironment,
      TOKEN_DIGEST_PEPPER: sensitiveValue,
      PAGE_TOKEN_HMAC_KEY: sensitiveValue,
      GITHUB_CLASSIC_TOKEN: sensitiveValue
    });

    expect(JSON.stringify(rendered)).not.toContain(sensitiveValue);
  });

  it("rejects an unsupported worker target", () => {
    expect(() => renderConfig("claude-runner", sourceConfig("claude-runner"), baseEnvironment)).toThrow(
      /unsupported worker/iu
    );
  });

  it("keeps generated configs inside the ignored Wrangler runtime directory", () => {
    expect(generatedConfigPath(root, "memory-gateway")).toBe(
      join(root, "wrangler", ".wrangler", "memory-gateway.generated.jsonc")
    );
  });

  it("pins the orchestrator Workflow step, CPU, and snapshot subrequest limits", () => {
    const rendered = renderConfig("memory-orchestrator", sourceConfig("memory-orchestrator"), {
      ...baseEnvironment,
      CF_D1_MEMORY_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
      CF_D1_SEARCH_DATABASE_ID: "33333333-3333-4333-8333-333333333333"
    });

    expect(rendered.limits).toEqual({
      cpu_ms: 300_000,
      subrequests: 1_500_000
    });
    expect(rendered.workflows).toEqual([
      expect.objectContaining({ limits: { steps: 10_000 } })
    ]);
  });
});
