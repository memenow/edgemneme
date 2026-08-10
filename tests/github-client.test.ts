import { describe, expect, it, vi } from "vitest";
import {
  createGitHubRequestPacer,
  GitHubReadOnlyClient,
  MAX_AUTHENTICATED_REPOSITORIES,
  type GitHubRateLimit
} from "../src/github/client";

const REPOSITORY_ID = 42;
const OWNER_ID = 7;
const SHA = "a".repeat(40);
const TOKEN_EXPIRATION_HEADER = "2026-10-26 00:00:00 UTC";

function createClient(fetcher: typeof fetch): GitHubReadOnlyClient {
  return new GitHubReadOnlyClient({
    token: "synthetic-token",
    fetcher,
    allowedRepositoryIds: new Set([REPOSITORY_ID])
  });
}

describe("GitHubReadOnlyClient", () => {
  it("sends only allowlisted GET requests with fixed headers and manual redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: REPOSITORY_ID, owner: { id: 7 } }));

    await createClient(fetcher).getRepository(
      "memenow",
      "edgemneme",
      REPOSITORY_ID,
      OWNER_ID
    );

    const request = fetcher.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("manual");
    expect(request.url).toBe("https://api.github.com/repos/memenow/edgemneme");
    expect(request.headers.get("accept")).toBe("application/vnd.github+json");
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-token");
    expect(request.headers.get("user-agent")).toBe("EdgeMneme");
    expect(request.headers.get("x-github-api-version")).toBe("2026-03-10");
  });

  it("allows GET only and rejects ambiguous or non-allowlisted paths", () => {
    expect(GitHubReadOnlyClient.isAllowedEndpoint("GET", "/user")).toBe(true);
    expect(GitHubReadOnlyClient.isAllowedEndpoint("HEAD", "/user")).toBe(false);
    expect(GitHubReadOnlyClient.isAllowedEndpoint("POST", "/user")).toBe(false);
    expect(GitHubReadOnlyClient.isAllowedEndpoint("GET", "https://example.com/user")).toBe(
      false
    );
    expect(GitHubReadOnlyClient.isAllowedEndpoint("GET", "//api.github.com/user")).toBe(
      false
    );
    expect(GitHubReadOnlyClient.isAllowedEndpoint("GET", "/repos/a/b/issues")).toBe(false);
    expect(
      GitHubReadOnlyClient.isAllowedEndpoint(
        "GET",
        `/repos/a/b/git/tags/${SHA}`
      )
    ).toBe(true);
    expect(
      GitHubReadOnlyClient.isAllowedEndpoint(
        "GET",
        `/repos/a/b/git/tags/${SHA}/unexpected`
      )
    ).toBe(false);
    expect(
      GitHubReadOnlyClient.isAllowedEndpoint(
        "GET",
        `/repos/a/b/git/blobs/${"a".repeat(39)}/../user`
      )
    ).toBe(false);
    expect(
      GitHubReadOnlyClient.isAllowedEndpoint("GET", "/repos/a/b/git/blobs/%2e%2e")
    ).toBe(false);
  });

  it("fails with a partial sync before exceeding the configured request budget", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: OWNER_ID, login: "octocat" }), {
        headers: {
          "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
        }
      })
    );
    const client = new GitHubReadOnlyClient({
      token: "synthetic-token",
      fetcher,
      allowedRepositoryIds: new Set([REPOSITORY_ID]),
      maxRequests: 1
    });

    await expect(client.getAuthenticatedUser()).resolves.toMatchObject({
      status: "modified"
    });
    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({
      code: "GITHUB_PARTIAL_SYNC"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a slow GitHub fetch at the per-request deadline", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (input) =>
        new Promise<Response>((_resolve, reject) => {
          const request = input as Request;
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true
          });
        })
    );
    const client = new GitHubReadOnlyClient({
      token: "synthetic-token",
      fetcher,
      allowedRepositoryIds: new Set([REPOSITORY_ID]),
      requestTimeoutMs: 5
    });

    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({
      code: "GITHUB_PARTIAL_SYNC"
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects an exhausted absolute deadline before fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new GitHubReadOnlyClient({
      token: "synthetic-token",
      fetcher,
      allowedRepositoryIds: new Set([REPOSITORY_ID]),
      absoluteDeadlineMs: 1_000,
      now: () => 1_000
    });

    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({
      code: "GITHUB_PARTIAL_SYNC"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps request budgets isolated between client instances", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ id: OWNER_ID, login: "octocat" }), {
        headers: {
          "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
        }
      })
    );
    const createBudgetedClient = () =>
      new GitHubReadOnlyClient({
        token: "synthetic-token",
        fetcher,
        allowedRepositoryIds: new Set([REPOSITORY_ID]),
        maxRequests: 1
      });
    const first = createBudgetedClient();
    const second = createBudgetedClient();

    await expect(first.getAuthenticatedUser()).resolves.toMatchObject({
      status: "modified"
    });
    await expect(first.getAuthenticatedUser()).rejects.toMatchObject({
      code: "GITHUB_PARTIAL_SYNC"
    });
    await expect(second.getAuthenticatedUser()).resolves.toMatchObject({
      status: "modified"
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("paces requests from separate clients through one shared serial gate", async () => {
    let clock = 1_000;
    const delays: number[] = [];
    const requestStarts: number[] = [];
    const pacer = createGitHubRequestPacer({
      minimumIntervalMs: 80,
      now: () => clock,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        clock += delayMs;
      }
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      requestStarts.push(clock);
      return new Response(JSON.stringify({ id: OWNER_ID, login: "octocat" }), {
        headers: {
          "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
        }
      });
    });
    const createPacedClient = () =>
      new GitHubReadOnlyClient({
        token: "synthetic-token",
        fetcher,
        allowedRepositoryIds: new Set([REPOSITORY_ID]),
        beforeRequest: pacer
      });

    await Promise.all([
      createPacedClient().getAuthenticatedUser(),
      createPacedClient().getAuthenticatedUser()
    ]);

    expect(requestStarts).toEqual([1_000, 1_080]);
    expect(delays).toEqual([80]);
  });

  it("does not enter the request pacer after a client budget is exhausted", async () => {
    const beforeRequest = { wait: vi.fn().mockResolvedValue(undefined) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: OWNER_ID, login: "octocat" }), {
        headers: {
          "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
        }
      })
    );
    const client = new GitHubReadOnlyClient({
      token: "synthetic-token",
      fetcher,
      allowedRepositoryIds: new Set([REPOSITORY_ID]),
      maxRequests: 1,
      beforeRequest
    });

    await client.getAuthenticatedUser();
    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({
      code: "GITHUB_PARTIAL_SYNC"
    });

    expect(beforeRequest.wait).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reserves a one-request budget before concurrent callers enter the pacer", async () => {
    const beforeRequest = { wait: vi.fn().mockResolvedValue(undefined) };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: OWNER_ID, login: "octocat" }), {
        headers: {
          "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
        }
      })
    );
    const client = new GitHubReadOnlyClient({
      token: "synthetic-token",
      fetcher,
      allowedRepositoryIds: new Set([REPOSITORY_ID]),
      maxRequests: 1,
      beforeRequest
    });

    const results = await Promise.allSettled([
      client.getAuthenticatedUser(),
      client.getAuthenticatedUser()
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "GITHUB_PARTIAL_SYNC" })
      })
    ]);
    expect(beforeRequest.wait).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps a request budget consumed when the pacer fails closed", async () => {
    const beforeRequest = {
      wait: vi.fn().mockRejectedValue(new Error("synthetic pacer failure"))
    };
    const fetcher = vi.fn<typeof fetch>();
    const client = new GitHubReadOnlyClient({
      token: "synthetic-token",
      fetcher,
      allowedRepositoryIds: new Set([REPOSITORY_ID]),
      maxRequests: 1,
      beforeRequest
    });

    await expect(client.getAuthenticatedUser()).rejects.toThrow(
      "synthetic pacer failure"
    );
    await expect(client.getAuthenticatedUser()).rejects.toMatchObject({
      code: "GITHUB_PARTIAL_SYNC"
    });

    expect(beforeRequest.wait).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects ref access before a client verifies repository identity", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      createClient(fetcher).getRef(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        "heads/main"
      )
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects repository identity drift and every redirect without following it", async () => {
    await expect(
      createClient(
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 99, owner: { id: 7 } }))
      ).getRepository("memenow", "edgemneme", REPOSITORY_ID, OWNER_ID)
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });

    await expect(
      createClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json({ id: REPOSITORY_ID, owner: { id: OWNER_ID + 1 } })
          )
      ).getRepository("memenow", "edgemneme", REPOSITORY_ID, OWNER_ID)
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });

    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repos/memenow/renamed" }
      })
    );
    await expect(
      createClient(fetcher).getRepository(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        OWNER_ID
      )
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("loads the authenticated identity conditionally and never parses a 304 body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 7, login: "octocat" }), {
          status: 200,
          headers: {
            etag: '"identity-etag"',
            "x-oauth-scopes": "repo, read:user",
            "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: {
            etag: '"identity-etag"',
            "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
          }
        })
      );
    const client = createClient(fetcher);

    await expect(client.getAuthenticatedUser()).resolves.toMatchObject({
      status: "modified",
      value: { id: 7, login: "octocat" },
      etag: '"identity-etag"',
      scopes: ["read:user", "repo"],
      credentialExpiresAt: "2026-10-26T00:00:00.000Z"
    });
    await expect(client.getAuthenticatedUser('"identity-etag"')).resolves.toEqual(
      expect.objectContaining({
        status: "not_modified",
        etag: '"identity-etag"',
        credentialExpiresAt: "2026-10-26T00:00:00.000Z"
      })
    );
    const secondRequest = fetcher.mock.calls[1]?.[0] as Request;
    expect(secondRequest.headers.get("if-none-match")).toBe('"identity-etag"');
  });

  it("bounds an oversized 2xx JSON stream without Content-Length and cancels it", async () => {
    const confidentialMarker = "synthetic-confidential-success-body";
    const prefix = new TextEncoder().encode(
      `{"id":${REPOSITORY_ID},"owner":{"id":${OWNER_ID}},"padding":"${confidentialMarker}`
    );
    const chunk = new Uint8Array(4 * 1024 * 1024).fill(120);
    chunk.set(prefix);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 8) {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      }
    });
    const response = new Response(body, { status: 200 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    const error = await createClient(fetcher)
      .getRepository("memenow", "edgemneme", REPOSITORY_ID, OWNER_ID)
      .catch((caught: unknown) => caught);

    expect(response.headers.has("content-length")).toBe(false);
    expect(error).toMatchObject({
      code: "GITHUB_PARTIAL_SYNC",
      retryable: false
    });
    expect(String(error)).not.toContain(confidentialMarker);
    expect(String(error)).not.toContain("synthetic-token");
    expect(pulls).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);
  });

  it("rejects an unsolicited 304 without a matching conditional request", async () => {
    await expect(
      createClient(
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 304 }))
      ).getAuthenticatedUser()
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed", "2026-10-26T00:00:00Z"],
    ["invalid calendar date", "2026-02-30 00:00:00 UTC"]
  ])("rejects a %s credential expiration header", async (_label, header) => {
    const headers = new Headers();
    if (header !== undefined) {
      headers.set("github-authentication-token-expiration", header);
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: OWNER_ID, login: "octocat" }), { headers })
    );

    await expect(createClient(fetcher).getAuthenticatedUser()).rejects.toMatchObject({
      code: "GITHUB_CREDENTIAL_EXPIRED"
    });
  });

  it.each([
    [401, {}, "GITHUB_AUTHORIZATION_REQUIRED"],
    [403, { "x-github-sso": "required" }, "GITHUB_SSO_REQUIRED"],
    [429, { "retry-after": "2" }, "GITHUB_RATE_LIMITED"]
  ])(
    "preserves GitHub status %i before requiring an expiration header",
    async (status, headers, code) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status, headers }));

      await expect(createClient(fetcher).getAuthenticatedUser()).rejects.toMatchObject({
        code
      });
    }
  );

  it("enumerates every authenticated repository page and validates pagination links", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 42,
              full_name: "memenow/edgemneme",
              owner: { id: 7 },
              permissions: { pull: true, push: false, admin: false },
              private: true,
              untrusted_payload: "must not be retained"
            }
          ]),
          {
            headers: {
              link:
                '<https://api.github.com/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&direction=asc&per_page=100&page=2>; rel="next"',
              "x-oauth-scopes": "repo"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 84,
              full_name: "memenow/other",
              owner: { id: 7 },
              permissions: { pull: true, push: true, admin: false }
            }
          ]),
          { headers: { "x-oauth-scopes": "repo" } }
        )
      );

    await expect(createClient(fetcher).listAuthenticatedRepositories()).resolves.toEqual({
      repositories: [
        {
          id: 42,
          owner: { id: 7 },
          permissions: { pull: true, push: false, admin: false }
        },
        {
          id: 84,
          owner: { id: 7 },
          permissions: { pull: true, push: true, admin: false }
        }
      ],
      scopes: ["repo"],
      rateLimit: undefined
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[0]?.[0] as Request).url).toContain("per_page=100");
  });

  it("fails closed before an authenticated repository baseline exceeds its cap", async () => {
    const repositoriesPerPage = 100;
    const maximumPages = MAX_AUTHENTICATED_REPOSITORIES / repositoriesPerPage;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL((input as Request).url);
      const page = Number(url.searchParams.get("page"));
      const firstId = (page - 1) * repositoriesPerPage + 1;
      const nextUrl = new URL(url);
      nextUrl.searchParams.set("page", String(page + 1));
      return Response.json(
        Array.from({ length: repositoriesPerPage }, (_, index) => ({
          id: firstId + index,
          full_name: `memenow/repository-${firstId + index}`,
          owner: { id: 7 },
          permissions: { pull: true, push: false, admin: false }
        })),
        { headers: { link: `<${nextUrl.toString()}>; rel="next"` } }
      );
    });

    await expect(
      createClient(fetcher).listAuthenticatedRepositories()
    ).rejects.toMatchObject({ code: "GITHUB_PARTIAL_SYNC" });
    expect(fetcher).toHaveBeenCalledTimes(maximumPages);
  });

  it("rejects cross-origin and malformed pagination links before a second request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("[]", {
        headers: {
          link: '<https://evil.example/user/repos?page=2&per_page=100>; rel="next"'
        }
      })
    );

    await expect(
      createClient(fetcher).listAuthenticatedRepositories()
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://api.github.com/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&direction=asc&per_page=100&page=2&unexpected=true",
    "https://api.github.com/user/repos?visibility=all&sort=full_name&direction=asc&per_page=100&page=2",
    "https://api.github.com/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&direction=asc&per_page=100&page=0"
  ])("rejects an unsafe same-origin pagination target %s", async (nextUrl) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("[]", {
        headers: { link: `<${nextUrl}>; rel="next"` }
      })
    );

    await expect(
      createClient(fetcher).listAuthenticatedRepositories()
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ignores non-next pagination relations and rejects unsafe ETags", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("[]", {
        headers: {
          link:
            '<https://api.github.com/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&direction=asc&per_page=100&page=1>; rel="prev"'
        }
      })
    );
    await expect(createClient(fetcher).listAuthenticatedRepositories()).resolves.toEqual(
      expect.objectContaining({ repositories: [] })
    );
    await expect(
      createClient(vi.fn<typeof fetch>()).getAuthenticatedUser('"etag"\r\nInjected: yes')
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
  });

  it("rejects malformed repository pages, path segments, and object IDs", async () => {
    await expect(
      createClient(
        vi.fn<typeof fetch>().mockResolvedValue(Response.json([null]))
      ).listAuthenticatedRepositories()
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });

    await expect(
      createClient(vi.fn<typeof fetch>()).getRepository(
        "bad/owner",
        "edgemneme",
        REPOSITORY_ID,
        OWNER_ID
      )
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });

    const client = createClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ id: REPOSITORY_ID, owner: { id: 7 } }))
    );
    await client.getRepository("memenow", "edgemneme", REPOSITORY_ID, OWNER_ID);
    await expect(
      client.getCommit("memenow", "edgemneme", REPOSITORY_ID, "not-a-sha")
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
  });

  it("requires metadata verification before refs and content access", async () => {
    const client = createClient(vi.fn<typeof fetch>());

    await expect(
      client.getRef("memenow", "edgemneme", REPOSITORY_ID, "heads/main")
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    await expect(
      client.getBlob("memenow", "edgemneme", REPOSITORY_ID, SHA)
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
  });

  it.each([
    ["dot", "heads/./main"],
    [
      "dot-dot",
      "heads/../../../../../../repos/attacker/target/git/ref/heads/main"
    ]
  ])(
    "rejects %s ref components before URL normalization can change the target repository",
    async (_label, ref) => {
      const requestedUrls: string[] = [];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const request = input as Request;
        requestedUrls.push(request.url);
        return Response.json({ id: REPOSITORY_ID, owner: { id: OWNER_ID } });
      });
      const client = createClient(fetcher);

      await client.getRepository(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        OWNER_ID
      );
      await expect(
        client.getRef("memenow", "edgemneme", REPOSITORY_ID, ref)
      ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });

      expect(requestedUrls).toEqual([
        "https://api.github.com/repos/memenow/edgemneme"
      ]);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );

  it("loads verified refs, commits, comparisons, trees, and blobs", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL((input as Request).url);
      if (url.pathname === "/repos/memenow/edgemneme") {
        return Response.json({
          id: REPOSITORY_ID,
          owner: { id: 7 },
          default_branch: "main"
        });
      }
      if (url.pathname.includes("/git/ref/")) {
        return Response.json({
          ref: "refs/heads/main",
          object: { sha: SHA, type: "commit" }
        });
      }
      if (url.pathname.includes("/compare/")) {
        return Response.json({
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          merge_base_commit: { sha: SHA }
        });
      }
      if (url.pathname.includes("/commits/")) {
        return Response.json({ sha: SHA, tree: { sha: SHA } });
      }
      if (url.pathname.includes("/git/trees/")) {
        expect(url.searchParams.get("recursive")).toBe("1");
        return Response.json({ sha: SHA, truncated: false, tree: [] });
      }
      return Response.json({ sha: SHA, size: 3, encoding: "utf-8", content: "abc" });
    });
    const client = createClient(fetcher);

    await client.getRepository("memenow", "edgemneme", REPOSITORY_ID, OWNER_ID);
    await expect(
      client.getRef("memenow", "edgemneme", REPOSITORY_ID, "heads/main")
    ).resolves.toMatchObject({ ref: "refs/heads/main" });
    await expect(
      client.getCommit("memenow", "edgemneme", REPOSITORY_ID, SHA)
    ).resolves.toMatchObject({ sha: SHA });
    await expect(
      client.compareCommits("memenow", "edgemneme", REPOSITORY_ID, SHA, SHA)
    ).resolves.toMatchObject({ status: "ahead" });
    await expect(
      client.getTree("memenow", "edgemneme", REPOSITORY_ID, SHA)
    ).resolves.toMatchObject({ truncated: false });
    await expect(
      client.getBlob("memenow", "edgemneme", REPOSITORY_ID, SHA)
    ).resolves.toMatchObject({ content: "abc" });
  });

  it("returns ETag and rate-limit metadata for conditional refs", async () => {
    const rateLimit: GitHubRateLimit = {
      limit: 5000,
      remaining: 4999,
      used: 1,
      resetAt: 2_000_000_000_000,
      resource: "core",
      retryAfterMs: undefined
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: REPOSITORY_ID, owner: { id: 7 } })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: {
            etag: '"ref-etag"',
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-used": "1",
            "x-ratelimit-reset": "2000000000",
            "x-ratelimit-resource": "core"
          }
        })
      );
    const client = createClient(fetcher);
    await client.getRepository("memenow", "edgemneme", REPOSITORY_ID, OWNER_ID);

    await expect(
      client.getRefConditional(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        "heads/main",
        '"ref-etag"'
      )
    ).resolves.toEqual({
      status: "not_modified",
      etag: '"ref-etag"',
      scopes: [],
      rateLimit
    });
  });

  it("classifies GitHub's official classic PAT disabled response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          message:
            "Personal access token (classic) is disabled for this organization."
        },
        { status: 403 }
      )
    );

    await expect(
      createClient(fetcher).getRepository(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        OWNER_ID
      )
    ).rejects.toMatchObject({
      code: "GITHUB_CLASSIC_PAT_BLOCKED",
      retryable: false
    });
  });

  it("classifies a body-only secondary rate limit with a bounded retry delay", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."
        },
        { status: 403 }
      )
    );

    await expect(
      createClient(fetcher).getRepository(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        OWNER_ID
      )
    ).rejects.toMatchObject({
      code: "GITHUB_RATE_LIMITED",
      retryable: true,
      retryAfterMs: 60_000,
      rateLimit: undefined
    });
  });

  it("bounds a streaming 403 body without Content-Length and never exposes it", async () => {
    const confidentialMarker = "synthetic-confidential-response-body";
    const chunk = new TextEncoder().encode(
      confidentialMarker.padEnd(4_096, "x")
    );
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    });
    const response = new Response(body, { status: 403 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    const error = await createClient(fetcher)
      .getRepository("memenow", "edgemneme", REPOSITORY_ID, OWNER_ID)
      .catch((caught: unknown) => caught);

    expect(response.headers.has("content-length")).toBe(false);
    expect(error).toMatchObject({
      code: "GITHUB_PERMISSION_INSUFFICIENT",
      retryable: false
    });
    expect(String(error)).not.toContain(confidentialMarker);
    expect(pulls).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);
  });

  it.each([
    [401, {}, "GITHUB_AUTHORIZATION_REQUIRED", false, undefined],
    [403, { "x-github-sso": "required" }, "GITHUB_SSO_REQUIRED", false, undefined],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" }, "GITHUB_RATE_LIMITED", true, 2_000_000_000_000],
    [429, { "retry-after": "2" }, "GITHUB_RATE_LIMITED", true, 2_000],
    [500, {}, "GITHUB_REPOSITORY_UNAVAILABLE", true, 1_000]
  ])(
    "maps GitHub status %i without exposing a response body",
    async (status, headers, code, retryable, retryAfterMs) => {
      const client = createClient(
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status, headers }))
      );
      const rejection = expect(
        client.getRepository("memenow", "edgemneme", REPOSITORY_ID, OWNER_ID)
      ).rejects;
      await rejection.toMatchObject({ code, retryable });
      if (retryAfterMs !== undefined) {
        const error = await client
          .getRepository("memenow", "edgemneme", REPOSITORY_ID, OWNER_ID)
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          retryAfterMs: expect.any(Number)
        });
      }
    }
  );
});
