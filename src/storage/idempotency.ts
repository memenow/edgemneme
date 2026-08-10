import { EdgeMnemeError } from "../contracts/errors";

export interface IdempotencyRecord<T> {
  payloadDigest: string;
  response: T;
}

export function resolveIdempotency<T>(
  existing: IdempotencyRecord<T> | null,
  payloadDigest: string
): T | null {
  if (existing === null) {
    return null;
  }
  if (existing.payloadDigest !== payloadDigest) {
    throw new EdgeMnemeError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used with a different payload."
    );
  }
  return existing.response;
}
