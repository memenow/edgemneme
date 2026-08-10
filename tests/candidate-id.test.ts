import { describe, expect, it } from "vitest";
import {
  GITHUB_PATH_ABSENT_CANDIDATE_ID_LENGTH,
  candidateIdentifierSchema,
  isCandidateIdentifier
} from "../src/contracts/candidate-id";

const deletionCandidateId =
  `github-path-absent-observation:${"a".repeat(64)}:` +
  `${"b".repeat(64)}:${"c".repeat(64)}`;

describe("candidate identifier contract", () => {
  it("accepts UUID and exact GitHub path-absence candidate identifiers", () => {
    expect(
      candidateIdentifierSchema.safeParse(
        "00000000-0000-4000-8000-000000000001"
      ).success
    ).toBe(true);
    expect(deletionCandidateId).toHaveLength(
      GITHUB_PATH_ABSENT_CANDIDATE_ID_LENGTH
    );
    expect(candidateIdentifierSchema.safeParse(deletionCandidateId).success).toBe(true);
    expect(isCandidateIdentifier(deletionCandidateId)).toBe(true);
  });

  it.each([
    ["wrong prefix", deletionCandidateId.replace("observation", "candidate")],
    [
      "uppercase digest",
      `github-path-absent-observation:A${"a".repeat(63)}:${"b".repeat(64)}:${"c".repeat(64)}`
    ],
    [
      "short digest",
      `github-path-absent-observation:${"a".repeat(63)}:${"b".repeat(64)}:${"c".repeat(64)}`
    ],
    [
      "long digest",
      `github-path-absent-observation:${"a".repeat(65)}:${"b".repeat(64)}:${"c".repeat(64)}`
    ],
    ["leading whitespace", ` ${deletionCandidateId}`],
    ["trailing whitespace", `${deletionCandidateId} `],
    ["NUL byte", `${deletionCandidateId}\0`]
  ])("rejects %s", (_label, candidateId) => {
    expect(candidateIdentifierSchema.safeParse(candidateId).success).toBe(false);
    expect(isCandidateIdentifier(candidateId)).toBe(false);
  });
});
