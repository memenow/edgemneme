import { describe, expect, it } from "vitest";

// @ts-expect-error The JavaScript CLI has no separate declaration file.
import { verifyCurrentMainHead } from "../scripts/verify-github-main-head.mjs";

const CURRENT_SHA = "1111111111111111111111111111111111111111";

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    GITHUB_REPOSITORY: "memenow/edgemneme",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CURRENT_SHA,
    GITHUB_TOKEN: "synthetic-token",
    ...overrides
  };
}

describe("GitHub main-head deployment admission", () => {
  it("accepts only the run that still targets current main", async () => {
    const fetchImpl = (async (input, init) => {
      expect(String(input)).toBe(
        "https://api.github.com/repos/memenow/edgemneme/git/ref/heads/main"
      );
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-token");
      expect(new Headers(init?.headers).get("x-github-api-version")).toBe("2026-03-10");
      return Response.json({ object: { sha: CURRENT_SHA } });
    }) as typeof fetch;

    await expect(verifyCurrentMainHead(environment(), fetchImpl)).resolves.toBe(CURRENT_SHA);
  });

  it("rejects a queued run after main advances", async () => {
    const fetchImpl = (async () =>
      Response.json({ object: { sha: "2222222222222222222222222222222222222222" } })) as typeof fetch;

    await expect(
      verifyCurrentMainHead(environment(), fetchImpl)
    ).rejects.toThrow("no longer targets the current main commit");
  });

  it("rejects redirects and malformed repository context", async () => {
    const redirectingFetch = (async () => new Response(null, { status: 302 })) as typeof fetch;
    await expect(
      verifyCurrentMainHead(environment(), redirectingFetch)
    ).rejects.toThrow("HTTP 302");
    await expect(
      verifyCurrentMainHead(environment({ GITHUB_REPOSITORY: "memenow/edgemneme/extra" }))
    ).rejects.toThrow("one owner and repository name");
  });

  it("rejects non-main refs before making a request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({ object: { sha: CURRENT_SHA } });
    }) as typeof fetch;

    await expect(
      verifyCurrentMainHead(environment({ GITHUB_REF: "refs/heads/feature" }), fetchImpl)
    ).rejects.toThrow("only from refs/heads/main");
    expect(called).toBe(false);
  });
});
