import { describe, expect, it, vi } from "vitest";
import {
  createGitHubRequestPacer,
  MAX_AUTHENTICATED_REPOSITORIES,
  type GitHubReadOnlyClient,
  type GitHubRequestPacer
} from "../src/github/client";
import githubSyncWorker, {
  buildGitHubBlobCandidate,
  buildStableSyncEvent,
  classifyRefChange,
  collectAccessBaseline,
  computeNextSyncAt,
  enforceApprovedAccessBaseline,
  evaluateAccessBaseline,
  parseApprovedAccessBaseline,
  parseTrackedRefs,
  type AccessBaseline
} from "../workers/github-sync/index";

const PREVIOUS_SHA = "a".repeat(40);
const OBSERVED_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const SAFE_BLOB_SHA = "d".repeat(40);
const SENSITIVE_BLOB_SHA = "e".repeat(40);
const PROMPT_BLOB_SHA = "f".repeat(40);
const RAW_LOG_BLOB_SHA = "1".repeat(40);
const RELEASE_SHA = "2".repeat(40);
const RELEASE_TREE_SHA = "3".repeat(40);
const SECOND_REPOSITORY_SHA = "4".repeat(40);
const SECOND_REPOSITORY_TREE_SHA = "5".repeat(40);
const ANNOTATED_TAG_SHA = "6".repeat(40);
const TOKEN_EXPIRATION_HEADER = "2099-10-26 00:00:00 UTC";
const TOKEN_EXPIRATION_ISO = "2099-10-26T00:00:00.000Z";

