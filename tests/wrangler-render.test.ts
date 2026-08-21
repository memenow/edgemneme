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

function workflowSource(name: string): string {
  return readFileSync(join(root, ".github", "workflows", name), "utf8");
}

function workflowStep(source: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step ${name} was not found.`);
  }
  const next = source.indexOf("\n      - name: ", start + marker.length);
  return source.slice(start, next === -1 ? undefined : next);
}

function workflowRunScript(source: string, name: string): string {
  const step = workflowStep(source, name);
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step ${name} does not contain a literal run script.`);
  }
  return step
    .slice(start + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
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
    expect(() => renderConfig("not-a-worker", {}, baseEnvironment)).toThrow(
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

describe("production workflow secret isolation", () => {
  const deploy = workflowSource("deploy.yml");
  const migrate = workflowSource("migrate-d1.yml");

  function secretExposure(source: string): Array<[string, string[]]> {
    const stepMatches = [...source.matchAll(/^      - name: (.+)$/gmu)];
    const secretPattern = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/gu;
    const exposure: Array<[string, string[]]> = [];
    for (const [index, match] of stepMatches.entries()) {
      const name = match[1];
      if (name === undefined) {
        throw new Error("Workflow step name was not captured.");
      }
      const next = stepMatches[index + 1];
      const step = source.slice(match.index, next?.index);
      const secrets = [...step.matchAll(secretPattern)]
        .map((secretMatch) => secretMatch[1])
        .filter((secret): secret is string => secret !== undefined)
        .sort();
      if (secrets.length > 0) {
        exposure.push([name, secrets]);
      }
    }
    return exposure;
  }

  it("keeps secrets out of job-level environments and source validation", () => {
    expect(deploy).not.toMatch(/^    env:/mu);
    expect(migrate).not.toMatch(/^    env:/mu);
    expect(workflowStep(deploy, "Validate source and public Wrangler templates")).not.toContain(
      "env:"
    );
  });

  it("installs without lifecycle scripts and deploys the immutable trusted-main commit", () => {
    expect(deploy).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(deploy).toContain("if: github.ref == 'refs/heads/main'");
    expect(deploy).toContain("ref: ${{ github.sha }}");
    const immutableDeployment = workflowStep(deploy, "Verify immutable deployment source");
    expect(immutableDeployment).toContain('"$GITHUB_REF" != "refs/heads/main"');
    expect(immutableDeployment).toContain('"$(git rev-parse HEAD)" != "$GITHUB_SHA"');

    expect(migrate).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(migrate).toContain("if: github.ref == 'refs/heads/main'");
    expect(migrate).toContain("ref: ${{ github.sha }}");
    const immutableSource = workflowStep(migrate, "Verify immutable migration source");
    expect(immutableSource).toContain('"$GITHUB_REF" != "refs/heads/main"');
    expect(immutableSource).toContain('"$(git rev-parse HEAD)" != "$GITHUB_SHA"');
  });

  it("fails closed before deployment when either remote D1 database has pending migrations", () => {
    const gate = workflowStep(deploy, "Require fully migrated remote D1 databases");
    const orchestratorDeploy = deploy.indexOf("      - name: Deploy memory orchestrator\n");

    expect(gate).toContain("wrangler d1 migrations list \"$database\" --remote");
    expect(gate).toContain("No migrations to apply!");
    expect(gate).toContain("Migrations to be applied:");
    expect(gate).toContain("check_no_pending MEMORY_DB");
    expect(gate).toContain("check_no_pending SEARCH_DB");
    expect(gate).not.toContain("migrations apply");
    expect(deploy.indexOf("      - name: Require fully migrated remote D1 databases\n"))
      .toBeLessThan(orchestratorDeploy);
  });

  it("ensures the exact semantic-filter metadata indexes before deploying the orchestrator", () => {
    const gate = workflowStep(deploy, "Ensure semantic Vectorize metadata indexes");
    const orchestratorDeploy = deploy.indexOf("      - name: Deploy memory orchestrator\n");
    const secretPattern = /\$\{\{ secrets\.[A-Z0-9_]+ \}\}/gu;

    expect(gate).toContain("vectorize list-metadata-index \\");
    expect(gate).toContain('"$vectorize_index_name" --json');
    expect(gate).toContain("model_generation");
    expect(gate).toContain("status");
    expect(gate).toContain("repository_partition");
    expect(gate).toContain("kind");
    expect(gate).toContain("memory_class");
    expect(gate).toContain("scope_key");
    expect(gate).toContain("valid_from_epoch_ms");
    expect(gate).toContain("valid_until_epoch_ms");
    expect(gate).toContain('typeof index.indexType !== "string"');
    expect(gate).toContain("index.indexType.toLowerCase()");
    expect(gate).toContain("vectorize create-metadata-index");
    expect(gate).toContain("--property-name=\"$property_name\"");
    expect(gate).toContain("--type=\"$index_type\"");
    expect(gate.match(secretPattern)?.sort()).toEqual([
      "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      "${{ secrets.CLOUDFLARE_API_TOKEN }}"
    ]);
    expect(deploy.indexOf("      - name: Ensure semantic Vectorize metadata indexes\n"))
      .toBeLessThan(orchestratorDeploy);
  });

  it("rebuilds projections after the orchestrator and before the gateway", () => {
    const rebuild = workflowStep(deploy, "Rebuild and verify projections");
    const orchestratorDeploy = deploy.indexOf("      - name: Deploy memory orchestrator\n");
    const rebuildStart = deploy.indexOf("      - name: Rebuild and verify projections\n");
    const gatewayDeploy = deploy.indexOf("      - name: Deploy memory gateway\n");
    const secretPattern = /\$\{\{ secrets\.[A-Z0-9_]+ \}\}/gu;

    expect(rebuild).toContain("pnpm projection:rebuild:enqueue");
    expect(rebuild).toContain(
      "pnpm projection:rebuild:enqueue --resume --max-wait-seconds 3600"
    );
    expect(rebuild).toContain("pnpm projection:rebuild:verify --wait-seconds 3600");
    expect(rebuild).not.toContain(" -- --");
    expect(rebuild).toContain("timeout-minutes: 65");
    expect(rebuild.match(secretPattern)?.sort()).toEqual([
      "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
      "${{ secrets.CLOUDFLARE_API_TOKEN }}"
    ]);
    expect(orchestratorDeploy).toBeLessThan(rebuildStart);
    expect(rebuildStart).toBeLessThan(gatewayDeploy);
  });

  it("fails before deployment when the projection fanout exceeds its wait budget", () => {
    const budget = workflowStep(deploy, "Check projection rebuild deployment budget");
    const budgetStart = deploy.indexOf(
      "      - name: Check projection rebuild deployment budget\n"
    );
    const orchestratorDeploy = deploy.indexOf("      - name: Deploy memory orchestrator\n");

    expect(budget).toContain(
      "pnpm projection:rebuild:plan --resume --max-wait-seconds 3600"
    );
    expect(budget).toContain("timeout-minutes: 5");
    expect(budgetStart).toBeLessThan(orchestratorDeploy);
  });

  it("retains the cleanup ledger when canary recovery cannot finish", () => {
    expect(workflowStep(deploy, "Remove ephemeral deployment files")).not.toContain(
      "EDGEMNEME_CANARY_CLEANUP_LEDGER"
    );
  });

  it("fails closed unless both migrated databases are complete and structurally healthy", () => {
    const validation = workflowStep(migrate, "Validate migrated D1 databases");
    const searchMigration = migrate.indexOf("      - name: Apply search database migrations\n");
    const validationStart = migrate.indexOf("      - name: Validate migrated D1 databases\n");

    expect(validation).toContain("migrations list \"$database\" --remote");
    expect(validation).toContain("No migrations to apply!");
    expect(validation).toContain("Migrations to be applied:");
    expect(validation).toContain("check_no_pending MEMORY_DB");
    expect(validation).toContain("check_no_pending SEARCH_DB");
    expect(validation).toContain("PRAGMA quick_check");
    expect(validation).toContain("PRAGMA foreign_key_check");
    expect(validation).toContain("SELECT type, name, sql FROM sqlite_master");
    expect(validation).toContain("WHERE sql IS NOT NULL ORDER BY type, name");
    expect(validation).not.toContain("name IN (");
    expect(validation).toContain("validate-integrity");
    expect(validation).toContain("validate-schema");
    expect(validationStart).toBeGreaterThan(searchMigration);
  });

  it("always removes local migration backup material without deleting private R2 recovery data", () => {
    const cleanup = workflowStep(migrate, "Remove ephemeral migration files");

    expect(cleanup).toContain("if: always()");
    expect(cleanup).toContain("EDGEMNEME_D1_BACKUP_DIR");
    expect(cleanup).not.toContain("r2 object delete");
  });

});
