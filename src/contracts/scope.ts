import type { MemoryScope } from "./taxonomy";

export interface RefScopeIdParts {
  repositoryId: string;
  ref: string;
}

export interface WorktreeScopeIdParts {
  sessionId: string;
  worktreeId: string;
}

export function createRefScopeId(repositoryId: string, ref: string): string {
  return `repository:${encodeScopeComponent(repositoryId)}:ref:${encodeScopeComponent(ref)}`;
}

export function parseRefScopeId(scopeId: string): RefScopeIdParts | null {
  const match = /^repository:([^:]+):ref:([^:]+)$/u.exec(scopeId);
  if (match === null) {
    return null;
  }
  const repositoryId = decodeScopeComponent(match[1] ?? "");
  const ref = decodeScopeComponent(match[2] ?? "");
  if (repositoryId === null || ref === null) {
    return null;
  }
  return { repositoryId, ref };
}

export function createWorktreeScopeId(sessionId: string, worktreeId: string): string {
  return `session:${encodeScopeComponent(sessionId)}:worktree:${encodeScopeComponent(worktreeId)}`;
}

export function parseWorktreeScopeId(scopeId: string): WorktreeScopeIdParts | null {
  const match = /^session:([^:]+):worktree:([^:]+)$/u.exec(scopeId);
  if (match === null) {
    return null;
  }
  const sessionId = decodeScopeComponent(match[1] ?? "");
  const worktreeId = decodeScopeComponent(match[2] ?? "");
  if (sessionId === null || worktreeId === null) {
    return null;
  }
  return { sessionId, worktreeId };
}

export async function isFormalScopeEntityValid(
  database: D1Database,
  projectId: string,
  scope: MemoryScope,
  scopeId: string
): Promise<boolean> {
  if (scope === "project") {
    return scopeId === projectId;
  }
  if (scope === "ref") {
    const parsed = parseRefScopeId(scopeId);
    if (parsed === null) {
      return false;
    }
    const row = await database
      .withSession("first-primary")
      .prepare(
        `SELECT 1 AS present
         FROM sync_cursors AS cursor
         JOIN repositories AS repository
           ON repository.project_id = cursor.project_id
          AND repository.repository_id = cursor.repository_id
         WHERE cursor.project_id = ? AND cursor.repository_id = ? AND cursor.ref = ?`
      )
      .bind(projectId, parsed.repositoryId, parsed.ref)
      .first<{ present: number }>();
    return row?.present === 1;
  }
  if (scope === "worktree") {
    const parsed = parseWorktreeScopeId(scopeId);
    if (parsed === null) {
      return false;
    }
    const row = await database
      .withSession("first-primary")
      .prepare(
        `SELECT 1 AS present
         FROM sessions
         WHERE project_id = ? AND session_id = ?
           AND worktree_id = ?`
      )
      .bind(projectId, parsed.sessionId, parsed.worktreeId)
      .first<{ present: number }>();
    return row?.present === 1;
  }
  const [table, identifier] =
    scope === "repository"
      ? (["repositories", "repository_id"] as const)
      : (["sessions", "session_id"] as const);
  const row = await database
    .withSession("first-primary")
    .prepare(`SELECT 1 AS present FROM ${table} WHERE project_id = ? AND ${identifier} = ?`)
    .bind(projectId, scopeId)
    .first<{ present: number }>();
  return row?.present === 1;
}

function encodeScopeComponent(value: string): string {
  if (value === "" || value.trim() !== value || value.includes("\0")) {
    throw new TypeError("Scope ID components must be nonempty canonical text without NUL bytes.");
  }
  try {
    return encodeURIComponent(value);
  } catch {
    throw new TypeError("Scope ID components must be valid Unicode text.");
  }
}

function decodeScopeComponent(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  try {
    return encodeScopeComponent(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}
