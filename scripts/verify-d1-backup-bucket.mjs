#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const D1_BACKUP_PREFIX = "system/backups/d1-migrations/";
export const D1_BACKUP_RETENTION_RULE_ID =
  "edgemneme-d1-migration-backups-retention";
export const MIN_D1_BACKUP_RETENTION_DAYS = 30;
export const MAX_D1_BACKUP_RETENTION_DAYS = 365;

const R2_BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;

export function d1MigrationBackupBucketName(environment = process.env) {
  const bucketName = requiredEnvironment(environment, "D1_MIGRATION_BACKUP_R2_BUCKET");
  if (!R2_BUCKET_PATTERN.test(bucketName)) {
    throw new Error(
      "D1_MIGRATION_BACKUP_R2_BUCKET must be a valid 3-63 character R2 bucket name."
    );
  }
  return bucketName;
}

export function d1BackupBucketPolicy(environment = process.env) {
  const bucketName = d1MigrationBackupBucketName(environment);

  const retentionValue = requiredEnvironment(
    environment,
    "D1_MIGRATION_BACKUP_RETENTION_DAYS"
  );
  if (!/^[1-9][0-9]*$/u.test(retentionValue)) {
    throw new Error("D1_MIGRATION_BACKUP_RETENTION_DAYS must be an integer number of days.");
  }
  const retentionDays = Number(retentionValue);
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_D1_BACKUP_RETENTION_DAYS ||
    retentionDays > MAX_D1_BACKUP_RETENTION_DAYS
  ) {
    throw new Error(
      `D1_MIGRATION_BACKUP_RETENTION_DAYS must be between ${MIN_D1_BACKUP_RETENTION_DAYS} and ${MAX_D1_BACKUP_RETENTION_DAYS}.`
    );
  }

  return {
    bucketName,
    retentionDays,
    retentionSeconds: retentionDays * 24 * 60 * 60
  };
}

export function readRuntimeR2Bindings(rootDirectory = process.cwd()) {
  const wranglerDirectory = join(rootDirectory, "wrangler");
  const generatedDirectory = join(wranglerDirectory, ".wrangler");
  const generatedMigrationConfig = join(
    generatedDirectory,
    "memory-orchestrator.generated.jsonc"
  );
  if (!existsSync(generatedMigrationConfig)) {
    throw new Error("The generated memory-orchestrator migration config is missing.");
  }

  const trackedConfigs = readdirSync(wranglerDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonc"))
    .map((entry) => join(wranglerDirectory, entry.name));
  const generatedConfigs = readdirSync(generatedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".generated.jsonc"))
    .map((entry) => join(generatedDirectory, entry.name));
  const configPaths = [...new Set([...trackedConfigs, ...generatedConfigs])].sort();
  const bindings = [];

  for (const configPath of configPaths) {
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      throw new Error(
        `Unable to parse runtime Wrangler config ${relative(rootDirectory, configPath)}.`
      );
    }
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(
        `Runtime Wrangler config ${relative(rootDirectory, configPath)} must be an object.`
      );
    }
    if (!("r2_buckets" in config)) {
      continue;
    }
    if (!Array.isArray(config.r2_buckets)) {
      throw new Error(
        `Runtime Wrangler config ${relative(rootDirectory, configPath)} has invalid R2 bindings.`
      );
    }
    for (const binding of config.r2_buckets) {
      if (
        binding === null ||
        typeof binding !== "object" ||
        Array.isArray(binding) ||
        typeof binding.binding !== "string" ||
        binding.binding.length === 0 ||
        typeof binding.bucket_name !== "string" ||
        !R2_BUCKET_PATTERN.test(binding.bucket_name)
      ) {
        throw new Error(
          `Runtime Wrangler config ${relative(rootDirectory, configPath)} has an invalid R2 binding.`
        );
      }
      bindings.push({
        configPath: relative(rootDirectory, configPath),
        binding: binding.binding,
        bucketName: binding.bucket_name
      });
    }
  }

  return bindings;
}

export function assertBackupBucketIsolation(bucketName, runtimeBindings) {
  if (!Array.isArray(runtimeBindings)) {
    throw new Error("Runtime R2 binding inventory is invalid.");
  }
  const conflicts = runtimeBindings.filter((binding) => binding?.bucketName === bucketName);
  if (conflicts.length > 0) {
    const locations = conflicts
      .map((binding) => `${binding.configPath}:${binding.binding}`)
      .sort()
      .join(", ");
    throw new Error(
      `The D1 migration backup bucket is bound to a runtime Worker (${locations}).`
    );
  }
}

