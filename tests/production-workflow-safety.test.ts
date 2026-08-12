import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function workflowSource(name: string): string {
  return readFileSync(join(process.cwd(), ".github", "workflows", name), "utf8");
}

function workflowJob(source: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow job ${name} was not found.`);
  }
  const remainder = source.slice(start + marker.length);
  const next = /^  [a-zA-Z0-9_]+:\n/mu.exec(remainder);
  return source.slice(start, next === null ? undefined : start + marker.length + next.index);
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

function timeoutMinutes(source: string): number {
  const match = /^\s+timeout-minutes: (\d+)$/mu.exec(source);
  if (match?.[1] === undefined) {
    throw new Error("Workflow timeout was not found.");
  }
  return Number(match[1]);
}

function timedSteps(source: string): Array<[string, number]> {
  return [...source.matchAll(/^      - name: (.+)$/gmu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
    .map((name) => [name, workflowStep(source, name)] as const)
    .filter(([, step]) => /^\s+timeout-minutes: \d+$/mu.test(step))
    .map(([name, step]) => [name, timeoutMinutes(step)]);
}

describe("production workflow safety", () => {
  const deploy = workflowSource("deploy.yml");
  const migrate = workflowSource("migrate-d1.yml");

  it("keeps rollback inputs outside the cancellable deployment job", () => {
    const rollbackChannelJob = workflowJob(deploy, "validate_rollback_channel");
    const captureJob = workflowJob(deploy, "capture_production_state");
    const deployJob = workflowJob(deploy, "deploy");
    const rollbackJob = workflowJob(deploy, "rollback_workers");
    const durableCapture = workflowStep(captureJob, "Capture production Worker state");
    const driftGate = workflowStep(deploy, "Reject deployment state drift");
    const preMutationDriftGate = workflowStep(
      deploy,
      "Reject pre-mutation deployment state drift"
    );

    expect(rollbackChannelJob).toContain("    environment: production-rollback\n");
    expect(rollbackChannelJob).toContain("    needs: capture_production_state\n");
    expect(rollbackChannelJob).toContain("UNATTENDED_ROLLBACK_ENABLED");
    expect(rollbackChannelJob).toContain("secrets.CLOUDFLARE_ROLLBACK_API_TOKEN");
    expect(rollbackChannelJob).toContain("vars.CF_ROLLBACK_ACCOUNT_ID");
    expect(rollbackChannelJob).toContain(
      "node scripts/capture-deployment-state.mjs verify-configuration"
    );
    expect(rollbackChannelJob).toContain(
      'if [[ "$UNATTENDED_ROLLBACK_ENABLED" != "true" ]]'
    );
    expect(captureJob).not.toContain("    needs:");
    expect(captureJob).toContain("    timeout-minutes: 20\n");
    expect(captureJob).toContain("    environment: production\n");
    expect(captureJob).toContain("gateway_previous_trigger_state");
    expect(captureJob).toContain("gateway_previous_trigger_fingerprint");
    expect(durableCapture).toContain("node scripts/capture-deployment-state.mjs");
    expect(deployJob).toContain(
      "    needs: [capture_production_state, validate_rollback_channel]\n"
    );
    expect(deployJob).not.toContain("    outputs:\n");
    expect(driftGate).toContain("CAPTURED_ORCHESTRATOR_VERSION");
    expect(driftGate).toContain("OBSERVED_ORCHESTRATOR_VERSION");
    expect(driftGate).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(driftGate).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
    expect(driftGate).toContain("EXPECTED_GATEWAY_TRIGGER_STATE");
    expect(driftGate).toContain("EXPECTED_GATEWAY_TRIGGER_FINGERPRINT");
    expect(driftGate).toContain("gateway_trigger_state");
    expect(driftGate).toContain("gateway_trigger_fingerprint");
    expect(driftGate).toContain("node scripts/capture-deployment-state.mjs verify");
    expect(driftGate).toContain("state changed after the rollback snapshot");
    expect(preMutationDriftGate).toContain(
      "node scripts/capture-deployment-state.mjs verify-configuration"
    );
    expect(preMutationDriftGate).toContain("gateway_trigger_state");
    expect(preMutationDriftGate).toContain("gateway_trigger_fingerprint");
    expect(preMutationDriftGate).toContain("gateway-deployment-target.mjs verify-predeploy");
    expect(rollbackJob).toContain("    needs: [capture_production_state, deploy]\n");
    expect(rollbackJob).toContain("needs.deploy.result == 'failure'");
    expect(rollbackJob).toContain("needs.deploy.result == 'cancelled'");
    expect(rollbackJob).toContain("needs.capture_production_state.outputs.bootstrap_mode");
    expect(rollbackJob).toContain("    environment: production-rollback\n");
    expect(rollbackJob).toContain(
      "EXPECTED_CONFIGURATION_FINGERPRINT: ${{ needs.capture_production_state.outputs.configuration_fingerprint }}"
    );
    expect(rollbackJob).toContain("secrets.CLOUDFLARE_ROLLBACK_API_TOKEN");
    expect(rollbackJob).toContain("EXPECTED_GATEWAY_TRIGGER_STATE");
    expect(rollbackJob).toContain("EXPECTED_GATEWAY_CURRENT_TRIGGER_STATE");
    expect(rollbackJob).toContain("EXPECTED_GATEWAY_CURRENT_TRIGGER_FINGERPRINT");
    expect(rollbackJob).toContain("EDGEMNEME_GATEWAY_ADVANCED_BY_RUN");
    expect(rollbackJob).toContain("gateway_advanced_by_run=false");
    expect(rollbackJob).toContain("gateway_advanced_by_run=true");
    expect(rollbackJob).toContain("did not reach its captured version after rollback");
    expect(rollbackJob).toContain("capture-rollback-current");
    expect(rollbackJob).toContain("EDGEMNEME_GATEWAY_ALLOW_DETACHED_ABSENT=true");
    expect(rollbackJob).toContain("capture belongs to a different tagged version");
    expect(rollbackJob).toContain("verify-active-tag");
    expect(rollbackJob.indexOf("capture-rollback-current")).toBeLessThan(
      rollbackJob.indexOf("node scripts/delete-worker-script.mjs")
    );
    const bootstrapDetach = rollbackJob.indexOf(
      "EDGEMNEME_GATEWAY_ALLOW_DETACHED_ABSENT=true"
    );
    const bootstrapTagRecheck = rollbackJob.indexOf("verify-active-tag");
    const bootstrapDelete = rollbackJob.indexOf("node scripts/delete-worker-script.mjs");
    expect(bootstrapTagRecheck).toBeGreaterThan(bootstrapDetach);
    expect(bootstrapDelete).toBeGreaterThan(bootstrapTagRecheck);
    expect(rollbackJob).toContain("gateway-deployment-target.mjs restore");
    expect(rollbackJob).toContain("gateway_trigger_fingerprint");
    expect(rollbackJob).not.toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(rollbackJob).not.toContain("needs.deploy.outputs");
  });

  it("revalidates current main and captured state immediately before mutations", () => {
    const captureJob = workflowJob(deploy, "capture_production_state");
    const deployJob = workflowJob(deploy, "deploy");
    const migrateJob = workflowJob(migrate, "migrate");
    expect(workflowStep(captureJob, "Verify current main state capture head")).toContain(
      "node scripts/verify-github-main-head.mjs"
    );
    expect(workflowStep(deployJob, "Verify current main deployment head")).toContain(
      "node scripts/verify-github-main-head.mjs"
    );
    const configurationGate = workflowStep(
      deployJob,
      "Verify captured production configuration"
    );
    expect(configurationGate).toContain(
      "EXPECTED_CONFIGURATION_FINGERPRINT: ${{ needs.capture_production_state.outputs.configuration_fingerprint }}"
    );
    expect(configurationGate).toContain(
      "node scripts/capture-deployment-state.mjs verify-configuration"
    );
    const configurationGateStart = deployJob.indexOf(
      "      - name: Verify captured production configuration\n"
    );
    const renderStart = deployJob.indexOf("      - name: Render private deployment configs\n");
    expect(configurationGateStart).toBeGreaterThanOrEqual(0);
    expect(renderStart).toBeGreaterThan(configurationGateStart);
    expect(deployJob.slice(configurationGateStart, renderStart)).not.toMatch(
      /\n      - name: /u
    );
    expect(workflowStep(migrateJob, "Verify current main migration head")).toContain(
      "node scripts/verify-github-main-head.mjs"
    );

    const vectorAdmissionStart = deployJob.indexOf(
      "      - name: Revalidate Vectorize metadata admission\n"
    );
    const preMutationDriftGateStart = deployJob.indexOf(
      "      - name: Reject pre-mutation deployment state drift\n"
    );
    const vectorMutationStart = deployJob.indexOf(
      "      - name: Ensure semantic Vectorize metadata indexes\n"
    );
    expect(vectorAdmissionStart).toBeGreaterThanOrEqual(0);
    expect(preMutationDriftGateStart).toBeGreaterThan(vectorAdmissionStart);
    expect(vectorMutationStart).toBeGreaterThan(preMutationDriftGateStart);
    expect(deployJob.slice(vectorAdmissionStart, preMutationDriftGateStart)).not.toMatch(
      /\n      - name: /u
    );
    expect(deployJob.slice(preMutationDriftGateStart, vectorMutationStart)).not.toMatch(
      /\n      - name: /u
    );

    const lifecycleAdmissions = [
      [
        "Revalidate disabled GitHub sync reconciliation main",
        "Revalidate disabled GitHub sync reconciliation state",
        "Reconcile disabled GitHub sync"
      ],
      [
        "Revalidate orchestrator deployment main",
        "Revalidate orchestrator deployment state",
        "Deploy memory orchestrator"
      ],
      [
        "Revalidate gateway deployment main",
        "Revalidate gateway deployment state",
        "Deploy memory gateway"
      ],
      [
        "Revalidate GitHub sync deployment main",
        "Revalidate GitHub sync deployment state",
        "Deploy GitHub sync"
      ]
    ] as const;
    for (const [mainAdmission, stateAdmission, mutation] of lifecycleAdmissions) {
      const mainStart = deployJob.indexOf(`      - name: ${mainAdmission}\n`);
      const stateStart = deployJob.indexOf(`      - name: ${stateAdmission}\n`);
      const mutationStart = deployJob.indexOf(`      - name: ${mutation}\n`);
      expect(mainStart).toBeGreaterThanOrEqual(0);
      expect(stateStart).toBeGreaterThan(mainStart);
      expect(mutationStart).toBeGreaterThan(stateStart);
      expect(deployJob.slice(mainStart, stateStart)).not.toMatch(/\n      - name: /u);
      expect(deployJob.slice(stateStart, mutationStart)).not.toMatch(
        /\n      - name: /u
      );
      expect(workflowStep(deployJob, mainAdmission)).toContain(
        "node scripts/verify-github-main-head.mjs"
      );
      expect(workflowStep(deployJob, stateAdmission)).toContain(
        "node scripts/capture-deployment-state.mjs verify"
      );
    }
    expect(workflowStep(deployJob, "Revalidate Vectorize metadata admission")).toContain(
      "node scripts/verify-github-main-head.mjs"
    );

    const firstRemoteMutation = deployJob.indexOf("vectorize create-metadata-index");
    expect(preMutationDriftGateStart).toBeGreaterThanOrEqual(0);
    expect(firstRemoteMutation).toBeGreaterThan(preMutationDriftGateStart);

    const driftGateStart = deployJob.indexOf(
      "      - name: Reject deployment state drift\n"
    );
    const firstWorkerLifecycleMutation = deployJob.indexOf(
      "      - name: Reconcile disabled GitHub sync\n"
    );
    expect(driftGateStart).toBeGreaterThanOrEqual(0);
    expect(firstWorkerLifecycleMutation).toBeGreaterThan(driftGateStart);

    const migrationAdmission = migrateJob.indexOf(
      "      - name: Revalidate current main migration admission\n"
    );
    const searchAdmission = migrateJob.indexOf(
      "      - name: Revalidate greenfield maintenance immediately before search apply\n"
    );
    const searchMigration = migrateJob.indexOf(
      "      - name: Apply search database migrations\n"
    );
    const searchValidation = migrateJob.indexOf(
      "      - name: Validate search database before memory migration\n"
    );
    const memoryAdmission = migrateJob.indexOf(
      "      - name: Revalidate greenfield maintenance immediately before memory apply\n"
    );
    const memoryMigration = migrateJob.indexOf(
      "      - name: Apply memory database migrations\n"
    );
    expect(migrationAdmission).toBeGreaterThanOrEqual(0);
    expect(searchAdmission).toBeGreaterThan(migrationAdmission);
    expect(searchMigration).toBeGreaterThan(searchAdmission);
    expect(migrateJob.slice(searchAdmission, searchMigration)).not.toMatch(
      /\n      - name: /u
    );
    expect(searchValidation).toBeGreaterThan(searchMigration);
    expect(memoryAdmission).toBeGreaterThan(searchValidation);
    expect(memoryMigration).toBeGreaterThan(memoryAdmission);
    expect(migrateJob.slice(memoryAdmission, memoryMigration)).not.toMatch(
      /\n      - name: /u
    );
  });

  it("budgets deployment timeouts and queues every production mutation run", () => {
    const expectedConcurrency = [
      "concurrency:",
      "  group: production-cloudflare",
      "  queue: max",
      "  cancel-in-progress: false"
    ].join("\n");
    for (const workflow of [deploy, migrate]) {
      expect(workflow).toContain(`${expectedConcurrency}\n`);
      expect(workflow.match(/^  queue: max$/gmu)).toHaveLength(1);
      expect(workflow).not.toContain("cancel-in-progress: true");
    }

    expect(timedSteps(workflowJob(deploy, "deploy"))).toEqual([
      ["Verify current main deployment head", 2],
      ["Verify captured production configuration", 2],
      ["Revalidate Vectorize metadata admission", 2],
      ["Reject pre-mutation deployment state drift", 2],
      ["Ensure semantic Vectorize metadata indexes", 5],
      ["Check projection rebuild deployment budget", 5],
      ["Reject deployment state drift", 2],
      ["Revalidate disabled GitHub sync reconciliation main", 2],
      ["Revalidate disabled GitHub sync reconciliation state", 2],
      ["Reconcile disabled GitHub sync", 35],
      ["Revalidate orchestrator deployment main", 2],
      ["Revalidate orchestrator deployment state", 2],
      ["Rebuild and verify projections", 65],
      ["Revalidate gateway deployment main", 2],
      ["Revalidate gateway deployment state", 2],
      ["Capture deployed gateway canary target", 2],
      ["Run isolated production canary", 20],
      ["Recover isolated production canary", 12],
      ["Reverify deployed gateway canary target", 2],
      ["Revalidate GitHub sync deployment main", 2],
      ["Revalidate GitHub sync deployment state", 2],
      ["Deploy GitHub sync", 35]
    ]);
    expect(timedSteps(workflowJob(migrate, "migrate"))).toEqual([
      ["Verify current main migration head", 2],
      ["Capture greenfield maintenance admission before backups", 10],
      ["Capture and verify private pre-migration backups", 25],
      ["Revalidate current main migration admission", 2],
      ["Revalidate greenfield maintenance immediately before search apply", 10],
      ["Validate search database before memory migration", 5],
      ["Revalidate greenfield maintenance immediately before memory apply", 10]
    ]);

    const boundedFailurePath = [
      "Verify current main deployment head",
      "Verify captured production configuration",
      "Revalidate Vectorize metadata admission",
      "Reject pre-mutation deployment state drift",
      "Ensure semantic Vectorize metadata indexes",
      "Check projection rebuild deployment budget",
      "Reject deployment state drift",
      "Revalidate disabled GitHub sync reconciliation main",
      "Revalidate disabled GitHub sync reconciliation state",
      "Reconcile disabled GitHub sync",
      "Revalidate orchestrator deployment main",
      "Revalidate orchestrator deployment state",
      "Rebuild and verify projections",
      "Revalidate gateway deployment main",
      "Revalidate gateway deployment state",
      "Capture deployed gateway canary target",
      "Run isolated production canary",
      "Recover isolated production canary",
      "Reverify deployed gateway canary target"
    ].reduce((total, name) => total + timeoutMinutes(workflowStep(deploy, name)), 0);
    expect(boundedFailurePath).toBe(168);
    expect(timeoutMinutes(workflowJob(deploy, "deploy")))
      .toBeGreaterThanOrEqual(boundedFailurePath + 30);
    const boundedMigrationPath = timedSteps(workflowJob(migrate, "migrate")).reduce(
      (total, [, timeout]) => total + timeout,
      0
    );
    expect(boundedMigrationPath).toBe(64);
    expect(timeoutMinutes(workflowJob(migrate, "migrate")))
      .toBeGreaterThanOrEqual(boundedMigrationPath + 10);
  });

  it("keeps migration maintenance read-only and applies SEARCH_DB before MEMORY_DB", () => {
    const migrateJob = workflowJob(migrate, "migrate");
    const initial = workflowStep(
      migrateJob,
      "Capture greenfield maintenance admission before backups"
    );
    const finalSearch = workflowStep(
      migrateJob,
      "Revalidate greenfield maintenance immediately before search apply"
    );
    const finalMemory = workflowStep(
      migrateJob,
      "Revalidate greenfield maintenance immediately before memory apply"
    );
    for (const gate of [initial, finalSearch, finalMemory]) {
      expect(gate).toContain("node scripts/d1-maintenance-admission.mjs");
      expect(gate).toContain(
        "D1_MIGRATION_BACKUP_R2_BUCKET: ${{ vars.D1_MIGRATION_BACKUP_R2_BUCKET }}"
      );
      expect(gate).not.toMatch(/\b(?:reconcile|PUT|DELETE|purge|terminate|restore)\b/iu);
    }
    expect(migrateJob).not.toContain("github-sync-quiescence.mjs reconcile");
    const backup = migrateJob.indexOf(
      "      - name: Capture and verify private pre-migration backups\n"
    );
    const searchGate = migrateJob.indexOf(
      "      - name: Revalidate greenfield maintenance immediately before search apply\n"
    );
    const searchApply = migrateJob.indexOf(
      "      - name: Apply search database migrations\n"
    );
    const searchValidation = migrateJob.indexOf(
      "      - name: Validate search database before memory migration\n"
    );
    const memoryGate = migrateJob.indexOf(
      "      - name: Revalidate greenfield maintenance immediately before memory apply\n"
    );
    const memoryApply = migrateJob.indexOf(
      "      - name: Apply memory database migrations\n"
    );
    expect(initial).toContain("capture");
    expect(backup).toBeGreaterThan(migrateJob.indexOf("Capture greenfield maintenance"));
    expect(searchGate).toBeGreaterThan(backup);
    expect(searchApply).toBeGreaterThan(searchGate);
    expect(searchValidation).toBeGreaterThan(searchApply);
    expect(memoryGate).toBeGreaterThan(searchValidation);
    expect(memoryApply).toBeGreaterThan(memoryGate);
  });
});
