import { MEMORY_SCOPES, type MemoryScope } from "./taxonomy";
import { parseRefScopeId, parseWorktreeScopeId } from "./scope";

export const REPOSITORY_AUTHORITIES = [
  "default_branch",
  "tracked_ref",
  "agent_supplied"
] as const;

export type RepositoryAuthority = (typeof REPOSITORY_AUTHORITIES)[number];

export type RepositoryContextSource =
  | { kind: "session"; id: string }
  | { kind: "evidence"; id: string };

export interface TrustedRepositoryContext {
  projectId: string;
  repositoryId: string;
  repositoryRef: string | null;
  repositoryPath: string | null;
  repositoryAuthority: RepositoryAuthority;
  source: RepositoryContextSource;
}

export interface RepositoryOwnership {
  projectId: string;
  repositoryId: string | null;
}

export interface MemoryChangeRepositoryContext {
  scope: MemoryScope;
  scopeId: string;
  repositoryId: string | null;
  repositoryRef: string | null;
  sessionId: string | null;
  worktreeId: string | null;
}

interface RepositoryContextRow {
  repository_id: string;
  repository_ref: string | null;
  repository_path: string | null;
  repository_authority: string;
}

interface RepositoryOwnershipRow {
  repository_id: string;
}

interface MemoryRepositoryContextRow {
  scope: string;
  scope_id: string;
  repository_id: string | null;
}

export async function resolveTrustedRepositoryContext(
  database: D1Database,
  projectId: string,
  source: RepositoryContextSource
): Promise<TrustedRepositoryContext | null> {
  const row =
    source.kind === "session"
      ? await database
          .withSession("first-primary")
          .prepare(
            `SELECT session_record.repository_id,
                    session_record.repository_ref,
                    NULL AS repository_path,
                    'agent_supplied' AS repository_authority
             FROM sessions AS session_record
             JOIN repositories AS repository
               ON repository.project_id = session_record.project_id
              AND repository.repository_id = session_record.repository_id
             WHERE session_record.project_id = ? AND session_record.session_id = ?
               AND session_record.repository_id IS NOT NULL`
          )
          .bind(projectId, source.id)
          .first<RepositoryContextRow>()
      : await database
          .withSession("first-primary")
          .prepare(
            `SELECT evidence_record.repository_id,
                    evidence_record.repository_ref,
                    evidence_record.repository_path,
                    evidence_record.repository_authority
             FROM evidence AS evidence_record
             JOIN repositories AS repository
               ON repository.project_id = evidence_record.project_id
              AND repository.repository_id = evidence_record.repository_id
             WHERE evidence_record.project_id = ? AND evidence_record.evidence_id = ?
               AND evidence_record.repository_id IS NOT NULL
               AND evidence_record.repository_authority IS NOT NULL`
          )
          .bind(projectId, source.id)
          .first<RepositoryContextRow>();

  if (row === null || !isRepositoryAuthority(row.repository_authority)) {
    return null;
  }
  return {
    projectId,
    repositoryId: row.repository_id,
    repositoryRef: row.repository_ref,
    repositoryPath: row.repository_path,
    repositoryAuthority: row.repository_authority,
    source
  };
}

export async function resolveScopeRepositoryOwnership(
  database: D1Database,
  projectId: string,
  scope: MemoryScope,
  scopeId: string
): Promise<RepositoryOwnership | null> {
  if (scope === "project") {
    return scopeId === projectId ? { projectId, repositoryId: null } : null;
  }

  let statement: D1PreparedStatement;
  let bindings: string[];
  if (scope === "repository") {
    statement = database.withSession("first-primary").prepare(
      `SELECT repository_id
       FROM repositories
       WHERE project_id = ? AND repository_id = ?`
    );
    bindings = [projectId, scopeId];
  } else if (scope === "ref") {
    const parsed = parseRefScopeId(scopeId);
    if (parsed === null) {
      return null;
    }
    statement = database.withSession("first-primary").prepare(
      `SELECT cursor.repository_id
       FROM sync_cursors AS cursor
       JOIN repositories AS repository
         ON repository.project_id = cursor.project_id
        AND repository.repository_id = cursor.repository_id
       WHERE cursor.project_id = ? AND cursor.repository_id = ? AND cursor.ref = ?`
    );
    bindings = [projectId, parsed.repositoryId, parsed.ref];
  } else if (scope === "session") {
    statement = database.withSession("first-primary").prepare(
      `SELECT session_record.repository_id
       FROM sessions AS session_record
       JOIN repositories AS repository
         ON repository.project_id = session_record.project_id
        AND repository.repository_id = session_record.repository_id
       WHERE session_record.project_id = ? AND session_record.session_id = ?
         AND session_record.repository_id IS NOT NULL`
    );
    bindings = [projectId, scopeId];
  } else {
    const parsed = parseWorktreeScopeId(scopeId);
    if (parsed === null) {
      return null;
    }
    statement = database.withSession("first-primary").prepare(
      `SELECT session_record.repository_id
       FROM sessions AS session_record
       JOIN repositories AS repository
         ON repository.project_id = session_record.project_id
        AND repository.repository_id = session_record.repository_id
       WHERE session_record.project_id = ? AND session_record.session_id = ?
         AND session_record.worktree_id = ?
         AND session_record.repository_id IS NOT NULL`
    );
    bindings = [projectId, parsed.sessionId, parsed.worktreeId];
  }

  const row = await statement.bind(...bindings).first<RepositoryOwnershipRow>();
  return row === null ? null : { projectId, repositoryId: row.repository_id };
}

