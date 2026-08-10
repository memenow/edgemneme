const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_097_152;
const ACCOUNT_ID_PATTERN =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

function requireAccountId(value) {
  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must contain a valid account identifier.");
  }
  const normalized = value.toLowerCase();
  if (/^(?:0{32}|1{32})$/u.test(normalized.replaceAll("-", ""))) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must not contain a placeholder value.");
  }
  return normalized;
}

function requireToken(value) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN must be provided through the environment.");
  }
  return value;
}

async function readBoundedJson(response, label) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      if (response.body !== null) void response.body.cancel().catch(() => {});
      throw new Error(`${label} returned an invalid or oversized response.`);
    }
  }
  if (response.body === null) throw new Error(`${label} returned an empty response.`);
  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error(`${label} returned an oversized response.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} returned an unreadable response.`);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export function createCloudflareMaintenanceClient(
  environment = process.env,
  fetchImpl = fetch
) {
  const accountId = requireAccountId(environment.CLOUDFLARE_ACCOUNT_ID);
  const token = requireToken(environment.CLOUDFLARE_API_TOKEN);
  if (typeof fetchImpl !== "function") {
    throw new Error("A Cloudflare fetch implementation is required.");
  }
  return Object.freeze({
    accountId,
    accountPath(path) {
      return `/accounts/${encodeURIComponent(accountId)}${path}`;
    },
    async get(path, { allowNotFound = false, label = "Cloudflare maintenance query" } = {}) {
      if (typeof path !== "string" || !path.startsWith("/") || path.includes("#")) {
        throw new Error("A fixed Cloudflare API path is required.");
      }
      let response;
      try {
        response = await fetchImpl(`${API_ORIGIN}${path}`, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`
          },
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch {
        throw new Error(`${label} did not receive a valid response.`);
      }
      if (allowNotFound && response.status === 404) {
        if (response.body !== null) void response.body.cancel().catch(() => {});
        return undefined;
      }
      if (!response.ok) {
        if (response.body !== null) void response.body.cancel().catch(() => {});
        throw new Error(`${label} failed with HTTP ${response.status}.`);
      }
      const envelope = await readBoundedJson(response, label);
      if (
        envelope === null ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        envelope.success !== true ||
        !("result" in envelope)
      ) {
        throw new Error(`${label} returned an invalid Cloudflare envelope.`);
      }
      return envelope;
    }
  });
}

export function requirePage(envelope, expectedPage, expectedPerPage, label) {
  const rows = envelope?.result;
  const info = envelope?.result_info;
  if (
    !Array.isArray(rows) ||
    info === null ||
    typeof info !== "object" ||
    Array.isArray(info) ||
    !Number.isSafeInteger(info.count) ||
    info.count !== rows.length ||
    !Number.isSafeInteger(info.page) ||
    info.page !== expectedPage ||
    !Number.isSafeInteger(info.per_page) ||
    info.per_page !== expectedPerPage ||
    !Number.isSafeInteger(info.total_count) ||
    info.total_count < 0 ||
    !Number.isSafeInteger(info.total_pages) ||
    info.total_pages < 0 ||
    (info.total_count === 0 && ![0, 1].includes(info.total_pages)) ||
    (info.total_count > 0 &&
      info.total_pages !== Math.ceil(info.total_count / info.per_page))
  ) {
    throw new Error(`${label} returned invalid or incomplete pagination metadata.`);
  }
  return { rows, info };
}
