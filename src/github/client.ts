const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const GITHUB_SUCCESS_JSON_MAX_BYTES = {
  user: 64 * 1024,
  repositoryPage: 4 * 1024 * 1024,
  repository: 512 * 1024,
  ref: 256 * 1024,
  commit: 4 * 1024 * 1024,
  compare: 8 * 1024 * 1024,
  tree: 8 * 1024 * 1024,
  blob: 128 * 1024
} as const;
const AUTHENTICATED_REPOSITORIES_PER_PAGE = 100;
export const MAX_AUTHENTICATED_REPOSITORIES = 10_000;
const MAX_AUTHENTICATED_REPOSITORY_PAGES =
  MAX_AUTHENTICATED_REPOSITORIES / AUTHENTICATED_REPOSITORIES_PER_PAGE;
const SEGMENT = "[A-Za-z0-9_.-]+";
const SHA = "[A-Fa-f0-9]{40,128}";
const ALLOWED_PATHS = [
  /^\/user$/u,
  /^\/user\/repos$/u,
  new RegExp(`^/repos/${SEGMENT}/${SEGMENT}$`, "u"),
  new RegExp(`^/repos/${SEGMENT}/${SEGMENT}/git/ref/${SEGMENT}(?:/${SEGMENT})*$`, "u"),
  new RegExp(`^/repos/${SEGMENT}/${SEGMENT}/commits/${SHA}$`, "u"),
  new RegExp(`^/repos/${SEGMENT}/${SEGMENT}/compare/${SHA}\\.\\.\\.${SHA}$`, "u"),
  new RegExp(`^/repos/${SEGMENT}/${SEGMENT}/git/trees/${SHA}$`, "u"),
  new RegExp(`^/repos/${SEGMENT}/${SEGMENT}/git/blobs/${SHA}$`, "u")
] as const;

export interface GitHubRequestPacer {
  wait(): Promise<void>;
}

export interface GitHubRequestPacerOptions {
  minimumIntervalMs: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface GitHubClientOptions {
  token: string;
  fetcher?: typeof fetch;
  allowedRepositoryIds: ReadonlySet<number>;
  maxRequests?: number;
  beforeRequest?: GitHubRequestPacer;
  requestTimeoutMs?: number;
  absoluteDeadlineMs?: number;
  now?: () => number;
}

export interface GitHubUser {
  id: number;
  login: string;
}

export interface RepositoryMetadata {
  id: number;
  owner: { id: number };
  default_branch?: string;
}

export interface RepositoryAccess {
  id: number;
  owner: { id: number };
  permissions: {
    pull: boolean;
    push: boolean;
    admin: boolean;
  };
}

export interface GitReference {
  ref: string;
  object: { sha: string; type: string };
}

export interface GitCommit {
  sha: string;
  tree: { sha: string };
}

export interface GitComparison {
  status: "ahead" | "behind" | "diverged" | "identical";
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  merge_base_commit: { sha: string };
}

export interface GitTree {
  sha: string;
  truncated: boolean;
  tree: Array<{
    path: string;
    mode: string;
    type: "blob" | "tree" | "commit";
    sha: string;
    size?: number;
  }>;
}

export interface GitBlob {
  sha: string;
  size: number;
  encoding: "base64" | "utf-8";
  content: string;
}

export interface GitHubRateLimit {
  limit: number | undefined;
  remaining: number | undefined;
  used: number | undefined;
  resetAt: number | undefined;
  resource: string | undefined;
  retryAfterMs: number | undefined;
}

export type ConditionalResult<T> =
  | {
      status: "modified";
      value: T;
      etag: string | undefined;
      scopes: string[];
      rateLimit: GitHubRateLimit | undefined;
    }
  | {
      status: "not_modified";
      etag: string | undefined;
      scopes: string[];
      rateLimit: GitHubRateLimit | undefined;
    };

export type CredentialConditionalResult<T> = ConditionalResult<T> & {
  credentialExpiresAt: string;
};

export const GITHUB_SYNC_ERROR_CODES = [
  "GITHUB_AUTHORIZATION_REQUIRED",
  "GITHUB_CREDENTIAL_EXPIRED",
  "GITHUB_SSO_REQUIRED",
  "GITHUB_CLASSIC_PAT_BLOCKED",
  "GITHUB_PERMISSION_INSUFFICIENT",
  "GITHUB_REPOSITORY_UNAVAILABLE",
  "GITHUB_RATE_LIMITED",
  "GITHUB_PARTIAL_SYNC",
  "GITHUB_RECONCILIATION_REQUIRED"
] as const;

export type GitHubSyncErrorCode = (typeof GITHUB_SYNC_ERROR_CODES)[number];

export class GitHubSyncError extends Error {
  readonly code: GitHubSyncErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly rateLimit: GitHubRateLimit | undefined;

