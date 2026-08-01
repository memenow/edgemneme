import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github", "workflows", "deploy.yml"),
  "utf8"
);
const migrationWorkflow = readFileSync(
  join(process.cwd(), ".github", "workflows", "migrate-d1.yml"),
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

function migrationStep(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = migrationWorkflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`Migration workflow step ${name} was not found.`);
  }
  const next = migrationWorkflow.indexOf("\n      - name: ", start + marker.length);
  return migrationWorkflow.slice(start, next === -1 ? undefined : next);
}

function migrationRunScript(name: string): string {
  const step = migrationStep(name);
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  if (start === -1) {
    throw new Error(`Migration workflow step ${name} does not contain a literal run script.`);
  }
  return step
    .slice(start + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
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
      "steps.capture_core_versions.outputs.github_sync_state == 'present'"
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
      migrationStep("Require quiescent GitHub sync before migration"),
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
      migrationStep("Require quiescent GitHub sync before migration"),
      workflowStep("Deploy GitHub sync"),
      workflowStep("Rollback failed Worker deployment")
    ]) {
      expect(lifecycle).toContain("workflowInventoryNames");
      expect(lifecycle).toContain("total_pages");
    }
  });

  it.each([
    ["legacy present with zero Workflows", "legacy-or-exact", 0, 0],
    ["Workflow-capable present with exact three", "legacy-or-exact", 3, 0],
    ["legacy present with a partial inventory", "legacy-or-exact", 1, 1],
    ["legacy present with a fourth inventory entry", "legacy-or-exact", 4, 1],
    ["absent Worker with zero Workflows", "absent", 0, 0],
    ["absent Worker with orphan Workflows", "absent", 3, 1]
  ])("classifies migration inventory for %s", (_label, inventoryState, size, expectedStatus) => {
    const lifecycleClient = nodeHeredocContaining(
      migrationRunScript("Require quiescent GitHub sync before migration"),
      "const workflowContracts ="
    );
    const entries = [
      ["dispatch", "edgemneme-github-dispatch-workflow", "GitHubDispatchWorkflow"],
      ["ref", "edgemneme-github-ref-sync-workflow", "GitHubRefSyncWorkflow"],
      ["retention", "edgemneme-github-retention-workflow", "GitHubRetentionWorkflow"],
      ["legacy", "edgemneme-github-legacy-workflow", "LegacyGitHubWorkflow"]
    ].slice(0, size);
    const script = `
const inventory = ${JSON.stringify(entries)}.map(([id, name, class_name]) => ({
  id, name, class_name, script_name: "edgemneme-github-sync", schedules: []
}));
const definitions = Object.fromEntries(inventory.map((item) => [item.name, item.class_name]));
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/workflows")) {
    return Response.json({
      success: true,
      result: inventory,
      result_info: {
        count: inventory.length,
        page: 1,
        per_page: 100,
        total_count: inventory.length,
        total_pages: inventory.length === 0 ? 0 : 1
      }
    });
  }
  if (!url.pathname.endsWith("/instances")) {
    const name = decodeURIComponent(url.pathname.split("/").at(-1));
    return Response.json({
      success: true,
      result: { name, class_name: definitions[name], script_name: "edgemneme-github-sync" }
    });
  }
  return Response.json({ success: true, result: [], result_info: { cursor: null } });
};
${lifecycleClient}
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
        CLOUDFLARE_API_TOKEN: "synthetic-token",
        ALLOW_MISSING_WORKFLOWS: "true",
        EXPECTED_WORKFLOW_INVENTORY: inventoryState
      },
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(expectedStatus);
    if (expectedStatus === 0) expect(result.stdout).toBe("clear");
  });

  it("gates migrations on a disabled runtime and two exhaustive zero observations", () => {
    const gate = migrationStep("Require quiescent GitHub sync before migration");
    const backupStart = migrationWorkflow.indexOf(
      "      - name: Capture and verify private pre-migration backups\n"
    );

    expect(migrationWorkflow).toContain("ENABLE_GITHUB_SYNC: ${{ vars.ENABLE_GITHUB_SYNC }}");
    expect(gate).toContain('ENABLE_GITHUB_SYNC:-');
    expect(gate).toContain('!= "false"');
    expect(gate).toContain("/workers/scripts/edgemneme-github-sync/settings");
    expect(gate).toContain("GITHUB_SYNC_ENABLED");
    expect(gate).toContain("/workers/scripts/edgemneme-github-sync/schedules");
    expect(gate).toContain("const workflowContracts =");
    expect(gate).toContain('ALLOW_MISSING_WORKFLOWS="true"');
    expect(gate).toContain("cursor");
    expect(gate).toContain("sqlite_master");
    expect(gate).toContain("zero_observations");
    expect(gate).toContain("zero_observations=0");
    expect(gate).toContain("sleep 60");
    expect(gate).toContain("status IN ('materialized', 'dispatching')");
    expect(gate).toContain("holder_id IS NOT NULL");
    expect(migrationWorkflow.indexOf("      - name: Require quiescent GitHub sync before migration\n"))
      .toBeLessThan(backupStart);
  });

  it("rechecks the same disabled Worker version around every migration zero observation", () => {
    const gate = migrationStep("Require quiescent GitHub sync before migration");
    const loopStart = gate.indexOf("for ((attempt = 1; attempt <= 5; attempt++)); do");
    const increment = gate.indexOf(
      "zero_observations=$((zero_observations + 1))",
      loopStart
    );
    const loop = gate.slice(loopStart, increment);

    expect(gate).toContain('captured_runtime_version="$(github_sync_runtime_state)"');
    expect(gate).toContain("latest.versions.length !== 1");
    expect(gate).toContain("latest.versions[0]?.percentage !== 100");
    expect(gate).toContain("latest.versions[0].version_id");
    expect(loop.match(/github_sync_runtime_state/g)).toHaveLength(2);
    expect(loop.match(/github_sync_schedule_state/g)).toHaveLength(2);
    expect(loop).toContain(
      '[[ "$observed_runtime_version" != "$captured_runtime_version" ]]'
    );
    expect(loop).toContain(
      '[[ "$verified_runtime_version" != "$captured_runtime_version" ]]'
    );
    expect(loop.indexOf("github_sync_runtime_state")).toBeLessThan(
      loop.indexOf("cloudflare_github_workflow_state")
    );
    expect(loop.lastIndexOf("github_sync_runtime_state")).toBeLessThan(
      loop.indexOf("github_sync_d1_state")
    );
    const reconciliation = loop.indexOf(
      "node scripts/github-sync-quiescence.mjs reconcile"
    );
    expect(loop.lastIndexOf("github_sync_schedule_state", reconciliation))
      .toBeGreaterThan(loop.indexOf("cloudflare_github_workflow_state"));
    expect(loop.indexOf("github_sync_schedule_state", reconciliation))
      .toBeLessThan(loop.indexOf("github_sync_runtime_state", reconciliation));
  });

  it("reconciles disabled orphan state only inside the three pre-D1 drain fences", () => {
    const invocation = "node scripts/github-sync-quiescence.mjs reconcile";
    const disabledObservation = shellFunctionBetween(
      "Reconcile disabled GitHub sync",
      "github_sync_zero_observation",
      "wait_for_github_sync_drain"
    );
    const rollbackDrain = shellFunctionBetween(
      "Rollback failed Worker deployment",
      "wait_for_github_sync_drain",
      "github_sync_secret_state"
    );
    const migrationGate = migrationStep("Require quiescent GitHub sync before migration");
    const migrationLoop = migrationGate.slice(
      migrationGate.indexOf("for ((attempt = 1; attempt <= 5; attempt++)); do"),
      migrationGate.indexOf("zero_observations=$((zero_observations + 1))")
    );
    const finalMigrationGate = migrationStep(
      "Revalidate quiescent GitHub sync before migration apply"
    );
    const exactCalls = [
      ...`${workflow}\n${migrationWorkflow}`.matchAll(
        /reconciliation_state="\$\(\n\s+node scripts\/github-sync-quiescence\.mjs reconcile \\\n\s+--config "\$config" \\\n\s+--disabled-version "\$(quiesced_version|expected_version|captured_runtime_version)" \\\n\s+--schedule-state clear \\\n\s+--workflow-state clear\n\s+\)" \|\| (?:return|exit) 1/g
      )
    ];

    expect(workflow.split(invocation)).toHaveLength(3);
    expect(migrationWorkflow.split(invocation)).toHaveLength(2);
    expect(exactCalls.map((match) => match[1]).sort()).toEqual([
      "captured_runtime_version",
      "expected_version",
      "quiesced_version"
    ]);
    expect(finalMigrationGate).not.toContain("scripts/github-sync-quiescence.mjs");

    const disabledCall = disabledObservation.indexOf(invocation);
    const disabledD1 = disabledObservation.indexOf(
      'd1_state="$(github_sync_d1_state)"',
      disabledCall
    );
    const disabledPending = disabledObservation.indexOf(
      'if [[ "$reconciliation_state" == "pending" ]]',
      disabledCall
    );
    expect(disabledCall).toBeGreaterThan(
      disabledObservation.indexOf(
        'if [[ "$schedule_state" != "clear" || "$workflow_state" != "clear" ]]'
      )
    );
    expect(disabledCall).toBeLessThan(disabledD1);
    expect(disabledObservation.slice(disabledCall, disabledD1)).toContain(
      'verified_schedule_state="$(github_sync_schedule_state)"'
    );
    expect(disabledObservation.slice(disabledCall, disabledD1)).toContain(
      'verified_workflow_state="$(cloudflare_github_workflow_state)"'
    );
    expect(disabledObservation.slice(disabledCall, disabledD1)).toContain(
      'assert_disabled_version \\\n    "$quiesced_version" "$quiesce_tag" "$initial_secret_state"'
    );
    expect(disabledObservation.indexOf(
      'verified_schedule_state="$(github_sync_schedule_state)"',
      disabledCall
    )).toBeLessThan(disabledPending);
    expect(disabledObservation.indexOf(
      'verified_workflow_state="$(cloudflare_github_workflow_state)"',
      disabledCall
    )).toBeLessThan(disabledPending);
    expect(disabledObservation.indexOf("assert_disabled_version", disabledCall))
      .toBeLessThan(disabledPending);
    expect(disabledPending).toBeLessThan(disabledD1);
    expect(disabledObservation.slice(disabledCall)).toContain(
      '"$reconciliation_state" == "clear"'
    );
    expect(disabledObservation.slice(disabledCall, disabledD1)).toContain(
      '--disabled-version "$quiesced_version"'
    );

    const rollbackCall = rollbackDrain.indexOf(invocation);
    const rollbackD1 = rollbackDrain.indexOf(
      'd1_state="$(github_sync_d1_state "$config")"',
      rollbackCall
    );
    const rollbackPending = rollbackDrain.indexOf(
      'if [[ "$reconciliation_state" == "pending" ]]',
      rollbackCall
    );
    expect(rollbackCall).toBeGreaterThan(
      rollbackDrain.indexOf(
        'if [[ "$schedule_state" != "clear" || "$workflow_state" != "clear" ]]'
      )
    );
    expect(rollbackCall).toBeLessThan(rollbackD1);
    expect(rollbackDrain.slice(rollbackCall, rollbackD1)).toContain(
      'verified_schedule_state="$(github_sync_schedule_state)"'
    );
    expect(rollbackDrain.slice(rollbackCall, rollbackD1)).toContain(
      'verified_workflow_state="$(cloudflare_github_workflow_state)"'
    );
    expect(rollbackDrain.slice(rollbackCall, rollbackD1)).toContain(
      'assert_exact_disabled_github_version \\\n      "$config" "$expected_version" "$expected_tag" "present"'
    );
    expect(rollbackDrain.indexOf(
      'verified_schedule_state="$(github_sync_schedule_state)"',
      rollbackCall
    )).toBeLessThan(rollbackPending);
    expect(rollbackDrain.indexOf(
      'verified_workflow_state="$(cloudflare_github_workflow_state)"',
      rollbackCall
    )).toBeLessThan(rollbackPending);
    expect(rollbackDrain.indexOf(
      "assert_exact_disabled_github_version",
      rollbackCall
    )).toBeLessThan(rollbackPending);
    expect(rollbackPending).toBeLessThan(rollbackD1);
    expect(rollbackDrain.slice(rollbackCall)).toContain(
      '"$reconciliation_state" == "clear"'
    );
    expect(rollbackDrain.slice(rollbackCall, rollbackD1)).toContain(
      '--disabled-version "$expected_version"'
    );

    const migrationCall = migrationLoop.indexOf(invocation);
    const migrationD1 = migrationLoop.indexOf(
      'd1_state="$(github_sync_d1_state)"',
      migrationCall
    );
    const migrationPending = migrationLoop.indexOf(
      'if [[ "$reconciliation_state" == "pending" ]]',
      migrationCall
    );
    expect(migrationCall).toBeGreaterThan(
      migrationLoop.indexOf(
        'if [[ "$schedule_state" != "clear" || "$workflow_state" != "clear" ]]'
      )
    );
    expect(migrationCall).toBeLessThan(migrationD1);
    expect(migrationLoop.slice(migrationCall, migrationD1)).toContain(
      'verified_runtime_version="$(github_sync_runtime_state)"'
    );
    expect(migrationLoop.slice(migrationCall, migrationD1)).toContain(
      '[[ "$verified_runtime_version" != "$captured_runtime_version" ]]'
    );
    expect(migrationLoop.slice(migrationCall, migrationD1)).toContain(
      'verified_workflow_state="$(cloudflare_github_workflow_state)"'
    );
    expect(migrationLoop.indexOf(
      'verified_schedule_state="$(',
      migrationCall
    )).toBeLessThan(migrationPending);
    expect(migrationLoop.indexOf(
      'verified_runtime_version="$(github_sync_runtime_state)"',
      migrationCall
    )).toBeLessThan(migrationPending);
    expect(migrationLoop.indexOf(
      'verified_workflow_state="$(cloudflare_github_workflow_state)"',
      migrationCall
    )).toBeLessThan(migrationPending);
    expect(migrationPending).toBeLessThan(migrationD1);
    expect(migrationLoop.slice(migrationCall)).toContain(
      '"$reconciliation_state" == "clear"'
    );
    expect(migrationLoop.slice(migrationCall, migrationD1)).toContain(
      '--disabled-version "$captured_runtime_version"'
    );
  });

  it("paces every high-cost drain below the Cloudflare global API budget", () => {
    const disabled = workflowStep("Reconcile disabled GitHub sync");
    const rollback = shellFunctionBetween(
      "Rollback failed Worker deployment",
      "wait_for_github_sync_drain",
      "github_sync_secret_state"
    );
    const initialMigration = migrationStep(
      "Require quiescent GitHub sync before migration"
    );
    const finalMigration = migrationStep(
      "Revalidate quiescent GitHub sync before migration apply"
    );

    expect(disabled).toContain("for ((attempt = 1; attempt <= 30; attempt++)); do");
    expect(disabled).toContain("if (( attempt < 30 )); then");
    expect(rollback).toContain("for ((attempt = 1; attempt <= 25; attempt++)); do");
    expect(rollback).toContain("if (( attempt < 25 )); then");
    for (const migration of [initialMigration, finalMigration]) {
      expect(migration).toContain("for ((attempt = 1; attempt <= 5; attempt++)); do");
      expect(migration).toContain("if (( attempt < 5 )); then");
    }
    for (const drain of [disabled, rollback, initialMigration, finalMigration]) {
      expect(drain).toContain("sleep 60");
      expect(drain).not.toContain("sleep 5");
    }

    const conservativeCallsPerPoll = 119;
    const pollsPerFiveMinutes = 300 / 60;
    expect(conservativeCallsPerPoll * pollsPerFiveMinutes).toBeLessThan(1_200);
  });

  it("blocks migration reconciliation when Cron appears after runtime preflight", () => {
    const script = migrationRunScript("Require quiescent GitHub sync before migration");
    const start = script.indexOf("zero_observations=0");
    const terminal =
      'echo "GitHub sync is not quiescent; migration is blocked." >&2\nexit 1';
    const end = script.indexOf(terminal, start);
    const drain = script.slice(start, end + terminal.length);
    const harness = [
      "set -euo pipefail",
      'captured_runtime_version="123e4567-e89b-42d3-a456-426614174000"',
      'config="synthetic.jsonc"',
      'github_sync_runtime_state() { printf "%s" "$captured_runtime_version"; }',
      'cloudflare_github_workflow_state() { printf "%s" "clear"; }',
      'github_sync_schedule_state() { printf "%s" "pending"; }',
      'github_sync_d1_state() { echo "unexpected D1 read" >&2; return 91; }',
      'node() { echo "unexpected reconciliation" >&2; return 92; }',
      "sleep() { :; }",
      drain
    ].join("\n");
    const result = spawnSync("bash", ["-c", harness], {
      env: process.env,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("migration is blocked");
    expect(result.stderr).not.toContain("unexpected reconciliation");
    expect(result.stderr).not.toContain("unexpected D1 read");
  });

  it.each([
    ["no Queue association", false, "none", false, 0],
    ["a Queue binding", true, "none", false, 1],
    ["a Queue consumer", false, "target", false, 1],
    ["a malformed worker consumer", false, "malformed", false, 1],
    ["a Queue producer", false, "none", true, 1]
  ])(
    "rejects migration quiescence with %s",
    (
      _label,
      includeQueueBinding,
      queueConsumerState,
      includeQueueProducer,
      expectedStatus
    ) => {
      const runtimeClient = nodeHeredocContaining(
        migrationRunScript("Require quiescent GitHub sync before migration"),
        "Cloudflare GitHub sync lifecycle inputs are incomplete."
      );
      const versionId = "123e4567-e89b-42d3-a456-426614174000";
      const script = `
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/deployments")) {
    return Response.json({
      success: true,
      result: {
        deployments: [{
          created_on: "2026-08-01T00:00:00.000Z",
          versions: [{ version_id: ${JSON.stringify(versionId)}, percentage: 100 }]
        }]
      }
    });
  }
  if (url.pathname.endsWith("/settings")) {
    return Response.json({
      success: true,
      result: {
        bindings: [
          { name: "GITHUB_SYNC_ENABLED", type: "plain_text", text: "false" },
          ...(${JSON.stringify(includeQueueBinding)}
            ? [{ name: "LEGACY_QUEUE", type: "queue", queue_name: "legacy" }]
            : [])
        ]
      }
    });
  }
  if (url.pathname.endsWith("/schedules")) {
    return Response.json({ success: true, result: { schedules: [] } });
  }
  if (url.pathname.endsWith("/queues")) {
    const queueConsumerState = ${JSON.stringify(queueConsumerState)};
    const consumers = queueConsumerState === "none"
      ? []
      : [{
          consumer_id: "consumer-1",
          type: "worker",
          ...(queueConsumerState === "target"
            ? { script_name: "edgemneme-github-sync" }
            : {}),
          queue_name: "legacy"
        }];
    const producers = ${JSON.stringify(includeQueueProducer)}
      ? [{ type: "worker", script: "edgemneme-github-sync" }]
      : [];
    return Response.json({
      success: true,
      result: [{
        queue_id: "queue-1",
        queue_name: "legacy",
        consumers,
        consumers_total_count: consumers.length,
        producers,
        producers_total_count: producers.length
      }],
      result_info: { count: 1, page: 1, per_page: 100, total_count: 1, total_pages: 1 }
    });
  }
  throw new Error("Unexpected request: " + url);
};
${runtimeClient}
`;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: "synthetic-account",
          CLOUDFLARE_API_TOKEN: "synthetic-token"
        },
        encoding: "utf8"
      });

      expect(result.status, result.stderr).toBe(expectedStatus);
      if (expectedStatus === 0) expect(result.stdout).toBe(versionId);
    }
  );

  it("revalidates the captured quiescent state after backup immediately before D1 apply", () => {
    const finalGate = migrationStep(
      "Revalidate quiescent GitHub sync before migration apply"
    );
    const backup = migrationWorkflow.indexOf(
      "      - name: Capture and verify private pre-migration backups\n"
    );
    const gate = migrationWorkflow.indexOf(
      "      - name: Revalidate quiescent GitHub sync before migration apply\n"
    );
    const apply = migrationWorkflow.indexOf(
      "      - name: Apply memory database migrations\n"
    );

    expect(backup).toBeLessThan(gate);
    expect(gate).toBeLessThan(apply);
    expect(finalGate).toContain("EDGEMNEME_MIGRATION_GITHUB_SYNC_VERSION");
    expect(finalGate).toContain("latest.versions[0]?.percentage !== 100");
    expect(finalGate).toContain("GITHUB_SYNC_ENABLED");
    expect(finalGate).toContain("workflowInventoryNames");
    expect(finalGate).toContain("nonterminalStatuses");
    expect(finalGate).toContain("github_sync_d1_state");
    expect(finalGate).toContain("zero_observations");
    expect(finalGate).toContain("zero_observations=0");
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
      migrationStep("Require quiescent GitHub sync before migration"),
      migrationStep("Revalidate quiescent GitHub sync before migration apply")
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
      migrationStep("Require quiescent GitHub sync before migration"),
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
      rollback.indexOf('wrangler delete --config "$config" --force')
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
    const deletion = absentBranch.indexOf('wrangler delete --config "$config" --force');

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
      migrationStep("Require quiescent GitHub sync before migration"),
      migrationStep("Revalidate quiescent GitHub sync before migration apply")
    ]) {
      expect(lifecycle).toContain("/queues");
      expect(lifecycle).toContain("consumers_total_count");
      expect(lifecycle).toContain('consumer?.script_name === "edgemneme-github-sync"');
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
      'wrangler delete --config "$config" --force',
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
