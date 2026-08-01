#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const REQUEST_TIMEOUT_MS = 15_000;

function requiredValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required deployment input ${name} is missing.`);
  }
  return value.trim();
}

export async function verifyCurrentMainHead(environment = process.env, fetchImpl = fetch) {
  const repository = requiredValue(environment, "GITHUB_REPOSITORY");
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/u.test(part))) {
    throw new Error("GITHUB_REPOSITORY must contain one owner and repository name.");
  }
  if (requiredValue(environment, "GITHUB_REF") !== "refs/heads/main") {
    throw new Error("Production deployment is allowed only from refs/heads/main.");
  }
  const expectedSha = requiredValue(environment, "GITHUB_SHA").toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(expectedSha)) {
    throw new Error("GITHUB_SHA is invalid.");
  }
  const token = requiredValue(environment, "GITHUB_TOKEN");
  const [owner, name] = parts;
  const response = await fetchImpl(
    `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
      "/git/ref/heads/main",
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "edgemneme-deployment-admission",
        "X-GitHub-Api-Version": API_VERSION
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub main-head query failed with HTTP ${response.status}.`);
  }
  const payload = await response.json();
  const observedSha = payload?.object?.sha;
  if (typeof observedSha !== "string" || !COMMIT_SHA_PATTERN.test(observedSha)) {
    throw new Error("The GitHub main-head response is invalid.");
  }
  if (observedSha.toLowerCase() !== expectedSha) {
    throw new Error("This deployment run no longer targets the current main commit.");
  }
  return observedSha.toLowerCase();
}

async function main() {
  await verifyCurrentMainHead();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
