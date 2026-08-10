#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createD1RestRuntime } from "./github-sync-quiescence-runtime.mjs";
import {
  finishBoundRepositoryRuns,
  finishUnboundRepositoryRuns,
  QUIESCENCE_BATCH_LIMIT,
  rejectUnboundDispatchItems,
  verifyD1ParameterCompatibility,
  verifyQuiescenceSchema
} from "./github-sync-quiescence-sql.mjs";
import {
  closeInactiveDispatches,
  releaseInactiveCredentialLanes
} from "./github-sync-quiescence-terminal.mjs";

const VERSION = /^(?:absent|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
export const QUIESCENCE_PHASE_STATEMENT_BUDGETS = Object.freeze({
  schema: 1,
  compatibility: 1,
  items: 1 + (2 * QUIESCENCE_BATCH_LIMIT) + QUIESCENCE_BATCH_LIMIT,
  boundRuns: 1 + (3 * QUIESCENCE_BATCH_LIMIT) + QUIESCENCE_BATCH_LIMIT,
  unboundRuns: 1 + QUIESCENCE_BATCH_LIMIT + QUIESCENCE_BATCH_LIMIT,
  dispatches: 2 + QUIESCENCE_BATCH_LIMIT + QUIESCENCE_BATCH_LIMIT,
  lanes: 1 + (2 * QUIESCENCE_BATCH_LIMIT) + QUIESCENCE_BATCH_LIMIT
});
export const MAX_QUIESCENCE_QUERY_STATEMENTS = Object.values(
  QUIESCENCE_PHASE_STATEMENT_BUDGETS
).reduce((total, count) => total + count, 0);
export const QUIESCENCE_PHASE_HTTP_REQUEST_BUDGETS = Object.freeze({
  schema: 1,
  compatibility: 1,
  items: 3,
  boundRuns: 3,
  unboundRuns: 3,
  dispatches: 4,
  lanes: 3
});
export const MAX_QUIESCENCE_HTTP_REQUESTS = Object.values(
  QUIESCENCE_PHASE_HTTP_REQUEST_BUDGETS
).reduce((total, count) => total + count, 0);

export async function reconcileGitHubSyncQuiescence(options, runtime) {
  const normalized = normalizeOptions(options);
  const database = runtime ?? createD1RestRuntime(normalized.config);
  const schemaState = await verifyQuiescenceSchema(database);
  if (schemaState === "absent") {
    return {
      reconciliationState: "clear",
      schemaState,
      items: 0,
      boundRuns: 0,
      unboundRuns: 0,
      dispatches: 0,
      lanes: 0
    };
  }
  await verifyD1ParameterCompatibility(database);
  const quiescenceNow = normalized.quiescenceNow;
  const items = await rejectUnboundDispatchItems(database, quiescenceNow);
  const boundRuns = await finishBoundRepositoryRuns(database, quiescenceNow);
  const unboundRuns = await finishUnboundRepositoryRuns(database, quiescenceNow);
  const dispatches = await closeInactiveDispatches(database, quiescenceNow);
  const lanes = await releaseInactiveCredentialLanes(database, quiescenceNow);
  const changed = items + boundRuns + unboundRuns + dispatches + lanes;
  return {
    reconciliationState: changed === 0 ? "clear" : "pending",
    schemaState,
    items,
    boundRuns,
    unboundRuns,
    dispatches,
    lanes
  };
}

function normalizeOptions(options) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("GitHub sync quiescence options are invalid.");
  }
  const config = String(options.config ?? "");
  const disabledVersion = String(options.disabledVersion ?? "");
  if (!VERSION.test(disabledVersion)) {
    throw new Error("The disabled GitHub sync version is invalid.");
  }
  if (options.scheduleState !== "clear" || options.workflowState !== "clear") {
    throw new Error("GitHub sync control-plane quiescence was not proven.");
  }
  const quiescenceNow = options.quiescenceNow ?? new Date().toISOString();
  const parsed = typeof quiescenceNow === "string" ? new Date(quiescenceNow) : null;
  if (
    parsed === null || !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== quiescenceNow
  ) {
    throw new Error("The GitHub sync quiescence time is invalid.");
  }
  return { config, disabledVersion, quiescenceNow };
}

function parseCli(argv) {
  if (argv[0] !== "reconcile") {
    throw new Error(
      "Usage: github-sync-quiescence.mjs reconcile --config PATH " +
      "--disabled-version VERSION --schedule-state clear --workflow-state clear"
    );
  }
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error("The GitHub sync quiescence command arguments are invalid.");
    }
    values.set(name, value);
  }
  const allowed = new Set([
    "--config",
    "--disabled-version",
    "--schedule-state",
    "--workflow-state"
  ]);
  if (values.size !== allowed.size || [...values.keys()].some((name) => !allowed.has(name))) {
    throw new Error("The GitHub sync quiescence command arguments are incomplete.");
  }
  return {
    config: values.get("--config"),
    disabledVersion: values.get("--disabled-version"),
    scheduleState: values.get("--schedule-state"),
    workflowState: values.get("--workflow-state")
  };
}

async function main() {
  try {
    const result = await reconcileGitHubSyncQuiescence(parseCli(process.argv.slice(2)));
    process.stdout.write(result.reconciliationState);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "GitHub sync D1 quiescence failed."}\n`
    );
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) await main();
