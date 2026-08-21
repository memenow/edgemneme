import { EdgeMnemeError } from "../contracts/errors";
import { decodeBase64Url, encodeBase64Url } from "./crypto";

export interface PageTokenPayload {
  projectId: string;
  queryDigest: string;
  snapshotVersion: number;
  lastSortKey: string;
}

interface PageTokenContext {
  projectId: string;
  queryDigest: string;
}

const PAGE_TOKEN_VERSION = 4;

export function createPageToken(payload: PageTokenPayload): string {
  const body = new TextEncoder().encode(
    JSON.stringify({
      v: PAGE_TOKEN_VERSION,
      p: payload.projectId,
      q: payload.queryDigest,
      s: payload.snapshotVersion,
      c: payload.lastSortKey
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
      typeof parsed.c !== "string"
    ) {
      throw new Error("Token context mismatch.");
    }
    return {
      projectId: parsed.p as string,
      queryDigest: parsed.q as string,
      snapshotVersion: parsed.s,
      lastSortKey: parsed.c
    };
  } catch {
    throw new EdgeMnemeError("PAGE_TOKEN_INVALID", "The page token is invalid.");
  }
}
