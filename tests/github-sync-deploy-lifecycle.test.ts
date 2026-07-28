import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github", "workflows", "deploy.yml"),
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

function workflowNodeHeredoc(name: string, index: number): string {
  const script = workflowRunScript(name);
  const heredocs = [...script.matchAll(/<<'NODE'\n([\s\S]*?)\nNODE/g)].map(
    (match) => match[1]
  );
  const heredoc = heredocs[index];
  if (heredoc === undefined) {
    throw new Error(`Node heredoc ${index} was not found in workflow step ${name}.`);
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

describe("GitHub sync deployment lifecycle", () => {
  it("keeps an absent disabled Worker absent and reconciles only a present one", () => {
    const disabled = workflowStep("Reconcile disabled GitHub sync");

    expect(disabled).toContain(
      "steps.capture_core_versions.outputs.github_sync_state == 'present'"
    );
    expect(disabled).toContain("wrangler deploy --strict");
    expect(disabled.indexOf("wrangler deploy --strict"))
      .toBeLessThan(disabled.indexOf("wrangler secret bulk"));
    expect(disabled).toContain('{"GITHUB_CLASSIC_TOKEN":null}');
    expect(disabled).toContain("wrangler secret list");
    expect(disabled).toContain("secrets.length !== 0");
    expect(disabled).toContain("schedules.length !== 0");
  });

  it.each([
    ["Reconcile disabled GitHub sync", [], [], 0],
    ["Reconcile disabled GitHub sync", [{ name: "OTHER_SECRET" }], [], 1],
    ["Deploy GitHub sync", [{ name: "GITHUB_CLASSIC_TOKEN" }], [{ cron: "0 */6 * * *" }], 0],
    [
      "Deploy GitHub sync",
      [{ name: "GITHUB_CLASSIC_TOKEN" }, { name: "OTHER_SECRET" }],
      [{ cron: "0 */6 * * *" }],
      1
    ]
  ])(
    "enforces the exact github-sync secret allowlist in %s",
    (stepName, secrets, schedules, expectedStatus) => {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", workflowNodeHeredoc(stepName, 1)],
        {
          env: {
            ...process.env,
            SECRETS_JSON: JSON.stringify(secrets),
            SCHEDULES_JSON: JSON.stringify(schedules)
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

  it("rolls an existing enabled deployment back to its exact prior version and schedule", () => {
    const rollback = workflowStep("Rollback failed Worker deployment");
    expect(rollback).toContain("body: JSON.stringify(desired)");
    expect(rollback).not.toContain("body: JSON.stringify({ schedules: desired })");

    const harness = `
set -euo pipefail
worker_presence() { printf present; }
active_version() { printf current-version; }
tagged_current_version() { printf current-version; }
restore_github_sync_schedule_state() { printf 'schedule:%s\n' "$1"; }
pnpm() { printf 'pnpm:%s\n' "$*"; }
${rollbackFunction()}
EDGEMNEME_GITHUB_SYNC_PREVIOUS_SCHEDULE_STATE=disabled \
  rollback_if_advanced github-sync package.json previous-version expected-tag worker false
`;
    const result = spawnSync("bash", ["-c", harness], {
      env: { ...process.env, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("wrangler rollback previous-version");
    expect(result.stdout).toContain("schedule:disabled");
    expect(result.stdout).not.toContain("wrangler delete");
  });

  it("restores the captured Cron state when the Worker version already matches", () => {
    const harness = `
set -euo pipefail
worker_presence() { printf present; }
active_version() { printf previous-version; }
tagged_current_version() { echo unexpected-tag-check >&2; return 9; }
restore_github_sync_schedule_state() { printf 'schedule:%s\n' "$1"; }
pnpm() { echo unexpected-wrangler-mutation >&2; return 9; }
${rollbackFunction()}
EDGEMNEME_GITHUB_SYNC_PREVIOUS_SCHEDULE_STATE=disabled \
  rollback_if_advanced github-sync package.json previous-version expected-tag worker false
`;
    const result = spawnSync("bash", ["-c", harness], {
      env: { ...process.env, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("schedule:disabled\n");
    expect(result.stderr).not.toContain("unexpected");
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
    const harness = `
set -euo pipefail
deleted=false
worker_presence() {
  if [[ "$deleted" == "true" ]]; then printf absent; else printf present; fi
}
active_version() { printf current-version; }
tagged_current_version() { printf current-version; }
restore_github_sync_schedule_state() { echo unexpected-schedule-restore >&2; return 9; }
pnpm() {
  printf 'pnpm:%s\n' "$*"
  if [[ "$*" == *"wrangler delete"* ]]; then deleted=true; fi
}
${rollbackFunction()}
rollback_if_advanced github-sync package.json "" expected-tag worker true
`;
    const result = spawnSync("bash", ["-c", harness], {
      env: { ...process.env, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
      encoding: "utf8"
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("wrangler delete --config package.json --force");
    expect(result.stdout).not.toContain("wrangler rollback");
    expect(result.stderr).not.toContain("unexpected-schedule-restore");
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
