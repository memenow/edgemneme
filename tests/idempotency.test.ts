import { describe, expect, it } from "vitest";
import { resolveIdempotency } from "../src/storage/idempotency";

describe("idempotency", () => {
  it("returns null when the key has not been used", () => {
    expect(resolveIdempotency(null, "new")).toBeNull();
  });

  it("returns the original result for an identical payload", () => {
    expect(
      resolveIdempotency(
        { payloadDigest: "same", response: { candidateId: "candidate-1" } },
        "same"
      )
    ).toEqual({ candidateId: "candidate-1" });
  });

  it("rejects reuse with a different payload", () => {
    expect(() =>
      resolveIdempotency(
        { payloadDigest: "old", response: { candidateId: "candidate-1" } },
        "new"
      )
    ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });
});