describe("GitHub sync policy", () => {
  it("returns before D1, GitHub, or token access when runtime synchronization is disabled", async () => {
    const environment = new Proxy(
      { GITHUB_SYNC_ENABLED: "false" },
      {
        get(target, property) {
          if (property !== "GITHUB_SYNC_ENABLED") {
            throw new Error(`disabled synchronization accessed ${String(property)}`);
          }
          return target.GITHUB_SYNC_ENABLED;
        }
      }
    );
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(
        githubSyncWorker.scheduled(
          { scheduledTime: 1_000 } as ScheduledController,
          environment as never,
          {} as ExecutionContext
        )
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["missing token", { GITHUB_SYNC_ENABLED: "true", GITHUB_CREDENTIAL_VERSION: "credential" }],
    ["missing version", { GITHUB_SYNC_ENABLED: "true", GITHUB_CLASSIC_TOKEN: "synthetic-token" }],
    ["placeholder version", {
      GITHUB_SYNC_ENABLED: "true",
      GITHUB_CLASSIC_TOKEN: "synthetic-token",
      GITHUB_CREDENTIAL_VERSION: "unconfigured"
    }],
    ["invalid gate", { GITHUB_SYNC_ENABLED: "TRUE" }]
  ])("fails before D1 or GitHub access for %s", async (_label, bindings) => {
    const database = new Proxy({} as D1Database, {
      get() {
        throw new Error("invalid runtime synchronization accessed D1");
      }
    });
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(
        githubSyncWorker.scheduled(
          { scheduledTime: 1_000 } as ScheduledController,
          { MEMORY_DB: database, ...bindings } as never,
          {} as ExecutionContext
        )
      ).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("strictly parses and normalizes an approved baseline", () => {
    expect(
      parseApprovedAccessBaseline(
        {
          credential_version: "credential-current",
          user_id: 7,
          scopes_json: '[" REPO ","repo"]',
          repositories_json: JSON.stringify([
            {
              id: 84,
              permissions: { pull: true, push: false, admin: false }
            },
            {
              id: 42,
              permissions: { pull: true, push: true, admin: false }
            }
          ])
        },
        "credential-current"
      )
    ).toEqual({
      credentialVersion: "credential-current",
      userId: 7,
      scopes: ["repo"],
      repositories: [
        {
          id: 42,
          permissions: { pull: true, push: true, admin: false }
        },
        {
          id: 84,
          permissions: { pull: true, push: false, admin: false }
        }
      ]
    });
  });

  it.each([
    null,
    {
      credential_version: "wrong",
      user_id: 7,
      scopes_json: "[]",
      repositories_json: "[]"
    },
    {
      credential_version: "credential-current",
      user_id: 0,
      scopes_json: "[]",
      repositories_json: "[]"
    },
    {
      credential_version: "credential-current",
      user_id: 7,
      scopes_json: '["repo",42]',
      repositories_json: "[]"
    },
    {
      credential_version: "credential-current",
      user_id: 7,
      scopes_json: "[]",
      repositories_json:
        '[{"id":42,"permissions":{"pull":true,"push":false,"admin":false},"unexpected":true}]'
    },
    {
      credential_version: "credential-current",
      user_id: 7,
      scopes_json: "not-json",
      repositories_json: "[]"
    }
  ])("rejects a missing or malformed approved baseline", (row) => {
    expect(() => parseApprovedAccessBaseline(row, "credential-current")).toThrowError(
      "GITHUB_RECONCILIATION_REQUIRED"
    );
  });

  it("enforces configured repository access after observing the full baseline", async () => {
    const database = createBaselineDatabase({
      credential_version: "credential-current",
      user_id: 7,
      scopes_json: '["repo"]',
      repositories_json:
        '[{"id":42,"permissions":{"pull":true,"push":false,"admin":false}}]'
    });
    const client = createBaselineClient([
      {
        id: 42,
        permissions: { pull: true, push: false, admin: false }
      }
    ]);

    await expect(
      enforceApprovedAccessBaseline(database, client, "credential-current", new Set([42]))
    ).resolves.toEqual({ status: "active", warningThresholdDays: null });
    await expect(
      enforceApprovedAccessBaseline(database, client, "credential-current", new Set([42, 84]))
    ).rejects.toMatchObject({ code: "GITHUB_RECONCILIATION_REQUIRED" });
  });

  it.each([
    ["repo plus read:user", ["repo", "read:user"]],
    ["repo plus workflow", ["repo", "workflow"]],
    ["read:user without repo", ["read:user"]]
  ])("rejects runtime classic PAT scopes with %s", async (_label, scopes) => {
    const database = createBaselineDatabase({
      credential_version: "credential-current",
      user_id: 7,
      scopes_json: '["repo"]',
      repositories_json:
        '[{"id":42,"permissions":{"pull":true,"push":false,"admin":false}}]'
    });
    const client = createBaselineClient(
      [
        {
          id: 42,
          permissions: { pull: true, push: false, admin: false }
        }
      ],
      scopes
    );

    await expect(
      enforceApprovedAccessBaseline(database, client, "credential-current", new Set([42]))
    ).rejects.toMatchObject({ code: "GITHUB_PERMISSION_INSUFFICIENT" });
  });

  it("rejects an over-scoped approved baseline before runtime access", async () => {
    const database = createBaselineDatabase({
      credential_version: "credential-current",
      user_id: 7,
      scopes_json: '["repo","read:user"]',
      repositories_json:
        '[{"id":42,"permissions":{"pull":true,"push":false,"admin":false}}]'
    });
    const client = createBaselineClient([
      {
        id: 42,
        permissions: { pull: true, push: false, admin: false }
      }
    ]);

    await expect(
      enforceApprovedAccessBaseline(database, client, "credential-current", new Set([42]))
    ).rejects.toMatchObject({ code: "GITHUB_PERMISSION_INSUFFICIENT" });
  });




  it("collects a stable full-access baseline from identity and repository pages", async () => {
    const client = {
      getAuthenticatedUser: vi.fn().mockResolvedValue({
        status: "modified",
        value: { id: 7, login: "octocat" },
        etag: '"user"',
        scopes: [" REPO ", "repo"],
        rateLimit: undefined,
        credentialExpiresAt: TOKEN_EXPIRATION_ISO
      }),
      listAuthenticatedRepositories: vi.fn().mockResolvedValue({
        repositories: [
          {
            id: 84,
            permissions: { pull: true, push: false, admin: false }
          },
          {
            id: 42,
            permissions: { pull: true, push: true, admin: false }
          }
        ],
        scopes: ["Repo"],
        rateLimit: undefined
      })
    } as unknown as GitHubReadOnlyClient;

    await expect(collectAccessBaseline(client, "credential-current")).resolves.toEqual({
      credentialVersion: "credential-current",
      userId: 7,
      scopes: ["repo"],
      repositories: [
        {
          id: 42,
          permissions: { pull: true, push: true, admin: false }
        },
        {
          id: 84,
          permissions: { pull: true, push: false, admin: false }
        }
      ]
    });
  });

  it("uses the default branch when tracked refs are empty", () => {
    expect(parseTrackedRefs("[]", "main")).toEqual(["refs/heads/main"]);
  });

  it("validates and deduplicates explicitly tracked branches and tags", () => {
    expect(
      parseTrackedRefs(
        JSON.stringify([
          "refs/tags/release-2026-07-25",
          "refs/heads/release",
          "refs/heads/release"
        ]),
        "main"
      )
    ).toEqual([
      "refs/heads/main",
      "refs/heads/release",
      "refs/tags/release-2026-07-25"
    ]);
    expect(() => parseTrackedRefs('["pull/1/head"]', "main")).toThrowError(
      "GITHUB_REPOSITORY_UNAVAILABLE"
    );
    expect(() => parseTrackedRefs('["refs/heads/../admin"]', "main")).toThrowError(
      "GITHUB_REPOSITORY_UNAVAILABLE"
    );
    expect(() =>
      parseTrackedRefs(
        JSON.stringify(
          Array.from({ length: 513 }, (_, index) => `refs/heads/branch-${index}`)
        ),
        "main"
      )
    ).toThrowError("GITHUB_REPOSITORY_UNAVAILABLE");
  });

  it("classifies initial, unchanged, fast-forward, and force-push observations", () => {
    expect(classifyRefChange(null, OBSERVED_SHA)).toEqual({
      kind: "initial",
      historyGapPossible: false,
      reconciliationRequired: false
    });
    expect(classifyRefChange(OBSERVED_SHA, OBSERVED_SHA)).toEqual({
      kind: "unchanged",
      historyGapPossible: false,
      reconciliationRequired: false
    });
    expect(
      classifyRefChange(PREVIOUS_SHA, OBSERVED_SHA, {
        status: "ahead",
        ahead_by: 2,
        behind_by: 0,
        total_commits: 2,
        merge_base_commit: { sha: PREVIOUS_SHA }
      })
    ).toEqual({
      kind: "fast_forward",
      historyGapPossible: false,
      reconciliationRequired: false
    });
    expect(
      classifyRefChange(PREVIOUS_SHA, OBSERVED_SHA, {
        status: "diverged",
        ahead_by: 1,
        behind_by: 1,
        total_commits: 1,
        merge_base_commit: { sha: "c".repeat(40) }
      })
    ).toEqual({
      kind: "force_push",
      historyGapPossible: true,
      reconciliationRequired: true
    });
    expect(classifyRefChange(PREVIOUS_SHA, OBSERVED_SHA)).toEqual({
      kind: "reconciliation",
      historyGapPossible: true,
      reconciliationRequired: true
    });
  });

  it("fails closed when authenticated access or permissions expand", () => {
    const approved: AccessBaseline = {
      credentialVersion: "credential-current",
      userId: 7,
      scopes: ["repo"],
      repositories: [
        {
          id: 42,
          permissions: { pull: true, push: false, admin: false }
        }
      ]
    };

    expect(evaluateAccessBaseline(approved, approved)).toEqual({
      accepted: true,
      addedRepositoryIds: [],
      elevatedRepositoryIds: [],
      addedScopes: [],
      identityChanged: false,
      credentialVersionChanged: false
    });
    expect(
      evaluateAccessBaseline(approved, {
        ...approved,
        repositories: [
          ...approved.repositories,
          {
            id: 84,
            permissions: { pull: true, push: false, admin: false }
          },
          {
            id: 42,
            permissions: { pull: true, push: true, admin: false }
          }
        ]
      })
    ).toEqual(
      expect.objectContaining({
        accepted: false,
        addedRepositoryIds: [84],
        elevatedRepositoryIds: [42]
      })
    );
  });

  it("produces stable per-ref event IDs and idempotency keys", async () => {
    const first = await buildStableSyncEvent({
      projectId: "project-1",
      repositoryId: "repository-1",
      externalRepositoryId: 42,
      ref: "refs/heads/main",
      observedSha: OBSERVED_SHA,
      manifestId: "7".repeat(64)
    });
    const second = await buildStableSyncEvent({
      projectId: "project-1",
      repositoryId: "repository-1",
      externalRepositoryId: 42,
      ref: "refs/heads/main",
      observedSha: OBSERVED_SHA,
      manifestId: "7".repeat(64)
    });
    const reclassifiedManifest = await buildStableSyncEvent({
      projectId: "project-1",
      repositoryId: "repository-1",
      externalRepositoryId: 42,
      ref: "refs/heads/main",
      observedSha: OBSERVED_SHA,
      manifestId: "8".repeat(64)
    });

    expect(second).toEqual(first);
    expect(first.eventId).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.manifestId).toBe("7".repeat(64));
    expect(first.idempotencyKey).toBe(`github:42:${"7".repeat(64)}`);
    expect(reclassifiedManifest.eventId).not.toBe(first.eventId);
    expect(reclassifiedManifest.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(reclassifiedManifest.observedSha).toBe(first.observedSha);
  });

  it("builds a stable queued candidate plan with safe repository provenance", async () => {
    const input = githubBlobInput(
      "docs/architecture #1?.md",
      "Durable project context."
    );
    const first = await buildGitHubBlobCandidate(input);
    const second = await buildGitHubBlobCandidate(input);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      locator: expect.stringMatching(
        new RegExp(
          `^github://42/${OBSERVED_SHA}/ref-sha256/[a-f0-9]{64}/` +
            "docs/architecture%20%231%3F\\.md$",
          "u"
        )
      ),
      repositoryId: "repository-1",
      repositoryRef: "refs/heads/main",
      repositoryPath: "docs/architecture #1?.md",
      repositoryAuthority: "default_branch",
      sensitivityStatus: "clear"
    });
    expect(first.observation?.observationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    const observation = first.observation;
    expect(observation).toBeDefined();
    if (observation === undefined) {
      throw new Error("expected a safe GitHub candidate observation");
    }
    expect(observation.event).toMatchObject({
      type: "candidate.submitted",
      eventId: observation.observationId,
      candidateId: observation.observationId,
      projectId: "project-1"
    });
    expect(observation.event.idempotencyKey.length).toBeLessThanOrEqual(256);
    expect(observation.event).not.toHaveProperty("repositoryRef");
    expect(observation.event).not.toHaveProperty("repositoryPath");
    expect(observation.event).not.toHaveProperty("repositoryAuthority");
    expect(observation.content).toBe(input.content);
  });

  it("creates only a tombstone plan for sensitive content or a sensitive path", async () => {
    const secret = "api_key = 'synthetic-secret-value'";
    const contentSensitive = await buildGitHubBlobCandidate(
      githubBlobInput("docs/config.md", secret)
    );
    const pathSensitive = await buildGitHubBlobCandidate(
      githubBlobInput("config/secrets.json", '{"enabled":true}')
    );

    expect(contentSensitive.sensitivityStatus).toBe("tombstone");
    expect(contentSensitive.observation).toBeUndefined();
    expect(contentSensitive.repositoryPath).toBeNull();
    expect(contentSensitive.locator).not.toContain("docs/config.md");
    expect(contentSensitive.locator).toMatch(/\/path-sha256\/[0-9a-f]{64}$/u);
    expect(JSON.stringify(contentSensitive)).not.toContain(secret);
    expect(pathSensitive).toMatchObject({
      repositoryId: "repository-1",
      repositoryRef: "refs/heads/main",
      repositoryPath: null,
      repositoryAuthority: "default_branch",
      sensitivityStatus: "tombstone"
    });
    expect(pathSensitive.observation).toBeUndefined();
    expect(pathSensitive.locator).not.toContain("secrets.json");
  });

  it.each([
    [
      "prompt transcript",
      "### System\nFollow repository instructions.\n### User\nSummarize this file."
    ],
    [
      "raw log",
      [
        "2026-07-28T00:00:00Z INFO Worker started",
        "2026-07-28T00:00:01Z WARN Retry scheduled",
        "2026-07-28T00:00:02Z ERROR Sync failed"
      ].join("\n")
    ]
  ])("creates a bodyless tombstone for a %s", async (_label, content) => {
    const candidate = await buildGitHubBlobCandidate(
      githubBlobInput("docs/ingestion.txt", content)
    );

    expect(candidate.sensitivityStatus).toBe("tombstone");
    expect(candidate.observation).toBeUndefined();
    expect(JSON.stringify(candidate)).not.toContain(content);
  });

  it("rejects non-relative GitHub repository paths", async () => {
    await expect(
      buildGitHubBlobCandidate(
        githubBlobInput("docs/../credentials.md", "Durable project context.")
      )
    ).rejects.toMatchObject({ code: "GITHUB_PARTIAL_SYNC" });
  });

  it("accepts the 16 KiB model boundary and treats larger text as a partial sync", async () => {
    await expect(
      buildGitHubBlobCandidate(githubBlobInput("docs/boundary.md", "x".repeat(16 * 1024)))
    ).resolves.toMatchObject({ sensitivityStatus: "clear" });
    await expect(
      buildGitHubBlobCandidate(githubBlobInput("docs/model-large.md", "x".repeat(16 * 1024 + 1)))
    ).rejects.toMatchObject({ code: "GITHUB_PARTIAL_SYNC" });
    await expect(
      buildGitHubBlobCandidate(githubBlobInput("docs/transport-boundary.md", "x".repeat(64 * 1024)))
    ).rejects.toMatchObject({ code: "GITHUB_PARTIAL_SYNC" });
    await expect(
      buildGitHubBlobCandidate(githubBlobInput("docs/large.md", "x".repeat(64 * 1024 + 1)))
    ).rejects.toMatchObject({ code: "GITHUB_PARTIAL_SYNC" });
  });



  it("keeps the production scheduled handler limited to stable Workflow starts", async () => {
    const databaseAccess = vi.fn(() => {
      throw new Error("scheduled handler accessed D1");
    });
    const dispatchCreate = vi.fn().mockResolvedValue({});
    const retentionCreate = vi.fn().mockResolvedValue({});

    await githubSyncWorker.scheduled(
      {
        scheduledTime: Date.parse("2026-07-29T06:17:00.000Z")
      } as ScheduledController,
      {
        MEMORY_DB: { prepare: databaseAccess } as unknown as D1Database,
        GITHUB_SYNC_ENABLED: "true",
        GITHUB_CLASSIC_TOKEN: "synthetic-token",
        GITHUB_CREDENTIAL_VERSION: "credential-current",
        GITHUB_DISPATCH_WORKFLOW: {
          create: dispatchCreate,
          get: vi.fn()
        } as unknown as Workflow,
        GITHUB_RETENTION_WORKFLOW: {
          create: retentionCreate,
          get: vi.fn()
        } as unknown as Workflow
      },
      {} as ExecutionContext
    );

    expect(databaseAccess).not.toHaveBeenCalled();
    expect(dispatchCreate).toHaveBeenCalledOnce();
    expect(retentionCreate).toHaveBeenCalledOnce();
    expect(dispatchCreate.mock.calls[0]?.[0]).toMatchObject({
      id: expect.stringMatching(/^ghd-[0-9a-f]{64}$/u),
      params: { scheduledFor: "2026-07-29T06:00:00.000Z" }
    });
    expect(retentionCreate.mock.calls[0]?.[0]).toMatchObject({
      id: expect.stringMatching(/^ghc-[0-9a-f]{64}$/u),
      params: { utcDate: "2026-07-29" }
    });
    expect(JSON.stringify(dispatchCreate.mock.calls)).not.toContain(
      "synthetic-token"
    );
  });












  it("persists bounded retry and primary-rate reset schedules", () => {
    expect(computeNextSyncAt(1_000, undefined, 2_000)).toBe(
      "1970-01-01T00:00:03.000Z"
    );
    expect(
      computeNextSyncAt(1_000, {
        limit: 5_000,
        remaining: 0,
        used: 5_000,
        resetAt: 10_000,
        resource: "core",
        retryAfterMs: undefined
      })
    ).toBe("1970-01-01T06:00:01.000Z");
  });
});

function createBaselineClient(
  repositories: AccessBaseline["repositories"],
  scopes: string[] = ["repo"]
): GitHubReadOnlyClient {
  return {
    getAuthenticatedUser: vi.fn().mockResolvedValue({
      status: "modified",
      value: { id: 7, login: "octocat" },
      etag: undefined,
      scopes,
      rateLimit: undefined,
      credentialExpiresAt: TOKEN_EXPIRATION_ISO
    }),
    listAuthenticatedRepositories: vi.fn().mockResolvedValue({
      repositories,
      scopes,
      rateLimit: undefined
    })
  } as unknown as GitHubReadOnlyClient;
}

function createBaselineDatabase(row: unknown): D1Database {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(row),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
      })
    })
  } as unknown as D1Database;
}

