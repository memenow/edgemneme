#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { observeCloudflareMaintenance } from "./d1-maintenance-cloudflare.mjs";
import { observeD1Maintenance } from "./d1-maintenance-d1.mjs";

const DEFAULT_CONFIG = "wrangler/.wrangler/memory-orchestrator.generated.jsonc";
const STABILITY_DELAY_MS = 60_000;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const CORE_WORKERS = new Set([
  "edgemneme-github-sync",
  "edgemneme-memory-gateway",
  "edgemneme-memory-orchestrator"
]);
const TARGET_QUEUES = new Set([
  "edgemneme-memory-events",
  "edgemneme-memory-events-dlq"
]);

export class MaintenanceAdmissionError extends Error {
  constructor(codes, message = "production maintenance admission failed") {
    const uniqueCodes = [...new Set(codes)].sort();
    super(`${message}: ${uniqueCodes.join(", ")}`);
    this.name = "MaintenanceAdmissionError";
    this.codes = Object.freeze(uniqueCodes);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function maintenanceFingerprint(observation) {
  return createHash("sha256")
    .update(stableJson({ schema: 1, observation }))
    .digest("hex");
}

function hasPublicGatewayIngress(ingress) {
  return (
    ingress?.workers_dev !== null &&
    (ingress?.workers_dev?.enabled !== false ||
      ingress?.workers_dev?.previews_enabled !== false)
  ) || ingress?.custom_domains?.length !== 0 || ingress?.routes?.length !== 0;
}

export function maintenanceViolationCodes(observation) {
  const codes = [];
  const cloudflare = observation?.cloudflare;
  const d1 = observation?.d1;
  if (cloudflare === null || typeof cloudflare !== "object" || d1 === null || typeof d1 !== "object") {
    throw new Error("Maintenance observation is incomplete.");
  }

  const deployedCoreWorkers = Object.values(cloudflare.core_versions ?? {})
    .filter((version) => version !== "absent");
  if (deployedCoreWorkers.length !== 0) {
    codes.push("CORE_WORKER_PRESENT", "MISSING_DURABLE_MAINTENANCE_FENCE");
  }
  const bindingTargets = cloudflare.binding_targets;
  const workerBindings = cloudflare.worker_bindings;
  const targetD1Ids = Object.values(bindingTargets?.d1_databases ?? {});
  if (
    targetD1Ids.length !== 2 ||
    targetD1Ids.some((databaseId) => typeof databaseId !== "string") ||
    typeof bindingTargets?.backup_r2_bucket !== "string" ||
    !Array.isArray(workerBindings)
  ) {
    throw new Error("Maintenance Worker binding observation is incomplete.");
  }
  const targetD1IdSet = new Set(targetD1Ids);
  for (const worker of workerBindings) {
    if (!Array.isArray(worker?.bindings)) {
      throw new Error("Maintenance Worker binding observation is incomplete.");
    }
    for (const binding of worker.bindings) {
      if (binding?.type === "d1" && targetD1IdSet.has(binding.database_id)) {
        codes.push("TARGET_D1_BINDING_ACTIVE", "MISSING_DURABLE_MAINTENANCE_FENCE");
      }
      if (
        binding?.type === "r2_bucket" &&
        binding.bucket_name === bindingTargets.backup_r2_bucket
      ) {
        codes.push("BACKUP_R2_BINDING_ACTIVE");
      }
      if (binding?.type === "service" && binding.service === "edgemneme-memory-gateway") {
        codes.push("INBOUND_GATEWAY_SERVICE_BINDING_ACTIVE");
      }
    }
  }
  if (hasPublicGatewayIngress(cloudflare.gateway_ingress)) {
    codes.push("PUBLIC_GATEWAY_INGRESS_ACTIVE");
  }
  if ((cloudflare.schedules?.["edgemneme-memory-orchestrator"]?.length ?? 0) !== 0) {
    codes.push("ORCHESTRATOR_CRON_ACTIVE");
  }
  if ((cloudflare.schedules?.["edgemneme-github-sync"]?.length ?? 0) !== 0) {
    codes.push("GITHUB_SYNC_CRON_ACTIVE");
  }

  for (const queue of cloudflare.queues ?? []) {
    const target = TARGET_QUEUES.has(queue.name);
    if (
      queue.consumers?.some((consumer) => CORE_WORKERS.has(consumer.script)) ||
      (target && queue.consumers?.length !== 0)
    ) {
      codes.push("QUEUE_CONSUMER_ACTIVE");
    }
    if (target && queue.producers?.length !== 0) {
      codes.push("QUEUE_PRODUCER_ACTIVE");
    }
    if (
      target && queue.metrics !== null &&
      (queue.metrics?.backlog_count !== 0 ||
        queue.metrics?.backlog_bytes !== 0 ||
        queue.metrics?.oldest_message_timestamp_ms !== 0)
    ) {
      codes.push("QUEUE_APPROXIMATE_BACKLOG_NONZERO");
    }
  }

  const relevantWorkflows = cloudflare.workflows ?? [];
  if (relevantWorkflows.length !== 0) {
    codes.push("CORE_WORKFLOW_DEFINITION_PRESENT", "MISSING_DURABLE_MAINTENANCE_FENCE");
  }
  if (relevantWorkflows.some((workflow) => workflow.nonterminal_instances?.length !== 0)) {
    codes.push("NONTERMINAL_WORKFLOW_INSTANCE");
  }
  if (d1.memory?.inflight !== 0) codes.push("MEMORY_D1_INFLIGHT");
  if (d1.search?.inflight !== 0) codes.push("SEARCH_D1_INFLIGHT");
  if ((d1.memory?.production_rows ?? 0) !== 0 || (d1.search?.production_rows ?? 0) !== 0) {
    codes.push("PRODUCTION_DATA_PRESENT", "MISSING_DURABLE_MAINTENANCE_FENCE");
  }
  return [...new Set(codes)].sort();
}

export function assertMaintenanceReady(observation) {
  const codes = maintenanceViolationCodes(observation);
  if (codes.length !== 0) throw new MaintenanceAdmissionError(codes);
  return observation;
}

export async function observeMaintenance(
  {
    environment = process.env,
    fetchImpl = fetch,
    configPath = DEFAULT_CONFIG,
    cloudflareObserver = observeCloudflareMaintenance,
    d1Observer = observeD1Maintenance
  } = {}
) {
  const [cloudflare, d1] = await Promise.all([
    cloudflareObserver(environment, fetchImpl, configPath),
    d1Observer(configPath)
  ]);
  return Object.freeze({ cloudflare, d1 });
}

export async function runMaintenanceAdmission(
  {
    expectedFingerprint,
    wait = () => new Promise((resolve) => setTimeout(resolve, STABILITY_DELAY_MS)),
    ...observationOptions
  } = {}
) {
  if (expectedFingerprint !== undefined && !FINGERPRINT.test(expectedFingerprint)) {
    throw new Error("The expected maintenance fingerprint is invalid.");
  }
  const first = assertMaintenanceReady(await observeMaintenance(observationOptions));
  await wait();
  const second = assertMaintenanceReady(await observeMaintenance(observationOptions));
  const firstCanonical = stableJson(first);
  const secondCanonical = stableJson(second);
  if (firstCanonical !== secondCanonical) {
    throw new MaintenanceAdmissionError(
      ["MAINTENANCE_STATE_DRIFT"],
      "maintenance state changed between consecutive observations"
    );
  }
  const fingerprint = maintenanceFingerprint(second);
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
    throw new MaintenanceAdmissionError(
      ["MAINTENANCE_FINGERPRINT_DRIFT"],
      "maintenance state changed since the pre-backup admission"
    );
  }
  return Object.freeze({ fingerprint, observation: second });
}

function parseCliArgs(argv) {
  const [command, ...args] = argv;
  if (!["capture", "verify"].includes(command)) {
    throw new Error("Usage: d1-maintenance-admission.mjs <capture|verify> --config <path> [--expected-fingerprint <sha256>]");
  }
  let configPath;
  let expectedFingerprint;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (typeof value !== "string" || value === "") throw new Error(`Missing value for ${flag}.`);
    if (flag === "--config" && configPath === undefined) configPath = value;
    else if (flag === "--expected-fingerprint" && expectedFingerprint === undefined) {
      expectedFingerprint = value;
    } else {
      throw new Error(`Unknown or duplicate maintenance admission option ${flag}.`);
    }
  }
  if (configPath === undefined) throw new Error("--config is required.");
  if (command === "capture" && expectedFingerprint !== undefined) {
    throw new Error("capture does not accept --expected-fingerprint.");
  }
  if (command === "verify" && expectedFingerprint === undefined) {
    throw new Error("verify requires --expected-fingerprint.");
  }
  return { configPath, expectedFingerprint };
}

async function main(argv) {
  const options = parseCliArgs(argv);
  const result = await runMaintenanceAdmission(options);
  const queueEvidence = result.observation.cloudflare.queues
    .filter((queue) => TARGET_QUEUES.has(queue.name))
    .map((queue) => ({ name: queue.name, approximate_metrics: queue.metrics }));
  process.stderr.write(`${JSON.stringify({
    status: "ready",
    mode: "greenfield-only",
    search_0005: result.observation.d1.search.state,
    queue_metrics_are_approximate_corroboration_only: true,
    queues: queueEvidence
  })}\n`);
  process.stdout.write(`${result.fingerprint}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown maintenance admission failure.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
