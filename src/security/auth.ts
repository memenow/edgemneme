import { EdgeMnemeError } from "../contracts/errors";
import { encodeBase64Url } from "./crypto";

export type ProjectRole = "reader" | "writer" | "maintainer";

export interface AuthenticatedPrincipal {
  principalId: string;
  projectId: string;
  role: ProjectRole;
}

interface PrincipalRow {
  principal_id: string;
  project_id: string;
  role: ProjectRole;
}

export async function authenticateProjectBearer(
  request: Request,
  database: D1Database,
  pepper: string
): Promise<AuthenticatedPrincipal> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new EdgeMnemeError("UNAUTHENTICATED", "A bearer token is required.");
  }
  const token = authorization.slice("Bearer ".length);
  if (token.length < 32 || token.length > 4096 || pepper.length < 32) {
    throw new EdgeMnemeError("UNAUTHENTICATED", "The bearer token is invalid.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const tokenDigest = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token))
    )
  );
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT p.principal_id, g.project_id, g.role
       FROM principals p
       JOIN project_grants g ON g.principal_id = p.principal_id
       WHERE p.token_digest = ? AND p.revoked_at IS NULL AND g.revoked_at IS NULL
       ORDER BY CASE g.role
         WHEN 'maintainer' THEN 2
         WHEN 'writer' THEN 1
         ELSE 0
       END DESC
       LIMIT 1`
    )
    .bind(tokenDigest)
    .first<PrincipalRow>();
  if (row === null) {
    throw new EdgeMnemeError("UNAUTHENTICATED", "The bearer token is invalid.");
  }
  return {
    principalId: row.principal_id,
    projectId: row.project_id,
    role: row.role
  };
}

export async function requireProjectRole(
  database: D1Database,
  principal: AuthenticatedPrincipal,
  required: ProjectRole
): Promise<void> {
  const minimumRank = { reader: 0, writer: 1, maintainer: 2 } as const;
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS authorized
       FROM project_grants
       WHERE project_id = ? AND principal_id = ? AND revoked_at IS NULL
         AND scope_kind = 'project' AND scope_id = ?
         AND CASE role
           WHEN 'maintainer' THEN 2
           WHEN 'writer' THEN 1
           ELSE 0
         END >= ?
       LIMIT 1`
    )
    .bind(
      principal.projectId,
      principal.principalId,
      principal.projectId,
      minimumRank[required]
    )
    .first();
  if (row === null) {
    throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
  }
}

export function requireRole(
  principal: AuthenticatedPrincipal,
  required: ProjectRole
): void {
  const rank = { reader: 0, writer: 1, maintainer: 2 } as const;
  if (rank[principal.role] < rank[required]) {
    throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
  }
}

/**
 * Builds the repository hierarchy portion of an ACL query. The caller must also
 * filter the grant by principal, active state, and minimum role.
 */
export function hierarchicalMemoryAccessPredicate(
  grantAlias: string,
  memoryAlias: string
): string {
  requireSqlAlias(grantAlias);
  requireSqlAlias(memoryAlias);
  return `
    ${memoryAlias}.project_id = ${grantAlias}.project_id
    AND (
      (
        ${memoryAlias}.scope = 'project'
        AND ${memoryAlias}.scope_id = ${memoryAlias}.project_id
        AND (
          (
            ${grantAlias}.scope_kind = 'project'
            AND ${grantAlias}.scope_id = ${grantAlias}.project_id
          )
          OR EXISTS (
            SELECT 1
            FROM project_grant_repository_contexts AS acl_project_grant_context
            WHERE acl_project_grant_context.project_id = ${grantAlias}.project_id
              AND acl_project_grant_context.grant_id = ${grantAlias}.grant_id
          )
        )
      )
      OR (
        ${memoryAlias}.scope <> 'project'
        AND EXISTS (
          SELECT 1
          FROM memory_repository_contexts AS acl_memory_context
          JOIN repositories AS acl_memory_repository
            ON acl_memory_repository.project_id = acl_memory_context.project_id
           AND acl_memory_repository.repository_id = acl_memory_context.repository_id
          WHERE acl_memory_context.project_id = ${memoryAlias}.project_id
            AND acl_memory_context.memory_id = ${memoryAlias}.memory_id
            AND (
              (
                ${grantAlias}.scope_kind = 'project'
                AND ${grantAlias}.scope_id = ${grantAlias}.project_id
              )
              OR EXISTS (
                SELECT 1
                FROM project_grant_repository_contexts AS acl_grant_context
                WHERE acl_grant_context.project_id = ${grantAlias}.project_id
                  AND acl_grant_context.grant_id = ${grantAlias}.grant_id
                  AND acl_grant_context.repository_id = acl_memory_context.repository_id
                  AND (
                    ${grantAlias}.scope_kind = 'repository'
                    OR (
                      ${grantAlias}.scope_kind IN ('ref', 'worktree', 'session')
                      AND (
                        ${memoryAlias}.scope = 'repository'
                        OR (
                          ${memoryAlias}.scope = ${grantAlias}.scope_kind
                          AND ${memoryAlias}.scope_id = ${grantAlias}.scope_id
                        )
                      )
                    )
                  )
              )
            )
        )
      )
    )`;
}

