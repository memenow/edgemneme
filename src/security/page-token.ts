import { EdgeMnemeError } from "../contracts/errors";
import { constantTimeEqual, decodeBase64Url, encodeBase64Url } from "./crypto";

export interface PageTokenPayload {
  projectId: string;
  queryDigest: string;
  snapshotVersion: number;
  lastSortKey: string;
  validAt: string;
  expiresAt: number;
}

interface PageTokenContext {
  projectId: string;
  queryDigest: string;
  nowEpochSeconds: number;
}

const PAGE_TOKEN_VERSION = 2;

export async function createPageToken(
  payload: PageTokenPayload,
  key: Uint8Array
): Promise<string> {
  validateKey(key);
  validateTimestamp(payload.validAt);
  const body = new TextEncoder().encode(
    JSON.stringify({
      v: PAGE_TOKEN_VERSION,
      p: payload.projectId,
      q: payload.queryDigest,
      s: payload.snapshotVersion,
      c: payload.lastSortKey,
      t: payload.validAt,
      e: payload.expiresAt
    })
  );
  const signature = await sign(body, key);
  return `${encodeBase64Url(body)}.${encodeBase64Url(signature)}`;
}

export async function readPageToken(
  token: string,
  key: Uint8Array,
  context: PageTokenContext
): Promise<PageTokenPayload> {
  try {
    validateKey(key);
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("Malformed token.");
    }
    const body = decodeBase64Url(parts[0]);
    const suppliedSignature = decodeBase64Url(parts[1]);
    const expectedSignature = await sign(body, key);
    if (!constantTimeEqual(suppliedSignature, expectedSignature)) {
      throw new Error("Signature mismatch.");
    }
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    if (
      parsed.v !== PAGE_TOKEN_VERSION ||
      parsed.p !== context.projectId ||
      parsed.q !== context.queryDigest ||
      typeof parsed.s !== "number" ||
      !Number.isSafeInteger(parsed.s) ||
      parsed.s < 0 ||
      typeof parsed.c !== "string" ||
      typeof parsed.t !== "string" ||
      !isCanonicalTimestamp(parsed.t) ||
      typeof parsed.e !== "number" ||
      !Number.isSafeInteger(parsed.e) ||
      parsed.e < context.nowEpochSeconds
    ) {
      throw new Error("Token context mismatch.");
    }
    return {
      projectId: parsed.p,
      queryDigest: parsed.q,
      snapshotVersion: parsed.s,
      lastSortKey: parsed.c,
      validAt: parsed.t,
      expiresAt: parsed.e
    };
  } catch {
    throw new EdgeMnemeError("PAGE_TOKEN_INVALID", "The page token is invalid or expired.");
  }
}

async function sign(body: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyBytes).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, Uint8Array.from(body).buffer)
  );
}

function validateKey(key: Uint8Array): void {
  if (key.byteLength < 32) {
    throw new Error("HMAC keys must be at least 32 bytes.");
  }
}

function validateTimestamp(value: string): void {
  if (!isCanonicalTimestamp(value)) {
    throw new TypeError("The page validity timestamp must be a canonical ISO timestamp.");
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