function repositoryRow(
  repositoryId: string,
  externalId: number,
  overrides: Partial<{
    default_branch: string | null;
    tracked_refs_json: string;
  }> = {}
) {
  return {
    repository_id: repositoryId,
    project_id: "project-1",
    external_id: externalId,
    expected_owner_external_id: 7,
    owner: "memenow",
    name: `repository-${externalId}`,
    default_branch: "main",
    tracked_refs_json: "[]",
    repository_configuration_version: 1,
    repository_updated_at: "1970-01-01T00:00:00.000Z",
    ...overrides
  };
}

function createScheduledDatabase(
  repositories: ReturnType<typeof repositoryRow>[],
  baseline: unknown,
  failures: unknown[][],
  preparedQueries: string[] = []
): D1Database {
  const retentionCursor = (lane: unknown) => ({
    lane: String(lane),
    after_project_id: "",
    after_manifest_id: "",
    cursor_version: 0
  });
  return {
    withSession: vi.fn().mockReturnValue({
      prepare: vi.fn().mockImplementation((sql: string) => {
        preparedQueries.push(sql);
        const bound = (...bindings: unknown[]) => ({
          first: vi.fn().mockResolvedValue(
            sql.includes("FROM github_tree_manifest_retention_cursors")
              ? retentionCursor(bindings[0])
              : null
          ),
          all: vi.fn().mockResolvedValue({
            results: sql.includes("FROM repositories")
              ? repositories
              : selectSyntheticScheduledRefs(sql, bindings, repositories)
          }),
          run: vi.fn().mockImplementation(async () => {
            if (
              sql.includes("INSERT INTO sync_cursors") &&
              sql.includes("'failed'")
            ) {
              failures.push(bindings);
            }
            return { meta: { changes: 1 } };
          })
        });
        return {
          bind: vi.fn().mockImplementation(bound),
          all: vi.fn().mockImplementation(async () => ({
            results: sql.includes("FROM repositories") ? repositories : []
          }))
        };
      })
    }),
    prepare: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("FROM github_access_baselines")) {
        return {
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(baseline)
          })
        };
      }
      if (sql.includes("INSERT INTO sync_cursors")) {
        return {
          bind: vi.fn().mockImplementation((...bindings: unknown[]) => ({
            run: vi.fn().mockImplementation(async () => {
              failures.push(bindings);
              return {};
            })
          }))
        };
      }
      if (sql.includes("INSERT INTO github_credential_states")) {
        return {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } })
          })
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    })
  } as unknown as D1Database;
}

