import { describe, expect, it } from "vitest";
import { markGitHubSyncPendingReview } from "../src/github/sync-review-cursor";

interface ReviewCursorStateRow {
  cursor_observed_sha: string | null;
  status: string;
  cursor_version: number;
  head_manifest_id: string | null;
  manifest_observed_sha: string | null;
}

type ScriptStep =
  | { kind: "run"; changes: number }
  | { kind: "first"; row: ReviewCursorStateRow | null };

interface StatementInvocation {
  kind: "run" | "first";
  query: string;
  bindings: readonly unknown[];
}

const INPUT = {
  projectId: "project-a",
  repositoryId: "repository-a",
  ref: "refs/heads/main",
  observedSha: "a".repeat(40),
  manifestId: "b".repeat(64),
  updatedAt: "2026-08-10T12:00:00.000Z"
};

describe("GitHub sync review cursor", () => {
  it("accepts exactly one guarded cursor update", async () => {
    const scripted = new ScriptedD1([{ kind: "run", changes: 1 }]);

    await expect(
      markGitHubSyncPendingReview(scripted, INPUT)
    ).resolves.toBeUndefined();

    expect(scripted.sessionConstraints).toEqual(["first-primary"]);
    expect(scripted.invocations).toHaveLength(1);
    expect(scripted.invocations[0]).toMatchObject({
      kind: "run",
      bindings: [
        INPUT.updatedAt,
        INPUT.projectId,
        INPUT.repositoryId,
        INPUT.ref,
        INPUT.observedSha,
        INPUT.manifestId,
        INPUT.observedSha
      ]
    });
    expect(scripted.invocations[0]?.query).toContain(
      "AND status = 'observed'"
    );
    expect(scripted.remainingStepCount).toBe(0);
  });

  it("fails closed when a guarded update changes more than one row", async () => {
    const scripted = new ScriptedD1([{ kind: "run", changes: 2 }]);

    await expect(
      markGitHubSyncPendingReview(scripted, INPUT)
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });

    expect(scripted.invocations).toHaveLength(1);
    expect(scripted.invocations[0]?.kind).toBe("run");
    expect(scripted.remainingStepCount).toBe(0);
  });

  it("fails closed when the guarded no-op cannot reread the cursor", async () => {
    const scripted = new ScriptedD1([
      { kind: "run", changes: 0 },
      { kind: "first", row: null }
    ]);

    await expect(
      markGitHubSyncPendingReview(scripted, INPUT)
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });

    expect(scripted.invocations).toHaveLength(2);
    expect(scripted.invocations[1]).toMatchObject({
      kind: "first",
      bindings: [INPUT.projectId, INPUT.repositoryId, INPUT.ref]
    });
    expect(scripted.invocations[1]?.query).toContain(
      "LEFT JOIN github_tree_ref_heads"
    );
    expect(scripted.remainingStepCount).toBe(0);
  });

  it.each([
    {
      drift: "manifest",
      cursorObservedSha: INPUT.observedSha,
      manifestObservedSha: "c".repeat(40)
    },
    {
      drift: "cursor",
      cursorObservedSha: "d".repeat(40),
      manifestObservedSha: INPUT.observedSha
    }
  ])(
    "fails closed on exact-current $drift SHA drift",
    async ({ cursorObservedSha, manifestObservedSha }) => {
      const scripted = new ScriptedD1([
        { kind: "run", changes: 0 },
        {
          kind: "first",
          row: {
            cursor_observed_sha: cursorObservedSha,
            status: "paused",
            cursor_version: 7,
            head_manifest_id: INPUT.manifestId,
            manifest_observed_sha: manifestObservedSha
          }
        }
      ]);

      await expect(
        markGitHubSyncPendingReview(scripted, INPUT)
      ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });

      expect(scripted.invocations).toHaveLength(2);
      expect(scripted.remainingStepCount).toBe(0);
    }
  );
});

class ScriptedD1 implements D1Database {
  readonly invocations: StatementInvocation[] = [];
  readonly sessionConstraints: Array<string | undefined> = [];
  readonly #steps: ScriptStep[];

  constructor(steps: readonly ScriptStep[]) {
    this.#steps = [...steps];
  }

  get remainingStepCount(): number {
    return this.#steps.length;
  }

  prepare(_query: string): D1PreparedStatement {
    throw new Error("Direct database preparation is not part of this test.");
  }

  batch<T = unknown>(
    _statements: D1PreparedStatement[]
  ): Promise<D1Result<T>[]> {
    throw new Error("Database batches are not part of this test.");
  }

  exec(_query: string): Promise<D1ExecResult> {
    throw new Error("Database exec is not part of this test.");
  }

  withSession(constraintOrBookmark?: string): D1DatabaseSession {
    this.sessionConstraints.push(constraintOrBookmark);
    return new ScriptedD1Session(this);
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error("Database dumps are not part of this test.");
  }

  run(query: string, bindings: readonly unknown[]): D1Result {
    const step = this.takeStep("run");
    this.invocations.push({ kind: "run", query, bindings });
    return d1Result(step.changes);
  }

  first(
    query: string,
    bindings: readonly unknown[]
  ): ReviewCursorStateRow | null {
    const step = this.takeStep("first");
    this.invocations.push({ kind: "first", query, bindings });
    return step.row;
  }

  private takeStep<K extends ScriptStep["kind"]>(
    kind: K
  ): Extract<ScriptStep, { kind: K }> {
    const step = this.#steps.shift();
    if (step === undefined || step.kind !== kind) {
      throw new Error(`Expected scripted D1 ${kind} step.`);
    }
    return step as Extract<ScriptStep, { kind: K }>;
  }
}

class ScriptedD1Session implements D1DatabaseSession {
  constructor(private readonly database: ScriptedD1) {}

  prepare(query: string): D1PreparedStatement {
    return new ScriptedD1Statement(this.database, query);
  }

  batch<T = unknown>(
    _statements: D1PreparedStatement[]
  ): Promise<D1Result<T>[]> {
    throw new Error("Session batches are not part of this test.");
  }

  getBookmark(): string | null {
    return null;
  }
}

class ScriptedD1Statement implements D1PreparedStatement {
  #bindings: readonly unknown[] = [];

  constructor(
    private readonly database: ScriptedD1,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.#bindings = values;
    return this;
  }

  first<T = unknown>(_colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T = Record<string, unknown>>(_colName?: string): Promise<T | null> {
    if (_colName !== undefined) {
      throw new Error("Column selection is not part of this test.");
    }
    return Promise.resolve(
      this.database.first(this.query, this.#bindings) as T | null
    );
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return Promise.resolve(
      this.database.run(this.query, this.#bindings) as D1Result<T>
    );
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    throw new Error("Statement all is not part of this test.");
  }

  raw<T = unknown[]>(
    _options: { columnNames: true }
  ): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(_options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(
    _options?: { columnNames?: boolean }
  ): Promise<T[] | [string[], ...T[]]> {
    throw new Error("Statement raw is not part of this test.");
  }
}

function d1Result(changes: number): D1Result {
  return {
    success: true,
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