export async function resolveMemoryRepositoryOwnership(
  database: D1Database,
  projectId: string,
  memoryId: string
): Promise<RepositoryOwnership | null> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT context.repository_id
       FROM memory_repository_contexts AS context
       JOIN memories AS memory_record
         ON memory_record.project_id = context.project_id
        AND memory_record.memory_id = context.memory_id
       JOIN repositories AS repository
         ON repository.project_id = context.project_id
        AND repository.repository_id = context.repository_id
       WHERE context.project_id = ? AND context.memory_id = ?
         AND memory_record.scope <> 'project'`
    )
    .bind(projectId, memoryId)
    .first<RepositoryOwnershipRow>();
  return row === null ? null : { projectId, repositoryId: row.repository_id };
}

export async function resolveMemoryChangeRepositoryContext(
  database: D1Database,
  projectId: string,
  memoryId: string
): Promise<MemoryChangeRepositoryContext | null> {
  const row = await database
    .withSession("first-primary")
    .prepare(
      `SELECT memory_record.scope, memory_record.scope_id, context.repository_id
       FROM memories AS memory_record
       LEFT JOIN memory_repository_contexts AS context
         ON context.project_id = memory_record.project_id
        AND context.memory_id = memory_record.memory_id
       WHERE memory_record.project_id = ? AND memory_record.memory_id = ?`
    )
    .bind(projectId, memoryId)
    .first<MemoryRepositoryContextRow>();
  if (row === null || !isMemoryScope(row.scope)) {
    return null;
  }

  const ownership = await resolveScopeRepositoryOwnership(
    database,
    projectId,
    row.scope,
    row.scope_id
  );
  if (ownership === null || ownership.repositoryId !== row.repository_id) {
    return null;
  }
  if (row.scope === "project") {
    return {
      scope: row.scope,
      scopeId: row.scope_id,
      repositoryId: null,
      repositoryRef: null,
      sessionId: null,
      worktreeId: null
    };
  }
  if (row.repository_id === null) {
    return null;
  }
  if (row.scope === "repository") {
    return {
      scope: row.scope,
      scopeId: row.scope_id,
      repositoryId: row.repository_id,
      repositoryRef: null,
      sessionId: null,
      worktreeId: null
    };
  }
  if (row.scope === "ref") {
    const parsed = parseRefScopeId(row.scope_id);
    if (parsed === null || parsed.repositoryId !== row.repository_id) {
      return null;
    }
    return {
      scope: row.scope,
      scopeId: row.scope_id,
      repositoryId: row.repository_id,
      repositoryRef: parsed.ref,
      sessionId: null,
      worktreeId: null
    };
  }

  const parsedWorktree =
    row.scope === "worktree" ? parseWorktreeScopeId(row.scope_id) : null;
  const sessionId = row.scope === "session" ? row.scope_id : parsedWorktree?.sessionId;
  if (sessionId === undefined || (row.scope === "worktree" && parsedWorktree === null)) {
    return null;
  }
  const sessionContext = await resolveTrustedRepositoryContext(database, projectId, {
    kind: "session",
    id: sessionId
  });
  if (sessionContext === null || sessionContext.repositoryId !== row.repository_id) {
    return null;
  }
  return {
    scope: row.scope,
    scopeId: row.scope_id,
    repositoryId: row.repository_id,
    repositoryRef: sessionContext.repositoryRef,
    sessionId,
    worktreeId: parsedWorktree?.worktreeId ?? null
  };
}

function isMemoryScope(value: string): value is MemoryScope {
  return (MEMORY_SCOPES as readonly string[]).includes(value);
}

function isRepositoryAuthority(value: string): value is RepositoryAuthority {
  return (REPOSITORY_AUTHORITIES as readonly string[]).includes(value);
}
