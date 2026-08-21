import { describe, expect, it } from "vitest";
import { createPageToken, readPageToken } from "../src/security/page-token";
import { decodeBase64Url } from "../src/security/crypto";

describe("page tokens", () => {
  it("round-trips a query-bound snapshot cursor", () => {
    const token = createPageToken({
      projectId: "project-1",
      queryDigest: "query-digest",
      snapshotVersion: 7,
      lastSortKey: "2026-07-25T00:00:00.000Z|memory-1",
      validAt: "2026-07-25T12:00:00.000Z",
      expiresAt: 2_000_000_000
    });

    expect(
      readPageToken(token, {
        projectId: "project-1",
        queryDigest: "query-digest",
        nowEpochSeconds: 1_900_000_000
      })
    ).toMatchObject({
      snapshotVersion: 7,
      lastSortKey: expect.any(String),
      validAt: "2026-07-25T12:00:00.000Z"
    });

    const body = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(token))
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ v: 3, t: "2026-07-25T12:00:00.000Z" });
  });

  it("rejects malformed tokens, query reuse, and expiration", () => {
    const token = createPageToken({
      projectId: "project-1",
      queryDigest: "query-a",
      snapshotVersion: 2,
      lastSortKey: "cursor",
      validAt: "2026-07-25T12:00:00.000Z",
      expiresAt: 100
    });

    expect(() =>
      readPageToken(`${token.slice(0, -1)}x`, {
        projectId: "project-1",
        queryDigest: "query-a",
        nowEpochSeconds: 1
      })
    ).toThrow(expect.objectContaining({ code: "PAGE_TOKEN_INVALID" }));
    expect(() =>
      readPageToken(token, {
        projectId: "project-1",
        queryDigest: "query-b",
        nowEpochSeconds: 1
      })
    ).toThrow(expect.objectContaining({ code: "PAGE_TOKEN_INVALID" }));
    expect(() =>
      readPageToken(token, {
        projectId: "project-1",
        queryDigest: "query-a",
        nowEpochSeconds: 101
      })
    ).toThrow(expect.objectContaining({ code: "PAGE_TOKEN_INVALID" }));
  });

  it("rejects an invalid validity timestamp", () => {
    expect(() =>
      createPageToken({
        projectId: "project-1",
        queryDigest: "query-digest",
        snapshotVersion: 7,
        lastSortKey: "cursor",
        validAt: "not-a-timestamp",
        expiresAt: 2_000_000_000
      })
    ).toThrow("validity timestamp");
  });
});
