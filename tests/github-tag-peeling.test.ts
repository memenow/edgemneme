import { describe, expect, it, vi } from "vitest";
import {
  GitHubReadOnlyClient,
  MAX_GITHUB_ANNOTATED_TAG_PEEL_REQUESTS,
  type GitReference
} from "../src/github/client";

const REPOSITORY_ID = 42;
const OWNER_ID = 7;
const COMMIT_SHA = "c".repeat(40);
const TAG_SHA = "a".repeat(40);
const SECOND_TAG_SHA = "b".repeat(40);

describe("GitHub annotated tag peeling", () => {
  it("keeps lightweight tags at their direct commit without another request", async () => {
    const fetcher = metadataOnlyFetcher();
    const client = await createVerifiedClient(fetcher);

    await expect(
      client.peelReferenceToCommit(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        "refs/tags/release",
        reference("refs/tags/release", COMMIT_SHA, "commit")
      )
    ).resolves.toBe(COMMIT_SHA);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("peels a bounded annotated-tag chain to its commit", async () => {
    const requestedPaths: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL((input as Request).url).pathname;
      requestedPaths.push(path);
      if (path === "/repos/memenow/edgemneme") {
        return metadataResponse();
      }
      if (path.endsWith(`/git/tags/${TAG_SHA}`)) {
        return Response.json({
          sha: TAG_SHA,
          object: { sha: SECOND_TAG_SHA, type: "tag" }
        });
      }
      if (path.endsWith(`/git/tags/${SECOND_TAG_SHA}`)) {
        return Response.json({
          sha: SECOND_TAG_SHA,
          object: { sha: COMMIT_SHA, type: "commit" }
        });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const client = await createVerifiedClient(fetcher);

    await expect(
      client.peelReferenceToCommit(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        "refs/tags/release",
        reference("refs/tags/release", TAG_SHA, "tag")
      )
    ).resolves.toBe(COMMIT_SHA);
    expect(requestedPaths).toEqual([
      "/repos/memenow/edgemneme",
      `/repos/memenow/edgemneme/git/tags/${TAG_SHA}`,
      `/repos/memenow/edgemneme/git/tags/${SECOND_TAG_SHA}`
    ]);
  });

  it("still requires heads to point directly to commits", async () => {
    const fetcher = metadataOnlyFetcher();
    const client = await createVerifiedClient(fetcher);

    await expect(
      client.peelReferenceToCommit(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        "refs/heads/main",
        reference("refs/heads/main", TAG_SHA, "tag")
      )
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["tree", "blob"])(
    "rejects an annotated tag that terminates at a %s",
    async (type) => {
      const fetcher = tagFetcher(() => ({
        sha: TAG_SHA,
        object: { sha: COMMIT_SHA, type }
      }));
      const client = await createVerifiedClient(fetcher);

      await expect(
        client.peelReferenceToCommit(
          "memenow",
          "edgemneme",
          REPOSITORY_ID,
          "refs/tags/release",
          reference("refs/tags/release", TAG_SHA, "tag")
        )
      ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    }
  );

  it("rejects a tag response that does not match the requested object", async () => {
    const fetcher = tagFetcher(() => ({
      sha: SECOND_TAG_SHA,
      object: { sha: COMMIT_SHA, type: "commit" }
    }));
    const client = await createVerifiedClient(fetcher);

    await expect(
      client.peelReferenceToCommit(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        "refs/tags/release",
        reference("refs/tags/release", TAG_SHA, "tag")
      )
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
  });

  it("detects cycles before requesting the same annotated tag twice", async () => {
    const fetcher = tagFetcher((sha) => ({
      sha,
      object: {
        sha: sha === TAG_SHA ? SECOND_TAG_SHA : TAG_SHA,
        type: "tag"
      }
    }));
    const client = await createVerifiedClient(fetcher);

    await expect(
      client.peelReferenceToCommit(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        "refs/tags/release",
        reference("refs/tags/release", TAG_SHA, "tag")
      )
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fails partially at the annotated-tag peel request bound", async () => {
    const tagShas = Array.from(
      { length: MAX_GITHUB_ANNOTATED_TAG_PEEL_REQUESTS + 1 },
      (_, index) => (index + 1).toString(16).repeat(40)
    );
    const fetcher = tagFetcher((sha) => {
      const index = tagShas.indexOf(sha);
      const nextSha = tagShas[index + 1];
      if (index < 0 || nextSha === undefined) {
        throw new Error(`unexpected tag ${sha}`);
      }
      return { sha, object: { sha: nextSha, type: "tag" } };
    });
    const client = await createVerifiedClient(fetcher);

    await expect(
      client.peelReferenceToCommit(
        "memenow",
        "edgemneme",
        REPOSITORY_ID,
        "refs/tags/release",
        reference("refs/tags/release", tagShas[0] ?? "", "tag")
      )
    ).rejects.toMatchObject({ code: "GITHUB_PARTIAL_SYNC" });
    expect(fetcher).toHaveBeenCalledTimes(
      MAX_GITHUB_ANNOTATED_TAG_PEEL_REQUESTS + 1
    );
  });
});

function reference(ref: string, sha: string, type: string): GitReference {
  return { ref, object: { sha, type } };
}

async function createVerifiedClient(
  fetcher: typeof fetch
): Promise<GitHubReadOnlyClient> {
  const client = new GitHubReadOnlyClient({
    token: "synthetic-token",
    fetcher,
    allowedRepositoryIds: new Set([REPOSITORY_ID])
  });
  await client.getRepository(
    "memenow",
    "edgemneme",
    REPOSITORY_ID,
    OWNER_ID
  );
  return client;
}

function metadataOnlyFetcher(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockResolvedValue(metadataResponse());
}

function tagFetcher(
  tag: (sha: string) => { sha: string; object: { sha: string; type: string } }
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const path = new URL((input as Request).url).pathname;
    if (path === "/repos/memenow/edgemneme") {
      return metadataResponse();
    }
    const sha = path.split("/").at(-1);
    if (sha === undefined) {
      throw new Error(`missing tag SHA in ${path}`);
    }
    return Response.json(tag(sha));
  });
}

function metadataResponse(): Response {
  return Response.json({ id: REPOSITORY_ID, owner: { id: OWNER_ID } });
}