export async function hasMemoryRole(
  database: D1Database,
  principal: AuthenticatedPrincipal,
  required: ProjectRole,
  memoryId: string
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS authorized
       FROM project_grants AS grant_record
       JOIN memories AS memory_record
         ON memory_record.project_id = grant_record.project_id
       WHERE grant_record.project_id = ?
         AND grant_record.principal_id = ?
         AND grant_record.revoked_at IS NULL
         AND memory_record.memory_id = ?
         AND CASE grant_record.role
           WHEN 'maintainer' THEN 2
           WHEN 'writer' THEN 1
           WHEN 'reader' THEN 0
           ELSE -1
         END >= ?
         AND ${hierarchicalMemoryAccessPredicate("grant_record", "memory_record")}
       LIMIT 1`
    )
    .bind(
      principal.projectId,
      principal.principalId,
      memoryId,
      roleRank(required)
    )
    .first<{ authorized: number }>();
  return row?.authorized === 1;
}

export async function requireMemoryRole(
  database: D1Database,
  principal: AuthenticatedPrincipal,
  required: ProjectRole,
  memoryId: string
): Promise<void> {
  if (!(await hasMemoryRole(database, principal, required, memoryId))) {
    throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
  }
}

export async function hasRepositoryRole(
  database: D1Database,
  principal: AuthenticatedPrincipal,
  required: ProjectRole,
  repositoryId: string
): Promise<boolean> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT 1 AS authorized
       FROM project_grants AS grant_record
       JOIN repositories AS repository
         ON repository.project_id = grant_record.project_id
        AND repository.repository_id = ?
       LEFT JOIN project_grant_repository_contexts AS grant_context
         ON grant_context.project_id = grant_record.project_id
        AND grant_context.grant_id = grant_record.grant_id
       WHERE grant_record.project_id = ?
         AND grant_record.principal_id = ?
         AND grant_record.revoked_at IS NULL
         AND CASE grant_record.role
           WHEN 'maintainer' THEN 2
           WHEN 'writer' THEN 1
           WHEN 'reader' THEN 0
           ELSE -1
         END >= ?
         AND (
           (
             grant_record.scope_kind = 'project'
             AND grant_record.scope_id = grant_record.project_id
           )
           OR grant_context.repository_id = repository.repository_id
         )
       LIMIT 1`
    )
    .bind(
      repositoryId,
      principal.projectId,
      principal.principalId,
      roleRank(required)
    )
    .first<{ authorized: number }>();
  return row?.authorized === 1;
}

export async function requireRepositoryRole(
  database: D1Database,
  principal: AuthenticatedPrincipal,
  required: ProjectRole,
  repositoryId: string
): Promise<void> {
  if (!(await hasRepositoryRole(database, principal, required, repositoryId))) {
    throw new EdgeMnemeError("PROJECT_UNAVAILABLE", "The project is unavailable.");
  }
}

export function validateOrigin(request: Request, allowedOrigins: string): void {
  const origin = request.headers.get("origin");
  if (origin === null) {
    return;
  }
  const allowlist = new Set(
    allowedOrigins
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (!allowlist.has(origin)) {
    throw new EdgeMnemeError("UNAUTHENTICATED", "The request origin is not allowed.");
  }
}

function roleRank(role: ProjectRole): number {
  return { reader: 0, writer: 1, maintainer: 2 }[role];
}

function requireSqlAlias(alias: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(alias)) {
    throw new TypeError("SQL aliases must be simple identifiers.");
  }
}
