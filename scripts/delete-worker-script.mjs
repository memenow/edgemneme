#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const ALLOWED_WORKER_NAMES = new Set([
  "edgemneme-github-sync",
  "edgemneme-memory-gateway"
]);

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required deployment input ${name} is missing.`);
  }
  return value.trim();
}

function allowedWorkerName(workerName) {
  if (typeof workerName !== "string" || !ALLOWED_WORKER_NAMES.has(workerName)) {
    throw new Error(
      "Worker name must be exactly edgemneme-memory-gateway or edgemneme-github-sync."
    );
  }
  return workerName;
}

function requestInit(token, method) {
  return {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  };
}

async function responseConfirmsDeletion(response) {
  if (response.status === 404) {
    return true;
  }
  if (!response.ok) {
    return false;
  }
  let body;
  try {
    body = await response.text();
  } catch {
    return false;
  }
  if (body.trim() === "") {
    return true;
  }
  try {
    return JSON.parse(body)?.success === true;
  } catch {
    return false;
  }
}

async function deploymentsAreAbsent(deploymentsUrl, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(deploymentsUrl, requestInit(token, "GET"));
  } catch {
    return false;
  }
  return response.status === 404;
}

export async function deleteWorkerScript(
  workerName,
  environment = process.env,
  fetchImpl = fetch
) {
  const exactWorkerName = allowedWorkerName(workerName);
  const accountId = requiredEnvironmentValue(environment, "CLOUDFLARE_ACCOUNT_ID");
  const token = requiredEnvironmentValue(environment, "CLOUDFLARE_API_TOKEN");
  const workerPath =
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/` +
    encodeURIComponent(exactWorkerName);
  const deleteUrl = `${API_ORIGIN}${workerPath}`;
  const deploymentsUrl = `${API_ORIGIN}${workerPath}/deployments`;

  let deleteResponse;
  try {
    deleteResponse = await fetchImpl(deleteUrl, requestInit(token, "DELETE"));
  } catch {
    deleteResponse = undefined;
  }

  if (deleteResponse !== undefined && await responseConfirmsDeletion(deleteResponse)) {
    return { workerName: exactWorkerName, state: "absent" };
  }

  if (await deploymentsAreAbsent(deploymentsUrl, token, fetchImpl)) {
    return { workerName: exactWorkerName, state: "absent" };
  }

  throw new Error(
    `Cloudflare Worker ${exactWorkerName} deletion could not be confirmed; refusing to continue.`
  );
}

async function main() {
  const workerNames = process.argv.slice(2);
  if (workerNames.length !== 1) {
    throw new Error(
      "Usage: node scripts/delete-worker-script.mjs <edgemneme-memory-gateway|edgemneme-github-sync>"
    );
  }
  const result = await deleteWorkerScript(workerNames[0]);
  console.log(`Cloudflare Worker ${result.workerName} is absent.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