function selectSyntheticScheduledRefs(
  sql: string,
  bindings: unknown[],
  repositories: ReturnType<typeof repositoryRow>[],
  selectedKeys?: ReadonlySet<string>
): ScheduledRefFixture[] {
  if (!sql.includes("ROW_NUMBER() OVER")) {
    return [];
  }
  const configured = JSON.parse(String(bindings[0])) as ConfiguredRefFixture[];
  const limit = Number(bindings[2]);
  const firstByRepository = new Map<string, ConfiguredRefFixture>();
  for (const candidate of configured.sort((left, right) =>
    `${left.project_id}\n${left.repository_id}\n${left.ref}`.localeCompare(
      `${right.project_id}\n${right.repository_id}\n${right.ref}`
    )
  )) {
    const key = `${candidate.repository_id}:${candidate.ref}`;
    if (selectedKeys !== undefined && !selectedKeys.has(key)) {
      continue;
    }
    firstByRepository.set(
      candidate.repository_id,
      firstByRepository.get(candidate.repository_id) ?? candidate
    );
  }
  return [...firstByRepository.values()].slice(0, limit).flatMap((candidate) => {
    const repository = repositories.find(
      (row) =>
        row.project_id === candidate.project_id &&
        row.repository_id === candidate.repository_id
    );
    return repository === undefined
      ? []
      : [
          {
            ...repository,
            ref: candidate.ref,
            cursor_status: "complete",
            cursor_updated_at: "1970-01-01T00:00:00.000Z",
            cursor_version: 1,
            selected_head_manifest_id: null,
            selected_head_version: 0,
            last_sync_at: null
          }
        ];
  });
}

