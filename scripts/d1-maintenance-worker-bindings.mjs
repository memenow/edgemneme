import { readGeneratedD1DatabaseId } from "./github-sync-quiescence-runtime.mjs";
import { d1MigrationBackupBucketName } from "./verify-d1-backup-bucket.mjs";

const GATEWAY = "edgemneme-memory-gateway";
const MAX_CONCURRENT_WORKER_QUERIES = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
const R2_JURISDICTIONS = new Set(["eu", "fedramp", "fedramp-high"]);

function identifier(value, label, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) return null;
  return identifier(value, label, 2_048);
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.toLowerCase();
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

async function mapConcurrent(values, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_WORKER_QUERIES, values.length) },
      () => run()
    )
  );
  return results;
}

export function maintenanceBindingTargets(configPath, environment = process.env) {
  const memoryDatabaseId = readGeneratedD1DatabaseId(configPath, "MEMORY_DB");
  const searchDatabaseId = readGeneratedD1DatabaseId(configPath, "SEARCH_DB");
  if (memoryDatabaseId === searchDatabaseId) {
    throw new Error("MEMORY_DB and SEARCH_DB must reference distinct D1 databases.");
  }
  return Object.freeze({
    d1_databases: Object.freeze({
      MEMORY_DB: memoryDatabaseId,
      SEARCH_DB: searchDatabaseId
    }),
    backup_r2_bucket: d1MigrationBackupBucketName(environment)
  });
}

export function activeWorkerVersion(envelope, worker) {
  const deployments = envelope?.result?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error(`${worker} returned an invalid deployment inventory.`);
  }
  const active = record(deployments[0], `${worker} active deployment`);
  uuid(active.id, `${worker} active deployment ID`);
  if (!Number.isFinite(Date.parse(active.created_on)) || active.strategy !== "percentage") {
    throw new Error(`${worker} active deployment is invalid.`);
  }
  const version = active.versions?.[0];
  if (
    !Array.isArray(active.versions) ||
    active.versions.length !== 1 ||
    version?.percentage !== 100
  ) {
    throw new Error(`${worker} does not have one stable 100% active version.`);
  }
  return uuid(version.version_id, `${worker} active version ID`);
}

export async function readActiveWorkerVersions(client, workers) {
  if (!Array.isArray(workers)) throw new Error("Cloudflare Worker inventory is invalid.");
  return mapConcurrent(workers, async (worker) => {
    const name = identifier(worker?.name, "Cloudflare Worker script name");
    const envelope = await client.get(
      client.accountPath(`/workers/scripts/${encodeURIComponent(name)}/deployments`),
      { label: `${name} deployment query` }
    );
    return {
      name,
      version_id: activeWorkerVersion(envelope, name)
    };
  });
}

function normalizeBinding(binding, worker, targets) {
  const value = record(binding, `${worker} binding`);
  const name = identifier(value.name, `${worker} binding name`);
  const type = identifier(value.type, `${worker} binding type`);
  if (type === "inherit") {
    throw new Error(`${worker} active version contains an unresolved inherited binding.`);
  }
  if (type === "d1") {
    const databaseId = uuid(value.database_id, `${worker} D1 binding database ID`);
    if (value.id !== undefined && uuid(value.id, `${worker} deprecated D1 binding ID`) !== databaseId) {
      throw new Error(`${worker} D1 binding identifiers disagree.`);
    }
    const target = Object.entries(targets.d1_databases)
      .find(([, targetId]) => targetId === databaseId)?.[0] ?? null;
    return { name, type, database_id: databaseId, target };
  }
  if (type === "r2_bucket") {
    const bucketName = identifier(value.bucket_name, `${worker} R2 binding bucket name`);
    if (!R2_BUCKET.test(bucketName)) throw new Error(`${worker} R2 binding bucket name is invalid.`);
    const jurisdiction = optionalString(value.jurisdiction, `${worker} R2 binding jurisdiction`);
    if (jurisdiction !== null && !R2_JURISDICTIONS.has(jurisdiction)) {
      throw new Error(`${worker} R2 binding jurisdiction is invalid.`);
    }
    return {
      name,
      type,
      bucket_name: bucketName,
      jurisdiction,
      backup_bucket: bucketName === targets.backup_r2_bucket
    };
  }
  if (type === "service") {
    const service = identifier(value.service, `${worker} service binding target`);
    return {
      name,
      type,
      service,
      environment: optionalString(value.environment, `${worker} service binding environment`),
      entrypoint: optionalString(value.entrypoint, `${worker} service binding entrypoint`),
      inbound_gateway: service === GATEWAY
    };
  }
  return { name, type };
}

async function readVersionBindings(client, activeVersion, targets) {
  const worker = identifier(activeVersion?.name, "Cloudflare Worker script name");
  const versionId = uuid(activeVersion?.version_id, `${worker} active version ID`);
  const envelope = await client.get(
    client.accountPath(
      `/workers/scripts/${encodeURIComponent(worker)}/versions/${encodeURIComponent(versionId)}`
    ),
    { label: `${worker} active version resource query` }
  );
  const version = record(envelope?.result, `${worker} active version response`);
  if (uuid(version.id, `${worker} immutable version ID`) !== versionId) {
    throw new Error(`${worker} immutable version response does not match its active version.`);
  }
  const resources = record(version.resources, `${worker} active version resources`);
  const bindings = resources.bindings ?? [];
  if (!Array.isArray(bindings)) {
    throw new Error(`${worker} active version binding inventory is invalid.`);
  }
  const names = new Set();
  const normalized = bindings.map((binding) => {
    const value = normalizeBinding(binding, worker, targets);
    if (names.has(value.name)) throw new Error(`${worker} has duplicate binding names.`);
    names.add(value.name);
    return value;
  }).sort((left, right) => left.name.localeCompare(right.name));
  return {
    script: worker,
    version_id: versionId,
    bindings: normalized
  };
}

export async function readActiveWorkerBindings(client, activeVersions, targets) {
  if (!Array.isArray(activeVersions)) {
    throw new Error("Cloudflare active Worker version inventory is invalid.");
  }
  record(targets, "Maintenance binding targets");
  const d1Targets = record(targets.d1_databases, "Maintenance D1 binding targets");
  if (
    Object.keys(d1Targets).sort().join("\0") !== "MEMORY_DB\0SEARCH_DB" ||
    uuid(d1Targets.MEMORY_DB, "MEMORY_DB binding target") ===
      uuid(d1Targets.SEARCH_DB, "SEARCH_DB binding target")
  ) {
    throw new Error("Maintenance D1 binding targets are invalid.");
  }
  if (!R2_BUCKET.test(targets.backup_r2_bucket)) {
    throw new Error("Maintenance backup R2 binding target is invalid.");
  }
  return mapConcurrent(activeVersions, (activeVersion) =>
    readVersionBindings(client, activeVersion, targets)
  );
}
