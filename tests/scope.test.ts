import { describe, expect, it } from "vitest";
import {
  createRefScopeId,
  createWorktreeScopeId,
  isFormalScopeEntityValid,
  parseRefScopeId,
  parseWorktreeScopeId
} from "../src/contracts/scope";

describe("formal memory scope relationships", () => {
  it("requires project scope to use the current project ID", async () => {
    const unreachable = {} as D1Database;
    await expect(
      isFormalScopeEntityValid(unreachable, "project-1", "project", "project-1")
    ).resolves.toBe(true);
    await expect(
      isFormalScopeEntityValid(unreachable, "project-1", "project", "project-2")
    ).resolves.toBe(false);
  });

  it("checks repository and session identities in the current project", async () => {
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
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
                return call.bindings[1] === "owned" ? { present: 1 } : null;
              }
            };
          }
        };
      }
    } as unknown as D1Database;

    await expect(
      isFormalScopeEntityValid(database, "project-1", "repository", "owned")
    ).resolves.toBe(true);
    await expect(
      isFormalScopeEntityValid(database, "project-1", "session", "foreign")
    ).resolves.toBe(false);
    expect(calls[0]?.sql).toContain("FROM repositories");
    expect(calls[1]?.sql).toContain("FROM sessions");
    expect(calls.map((call) => call.bindings)).toEqual([
      ["project-1", "owned"],
      ["project-1", "foreign"]
    ]);
  });

  it("creates and parses canonical ref and worktree scope IDs", () => {
    const refScopeId = createRefScopeId("repository:1", "refs/heads/feature x");
    const worktreeScopeId = createWorktreeScopeId("session:1", "worktree/path");

    expect(refScopeId).toBe(
      "repository:repository%3A1:ref:refs%2Fheads%2Ffeature%20x"
    );
    expect(parseRefScopeId(refScopeId)).toEqual({
      repositoryId: "repository:1",
      ref: "refs/heads/feature x"
    });
    expect(worktreeScopeId).toBe(
      "session:session%3A1:worktree:worktree%2Fpath"
    );
    expect(parseWorktreeScopeId(worktreeScopeId)).toEqual({
      sessionId: "session:1",
      worktreeId: "worktree/path"
    });
  });

  it.each([
    ["ref", "repository::ref:refs%2Fheads%2Fx"],
    ["ref", "repository:repository-1:ref:"],
    ["ref", "repository:repository-1:ref:refs/heads/x"],
    ["ref", "repository:repository-1:ref:refs%2fheads%2fx"],
    ["ref", "repository:repository-1:ref:%00"],
    ["ref", "repository:%E0%A4%A:ref:x"],
    ["worktree", "session::worktree:worktree-1"],
    ["worktree", "session:session-1:worktree:"],
    ["worktree", "session:session-1:worktree:worktree/path"],
    ["worktree", "session:session-1:worktree:%00"]
  ] as const)("rejects malformed or non-canonical %s scope IDs", async (scope, scopeId) => {
    const unreachable = {} as D1Database;
    await expect(
      isFormalScopeEntityValid(unreachable, "project-1", scope, scopeId)
    ).resolves.toBe(false);
  });

  it("checks canonical ref scopes against the project repository and tracked ref", async () => {
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    const database = scopedDatabase(calls, (sql, bindings) => {
      return (
        sql.includes("FROM sync_cursors") &&
        sql.includes("JOIN repositories") &&
        bindings[0] === "project-1" &&
        bindings[1] === "repository-1" &&
        bindings[2] === "refs/heads/main"
      );
    });

    await expect(
      isFormalScopeEntityValid(
        database,
        "project-1",
        "ref",
        createRefScopeId("repository-1", "refs/heads/main")
      )
    ).resolves.toBe(true);
    await expect(
      isFormalScopeEntityValid(
        database,
        "project-1",
        "ref",
        createRefScopeId("repository-2", "refs/heads/main")
      )
    ).resolves.toBe(false);

    expect(calls.map((call) => call.bindings)).toEqual([
      ["project-1", "repository-1", "refs/heads/main"],
      ["project-1", "repository-2", "refs/heads/main"]
    ]);
  });

  it("checks canonical worktree scopes against the project session metadata", async () => {
    const calls: Array<{ sql: string; bindings: unknown[] }> = [];
    const database = scopedDatabase(calls, (sql, bindings) => {
      return (
        sql.includes("FROM sessions") &&
        sql.includes("worktree_id = ?") &&
        bindings[0] === "project-1" &&
        bindings[1] === "session-1" &&
        bindings[2] === "worktree-1"
      );
    });

    await expect(
      isFormalScopeEntityValid(
        database,
        "project-1",
        "worktree",
        createWorktreeScopeId("session-1", "worktree-1")
      )
    ).resolves.toBe(true);
    await expect(
      isFormalScopeEntityValid(
        database,
        "project-2",
        "worktree",
        createWorktreeScopeId("session-1", "worktree-1")
      )
    ).resolves.toBe(false);

    expect(calls.map((call) => call.bindings)).toEqual([
      ["project-1", "session-1", "worktree-1"],
      ["project-2", "session-1", "worktree-1"]
    ]);
  });
});

function scopedDatabase(
  calls: Array<{ sql: string; bindings: unknown[] }>,
  isPresent: (sql: string, bindings: unknown[]) => boolean
): D1Database {
  return {
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
              return isPresent(sql, call.bindings) ? { present: 1 } : null;
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}