export function assertBackupBucketControlPlane(policy, controlPlane) {
  const bucket = requiredRecord(controlPlane?.bucket, "R2 bucket response");
  if (
    bucket.name !== policy.bucketName ||
    (bucket.jurisdiction !== undefined && bucket.jurisdiction !== "default")
  ) {
    throw new Error("The configured D1 migration backup bucket was not returned exactly.");
  }

  const customDomains = requiredRecord(
    controlPlane?.customDomains,
    "R2 custom-domain response"
  );
  if (!Array.isArray(customDomains.domains)) {
    throw new Error("The R2 custom-domain response is invalid.");
  }
  if (customDomains.domains.length !== 0) {
    throw new Error("The D1 migration backup bucket has a custom domain registration.");
  }

  const managedDomain = requiredRecord(
    controlPlane?.managedDomain,
    "R2 managed-domain response"
  );
  if (
    typeof managedDomain.bucketId !== "string" ||
    managedDomain.bucketId.length === 0 ||
    typeof managedDomain.domain !== "string" ||
    managedDomain.domain.length === 0 ||
    managedDomain.enabled !== false
  ) {
    throw new Error("The D1 migration backup bucket does not have r2.dev access disabled.");
  }

  const lifecycle = requiredRecord(controlPlane?.lifecycle, "R2 lifecycle response");
  if (!Array.isArray(lifecycle.rules)) {
    throw new Error("The R2 lifecycle response is invalid.");
  }
  const ruleIds = new Set();
  const enabledDeletionRules = [];
  for (const value of lifecycle.rules) {
    const rule = requiredRecord(value, "R2 lifecycle rule");
    const conditions = requiredRecord(rule.conditions, "R2 lifecycle rule conditions");
    if (
      typeof rule.id !== "string" ||
      rule.id.length === 0 ||
      ruleIds.has(rule.id) ||
      typeof rule.enabled !== "boolean" ||
      typeof conditions.prefix !== "string"
    ) {
      throw new Error("The R2 lifecycle response contains an invalid rule.");
    }
    ruleIds.add(rule.id);
    if (rule.deleteObjectsTransition === undefined) {
      continue;
    }
    const transition = requiredRecord(
      rule.deleteObjectsTransition,
      "R2 lifecycle delete transition"
    );
    const condition = requiredRecord(
      transition.condition,
      "R2 lifecycle delete transition condition"
    );
    if (rule.enabled) {
      enabledDeletionRules.push({ rule, conditions, condition });
    }
  }

  if (enabledDeletionRules.length !== 1) {
    throw new Error(
      "The D1 migration backup bucket must have exactly one enabled object-deletion rule."
    );
  }
  const [{ rule, conditions, condition }] = enabledDeletionRules;
  if (
    rule.id !== D1_BACKUP_RETENTION_RULE_ID ||
    conditions.prefix !== D1_BACKUP_PREFIX ||
    condition.type !== "Age" ||
    condition.maxAge !== policy.retentionSeconds
  ) {
    throw new Error(
      "The D1 migration backup bucket lifecycle does not match the protected retention policy."
    );
  }
}

export async function verifyD1BackupBucket(
  environment = process.env,
  fetchImpl = fetch,
  options = {}
) {
  const policy = d1BackupBucketPolicy(environment);
  const runtimeBindings = options.runtimeBindings ?? readRuntimeR2Bindings(
    options.rootDirectory ?? process.cwd()
  );
  assertBackupBucketIsolation(policy.bucketName, runtimeBindings);

  const accountId = requiredEnvironment(environment, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredEnvironment(environment, "CLOUDFLARE_API_TOKEN");
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
  const bucketPath = `/r2/buckets/${encodeURIComponent(policy.bucketName)}`;
  const request = (suffix, label) => requestCloudflare(
    `${base}${bucketPath}${suffix}`,
    apiToken,
    label,
    fetchImpl
  );

  const bucket = await request("", "R2 bucket");
  const [customDomains, managedDomain, lifecycle] = await Promise.all([
    request("/domains/custom", "R2 custom-domain"),
    request("/domains/managed", "R2 managed-domain"),
    request("/lifecycle", "R2 lifecycle")
  ]);
  assertBackupBucketControlPlane(policy, {
    bucket,
    customDomains,
    managedDomain,
    lifecycle
  });
  return policy;
}

async function requestCloudflare(url, apiToken, label, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new Error(`${label} query failed.`);
  }
  if (!response.ok) {
    throw new Error(`${label} query failed with HTTP ${response.status}.`);
  }
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error(`${label} response is not valid JSON.`);
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    envelope.success !== true ||
    !("result" in envelope)
  ) {
    throw new Error(`${label} response envelope is invalid.`);
  }
  return envelope.result;
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  return value.trim();
}

function requiredRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

async function main() {
  await verifyD1BackupBucket();
  process.stdout.write("D1 migration backup bucket admission passed.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown backup bucket error.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
