import { describe, expect, it } from "vitest";
import {
  classifyCredentialExpiration,
  isDailyFullReconciliation
} from "../workers/github-sync/index";

describe("GitHub credential expiration", () => {
  const expiresAt = "2026-08-31T00:00:00.000Z";
  const expiresAtMs = Date.parse(expiresAt);
  const dayMs = 24 * 60 * 60 * 1_000;

  it.each([
    [15, { status: "active", warningThresholdDays: null }],
    [14, { status: "expiring", warningThresholdDays: 14 }],
    [7, { status: "expiring", warningThresholdDays: 7 }],
    [1, { status: "expiring", warningThresholdDays: 1 }],
    [0, { status: "expired", warningThresholdDays: null }]
  ] as const)("classifies the %i-day boundary", (daysRemaining, expected) => {
    expect(
      classifyCredentialExpiration(
        expiresAt,
        expiresAtMs - daysRemaining * dayMs
      )
    ).toEqual(expected);
  });

  it("recognizes only the UTC midnight minute as the daily full run", () => {
    expect(isDailyFullReconciliation(Date.parse("2026-07-28T00:00:00.000Z"))).toBe(
      true
    );
    expect(isDailyFullReconciliation(Date.parse("2026-07-28T00:00:59.000Z"))).toBe(
      true
    );
    expect(isDailyFullReconciliation(Date.parse("2026-07-28T00:01:00.000Z"))).toBe(
      false
    );
  });
});
