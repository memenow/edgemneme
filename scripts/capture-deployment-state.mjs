#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ACTIVE_VERSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const GITHUB_SYNC_CRON = "0 */6 * * *";
const GITHUB_SYNC_WORKER = "edgemneme-github-sync";
const REQUEST_TIMEOUT_MS = 15_000;
const STATE_FIELDS = new Set([
  "orchestrator_version",
  "gateway_version",
  "github_sync_version",
  "github_sync_state",
  "github_sync_schedule_state",
  "github_sync_secret_state"
]);
const CONFIGURATION_FIELDS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_D1_MEMORY_DATABASE_ID",
  "CF_D1_SEARCH_DATABASE_ID",
  "CF_RATE_LIMIT_NAMESPACE_EDGE",
  "CF_RATE_LIMIT_NAMESPACE_CLIENT",
  "CF_RATE_LIMIT_NAMESPACE_PRINCIPAL"
];

function requiredValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required deployment input ${name} is missing.`);
  }
  return value.trim();
}

function booleanValue(environment, name, defaultValue) {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return defaultValue;
  }
  const value = rawValue.trim();
  if (value !== "true" && value !== "false") {
    throw new Error(`Deployment input ${name} must be exactly true or false.`);
  }
  return value === "true";
}

function optionalValue(environment, name) {
  const value = environment[name];
  return typeof value === "string" ? value.trim() : "";
}

export function deploymentConfigurationFingerprint(environment = process.env) {
  const enableGitHubSync = requiredValue(environment, "ENABLE_GITHUB_SYNC");
  if (enableGitHubSync !== "true" && enableGitHubSync !== "false") {
    throw new Error("Deployment input ENABLE_GITHUB_SYNC must be exactly true or false.");
  }
  const configuration = CONFIGURATION_FIELDS.map((name) => [
    name,
    requiredValue(environment, name)
  ]);
  configuration.push(
    ["ENABLE_GITHUB_SYNC", enableGitHubSync],
    ["GITHUB_CREDENTIAL_VERSION", optionalValue(environment, "GITHUB_CREDENTIAL_VERSION")],
    ["MEMORY_GATEWAY_ALLOWED_ORIGINS", optionalValue(environment, "MEMORY_GATEWAY_ALLOWED_ORIGINS")],
    ["MEMORY_GATEWAY_CUSTOM_DOMAIN", optionalValue(environment, "MEMORY_GATEWAY_CUSTOM_DOMAIN")]
  );
  if (
    enableGitHubSync === "true" &&
    configuration.find(([name]) => name === "GITHUB_CREDENTIAL_VERSION")?.[1] === ""
  ) {
    throw new Error(
      "Required deployment input GITHUB_CREDENTIAL_VERSION is missing while GitHub sync is enabled."
    );
  }
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

async function requestCloudflare({ accountId, token, path, fetchImpl, allowNotFound = false }) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
  );
  if (allowNotFound && response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Cloudflare deployment state query failed with HTTP ${response.status}.`);
  }
  const envelope = await response.json();
  if (envelope?.success !== true) {
    throw new Error("The Cloudflare deployment state response is invalid.");
  }
  return envelope;
}

