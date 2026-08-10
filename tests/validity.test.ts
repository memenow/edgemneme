import { describe, expect, it } from "vitest";
import {
  isValidValidityInterval,
  requireValidValidityInterval
} from "../src/contracts/validity";

describe("memory validity intervals", () => {
  it("accepts open, equal, and chronologically ordered intervals", () => {
    expect(isValidValidityInterval({ validFrom: null, validUntil: null })).toBe(true);
    expect(
      isValidValidityInterval({
        validFrom: "2026-07-25T00:00:00.000Z",
        validUntil: "2026-07-25T00:00:00.000Z"
      })
    ).toBe(true);
    expect(
      isValidValidityInterval({
        validFrom: "2026-07-25T00:00:00.000Z",
        validUntil: "2026-07-26T00:00:00.000Z"
      })
    ).toBe(true);
  });

  it("normalizes offsets before comparing and rejects reverse or invalid intervals", () => {
    expect(
      isValidValidityInterval({
        validFrom: "2026-07-25T02:00:00.000+02:00",
        validUntil: "2026-07-25T00:00:00.000Z"
      })
    ).toBe(true);
    expect(
      isValidValidityInterval({
        validFrom: "2026-07-26T00:00:00.000Z",
        validUntil: "2026-07-25T00:00:00.000Z"
      })
    ).toBe(false);
    expect(() => requireValidValidityInterval({ validFrom: "not-a-time" })).toThrow(
      /validity interval/iu
    );
  });
});