interface ConfiguredRefFixture {
  project_id: string;
  repository_id: string;
  ref: string;
}

type ScheduledRefFixture = ReturnType<typeof repositoryRow> & {
  ref: string;
  cursor_status: string;
  cursor_updated_at: string;
  cursor_version: number;
  selected_head_manifest_id: string | null;
  selected_head_version: number;
  last_sync_at: string | null;
};


interface CapturedStatement {
  sql: string;
  bindings: unknown[];
}

interface CapturedManifestEntry {
  path_digest: string;
  safe_path: string | null;
  blob_sha: string;
  byte_size: number;
  disposition: string;
}

function parseJsonRows(value: unknown): unknown[][] {
  return JSON.parse(String(value)) as unknown[][];
}

function parseOutboxPayloads(statement: CapturedStatement): Record<string, unknown>[] {
  if (statement.sql.includes("'candidate.submitted'")) {
    return parseJsonRows(statement.bindings[1]).map(
      (row) => JSON.parse(String(row[2])) as Record<string, unknown>
    );
  }
  return [JSON.parse(String(statement.bindings[2])) as Record<string, unknown>];
}

function expectFailureLifecycleBatch(batches: CapturedStatement[][]): void {
  expect(batches).toHaveLength(1);
  expect(batches[0]).toHaveLength(2);
  expect(batches[0]?.[0]?.sql).toContain("SET status = 'failed'");
  expect(batches[0]?.[1]?.sql).toContain(
    "INSERT INTO github_tree_manifest_lifecycle_events"
  );
  expect(batches[0]?.[1]?.sql).toContain("'failed'");
}

function githubBlobInput(path: string, content: string) {
  return {
    projectId: "project-1",
    repositoryId: "repository-1",
    externalRepositoryId: 42,
    defaultBranch: "main",
    ref: "refs/heads/main",
    observedSha: OBSERVED_SHA,
    path,
    blobSha: SAFE_BLOB_SHA,
    content
  };
}

