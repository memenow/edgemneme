import { z } from "zod";

export const GITHUB_PATH_ABSENT_CANDIDATE_ID_LENGTH = 225;
export const GITHUB_PATH_ABSENT_CANDIDATE_ID_PATTERN =
  /^github-path-absent-observation:[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]{64}$/u;

export const candidateIdentifierSchema = z.union([
  z.string().uuid(),
  z
    .string()
    .length(GITHUB_PATH_ABSENT_CANDIDATE_ID_LENGTH)
    .regex(GITHUB_PATH_ABSENT_CANDIDATE_ID_PATTERN)
]);

export function isCandidateIdentifier(value: unknown): value is string {
  return candidateIdentifierSchema.safeParse(value).success;
}
