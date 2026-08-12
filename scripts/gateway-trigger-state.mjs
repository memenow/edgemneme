#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  addUniqueIdentity,
  validatePaginatedListPage,
  validateSinglePageList
} from "./cloudflare-list-integrity.mjs";

export const GATEWAY_WORKER = "edgemneme-memory-gateway";

const API_ORIGIN = "https://api.cloudflare.com";
const MAX_ZONE_PAGES = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const ZONE_PAGE_SIZE = 50;

function requiredValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required gateway trigger input ${name} is missing.`);
  }
  return value.trim();
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.join(",") !== expectedKeys.join(",")) {
    throw new Error(`${label} has an unsupported shape.`);
  }
  return value;
}

function validatedHostname(value, label) {
  if (typeof value !== "string" || value !== value.trim().toLowerCase()) {
    throw new Error(`${label} is invalid.`);
  }
  let url;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (
    value.length > 253 ||
    url.hostname !== value ||
    url.host !== value ||
    url.pathname !== "/" ||
    !value.includes(".")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function validatedIdentifier(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

async function requestCloudflare(context, path, options = {}) {
  const { method = "GET", body, allowNotFound = false } = options;
  const response = await context.fetchImpl(`${API_ORIGIN}/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${context.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (allowNotFound && response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Cloudflare gateway trigger request failed with HTTP ${response.status}.`);
  }
  const envelope = await response.json();
  if (envelope?.success !== true) {
    throw new Error("The Cloudflare gateway trigger response is invalid.");
  }
  return envelope;
}

async function listAccountZones(context) {
  const zones = [];
  const zoneIds = new Set();
  const zoneNames = new Set();
  let totals;
  for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
    const query = new URLSearchParams({
      "account.id": context.accountId,
      page: String(page),
      per_page: String(ZONE_PAGE_SIZE),
      type: "full,partial,secondary,internal"
    });
    const envelope = await requestCloudflare(context, `/zones?${query.toString()}`);
    const validatedPage = validatePaginatedListPage(envelope, {
      requestedPage: page,
      requestedPerPage: ZONE_PAGE_SIZE,
      previousTotals: totals,
      label: "Cloudflare zone list"
    });
    totals = validatedPage.totals;
    for (const zone of validatedPage.items) {
      const id = validatedIdentifier(zone?.id, "Cloudflare zone ID");
      const name = validatedHostname(zone?.name, "Cloudflare zone name");
      if (zone?.account?.id !== context.accountId) {
        throw new Error("A Cloudflare zone belongs to the wrong account.");
      }
      addUniqueIdentity(zoneIds, id, "Cloudflare zone ID");
      addUniqueIdentity(zoneNames, name, "Cloudflare zone name");
      zones.push({ id, name });
    }
    if (totals.totalPages > MAX_ZONE_PAGES) {
      throw new Error("The Cloudflare zone list exceeded the supported pagination bound.");
    }
    if (page >= totals.totalPages) {
      if (zones.length !== totals.totalCount) {
        throw new Error("The Cloudflare zone list did not return its declared total.");
      }
      return zones;
    }
  }
  throw new Error("The Cloudflare zone list exceeded the supported pagination bound.");
}

async function readGatewayDomains(context) {
  const query = new URLSearchParams({ service: GATEWAY_WORKER });
  const envelope = await requestCloudflare(
    context,
    `/accounts/${encodeURIComponent(context.accountId)}/workers/domains?${query.toString()}`
  );
  const domains = validateSinglePageList(
    envelope,
    "Cloudflare custom domain list",
    { allowZeroPerPageWithUnfilteredTotals: true }
  );
  const domainIds = new Set();
  const hostnames = new Set();
  return domains.map((domain) => {
    if (domain?.service !== GATEWAY_WORKER) {
      throw new Error("A custom domain response belongs to the wrong Worker script.");
    }
    if (domain.environment !== undefined && domain.environment !== "production") {
      throw new Error("The gateway custom domain has an unsupported Worker environment.");
    }
    const id = validatedIdentifier(domain?.id, "Gateway custom domain ID");
    const hostname = validatedHostname(domain?.hostname, "Gateway custom domain hostname");
    addUniqueIdentity(domainIds, id, "Gateway custom domain ID");
    addUniqueIdentity(hostnames, hostname, "Gateway custom domain hostname");
    return {
      id,
      hostname,
      zone_id: validatedIdentifier(domain?.zone_id, "Gateway custom domain zone ID"),
      zone_name: validatedHostname(domain?.zone_name, "Gateway custom domain zone name"),
      environment: domain.environment ?? "production"
    };
  });
}

async function assertCustomDomainAvailable(context, hostname) {
  const query = new URLSearchParams({ hostname });
  const envelope = await requestCloudflare(
    context,
    `/accounts/${encodeURIComponent(context.accountId)}/workers/domains?${query.toString()}`
  );
  const domains = validateSinglePageList(
    envelope,
    "Cloudflare custom domain ownership list",
    { allowZeroPerPageWithUnfilteredTotals: true }
  );
  const domainIds = new Set();
  const hostnames = new Set();
  for (const domain of domains) {
    addUniqueIdentity(
      domainIds,
      validatedIdentifier(domain?.id, "Custom domain ownership ID"),
      "Custom domain ownership ID"
    );
    const observedHostname = validatedHostname(
      domain?.hostname,
      "Custom domain ownership hostname"
    );
    addUniqueIdentity(hostnames, observedHostname, "Custom domain ownership hostname");
    if (observedHostname !== hostname) {
      throw new Error("The custom domain ownership response contains the wrong hostname.");
    }
    if (domain?.service !== GATEWAY_WORKER) {
      throw new Error("The captured custom domain is now owned by another Worker script.");
    }
  }
}

async function readGatewayRoutes(context, zones) {
  const routes = [];
  for (const zone of zones) {
    const envelope = await requestCloudflare(
      context,
      `/zones/${encodeURIComponent(zone.id)}/workers/routes`
    );
    const zoneRoutes = validateSinglePageList(envelope, "Cloudflare Worker route list");
    const routeIds = new Set();
    const routePatterns = new Set();
    for (const route of zoneRoutes) {
      const id = validatedIdentifier(route?.id, "Worker route ID");
      const pattern = validatedIdentifier(route?.pattern, "Worker route pattern");
      if (route?.script !== undefined && typeof route.script !== "string") {
        throw new Error("A Cloudflare Worker route script is invalid.");
      }
      addUniqueIdentity(routeIds, id, "Worker route ID");
      addUniqueIdentity(routePatterns, pattern, "Worker route pattern");
      if (route.script !== GATEWAY_WORKER) {
        continue;
      }
      routes.push({
        id,
        pattern,
        zone_id: zone.id,
        zone_name: zone.name
      });
    }
  }
  return routes;
}

async function readWorkerSubdomain(context) {
  const envelope = await requestCloudflare(
    context,
    `/accounts/${encodeURIComponent(context.accountId)}/workers/scripts/${GATEWAY_WORKER}/subdomain`,
    { allowNotFound: true }
  );
  if (envelope === undefined) {
    return null;
  }
  if (
    typeof envelope?.result?.enabled !== "boolean" ||
    typeof envelope?.result?.previews_enabled !== "boolean"
  ) {
    throw new Error("The gateway workers.dev response is invalid.");
  }
  return {
    enabled: envelope.result.enabled,
    previews_enabled: envelope.result.previews_enabled
  };
}

async function readAccountSubdomain(context) {
  const envelope = await requestCloudflare(
    context,
    `/accounts/${encodeURIComponent(context.accountId)}/workers/subdomain`
  );
  return validatedHostname(
    `${validatedIdentifier(envelope?.result?.subdomain, "Workers account subdomain")}.workers.dev`,
    "Workers account hostname"
  );
}

function publicState(observed) {
  return {
    schema: 1,
    script: GATEWAY_WORKER,
    worker_present: observed.workersDev !== null,
    workers_dev: observed.workersDev,
    custom_domains: observed.domains
      .map(({ hostname, zone_id, zone_name, environment }) => ({
        hostname,
        zone_id,
        zone_name,
        environment
      }))
      .sort((left, right) => left.hostname.localeCompare(right.hostname)),
    routes: observed.routes
      .map(({ pattern, zone_id, zone_name }) => ({ pattern, zone_id, zone_name }))
      .sort((left, right) =>
        `${left.zone_id}\0${left.pattern}`.localeCompare(`${right.zone_id}\0${right.pattern}`)
      )
  };
}

export function assertSupportedGatewayTriggerState(state) {
  exactObject(
    state,
    ["schema", "script", "worker_present", "workers_dev", "custom_domains", "routes"],
    "Gateway trigger state"
  );
  if (
    state.schema !== 1 || state.script !== GATEWAY_WORKER ||
    typeof state.worker_present !== "boolean"
  ) {
    throw new Error("The gateway trigger state identity is invalid.");
  }
  if (!Array.isArray(state.custom_domains) || !Array.isArray(state.routes)) {
    throw new Error("The gateway trigger state collections are invalid.");
  }
  if (state.routes.length !== 0) {
    throw new Error("Zone routes are not supported for the production gateway.");
  }
  if (!state.worker_present) {
    if (state.workers_dev !== null || state.custom_domains.length !== 0) {
      throw new Error("An absent gateway has residual trigger resources.");
    }
    return { mode: "absent", endpoint: null, host: null };
  }
  exactObject(state.workers_dev, ["enabled", "previews_enabled"], "Gateway workers.dev state");
  if (
    typeof state.workers_dev.enabled !== "boolean" ||
    state.workers_dev.previews_enabled !== false
  ) {
    throw new Error("The gateway workers.dev state is unsupported.");
  }
  for (const domain of state.custom_domains) {
    exactObject(
      domain,
      ["hostname", "zone_id", "zone_name", "environment"],
      "Gateway custom domain state"
    );
    validatedHostname(domain.hostname, "Gateway custom domain hostname");
    validatedIdentifier(domain.zone_id, "Gateway custom domain zone ID");
    validatedHostname(domain.zone_name, "Gateway custom domain zone name");
    if (domain.environment !== "production") {
      throw new Error("The gateway custom domain environment is unsupported.");
    }
  }
  if (state.workers_dev.enabled) {
    if (state.custom_domains.length !== 0) {
      throw new Error("The gateway cannot expose workers.dev and a custom domain together.");
    }
    return { mode: "workers_dev", endpoint: undefined, host: undefined };
  }
  if (state.custom_domains.length !== 1) {
    throw new Error("The production gateway must expose exactly one custom domain.");
  }
  const host = state.custom_domains[0].hostname;
  return { mode: "custom_domain", endpoint: `https://${host}/mcp`, host };
}

function isDetachedAbsentGatewayTriggerState(state) {
  return (
    state?.schema === 1 &&
    state.script === GATEWAY_WORKER &&
    state.worker_present === true &&
    state.workers_dev?.enabled === false &&
    state.workers_dev?.previews_enabled === false &&
    Array.isArray(state.custom_domains) &&
    state.custom_domains.length === 0 &&
    Array.isArray(state.routes) &&
    state.routes.length === 0
  );
}

export function encodeGatewayTriggerState(state) {
  assertSupportedGatewayTriggerState(state);
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function decodeGatewayTriggerState(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("The encoded gateway trigger state is invalid.");
  }
  let state;
  try {
    state = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("The encoded gateway trigger state is invalid.");
  }
  assertSupportedGatewayTriggerState(state);
  if (encodeGatewayTriggerState(state) !== value) {
    throw new Error("The encoded gateway trigger state is not canonical.");
  }
  return state;
}

export const gatewayTriggerFingerprint = (state) =>
  createHash("sha256").update(encodeGatewayTriggerState(state)).digest("hex");

async function observeGatewayTriggerResources(environment, fetchImpl, requireSupported) {
  const context = {
    accountId: requiredValue(environment, "CLOUDFLARE_ACCOUNT_ID"),
    token: requiredValue(environment, "CLOUDFLARE_API_TOKEN"),
    fetchImpl
  };
  const [zones, domains, workersDev] = await Promise.all([
    listAccountZones(context),
    readGatewayDomains(context),
    readWorkerSubdomain(context)
  ]);
  const routes = await readGatewayRoutes(context, zones);
  const observed = { context, domains, routes, workersDev };
  const state = publicState(observed);
  const rawEncoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const rawFingerprint = createHash("sha256").update(rawEncoded).digest("hex");
  const target = requireSupported
    ? assertSupportedGatewayTriggerState(state)
    : { mode: "unknown", endpoint: undefined, host: undefined };
  if (requireSupported && target.mode === "workers_dev") {
    const accountHostname = await readAccountSubdomain(context);
    target.host = `${GATEWAY_WORKER}.${accountHostname}`;
    target.endpoint = `https://${target.host}/mcp`;
  }
  return {
    state,
    rawEncoded,
    rawFingerprint,
    encoded: requireSupported ? encodeGatewayTriggerState(state) : undefined,
    fingerprint: requireSupported ? gatewayTriggerFingerprint(state) : undefined,
    endpoint: target.endpoint,
    host: target.host,
    resources: observed
  };
}

export async function observeGatewayTriggerState(environment = process.env, fetchImpl = fetch) {
  return observeGatewayTriggerResources(environment, fetchImpl, true);
}

export function desiredGatewayTriggerFromConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("The rendered gateway config is invalid.");
  }
  if (config.name !== GATEWAY_WORKER || config.preview_urls !== false) {
    throw new Error("The rendered gateway config has the wrong script or preview contract.");
  }
  const routes = config.routes ?? [];
  if (!Array.isArray(routes)) {
    throw new Error("The rendered gateway route contract is invalid.");
  }
  if (config.workers_dev === true && routes.length === 0) {
    return { mode: "workers_dev", hostname: null };
  }
  if (config.workers_dev !== false || routes.length !== 1) {
    throw new Error("The rendered gateway trigger contract is unsupported.");
  }
  const route = exactObject(routes[0], ["pattern", "custom_domain"], "Gateway custom domain route");
  if (route.custom_domain !== true) {
    throw new Error("The rendered gateway route is not a custom domain.");
  }
  return {
    mode: "custom_domain",
    hostname: validatedHostname(route.pattern, "Rendered gateway custom domain")
  };
}