  constructor(
    code: GitHubSyncErrorCode,
    options: {
      retryable?: boolean;
      retryAfterMs?: number;
      rateLimit?: GitHubRateLimit | undefined;
    } = {}
  ) {
    super(code);
    this.name = "GitHubSyncError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.rateLimit = options.rateLimit;
  }
}

export class GitHubReadOnlyClient {
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly allowedRepositoryIds: ReadonlySet<number>;
  private readonly beforeRequest: GitHubRequestPacer | undefined;
  private readonly requestTimeoutMs: number;
  private readonly absoluteDeadlineMs: number | undefined;
  private readonly now: () => number;
  private readonly verifiedRepositories = new Set<string>();
  private remainingRequests: number | null;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
    this.allowedRepositoryIds = options.allowedRepositoryIds;
    this.beforeRequest = options.beforeRequest;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.absoluteDeadlineMs = options.absoluteDeadlineMs;
    this.now = options.now ?? Date.now;
    if (
      options.maxRequests !== undefined &&
      (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1)
    ) {
      throw new TypeError("maxRequests must be a positive safe integer");
    }
    this.remainingRequests = options.maxRequests ?? null;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs < 1 ||
      this.requestTimeoutMs > 120_000
    ) {
      throw new TypeError("requestTimeoutMs must be between one and 120000");
    }
    if (
      this.absoluteDeadlineMs !== undefined &&
      (!Number.isFinite(this.absoluteDeadlineMs) || this.absoluteDeadlineMs < 0)
    ) {
      throw new TypeError("absoluteDeadlineMs must be a non-negative finite number");
    }
  }

  static isAllowedEndpoint(method: string, path: string): boolean {
    if (method !== "GET") {
      return false;
    }
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      /%(?:2e|2f|5c)/iu.test(path)
    ) {
      return false;
    }
    return ALLOWED_PATHS.some((pattern) => pattern.test(path));
  }

  getAuthenticatedUser(
    ifNoneMatch?: string
  ): Promise<CredentialConditionalResult<GitHubUser>> {
    return this.requestJson<GitHubUser>(
      new URL("/user", API_ORIGIN),
      ifNoneMatch,
      true
    );
  }

  async listAuthenticatedRepositories(): Promise<{
    repositories: RepositoryAccess[];
    scopes: string[];
    rateLimit: GitHubRateLimit | undefined;
  }> {
    let nextUrl: URL | undefined = new URL("/user/repos", API_ORIGIN);
    nextUrl.search = new URLSearchParams({
      visibility: "all",
      affiliation: "owner,collaborator,organization_member",
      sort: "full_name",
      direction: "asc",
      per_page: String(AUTHENTICATED_REPOSITORIES_PER_PAGE),
      page: "1"
    }).toString();
    const repositories = new Map<number, RepositoryAccess>();
    const scopes = new Set<string>();
    let rateLimit: GitHubRateLimit | undefined;
    let pageCount = 0;
    while (nextUrl !== undefined) {
      pageCount += 1;
      if (pageCount > MAX_AUTHENTICATED_REPOSITORY_PAGES) {
        throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
      }
      const response = await this.send(nextUrl);
      if (!response.ok) {
        throw await mapGitHubError(response);
      }
      const page = await readBoundedGitHubJson(
        response,
        successJsonMaxBytes(nextUrl)
      );
      if (
        !Array.isArray(page) ||
        page.length > AUTHENTICATED_REPOSITORIES_PER_PAGE
      ) {
        throw repositoryUnavailable();
      }
      for (const item of page) {
        const repository = parseRepositoryAccess(item);
        if (repository === null) {
          throw repositoryUnavailable();
        }
        const prior = repositories.get(repository.id);
        if (prior !== undefined && prior.owner.id !== repository.owner.id) {
          throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
        }
        repositories.set(repository.id, {
          id: repository.id,
          owner: { id: repository.owner.id },
          permissions: {
            pull: (prior?.permissions.pull ?? false) || repository.permissions.pull,
            push: (prior?.permissions.push ?? false) || repository.permissions.push,
            admin: (prior?.permissions.admin ?? false) || repository.permissions.admin
          }
        });
        if (repositories.size > MAX_AUTHENTICATED_REPOSITORIES) {
          throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
        }
      }
      for (const scope of parseScopes(response.headers)) {
        scopes.add(scope);
      }
      rateLimit = parseRateLimit(response.headers) ?? rateLimit;
      nextUrl = readNextPage(response.headers.get("link"));
    }
    return {
      repositories: [...repositories.values()].sort(
        (left, right) => left.id - right.id
      ),
      scopes: [...scopes].sort(),
      rateLimit
    };
  }

  async getRepository(
    owner: string,
    repository: string,
    expectedRepositoryId: number,
    expectedOwnerId: number
  ): Promise<RepositoryMetadata> {
    if (
      !this.allowedRepositoryIds.has(expectedRepositoryId) ||
      !Number.isSafeInteger(expectedOwnerId) ||
      expectedOwnerId <= 0
    ) {
      throw repositoryUnavailable();
    }
    const metadata = await this.getJson<RepositoryMetadata>(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repository)}`
    );
    if (
      metadata.id !== expectedRepositoryId ||
      !this.allowedRepositoryIds.has(metadata.id) ||
      metadata.owner?.id !== expectedOwnerId
    ) {
      throw repositoryUnavailable();
    }
    this.verifiedRepositories.add(repositoryKey(owner, repository, expectedRepositoryId));
    return metadata;
  }

  async getRef(
    owner: string,
    repository: string,
    expectedRepositoryId: number,
    ref: string
  ): Promise<GitReference> {
    const result = await this.getRefConditional(
      owner,
      repository,
      expectedRepositoryId,
      ref
    );
    if (result.status !== "modified") {
      throw repositoryUnavailable();
    }
    return result.value;
  }

  getRefConditional(
    owner: string,
    repository: string,
    expectedRepositoryId: number,
    ref: string,
    ifNoneMatch?: string
  ): Promise<ConditionalResult<GitReference>> {
    this.assertVerified(owner, repository, expectedRepositoryId);
    const encodedRef = ref.split("/").map(encodeSegment).join("/");
    return this.requestJson<GitReference>(
      new URL(
        `/repos/${encodeSegment(owner)}/${encodeSegment(repository)}/git/ref/${encodedRef}`,
        API_ORIGIN
      ),
      ifNoneMatch
    );
  }

  async getCommit(
    owner: string,
    repository: string,
    expectedRepositoryId: number,
    sha: string
  ): Promise<GitCommit> {
    this.assertVerified(owner, repository, expectedRepositoryId);
    assertSha(sha);
    return await this.getJson<GitCommit>(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repository)}/commits/${sha}`
    );
  }

  async compareCommits(
    owner: string,
    repository: string,
    expectedRepositoryId: number,
    baseSha: string,
    headSha: string
  ): Promise<GitComparison> {
    this.assertVerified(owner, repository, expectedRepositoryId);
    assertSha(baseSha);
    assertSha(headSha);
    return await this.getJson<GitComparison>(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repository)}/compare/${baseSha}...${headSha}`
    );
  }

  async getTree(
    owner: string,
    repository: string,
    expectedRepositoryId: number,
    sha: string
  ): Promise<GitTree> {
    this.assertVerified(owner, repository, expectedRepositoryId);
    assertSha(sha);
    return await this.getJson<GitTree>(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repository)}/git/trees/${sha}`,
      new URLSearchParams({ recursive: "1" })
    );
  }

  async getBlob(
    owner: string,
    repository: string,
    expectedRepositoryId: number,
    sha: string
  ): Promise<GitBlob> {
    this.assertVerified(owner, repository, expectedRepositoryId);
    assertSha(sha);
    return await this.getJson<GitBlob>(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repository)}/git/blobs/${sha}`
    );
  }

  private async getJson<T>(path: string, query?: URLSearchParams): Promise<T> {
    const url = new URL(path, API_ORIGIN);
    if (query !== undefined) {
      url.search = query.toString();
    }
    const result = await this.requestJson<T>(url);
    if (result.status !== "modified") {
      throw repositoryUnavailable();
    }
    return result.value;
  }

  private requestJson<T>(
    url: URL,
    ifNoneMatch: string | undefined,
    requireCredentialExpiration: true
  ): Promise<CredentialConditionalResult<T>>;
  private requestJson<T>(
    url: URL,
    ifNoneMatch?: string,
    requireCredentialExpiration?: false
  ): Promise<ConditionalResult<T>>;
  private async requestJson<T>(
    url: URL,
    ifNoneMatch?: string,
    requireCredentialExpiration = false
  ): Promise<ConditionalResult<T> | CredentialConditionalResult<T>> {
    const response = await this.send(url, ifNoneMatch);
    if (response.status === 304 && ifNoneMatch === undefined) {
      throw repositoryUnavailable();
    }
    if (response.status !== 304 && !response.ok) {
      throw await mapGitHubError(response);
    }
    const credentialExpiresAt = requireCredentialExpiration
      ? parseCredentialExpiration(response.headers)
      : undefined;
    const metadata = {
      etag: response.headers.get("etag") ?? undefined,
      scopes: parseScopes(response.headers),
      rateLimit: parseRateLimit(response.headers),
      ...(credentialExpiresAt === undefined ? {} : { credentialExpiresAt })
    };
    if (response.status === 304) {
      return { status: "not_modified", ...metadata };
    }
    return {
      status: "modified",
      value: (await readBoundedGitHubJson(
        response,
        successJsonMaxBytes(url)
      )) as T,
      ...metadata
    };
  }

  private async send(url: URL, ifNoneMatch?: string): Promise<Response> {
    assertAllowedUrl(url);
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "EdgeMneme",
      "X-GitHub-Api-Version": API_VERSION
    });
    if (ifNoneMatch !== undefined) {
      if (
        ifNoneMatch.length > 1_024 ||
        ifNoneMatch.includes("\r") ||
        ifNoneMatch.includes("\n")
      ) {
        throw repositoryUnavailable();
      }
      headers.set("If-None-Match", ifNoneMatch);
    }
    if (this.remainingRequests !== null) {
      if (this.remainingRequests === 0) {
        throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
      }
      this.remainingRequests -= 1;
    }
    await this.beforeRequest?.wait();
    const now = this.now();
    if (!Number.isFinite(now)) {
      throw new TypeError("GitHub client clock must return a finite number");
    }
    const remainingMs =
      this.absoluteDeadlineMs === undefined
        ? this.requestTimeoutMs
        : Math.min(this.requestTimeoutMs, this.absoluteDeadlineMs - now);
    if (remainingMs < 1) {
      throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
    }
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)));
    let response: Response;
    try {
      response = await this.fetcher(
        new Request(url, {
          method: "GET",
          redirect: "manual",
          headers,
          signal
        })
      );
    } catch {
      if (signal.aborted) {
        throw new GitHubSyncError("GITHUB_PARTIAL_SYNC", {
          retryable: true,
          retryAfterMs: 1_000
        });
      }
      throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE", {
        retryable: true,
        retryAfterMs: 1_000
      });
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      throw repositoryUnavailable();
    }
    return response;
  }

  private assertVerified(
    owner: string,
    repository: string,
    expectedRepositoryId: number
  ): void {
    if (
      !this.verifiedRepositories.has(
        repositoryKey(owner, repository, expectedRepositoryId)
      )
    ) {
      throw repositoryUnavailable();
    }
  }
}

export function createGitHubRequestPacer(
  options: GitHubRequestPacerOptions
): GitHubRequestPacer {
  if (
    !Number.isFinite(options.minimumIntervalMs) ||
    options.minimumIntervalMs < 0
  ) {
    throw new TypeError("minimumIntervalMs must be a non-negative finite number");
  }
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));
  let previousStartAt: number | null = null;
  let gate = Promise.resolve();
  return {
    wait(): Promise<void> {
      const turn = gate.then(async () => {
        const current = now();
        if (!Number.isFinite(current)) {
          throw new TypeError("request pacer clock must return a finite number");
        }
        const delayMs =
          previousStartAt === null
            ? 0
            : Math.max(0, previousStartAt + options.minimumIntervalMs - current);
        if (delayMs > 0) {
          await sleep(delayMs);
        }
        const startedAt = now();
        if (!Number.isFinite(startedAt)) {
          throw new TypeError("request pacer clock must return a finite number");
        }
        previousStartAt = startedAt;
      });
      gate = turn.catch(() => undefined);
      return turn;
    }
  };
}

function assertAllowedUrl(url: URL): void {
  if (
    url.origin !== API_ORIGIN ||
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !GitHubReadOnlyClient.isAllowedEndpoint("GET", url.pathname)
  ) {
    throw repositoryUnavailable();
  }
  assertAllowedQuery(url);
}

function assertAllowedQuery(url: URL): void {
  const entries = [...url.searchParams.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw repositoryUnavailable();
  }
  if (url.pathname === "/user/repos") {
    const allowed = new Set([
      "visibility",
      "affiliation",
      "sort",
      "direction",
      "per_page",
      "page"
    ]);
    if (entries.some(([key]) => !allowed.has(key))) {
      throw repositoryUnavailable();
    }
    const expected = {
      visibility: "all",
      affiliation: "owner,collaborator,organization_member",
      sort: "full_name",
      direction: "asc",
      per_page: "100"
    } as const;
    for (const [key, value] of Object.entries(expected)) {
      if (url.searchParams.get(key) !== value) {
        throw repositoryUnavailable();
      }
    }
    const page = url.searchParams.get("page") ?? "1";
    if (!/^[1-9][0-9]*$/u.test(page)) {
      throw repositoryUnavailable();
    }
    return;
  }
  if (/\/git\/trees\//u.test(url.pathname)) {
    if (entries.length !== 1 || url.searchParams.get("recursive") !== "1") {
      throw repositoryUnavailable();
    }
    return;
  }
  if (entries.length !== 0) {
    throw repositoryUnavailable();
  }
}

function readNextPage(link: string | null): URL | undefined {
  if (link === null || link.trim() === "") {
    return undefined;
  }
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/u.exec(part);
    if (match?.[2] === "next" && match[1] !== undefined) {
      const url = new URL(match[1]);
      assertAllowedUrl(url);
      return url;
    }
  }
  return undefined;
}

function parseRepositoryAccess(value: unknown): RepositoryAccess | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as {
    id?: unknown;
    full_name?: unknown;
    owner?: { id?: unknown };
    permissions?: { pull?: unknown; push?: unknown; admin?: unknown };
  };
  const id = candidate.id;
  const ownerId = candidate.owner?.id;
  const pull = candidate.permissions?.pull;
  const push = candidate.permissions?.push;
  const admin = candidate.permissions?.admin;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof candidate.full_name !== "string" ||
    typeof ownerId !== "number" ||
    !Number.isSafeInteger(ownerId) ||
    ownerId <= 0 ||
    typeof pull !== "boolean" ||
    typeof push !== "boolean" ||
    typeof admin !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    owner: { id: ownerId },
    permissions: {
      pull,
      push,
      admin
    }
  };
}

function encodeSegment(value: string): string {
  if (
    value === "." ||
    value === ".." ||
    !new RegExp(`^${SEGMENT}$`, "u").test(value)
  ) {
    throw repositoryUnavailable();
  }
  return encodeURIComponent(value);
}

function assertSha(value: string): void {
  if (!new RegExp(`^${SHA}$`, "u").test(value)) {
    throw repositoryUnavailable();
  }
}

function repositoryKey(owner: string, repository: string, id: number): string {
  return `${owner.toLowerCase()}/${repository.toLowerCase()}:${id}`;
}

function parseScopes(headers: Headers): string[] {
  return [
    ...new Set(
      (headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope) => scope !== "")
    )
  ].sort();
}

function parseCredentialExpiration(headers: Headers): string {
  const value = headers.get("github-authentication-token-expiration");
  const match =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/u.exec(
      value ?? ""
    );
  if (match === null) {
    throw new GitHubSyncError("GITHUB_CREDENTIAL_EXPIRED");
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new GitHubSyncError("GITHUB_CREDENTIAL_EXPIRED");
  }
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const parsed = new Date(timestamp);
  if (
    !Number.isFinite(timestamp) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    throw new GitHubSyncError("GITHUB_CREDENTIAL_EXPIRED");
  }
  return parsed.toISOString();
}

function parseRateLimit(headers: Headers): GitHubRateLimit | undefined {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"));
  const values = {
    limit: parseNonNegativeInteger(headers.get("x-ratelimit-limit")),
    remaining: parseNonNegativeInteger(headers.get("x-ratelimit-remaining")),
    used: parseNonNegativeInteger(headers.get("x-ratelimit-used")),
    resetAt: parseEpochMilliseconds(headers.get("x-ratelimit-reset")),
    resource: headers.get("x-ratelimit-resource") ?? undefined,
    retryAfterMs
  };
  return Object.values(values).every((value) => value === undefined) ? undefined : values;
}

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (value === null || !/^[0-9]+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseEpochMilliseconds(value: string | null): number | undefined {
  const seconds = parseNonNegativeInteger(value);
  const milliseconds = seconds === undefined ? undefined : seconds * 1000;
  return milliseconds !== undefined && Number.isSafeInteger(milliseconds)
    ? milliseconds
    : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  const seconds = parseNonNegativeInteger(value);
  return seconds === undefined ? undefined : Math.min(seconds, 3600) * 1000;
}

function repositoryUnavailable(): GitHubSyncError {
  return new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
}

function successJsonMaxBytes(url: URL): number {
  const path = url.pathname;
  if (path === "/user") return GITHUB_SUCCESS_JSON_MAX_BYTES.user;
  if (path === "/user/repos") {
    return GITHUB_SUCCESS_JSON_MAX_BYTES.repositoryPage;
  }
  if (path.includes("/git/ref/")) return GITHUB_SUCCESS_JSON_MAX_BYTES.ref;
  if (path.includes("/commits/")) return GITHUB_SUCCESS_JSON_MAX_BYTES.commit;
  if (path.includes("/compare/")) return GITHUB_SUCCESS_JSON_MAX_BYTES.compare;
  if (path.includes("/git/trees/")) return GITHUB_SUCCESS_JSON_MAX_BYTES.tree;
  if (path.includes("/git/blobs/")) return GITHUB_SUCCESS_JSON_MAX_BYTES.blob;
  return GITHUB_SUCCESS_JSON_MAX_BYTES.repository;
}

async function readBoundedGitHubJson(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^[0-9]+$/u.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }

  const body = response.body;
  if (body === null) {
    return JSON.parse("") as unknown;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - total) {
        await reader.cancel().catch(() => undefined);
        throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function mapGitHubError(response: Response): Promise<GitHubSyncError> {
  const rateLimit = parseRateLimit(response.headers);
  const message = response.status === 403
    ? await readBoundedGitHubErrorMessage(response)
    : "";
  if (response.status === 401) {
    return new GitHubSyncError("GITHUB_AUTHORIZATION_REQUIRED", { rateLimit });
  }
  if (response.status === 403 && response.headers.has("x-github-sso")) {
    return new GitHubSyncError("GITHUB_SSO_REQUIRED", { rateLimit });
  }
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (rateLimit?.remaining === 0 ||
        rateLimit?.retryAfterMs !== undefined ||
        message.includes("secondary rate limit") ||
        message.includes("abuse detection")))
  ) {
    const resetDelay =
      rateLimit?.resetAt === undefined
        ? undefined
        : Math.max(0, rateLimit.resetAt - Date.now());
    const retryAfterMs = rateLimit?.retryAfterMs ?? resetDelay ?? 60_000;
    return new GitHubSyncError("GITHUB_RATE_LIMITED", {
      retryable: true,
      retryAfterMs,
      rateLimit
    });
  }
  if (response.status >= 500 && response.status <= 599) {
    return new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE", {
      retryable: true,
      retryAfterMs: rateLimit?.retryAfterMs ?? 1_000,
      rateLimit
    });
  }
  if (response.status === 403) {
    const namesClassicToken =
      message.includes("classic personal access token") ||
      message.includes("personal access token (classic)") ||
      message.includes("personal access tokens (classic)");
    if (
      namesClassicToken &&
      (message.includes("disabled") || message.includes("not allowed"))
    ) {
      return new GitHubSyncError("GITHUB_CLASSIC_PAT_BLOCKED", { rateLimit });
    }
    return new GitHubSyncError("GITHUB_PERMISSION_INSUFFICIENT", { rateLimit });
  }
  return new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE", { rateLimit });
}

async function readBoundedGitHubErrorMessage(response: Response): Promise<string> {
  try {
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      Number.isFinite(Number(contentLength)) &&
      Number(contentLength) > 16_384
    ) {
      return "";
    }
    const body = response.body;
    if (body === null) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16_384) {
        void reader.cancel().catch(() => undefined);
        return "";
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      message?: unknown;
    };
    return typeof payload.message === "string"
      ? payload.message.slice(0, 4_096).toLowerCase()
      : "";
  } catch {
    return "";
  }
}
