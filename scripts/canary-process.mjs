import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const CAPTURE_LIMIT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 240_000;
const LONG_TIMEOUT_MS = 900_000;
const GATEWAY_READY_CONSECUTIVE_SUCCESSES = 6;
const GATEWAY_READY_MAX_ATTEMPTS = 24;
const GATEWAY_READY_RETRY_DELAY_MS = 5_000;
const GATEWAY_WORKER_NAME = "edgemneme-memory-gateway";
const GATEWAY_VERSION_OVERRIDE_HEADER =
  "Cloudflare-Workers-Version-Overrides";
const GATEWAY_VERSION_RESPONSE_HEADER = "x-edgemneme-worker-version";
const CLOUDFLARE_ERROR_BODY_LIMIT_BYTES = 16 * 1024;
const WORKER_VERSION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CLIENT_ENVIRONMENT_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "CI",
  "NO_COLOR"
];
const SYSTEM_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "PNPM_HOME",
  "COREPACK_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "CI",
  "NO_COLOR"
];

export function clientEnvironment(overrides) {
  return { ...pickEnvironment(CLIENT_ENVIRONMENT_KEYS), ...overrides };
}

export function wranglerEnvironment() {
  return pickEnvironment([
    ...SYSTEM_ENVIRONMENT_KEYS,
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID"
  ]);
}

