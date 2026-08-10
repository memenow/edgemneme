import { sha256 } from "../security/crypto";

export interface GitHubCandidateEvidenceIdentity {
  evidenceId: string;
  locator: string;
  repositoryId: string;
  repositoryRef: string;
  repositoryPath: string | null;
  repositoryAuthority: "default_branch" | "tracked_ref";
  excerptHash: string;
  sensitivityStatus: "clear" | "tombstone";
}

export async function buildGitHubBlobEvidenceId(input: {
  projectId: string;
  repositoryId: string;
  externalRepositoryId: number;
  repositoryRef: string;
  observedSha: string;
  repositoryPath: string;
  blobSha: string;
  sensitivityStatus: "clear" | "tombstone";
}): Promise<string> {
  return await sha256(
    [
      input.sensitivityStatus === "tombstone"
        ? "github.blob.evidence.tombstone"
        : "github.blob.evidence.clear",
      input.projectId,
      input.repositoryId,
      String(input.externalRepositoryId),
      input.repositoryRef,
      input.observedSha,
      input.repositoryPath,
      input.blobSha
    ].join("\n")
  );
}

export async function buildGitHubClearEvidenceLocator(input: {
  externalRepositoryId: number;
  repositoryRef: string;
  observedSha: string;
  repositoryPath: string;
}): Promise<string> {
  const encodedPath = input.repositoryPath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const refDigest = await sha256(
    ["github.ref", input.repositoryRef].join("\n")
  );
  return (
    `github://${input.externalRepositoryId}/${input.observedSha}/` +
    `ref-sha256/${refDigest}/${encodedPath}`
  );
}

export async function buildGitHubTombstoneEvidenceLocator(input: {
  externalRepositoryId: number;
  repositoryRef: string;
  observedSha: string;
  repositoryPath: string;
}): Promise<string> {
  const pathIdentityDigest = await sha256(
    ["github.blob.path", input.repositoryRef, input.repositoryPath].join("\n")
  );
  return (
    `github://${input.externalRepositoryId}/${input.observedSha}/path-sha256/` +
    pathIdentityDigest
  );
}
