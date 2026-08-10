import {
  createCloudflareMaintenanceClient,
  requirePage
} from "./d1-maintenance-cloudflare-client.mjs";
import {
  maintenanceBindingTargets,
  readActiveWorkerBindings,
  readActiveWorkerVersions
} from "./d1-maintenance-worker-bindings.mjs";

export const CORE_WORKERS = Object.freeze([
  "edgemneme-github-sync",
  "edgemneme-memory-gateway",
  "edgemneme-memory-orchestrator"
]);

export const NONTERMINAL_WORKFLOW_STATUSES = Object.freeze([
  "queued",
  "running",
  "paused",
  "waitingForPause",
  "waiting",
  "rollingBack"
]);

const GATEWAY = "edgemneme-memory-gateway";
const ORCHESTRATOR = "edgemneme-memory-orchestrator";
const MAIN_QUEUE = "edgemneme-memory-events";
const DLQ = "edgemneme-memory-events-dlq";
const MAX_PAGES = 100;
const MAX_WORKERS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const WORKFLOW_CONTRACTS = Object.freeze([
  ["edgemneme-memory-workflow", "MemoryWorkflow", ORCHESTRATOR],
  ["edgemneme-github-dispatch-workflow", "GitHubDispatchWorkflow", "edgemneme-github-sync"],
  ["edgemneme-github-ref-sync-workflow", "GitHubRefSyncWorkflow", "edgemneme-github-sync"],
  ["edgemneme-github-retention-workflow", "GitHubRetentionWorkflow", "edgemneme-github-sync"]
]);

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

function exactBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}

async function listPaged(client, path, label, perPage = 100) {
  const rows = [];
  const identities = new Set();
  let expectedTotal;
  let expectedPages;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const envelope = await client.get(
      `${path}${separator}page=${page}&per_page=${perPage}`,
      { label }
    );
    const current = requirePage(envelope, page, perPage, label);
    expectedTotal ??= current.info.total_count;
    expectedPages ??= current.info.total_pages;
    if (
      current.info.total_count !== expectedTotal ||
      current.info.total_pages !== expectedPages
    ) {
      throw new Error(`${label} changed while pagination was in progress.`);
    }
    for (const row of current.rows) {
      const id = identifier(row?.id ?? row?.queue_id, `${label} identity`);
      if (identities.has(id)) throw new Error(`${label} contains a duplicate identity.`);
      identities.add(id);
      rows.push(row);
    }
    if (page >= Math.max(1, expectedPages)) break;
    if (page === MAX_PAGES) throw new Error(`${label} exceeded its pagination bound.`);
  }
  if (rows.length !== expectedTotal) throw new Error(`${label} returned an incomplete inventory.`);
  return rows;
}