export function runProcess(
  command,
  args,
  label,
  environment = wranglerEnvironment(),
  stdio = "ignore",
  timeoutMs = LONG_TIMEOUT_MS
) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    stdio,
    timeout: timeoutMs
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed.`);
  }
}

export function runProcessCapture(
  command,
  args,
  label,
  environment = wranglerEnvironment()
) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: CAPTURE_LIMIT_BYTES
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`${label} failed.`);
  }
  return result.stdout;
}

export function runProcessCaptureIfFound(
  command,
  args,
  label,
  missingMarker,
  environment = wranglerEnvironment()
) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: CAPTURE_LIMIT_BYTES
  });
  if (result.error) {
    throw new Error(`${label} failed.`, { cause: result.error });
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status === 0) {
    return typeof result.stdout === "string" ? result.stdout : "";
  }
  if (output.includes(missingMarker)) {
    return null;
  }
  throw new Error(`${label} failed.`);
}

export function runProcessAsync(
  command,
  args,
  label,
  environment = wranglerEnvironment()
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: "ignore"
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, DEFAULT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`${label} failed.`, { cause: error }));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) {
        resolve();
      } else {
        reject(new Error(`${label} failed.`));
      }
    });
  });
}

export function runProcessAsyncStatus(
  command,
  args,
  environment = wranglerEnvironment()
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let timedOut = false;
    const append = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-CAPTURE_LIMIT_BYTES);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, DEFAULT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: timedOut ? null : code, output });
    });
  });
}

export function canaryUuid(name, required) {
  const configured = process.env[name];
  if (!configured) {
    if (required) {
      throw new Error(`${name} is required for cleanup-only mode.`);
    }
    return randomUUID();
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(configured)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return configured.toLowerCase();
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForCredentialPropagation(
  url,
  bearerToken,
  expectedHost = process.env.EDGEMNEME_GATEWAY_EXPECTED_HOST,
  options = {}
) {
  const {
    consecutiveSuccesses = GATEWAY_READY_CONSECUTIVE_SUCCESSES,
    expectedVersion = process.env.EDGEMNEME_GATEWAY_EXPECTED_VERSION,
    maxAttempts = GATEWAY_READY_MAX_ATTEMPTS,
    retryDelayMs = GATEWAY_READY_RETRY_DELAY_MS,
    delayImplementation = delay
  } = options;
  if (
    !Number.isSafeInteger(consecutiveSuccesses) ||
    consecutiveSuccesses < 2 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < consecutiveSuccesses ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 0 ||
    typeof delayImplementation !== "function"
  ) {
    throw new Error("Gateway readiness options are invalid.");
  }
  const gatewayUrl = validateGatewayUrl(url, "Gateway URL", expectedHost);
  const gatewayVersion = validateGatewayVersion(expectedVersion);
  const gatewayFetch = createPinnedGatewayTransportFetch(
    gatewayUrl.toString(),
    expectedHost,
    gatewayVersion,
    globalThis.fetch,
    false
  );
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "EdgeMneme synthetic canary", version: "2026-07-25" }
    }
  });
  let successfulProbes = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await gatewayFetch(gatewayUrl.toString(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: requestBody,
      signal: AbortSignal.timeout(10_000)
    });
    if (await isCloudflareScriptNotFound(response)) {
      successfulProbes = 0;
    } else {
      assertGatewayResponseVersion(response, gatewayVersion);
      if (!response.ok) {
        throw new Error(
          `Gateway readiness probe failed with HTTP status ${response.status}.`
        );
      }
      successfulProbes += 1;
      if (successfulProbes === consecutiveSuccesses) {
        return;
      }
    }
    if (attempt + 1 < maxAttempts) {
      await delayImplementation(retryDelayMs);
    }
  }
  throw new Error(
    "Gateway did not accept the synthetic credential within the propagation window."
  );
}

export function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function requireGatewayUrl(
  name,
  expectedHost = process.env.EDGEMNEME_GATEWAY_EXPECTED_HOST
) {
  const value = requiredEnvironment(name);
  return validateGatewayUrl(value, name, expectedHost).toString();
}

export function createPinnedGatewayFetch(
  gatewayUrl,
  expectedHost = process.env.EDGEMNEME_GATEWAY_EXPECTED_HOST,
  expectedVersion = process.env.EDGEMNEME_GATEWAY_EXPECTED_VERSION,
  fetchImplementation = globalThis.fetch
) {
  return createPinnedGatewayTransportFetch(
    gatewayUrl,
    expectedHost,
    validateGatewayVersion(expectedVersion),
    fetchImplementation,
    true
  );
}

function createPinnedGatewayTransportFetch(
  gatewayUrl,
  expectedHost,
  expectedVersion,
  fetchImplementation,
  verifyResponseVersion
) {
  const pinnedUrl = validateGatewayUrl(gatewayUrl, "Gateway URL", expectedHost);
  if (typeof fetchImplementation !== "function") {
    throw new Error("A fetch implementation is required for the gateway client.");
  }
  return async (input, init) => {
    const requestUrl = validateGatewayUrl(
      fetchInputUrl(input),
      "Gateway request URL",
      expectedHost
    );
    if (requestUrl.toString() !== pinnedUrl.toString()) {
      throw new Error("Gateway request URL does not match the pinned endpoint.");
    }
    const headers = requestHeaders(input, init?.headers);
    headers.set(
      GATEWAY_VERSION_OVERRIDE_HEADER,
      `${GATEWAY_WORKER_NAME}="${expectedVersion}"`
    );
    const response = await fetchImplementation(input, {
      ...init,
      headers,
      redirect: "manual"
    });
    if (
      (response.status >= 300 && response.status < 400) ||
      response.redirected === true ||
      response.type === "opaqueredirect"
    ) {
      throw new Error("Gateway redirects are not allowed for bearer requests.");
    }
    if (response.url !== pinnedUrl.toString()) {
      throw new Error("Gateway returned a response from an unexpected URL.");
    }
    if (verifyResponseVersion) {
      assertGatewayResponseVersion(response, expectedVersion);
    }
    return response;
  };
}

function requestHeaders(input, initHeaders) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(initHeaders).forEach((value, name) => headers.set(name, value));
  return headers;
}

function assertGatewayResponseVersion(response, expectedVersion) {
  const observedVersion = response.headers?.get?.(
    GATEWAY_VERSION_RESPONSE_HEADER
  );
  if (observedVersion !== expectedVersion) {
    throw new Error(
      "Gateway response did not prove the expected Worker version."
    );
  }
}

async function isCloudflareScriptNotFound(response) {
  if (
    response.status !== 500 ||
    !/^application\/(?:problem\+)?json(?:\s*;|$)/iu.test(
      response.headers?.get?.("content-type") ?? ""
    ) ||
    typeof response.clone !== "function"
  ) {
    return false;
  }
  const declaredLength = response.headers?.get?.("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > CLOUDFLARE_ERROR_BODY_LIMIT_BYTES)
  ) {
    return false;
  }
  let body = "";
  try {
    const reader = response.clone().body?.getReader();
    if (reader === undefined) {
      return false;
    }
    const decoder = new TextDecoder();
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        body += decoder.decode();
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > CLOUDFLARE_ERROR_BODY_LIMIT_BYTES) {
        await reader.cancel();
        return false;
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return false;
  }
  let error;
  try {
    error = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    error !== null &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    error.status === 500 &&
    error.error_code === 1104 &&
    error.error_name === "worker_script_not_found" &&
    error.cloudflare_error === true
  );
}

function validateGatewayVersion(value) {
  if (typeof value !== "string" || !WORKER_VERSION_PATTERN.test(value)) {
    throw new Error(
      "EDGEMNEME_GATEWAY_EXPECTED_VERSION must be a canonical lowercase Worker version UUID."
    );
  }
  return value;
}

function validateGatewayUrl(value, label, expectedHost) {
  if (typeof expectedHost !== "string" || expectedHost.length === 0) {
    throw new Error("EDGEMNEME_GATEWAY_EXPECTED_HOST is required.");
  }
  const normalizedExpectedHost = expectedHost.toLowerCase();
  let expectedOrigin;
  try {
    expectedOrigin = new URL(`https://${normalizedExpectedHost}/`);
  } catch {
    throw new Error("EDGEMNEME_GATEWAY_EXPECTED_HOST must be a valid hostname.");
  }
  if (
    expectedOrigin.hostname !== normalizedExpectedHost ||
    expectedOrigin.host !== normalizedExpectedHost ||
    expectedOrigin.username !== "" ||
    expectedOrigin.password !== "" ||
    expectedOrigin.port !== "" ||
    expectedOrigin.pathname !== "/" ||
    expectedOrigin.search !== "" ||
    expectedOrigin.hash !== ""
  ) {
    throw new Error("EDGEMNEME_GATEWAY_EXPECTED_HOST must be a valid hostname.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/mcp" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.hostname !== normalizedExpectedHost
  ) {
    throw new Error(`${label} must be the expected HTTPS /mcp endpoint.`);
  }
  return url;
}

function fetchInputUrl(input) {
  if (typeof input === "string" || input instanceof URL) {
    return input.toString();
  }
  if (
    typeof input === "object" &&
    input !== null &&
    typeof input.url === "string"
  ) {
    return input.url;
  }
  throw new Error("Gateway request URL must be a string, URL, or Request.");
}

export function requireResourceName(value, label) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/u.test(value)) {
    throw new Error(`The ${label} name is invalid.`);
  }
}

function pickEnvironment(names) {
  return Object.fromEntries(
    names.flatMap((name) =>
      typeof process.env[name] === "string" ? [[name, process.env[name]]] : []
    )
  );
}