function createFullSyncDatabase(
  batches: CapturedStatement[][],
  failures: unknown[][],
  repositoryOverrides: Partial<{
    default_branch: string | null;
    tracked_refs_json: string;
  }> = {},
  capturedManifestEntries: CapturedManifestEntry[] = [],
  initialState: {
    manifestId: string;
    observedSha: string;
    etag: string | null;
  } | null = null,
  additionalRepositories: ReturnType<typeof repositoryRow>[] = [],
  selectedRefKeys?: ReadonlySet<string>
): D1Database {
  const repository = repositoryRow("repository-1", 42, repositoryOverrides);
  const repositories = [repository, ...additionalRepositories];
  const retentionCursors = new Map([
    ["staging", { afterProjectId: "", afterManifestId: "", version: 0 }],
    ["failed", { afterProjectId: "", afterManifestId: "", version: 0 }]
  ]);
  let manifest: Record<string, unknown> | null = null;
  let manifestEntries: CapturedManifestEntry[] = [];
  const activeHeads = new Map<
    string,
    { manifestId: string; observedSha: string; headVersion: number }
  >();
  if (initialState !== null) {
    activeHeads.set(`${repository.repository_id}:refs/heads/main`, {
      manifestId: initialState.manifestId,
      observedSha: initialState.observedSha,
      headVersion: 1
    });
  }
  const prepare = (sql: string) => {
    const statement = {
      sql,
      bindings: [] as unknown[],
      bind(...bindings: unknown[]) {
        this.bindings = bindings;
        return this;
      },
      first: vi.fn().mockImplementation(async () => {
        if (sql.includes("FROM github_tree_manifest_retention_cursors")) {
          const lane = String(statement.bindings[0]);
          const cursor = retentionCursors.get(lane);
          return cursor === undefined
            ? null
            : {
                lane,
                after_project_id: cursor.afterProjectId,
                after_manifest_id: cursor.afterManifestId,
                cursor_version: cursor.version
              };
        }
        if (sql.includes("FROM github_access_baselines")) {
          return {
            credential_version: "credential-current",
            user_id: 7,
            scopes_json: '["repo"]',
            repositories_json: JSON.stringify(
              repositories.map((configuredRepository) => ({
                id: configuredRepository.external_id,
                permissions: { pull: true, push: false, admin: false }
              }))
            )
          };
        }
        if (
          sql.includes(
            "SELECT head.manifest_id, head.head_version, manifest.observed_sha"
          )
        ) {
          const activeHead = activeHeads.get(
            `${String(statement.bindings[1])}:${String(statement.bindings[2])}`
          );
          return activeHead === undefined
            ? null
            : {
                manifest_id: activeHead.manifestId,
                head_version: activeHead.headVersion,
                observed_sha: activeHead.observedSha
              };
        }
        if (sql.includes("FROM github_tree_manifests") && sql.includes("collection_key")) {
          return manifest;
        }
        if (sql.includes("SELECT manifest.repository_authority")) {
          return manifest === null
            ? null
            : {
                repository_authority: manifest.repository_authority,
                observed_sha: manifest.observed_sha,
                external_id:
                  repositories.find(
                    (configuredRepository) =>
                      configuredRepository.repository_id === manifest?.repository_id
                  )?.external_id ?? -1
              };
        }
        if (sql.includes("SELECT observed_sha, etag FROM sync_cursors")) {
          return initialState === null ||
            statement.bindings[1] !== repository.repository_id ||
            statement.bindings[2] !== "refs/heads/main"
            ? null
            : { observed_sha: initialState.observedSha, etag: initialState.etag };
        }
        if (sql.includes("SELECT head.manifest_id, cursor.observed_sha")) {
          const activeHead = activeHeads.get(
            `${String(statement.bindings[1])}:${String(statement.bindings[2])}`
          );
          return activeHead === undefined
            ? null
            : {
                manifest_id: activeHead.manifestId,
                observed_sha: activeHead.observedSha
              };
        }
        if (sql.includes("FROM canonical_repository_scope_ownership")) {
          return {
            scope_id: "repository:repository-1:ref:refs%2Fheads%2Frelease"
          };
        }
        return null;
      }),
      all: vi.fn().mockImplementation(async () => {
        if (sql.includes("FROM repositories")) {
          return { results: repositories };
        }
        if (sql.includes("ROW_NUMBER() OVER")) {
          const selected = selectSyntheticScheduledRefs(
            sql,
            statement.bindings,
            repositories,
            selectedRefKeys
          );
          return {
            results: selected.map((row) => {
              const ref = String(row.ref);
              const activeHead = activeHeads.get(
                `${row.repository_id}:${ref}`
              );
              return {
                ...row,
                selected_head_manifest_id: activeHead?.manifestId ?? null,
                selected_head_version: activeHead?.headVersion ?? 0
              };
            })
          };
        }
        if (sql.includes("WITH requested(path_digest)")) {
          const requested = new Set(
            JSON.parse(String(statement.bindings[0])) as string[]
          );
          return {
            results: manifestEntries.filter(
              (entry) =>
                entry.disposition === "text" &&
                requested.has(entry.path_digest)
            )
          };
        }
        if (sql.includes("FROM github_tree_manifest_entries")) {
          if (sql.includes("disposition = 'text'")) {
            return {
              results: manifestEntries.filter(
                (entry) => entry.disposition === "text"
              )
            };
          }
          const after = String(statement.bindings[2] ?? "");
          const limit = Number(statement.bindings[3] ?? 500);
          return {
            results: manifestEntries
              .filter((entry) => entry.path_digest > after)
              .sort((left, right) =>
                left.path_digest.localeCompare(right.path_digest)
              )
              .slice(0, limit)
          };
        }
        return { results: [] };
      }),
      run: vi.fn().mockImplementation(async function (this: CapturedStatement) {
        if (sql.includes("INSERT INTO github_tree_manifests")) {
          manifestEntries = [];
          manifest = {
            manifest_id: this.bindings[0],
            project_id: this.bindings[1],
            repository_id: this.bindings[2],
            ref: this.bindings[3],
            observed_sha: this.bindings[4],
            tree_sha: this.bindings[5],
            repository_authority: this.bindings[6],
            collection_key: this.bindings[7],
            created_at: this.bindings[8],
            status: "staging",
            entry_count: null,
            entries_checksum: null,
            failed_at: null,
            failure_code: null,
            purged_at: null
          };
        } else if (sql.includes("INSERT INTO github_tree_manifest_entries")) {
          const insertedEntries = (
            JSON.parse(String(this.bindings[2])) as unknown[][]
          ).map(
            (entry) => ({
              path_digest: String(entry[0]),
              safe_path: entry[1] === null ? null : String(entry[1]),
              blob_sha: String(entry[2]),
              byte_size: Number(entry[3]),
              disposition: String(entry[4])
            })
          );
          const entriesByPath = new Map(
            manifestEntries.map((entry) => [entry.path_digest, entry])
          );
          for (const entry of insertedEntries) {
            entriesByPath.set(entry.path_digest, entry);
          }
          manifestEntries = [...entriesByPath.values()];
          capturedManifestEntries.splice(
            0,
            capturedManifestEntries.length,
            ...manifestEntries
          );
        } else if (sql.includes("SET status = 'failed'")) {
          manifest = {
            ...manifest,
            status: "failed",
            entry_count: this.bindings[0],
            entries_checksum: this.bindings[1],
            failed_at: this.bindings[2],
            failure_code: this.bindings[3]
          };
        } else if (sql.includes("UPDATE github_tree_manifests")) {
          manifest = {
            ...manifest,
            status: "complete",
            entry_count: this.bindings[0],
            entries_checksum: this.bindings[1]
          };
        } else if (
          sql.includes("INSERT INTO sync_cursors") &&
          sql.includes("'failed'")
        ) {
          failures.push(this.bindings);
        }
        return { meta: { changes: 1 } };
      })
    };
    return statement;
  };
  return {
    withSession: vi.fn().mockReturnValue({ prepare }),
    prepare: vi.fn().mockImplementation(prepare),
    batch: vi.fn().mockImplementation(async (statements: CapturedStatement[]) => {
      batches.push(statements);
      return statements.map((statement) => {
        if (statement.sql.includes("INSERT INTO github_tree_ref_heads")) {
          activeHeads.set(
            `${String(statement.bindings[1])}:${String(statement.bindings[2])}`,
            {
              manifestId: String(statement.bindings[3]),
              observedSha: String(manifest?.observed_sha ?? OBSERVED_SHA),
              headVersion:
                (activeHeads.get(
                  `${String(statement.bindings[1])}:${String(statement.bindings[2])}`
                )?.headVersion ?? 0) + 1
            }
          );
        }
        return { meta: { changes: 1 } };
      });
    })
  } as unknown as D1Database;
}