export function readGatewayConfig(configPath) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("Unable to parse the rendered gateway config.");
  }
  return config;
}

export function assertGatewayConfigMatchesState(config, state) {
  const desired = desiredGatewayTriggerFromConfig(config);
  const target = assertSupportedGatewayTriggerState(state);
  if (
    desired.mode !== target.mode ||
    (desired.mode === "custom_domain" && desired.hostname !== target.host)
  ) {
    throw new Error("The rendered gateway trigger differs from the verified remote trigger.");
  }
  return target;
}

async function deleteResource(context, path) {
  await requestCloudflare(context, path, { method: "DELETE", allowNotFound: true });
}

export async function restoreGatewayTriggerState(
  expectedEncodedState,
  environment = process.env,
  fetchImpl = fetch,
  options = {}
) {
  const expected = decodeGatewayTriggerState(expectedEncodedState);
  if (typeof options.gatewayAdvancedByRun !== "boolean") {
    throw new Error("Gateway trigger restore ownership proof is missing.");
  }
  if (
    typeof options.expectedCurrentEncodedState !== "string" ||
    options.expectedCurrentEncodedState === ""
  ) {
    throw new Error("Expected-current gateway trigger state is missing.");
  }
  if (
    typeof options.expectedCurrentFingerprint !== "string" ||
    options.expectedCurrentFingerprint === ""
  ) {
    throw new Error("Expected-current gateway trigger fingerprint is missing.");
  }
  const expectedCurrentEncodedState = options.expectedCurrentEncodedState;
  const expectedCurrent = decodeGatewayTriggerState(expectedCurrentEncodedState);
  const expectedCurrentFingerprint = options.expectedCurrentFingerprint;
  if (gatewayTriggerFingerprint(expectedCurrent) !== expectedCurrentFingerprint) {
    throw new Error("The expected-current gateway trigger fingerprint is invalid.");
  }
  if (
    !options.gatewayAdvancedByRun &&
    expectedCurrentEncodedState !== expectedEncodedState
  ) {
    throw new Error(
      "Gateway trigger target drift requires proof that this run advanced the gateway."
    );
  }
  const allowDetachedAbsent = options.allowDetachedAbsent === true;
  if (
    options.allowDetachedAbsent !== undefined &&
    typeof options.allowDetachedAbsent !== "boolean"
  ) {
    throw new Error("The detached gateway restore option is invalid.");
  }
  if (allowDetachedAbsent && (!options.gatewayAdvancedByRun || expected.worker_present)) {
    throw new Error("Detached gateway restore is allowed only for an advanced bootstrap.");
  }
  const current = await observeGatewayTriggerResources(environment, fetchImpl, false);
  if (
    (
      current.rawEncoded !== expectedCurrentEncodedState ||
      current.rawFingerprint !== expectedCurrentFingerprint
    )
  ) {
    throw new Error(
      "The current gateway trigger is not owned by this deployment run; refusing restore."
    );
  }
  const context = current.resources.context;
  const expectedDomain = expected.custom_domains[0];
  const expectedDomainPresent =
    expectedDomain !== undefined &&
    current.resources.domains.some(
      (domain) =>
        domain.hostname === expectedDomain.hostname && domain.zone_id === expectedDomain.zone_id
    );
  if (
    current.rawEncoded === expectedEncodedState
  ) {
    return observeGatewayTriggerState(environment, fetchImpl);
  }
  if (expectedDomain !== undefined && !expectedDomainPresent) {
    await assertCustomDomainAvailable(context, expectedDomain.hostname);
  }

  for (const route of current.resources.routes) {
    await deleteResource(
      context,
      `/zones/${encodeURIComponent(route.zone_id)}/workers/routes/${encodeURIComponent(route.id)}`
    );
  }
  for (const domain of current.resources.domains) {
    if (
      expectedDomain === undefined ||
      domain.hostname !== expectedDomain.hostname ||
      domain.zone_id !== expectedDomain.zone_id
    ) {
      await deleteResource(
        context,
        `/accounts/${encodeURIComponent(context.accountId)}/workers/domains/${encodeURIComponent(domain.id)}`
      );
    }
  }
  const subdomainPath =
    `/accounts/${encodeURIComponent(context.accountId)}/workers/scripts/${GATEWAY_WORKER}/subdomain`;
  if (expected.workers_dev === null) {
    if (current.resources.workersDev !== null) {
      await deleteResource(context, subdomainPath);
    }
  } else {
    await requestCloudflare(context, subdomainPath, {
      method: "POST",
      body: expected.workers_dev
    });
  }
  if (
    expectedDomain !== undefined &&
    !expectedDomainPresent
  ) {
    await requestCloudflare(
      context,
      `/accounts/${encodeURIComponent(context.accountId)}/workers/domains`,
      {
        method: "PUT",
        body: {
          hostname: expectedDomain.hostname,
          service: GATEWAY_WORKER,
          zone_id: expectedDomain.zone_id,
          zone_name: expectedDomain.zone_name
        }
      }
    );
  }

  const restored = await observeGatewayTriggerResources(environment, fetchImpl, false);
  if (restored.rawEncoded === expectedEncodedState) {
    return observeGatewayTriggerState(environment, fetchImpl);
  }
  if (allowDetachedAbsent && isDetachedAbsentGatewayTriggerState(restored.state)) {
    return restored;
  }
  throw new Error("The gateway trigger state was not restored exactly.");
}
