#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORTED_WORKERS = new Set([
  "memory-orchestrator",
  "memory-gateway",
  "github-sync"
]);

const PUBLIC_PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "11111111-1111-1111-1111-111111111111"
]);
const PUBLIC_NAMESPACE_PLACEHOLDERS = new Set(["10001", "10002", "10003"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CREDENTIAL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const GITHUB_SYNC_CRON = "0 */6 * * *";

export function generatedConfigPath(rootDirectory, worker) {
  assertSupportedWorker(worker);
  return join(rootDirectory, "wrangler", ".wrangler", `${worker}.generated.jsonc`);
}

export function renderConfig(worker, sourceConfig, environment) {
  assertSupportedWorker(worker);
  const rendered = structuredClone(sourceConfig);
  rebaseRelativePaths(rendered);

  if (worker === "memory-orchestrator") {
    setD1DatabaseId(rendered, "MEMORY_DB", requiredUuid(environment, "CF_D1_MEMORY_DATABASE_ID"));
    setD1DatabaseId(rendered, "SEARCH_DB", requiredUuid(environment, "CF_D1_SEARCH_DATABASE_ID"));
    return rendered;
  }

  if (worker === "memory-gateway") {
    setD1DatabaseId(rendered, "MEMORY_DB", requiredUuid(environment, "CF_D1_MEMORY_DATABASE_ID"));
    setD1DatabaseId(rendered, "SEARCH_DB", requiredUuid(environment, "CF_D1_SEARCH_DATABASE_ID"));

    const namespaces = {
      MCP_EDGE_LIMITER: requiredNamespace(environment, "CF_RATE_LIMIT_NAMESPACE_EDGE"),
      MCP_CLIENT_LIMITER: requiredNamespace(environment, "CF_RATE_LIMIT_NAMESPACE_CLIENT"),
      MCP_PRINCIPAL_LIMITER: requiredNamespace(environment, "CF_RATE_LIMIT_NAMESPACE_PRINCIPAL")
    };
    if (new Set(Object.values(namespaces)).size !== Object.keys(namespaces).length) {
      throw new Error("Rate-limit namespace variables must contain distinct IDs.");
    }
    for (const [binding, namespaceId] of Object.entries(namespaces)) {
      setRateLimitNamespace(rendered, binding, namespaceId);
    }

    const vars = requireRecord(rendered, "vars");
    if (vars.ALLOWED_ORIGINS !== "") {
      throw new Error("Public memory-gateway config must retain the empty ALLOWED_ORIGINS placeholder.");
    }
    vars.ALLOWED_ORIGINS = optionalOrigins(environment, "MEMORY_GATEWAY_ALLOWED_ORIGINS");
    if ("routes" in rendered) {
      throw new Error("Public memory-gateway config must not contain account route resources.");
    }
    const customDomain = optionalDomain(environment, "MEMORY_GATEWAY_CUSTOM_DOMAIN");
    if (customDomain === undefined) {
      rendered.workers_dev = true;
    } else {
      rendered.workers_dev = false;
      rendered.routes = [{ pattern: customDomain, custom_domain: true }];
    }
    return rendered;
  }

  setD1DatabaseId(rendered, "MEMORY_DB", requiredUuid(environment, "CF_D1_MEMORY_DATABASE_ID"));
  const enabled = environment.ENABLE_GITHUB_SYNC;
  if (enabled !== "true" && enabled !== "false") {
    throw new Error("Deployment variable ENABLE_GITHUB_SYNC must be exactly true or false.");
  }
  const vars = requireRecord(rendered, "vars");
  if (
    vars.GITHUB_SYNC_ENABLED !== "false" ||
    vars.GITHUB_CREDENTIAL_VERSION !== "unconfigured"
  ) {
    throw new Error(
      "Public github-sync config must retain its disabled lifecycle placeholders."
    );
  }
  if ("secrets" in rendered) {
    throw new Error("Public github-sync config must not require a credential secret.");
  }
  const triggers = requireRecord(rendered, "triggers");
  const crons = requireArray(triggers, "crons");
  if (crons.length !== 0) {
    throw new Error("Public github-sync config must not contain an active Cron Trigger.");
  }
  if (enabled === "true") {
    vars.GITHUB_SYNC_ENABLED = "true";
    vars.GITHUB_CREDENTIAL_VERSION = requiredCredentialVersion(
      environment,
      "GITHUB_CREDENTIAL_VERSION"
    );
    triggers.crons = [GITHUB_SYNC_CRON];
    rendered.secrets = { required: ["GITHUB_CLASSIC_TOKEN"] };
  }
  return rendered;
}

function rebaseRelativePaths(config) {
  config.$schema = rebaseParentPath(config.$schema, "$schema");
  config.main = rebaseParentPath(config.main, "main");
  if (Array.isArray(config.d1_databases)) {
    for (const database of config.d1_databases) {
      if (typeof database?.migrations_dir === "string") {
        database.migrations_dir = rebaseParentPath(
          database.migrations_dir,
          `${database.binding ?? "unknown"}.migrations_dir`
        );
      }
    }
  }
}

function rebaseParentPath(value, property) {
  if (typeof value !== "string" || !value.startsWith("../")) {
    throw new Error(`Public Wrangler config property ${property} must start with ../.`);
  }
  return `../${value}`;
}

export function renderAndWrite(worker, environment = process.env, rootDirectory = process.cwd()) {
  assertSupportedWorker(worker);
  const sourcePath = join(rootDirectory, "wrangler", `${worker}.jsonc`);
  let source;
  try {
    source = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch {
    throw new Error(`Unable to parse the public Wrangler config for ${worker}.`);
  }
  const rendered = renderConfig(worker, source, environment);
  const outputPath = generatedConfigPath(rootDirectory, worker);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(rendered, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return outputPath;
}

function assertSupportedWorker(worker) {
  if (!SUPPORTED_WORKERS.has(worker)) {
    throw new Error(`Unsupported worker target: ${worker}`);
  }
}

function requireRecord(parent, property) {
  const value = parent[property];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Wrangler config property ${property} must be an object.`);
  }
  return value;
}

function requireArray(parent, property) {
  const value = parent[property];
  if (!Array.isArray(value)) {
    throw new Error(`Wrangler config property ${property} must be an array.`);
  }
  return value;
}

function setD1DatabaseId(config, binding, databaseId) {
  const databases = requireArray(config, "d1_databases");
  const matches = databases.filter((entry) => entry?.binding === binding);
  if (matches.length !== 1) {
    throw new Error(`Wrangler config must contain exactly one ${binding} D1 binding.`);
  }
  const database = matches[0];
  if (!PUBLIC_PLACEHOLDERS.has(database.database_id)) {
    throw new Error(`Public Wrangler config must retain the ${binding} placeholder ID.`);
  }
  database.database_id = databaseId;
}

function setRateLimitNamespace(config, binding, namespaceId) {
  const rateLimits = requireArray(config, "ratelimits");
  const matches = rateLimits.filter((entry) => entry?.name === binding);
  if (matches.length !== 1) {
    throw new Error(`Wrangler config must contain exactly one ${binding} rate-limit binding.`);
  }
  matches[0].namespace_id = namespaceId;
}

function requiredValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required deployment variable ${name} is missing.`);
  }
  return value.trim();
}

function requiredUuid(environment, name) {
  const value = requiredValue(environment, name);
  if (!UUID_PATTERN.test(value) || PUBLIC_PLACEHOLDERS.has(value.toLowerCase())) {
    throw new Error(`Deployment variable ${name} must be a non-placeholder UUID.`);
  }
  return value.toLowerCase();
}

function requiredNamespace(environment, name) {
  const value = requiredValue(environment, name);
  if (
    !/^[1-9][0-9]*$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    PUBLIC_NAMESPACE_PLACEHOLDERS.has(value)
  ) {
    throw new Error(`Deployment variable ${name} must be a positive safe integer.`);
  }
  return value;
}

function optionalOrigins(environment, name) {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return "";
  }
  const rawOrigins = rawValue.trim().split(",");
  const origins = rawOrigins.map((_entry, index) => {
    const entry = rawOrigins[index]?.trim() ?? "";
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`Deployment variable ${name} contains an invalid origin.`);
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin !== entry
    ) {
      throw new Error(`Deployment variable ${name} must contain only HTTPS origins.`);
    }
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) {
    throw new Error(`Deployment variable ${name} must not contain duplicate origins.`);
  }
  return origins.join(",");
}

