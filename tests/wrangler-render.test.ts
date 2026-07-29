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
      d1_databases: [
        { binding: "MEMORY_DB", database_id: baseEnvironment.CF_D1_MEMORY_DATABASE_ID }
      ]
    });
    expect(rendered).not.toHaveProperty("secrets");
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

  it("pins the orchestrator Workflow CPU and snapshot subrequest limits", () => {
    const rendered = renderConfig("memory-orchestrator", sourceConfig("memory-orchestrator"), {
      ...baseEnvironment,
      CF_D1_MEMORY_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
      CF_D1_SEARCH_DATABASE_ID: "33333333-3333-4333-8333-333333333333"
    });

    expect(rendered.limits).toEqual({ cpu_ms: 300_000, subrequests: 50_000 });
  });
});

describe("production workflow secret isolation", () => {
  const deploy = workflowSource("deploy.yml");
  const migrate = workflowSource("migrate-d1.yml");

  it("keeps secrets out of job-level environments and source validation", () => {
    expect(deploy).not.toMatch(/^    env:/mu);
    expect(migrate).not.toMatch(/^    env:/mu);
    expect(workflowStep(deploy, "Validate source and public Wrangler templates")).not.toContain(
      "env:"
    );
  });

  it("exposes production secrets only to their minimum deployment steps", () => {
    const allowedDeploySteps = [
      "Require fully migrated remote D1 databases",
      "Ensure semantic Vectorize metadata indexes",
      "Check projection rebuild deployment budget",
      "Capture pre-deployment Worker versions",
      "Rebuild and verify projections",
      "Create ephemeral gateway secret file",
      "Create ephemeral GitHub sync secret file",
      "Deploy memory orchestrator",
      "Deploy memory gateway",
      "Run isolated production canary",
      "Recover isolated production canary",
      "Reconcile disabled GitHub sync",
      "Deploy GitHub sync",
      "Rollback failed Worker deployment"
    ].map((name) => workflowStep(deploy, name)).join("\n");
    const allowedMigrationSteps = [
      "Capture and verify private pre-migration backups",
      "Apply memory database migrations",
      "Apply search database migrations",
      "Validate migrated D1 databases"
    ].map((name) => workflowStep(migrate, name)).join("\n");
    const secretPattern = /\$\{\{ secrets\.[A-Z0-9_]+ \}\}/gu;

    expect(deploy.match(secretPattern)?.sort()).toEqual(
      allowedDeploySteps.match(secretPattern)?.sort()
    );
    expect(migrate.match(secretPattern)?.sort()).toEqual(
      allowedMigrationSteps.match(secretPattern)?.sort()
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

  it("captures and rolls back only this run's advanced Workers in reverse dependency order", () => {
    const capture = workflowStep(deploy, "Capture pre-deployment Worker versions");
    const disabledSync = workflowStep(deploy, "Reconcile disabled GitHub sync");
    const orchestratorDeploy = workflowStep(deploy, "Deploy memory orchestrator");
    const gatewayDeploy = workflowStep(deploy, "Deploy memory gateway");
    const githubSyncDeploy = workflowStep(deploy, "Deploy GitHub sync");
    const rollback = workflowStep(deploy, "Rollback failed Worker deployment");
    const captureStart = deploy.indexOf("      - name: Capture pre-deployment Worker versions\n");
    const orchestratorStart = deploy.indexOf("      - name: Deploy memory orchestrator\n");
    const rollbackStart = deploy.indexOf("      - name: Rollback failed Worker deployment\n");
    const canaryStart = deploy.indexOf("      - name: Run isolated production canary\n");

    expect(capture).toContain("https://api.cloudflare.com/client/v4/accounts/");
    expect(capture).toContain('redirect: "manual"');
    expect(capture).toContain("response.status === 404");
    expect(capture).toContain("bootstrap_expected_empty");
    expect(capture).toContain("workflow_dispatch");
    expect(capture).toContain("expected both core Workers to be absent");
    expect(capture).toContain("EDGEMNEME_ORCHESTRATOR_PREVIOUS_VERSION");
    expect(capture).toContain("EDGEMNEME_GATEWAY_PREVIOUS_VERSION");
    expect(capture).toContain("EDGEMNEME_GITHUB_SYNC_PREVIOUS_VERSION");
    expect(capture).toContain("EDGEMNEME_GITHUB_SYNC_PREVIOUS_STATE");
    expect(capture).toContain("EDGEMNEME_GITHUB_SYNC_PREVIOUS_SCHEDULE_STATE");
    expect(capture).toContain("edgemneme-github-sync");
    expect(capture).toContain("read_github_sync_schedule_state");
    expect(capture).toContain("Enabled bootstrap expected the GitHub sync Worker to be absent");
    expect(capture).toContain("percentage !== 100");
    expect(capture).toContain("invalid creation timestamp");
    expect(orchestratorDeploy).toContain(
      '--tag "edgemneme-ledger-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-orchestrator"'
    );
    expect(gatewayDeploy).toContain('--tag "github-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-gateway"');
    expect(githubSyncDeploy).toContain(
      '--tag "github-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-github-sync-enabled"'
    );
    expect(githubSyncDeploy).toContain("wrangler secret list");
    expect(githubSyncDeploy).toContain(
      'secrets.length !== 1 || secrets[0]?.name !== "GITHUB_CLASSIC_TOKEN"'
    );
    expect(githubSyncDeploy).toContain("/workers/scripts/edgemneme-github-sync/schedules");
    expect(githubSyncDeploy).toContain('schedules.length !== 1');
    expect(disabledSync).toContain(
      "if: vars.ENABLE_GITHUB_SYNC == 'false' && steps.capture_core_versions.outputs.github_sync_state == 'present'"
    );
    expect(disabledSync).toContain(
      '--tag "github-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-github-sync-disabled"'
    );
    expect(disabledSync).toContain('{"GITHUB_CLASSIC_TOKEN":null}');
    expect(disabledSync).toContain("wrangler secret bulk");
    expect(disabledSync).toContain("wrangler secret list");
    expect(disabledSync).toContain("secrets.length !== 0");
    expect(disabledSync).toContain("schedules.length !== 0");
    expect(disabledSync).not.toContain("secrets.GITHUB_CLASSIC_TOKEN");
    expect(deploy).toContain("  rollback_workers:\n");
    expect(deploy).toContain("    needs: deploy\n");
    expect(deploy).toContain(
      "    if: ${{ always() && needs.deploy.result == 'failure' && needs.deploy.outputs.bootstrap_mode != '' }}\n"
    );
    expect(deploy).toContain("    timeout-minutes: 120\n");
    expect(deploy).toContain(
      "orchestrator_previous_version: ${{ steps.capture_core_versions.outputs.orchestrator_version }}"
    );
    expect(deploy).toContain(
      "gateway_previous_version: ${{ steps.capture_core_versions.outputs.gateway_version }}"
    );
    expect(deploy).toContain(
      "github_sync_previous_version: ${{ steps.capture_core_versions.outputs.github_sync_version }}"
    );
    expect(deploy).toContain(
      "github_sync_previous_state: ${{ steps.capture_core_versions.outputs.github_sync_state }}"
    );
    expect(deploy).toContain(
      "bootstrap_mode: ${{ steps.capture_core_versions.outputs.bootstrap_mode }}"
    );
    expect(rollback).not.toContain("wrangler versions list");
    expect(rollback).toContain('wrangler versions view "$version_id"');
    expect(rollback.match(/wrangler versions view/gu)).toHaveLength(2);
    expect(rollback).toContain("wrangler deployments list");
    expect(rollback).toContain('local expected_absent="$6"');
    expect(rollback).toContain("absent outside its captured expected-absent state");
    expect(rollback).toContain("refusing rollback");
    expect(rollback).toContain("deployment tag is unavailable; refusing rollback");
    expect(rollback).toContain("confirmed_version");
    expect(rollback).toContain("version_has_ledger_capability");
    expect(rollback).toContain("previous orchestrator version metadata is unavailable");
    expect(rollback).toContain("Manual roll-forward is required");
    expect(rollback).toContain('tag.startsWith("edgemneme-ledger-")');
    expect(rollback).toContain("not proven compatible with the Search chunk ledger");
    expect(rollback).toContain("deployment changed after rollback guards; refusing rollback");
    expect(rollback).toContain("event_type = 'projection.rebuild.requested'");
    expect(rollback).toContain("workflow_type = 'projection.rebuild.requested'");
    expect(rollback).toContain("rebuild_run.root_workflow_id = rebuild_event.event_id");
    expect(rollback).toContain("status IN ('complete', 'failed', 'terminated')");
    expect(rollback).toContain(
      "ORDER BY rebuild_run.updated_at DESC, rebuild_run.workflow_id DESC"
    );
    expect(rollback).toContain(
      "status NOT IN ('complete', 'failed', 'terminated')"
    );
    expect(rollback).toContain("retaining the current orchestrator");
    expect(rollback).toContain("wrangler delete --config \"$config\" --force");
    expect(rollback).toContain("Retaining the bootstrap orchestrator");
    expect(rollback).toContain("wrangler rollback \"$previous_version\"");
    expect(rollback).toContain("restore_github_sync_schedule_state");
    expect(rollback).toContain("body: JSON.stringify(desired)");
    expect(rollback).not.toContain("body: JSON.stringify({ schedules: desired })");
    expect(rollback).toContain("EDGEMNEME_GITHUB_SYNC_ENABLED");
    expect(rollback).toContain("rollback_if_advanced github-sync");
    expect(rollback).toContain("rollback_if_advanced gateway");
    expect(rollback).toContain("rollback_if_advanced orchestrator");
    expect(rollback.indexOf("rollback_if_advanced github-sync"))
      .toBeLessThan(rollback.indexOf("rollback_if_advanced gateway"));
    expect(rollback.indexOf("rollback_if_advanced gateway"))
      .toBeLessThan(rollback.indexOf("rollback_if_advanced orchestrator"));
    expect(rollback).toContain("gateway_status=$?");
    expect(rollback).toContain("orchestrator_status=$?");
    expect(captureStart).toBeLessThan(orchestratorStart);
    expect(canaryStart).toBeLessThan(rollbackStart);
  });

  it("keeps rollback blocked when a newer projection repair is still running", () => {
    const rollback = workflowStep(deploy, "Rollback failed Worker deployment");
    const query = rollback.match(/--command "(SELECT[\s\S]*?AS count;)"/u)?.[1];
    expect(query).toBeDefined();

    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE outbox_events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        dispatched_at TEXT,
        failed_at TEXT
      );
      CREATE TABLE workflow_runs (
        workflow_id TEXT PRIMARY KEY,
        root_workflow_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workflow_type TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO outbox_events
        (event_id, project_id, event_type, dispatched_at, failed_at)
      VALUES
        ('rebuild-event', 'project-1', 'projection.rebuild.requested',
         '2026-07-28T00:00:00.000Z', NULL);
      INSERT INTO workflow_runs
        (workflow_id, root_workflow_id, project_id, workflow_type, status, updated_at)
      VALUES
        ('rebuild-base', 'rebuild-event', 'project-1',
         'projection.rebuild.requested', 'failed', '2026-07-28T00:00:01.000Z'),
        ('rebuild-base-repair-1', 'rebuild-event', 'project-1',
         'projection.rebuild.requested', 'running', '2026-07-28T00:00:02.000Z');
    `);

    expect(database.prepare(query!).get()).toEqual({ count: 2 });
    database.prepare(
      "UPDATE workflow_runs SET status = 'complete' WHERE workflow_id = ?"
    ).run("rebuild-base-repair-1");
    expect(database.prepare(query!).get()).toEqual({ count: 0 });
    database.close();
  });

  it("fails closed when a previously deployed Worker is unexpectedly absent", () => {
    const script = workflowRunScript(deploy, "Rollback failed Worker deployment");
    const functionStart = script.indexOf("rollback_if_advanced() {");
    const functionEnd = script.indexOf("\n}\nset +e", functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const rollbackFunction = script.slice(functionStart, functionEnd + 2);
    const harness = `
set -euo pipefail
worker_presence() { printf absent; }
${rollbackFunction}
rollback_if_advanced gateway package.json "\${PREVIOUS_VERSION-}" tag worker "\${EXPECTED_ABSENT-false}"
`;
    const run = (expectedAbsent: string, previousVersion: string) =>
      spawnSync("bash", ["-c", harness], {
        env: {
          ...process.env,
          EXPECTED_ABSENT: expectedAbsent,
          PREVIOUS_VERSION: previousVersion
        },
        encoding: "utf8"
      });

    const normalRun = run("false", "previous-version");
    expect(normalRun.status).toBe(1);
    expect(normalRun.stderr).toContain("absent outside its captured expected-absent state");

    const inconsistentBootstrap = run("true", "previous-version");
    expect(inconsistentBootstrap.status).toBe(1);
    expect(inconsistentBootstrap.stderr).toContain("absent outside its captured expected-absent state");

    const emptyBootstrap = run("true", "");
    expect(emptyBootstrap.status, emptyBootstrap.stderr).toBe(0);
  });

  it("checks ledger capability by exact previous version instead of the recent-version window", () => {
    const script = workflowRunScript(deploy, "Rollback failed Worker deployment");
    const functionStart = script.indexOf("version_has_ledger_capability() {");
    const functionEnd = script.indexOf("\n}\nrebuild_work_state()", functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const capabilityFunction = script.slice(functionStart, functionEnd + 2);
    const harness = `
set -euo pipefail
pnpm() {
  if [[ "\${PNPM_FAIL:-false}" == "true" ]]; then
    return 1
  fi
  if [[ "$*" != "exec wrangler versions view \${VERSION_ID} --config package.json --json" ]]; then
    echo "unexpected Wrangler command: $*" >&2
    return 2
  fi
  printf '%s' "\${VERSION_VIEW_JSON-}"
}
${capabilityFunction}
version_has_ledger_capability package.json "\${VERSION_ID}"
`;
    const versionId = "11111111-1111-4111-8111-111111111111";
    const run = (version: unknown, options: { fail?: boolean; requestedId?: string } = {}) =>
      spawnSync("bash", ["-c", harness], {
        env: {
          ...process.env,
          PNPM_FAIL: options.fail === true ? "true" : "false",
          VERSION_ID: options.requestedId ?? versionId,
          VERSION_VIEW_JSON: JSON.stringify(version)
        },
        encoding: "utf8"
      });

    const compatible = run({
      id: versionId,
      annotations: { "workers/tag": "edgemneme-ledger-run-1" }
    });
    expect(compatible.status, compatible.stderr).toBe(0);
    expect(compatible.stdout).toBe("compatible");

    const incompatible = run({
      id: versionId,
      annotations: { "workers/tag": "legacy-version" }
    });
    expect(incompatible.status, incompatible.stderr).toBe(0);
    expect(incompatible.stdout).toBe("incompatible");

    const mismatched = run({
      id: "22222222-2222-4222-8222-222222222222",
      annotations: { "workers/tag": "edgemneme-ledger-run-1" }
    });
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("cannot be identified exactly");

    const unavailable = run({}, { fail: true });
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain("previous orchestrator version metadata is unavailable");
    expect(unavailable.stderr).toContain("Manual roll-forward is required");
  });

  it("resolves this run only from the exact active version and expected tag", () => {
    const script = workflowRunScript(deploy, "Rollback failed Worker deployment");
    const functionStart = script.indexOf("tagged_current_version() {");
    const functionEnd = script.indexOf(
      "\n}\nversion_has_ledger_capability()",
      functionStart
    );
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const taggedVersionFunction = script.slice(functionStart, functionEnd + 2);
    const harness = `
set -euo pipefail
pnpm() {
  if [[ "\${PNPM_FAIL:-false}" == "true" ]]; then
    return 1
  fi
  if [[ "$*" != "exec wrangler versions view \${VERSION_ID} --config package.json --json" ]]; then
    echo "unexpected Wrangler command: $*" >&2
    return 2
  fi
  printf '%s' "\${VERSION_VIEW_JSON-}"
}
${taggedVersionFunction}
tagged_current_version package.json "\${VERSION_ID}" "\${EXPECTED_TAG}"
`;
    const versionId = "11111111-1111-4111-8111-111111111111";
    const expectedTag = "edgemneme-ledger-run-1";
    const run = (version: unknown, fail = false) =>
      spawnSync("bash", ["-c", harness], {
        env: {
          ...process.env,
          EXPECTED_TAG: expectedTag,
          PNPM_FAIL: fail ? "true" : "false",
          VERSION_ID: versionId,
          VERSION_VIEW_JSON: JSON.stringify(version)
        },
        encoding: "utf8"
      });

    const matching = run({
      id: versionId,
      annotations: { "workers/tag": expectedTag }
    });
    expect(matching.status, matching.stderr).toBe(0);
    expect(matching.stdout).toBe(versionId);

    const external = run({
      id: versionId,
      annotations: { "workers/tag": "external-deployment" }
    });
    expect(external.status, external.stderr).toBe(0);
    expect(external.stdout).toBe("");

    const mismatched = run({
      id: "22222222-2222-4222-8222-222222222222",
      annotations: { "workers/tag": expectedTag }
    });
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("current Worker version cannot be identified exactly");

    const unavailable = run({}, true);
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain("current Worker version metadata is unavailable");
    expect(unavailable.stderr).toContain("refusing rollback");
  });

  it("keeps the extracted rollback shell and embedded JavaScript syntactically valid", () => {
    const script = workflowRunScript(deploy, "Rollback failed Worker deployment");
    const shell = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(shell.status, shell.stderr).toBe(0);

    const modules = [...script.matchAll(/<<'NODE'\n([\s\S]*?)\nNODE/gu)].map(
      (match) => match[1]
    );
    expect(modules.length).toBeGreaterThanOrEqual(4);
    for (const moduleSource of modules) {
      const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: moduleSource,
        encoding: "utf8"
      });
      expect(syntax.status, syntax.stderr).toBe(0);
    }
  });

  it("retries exact synthetic cleanup only after the production canary fails", () => {
    const prepare = workflowStep(deploy, "Prepare isolated canary identity");
    const canary = workflowStep(deploy, "Run isolated production canary");
    const recovery = workflowStep(deploy, "Recover isolated production canary");

    expect(prepare).toContain("EDGEMNEME_CANARY_PROJECT_ID");
    expect(prepare).toContain("EDGEMNEME_CANARY_PRINCIPAL_ID");
    expect(prepare).toContain("EDGEMNEME_CANARY_CLEANUP_LEDGER");
    expect(canary).toContain("id: isolated_production_canary");
    expect(canary).toContain("timeout-minutes: 20");
    expect(recovery).toContain(
      "if: failure() && steps.isolated_production_canary.outcome == 'failure'"
    );
    expect(recovery).not.toContain("if: always()");
    expect(recovery).toContain("--cleanup-only");
    expect(recovery).not.toContain("TOKEN_DIGEST_PEPPER");
  });

  it("removes each Worker secret file immediately after its deployment window", () => {
    const orchestratorDeploy = deploy.indexOf("      - name: Deploy memory orchestrator\n");
    const gatewaySecret = deploy.indexOf("      - name: Create ephemeral gateway secret file\n");
    const gatewayDeploy = deploy.indexOf("      - name: Deploy memory gateway\n");
    const gatewaySecretRemoval = deploy.indexOf("      - name: Remove gateway secret file\n");
    const canary = deploy.indexOf("      - name: Run isolated production canary\n");
    const recovery = deploy.indexOf("      - name: Recover isolated production canary\n");
    const githubSecret = deploy.indexOf("      - name: Create ephemeral GitHub sync secret file\n");
    const githubDeploy = deploy.indexOf("      - name: Deploy GitHub sync\n");
    const githubSecretRemoval = deploy.indexOf("      - name: Remove GitHub sync secret file\n");

    expect(orchestratorDeploy).toBeGreaterThan(-1);
    expect(gatewaySecret).toBeGreaterThan(-1);
    expect(orchestratorDeploy).toBeLessThan(gatewaySecret);
    expect(gatewaySecret).toBeLessThan(gatewayDeploy);
    expect(deploy.slice(gatewaySecret, gatewayDeploy)).not.toContain("\n      - name: ");
    expect(gatewayDeploy).toBeLessThan(gatewaySecretRemoval);
    expect(gatewaySecretRemoval).toBeLessThan(canary);
    expect(workflowStep(deploy, "Remove gateway secret file")).toContain("if: always()");

    expect(recovery).toBeLessThan(githubSecret);
    expect(githubSecret).toBeLessThan(githubDeploy);
    expect(githubDeploy).toBeLessThan(githubSecretRemoval);
    expect(workflowStep(deploy, "Remove GitHub sync secret file")).toContain("always()");
  });

  it("retains the cleanup ledger when canary recovery cannot finish", () => {
    expect(workflowStep(deploy, "Remove ephemeral deployment files")).not.toContain(
      "EDGEMNEME_CANARY_CLEANUP_LEDGER"
    );
  });

  it("retains exact pre-migration recovery points in a verified private R2 backup", () => {
    const backup = workflowStep(migrate, "Capture and verify private pre-migration backups");
    const memoryMigration = migrate.indexOf("      - name: Apply memory database migrations\n");
    const backupStart = migrate.indexOf(
      "      - name: Capture and verify private pre-migration backups\n"
    );

    expect(backup).toContain('d1 time-travel info "$database" --json');
    expect(backup).toContain("capture_bookmark MEMORY_DB");
    expect(backup).toContain("capture_bookmark SEARCH_DB");
    expect(backup).toContain("d1 export MEMORY_DB --remote");
    expect(backup).not.toContain("d1 export SEARCH_DB");
    expect(backup).toContain("search_generations");
    expect(backup).toContain("memory_fts");
    expect(backup).toContain("memory_projection_heads");
    expect(backup).toContain("system/backups/d1-migrations/");
    expect(backup).toContain('r2 bucket domain list "$backup_bucket"');
    expect(backup).toContain("There are no custom domains connected to this bucket.");
    expect(backup).toContain('r2 bucket dev-url get "$backup_bucket"');
    expect(backup).toContain("Public access via the r2.dev URL is disabled.");
    expect(backup).toContain("wrangler r2 object put");
    expect(backup).toContain("wrangler r2 object get");
    expect(backup).toContain("cmp --silent");
    expect(backup).toContain("create-backup-manifest");
    expect(backup).toContain("verify-backup");
    expect(backup.indexOf('upload_and_verify "manifest.json"'))
      .toBeGreaterThan(backup.indexOf('upload_and_verify "memory-projection-heads.jsonl"'));
    expect(backupStart).toBeGreaterThan(-1);
    expect(backupStart).toBeLessThan(memoryMigration);
    expect(migrate).not.toContain("actions/upload-artifact");
    expect(migrate).not.toContain("time-travel restore");
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
