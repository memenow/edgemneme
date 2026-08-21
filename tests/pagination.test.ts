import { describe, expect, it } from "vitest";
import { createPageToken, readPageToken } from "../src/security/page-token";
import { decodeBase64Url } from "../src/security/crypto";

describe("page tokens", () => {
  it("round-trips a query-bound snapshot cursor", () => {
    const token = createPageToken({
      projectId: "project-1",
      queryDigest: "query-digest",
      snapshotVersion: 7,
      lastSortKey: "2026-07-25T00:00:00.000Z|memory-1"
    });

    expect(
      readPageToken(token, {
        projectId: "project-1",
        queryDigest: "query-digest"
      })
    ).toEqual({
      projectId: "project-1",
      queryDigest: "query-digest",
      snapshotVersion: 7,
      lastSortKey: "2026-07-25T00:00:00.000Z|memory-1"
    });

    const body = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(token))
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ v: 4 });
    expect(body).not.toHaveProperty("t");
    expect(body).not.toHaveProperty("e");
  });

  it("rejects malformed tokens and query or project reuse", () => {
    const token = createPageToken({
      projectId: "project-1",
      queryDigest: "query-a",
      snapshotVersion: 2,
      lastSortKey: "cursor"
    });

    expect(() =>
      readPageToken(`${token.slice(0, -1)}x`, {
        projectId: "project-1",
        queryDigest: "query-a"
      })
    ).toThrow(expect.objectContaining({ code: "PAGE_TOKEN_INVALID" }));
    expect(() =>
      readPageToken(token, {
        projectId: "project-1",
        queryDigest: "query-b"
      })
    ).toThrow(expect.objectContaining({ code: "PAGE_TOKEN_INVALID" }));
    expect(() =>
      readPageToken(token, {
        projectId: "project-2",
        queryDigest: "query-a"
      })
    ).toThrow(expect.objectContaining({ code: "PAGE_TOKEN_INVALID" }));
  });
});