async function readWorkerDeployments(context, workerName) {
  const envelope = await requestCloudflare({
    ...context,
    path: `/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
    allowNotFound: true
  });
  if (envelope === undefined) {
    return undefined;
  }
  const deployments = envelope?.result?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("The Cloudflare Worker deployment response is invalid.");
  }
  return deployments;
}

function activeWorkerVersion(deployments) {
  const candidates = deployments.map((deployment) => {
    const createdAt = Date.parse(deployment?.created_on);
    if (!Number.isFinite(createdAt)) {
      throw new Error("A Worker deployment has an invalid creation timestamp.");
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
    throw new Error("The active Worker deployment is not a single 100% version.");
  }
  return version.version_id;
}

async function readGitHubSyncScheduleState(context) {
  const envelope = await requestCloudflare({
    ...context,
    path: `/workers/scripts/${GITHUB_SYNC_WORKER}/schedules`
  });
  const schedules = envelope?.result?.schedules;
  if (!Array.isArray(schedules)) {
    throw new Error("The Cloudflare schedule response is invalid.");
  }
  if (schedules.length === 0) {
    return "disabled";
  }
  if (schedules.length === 1 && schedules[0]?.cron === GITHUB_SYNC_CRON) {
    return "enabled";
  }
  throw new Error("The GitHub sync Worker has an unrecognized Cron Trigger state.");
}

async function readGitHubSyncSecretState(context) {
  const envelope = await requestCloudflare({
    ...context,
    path: `/workers/scripts/${GITHUB_SYNC_WORKER}/secrets`
  });
  const secrets = envelope?.result;
  if (!Array.isArray(secrets)) {
    throw new Error("The GitHub sync secret binding response is invalid.");
  }
  if (secrets.length === 0) {
    return "absent";
  }
  if (
    secrets.length === 1 &&
    secrets[0]?.name === "GITHUB_CLASSIC_TOKEN" &&
    secrets[0]?.type === "secret_text"
  ) {
    return "present";
  }
  throw new Error("The GitHub sync Worker has an unexpected secret binding.");
}

async function observeDeploymentState(environment, fetchImpl) {
  const context = {
    accountId: requiredValue(environment, "CLOUDFLARE_ACCOUNT_ID"),
    token: requiredValue(environment, "CLOUDFLARE_API_TOKEN"),
    fetchImpl
  };
  const [orchestratorDeployments, gatewayDeployments, githubSyncDeployments] =
    await Promise.all([
      readWorkerDeployments(context, "edgemneme-memory-orchestrator"),
      readWorkerDeployments(context, "edgemneme-memory-gateway"),
      readWorkerDeployments(context, GITHUB_SYNC_WORKER)
    ]);

  const orchestratorVersion =
    orchestratorDeployments === undefined ? "absent" : activeWorkerVersion(orchestratorDeployments);
  const gatewayVersion =
    gatewayDeployments === undefined ? "absent" : activeWorkerVersion(gatewayDeployments);
  const githubSyncState = githubSyncDeployments === undefined ? "absent" : "present";
  let githubSyncVersion = "absent";
  let githubSyncScheduleState = "absent";
  let githubSyncSecretState = "absent";

  if (githubSyncDeployments !== undefined) {
    githubSyncVersion = activeWorkerVersion(githubSyncDeployments);
    [githubSyncScheduleState, githubSyncSecretState] = await Promise.all([
      readGitHubSyncScheduleState(context),
      readGitHubSyncSecretState(context)
    ]);
    if (githubSyncScheduleState === "enabled" && githubSyncSecretState !== "present") {
      throw new Error("The enabled GitHub sync Worker is missing its credential binding.");
    }
  }

  return {
    orchestrator_version: orchestratorVersion,
    gateway_version: gatewayVersion,
    github_sync_version: githubSyncVersion,
    github_sync_state: githubSyncState,
    github_sync_schedule_state: githubSyncScheduleState,
    github_sync_secret_state: githubSyncSecretState
  };
}

export async function captureDeploymentState(environment = process.env, fetchImpl = fetch) {
  const enableGitHubSync = booleanValue(environment, "ENABLE_GITHUB_SYNC", false);
  const bootstrapMode = booleanValue(
    environment,
    "EDGEMNEME_BOOTSTRAP_EXPECTED_EMPTY",
    false
  );
  const observed = await observeDeploymentState(environment, fetchImpl);
  let orchestratorVersion = observed.orchestrator_version;
  let gatewayVersion = observed.gateway_version;

  if (bootstrapMode) {
    if (environment.GITHUB_EVENT_NAME !== "workflow_dispatch") {
      throw new Error("Bootstrap is allowed only from a manual workflow_dispatch run.");
    }
    if (orchestratorVersion !== "absent" || gatewayVersion !== "absent") {
      throw new Error("Bootstrap expected both core Workers to be absent; refusing deployment.");
    }
    if (enableGitHubSync && observed.github_sync_state !== "absent") {
      throw new Error(
        "Enabled bootstrap expected the GitHub sync Worker to be absent; refusing deployment."
      );
    }
    orchestratorVersion = "";
    gatewayVersion = "";
  } else if (orchestratorVersion === "absent" || gatewayVersion === "absent") {
    throw new Error("A core Worker is absent; use the explicit expected-empty bootstrap input.");
  }

  return {
    ...observed,
    orchestrator_version: orchestratorVersion,
    gateway_version: gatewayVersion,
    github_sync_version:
      observed.github_sync_version === "absent" ? "" : observed.github_sync_version,
    bootstrap_mode: String(bootstrapMode),
    configuration_fingerprint: deploymentConfigurationFingerprint(environment)
  };
}

export async function verifyDeploymentState(
  fields,
  environment = process.env,
  fetchImpl = fetch
) {
  if (!Array.isArray(fields) || fields.length === 0 || new Set(fields).size !== fields.length) {
    throw new Error("At least one unique deployment state field is required.");
  }
  for (const field of fields) {
    if (!STATE_FIELDS.has(field)) {
      throw new Error(`Unsupported deployment state field ${field}.`);
    }
  }
  const observed = await observeDeploymentState(environment, fetchImpl);
  for (const field of fields) {
    const expectedName = `EXPECTED_${field.toUpperCase()}`;
    const rawExpected = environment[expectedName];
    if (typeof rawExpected !== "string") {
      throw new Error(`Required deployment input ${expectedName} is missing.`);
    }
    let expected = rawExpected.trim();
    if (field.endsWith("_version") && expected === "") {
      expected = "absent";
    } else if (expected === "") {
      throw new Error(`Required deployment input ${expectedName} is missing.`);
    }
    if (observed[field] !== expected) {
      throw new Error(`Production ${field} changed after the rollback snapshot.`);
    }
  }
  return observed;
}

export function writeGitHubOutputs(outputPath, state) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error("GITHUB_OUTPUT is unavailable.");
  }
  const lines = Object.entries(state).map(([name, value]) => {
    if (typeof value !== "string" || value.includes("\n") || value.includes("\r")) {
      throw new Error(`Deployment state output ${name} is invalid.`);
    }
    return `${name}=${value}\n`;
  });
  appendFileSync(outputPath, lines.join(""));
}

async function main() {
  const mode = process.argv[2] ?? "capture";
  if (mode === "capture") {
    const state = await captureDeploymentState();
    writeGitHubOutputs(process.env.GITHUB_OUTPUT, state);
    return;
  }
  if (mode === "verify") {
    await verifyDeploymentState(process.argv.slice(3));
    return;
  }
  if (mode === "verify-configuration") {
    const expected = requiredValue(process.env, "EXPECTED_CONFIGURATION_FINGERPRINT");
    if (deploymentConfigurationFingerprint() !== expected) {
      throw new Error("Rollback configuration does not match the captured production configuration.");
    }
    return;
  }
  throw new Error(`Unsupported deployment state command ${mode}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