function optionalDomain(environment, name) {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }
  const domain = rawValue.trim().toLowerCase();
  if (
    domain.length > 253 ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    isIP(domain) !== 0
  ) {
    throw new Error(`Deployment variable ${name} must be a valid DNS hostname.`);
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )
  ) {
    throw new Error(`Deployment variable ${name} must be a valid DNS hostname.`);
  }
  return domain;
}

function requiredCredentialVersion(environment, name) {
  const value = requiredValue(environment, name);
  if (value === "unconfigured" || !CREDENTIAL_VERSION_PATTERN.test(value)) {
    throw new Error(`Deployment variable ${name} must be a configured version identifier.`);
  }
  return value;
}

function main() {
  const workers = process.argv.slice(2);
  if (workers.length === 0) {
    throw new Error("At least one supported worker target is required.");
  }
  if (new Set(workers).size !== workers.length) {
    throw new Error("Worker targets must not be repeated.");
  }
  for (const supportedWorker of SUPPORTED_WORKERS) {
    if (!workers.includes(supportedWorker)) {
      rmSync(generatedConfigPath(process.cwd(), supportedWorker), { force: true });
    }
  }
  for (const worker of workers) {
    renderAndWrite(worker);
    process.stdout.write(`Rendered deployment config for ${worker}.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown renderer error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
