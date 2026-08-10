import { z } from "zod";

const timestampSchema = z.iso.datetime({ offset: true });

export interface ValidityInterval {
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
}

export function isValidValidityInterval(interval: ValidityInterval): boolean {
  const validFrom = interval.validFrom ?? null;
  const validUntil = interval.validUntil ?? null;
  if (
    (validFrom !== null && !timestampSchema.safeParse(validFrom).success) ||
    (validUntil !== null && !timestampSchema.safeParse(validUntil).success)
  ) {
    return false;
  }
  return (
    validFrom === null ||
    validUntil === null ||
    Date.parse(validFrom) <= Date.parse(validUntil)
  );
}

export function requireValidValidityInterval(interval: ValidityInterval): void {
  if (!isValidValidityInterval(interval)) {
    throw new TypeError("The memory validity interval is invalid.");
  }
}
