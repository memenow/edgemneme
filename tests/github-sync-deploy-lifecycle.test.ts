import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github", "workflows", "deploy.yml"),
  "utf8"
);
const githubWorkflowMigration = readFileSync(
  join(process.cwd(), "migrations", "0019_github_sync_workflows.sql"),
  "utf8"
);
const githubWorkflowRuntime = readFileSync(
  join(process.cwd(), "src", "github", "sync-workflow.ts"),
  "utf8"
);

function workflowStep(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step ${name} was not found.`);
  }
  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function workflowRunScript(name: string): string {
  const step = workflowStep(name);
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

function nodeHeredocContaining(step: string, marker: string): string {
  const heredocs = [...step.matchAll(/<<'NODE'\n([\s\S]*?)\nNODE/g)].map(
    (match) => match[1]
  ).filter((candidate): candidate is string => candidate !== undefined);
  const heredoc = heredocs.find((candidate) => candidate.includes(marker));
  if (heredoc === undefined) {
    throw new Error(`A Node heredoc containing ${marker} was not found.`);
  }
  return heredoc;
}

function rollbackFunction(): string {
  const script = workflowRunScript("Rollback failed Worker deployment");
  const start = script.indexOf("rollback_if_advanced() {");
  const end = script.indexOf("\n}\nset +e", start);
  if (start === -1 || end === -1) {
    throw new Error("The rollback function was not found.");
  }
  return script.slice(start, end + 2);
}

function rollbackNodeHeredoc(functionName: string): string {
  const script = workflowRunScript("Rollback failed Worker deployment");
  const functionStart = script.indexOf(`${functionName}() {`);
  const heredocStart = script.indexOf("<<'NODE'\n", functionStart);
  const heredocEnd = script.indexOf("\nNODE\n", heredocStart);
  if (functionStart === -1 || heredocStart === -1 || heredocEnd === -1) {
    throw new Error(`The ${functionName} Node heredoc was not found.`);
  }
  return script.slice(heredocStart + "<<'NODE'\n".length, heredocEnd);
}

function githubRollbackFunction(): string {
  const script = workflowRunScript("Rollback failed Worker deployment");
  const start = script.indexOf("rollback_github_sync() {");
  const end = script.indexOf("\n}\nset +e", start);
  if (start === -1 || end === -1) {
    throw new Error("The GitHub sync rollback function was not found.");
  }
  return script.slice(start, end + 2);
}

function shellFunctionBetween(stepName: string, functionName: string, nextFunctionName: string): string {
  const script = workflowRunScript(stepName);
  const start = script.indexOf(`${functionName}() {`);
  const end = script.indexOf(`\n${nextFunctionName}() {`, start);
  if (start === -1 || end === -1) {
    throw new Error(`The ${functionName} shell function was not found.`);
  }
  return script.slice(start, end);
}

describe("GitHub sync deployment lifecycle", () => {
  it("keeps an absent disabled Worker absent and reconciles only a present one", () => {
    const disabled = workflowStep("Reconcile disabled GitHub sync");

    expect(disabled).toContain(
      "needs.capture_production_state.outputs.github_sync_previous_state == 'present'"
    );
    expect(disabled).toContain("wrangler deploy --strict");
    expect(disabled).toContain("wait_for_github_sync_drain");
    expect(disabled.indexOf("wrangler deploy --strict")).toBeLessThan(
      disabled.lastIndexOf("wait_for_github_sync_drain")
    );
    expect(disabled.lastIndexOf("wait_for_github_sync_drain")).toBeLessThan(
      disabled.lastIndexOf('remove_github_sync_secret_with_tag "$secretless_tag"')
    );
    expect(disabled).toContain("secrets: { GITHUB_CLASSIC_TOKEN: null }");
    expect(disabled).toContain("wrangler secret list");
    expect(disabled).toContain("secrets.length !== 0");
    expect(disabled).toContain("schedules.length !== 0");
    expect(disabled).toContain("zero_observations");
    expect(disabled).toContain("zero_observations=0");
    expect(disabled).toContain("sleep 60");
    expect(disabled).toContain('ALLOW_MISSING_WORKFLOWS="false"');
    expect(disabled).toContain("github_sync_d1_state");
    expect(disabled).toContain("status IN ('materialized', 'dispatching')");
    expect(disabled).toContain("status IN ('pending', 'running')");
    expect(disabled).toContain("status = 'running'");
    expect(disabled).toContain("holder_id IS NOT NULL");
    expect(disabled).toContain("lease_claim_id IS NOT NULL");
    expect(disabled).toContain("lease_until IS NOT NULL");
    expect(disabled).toContain("sqlite_master");
  });

  it("exhausts every Workflow status page and rejects a repeated cursor", () => {
    const disabled = workflowStep("Reconcile disabled GitHub sync");
    const lifecycleClient = nodeHeredocContaining(
      workflowRunScript("Reconcile disabled GitHub sync"),
      "const workflowContracts ="
    );
    const prelude = `
const requested = [];
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  requested.push(url.toString());
  if (url.pathname.endsWith("/workflows")) {
    const result = [
      ["dispatch", "edgemneme-github-dispatch-workflow", "GitHubDispatchWorkflow"],
      ["ref", "edgemneme-github-ref-sync-workflow", "GitHubRefSyncWorkflow"],
      ["retention", "edgemneme-github-retention-workflow", "GitHubRetentionWorkflow"]
    ].map(([id, name, class_name]) => ({
      id, name, class_name, script_name: "edgemneme-github-sync", schedules: []
    }));
    return Response.json({
      success: true,
      result,
      result_info: { count: 3, page: 1, per_page: 100, total_count: 3, total_pages: 1 }
    });
  }
  if (!url.pathname.endsWith("/instances")) {
    const name = decodeURIComponent(url.pathname.split("/").at(-1));
    const definitions = {
      "edgemneme-github-dispatch-workflow": "GitHubDispatchWorkflow",
      "edgemneme-github-ref-sync-workflow": "GitHubRefSyncWorkflow",
      "edgemneme-github-retention-workflow": "GitHubRetentionWorkflow"
    };
    return Response.json({
      success: true,
      result: { name, class_name: definitions[name], script_name: "edgemneme-github-sync" }
    });
  }
  const workflowName = decodeURIComponent(url.pathname.split("/").at(-2));
  const status = url.searchParams.get("status");
  const cursor = url.searchParams.get("cursor");
  if (workflowName === "edgemneme-github-dispatch-workflow" && status === "running") {
    if (cursor === null) {
      return Response.json({
        success: true,
        result: [{ id: "first", status: "running" }],
        result_info: { cursor: "next-page" }
      });
    }
    if (cursor === "next-page") {
      return Response.json({
        success: true,
        result: [{ id: "second", status: "running" }],
        result_info: { cursor: null }
      });
    }
  }
  return Response.json({ success: true, result: [], result_info: { cursor: null } });
};
process.on("exit", () => {
  if (!requested.some((url) => url.includes("cursor=next-page"))) process.exitCode = 91;
});
`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `${prelude}\n${lifecycleClient}`],
      {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
          CLOUDFLARE_API_TOKEN: "synthetic-token",
          ALLOW_MISSING_WORKFLOWS: "false"
        },
        encoding: "utf8"
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("pending");

    const repeatedCursorPrelude = prelude.replace(
      'result_info: { cursor: null }\n      });\n    }',
      'result_info: { cursor: "next-page" }\n      });\n    }'
    );
    const repeated = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `${repeatedCursorPrelude}\n${lifecycleClient}`],
      {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
          CLOUDFLARE_API_TOKEN: "synthetic-token",
          ALLOW_MISSING_WORKFLOWS: "false"
        },
        encoding: "utf8"
      }
    );
    expect(repeated.status).not.toBe(0);
    expect(repeated.stderr).toContain("cursor");
  });

  it("deduplicates an instance that transitions across non-snapshot status queries", () => {
    const lifecycleClient = nodeHeredocContaining(
      workflowRunScript("Reconcile disabled GitHub sync"),
      "const workflowContracts ="
    );
    const script = `
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/workflows")) {
    const result = [
      ["dispatch", "edgemneme-github-dispatch-workflow", "GitHubDispatchWorkflow"],
      ["ref", "edgemneme-github-ref-sync-workflow", "GitHubRefSyncWorkflow"],
      ["retention", "edgemneme-github-retention-workflow", "GitHubRetentionWorkflow"]
    ].map(([id, name, class_name]) => ({
      id, name, class_name, script_name: "edgemneme-github-sync", schedules: []
    }));
    return Response.json({
      success: true,
      result,
      result_info: { count: 3, page: 1, per_page: 100, total_count: 3, total_pages: 1 }
    });
  }
  if (!url.pathname.endsWith("/instances")) {
    const name = decodeURIComponent(url.pathname.split("/").at(-1));
    const definitions = {
      "edgemneme-github-dispatch-workflow": "GitHubDispatchWorkflow",
      "edgemneme-github-ref-sync-workflow": "GitHubRefSyncWorkflow",
      "edgemneme-github-retention-workflow": "GitHubRetentionWorkflow"
    };
    return Response.json({
      success: true,
      result: { name, class_name: definitions[name], script_name: "edgemneme-github-sync" }
    });
  }
  const workflowName = decodeURIComponent(url.pathname.split("/").at(-2));
  const status = url.searchParams.get("status");
  const result = workflowName === "edgemneme-github-dispatch-workflow" &&
    (status === "running" || status === "waiting")
    ? [{ id: "transitioning-instance", status }]
    : [];
  return Response.json({ success: true, result, result_info: { cursor: null } });
};
${lifecycleClient}
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
        CLOUDFLARE_API_TOKEN: "synthetic-token",
        ALLOW_MISSING_WORKFLOWS: "false"
      },
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("pending");
    for (const lifecycle of [
      workflowStep("Reconcile disabled GitHub sync"),
      workflowStep("Rollback failed Worker deployment")
    ]) {
      expect(lifecycle).toContain("statusInstanceKeys");
      expect(lifecycle).toContain("observedInstanceKeys");
    }
  });

  it("rejects a fourth remote Workflow owned by the GitHub sync Worker", () => {
    const lifecycleClient = nodeHeredocContaining(
      workflowRunScript("Reconcile disabled GitHub sync"),
      "const workflowContracts ="
    );
    const script = `
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/workflows")) {
    const result = [
      ["dispatch", "edgemneme-github-dispatch-workflow", "GitHubDispatchWorkflow"],
      ["ref", "edgemneme-github-ref-sync-workflow", "GitHubRefSyncWorkflow"],
      ["retention", "edgemneme-github-retention-workflow", "GitHubRetentionWorkflow"],
      ["legacy", "edgemneme-github-legacy-workflow", "LegacyGitHubWorkflow"]
    ].map(([id, name, class_name]) => ({
      id, name, class_name, script_name: "edgemneme-github-sync", schedules: []
    }));
    return Response.json({
      success: true,
      result,
      result_info: { count: 4, page: 1, per_page: 100, total_count: 4, total_pages: 1 }
    });
  }
  throw new Error("Unexpected request after invalid inventory: " + url);
};
${lifecycleClient}
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
        CLOUDFLARE_API_TOKEN: "synthetic-token",
        ALLOW_MISSING_WORKFLOWS: "false"
      },
      encoding: "utf8"
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("inventory");
    for (const lifecycle of [
      workflowStep("Reconcile disabled GitHub sync"),
      workflowStep("Deploy GitHub sync"),
      workflowStep("Rollback failed Worker deployment")
    ]) {
      expect(lifecycle).toContain("workflowInventoryNames");
      expect(lifecycle).toContain("total_pages");
    }
  });

  it("paces every high-cost drain below the Cloudflare global API budget", () => {
    const disabled = workflowStep("Reconcile disabled GitHub sync");
    const rollback = shellFunctionBetween(
      "Rollback failed Worker deployment",
      "wait_for_github_sync_drain",
      "github_sync_secret_state"
    );
    expect(disabled).toContain("for ((attempt = 1; attempt <= 30; attempt++)); do");
    expect(disabled).toContain("if (( attempt < 30 )); then");
    expect(rollback).toContain("for ((attempt = 1; attempt <= 25; attempt++)); do");
    expect(rollback).toContain("if (( attempt < 25 )); then");
    for (const drain of [disabled, rollback]) {
      expect(drain).toContain("sleep 60");
      expect(drain).not.toContain("sleep 5");
    }

    const conservativeCallsPerPoll = 119;
    const pollsPerFiveMinutes = 300 / 60;
    expect(conservativeCallsPerPoll * pollsPerFiveMinutes).toBeLessThan(1_200);
  });

  it("rejects malformed Cloudflare version IDs before any Actions env or output write", () => {
    const captureClient = nodeHeredocContaining(
      workflowRunScript("Capture pre-deployment Worker versions"),
      "Cloudflare Worker state inputs are incomplete."
    );
    const script = `
globalThis.fetch = async () => Response.json({
  success: true,
  result: {
    deployments: [{
      created_on: "2026-08-01T00:00:00.000Z",
      versions: [{ version_id: "123e4567-e89b-42d3-a456-426614174000\\nINJECTED=value", percentage: 100 }]
    }]
  }
});
${captureClient}
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
        CLOUDFLARE_API_TOKEN: "synthetic-token",
        WORKER_NAME: "edgemneme-memory-gateway"
      },
      encoding: "utf8"
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stdout).not.toContain("INJECTED");
    for (const lifecycle of [
      workflowStep("Capture pre-deployment Worker versions"),
      workflowStep("Reconcile disabled GitHub sync"),
      workflowStep("Deploy GitHub sync"),
      workflowStep("Rollback failed Worker deployment"),
    ]) {
      expect(lifecycle).toContain("[0-9a-f]{8}-[0-9a-f]{4}");
    }
  });

  it("pins disabled drain observations and secret deletion to this run's exact version", () => {
    const disabled = workflowRunScript("Reconcile disabled GitHub sync");
    const waitStart = disabled.indexOf("wait_for_github_sync_drain() {");
    const waitCall = disabled.indexOf("\nwait_for_github_sync_drain\n", waitStart);
    const waitBody = disabled.slice(waitStart, waitCall);
    const secretMutation = disabled.indexOf(
      'remove_github_sync_secret_with_tag "$secretless_tag"',
      waitCall
    );
    const finalFence = disabled.lastIndexOf(
      'final_observation_state="$(github_sync_zero_observation)"',
      secretMutation
    );
    const afterMutation = disabled.slice(secretMutation);

    expect(disabled).toContain("active_version() {");
    expect(disabled).toContain("tagged_current_version() {");
    expect(disabled).toContain("version_has_exact_disabled_github_contract() {");
    expect(disabled).toContain(
      'quiesce_tag="edgemneme-github-workflows-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-disabled"'
    );
    expect(disabled).toContain('quiesced_version="$(active_version)"');
    expect(disabled).toContain(
      'tagged_current_version "$quiesced_version" "$quiesce_tag"'
    );
    expect(waitBody).toContain('observation_state="$(github_sync_zero_observation)"');
    expect(finalFence).toBeGreaterThan(waitCall);
    expect(finalFence).toBeLessThan(secretMutation);
    expect(disabled).toContain('version_tags: { "workers/tag": tag }');
    expect(disabled).toContain("secrets: { GITHUB_CLASSIC_TOKEN: null }");
    expect(afterMutation).toContain('secretless_version="$(active_version)"');
    expect(afterMutation).toContain(
      'tagged_current_version "$secretless_version" "$secretless_tag"'
    );
    expect(afterMutation).toContain(
      'version_has_exact_disabled_github_contract "$secretless_version" "absent"'
    );
  });

  it("tags the secretless disabled version so a failed re-enable restores it without a PAT", () => {
    const disabled = workflowRunScript("Reconcile disabled GitHub sync");
    const rollbackScript = workflowRunScript("Rollback failed Worker deployment");
    const rollback = githubRollbackFunction();
    const rollbackCall = rollback.indexOf('wrangler rollback "$previous_version"');
    const secretCheck = rollback.indexOf(
      'restored_secret_state="$(github_sync_secret_state "$config")"',
      rollbackCall
    );

    expect(disabled).toContain(
      'secretless_tag="edgemneme-github-workflows-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-disabled-secretless"'
    );
    expect(disabled).toContain("version_tags");
    expect(rollback).toContain("version_has_github_workflow_capability");
    expect(rollbackScript).toContain('secretState === "present"');
    expect(rollbackScript).toContain('binding?.type === "secret_text"');
    expect(rollbackCall).toBeGreaterThanOrEqual(0);
    expect(secretCheck).toBeGreaterThan(rollbackCall);
    expect(rollback).toContain(
      '[[ "$restored_secret_state" != "$previous_secret_state" ]]'
    );
    expect(rollback.lastIndexOf('confirmed_version="$(active_version "$config")"')).toBeGreaterThan(
      secretCheck
    );
  });

  it("treats absent pre-Workflow D1 tables as a safe zero probe", () => {
    const d1State = shellFunctionBetween(
      "Reconcile disabled GitHub sync",
      "github_sync_d1_state",
      "wait_for_github_sync_drain"
    );
    const harness = `
set -euo pipefail
config=synthetic.jsonc
pnpm() {
  if [[ "$*" == *"sqlite_master"* ]]; then
    printf '%s' '[{"success":true,"results":[]}]'
  elif [[ "$*" == *"SELECT 0 AS count;"* ]]; then
    printf '%s' '[{"success":true,"results":[{"count":0}]}]'
  else
    echo "unexpected D1 probe: $*" >&2
    return 91
  fi
}
${d1State}
github_sync_d1_state
`;
    const result = spawnSync("bash", ["-c", harness], {
      env: process.env,
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("clear");
  });

  it("keeps every drain query aligned with the durable status contract", () => {
    const lifecycleSources = [
      workflowStep("Reconcile disabled GitHub sync"),
      workflowStep("Rollback failed Worker deployment")
    ];
    expect(githubWorkflowMigration).toContain(
      "status IN ('materialized', 'dispatching', 'complete', 'failed')"
    );
    expect(githubWorkflowMigration).toContain(
      "status IN ('pending', 'running', 'complete', 'failed')"
    );
    expect(githubWorkflowRuntime).toContain("status IN ('materialized', 'dispatching')");
    for (const lifecycle of lifecycleSources) {
      expect(lifecycle).toContain("status IN ('materialized', 'dispatching')");
      expect(lifecycle).toContain("status IN ('pending', 'running')");
      expect(lifecycle).toContain("status = 'running'");
      expect(lifecycle).toContain("holder_id IS NOT NULL");
      expect(lifecycle).toContain("lease_claim_id IS NOT NULL");
      expect(lifecycle).toContain("lease_until IS NOT NULL");
    }
  });

  it("uses an exact Workflow capability boundary before GitHub sync rollback or deletion", () => {
    const rollback = workflowStep("Rollback failed Worker deployment");

    expect(rollback).toContain("rollback_github_sync");
    expect(rollback).toContain("edgemneme-github-workflows-");
    expect(rollback).toContain("version_has_github_workflow_capability");
    expect(rollback).toContain("wait_for_github_sync_drain");
    expect(rollback).toContain("github-sync-rollback-quiesced");
    expect(rollback).toContain("Manual roll-forward is required");
    expect(rollback.indexOf("wait_for_github_sync_drain")).toBeLessThan(
      rollback.indexOf("remove_github_sync_secret_with_tag")
    );
    expect(rollback.indexOf("wait_for_github_sync_drain")).toBeLessThan(
      rollback.indexOf("node scripts/delete-worker-script.mjs edgemneme-github-sync")
    );
  });

  it("pins expected-absent rollback drain and deletion to this run's tagged versions", () => {
    const rollbackScript = workflowRunScript("Rollback failed Worker deployment");
    const rollback = githubRollbackFunction();
    const drain = shellFunctionBetween(
      "Rollback failed Worker deployment",
      "wait_for_github_sync_drain",
      "github_sync_secret_state"
    );
    const absentBranch = rollback.slice(rollback.indexOf('if [[ "$previous_state" == "absent" ]]'));
    const deletion = absentBranch.indexOf(
      "node scripts/delete-worker-script.mjs edgemneme-github-sync"
    );

    expect(rollbackScript).toContain("assert_exact_disabled_github_version() {");
    expect(drain.match(/assert_exact_disabled_github_version/g)).toHaveLength(2);
    expect(rollback).toMatch(
      /wait_for_github_sync_drain \\\n+\s+"\$config" "\$quiesced_version" "\$quiesce_tag"/
    );
    expect(rollback).toContain(
      'secretless_tag="edgemneme-github-workflows-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-github-sync-rollback-secretless"'
    );
    expect(absentBranch).toContain(
      'remove_github_sync_secret_with_tag "$config" "$secretless_tag"'
    );
    expect(absentBranch).toMatch(
      /tagged_current_version \\\n+\s+"\$config" "\$secretless_version" "\$secretless_tag"/
    );
    expect(absentBranch.lastIndexOf("assert_exact_disabled_github_version", deletion))
      .toBeGreaterThanOrEqual(0);
    expect(rollbackScript).toContain("version_tags");
  });

  it.each([
    ["exact capability", false, false, "edgemneme-github-workflows-run", "compatible"],
    ["missing Workflow", true, false, "edgemneme-github-workflows-run", "incompatible"],
    ["Queue binding", false, true, "edgemneme-github-workflows-run", "incompatible"],
    ["legacy tag", false, false, "legacy-direct-cron", "incompatible"]
  ])(
    "classifies a target version with %s",
    (_label, omitWorkflow, includeQueue, tag, expected) => {
      const capabilityClient = rollbackNodeHeredoc(
        "version_has_github_workflow_capability"
      );
      const script = `
globalThis.fetch = async () => Response.json({
  success: true,
  result: {
    id: "target-version",
    resources: {
      bindings: [
        { name: "GITHUB_SYNC_ENABLED", type: "plain_text", text: "true" },
        { name: "GITHUB_CREDENTIAL_VERSION", type: "plain_text", text: "credential-current" },
        { name: "GITHUB_CLASSIC_TOKEN", type: "secret_text" },
        { name: "MEMORY_DB", type: "d1", database_id: "synthetic-database" },
        { name: "GITHUB_DISPATCH_WORKFLOW", type: "workflow", workflow_name: "edgemneme-github-dispatch-workflow", class_name: "GitHubDispatchWorkflow" },
        { name: "GITHUB_REF_SYNC_WORKFLOW", type: "workflow", workflow_name: "edgemneme-github-ref-sync-workflow", class_name: "GitHubRefSyncWorkflow" },
        ...(${JSON.stringify(omitWorkflow)} ? [] : [
          { name: "GITHUB_RETENTION_WORKFLOW", type: "workflow", workflow_name: "edgemneme-github-retention-workflow", class_name: "GitHubRetentionWorkflow" }
        ]),
        ...(${JSON.stringify(includeQueue)} ? [
          { name: "GITHUB_SYNC_QUEUE", type: "queue", queue_name: "legacy-queue" }
        ] : [])
      ]
    }
  }
});
${capabilityClient}
`;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
          CLOUDFLARE_API_TOKEN: "synthetic-token",
          VERSION_ID: "target-version",
          VERSION_JSON: JSON.stringify({
            id: "target-version",
            annotations: { "workers/tag": tag }
          }),
          EDGEMNEME_GITHUB_SYNC_PREVIOUS_SCHEDULE_STATE: "enabled",
          EDGEMNEME_GITHUB_SYNC_PREVIOUS_SECRET_STATE: "present",
          GITHUB_CREDENTIAL_VERSION: "credential-current"
        },
        encoding: "utf8"
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
    }
  );

  it("verifies the exact three remote Workflow definitions before enabling Cron", () => {
    const enabled = workflowStep("Deploy GitHub sync");
    for (const [name, className] of [
      ["edgemneme-github-dispatch-workflow", "GitHubDispatchWorkflow"],
      ["edgemneme-github-ref-sync-workflow", "GitHubRefSyncWorkflow"],
      ["edgemneme-github-retention-workflow", "GitHubRetentionWorkflow"]
    ]) {
      expect(enabled).toContain(name);
      expect(enabled).toContain(className);
    }
    expect(enabled).toContain('workflow?.script_name !== "edgemneme-github-sync"');
    expect(enabled).toContain("workflow.schedules.length !== 0");
  });

  it("pins enabled verification to this run's exact active 100% version and tag", () => {
    const enabled = workflowRunScript("Deploy GitHub sync");
    const deploy = enabled.indexOf("wrangler deploy --strict");
    const firstFence = enabled.indexOf(
      'assert_active_tagged_version "$deployed_version" "$expected_tag"',
      deploy
    );
    const controlPlaneStart = enabled.indexOf(
      'secrets="$(pnpm exec wrangler secret list',
      firstFence
    );
    const finalFence = enabled.lastIndexOf(
      'assert_active_tagged_version "$deployed_version" "$expected_tag"'
    );

    expect(enabled).toContain("active_version() {");
    expect(enabled).toContain("tagged_current_version() {");
    expect(enabled).toContain("latest.versions.length !== 1");
    expect(enabled).toContain("latest.versions[0]?.percentage !== 100");
    expect(enabled).toContain(
      'expected_tag="edgemneme-github-workflows-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-enabled"'
    );
    expect(enabled).toContain('deployed_version="$(active_version)"');
    expect(firstFence).toBeGreaterThan(deploy);
    expect(firstFence).toBeLessThan(controlPlaneStart);
    expect(finalFence).toBeGreaterThan(enabled.indexOf("const workflowContracts ="));
    expect(finalFence).toBeGreaterThan(firstFence);
  });

  it("proves the enabled active version has the exact remote binding contract", () => {
    const enabled = workflowRunScript("Deploy GitHub sync");

    expect(enabled).toContain("version_has_exact_enabled_github_contract() {");
    expect(enabled).toContain(
      "/workers/scripts/edgemneme-github-sync/versions/${encodeURIComponent(versionId)}"
    );
    expect(enabled).toContain('runtime[0]?.text === "true"');
    expect(enabled).toContain("credential[0]?.text === credentialVersion");
    expect(enabled).toContain('secrets[0]?.type === "secret_text"');
    expect(enabled).toContain('!bindings.some((binding) => binding?.type === "queue")');
    expect(enabled).toContain('queue_state="$(github_sync_queue_state)"');
  });

  it("checks Queue consumer control-plane state in every lifecycle fence", () => {
    for (const lifecycle of [
      workflowStep("Reconcile disabled GitHub sync"),
      workflowStep("Deploy GitHub sync"),
      workflowStep("Rollback failed Worker deployment"),
    ]) {
      expect(lifecycle).toContain("/queues");
      expect(lifecycle).toContain("consumers_total_count");
      expect(lifecycle).toContain(
        "[consumer?.script, consumer?.service, consumer?.script_name]"
      );
      expect(lifecycle).toContain("workerScripts.every(validWorkerScript)");
      expect(lifecycle).toContain("value.trim() === value");
      expect(lifecycle).toContain("new Set(workerScripts).size === 1");
      expect(lifecycle).toContain('workerScript === "edgemneme-github-sync"');
      expect(lifecycle).toContain("producers_total_count");
      expect(lifecycle).toContain('producer?.script === "edgemneme-github-sync"');
    }
  });

  it.each([
    ["Reconcile disabled GitHub sync", [], [], 0],
    ["Reconcile disabled GitHub sync", [{ name: "OTHER_SECRET" }], [], 1],
    [
      "Deploy GitHub sync",
      [{ name: "GITHUB_CLASSIC_TOKEN", type: "secret_text" }],
      [{ cron: "0 */6 * * *" }],
      0
    ],
    [
      "Deploy GitHub sync",
      [{ name: "GITHUB_CLASSIC_TOKEN", type: "secret_key" }],
      [{ cron: "0 */6 * * *" }],
      1
    ],
    [
      "Deploy GitHub sync",
      [
        { name: "GITHUB_CLASSIC_TOKEN", type: "secret_text" },
        { name: "OTHER_SECRET", type: "secret_text" }
      ],
      [{ cron: "0 */6 * * *" }],
      1
    ]
  ])(
    "enforces the exact github-sync secret allowlist in %s",
    (stepName, secrets, schedules, expectedStatus) => {
      const verifier = nodeHeredocContaining(
        workflowRunScript(stepName),
        "GitHub sync lifecycle verification output is invalid."
      );
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", verifier],
        {
          env: {
            ...process.env,
            SECRETS_JSON: JSON.stringify(secrets),
            SCHEDULES_JSON: JSON.stringify(schedules),
            SCHEDULES_STATE: stepName === "Reconcile disabled GitHub sync" ? "clear" : undefined
          },
          encoding: "utf8"
        }
      );

      expect(result.status).toBe(expectedStatus);
      if (expectedStatus !== 0) {
        expect(result.stderr).toContain("binding");
      }
    }
  );

  it("rolls back only after quiescing and proving the exact previous capability", () => {
    const rollback = workflowStep("Rollback failed Worker deployment");
    const githubRollback = githubRollbackFunction();
    expect(rollback).toContain("body: JSON.stringify(desired)");
    expect(rollback).not.toContain("body: JSON.stringify({ schedules: desired })");
    expect(githubRollback).toContain("version_has_github_workflow_capability");
    expect(githubRollback).toContain('wrangler rollback "$previous_version"');
    expect(githubRollback.indexOf("wait_for_github_sync_drain")).toBeLessThan(
      githubRollback.lastIndexOf(
        "version_has_github_workflow_capability",
        githubRollback.indexOf('wrangler rollback "$previous_version"')
      )
    );
    expect(githubRollback.indexOf('wrangler rollback "$previous_version"')).toBeLessThan(
      githubRollback.indexOf('restore_github_sync_schedule_state "$previous_schedule_state"')
    );
  });

  it("does not mutate GitHub sync when its active version already matches the capture", () => {
    const githubRollback = githubRollbackFunction();
    const unchangedGuard = githubRollback.indexOf(
      'if [[ "$previous_state" == "present" && "$current_version" == "$previous_version" ]]'
    );
    const quiesceDeploy = githubRollback.indexOf("pnpm exec wrangler deploy --strict");

    expect(unchangedGuard).toBeGreaterThanOrEqual(0);
    expect(unchangedGuard).toBeLessThan(quiesceDeploy);
  });

  it.each([
    ["enabled", [{ cron: "0 */6 * * *" }]],
    ["disabled", []]
  ])("sends the Cloudflare schedule rollback body as the required array for %s", (state, expected) => {
    const script = `
globalThis.fetch = async (_input, init) => {
  const body = String(init?.body ?? "");
  process.stdout.write(body);
  return Response.json({ success: true, result: { schedules: JSON.parse(body) } });
};
${rollbackNodeHeredoc("restore_github_sync_schedule_state")}
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
        CLOUDFLARE_API_TOKEN: "synthetic-token",
        SCHEDULE_STATE: state
      },
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
  });

  it("deletes only this run's tagged GitHub sync Worker when the captured state was absent", () => {
    const githubRollback = githubRollbackFunction();
    const expectedAbsent = githubRollback.indexOf('if [[ "$previous_state" == "absent" ]]');
    const removeSecret = githubRollback.indexOf("remove_github_sync_secret", expectedAbsent);
    const deleteWorker = githubRollback.indexOf(
      "node scripts/delete-worker-script.mjs edgemneme-github-sync",
      expectedAbsent
    );

    expect(expectedAbsent).toBeGreaterThanOrEqual(0);
    expect(removeSecret).toBeGreaterThan(expectedAbsent);
    expect(deleteWorker).toBeGreaterThan(removeSecret);
  });

  it("never restores an enabled GitHub sync version after a disabled reconciliation failure", () => {
    const script = workflowRunScript("Rollback failed Worker deployment");
    const start = script.indexOf("set +e\n");
    const end = script.indexOf("\nset -e\n", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const dispatch = script.slice(start, end + "\nset -e\n".length);
    const harness = `
set -euo pipefail
rollback_if_advanced() { printf '%s\n' "$1"; }
${dispatch}
`;
    const result = spawnSync("bash", ["-c", harness], {
      env: {
        ...process.env,
        EDGEMNEME_GITHUB_SYNC_ENABLED: "false",
        EDGEMNEME_BOOTSTRAP_MODE: "false",
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1"
      },
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["gateway", "orchestrator"]);
  });
});