async function listWorkers(client) {
  const envelope = await client.get(client.accountPath("/workers/scripts"), {
    label: "Cloudflare Worker inventory"
  });
  if (!Array.isArray(envelope.result)) {
    throw new Error("Cloudflare Worker inventory is invalid.");
  }
  if (envelope.result.length > MAX_WORKERS) {
    throw new Error("Cloudflare Worker inventory exceeds the maintenance admission bound.");
  }
  const names = new Set();
  return envelope.result.map((worker) => {
    const name = identifier(worker?.id, "Cloudflare Worker script name");
    if (names.has(name)) throw new Error("Cloudflare Worker inventory has a duplicate script.");
    names.add(name);
    return {
      name,
      etag: optionalString(worker?.etag, "Cloudflare Worker etag"),
      modified_on: optionalString(worker?.modified_on, "Cloudflare Worker modified timestamp"),
      tag: optionalString(worker?.tag, "Cloudflare Worker tag")
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

async function readSchedules(client, worker, present) {
  const envelope = await client.get(
    client.accountPath(`/workers/scripts/${encodeURIComponent(worker)}/schedules`),
    { allowNotFound: !present, label: `${worker} schedule query` }
  );
  if (envelope === undefined) return [];
  if (!present) throw new Error(`${worker} schedule endpoint appeared without a Worker.`);
  const schedules = envelope?.result?.schedules;
  if (!Array.isArray(schedules)) throw new Error(`${worker} schedules are invalid.`);
  return schedules.map((schedule) => identifier(schedule?.cron, `${worker} Cron expression`)).sort();
}

async function readGatewayIngress(client, gatewayPresent) {
  const domainsUrl = new URL(
    `https://placeholder${client.accountPath("/workers/domains")}`
  );
  domainsUrl.searchParams.set("service", GATEWAY);
  const domainEnvelope = await client.get(`${domainsUrl.pathname}${domainsUrl.search}`, {
    label: "Gateway custom domain query"
  });
  const domains = domainEnvelope.result;
  const domainInfo = domainEnvelope.result_info;
  if (
    !Array.isArray(domains) ||
    !Number.isSafeInteger(domainInfo?.count) ||
    domainInfo.count !== domains.length ||
    !Number.isSafeInteger(domainInfo?.total_count) ||
    domainInfo.total_count !== domains.length ||
    !Number.isSafeInteger(domainInfo?.total_pages) ||
    ![0, 1].includes(domainInfo.total_pages)
  ) {
    throw new Error("Gateway custom domain inventory is incomplete.");
  }
  const normalizedDomains = domains.map((domain) => {
    if (domain?.service !== GATEWAY) throw new Error("Gateway domain query returned another Worker.");
    return identifier(domain?.hostname, "Gateway custom domain hostname");
  }).sort();

  const zones = await listPaged(client, "/zones?account.id=" + encodeURIComponent(client.accountId), "Cloudflare zone inventory", 50);
  const routes = [];
  for (const zone of zones) {
    const zoneId = identifier(zone?.id, "Cloudflare zone ID");
    const envelope = await client.get(`/zones/${encodeURIComponent(zoneId)}/workers/routes`, {
      label: "Cloudflare Worker route query"
    });
    if (!Array.isArray(envelope.result)) throw new Error("Cloudflare Worker routes are invalid.");
    const ids = new Set();
    for (const route of envelope.result) {
      const id = identifier(route?.id, "Cloudflare Worker route ID");
      if (ids.has(id)) throw new Error("Cloudflare Worker routes contain a duplicate ID.");
      ids.add(id);
      if (route?.script !== undefined && route.script !== null) {
        identifier(route.script, "Cloudflare Worker route script");
      }
      if (route?.script === GATEWAY) {
        routes.push({ zone_id: zoneId, id, pattern: identifier(route?.pattern, "Gateway route") });
      }
    }
  }
  routes.sort((left, right) => `${left.zone_id}\0${left.id}`.localeCompare(`${right.zone_id}\0${right.id}`));

  const subdomainEnvelope = await client.get(
    client.accountPath(`/workers/scripts/${GATEWAY}/subdomain`),
    { allowNotFound: !gatewayPresent, label: "Gateway workers.dev query" }
  );
  if (subdomainEnvelope === undefined) {
    return { workers_dev: null, custom_domains: normalizedDomains, routes };
  }
  if (!gatewayPresent) throw new Error("Gateway workers.dev appeared without a Worker inventory entry.");
  return {
    workers_dev: {
      enabled: exactBoolean(subdomainEnvelope?.result?.enabled, "Gateway workers.dev state"),
      previews_enabled: exactBoolean(
        subdomainEnvelope?.result?.previews_enabled,
        "Gateway preview URL state"
      )
    },
    custom_domains: normalizedDomains,
    routes
  };
}

function parseConsumer(consumer, queueName, ids) {
  const id = identifier(consumer?.consumer_id, `${queueName} consumer ID`);
  if (ids.has(id)) throw new Error(`${queueName} contains a duplicate consumer.`);
  ids.add(id);
  if (!["worker", "http_pull"].includes(consumer?.type)) {
    throw new Error(`${queueName} contains an unknown consumer type.`);
  }
  return {
    id,
    type: consumer.type,
    script: consumer.type === "worker"
      ? identifier(consumer?.script_name, `${queueName} consumer script`)
      : null
  };
}

async function readQueues(client) {
  const rows = await listPaged(client, client.accountPath("/queues"), "Cloudflare Queue inventory");
  const names = new Set();
  const queues = [];
  for (const queue of rows) {
    const id = identifier(queue?.queue_id, "Cloudflare Queue ID");
    const name = identifier(queue?.queue_name, "Cloudflare Queue name");
    if (names.has(name)) throw new Error("Cloudflare Queue inventory has a duplicate name.");
    names.add(name);
    if (!Number.isSafeInteger(queue?.consumers_total_count) || queue.consumers_total_count < 0) {
      throw new Error(`${name} has an invalid consumer count.`);
    }
    if (
      !Number.isSafeInteger(queue?.producers_total_count) ||
      queue.producers_total_count < 0 ||
      !Array.isArray(queue?.producers) ||
      queue.producers.length !== queue.producers_total_count
    ) {
      throw new Error(`${name} producer inventory is incomplete.`);
    }
    const producers = queue.producers.map((producer) => {
      if (producer?.type === "worker") {
        return { type: "worker", source: identifier(producer?.script, `${name} producer script`) };
      }
      if (producer?.type === "r2_bucket") {
        return {
          type: "r2_bucket",
          source: identifier(producer?.bucket_name, `${name} producer bucket`)
        };
      }
      throw new Error(`${name} contains an unknown producer type.`);
    });
    const envelope = await client.get(
      client.accountPath(`/queues/${encodeURIComponent(id)}/consumers`),
      { label: `${name} consumer query` }
    );
    if (!Array.isArray(envelope.result) || envelope.result.length !== queue.consumers_total_count) {
      throw new Error(`${name} consumer inventory is incomplete.`);
    }
    const consumerIds = new Set();
    const consumers = envelope.result.map((consumer) => parseConsumer(consumer, name, consumerIds));
    let metrics = null;
    if (name === MAIN_QUEUE || name === DLQ) {
      const metricsEnvelope = await client.get(
        client.accountPath(`/queues/${encodeURIComponent(id)}/metrics`),
        { label: `${name} approximate metrics query` }
      );
      const result = metricsEnvelope.result;
      metrics = {};
      for (const field of ["backlog_bytes", "backlog_count", "oldest_message_timestamp_ms"]) {
        if (!Number.isSafeInteger(result?.[field]) || result[field] < 0) {
          throw new Error(`${name} returned invalid approximate metrics.`);
        }
        metrics[field] = result[field];
      }
    }
    queues.push({ id, name, consumers, producers, metrics });
  }
  return queues.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeWorkflow(workflow, expected) {
  const [name, className, scriptName] = expected;
  if (
    workflow?.name !== name ||
    workflow?.class_name !== className ||
    workflow?.script_name !== scriptName ||
    typeof workflow?.id !== "string" ||
    !UUID.test(workflow.id)
  ) {
    throw new Error(`${name} does not match its approved Workflow contract.`);
  }
  if (workflow.schedules !== undefined && !Array.isArray(workflow.schedules)) {
    throw new Error(`${name} has an invalid schedule inventory.`);
  }
  if ((workflow.schedules ?? []).length !== 0) {
    throw new Error(`${name} still has a Workflow schedule.`);
  }
  return {
    id: workflow.id.toLowerCase(),
    name,
    class_name: className,
    script_name: scriptName,
    modified_on: optionalString(workflow.modified_on, `${name} modified timestamp`),
    schedules: (workflow.schedules ?? []).map((entry) => JSON.stringify(entry)).sort()
  };
}

export async function scanWorkflowInstances(client, definition) {
  const instances = [];
  const instanceIds = new Set();
  for (const status of NONTERMINAL_WORKFLOW_STATUSES) {
    let cursor;
    const cursors = new Set();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ status, direction: "asc", per_page: "100" });
      if (cursor !== undefined) query.set("cursor", cursor);
      const envelope = await client.get(
        client.accountPath(`/workflows/${encodeURIComponent(definition.name)}/instances?${query}`),
        { label: `${definition.name} ${status} instance query` }
      );
      if (!Array.isArray(envelope.result)) throw new Error("Workflow instance page is invalid.");
      if (
        !Number.isSafeInteger(envelope.result_info?.count) ||
        envelope.result_info.count !== envelope.result.length
      ) {
        throw new Error("Workflow instance page count is invalid.");
      }
      for (const instance of envelope.result) {
        const id = identifier(instance?.id, "Workflow instance ID", 1_024);
        if (
          instanceIds.has(id) ||
          instance?.status !== status ||
          instance?.workflow_id !== definition.id ||
          typeof instance?.version_id !== "string" ||
          !UUID.test(instance.version_id)
        ) {
          throw new Error("A nonterminal Workflow instance is invalid, duplicated, or drifting.");
        }
        instanceIds.add(id);
        instances.push({ id, status, version_id: instance.version_id.toLowerCase() });
      }
      const next = envelope?.result_info?.cursor;
      if (next === undefined || next === null || next === "") break;
      if (typeof next !== "string" || next.length > 4_096 || cursors.has(next)) {
        throw new Error("Workflow instance cursor is invalid or repeated.");
      }
      cursors.add(next);
      cursor = next;
      if (page === MAX_PAGES - 1) throw new Error("Workflow instance pagination exceeded its bound.");
    }
  }
  return instances.sort((left, right) => left.id.localeCompare(right.id));
}

async function readWorkflows(client) {
  const rows = await listPaged(client, client.accountPath("/workflows"), "Cloudflare Workflow inventory");
  const byName = new Map();
  for (const workflow of rows) {
    const name = identifier(workflow?.name, "Cloudflare Workflow name");
    if (byName.has(name)) throw new Error("Cloudflare Workflow inventory has a duplicate name.");
    byName.set(name, workflow);
  }
  const relevant = [];
  for (const expected of WORKFLOW_CONTRACTS) {
    const inventory = byName.get(expected[0]);
    if (inventory === undefined) continue;
    const firstEnvelope = await client.get(
      client.accountPath(`/workflows/${encodeURIComponent(expected[0])}`),
      { label: `${expected[0]} definition query` }
    );
    const first = normalizeWorkflow(firstEnvelope.result, expected);
    const listed = normalizeWorkflow(inventory, expected);
    if (first.id !== listed.id) {
      throw new Error(`${expected[0]} definition differs from its inventory entry.`);
    }
    const instances = await scanWorkflowInstances(client, first);
    const secondEnvelope = await client.get(
      client.accountPath(`/workflows/${encodeURIComponent(expected[0])}`),
      { label: `${expected[0]} definition revalidation` }
    );
    if (JSON.stringify(first) !== JSON.stringify(normalizeWorkflow(secondEnvelope.result, expected))) {
      throw new Error(`${expected[0]} changed while its instances were enumerated.`);
    }
    relevant.push({ ...first, nonterminal_instances: instances });
  }
  const approvedNames = new Set(WORKFLOW_CONTRACTS.map(([name]) => name));
  for (const workflow of rows) {
    if (CORE_WORKERS.includes(workflow?.script_name) && !approvedNames.has(workflow?.name)) {
      throw new Error("A core Worker owns an unknown Workflow definition.");
    }
  }
  return relevant.sort((left, right) => left.name.localeCompare(right.name));
}

export async function observeCloudflareMaintenance(
  environment = process.env,
  fetchImpl = fetch,
  configPath = "wrangler/.wrangler/memory-orchestrator.generated.jsonc"
) {
  const client = createCloudflareMaintenanceClient(environment, fetchImpl);
  const bindingTargets = maintenanceBindingTargets(configPath, environment);
  const workersBefore = await listWorkers(client);
  const versionsBefore = await readActiveWorkerVersions(client, workersBefore);
  const workerBindings = await readActiveWorkerBindings(client, versionsBefore, bindingTargets);
  const activeVersions = new Map(versionsBefore.map(({ name, version_id: versionId }) => [
    name,
    versionId
  ]));
  const coreVersions = Object.fromEntries(CORE_WORKERS.map((worker) => [
    worker,
    activeVersions.get(worker) ?? "absent"
  ]));
  const present = new Set(workersBefore.map(({ name }) => name));
  const [gatewayIngress, orchestratorCrons, githubCrons, queues, workflows] =
    await Promise.all([
      readGatewayIngress(client, present.has(GATEWAY)),
      readSchedules(client, ORCHESTRATOR, present.has(ORCHESTRATOR)),
      readSchedules(client, "edgemneme-github-sync", present.has("edgemneme-github-sync")),
      readQueues(client),
      readWorkflows(client)
    ]);
  const workersAfter = await listWorkers(client);
  const versionsAfter = await readActiveWorkerVersions(client, workersAfter);
  if (
    JSON.stringify(workersBefore) !== JSON.stringify(workersAfter) ||
    JSON.stringify(versionsBefore) !== JSON.stringify(versionsAfter)
  ) {
    throw new Error("Cloudflare Worker inventory or active versions changed during observation.");
  }
  return Object.freeze({
    workers: workersBefore,
    core_versions: Object.freeze(coreVersions),
    binding_targets: bindingTargets,
    worker_bindings: workerBindings,
    gateway_ingress: gatewayIngress,
    schedules: Object.freeze({
      [ORCHESTRATOR]: orchestratorCrons,
      "edgemneme-github-sync": githubCrons
    }),
    queues,
    workflows
  });
}
