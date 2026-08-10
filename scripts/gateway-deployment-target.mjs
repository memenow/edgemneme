#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  assertGatewayConfigMatchesState,
  decodeGatewayTriggerState,
  desiredGatewayTriggerFromConfig,
  gatewayTriggerFingerprint,
  observeGatewayTriggerState,
  readGatewayConfig,
  restoreGatewayTriggerState
} from "./gateway-trigger-state.mjs";

const ACTIVE_VERSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CAPTURE_LIMIT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 240_000;

function requiredValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required gateway deployment input ${name} is missing.`);
  }
  return value.trim();
}

function booleanValue(environment, name) {
  const value = requiredValue(environment, name);
  if (value !== "true" && value !== "false") {
    throw new Error(`Gateway deployment input ${name} must be exactly true or false.`);
  }
  return value === "true";
}

export function activeVersionFromDeployments(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("The gateway has no active deployment.");
  }
  const candidates = deployments.map((deployment) => {
    const createdAt = Date.parse(deployment?.created_on);
    if (!Number.isFinite(createdAt)) {
      throw new Error("A gateway deployment has an invalid creation timestamp.");
    }
    return { deployment, createdAt };
  });
  const latest = candidates.reduce((selected, candidate) =>
    candidate.createdAt > selected.createdAt ? candidate : selected
  ).deployment;
  const version = latest?.versions?.[0];
  if (
    !Array.isArray(latest?.versions) ||
    latest.versions.length !== 1 ||
    typeof version?.version_id !== "string" ||
    !ACTIVE_VERSION_PATTERN.test(version.version_id) ||
    version.percentage !== 100
  ) {
    throw new Error("The active gateway deployment is not a single 100% version.");
  }
  return version.version_id;
}

function defaultWranglerJson(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: CAPTURE_LIMIT_BYTES
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("The gateway Wrangler state query failed.");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("The gateway Wrangler state response is invalid.");
  }
}

export function taggedActiveGatewayVersion(configPath, expectedTag, runner = defaultWranglerJson) {
  const deployments = runner([
    "deployments",
    "list",
    "--config",
    configPath,
    "--json"
  ]);
  const activeVersion = activeVersionFromDeployments(deployments);
  const version = runner([
    "versions",
    "view",
    activeVersion,
    "--config",
    configPath,
    "--json"
  ]);
  if (
    version === null ||
    typeof version !== "object" ||
    Array.isArray(version) ||
    version.id !== activeVersion ||
    version.annotations?.["workers/tag"] !== expectedTag
  ) {
    throw new Error("The active gateway version is not this run's exact tagged deployment.");
  }
  return activeVersion;
}

function expectedCapturedState(environment) {
  return decodeGatewayTriggerState(requiredValue(environment, "EXPECTED_GATEWAY_TRIGGER_STATE"));
}

function assertCapturedFingerprint(state, environment) {
  const expectedFingerprint = requiredValue(
    environment,
    "EXPECTED_GATEWAY_TRIGGER_FINGERPRINT"
  );
  if (gatewayTriggerFingerprint(state) !== expectedFingerprint) {
    throw new Error("The captured gateway trigger fingerprint is invalid.");
  }
}

export async function verifyGatewayPredeploy(
  configPath,
  environment = process.env,
  fetchImpl = fetch
) {
  const config = readGatewayConfig(configPath);
  const captured = expectedCapturedState(environment);
  assertCapturedFingerprint(captured, environment);
  const bootstrap = booleanValue(environment, "EDGEMNEME_BOOTSTRAP_MODE");
  const observed = await observeGatewayTriggerState(environment, fetchImpl);
  if (observed.encoded !== requiredValue(environment, "EXPECTED_GATEWAY_TRIGGER_STATE")) {
    throw new Error("The remote gateway trigger changed after the production snapshot.");
  }
  if (bootstrap) {
    if (captured.worker_present) {
      throw new Error("Bootstrap requires an absent captured gateway trigger state.");
    }
    desiredGatewayTriggerFromConfig(config);
  } else {
    assertGatewayConfigMatchesState(config, observed.state);
  }
  return observed;
}

export async function captureGatewayRollbackCurrent(
  configPath,
  environment = process.env,
  fetchImpl = fetch,
  runner = defaultWranglerJson
) {
  const config = readGatewayConfig(configPath);
  const expectedTag = requiredValue(environment, "EXPECTED_GATEWAY_DEPLOYMENT_TAG");
  const activeVersion = taggedActiveGatewayVersion(configPath, expectedTag, runner);
  const observed = await observeGatewayTriggerState(environment, fetchImpl);
  assertGatewayConfigMatchesState(config, observed.state);
  if (taggedActiveGatewayVersion(configPath, expectedTag, runner) !== activeVersion) {
    throw new Error("The active gateway version changed during rollback trigger capture.");
  }
  return {
    gateway_active_version: activeVersion,
    gateway_trigger_state: observed.encoded,
    gateway_trigger_fingerprint: observed.fingerprint
  };
}

export async function captureGatewayCanaryTarget(
  configPath,
  environment = process.env,
  fetchImpl = fetch,
  runner = defaultWranglerJson
) {
  const config = readGatewayConfig(configPath);
  const captured = expectedCapturedState(environment);
  assertCapturedFingerprint(captured, environment);
  const bootstrap = booleanValue(environment, "EDGEMNEME_BOOTSTRAP_MODE");
  if (bootstrap && captured.worker_present) {
    throw new Error("Bootstrap requires an absent captured gateway trigger state.");
  }
  const expectedTag = requiredValue(environment, "EXPECTED_GATEWAY_DEPLOYMENT_TAG");
  const activeVersion = taggedActiveGatewayVersion(configPath, expectedTag, runner);
  const observed = await observeGatewayTriggerState(environment, fetchImpl);
  assertGatewayConfigMatchesState(config, observed.state);
  if (!bootstrap && observed.encoded !== requiredValue(environment, "EXPECTED_GATEWAY_TRIGGER_STATE")) {
    throw new Error("The gateway deployment changed its remote trigger state.");
  }
  if (observed.endpoint === null || observed.host === null) {
    throw new Error("The deployed gateway has no verified canary endpoint.");
  }
  if (taggedActiveGatewayVersion(configPath, expectedTag, runner) !== activeVersion) {
    throw new Error("The active gateway version changed while resolving the canary target.");
  }
  return {
    gateway_active_version: activeVersion,
    gateway_url: observed.endpoint,
    gateway_host: observed.host,
    gateway_trigger_state: observed.encoded,
    gateway_trigger_fingerprint: observed.fingerprint
  };
}

export async function verifyGatewayCanaryTarget(
  configPath,
  environment = process.env,
  fetchImpl = fetch,
  runner = defaultWranglerJson
) {
  const expectedVersion = requiredValue(environment, "EXPECTED_GATEWAY_ACTIVE_VERSION");
  const expectedTag = requiredValue(environment, "EXPECTED_GATEWAY_DEPLOYMENT_TAG");
  const activeVersion = taggedActiveGatewayVersion(configPath, expectedTag, runner);
  if (activeVersion !== expectedVersion) {
    throw new Error("The active gateway version changed during the production canary.");
  }
  const observed = await observeGatewayTriggerState(environment, fetchImpl);
  assertGatewayConfigMatchesState(readGatewayConfig(configPath), observed.state);
  if (
    observed.encoded !== requiredValue(environment, "EXPECTED_GATEWAY_TRIGGER_STATE") ||
    observed.fingerprint !== requiredValue(environment, "EXPECTED_GATEWAY_TRIGGER_FINGERPRINT")
  ) {
    throw new Error("The gateway trigger changed during the production canary.");
  }
  if (taggedActiveGatewayVersion(configPath, expectedTag, runner) !== expectedVersion) {
    throw new Error("The active gateway version changed during trigger verification.");
  }
  return observed;
}

function writeOutputs(outputPath, outputs) {
  if (typeof outputPath !== "string" || outputPath === "") {
    throw new Error("GITHUB_OUTPUT is unavailable.");
  }
  const lines = Object.entries(outputs).map(([name, value]) => {
    if (typeof value !== "string" || value.includes("\n") || value.includes("\r")) {
      throw new Error(`Gateway canary output ${name} is invalid.`);
    }
    return `${name}=${value}\n`;
  });
  appendFileSync(outputPath, lines.join(""));
}

async function main() {
  const mode = process.argv[2];
  const configPath = process.argv[3];
  if (mode === "verify-predeploy" && configPath !== undefined) {
    await verifyGatewayPredeploy(configPath);
    return;
  }
  if (mode === "capture-canary-target" && configPath !== undefined) {
    writeOutputs(
      process.env.GITHUB_OUTPUT,
      await captureGatewayCanaryTarget(configPath)
    );
    return;
  }
  if (mode === "verify-canary-target" && configPath !== undefined) {
    await verifyGatewayCanaryTarget(configPath);
    return;
  }
  if (mode === "capture-rollback-current" && configPath !== undefined) {
    process.stdout.write(JSON.stringify(await captureGatewayRollbackCurrent(configPath)));
    return;
  }
  if (mode === "verify-active-tag" && configPath !== undefined) {
    process.stdout.write(
      taggedActiveGatewayVersion(
        configPath,
        requiredValue(process.env, "EXPECTED_GATEWAY_DEPLOYMENT_TAG")
      )
    );
    return;
  }
  if (mode === "restore") {
    const encoded = requiredValue(process.env, "EXPECTED_GATEWAY_TRIGGER_STATE");
    const expected = decodeGatewayTriggerState(encoded);
    assertCapturedFingerprint(expected, process.env);
    await restoreGatewayTriggerState(encoded, process.env, fetch, {
      expectedCurrentEncodedState: requiredValue(
        process.env,
        "EXPECTED_GATEWAY_CURRENT_TRIGGER_STATE"
      ),
      expectedCurrentFingerprint: requiredValue(
        process.env,
        "EXPECTED_GATEWAY_CURRENT_TRIGGER_FINGERPRINT"
      ),
      gatewayAdvancedByRun: booleanValue(
        process.env,
        "EDGEMNEME_GATEWAY_ADVANCED_BY_RUN"
      ),
      allowDetachedAbsent:
        process.env.EDGEMNEME_GATEWAY_ALLOW_DETACHED_ABSENT === undefined
          ? false
          : booleanValue(process.env, "EDGEMNEME_GATEWAY_ALLOW_DETACHED_ABSENT")
    });
    return;
  }
  throw new Error(`Unsupported gateway deployment target command ${mode ?? ""}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
