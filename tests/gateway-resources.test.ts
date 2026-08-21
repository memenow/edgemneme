import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AuthenticatedPrincipal } from "../src/security/auth";
import type { GatewayEnv } from "../src/gateway/service";
import { readGatewayResource } from "../src/gateway/resources";
import { sha256 } from "../src/security/crypto";

const principal: AuthenticatedPrincipal = {
  principalId: "principal-1",
  projectId: "project-1",
  role: "reader"
};

describe("gateway resources", () => {
  it("serves only checksum-verified files listed by the active manifest", async () => {
    const indexKey =
      "projects/project-1/projections/4/indexes/by-kind/decision/index.json";
    const indexBody = JSON.stringify({ memories: ["memory-1"] });
    const indexSha = await sha256(indexBody);
    const manifestBody = JSON.stringify({
      schema_version: 1,
      project_id: "project-1",
      project_version: 4,
      snapshot_id: "4",
      memories: [],
      revisions: [],
      files: [{ key: indexKey, sha256: indexSha }]
    });
    const manifestSha = await sha256(manifestBody);
    const env = projectionEnvironment({
      manifestBody,
      manifestSha,
      objects: new Map([
        [
          "projects/project-1/projections/4/manifest.json",
          checkedObject(manifestBody, manifestSha)
        ],
        [indexKey, checkedObject(indexBody, indexSha)]
      ])
    });

    await expect(
      readGatewayResource(
        env,
        principal,
        new URL("memory://projects/project-1/manifest"),
        {}
      )
    ).resolves.toBe(manifestBody);
    await expect(
      readGatewayResource(
        env,
        principal,
        new URL("memory://projects/project-1/indexes/by-kind/decision"),
        { kind: "decision" }
      )
    ).resolves.toBe(indexBody);
  });

  it("fails closed when R2 metadata or bytes do not match D1 and the manifest", async () => {
    const manifestBody = projectionManifest([]);
    const manifestSha = await sha256(manifestBody);
    const env = projectionEnvironment({
      manifestBody,
      manifestSha,
      objects: new Map([
        [
          "projects/project-1/projections/4/manifest.json",
          checkedObject(manifestBody, "0".repeat(64))
        ]
      ])
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

  it("binds current and historical memory reads to the authenticated project and scope grants", async () => {
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    const row = {
      memory_id: "memory-1",
      memory_version: 2,
      revision_id: "revision-2",
      content: "D1 is authoritative."
    };
    const database = {
      withSession(constraint: string) {
        expect(constraint).toBe("first-primary");
        return {
          prepare(sql: string) {
            const call = { sql, bindings: [] as unknown[] };
            calls.push(call);
            return {
              bind(...bindings: unknown[]) {
                call.bindings = bindings;
                return this;
              },
              async first() {
                return row;
              }
            };
          }
        };
      }
    };
    const env = { MEMORY_DB: database } as unknown as GatewayEnv;

    await expect(
      readGatewayResource(
        env,
        principal,
        new URL("memory://projects/project-1/memories/memory-1"),
        { memory_id: "memory-1" }
      )
    ).resolves.toContain("D1 is authoritative.");
    await expect(
      readGatewayResource(
        env,
        principal,
        new URL("memory://projects/project-1/memories/memory-1/versions/2"),
        { memory_id: "memory-1", version: "2" }
      )
    ).resolves.toContain('"memory_version": 2');

    expect(calls[0]?.sql).toContain("grant_row.principal_id = ?");
    expect(calls[0]?.sql).toContain("memory_repository_contexts");
    expect(calls[0]?.sql).toContain("project_grant_repository_contexts");
    expect(calls[0]?.sql).toContain("v.revision_id = m.current_revision_id");
    expect(calls[0]?.bindings).toEqual(["project-1", "memory-1", "principal-1"]);
    expect(calls[1]?.bindings).toEqual(["project-1", "memory-1", 2, "principal-1"]);
  });

  it("enforces repository hierarchy for shared, repository, and historical memories", async () => {
    const database = resourceAuthorizationDatabase();
    const env = { MEMORY_DB: asD1(database) } as unknown as GatewayEnv;
    const projectPrincipal = resourcePrincipal("principal-maintainer-1", "project-1");
    const repositoryAPrincipal = resourcePrincipal("principal-repository-a", "project-1");
    const repositoryBPrincipal = resourcePrincipal("principal-repository-b", "project-1");
    const otherProjectPrincipal = resourcePrincipal("principal-other-project", "project-2");

    await expect(
      readGatewayResource(
        env,
        repositoryAPrincipal,
        new URL("memory://projects/project-1/memories/memory-shared"),
        { memory_id: "memory-shared" }
      )
    ).resolves.toContain("Shared current content");
    await expect(
      readGatewayResource(
        env,
        repositoryAPrincipal,
        new URL("memory://projects/project-1/memories/memory-repository-a"),
        { memory_id: "memory-repository-a" }
      )
    ).resolves.toContain("Repository A current content");
    await expect(
      readGatewayResource(
        env,
        repositoryAPrincipal,
        new URL("memory://projects/project-1/memories/memory-repository-a/versions/1"),
        { memory_id: "memory-repository-a", version: "1" }
      )
    ).resolves.toContain("Repository A historical content");
    await expect(
      readGatewayResource(
        env,
        projectPrincipal,
        new URL("memory://projects/project-1/memories/memory-repository-b"),
        { memory_id: "memory-repository-b" }
      )
    ).resolves.toContain("Repository B content");

    await expect(
      readGatewayResource(
        env,
        repositoryAPrincipal,
        new URL("memory://projects/project-1/memories/memory-repository-b"),
        { memory_id: "memory-repository-b" }
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
    await expect(
      readGatewayResource(
        env,
        repositoryBPrincipal,
        new URL("memory://projects/project-1/memories/memory-repository-a/versions/1"),
        { memory_id: "memory-repository-a", version: "1" }
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
    await expect(
      readGatewayResource(
        env,
        otherProjectPrincipal,
        new URL("memory://projects/project-2/memories/memory-repository-a"),
        { memory_id: "memory-repository-a" }
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });

    for (const resource of [
      {
        uri: "memory://projects/project-1/manifest",
        values: {}
      },
      {
        uri: "memory://projects/project-1/indexes/by-kind/fact",
        values: { kind: "fact" }
      },
      {
        uri: "memory://projects/project-1/candidates/candidate-secret",
        values: { candidate_id: "candidate-secret" }
      },
      {
        uri: "memory://projects/project-1/evidence/evidence-secret",
        values: { evidence_id: "evidence-secret" }
      },
      {
        uri: "memory://projects/project-1/workflows/workflow-secret",
        values: { workflow_id: "workflow-secret" }
      },
      {
        uri: "memory://projects/project-1/audit/audit-1",
        values: { audit_id: "audit-1" }
      }
    ]) {
      await expect(
        readGatewayResource(
          env,
          repositoryAPrincipal,
          new URL(resource.uri),
          resource.values
        )
      ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
    }
  });

  it("does not disclose whether a project-only resource is missing or unauthorized", async () => {
    const deniedDatabase = {
      withSession: () => ({
        prepare: () => ({
          bind() {
            return this;
          },
          async first() {
            return null;
          }
        })
      })
    };
    const deniedEnv = { MEMORY_DB: deniedDatabase } as unknown as GatewayEnv;

    await expect(
      readGatewayResource(
        deniedEnv,
        principal,
        new URL("memory://projects/project-1/candidates/candidate-secret"),
        { candidate_id: "candidate-secret" }
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });

    const missingDatabase = {
      withSession: authorizedSession,
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          }
        };
      }
    };
    await expect(
      readGatewayResource(
        { MEMORY_DB: missingDatabase } as unknown as GatewayEnv,
        principal,
        new URL("memory://projects/project-1/candidates/candidate-missing"),
        { candidate_id: "candidate-missing" }
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  });

  it("rejects invalid memory versions without touching D1", async () => {
    let prepared = false;
    const env = {
      MEMORY_DB: {
        prepare() {
          prepared = true;
          throw new Error("D1 should not be queried.");
        }
      }
    } as unknown as GatewayEnv;

    await expect(
      readGatewayResource(
        env,
        principal,
        new URL("memory://projects/project-1/memories/memory-1/versions/0"),
        { memory_id: "memory-1", version: "0" }
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
    expect(prepared).toBe(false);
  });

  it.each([
    ["candidates", "candidate_id", "candidate-1"],
    ["evidence", "evidence_id", "evidence-1"],
    ["workflows", "workflow_id", "workflow-1"],
    ["audit", "audit_id", "audit-1"]
  ])("reads project-scoped %s resources", async (segment, valueKey, resourceId) => {
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    const database = {
      withSession: authorizedSession,
      prepare(sql: string) {
        const call = { sql, bindings: [] as unknown[] };
        calls.push(call);
        return {
          bind(...bindings: unknown[]) {
            call.bindings = bindings;
            return this;
          },
          async first() {
            return segment === "evidence"
              ? {
                  evidence_id: resourceId,
                  sensitivity_status: "clear",
                  recorded_at: "2026-07-28T00:00:00.000Z"
                }
              : { id: resourceId };
          }
        };
      }
    };

    await expect(
      readGatewayResource(
        { MEMORY_DB: database } as unknown as GatewayEnv,
        principal,
        new URL(`memory://projects/project-1/${segment}/${resourceId}`),
        { [valueKey]: resourceId }
      )
    ).resolves.toContain(resourceId);
    expect(calls[0]?.bindings).toEqual(
      segment === "workflows"
        ? ["project-1", resourceId, resourceId]
        : ["project-1", resourceId]
    );
  });

  it("rejects missing, unlisted, and malformed projection objects", async () => {
    const missingSnapshotDb = {
      withSession: authorizedSession,
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          }
        };
      }
    };
    await expect(
      readGatewayResource(
        {
          MEMORY_DB: missingSnapshotDb,
          PROJECTIONS: { get: async () => null }
        } as unknown as GatewayEnv,
        principal,
        new URL("memory://projects/project-1/manifest"),
        {}
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });

    for (const manifestBody of [
      "not-json",
      JSON.stringify({ files: "invalid" }),
      projectionManifest([])
    ]) {
      const manifestSha = await sha256(manifestBody);
      const env = projectionEnvironment({
        manifestBody,
        manifestSha,
        objects: new Map([
          [
            "projects/project-1/projections/4/manifest.json",
            checkedObject(manifestBody, manifestSha)
          ]
        ])
      });
      await expect(
        readGatewayResource(
          env,
          principal,
          new URL("memory://projects/project-1/indexes/by-class/semantic"),
          { memory_class: "semantic" }
        )
      ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
    }
  });

  it("rejects an unknown resource route and a missing project row", async () => {
    const database = {
      withSession: authorizedSession,
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          }
        };
      }
    };
    const env = { MEMORY_DB: database } as unknown as GatewayEnv;

    await expect(
      readGatewayResource(
        env,
        principal,
        new URL("memory://projects/project-1/unknown/value"),
        {}
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
    await expect(
      readGatewayResource(
        env,
        principal,
        new URL("memory://projects/project-1/candidates/candidate-1"),
        { candidate_id: "candidate-1" }
      )
    ).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  });
});

function projectionEnvironment(input: {
  manifestBody: string;
  manifestSha: string;
  manifestKey?: string;
  objects: Map<string, ReturnType<typeof checkedObject>>;
}): GatewayEnv {
  const database = {
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
            manifest_key:
              input.manifestKey ??
              "projects/project-1/projections/4/manifest.json",
            manifest_sha256: input.manifestSha
          };
        }
      };
    }
  };
  const bucket = {
    async get(key: string) {
      return input.objects.get(key) ?? null;
    }
  };
  return {
    MEMORY_DB: database,
    PROJECTIONS: bucket
  } as unknown as GatewayEnv;
}

function projectionManifest(files: Array<{ key: string; sha256: string }>): string {
  return JSON.stringify({
    schema_version: 1,
    project_id: "project-1",
    project_version: 4,
    snapshot_id: "4",
    memories: [],
    revisions: [],
    files
  });
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

function resourcePrincipal(
  principalId: string,
  projectId: string
): AuthenticatedPrincipal {
  return { principalId, projectId, role: "reader" };
}

function resourceAuthorizationDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "migrations/0001_initial.sql"
  ]) {
    database.exec(readFileSync(migration, "utf8"));
  }
  const now = "2026-07-27T00:00:00.000Z";
  database.exec(`
    INSERT INTO projects
      (project_id, project_ref, locator, display_name, created_at, updated_at)
    VALUES
      ('project-1', 'project-1', 'locator-1', 'Project 1', '${now}', '${now}'),
      ('project-2', 'project-2', 'locator-2', 'Project 2', '${now}', '${now}');
    INSERT INTO repositories
      (repository_id, project_id, provider, external_id, owner, name, created_at, updated_at)
    VALUES
      ('repository-a', 'project-1', 'github', 301, 'owner', 'a', '${now}', '${now}'),
      ('repository-b', 'project-1', 'github', 302, 'owner', 'b', '${now}', '${now}'),
      ('repository-c', 'project-2', 'github', 303, 'owner', 'c', '${now}', '${now}');
    INSERT INTO principals
      (principal_id, issuer, subject, token_digest, created_at)
    VALUES
      ('principal-maintainer-1', 'test', 'maintainer-1', 'digest-maintainer-1', '${now}'),
      ('principal-maintainer-2', 'test', 'maintainer-2', 'digest-maintainer-2', '${now}'),
      ('principal-repository-a', 'test', 'repository-a', 'digest-repository-a', '${now}'),
      ('principal-repository-b', 'test', 'repository-b', 'digest-repository-b', '${now}'),
      ('principal-other-project', 'test', 'other-project', 'digest-other-project', '${now}');
    INSERT INTO project_grants
      (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at)
    VALUES
      ('grant-maintainer-1', 'project-1', 'principal-maintainer-1', 'maintainer',
       'project', 'project-1', '${now}'),
      ('grant-maintainer-2', 'project-2', 'principal-maintainer-2', 'maintainer',
       'project', 'project-2', '${now}'),
      ('grant-repository-a', 'project-1', 'principal-repository-a', 'reader',
       'repository', 'repository-a', '${now}'),
      ('grant-repository-b', 'project-1', 'principal-repository-b', 'reader',
       'repository', 'repository-b', '${now}'),
      ('grant-other-project', 'project-2', 'principal-other-project', 'reader',
       'project', 'project-2', '${now}');
    INSERT INTO project_grant_repository_contexts
      (project_id, grant_id, repository_id, created_at)
    VALUES
      ('project-1', 'grant-repository-a', 'repository-a', '${now}'),
      ('project-1', 'grant-repository-b', 'repository-b', '${now}');
    INSERT INTO audit_events
      (audit_id, project_id, sequence, event_type, actor_principal_id, request_digest,
       event_hash, recorded_at)
    VALUES
      ('audit-1', 'project-1', 1, 'memory.promoted', 'principal-maintainer-1',
       'request-1', 'event-1', '${now}'),
      ('audit-2', 'project-2', 1, 'memory.promoted', 'principal-maintainer-2',
       'request-2', 'event-2', '${now}');
    INSERT INTO observations
      (observation_id, project_id, principal_id, status, content, content_sha256,
       created_at, updated_at)
    VALUES
      ('candidate-secret', 'project-1', 'principal-maintainer-1', 'queued',
       'Candidate metadata', 'candidate-sha', '${now}', '${now}');
    INSERT INTO evidence
      (evidence_id, project_id, source_type, locator, excerpt_hash,
       sensitivity_status, recorded_at)
    VALUES
      ('evidence-secret', 'project-1', 'manual', 'manual:evidence-secret',
       'evidence-sha', 'clear', '${now}');
    INSERT INTO workflow_runs
      (workflow_id, root_workflow_id, project_id, workflow_type, status,
       created_at, updated_at)
    VALUES
      ('workflow-secret', 'workflow-secret', 'project-1', 'candidate_quality',
       'queued', '${now}', '${now}');
    INSERT INTO memories
      (memory_id, project_id, current_revision_id, memory_version, kind, memory_class,
       scope, scope_id, status, created_at, updated_at)
    VALUES
      ('memory-shared', 'project-1', NULL, 0, 'fact', 'semantic',
       'project', 'project-1', 'active', '${now}', '${now}'),
      ('memory-repository-a', 'project-1', NULL, 0, 'fact', 'semantic',
       'repository', 'repository-a', 'active', '${now}', '${now}'),
      ('memory-repository-b', 'project-1', NULL, 0, 'fact', 'semantic',
       'repository', 'repository-b', 'active', '${now}', '${now}'),
      ('memory-other-project', 'project-2', NULL, 0, 'fact', 'semantic',
       'repository', 'repository-c', 'active', '${now}', '${now}');
    INSERT INTO memory_repository_contexts
      (project_id, memory_id, repository_id, created_at)
    VALUES
      ('project-1', 'memory-repository-a', 'repository-a', '${now}'),
      ('project-1', 'memory-repository-b', 'repository-b', '${now}'),
      ('project-2', 'memory-other-project', 'repository-c', '${now}');
    INSERT INTO memory_versions
      (revision_id, project_id, memory_id, memory_version, content, content_sha256,
       audit_id, recorded_at)
    VALUES
      ('revision-shared-1', 'project-1', 'memory-shared', 1,
       'Shared historical content', 'sha-shared-1', 'audit-1', '${now}'),
      ('revision-a-1', 'project-1', 'memory-repository-a', 1,
       'Repository A historical content', 'sha-a-1', 'audit-1', '${now}'),
      ('revision-b-1', 'project-1', 'memory-repository-b', 1,
       'Repository B content', 'sha-b-1', 'audit-1', '${now}'),
      ('revision-c-1', 'project-2', 'memory-other-project', 1,
       'Other project content', 'sha-c-1', 'audit-2', '${now}');
    UPDATE memories
    SET current_revision_id = CASE memory_id
          WHEN 'memory-shared' THEN 'revision-shared-1'
          WHEN 'memory-repository-a' THEN 'revision-a-1'
          WHEN 'memory-repository-b' THEN 'revision-b-1'
          WHEN 'memory-other-project' THEN 'revision-c-1'
        END,
        memory_version = 1,
        updated_at = '${now}';
    INSERT INTO memory_versions
      (revision_id, project_id, memory_id, memory_version, content, content_sha256,
       audit_id, recorded_at)
    VALUES
      ('revision-shared-2', 'project-1', 'memory-shared', 2,
       'Shared current content', 'sha-shared-2', 'audit-1', '${now}'),
      ('revision-a-2', 'project-1', 'memory-repository-a', 2,
       'Repository A current content', 'sha-a-2', 'audit-1', '${now}');
    UPDATE memories
    SET current_revision_id = CASE memory_id
          WHEN 'memory-shared' THEN 'revision-shared-2'
          WHEN 'memory-repository-a' THEN 'revision-a-2'
        END,
        memory_version = 2,
        updated_at = '${now}'
    WHERE memory_id IN ('memory-shared', 'memory-repository-a');
  `);
  return database;
}

function asD1(database: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    const statement = database.prepare(sql);
    let bindings: SQLInputValue[] = [];
    return {
      bind(...values: unknown[]) {
        bindings = values as SQLInputValue[];
        return this;
      },
      async first<T>() {
        return (statement.get(...bindings) as T | undefined) ?? null;
      }
    };
  };
  return {
    prepare,
    withSession(constraint: string) {
      expect(constraint).toBe("first-primary");
      return { prepare };
    }
  } as unknown as D1Database;
}
