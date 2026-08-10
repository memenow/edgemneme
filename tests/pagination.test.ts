import { describe, expect, it } from "vitest";
import { createPageToken, readPageToken } from "../src/security/page-token";
import { decodeBase64Url } from "../src/security/crypto";

const key = new TextEncoder().encode("synthetic-test-key-with-at-least-32-bytes");

describe("page tokens", () => {
  it("round-trips a query-bound snapshot cursor", async () => {
    const token = await createPageToken(
      {
        projectId: "project-1",
        queryDigest: "query-digest",
        snapshotVersion: 7,
        lastSortKey: "2026-07-25T00:00:00.000Z|memory-1",
        validAt: "2026-07-25T12:00:00.000Z",
        expiresAt: 2_000_000_000
      },
      key
    );

    await expect(
      readPageToken(token, key, {
        projectId: "project-1",
        queryDigest: "query-digest",
        nowEpochSeconds: 1_900_000_000
      })
    ).resolves.toMatchObject({
      snapshotVersion: 7,
      lastSortKey: expect.any(String),
      validAt: "2026-07-25T12:00:00.000Z"
    });

    const body = JSON.parse(
      new TextDecoder().decode(
        decodeBase64Url(token.slice(0, token.indexOf(".")))
      )
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ v: 2, t: "2026-07-25T12:00:00.000Z" });
  });

  it("rejects tampering, query reuse, and expiration", async () => {
    const token = await createPageToken(
      {
        projectId: "project-1",
        queryDigest: "query-a",
        snapshotVersion: 2,
        lastSortKey: "cursor",
        validAt: "2026-07-25T12:00:00.000Z",
        expiresAt: 100
      },
      key
    );

    await expect(
      readPageToken(`${token.slice(0, -1)}x`, key, {
        projectId: "project-1",
        queryDigest: "query-a",
        nowEpochSeconds: 1
      })
    ).rejects.toMatchObject({ code: "PAGE_TOKEN_INVALID" });
    await expect(
      readPageToken(token, key, {
        projectId: "project-1",
        queryDigest: "query-b",
        nowEpochSeconds: 1
      })
    ).rejects.toMatchObject({ code: "PAGE_TOKEN_INVALID" });
    await expect(
      readPageToken(token, key, {
        projectId: "project-1",
        queryDigest: "query-a",
        nowEpochSeconds: 101
      })
    ).rejects.toMatchObject({ code: "PAGE_TOKEN_INVALID" });
  });

  it("rejects an invalid validity timestamp before signing", async () => {
    await expect(
      createPageToken(
        {
          projectId: "project-1",
          queryDigest: "query-digest",
          snapshotVersion: 7,
          lastSortKey: "cursor",
          validAt: "not-a-timestamp",
          expiresAt: 2_000_000_000
        },
        key
      )
    ).rejects.toThrow("validity timestamp");
  });
});
