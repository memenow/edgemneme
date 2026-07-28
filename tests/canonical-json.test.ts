import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/security/canonical-json";

describe("canonical JSON", () => {
  it("sorts object keys recursively without reordering arrays", () => {
    expect(
      canonicalJson({
        z: [{ b: 2, a: 1 }],
        a: "value"
      })
    ).toBe('{"a":"value","z":[{"a":1,"b":2}]}');
  });

  it("rejects unsupported or ambiguous values", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow("finite");
    expect(() => canonicalJson({ value: undefined })).toThrow("Unsupported");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cyclic");
  });
});
