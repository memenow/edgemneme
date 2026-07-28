import { describe, expect, it } from "vitest";
import { readGatewayResource } from "../src/gateway/resources";
import type { GatewayEnv } from "../src/gateway/types";
import type { AuthenticatedPrincipal } from "../src/security/auth";
import { sha256 } from "../src/security/crypto";

const principal: AuthenticatedPrincipal = {
  principalId: "principal-1",
  projectId: "project-1",
  role: "reader"
};

describe("gateway resource disclosure boundaries", () => {
  it("rejects an active snapshot pointer to another project's valid R2 manifest", async () => {
    const foreignManifestKey =
      "projects/project-2/projections/4/manifest.json";
    const foreignManifestBody = JSON.stringify({
      schema_version: 1,
      project_id: "project-2",
      project_version: 4,
      snapshot_id: "4",
      memories: [],
      revisions: [],
      files: []
    });
    const foreignManifestSha = await sha256(foreignManifestBody);
    const env = projectionEnvironment({
      manifestBody: foreignManifestBody,
      manifestSha: foreignManifestSha,
      manifestKey: foreignManifestKey
    });

    await expect(
      readGatewayResource(
        env,
        principal,
        new URL("memory://projects/project-1/manifest"),
        {}
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  });

  it.each(["quarantined", "tombstone"] as const)(
    "redacts sensitive fields from %s evidence resources",
    async (sensitivityStatus) => {
      const evidence = {
        evidence_id: `evidence-${sensitivityStatus}`,
        source_type: "github_blob",
        locator: "github://owner/private-repository/secret.env",
        repository_id: "repository-secret",
        repository_ref: "refs/heads/main",
        repository_path: "secret.env",
        commit_sha: "a".repeat(40),
        excerpt_hash: "b".repeat(64),
        object_uri: "r2://private/raw-sensitive-evidence",
        sensitivity_status: sensitivityStatus,
        recorded_at: "2026-07-28T00:00:00.000Z"
      };
      const body = await readGatewayResource(
        evidenceResourceEnvironment(evidence),
        principal,
        new URL(`memory://projects/project-1/evidence/${evidence.evidence_id}`),
        { evidence_id: evidence.evidence_id }
      );

      expect(JSON.parse(body)).toEqual({
        evidence_id: evidence.evidence_id,
        sensitivity_status: sensitivityStatus,
        recorded_at: evidence.recorded_at
      });
      for (const secret of [
        evidence.source_type,
        evidence.locator,
        evidence.repository_id,
        evidence.repository_ref,
        evidence.repository_path,
        evidence.commit_sha,
        evidence.excerpt_hash,
        evidence.object_uri
      ]) {
        expect(body).not.toContain(secret);
      }
    }
  );

  it("returns complete clear evidence metadata", async () => {
    const evidence = {
      evidence_id: "evidence-clear",
      source_type: "github_blob",
      locator: "github://owner/repository/src/index.ts",
      repository_id: "repository-1",
      repository_ref: "refs/heads/main",
      repository_path: "src/index.ts",
      commit_sha: "a".repeat(40),
      excerpt_hash: "b".repeat(64),
      object_uri: "r2://private/clear-evidence",
      sensitivity_status: "clear",
      recorded_at: "2026-07-28T00:00:00.000Z"
    };

    const body = await readGatewayResource(
      evidenceResourceEnvironment(evidence),
      principal,
      new URL("memory://projects/project-1/evidence/evidence-clear"),
      { evidence_id: "evidence-clear" }
    );

    expect(JSON.parse(body)).toEqual(evidence);
  });
});

function projectionEnvironment(input: {
  manifestBody: string;
  manifestSha: string;
  manifestKey: string;
}): GatewayEnv {
  return {
    MEMORY_DB: {
      withSession: authorizedSession,
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return {
              snapshot_id: "project-1:4",
              project_version: 4,
              manifest_key: input.manifestKey,
              manifest_sha256: input.manifestSha
            };
          }
        };
      }
    },
    PROJECTIONS: {
      async get(key: string) {
        return key === input.manifestKey
          ? checkedObject(input.manifestBody, input.manifestSha)
          : null;
      }
    }
  } as unknown as GatewayEnv;
}

function evidenceResourceEnvironment(row: Record<string, unknown>): GatewayEnv {
  return {
    MEMORY_DB: {
      withSession: authorizedSession,
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return row;
          }
        };
      }
    }
  } as unknown as GatewayEnv;
}

function authorizedSession() {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return { authorized: 1 };
        }
      };
    }
  };
}

function checkedObject(body: string, metadataSha: string) {
  return {
    customMetadata: { sha256: metadataSha },
    async text() {
      return body;
    }
  };
}
