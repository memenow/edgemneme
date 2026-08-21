import { EdgeMnemeError } from "../contracts/errors";
import { decodeBase64Url, encodeBase64Url } from "./crypto";

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

const PAGE_TOKEN_VERSION = 3;

export function createPageToken(payload: PageTokenPayload): string {
  if (!isCanonicalTimestamp(payload.validAt)) {
    throw new TypeError("The page validity timestamp must be a canonical ISO timestamp.");
  }
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
  return encodeBase64Url(body);
}

export function readPageToken(
  token: string,
  context: PageTokenContext
): PageTokenPayload {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(token))
    ) as Record<string, unknown>;
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
      projectId: parsed.p as string,
      queryDigest: parsed.q as string,
      snapshotVersion: parsed.s,
      lastSortKey: parsed.c,
      validAt: parsed.t,
      expiresAt: parsed.e
    };
  } catch {
    throw new EdgeMnemeError("PAGE_TOKEN_INVALID", "The page token is invalid or expired.");
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