function createFullSyncFetcher(
  blobs: Array<{ path: string; sha: string; content: string; size?: number }>,
  options: {
    defaultBranch?: string;
    ref?: string;
    refObject?: { sha: string; type: string };
    tagObjects?: Record<
      string,
      { sha: string; object: { sha: string; type: string } }
    >;
    refStatus?: number;
    untrustedProvenance?: Record<string, string>;
    truncated?: boolean;
  } = {}
) {
  const defaultBranch = options.defaultBranch ?? "main";
  const ref = options.ref ?? "refs/heads/main";
  const refPath = ref.slice("refs/".length);
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL((input as Request).url);
    if (url.pathname === "/user") {
      return new Response(JSON.stringify({ id: 7, login: "octocat" }), {
        headers: {
          "x-oauth-scopes": "repo",
          "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
        }
      });
    }
    if (url.pathname === "/user/repos") {
      return Response.json([
        {
          id: 42,
          full_name: "memenow/repository-42",
          owner: { id: 7 },
          permissions: { pull: true, push: false, admin: false }
        }
      ]);
    }
    if (url.pathname === "/repos/memenow/repository-42") {
      return Response.json({
        id: 42,
        owner: { id: 7 },
        default_branch: defaultBranch,
        ...options.untrustedProvenance
      });
    }
    if (url.pathname.includes("/git/ref/")) {
      const requestedRef = `refs/${url.pathname.split("/git/ref/")[1] ?? ""}`;
      if (requestedRef !== ref && requestedRef !== "refs/heads/main") {
        throw new Error(`unexpected GitHub ref request: ${requestedRef}`);
      }
      if (options.refStatus !== undefined) {
        return Response.json(
          { message: "synthetic rate limit" },
          {
            status: options.refStatus,
            headers: { "retry-after": "2" }
          }
        );
      }
      return Response.json({
        ref: requestedRef,
        object: options.refObject ?? { sha: OBSERVED_SHA, type: "commit" },
        ...options.untrustedProvenance
      });
    }
    if (url.pathname.includes("/git/tags/")) {
      const tagSha = url.pathname.split("/git/tags/")[1] ?? "";
      const tag = options.tagObjects?.[tagSha];
      if (tag === undefined) {
        throw new Error(`unexpected GitHub tag request: ${tagSha}`);
      }
      return Response.json(tag);
    }
    if (url.pathname.endsWith(`/commits/${OBSERVED_SHA}`)) {
      return Response.json({ sha: OBSERVED_SHA, tree: { sha: TREE_SHA } });
    }
    if (url.pathname.endsWith(`/compare/${PREVIOUS_SHA}...${OBSERVED_SHA}`)) {
      return Response.json({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        merge_base_commit: { sha: PREVIOUS_SHA }
      });
    }
    if (url.pathname.endsWith(`/git/trees/${TREE_SHA}`)) {
      return Response.json({
        sha: TREE_SHA,
        truncated: options.truncated ?? false,
        tree: blobs.map((blob) => ({
          path: blob.path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
          size: blob.size ?? new TextEncoder().encode(blob.content).byteLength,
          ...options.untrustedProvenance
        }))
      });
    }
    const blob = blobs.find((candidate) =>
      url.pathname.endsWith(`/git/blobs/${candidate.sha}`)
    );
    if (blob !== undefined) {
      return Response.json({
        sha: blob.sha,
        size: blob.size ?? new TextEncoder().encode(blob.content).byteLength,
        encoding: "utf-8",
        content: blob.content,
        ...options.untrustedProvenance
      });
    }
    throw new Error(`unexpected GitHub request: ${url.pathname}`);
  });
}

