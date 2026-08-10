import { describe, expect, it, vi } from "vitest";
import { GitHubReadOnlyClient } from "../src/github/client";

const REPOSITORY_QUERY =
  "visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member" +
  "&sort=full_name&direction=asc&per_page=100";

describe("GitHub repository pagination", () => {
  it.each([
    [
      "quoted multiple relations and extension parameters",
      `</user/repos?${REPOSITORY_QUERY}&page=2>; type="application/json"; ` +
        'rel="alternate next"; title="page, two"; marker'
    ],
    [
      "an unquoted relation token",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel=next`
    ]
  ])("accepts %s", async (_label, link) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("[]", { headers: { link } }))
      .mockResolvedValueOnce(new Response("[]"));

    await expect(createClient(fetcher).listAuthenticatedRepositories()).resolves.toEqual(
      expect.objectContaining({ repositories: [] })
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((fetcher.mock.calls[1]?.[0] as Request).url).toContain("page=2");
  });

  it.each([
    ["plain text", "not-a-link"],
    [
      "an unterminated target",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2; rel=next`
    ],
    [
      "a rel parameter without a value",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel`
    ],
    [
      "duplicate rel parameters",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel=next; rel=prev`
    ],
    [
      "a duplicate next relation token",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel="next next"`
    ],
    [
      "duplicate identical next links",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel=next, ` +
        `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel=next`
    ],
    [
      "conflicting next links",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel=next, ` +
        `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=3>; rel=next`
    ],
    [
      "a malformed link after a valid non-next link",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=1>; rel=prev, broken`
    ],
    [
      "an unterminated quoted extension parameter",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; ` +
        'rel=next; title="unterminated'
    ],
    [
      "a trailing comma",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel=next,`
    ],
    [
      "garbage after a link value",
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel=next garbage`
    ]
  ])("fails closed on %s", async (_label, link) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("[]", { headers: { link } }));

    await expect(
      createClient(fetcher).listAuthenticatedRepositories()
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a repeated page", "1"],
    ["a skipped page", "3"],
    ["an unsafe integer page", "9007199254740992"]
  ])("rejects %s before following it", async (_label, page) => {
    const link =
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=${page}>; rel=next`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("[]", { headers: { link } }));

    await expect(
      createClient(fetcher).listAuthenticatedRepositories()
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-monotonic page after following a valid next page", async () => {
    const pageTwo =
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel=next`;
    const repeatedPageTwo =
      `<https://api.github.com/user/repos?${REPOSITORY_QUERY}&page=2>; rel=next`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("[]", { headers: { link: pageTwo } }))
      .mockResolvedValueOnce(
        new Response("[]", { headers: { link: repeatedPageTwo } })
      );

    await expect(
      createClient(fetcher).listAuthenticatedRepositories()
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

function createClient(fetcher: typeof fetch): GitHubReadOnlyClient {
  return new GitHubReadOnlyClient({
    token: "synthetic-token",
    fetcher,
    allowedRepositoryIds: new Set()
  });
}
