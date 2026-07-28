import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { inspectCandidateContent } from "../src/quality/sensitive-content";
import {
  consolidateSession,
  processCandidateSubmission
} from "../src/workflows/quality";

const PROJECT_ID = "project-1";
const CONSOLIDATION_ID = "consolidation-1";
const SESSION_ID = "session-1";

describe("quality workflow consolidation SQL", () => {
  it("executes the slot-owned batch atomically against SQLite", async () => {
    const fixture = createFixture();

    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID);
    fixture.database
      .prepare("UPDATE session_consolidations SET status = 'running'")
      .run();
    fixture.suggestion.content = "Changed retry content must not replace the winner.";
    await consolidateSession(fixture.env, PROJECT_ID, CONSOLIDATION_ID, SESSION_ID);

    expect(fixture.database.prepare("SELECT content FROM observations").get()).toEqual({
      content: "The SQLite-backed winner."
    });
    for (const table of [
      "observations",
      "consolidation_outputs",
      "evidence",
      "observation_evidence",
      "review_requests"
    ]) {
      expect(
        fixture.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
      ).toEqual({ count: 1 });
    }
    expect(
      fixture.database
        .prepare(
          `SELECT repository_id, repository_ref, repository_authority
           FROM evidence`
        )
        .get()
    ).toEqual({
      repository_id: "repository-1",
      repository_ref: "refs/heads/main",
      repository_authority: "agent_supplied"
    });
  });

  it.each([
    [
      "a legacy prompt transcript",
      "System: You are a coding agent.\nUser: Read every file.\nAssistant: Starting now."
    ],
    [
      "a legacy raw log",
      "2026-07-28T08:00:00.000Z INFO request started\n2026-07-28T08:00:01.000Z ERROR request failed"
    ]
  ])("blocks %s before AI without advancing the queued candidate", async (_label, content) => {
    const fixture = createFixture();
    const candidateId = "legacy-sensitive-candidate";
    fixture.database
      .prepare(
        `INSERT INTO observations
         (observation_id, project_id, session_id, principal_id, candidate_version,
          status, content, content_sha256, evidence_json, created_at)
         VALUES (?, ?, ?, ?, 1, 'queued', ?, 'legacy-content-sha', '[{"legacy":true}]', ?)`
      )
      .run(
        candidateId,
        PROJECT_ID,
        SESSION_ID,
        "principal-1",
        content,
        "2026-07-27T00:00:00Z"
      );
    expect(inspectCandidateContent(content, { maxBytes: 16 * 1024 })).toEqual({
      accepted: true
    });
    const ai = { run: vi.fn() };

    await expect(
      processCandidateSubmission(
        {
          MEMORY_DB: sqliteD1(fixture.database),
          AI: ai
        } as unknown as Parameters<typeof processCandidateSubmission>[0],
        PROJECT_ID,
        candidateId
      )
    ).rejects.toMatchObject({ code: "WORKFLOW_FAILED" });

    expect(ai.run).not.toHaveBeenCalled();
    expect(
      fixture.database
        .prepare(
          `SELECT status, content, content_sha256, evidence_json, kind, memory_class,
                  scope, scope_id, valid_from, valid_until, analysis_json,
                  review_reason, reviewed_content
           FROM observations WHERE observation_id = ?`
        )
        .get(candidateId)
    ).toEqual({
      status: "queued",
      content,
      content_sha256: "legacy-content-sha",
      evidence_json: '[{"legacy":true}]',
      kind: null,
      memory_class: null,
      scope: null,
      scope_id: null,
      valid_from: null,
      valid_until: null,
      analysis_json: null,
      review_reason: null,
      reviewed_content: null
    });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM review_requests WHERE candidate_id = ?")
        .get(candidateId)
    ).toEqual({ count: 0 });
  });
});

function createFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE repositories (
      repository_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      status TEXT NOT NULL,
      repository_id TEXT,
      repository_ref TEXT
    );
    CREATE TABLE session_consolidations (
      consolidation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE consolidation_inputs (
      project_id TEXT NOT NULL,
      consolidation_id TEXT NOT NULL,
      input_order INTEGER NOT NULL,
      input_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL
    );
    CREATE TABLE observations (
      observation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT,
      principal_id TEXT,
      candidate_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      content TEXT,
      content_sha256 TEXT,
      evidence_json TEXT NOT NULL,
      kind TEXT,
      memory_class TEXT,
      scope TEXT,
      scope_id TEXT,
      valid_from TEXT,
      valid_until TEXT,
      analysis_json TEXT,
      review_reason TEXT,
      reviewed_content TEXT,
      source_consolidation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE (project_id, observation_id)
    );
    CREATE TABLE consolidation_outputs (
      project_id TEXT NOT NULL,
      consolidation_id TEXT NOT NULL,
      output_order INTEGER NOT NULL,
      candidate_id TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, consolidation_id, output_order),
      UNIQUE (project_id, candidate_id)
    );
    CREATE TABLE evidence (
      evidence_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      locator TEXT NOT NULL,
      repository_id TEXT,
      repository_ref TEXT,
      repository_authority TEXT,
      excerpt_hash TEXT NOT NULL,
      sensitivity_status TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE (project_id, source_type, locator, excerpt_hash)
    );
    CREATE TABLE observation_evidence (
      project_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, observation_id, evidence_id)
    );
    CREATE TABLE review_requests (
      review_request_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      candidate_id TEXT,
      status TEXT NOT NULL,
      required_role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, candidate_id)
    );
  `);
  database
    .prepare("INSERT INTO repositories VALUES (?, ?)")
    .run("repository-1", PROJECT_ID);
  database
    .prepare("INSERT INTO sessions VALUES (?, ?, ?, 'closed', ?, ?)")
    .run(
      SESSION_ID,
      PROJECT_ID,
      "principal-1",
      "repository-1",
      "refs/heads/main"
    );
  database
    .prepare("INSERT INTO session_consolidations VALUES (?, ?, ?, 'queued', ?, ?)")
    .run(CONSOLIDATION_ID, PROJECT_ID, SESSION_ID, "input-digest", "2026-07-27T00:00:00Z");
  database
    .prepare("INSERT INTO consolidation_inputs VALUES (?, ?, 0, 'summary', ?, ?, ?)")
    .run(
      PROJECT_ID,
      CONSOLIDATION_ID,
      "session-summary",
      "D1 is authoritative.",
      "source-sha"
    );

  const suggestion = { content: "The SQLite-backed winner." };
  const ai = {
    async run(_model: unknown, input: unknown) {
      const prompt = modelPrompt(input);
      const projectOption = prompt.scope_options.find(
        (option) => option.scope === "project"
      );
      if (projectOption === undefined) {
        throw new Error("The test model could not select a project scope option.");
      }
      return modelFunctionResponse("consolidation_suggestions", {
        suggestions: [
          {
            content: suggestion.content,
            kind: "decision",
            memory_class: "semantic",
            scope_option_id: projectOption.option_id,
            evidence_source_ids: ["session-summary"],
            confidence: 0.99
          }
        ]
      });
    }
  };
  return {
    database,
    suggestion,
    env: { MEMORY_DB: sqliteD1(database), AI: ai } as unknown as Parameters<
      typeof consolidateSession
    >[0]
  };
}

function modelPrompt(input: unknown): {
  scope_options: Array<{ option_id: string; scope: string }>;
} {
  if (
    typeof input !== "object" ||
    input === null ||
    !("messages" in input) ||
    !Array.isArray(input.messages)
  ) {
    throw new Error("The AI request is invalid.");
  }
  const content = input.messages.at(-1)?.content;
  if (typeof content !== "string") {
    throw new Error("The AI prompt is invalid.");
  }
  return JSON.parse(content) as {
    scope_options: Array<{ option_id: string; scope: string }>;
  };
}

function modelFunctionResponse(name: string, value: unknown): Record<string, unknown> {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: "function",
              function: { name, arguments: JSON.stringify(value) }
            }
          ]
        }
      }
    ]
  };
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    let bindings: SQLInputValue[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bindings = values as SQLInputValue[];
        return statement;
      },
      async first<T>() {
        return (database.prepare(sql).get(...bindings) ?? null) as T | null;
      },
      async all<T>() {
        return { results: database.prepare(sql).all(...bindings) as T[] };
      },
      async run<T>() {
        const changes = Number(database.prepare(sql).run(...bindings).changes);
        return d1Result(changes) as T;
      }
    };
    return statement;
  };
  return {
    prepare,
    withSession() {
      return { prepare };
    },
    async batch(statements: ReturnType<typeof prepare>[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as D1Database;
}

function d1Result(changes: number) {
  return {
    success: true as const,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes
    },
    results: []
  };
}