function createRequestBudgetFetcher(
  blobCount: number,
  includeSecondRepository = false
) {
  const files = Array.from({ length: blobCount }, (_, index) => ({
    path: `docs/budget-${String(index).padStart(4, "0")}.md`,
    mode: "100644",
    type: "blob",
    sha: SAFE_BLOB_SHA,
    size: 1
  }));
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL((input as Request).url);
    if (url.pathname === "/user") {
      return new Response(JSON.stringify({ id: 7, login: "octocat" }), {
        headers: {
          "x-oauth-scopes": "repo",
          "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
        }
      });
    }
    if (url.pathname === "/user/repos") {
      return Response.json([
        {
          id: 42,
          full_name: "memenow/repository-42",
          owner: { id: 7 },
          permissions: { pull: true, push: false, admin: false }
        },
        ...(includeSecondRepository
          ? [
              {
                id: 84,
                full_name: "memenow/repository-84",
                owner: { id: 7 },
                permissions: { pull: true, push: false, admin: false }
              }
            ]
          : [])
      ]);
    }
    if (url.pathname === "/repos/memenow/repository-42") {
      return Response.json({ id: 42, owner: { id: 7 }, default_branch: "main" });
    }
    if (url.pathname === "/repos/memenow/repository-84") {
      return Response.json({ id: 84, owner: { id: 7 }, default_branch: "main" });
    }
    if (url.pathname.endsWith("/repos/memenow/repository-84/git/ref/heads/main")) {
      return Response.json({
        ref: "refs/heads/main",
        object: { sha: SECOND_REPOSITORY_SHA, type: "commit" }
      });
    }
    if (url.pathname.endsWith("/git/ref/heads/main")) {
      return Response.json({
        ref: "refs/heads/main",
        object: { sha: OBSERVED_SHA, type: "commit" }
      });
    }
    if (url.pathname.endsWith("/git/ref/heads/release")) {
      return Response.json({
        ref: "refs/heads/release",
        object: { sha: RELEASE_SHA, type: "commit" }
      });
    }
    if (url.pathname.endsWith(`/compare/${PREVIOUS_SHA}...${OBSERVED_SHA}`)) {
      return Response.json({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
        merge_base_commit: { sha: PREVIOUS_SHA }
      });
    }
    if (url.pathname.endsWith(`/commits/${OBSERVED_SHA}`)) {
      return Response.json({ sha: OBSERVED_SHA, tree: { sha: TREE_SHA } });
    }
    if (url.pathname.endsWith(`/commits/${RELEASE_SHA}`)) {
      return Response.json({ sha: RELEASE_SHA, tree: { sha: RELEASE_TREE_SHA } });
    }
    if (url.pathname.endsWith(`/commits/${SECOND_REPOSITORY_SHA}`)) {
      return Response.json({
        sha: SECOND_REPOSITORY_SHA,
        tree: { sha: SECOND_REPOSITORY_TREE_SHA }
      });
    }
    if (url.pathname.endsWith(`/git/trees/${TREE_SHA}`)) {
      return Response.json({ sha: TREE_SHA, truncated: false, tree: files });
    }
    if (url.pathname.endsWith(`/git/trees/${RELEASE_TREE_SHA}`)) {
      return Response.json({ sha: RELEASE_TREE_SHA, truncated: false, tree: [] });
    }
    if (url.pathname.endsWith(`/git/trees/${SECOND_REPOSITORY_TREE_SHA}`)) {
      return Response.json({
        sha: SECOND_REPOSITORY_TREE_SHA,
        truncated: false,
        tree: []
      });
    }
    if (url.pathname.endsWith(`/git/blobs/${SAFE_BLOB_SHA}`)) {
      return Response.json({
        sha: SAFE_BLOB_SHA,
        size: 1,
        encoding: "utf-8",
        content: "x"
      });
    }
    throw new Error(`unexpected GitHub request: ${url.pathname}`);
  });
}

function createBaselinePaginationFetcher(pageCount: number) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL((input as Request).url);
    if (url.pathname === "/user") {
      return new Response(JSON.stringify({ id: 7, login: "octocat" }), {
        headers: {
          "x-oauth-scopes": "repo",
          "github-authentication-token-expiration": TOKEN_EXPIRATION_HEADER
        }
      });
    }
    if (url.pathname === "/user/repos") {
      const page = Number(url.searchParams.get("page"));
      const headers = new Headers({ "x-oauth-scopes": "repo" });
      if (page < pageCount) {
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        headers.set("link", `<${next.toString()}>; rel="next"`);
      }
      return Response.json(
        [
          {
            id: 42,
            full_name: "memenow/repository-42",
            owner: { id: 7 },
            permissions: { pull: true, push: false, admin: false }
          }
        ],
        { headers }
      );
    }
    if (url.pathname === "/repos/memenow/repository-42") {
      return Response.json({ id: 42, owner: { id: 7 }, default_branch: "main" });
    }
    if (url.pathname.endsWith("/git/ref/heads/main")) {
      return Response.json({
        ref: "refs/heads/main",
        object: { sha: OBSERVED_SHA, type: "commit" }
      });
    }
    if (url.pathname.endsWith(`/commits/${OBSERVED_SHA}`)) {
      return Response.json({ sha: OBSERVED_SHA, tree: { sha: TREE_SHA } });
    }
    if (url.pathname.endsWith(`/git/trees/${TREE_SHA}`)) {
      return Response.json({ sha: TREE_SHA, truncated: false, tree: [] });
    }
    throw new Error(`unexpected GitHub request: ${url.pathname}`);
  });
}

function requestCount(
  fetcher: ReturnType<typeof vi.fn>,
  pathPart: string
): number {
  return fetcher.mock.calls.filter(([input]) =>
    new URL((input as Request).url).pathname.includes(pathPart)
  ).length;
}

function requestExactCount(
  fetcher: ReturnType<typeof vi.fn>,
  path: string
): number {
  return fetcher.mock.calls.filter(
    ([input]) => new URL((input as Request).url).pathname === path
  ).length;
}
