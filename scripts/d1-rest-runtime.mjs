import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_BATCH_STATEMENTS = 64;
const MAX_SQL_BYTES = 100_000;
const MAX_PARAMETERS = 100;
const MAX_PARAMETER_STRING_BYTES = 8_192;
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ACCOUNT_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const PLACEHOLDER_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "11111111-1111-1111-1111-111111111111"
]);
const ALLOWED_CONFIG_PATHS = Object.freeze([
  "wrangler/.wrangler/github-sync.generated.jsonc",
  "wrangler/.wrangler/memory-orchestrator.generated.jsonc"
]);

export function createD1RestRuntime(configPath) {
  return createD1BindingRestRuntime(configPath, "MEMORY_DB");
}

export function createD1BindingRestRuntime(configPath, bindingName) {
  const databaseId = readGeneratedD1DatabaseId(configPath, bindingName);
  const accountId = requireAccountId(process.env.CLOUDFLARE_ACCOUNT_ID);
  const token = requireApiToken(process.env.CLOUDFLARE_API_TOKEN);
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/d1/database/${encodeURIComponent(databaseId)}/query`;

  const execute = async (statements, label) => {
    const safeLabel = requireLabel(label);
    const requestStatements = requireStatements(statements);
    const requestBody = encodeRequestBody(requestStatements, safeLabel);

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: requestBody,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new Error(`${safeLabel} did not receive a valid Cloudflare D1 response.`);
    }

    if (!response.ok) {
      cancelResponseBody(response);
      throw new Error(`${safeLabel} failed with HTTP ${response.status}.`);
    }

    const envelope = await readBoundedJson(response, safeLabel);
    return requireD1Results(envelope, requestStatements.length, safeLabel);
  };

  return Object.freeze({
    async query(sql, params, label) {
      const [result] = await execute([{ sql, params }], label);
      return result;
    },

    async batch(statements, label) {
      return execute(statements, label);
    }
  });
}

function requireGeneratedConfigPath(configPath) {
  if (typeof configPath !== "string" || configPath.trim() === "") {
    throw new Error("A generated Wrangler config path is required.");
  }
  const candidate = resolve(configPath);
  const allowed = ALLOWED_CONFIG_PATHS.map((path) => resolve(path));
  if (!allowed.includes(candidate)) {
    throw new Error("Only an approved generated Wrangler config may be used for remote D1.");
  }
  return candidate;
}

export function readGeneratedD1DatabaseId(configPath, bindingName) {
  if (bindingName !== "MEMORY_DB" && bindingName !== "SEARCH_DB") {
    throw new Error("Only an approved D1 binding may be queried.");
  }
  const resolvedConfigPath = requireGeneratedConfigPath(configPath);
  let config;
  try {
    config = JSON.parse(readFileSync(resolvedConfigPath, "utf8"));
  } catch {
    throw new Error("The generated Wrangler config is missing or invalid.");
  }
  const databases = config?.d1_databases;
  if (!Array.isArray(databases)) {
    throw new Error("The generated Wrangler config has no D1 binding inventory.");
  }
  const matches = databases.filter((database) => database?.binding === bindingName);
  if (matches.length !== 1) {
    throw new Error(
      `The generated Wrangler config must contain exactly one ${bindingName} binding.`
    );
  }
  const databaseId = matches[0]?.database_id;
  if (
    typeof databaseId !== "string" ||
    !UUID_PATTERN.test(databaseId) ||
    PLACEHOLDER_UUIDS.has(databaseId.toLowerCase())
  ) {
    throw new Error(
      `The generated ${bindingName} binding must contain a non-placeholder UUID.`
    );
  }
  return databaseId.toLowerCase();
}

function requireAccountId(value) {
  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must contain a valid account identifier.");
  }
  const normalized = value.toLowerCase();
  const compact = normalized.replaceAll("-", "");
  if (/^(?:0{32}|1{32})$/u.test(compact)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must not contain a placeholder value.");
  }
  return normalized;
}

function requireApiToken(value) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error("CLOUDFLARE_API_TOKEN must be provided through the environment.");
  }
  return value;
}

function requireLabel(label) {
  if (
    typeof label !== "string" ||
    label.trim() === "" ||
    label.length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(label)
  ) {
    throw new Error("A safe D1 operation label is required.");
  }
  return label;
}

function requireStatements(statements) {
  if (
    !Array.isArray(statements) ||
    statements.length === 0 ||
    statements.length > MAX_BATCH_STATEMENTS
  ) {
    throw new Error(
      `A D1 statement batch must contain between 1 and ${MAX_BATCH_STATEMENTS} statements.`
    );
  }
  return statements.map((statement) => {
    if (
      statement === null ||
      typeof statement !== "object" ||
      Array.isArray(statement) ||
      typeof statement.sql !== "string" ||
      statement.sql.trim() === "" ||
      Buffer.byteLength(statement.sql, "utf8") > MAX_SQL_BYTES ||
      !Array.isArray(statement.params) ||
      statement.params.length > MAX_PARAMETERS ||
      statement.params.some((parameter) => !isD1RestParameter(parameter))
    ) {
      throw new Error(
        "Every D1 statement must contain bounded SQL and an explicit bounded scalar parameter array."
      );
    }
    return statement.params.length === 0
      ? { sql: statement.sql }
      : { sql: statement.sql, params: statement.params };
  });
}

function isD1RestParameter(value) {
  return (
    value === null ||
    (typeof value === "string" &&
      Buffer.byteLength(value, "utf8") <= MAX_PARAMETER_STRING_BYTES) ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  );
}

function encodeRequestBody(statements, label) {
  const prefix = '{"batch":[';
  const suffix = "]}";
  const encoded = [];
  let bodyBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  for (const statement of statements) {
    let value;
    try {
      value = JSON.stringify(statement);
    } catch {
      throw new Error(`${label} contains parameters that cannot be encoded as JSON.`);
    }
    bodyBytes += Buffer.byteLength(value, "utf8") + (encoded.length === 0 ? 0 : 1);
    if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
      throw new Error(`${label} exceeds the bounded Cloudflare D1 request size.`);
    }
    encoded.push(value);
  }
  return `${prefix}${encoded.join(",")}${suffix}`;
}

async function readBoundedJson(response, label) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      cancelResponseBody(response);
      throw new Error(`${label} returned an invalid or oversized Cloudflare D1 response.`);
    }
  }
  if (response.body === null) {
    throw new Error(`${label} returned an empty Cloudflare D1 response.`);
  }

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
        throw new Error(`${label} returned an oversized Cloudflare D1 response.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} returned`)) {
      throw error;
    }
    throw new Error(`${label} returned an unreadable Cloudflare D1 response.`);
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
    throw new Error(`${label} returned invalid Cloudflare D1 JSON.`);
  }
}

function requireD1Results(envelope, expectedLength, label) {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    envelope.success !== true ||
    !Array.isArray(envelope.result) ||
    envelope.result.length !== expectedLength
  ) {
    throw new Error(`${label} returned an invalid Cloudflare D1 envelope.`);
  }
  return envelope.result.map((statement) => {
    if (
      statement === null ||
      typeof statement !== "object" ||
      Array.isArray(statement) ||
      statement.success !== true ||
      !Array.isArray(statement.results) ||
      statement.meta === null ||
      typeof statement.meta !== "object" ||
      Array.isArray(statement.meta) ||
      statement.meta.served_by_primary !== true
    ) {
      throw new Error(`${label} returned an invalid Cloudflare D1 statement result.`);
    }
    return { results: statement.results, meta: statement.meta };
  });
}

function cancelResponseBody(response) {
  if (response.body !== null) {
    void response.body.cancel().catch(() => {});
  }
}
