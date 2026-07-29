import {
  GitHubReadOnlyClient,
  GitHubSyncError,
  type GitComparison,
  type GitHubRateLimit
} from "../../src/github/client";
import type { MemoryEvent } from "../../src/gateway/service";
import {
  inspectMemoryModelInput,
  inspectSensitivePath
} from "../../src/quality/sensitive-content";
import { sha256 } from "../../src/security/crypto";
import {
  GITHUB_BLOB_TRANSPORT_LIMIT_BYTES,
  classifyGitHubBlobBytes,
  classifyGitHubBlobPath
} from "../../src/github/content-policy";
import {
  activateGitHubTreeManifest,
  beginGitHubTreeManifest,
  buildGitHubTreeManifestDescriptor,
  completeGitHubTreeManifest,
  persistGitHubTreeManifestEntries,
  readActiveGitHubTreeHead,
  type GitHubTreeManifestDescriptor,
  type GitHubTreeManifestEntry
} from "../../src/github/tree-manifest";
import {
  failGitHubTreeManifest,
  maintainGitHubTreeManifestRetention
} from "../../src/github/tree-manifest-retention";
import {
  buildGitHubBlobEvidenceId,
  buildGitHubClearEvidenceLocator,
  buildGitHubTombstoneEvidenceLocator,
  prepareGitHubCandidateStatements,
  type PersistableGitHubCandidate
} from "../../src/github/candidate-persistence";

interface Env {
  MEMORY_DB: D1Database;
  GITHUB_SYNC_ENABLED: string;
  GITHUB_CLASSIC_TOKEN?: string;
  GITHUB_CREDENTIAL_VERSION?: string;
}

interface RepositoryRow {
  repository_id: string;
  project_id: string;
  external_id: number;
  expected_owner_external_id: number | null;
  owner: string;
  name: string;
  default_branch: string | null;
  tracked_refs_json: string;
}

interface CursorRow {
  observed_sha: string | null;
  etag: string | null;
}

interface AccessBaselineRow {
  credential_version: string;
  user_id: number;
  scopes_json: string;
  repositories_json: string;
}

export interface CredentialExpirationClassification {
  status: "active" | "expiring" | "expired";
  warningThresholdDays: 14 | 7 | 1 | null;
}

const MAX_CANDIDATE_BYTES = GITHUB_BLOB_TRANSPORT_LIMIT_BYTES;
const MAX_RUN_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 2_000;
const MAX_GITHUB_REQUESTS = 900;
const SYNC_RUN_LEASE_MS = 60 * 60 * 1_000;

export type GitHubBlobCandidate = PersistableGitHubCandidate;

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const activeEnv = requireActiveGitHubSyncEnv(env);
    if (activeEnv === null) {
      return;
    }
    await synchronizeScheduledRepositories(controller, activeEnv);
    const retention = await maintainGitHubTreeManifestRetention(
      activeEnv.MEMORY_DB,
      controller.scheduledTime
    );
    if (retention.errors > 0) {
      console.warn("GitHub manifest retention completed with isolated errors.", {
        error_count: retention.errors,
        claimed_count: retention.claimed,
        purged_count: retention.purged
      });
    }
  }
} satisfies ExportedHandler<Env>;

interface ActiveGitHubSyncEnv extends Env {
  GITHUB_SYNC_ENABLED: "true";
  GITHUB_CLASSIC_TOKEN: string;
  GITHUB_CREDENTIAL_VERSION: string;
}

function requireActiveGitHubSyncEnv(env: Env): ActiveGitHubSyncEnv | null {
  if (env.GITHUB_SYNC_ENABLED === "false") {
    return null;
  }
  if (env.GITHUB_SYNC_ENABLED !== "true") {
    throw new Error("GITHUB_SYNC_ENABLED must be exactly true or false.");
  }
  if (
    typeof env.GITHUB_CLASSIC_TOKEN !== "string" ||
    env.GITHUB_CLASSIC_TOKEN.trim() === ""
  ) {
    throw new Error("Enabled GitHub sync requires GITHUB_CLASSIC_TOKEN.");
  }
  if (
    typeof env.GITHUB_CREDENTIAL_VERSION !== "string" ||
    env.GITHUB_CREDENTIAL_VERSION.trim() === "" ||
    env.GITHUB_CREDENTIAL_VERSION === "unconfigured"
  ) {
    throw new Error("Enabled GitHub sync requires a configured credential version.");
  }
  return env as ActiveGitHubSyncEnv;
}

async function synchronizeScheduledRepositories(
  controller: ScheduledController,
  env: ActiveGitHubSyncEnv
): Promise<void> {
  const repositories = await env.MEMORY_DB.withSession("first-primary")
    .prepare(
      `SELECT repository_id, project_id, external_id, expected_owner_external_id,
              owner, name, default_branch, tracked_refs_json
       FROM repositories WHERE lower(provider) = 'github' AND sync_enabled = 1`
    )
    .all<RepositoryRow>();
  const eligibleRepositories: RepositoryRow[] = [];
  for (const repository of repositories.results) {
    if (
      !Number.isSafeInteger(repository.expected_owner_external_id) ||
      (repository.expected_owner_external_id ?? 0) <= 0
    ) {
      await recordSyncFailure(
        env.MEMORY_DB,
        repository,
        "refs/heads/unknown",
        new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE"),
        controller.scheduledTime
      );
      continue;
    }
    eligibleRepositories.push(repository);
  }
  const allowedIds = new Set(
    eligibleRepositories.map((row) => row.external_id)
  );
  const client = new GitHubReadOnlyClient({
    token: env.GITHUB_CLASSIC_TOKEN,
    allowedRepositoryIds: allowedIds,
    maxRequests: MAX_GITHUB_REQUESTS
  });
  if (eligibleRepositories.length === 0) {
    return;
  }
  let credentialExpiration: CredentialExpirationClassification;
  try {
    credentialExpiration = await enforceApprovedAccessBaseline(
      env.MEMORY_DB,
      client,
      env.GITHUB_CREDENTIAL_VERSION,
      allowedIds,
      controller.scheduledTime
    );
  } catch (error) {
    const baselineError = toSyncError(error);
    if (baselineError.code === "GITHUB_CREDENTIAL_EXPIRED") {
      await recordInvalidCredentialObservation(
        env.MEMORY_DB,
        env.GITHUB_CREDENTIAL_VERSION,
        controller.scheduledTime
      );
    }
    for (const repository of eligibleRepositories) {
      await recordSyncFailure(
        env.MEMORY_DB,
        repository,
        "refs/heads/unknown",
        baselineError,
        controller.scheduledTime
      );
    }
    return;
  }
  const fullReconciliation = isDailyFullReconciliation(controller.scheduledTime);
  const credentialStatus =
    credentialExpiration.status === "expiring" ? "expiring" : "active";
  for (const repository of eligibleRepositories) {
    const runId = await claimRepositorySync(
      env.MEMORY_DB,
      repository,
      controller.scheduledTime,
      fullReconciliation
    );
    if (runId === null) {
      continue;
    }
    try {
      const refError = await syncRepository(
        repository,
        client,
        env,
        controller.scheduledTime,
        fullReconciliation,
        credentialStatus
      );
      await finishRepositorySyncRun(
        env.MEMORY_DB,
        runId,
        refError?.code ?? null
      );
    } catch (error) {
      const syncError = toSyncError(error);
      await recordSyncFailure(
        env.MEMORY_DB,
        repository,
        "refs/heads/unknown",
        syncError,
        controller.scheduledTime,
        credentialStatus
      );
      await finishRepositorySyncRun(
        env.MEMORY_DB,
        runId,
        syncError.code
      );
    }
  }
}

async function syncRepository(
  repository: RepositoryRow,
  client: GitHubReadOnlyClient,
  env: ActiveGitHubSyncEnv,
  scheduledTime: number,
  fullReconciliation: boolean,
  credentialStatus: "active" | "expiring"
): Promise<GitHubSyncError | null> {
  const metadata = await client.getRepository(
    repository.owner,
    repository.name,
    repository.external_id,
    repository.expected_owner_external_id as number
  );
  const verifiedDefaultBranch = metadata.default_branch;
  if (verifiedDefaultBranch === undefined || verifiedDefaultBranch === "") {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  if (
    repository.default_branch !== null &&
    repository.default_branch !== verifiedDefaultBranch
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const refs = parseTrackedRefs(repository.tracked_refs_json, verifiedDefaultBranch);
  let firstRefError: GitHubSyncError | null = null;
  for (const ref of refs) {
    try {
      await syncRef(
        repository,
        client,
        env,
        scheduledTime,
        ref,
        verifiedDefaultBranch,
        fullReconciliation,
        credentialStatus
      );
    } catch (error) {
      const syncError = toSyncError(error);
      firstRefError ??= syncError;
      await recordSyncFailure(
        env.MEMORY_DB,
        repository,
        ref,
        syncError,
        scheduledTime,
        credentialStatus
      );
    }
  }
  return firstRefError;
}

async function syncRef(
  repository: RepositoryRow,
  client: GitHubReadOnlyClient,
  env: Env,
  scheduledTime: number,
  ref: string,
  verifiedDefaultBranch: string,
  fullReconciliation: boolean,
  credentialStatus: "active" | "expiring"
): Promise<void> {
  let stagedManifest: GitHubTreeManifestDescriptor | null = null;
  try {
    await syncRefAttempt(
      repository,
      client,
      env,
      scheduledTime,
      ref,
      verifiedDefaultBranch,
      fullReconciliation,
      credentialStatus,
      (manifest) => {
        stagedManifest = manifest;
      }
    );
  } catch (error) {
    const syncError = toSyncError(error);
    if (stagedManifest !== null) {
      await failGitHubTreeManifest(
        env.MEMORY_DB,
        stagedManifest,
        syncError.code
      );
    }
    throw syncError;
  }
}

async function syncRefAttempt(
  repository: RepositoryRow,
  client: GitHubReadOnlyClient,
  env: Env,
  scheduledTime: number,
  ref: string,
  verifiedDefaultBranch: string,
  fullReconciliation: boolean,
  credentialStatus: "active" | "expiring",
  onManifestStaged: (manifest: GitHubTreeManifestDescriptor) => void
): Promise<void> {
  const activeHead = await readActiveGitHubTreeHead(
    env.MEMORY_DB,
    repository.project_id,
    repository.repository_id,
    ref
  );
  const cursor = await env.MEMORY_DB.prepare(
    `SELECT observed_sha, etag FROM sync_cursors
     WHERE project_id = ? AND repository_id = ? AND ref = ?`
  )
    .bind(repository.project_id, repository.repository_id, ref)
    .first<CursorRow>();
  const result = await client.getRefConditional(
    repository.owner,
    repository.name,
    repository.external_id,
    ref.slice("refs/".length),
    fullReconciliation || activeHead === null
      ? undefined
      : (cursor?.etag ?? undefined)
  );
  if (result.status === "not_modified") {
    if (
      cursor?.observed_sha === null ||
      cursor === null ||
      activeHead === null ||
      activeHead.observedSha !== cursor.observed_sha
    ) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    await markUnchanged(
      env.MEMORY_DB,
      repository,
      ref,
      scheduledTime,
      result.etag,
      result.rateLimit,
      credentialStatus
    );
    return;
  }
  const reference = result.value;
  if (reference.ref !== ref || reference.object.type !== "commit") {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  const observedSha = reference.object.sha;
  if (
    !fullReconciliation &&
    cursor?.observed_sha === observedSha &&
    activeHead?.observedSha === observedSha
  ) {
    await markUnchanged(
      env.MEMORY_DB,
      repository,
      ref,
      scheduledTime,
      result.etag,
      result.rateLimit,
      credentialStatus
    );
    return;
  }
  let comparison: GitComparison | undefined;
  if (
    cursor?.observed_sha !== null &&
    cursor !== null &&
    cursor.observed_sha !== observedSha
  ) {
    try {
      comparison = await client.compareCommits(
        repository.owner,
        repository.name,
        repository.external_id,
        cursor.observed_sha,
        observedSha
      );
    } catch (error) {
      if (
        !(error instanceof GitHubSyncError) ||
        error.code !== "GITHUB_REPOSITORY_UNAVAILABLE"
      ) {
        throw error;
      }
    }
  }
  const change = classifyRefChange(cursor?.observed_sha ?? null, observedSha, comparison);

  const commit = await client.getCommit(
    repository.owner,
    repository.name,
    repository.external_id,
    observedSha
  );
  if (commit.sha !== observedSha) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const tree = await client.getTree(
    repository.owner,
    repository.name,
    repository.external_id,
    commit.tree.sha
  );
  if (tree.truncated) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  if (tree.sha !== commit.tree.sha) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const manifest = await buildGitHubTreeManifestDescriptor({
    projectId: repository.project_id,
    repositoryId: repository.repository_id,
    ref,
    observedSha,
    treeSha: tree.sha,
    repositoryAuthority: classifyRepositoryAuthority(ref, verifiedDefaultBranch),
    collectionKey: scheduledIso(scheduledTime),
    createdAt: new Date().toISOString()
  });
  await beginGitHubTreeManifest(env.MEMORY_DB, manifest);
  onManifestStaged(manifest);
  let runBytes = 0;
  let fileCount = 0;
  let partialDetected = false;
  const manifestEntries: GitHubTreeManifestEntry[] = [];
  const candidates: GitHubBlobCandidate[] = [];
  for (const entry of tree.tree) {
    if (entry.type !== "blob") {
      continue;
    }
    const repositoryPath = validateRepositoryPath(entry.path);
    const pathDigest = await sha256(repositoryPath);
    const pathInspection = inspectSensitivePath(repositoryPath);
    const sensitivePath =
      !pathInspection.accepted || isSensitiveGitHubPath(repositoryPath);
    const safePath = sensitivePath ? null : repositoryPath;
    if (!Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0) {
      partialDetected = true;
      continue;
    }
    const byteSize = entry.size as number;
    const pathDecision = classifyGitHubBlobPath({
      path: repositoryPath,
      byteLength: byteSize
    });
    if (pathDecision.action === "exclude") {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: pathDecision.result.disposition
      });
      continue;
    }
    if (
      pathDecision.action === "partial" ||
      fileCount >= MAX_FILES ||
      runBytes + byteSize > MAX_RUN_BYTES
    ) {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: "partial"
      });
      partialDetected = true;
      continue;
    }
    fileCount += 1;
    const blob = await client.getBlob(
      repository.owner,
      repository.name,
      repository.external_id,
      entry.sha
    );
    if (blob.sha !== entry.sha || blob.size !== byteSize) {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: "partial"
      });
      partialDetected = true;
      continue;
    }
    const bytes = decodeBlobBytes(blob.encoding, blob.content);
    const classification = classifyGitHubBlobBytes({
      path: repositoryPath,
      bytes,
      declaredByteLength: blob.size
    });
    runBytes += bytes.byteLength;
    if (classification.disposition === "partial") {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: "partial"
      });
      partialDetected = true;
      continue;
    }
    if (
      classification.disposition === "binary_excluded" ||
      classification.disposition === "generated_excluded"
    ) {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: classification.disposition
      });
      continue;
    }
    const modelInspection = inspectMemoryModelInput(classification.text);
    if (!modelInspection.accepted && modelInspection.reason === "CONTENT_TOO_LARGE") {
      manifestEntries.push({
        pathDigest,
        safePath,
        blobSha: entry.sha,
        byteSize,
        disposition: "partial"
      });
      partialDetected = true;
      continue;
    }
    const candidate = await buildGitHubBlobCandidate({
      projectId: repository.project_id,
      repositoryId: repository.repository_id,
      externalRepositoryId: repository.external_id,
      defaultBranch: verifiedDefaultBranch,
      ref,
      observedSha,
      path: repositoryPath,
      blobSha: entry.sha,
      content: classification.text
    });
    manifestEntries.push({
      pathDigest,
      safePath: candidate.sensitivityStatus === "tombstone" ? null : safePath,
      blobSha: entry.sha,
      byteSize,
      disposition:
        candidate.sensitivityStatus === "tombstone"
          ? "sensitive_tombstone"
          : "text"
    });
    candidates.push(candidate);
  }
  await persistGitHubTreeManifestEntries(env.MEMORY_DB, manifest, manifestEntries);
  if (partialDetected) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  await completeGitHubTreeManifest(
    env.MEMORY_DB,
    manifest,
    manifestEntries,
    new Date().toISOString()
  );
  const candidateStatements = await prepareGitHubCandidateStatements({
    database: env.MEMORY_DB,
    projectId: repository.project_id,
    repositoryId: repository.repository_id,
    repositoryRef: ref,
    externalRepositoryId: repository.external_id,
    manifestId: manifest.manifestId,
    observedSha,
    candidates
  });
  const syncEvent = await buildStableSyncEvent({
    projectId: repository.project_id,
    repositoryId: repository.repository_id,
    externalRepositoryId: repository.external_id,
    ref,
    observedSha
  });
  const syncPayload = JSON.stringify(syncEvent);
  await activateGitHubTreeManifest({
    database: env.MEMORY_DB,
    descriptor: manifest,
    expectedHead: activeHead,
    expectedCursorObservedSha: cursor?.observed_sha ?? null,
    scheduledTime,
    nextSyncAt: computeNextSyncAt(scheduledTime, result.rateLimit),
    historyGapPossible: change.historyGapPossible,
    credentialStatus,
    etag: result.etag ?? null,
    syncEvent: {
      eventId: syncEvent.eventId,
      payloadDigest: await sha256(syncPayload),
      payloadJson: syncPayload
    },
    candidateStatements
  });
}

export interface AccessBaseline {
  credentialVersion: string;
  userId: number;
  scopes: string[];
  repositories: Array<{
    id: number;
    permissions: {
      pull: boolean;
      push: boolean;
      admin: boolean;
    };
  }>;
}

export interface RefChangeClassification {
  kind: "initial" | "unchanged" | "fast_forward" | "force_push" | "reconciliation";
  historyGapPossible: boolean;
  reconciliationRequired: boolean;
}

export async function enforceApprovedAccessBaseline(
  database: D1Database,
  client: GitHubReadOnlyClient,
  credentialVersion: string,
  configuredRepositoryIds: ReadonlySet<number>,
  observedAt: number = Date.now()
): Promise<CredentialExpirationClassification> {
  const row = await database.prepare(
    `SELECT credential_version, user_id, scopes_json, repositories_json
     FROM github_access_baselines WHERE credential_version = ?`
  )
    .bind(credentialVersion)
    .first<AccessBaselineRow>();
  const approved = parseApprovedAccessBaseline(row, credentialVersion);
  if (!hasExactClassicPatScope(approved.scopes)) {
    throw new GitHubSyncError("GITHUB_PERMISSION_INSUFFICIENT");
  }
  const identity = await client.getAuthenticatedUser();
  if (identity.status !== "modified") {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const credentialExpiration = await recordCredentialExpirationObservation(
    database,
    credentialVersion,
    identity.credentialExpiresAt,
    observedAt
  );
  if (credentialExpiration.status === "expired") {
    throw new GitHubSyncError("GITHUB_CREDENTIAL_EXPIRED");
  }
  const observed = await collectAccessBaseline(client, credentialVersion, identity);
  if (!hasExactClassicPatScope(observed.scopes)) {
    throw new GitHubSyncError("GITHUB_PERMISSION_INSUFFICIENT");
  }
  const evaluation = evaluateAccessBaseline(approved, observed);
  const approvedIds = new Set(
    approved.repositories
      .filter((repository) => repository.permissions.pull)
      .map((repository) => repository.id)
  );
  const observedIds = new Set(
    observed.repositories
      .filter((repository) => repository.permissions.pull)
      .map((repository) => repository.id)
  );
  const configuredAccessValid = [...configuredRepositoryIds].every(
    (id) => approvedIds.has(id) && observedIds.has(id)
  );
  if (!evaluation.accepted || !configuredAccessValid) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  return credentialExpiration;
}

export function parseApprovedAccessBaseline(
  row: AccessBaselineRow | null,
  credentialVersion: string
): AccessBaseline {
  if (
    row === null ||
    credentialVersion === "" ||
    row.credential_version !== credentialVersion ||
    !Number.isSafeInteger(row.user_id) ||
    row.user_id <= 0
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  let scopes: unknown;
  let repositories: unknown;
  try {
    scopes = JSON.parse(row.scopes_json);
    repositories = JSON.parse(row.repositories_json);
  } catch {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  if (
    !Array.isArray(scopes) ||
    scopes.some(
      (scope) =>
        typeof scope !== "string" ||
        !/^[a-z0-9:_-]+$/iu.test(scope.trim())
    ) ||
    !Array.isArray(repositories)
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const parsedRepositories: AccessBaseline["repositories"] = [];
  const repositoryIds = new Set<number>();
  for (const repository of repositories) {
    if (!isApprovedRepository(repository) || repositoryIds.has(repository.id)) {
      throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
    }
    repositoryIds.add(repository.id);
    parsedRepositories.push({
      id: repository.id,
      permissions: {
        pull: repository.permissions.pull,
        push: repository.permissions.push,
        admin: repository.permissions.admin
      }
    });
  }
  return {
    credentialVersion,
    userId: row.user_id,
    scopes: normalizeClassicPatScopes(scopes),
    repositories: parsedRepositories.sort((left, right) => left.id - right.id)
  };
}

export async function collectAccessBaseline(
  client: GitHubReadOnlyClient,
  credentialVersion: string,
  prefetchedIdentity?: Awaited<ReturnType<GitHubReadOnlyClient["getAuthenticatedUser"]>>
): Promise<AccessBaseline> {
  const identity = prefetchedIdentity ?? (await client.getAuthenticatedUser());
  if (identity.status !== "modified") {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const access = await client.listAuthenticatedRepositories();
  const repositories = new Map<
    number,
    { pull: boolean; push: boolean; admin: boolean }
  >();
  for (const repository of access.repositories) {
    const prior = repositories.get(repository.id);
    repositories.set(repository.id, {
      pull: (prior?.pull ?? false) || repository.permissions.pull,
      push: (prior?.push ?? false) || repository.permissions.push,
      admin: (prior?.admin ?? false) || repository.permissions.admin
    });
  }
  return {
    credentialVersion,
    userId: identity.value.id,
    scopes: normalizeClassicPatScopes([...identity.scopes, ...access.scopes]),
    repositories: [...repositories.entries()]
      .map(([id, permissions]) => ({ id, permissions }))
      .sort((left, right) => left.id - right.id)
  };
}

export function classifyCredentialExpiration(
  expiresAt: string,
  observedAt: number
): CredentialExpirationClassification {
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== expiresAt ||
    !Number.isFinite(observedAt)
  ) {
    throw new GitHubSyncError("GITHUB_CREDENTIAL_EXPIRED");
  }
  const remainingMs = expiresAtMs - observedAt;
  if (remainingMs <= 0) {
    return { status: "expired", warningThresholdDays: null };
  }
  const dayMs = 24 * 60 * 60 * 1_000;
  for (const threshold of [1, 7, 14] as const) {
    if (remainingMs <= threshold * dayMs) {
      return { status: "expiring", warningThresholdDays: threshold };
    }
  }
  return { status: "active", warningThresholdDays: null };
}

export async function recordCredentialExpirationObservation(
  database: D1Database,
  credentialVersion: string,
  expiresAt: string,
  observedAt: number
): Promise<CredentialExpirationClassification> {
  const classification = classifyCredentialExpiration(expiresAt, observedAt);
  const observedAtIso = scheduledIso(observedAt);
  const lastErrorCode =
    classification.status === "expired" ? "GITHUB_CREDENTIAL_EXPIRED" : null;
  const stateStatement = database.prepare(
    `INSERT INTO github_credential_states
     (credential_version, expires_at, last_observed_at, credential_status,
      warning_threshold_days, last_error_code, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(credential_version) DO UPDATE SET
       expires_at = excluded.expires_at,
       last_observed_at = excluded.last_observed_at,
       credential_status = excluded.credential_status,
       warning_threshold_days = excluded.warning_threshold_days,
       last_error_code = excluded.last_error_code,
       updated_at = excluded.updated_at`
  ).bind(
    credentialVersion,
    expiresAt,
    observedAtIso,
    classification.status,
    classification.warningThresholdDays,
    lastErrorCode,
    observedAtIso
  );
  if (classification.warningThresholdDays === null) {
    await stateStatement.run();
    return classification;
  }
  const eventDigest = await sha256(
    [
      "github.credential.expiry.warning",
      credentialVersion,
      String(classification.warningThresholdDays),
      expiresAt
    ].join("\n")
  );
  const warningStatement = database.prepare(
    `INSERT INTO github_credential_expiry_warnings
     (event_id, credential_version, threshold_days, expires_at, observed_at,
      event_digest)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(credential_version, threshold_days) DO NOTHING`
  ).bind(
    eventDigest,
    credentialVersion,
    classification.warningThresholdDays,
    expiresAt,
    observedAtIso,
    eventDigest
  );
  await database.batch([stateStatement, warningStatement]);
  return classification;
}

export function parseTrackedRefs(
  trackedRefsJson: string,
  defaultBranch: string
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trackedRefsJson);
  } catch {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  const refs = [`refs/heads/${defaultBranch}`, ...parsed];
  for (const ref of refs) {
    if (
      typeof ref !== "string" ||
      !/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(ref) ||
      ref.includes("..") ||
      ref.includes("//") ||
      ref.endsWith("/") ||
      ref.includes("@{")
    ) {
      throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
    }
  }
  return [...new Set(refs)].sort();
}

export function classifyRefChange(
  previousSha: string | null,
  observedSha: string,
  comparison?: GitComparison
): RefChangeClassification {
  if (previousSha === null) {
    return {
      kind: "initial",
      historyGapPossible: false,
      reconciliationRequired: false
    };
  }
  if (previousSha === observedSha) {
    return {
      kind: "unchanged",
      historyGapPossible: false,
      reconciliationRequired: false
    };
  }
  if (
    comparison?.status === "ahead" &&
    comparison.merge_base_commit.sha === previousSha &&
    comparison.behind_by === 0
  ) {
    return {
      kind: "fast_forward",
      historyGapPossible: false,
      reconciliationRequired: false
    };
  }
  if (comparison === undefined) {
    return {
      kind: "reconciliation",
      historyGapPossible: true,
      reconciliationRequired: true
    };
  }
  return {
    kind: "force_push",
    historyGapPossible: true,
    reconciliationRequired: true
  };
}

export function evaluateAccessBaseline(
  approved: AccessBaseline,
  observed: AccessBaseline
): {
  accepted: boolean;
  addedRepositoryIds: number[];
  elevatedRepositoryIds: number[];
  addedScopes: string[];
  identityChanged: boolean;
  credentialVersionChanged: boolean;
} {
  const approvedRepositories = new Map(
    approved.repositories.map((repository) => [repository.id, repository.permissions])
  );
  const observedRepositories = new Map(
    observed.repositories.map((repository) => [repository.id, repository.permissions])
  );
  const addedRepositoryIds = [...observedRepositories.keys()]
    .filter((id) => !approvedRepositories.has(id))
    .sort((left, right) => left - right);
  const elevatedRepositoryIds = [...observedRepositories.entries()]
    .filter(([id, permissions]) => {
      const prior = approvedRepositories.get(id);
      return (
        prior !== undefined &&
        ((!prior.pull && permissions.pull) ||
          (!prior.push && permissions.push) ||
          (!prior.admin && permissions.admin))
      );
    })
    .map(([id]) => id)
    .sort((left, right) => left - right);
  const normalizedApprovedScopes = normalizeClassicPatScopes(approved.scopes);
  const normalizedObservedScopes = normalizeClassicPatScopes(observed.scopes);
  const approvedScopes = new Set(normalizedApprovedScopes);
  const addedScopes = normalizedObservedScopes
    .filter((scope) => !approvedScopes.has(scope))
    .sort();
  const identityChanged = approved.userId !== observed.userId;
  const credentialVersionChanged =
    approved.credentialVersion !== observed.credentialVersion;
  return {
    accepted:
      addedRepositoryIds.length === 0 &&
      elevatedRepositoryIds.length === 0 &&
      addedScopes.length === 0 &&
      hasExactClassicPatScope(normalizedApprovedScopes) &&
      hasExactClassicPatScope(normalizedObservedScopes) &&
      !identityChanged &&
      !credentialVersionChanged,
    addedRepositoryIds,
    elevatedRepositoryIds,
    addedScopes,
    identityChanged,
    credentialVersionChanged
  };
}

function normalizeClassicPatScopes(scopes: readonly string[]): string[] {
  return [
    ...new Set(
      scopes
        .map((scope) => scope.trim().toLowerCase())
        .filter((scope) => scope !== "")
    )
  ].sort();
}

function hasExactClassicPatScope(scopes: readonly string[]): boolean {
  const normalized = normalizeClassicPatScopes(scopes);
  return normalized.length === 1 && normalized[0] === "repo";
}

export async function buildStableSyncEvent(input: {
  projectId: string;
  repositoryId: string;
  externalRepositoryId: number;
  ref: string;
  observedSha: string;
}): Promise<Extract<MemoryEvent, { type: "github.sync.requested" }>> {
  const idempotencyKey =
    `github:${input.externalRepositoryId}:${input.ref}:${input.observedSha}`;
  const eventId = await sha256(
    [
      "github.sync.requested",
      input.projectId,
      input.repositoryId,
      String(input.externalRepositoryId),
      input.ref,
      input.observedSha
    ].join("\n")
  );
  return {
    type: "github.sync.requested",
    eventId,
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    externalRepositoryId: input.externalRepositoryId,
    ref: input.ref,
    observedSha: input.observedSha,
    idempotencyKey
  };
}

export async function buildGitHubBlobCandidate(input: {
  projectId: string;
  repositoryId: string;
  externalRepositoryId: number;
  defaultBranch: string;
  ref: string;
  observedSha: string;
  path: string;
  blobSha: string;
  content: string;
}): Promise<GitHubBlobCandidate> {
  if (new TextEncoder().encode(input.content).byteLength > MAX_CANDIDATE_BYTES) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  const contentInspection = inspectMemoryModelInput(input.content);
  if (!contentInspection.accepted && contentInspection.reason === "CONTENT_TOO_LARGE") {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  const repositoryPath = validateRepositoryPath(input.path);
  const repositoryAuthority = classifyRepositoryAuthority(
    input.ref,
    input.defaultBranch
  );
  const pathInspection = inspectSensitivePath(input.path);
  const pathAccepted = pathInspection.accepted && !isSensitiveGitHubPath(input.path);
  const pathHash = await sha256(input.path);
  const evidenceId = await buildGitHubBlobEvidenceId({
    projectId: input.projectId,
    repositoryId: input.repositoryId,
    externalRepositoryId: input.externalRepositoryId,
    repositoryRef: input.ref,
    observedSha: input.observedSha,
    repositoryPath,
    blobSha: input.blobSha
  });
  if (!contentInspection.accepted || !pathAccepted) {
    return {
      evidenceId,
      locator: await buildGitHubTombstoneEvidenceLocator({
        externalRepositoryId: input.externalRepositoryId,
        repositoryRef: input.ref,
        observedSha: input.observedSha,
        repositoryPath
      }),
      repositoryId: input.repositoryId,
      repositoryRef: input.ref,
      repositoryPath: null,
      repositoryAuthority,
      excerptHash: await sha256("github-sensitive-tombstone"),
      sensitivityStatus: "tombstone"
    };
  }
  const contentSha256 = await sha256(input.content);
  const locator = await buildGitHubClearEvidenceLocator({
    externalRepositoryId: input.externalRepositoryId,
    repositoryRef: input.ref,
    observedSha: input.observedSha,
    repositoryPath
  });
  const observationId = await stableUuid(
    [
      "github.candidate",
      input.projectId,
      input.repositoryId,
      String(input.externalRepositoryId),
      input.ref,
      input.observedSha,
      input.path,
      input.blobSha
    ].join("\n")
  );
  const idempotencyDigest = await sha256(
    [input.ref, input.observedSha, pathHash, input.blobSha].join("\n")
  );
  const idempotencyKey =
    `github-candidate:${input.externalRepositoryId}:${idempotencyDigest}`;
  const event: Extract<MemoryEvent, { type: "candidate.submitted" }> = {
    type: "candidate.submitted",
    eventId: observationId,
    projectId: input.projectId,
    candidateId: observationId,
    idempotencyKey
  };
  return {
    evidenceId,
    locator,
    repositoryId: input.repositoryId,
    repositoryRef: input.ref,
    repositoryPath,
    repositoryAuthority,
    excerptHash: contentSha256,
    sensitivityStatus: "clear",
    observation: {
      observationId,
      content: input.content,
      contentSha256,
      evidenceJson: JSON.stringify([
        {
          source_type: "github_blob",
          locator,
          commit_sha: input.observedSha,
          excerpt_hash: contentSha256
        }
      ]),
      event
    }
  };
}

function classifyRepositoryAuthority(
  ref: string,
  verifiedDefaultBranch: string
): "default_branch" | "tracked_ref" {
  const [defaultRef] = parseTrackedRefs("[]", verifiedDefaultBranch);
  const validatedRefs = parseTrackedRefs(JSON.stringify([ref]), verifiedDefaultBranch);
  if (defaultRef === undefined || !validatedRefs.includes(ref)) {
    throw new GitHubSyncError("GITHUB_REPOSITORY_UNAVAILABLE");
  }
  return ref === defaultRef ? "default_branch" : "tracked_ref";
}

function validateRepositoryPath(path: string): string {
  const segments = path.split("/");
  if (
    path === "" ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    new TextEncoder().encode(path).byteLength > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
  }
  return path;
}


async function stableUuid(value: string): Promise<string> {
  const digest = await sha256(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function computeNextSyncAt(
  scheduledTime: number,
  rateLimit?: GitHubRateLimit,
  retryAfterMs?: number
): string {
  const normalNext =
    retryAfterMs === undefined ? scheduledTime + 6 * 60 * 60 * 1000 : scheduledTime;
  const retryNext =
    retryAfterMs === undefined ? scheduledTime : scheduledTime + retryAfterMs;
  const resetNext =
    rateLimit?.remaining === 0 && rateLimit.resetAt !== undefined
      ? rateLimit.resetAt + 1_000
      : scheduledTime;
  return new Date(Math.max(normalNext, retryNext, resetNext)).toISOString();
}

function decodeBlobBytes(
  encoding: "base64" | "utf-8",
  content: string
): Uint8Array {
  if (encoding === "utf-8") {
    return new TextEncoder().encode(content);
  }
  const normalized = content.replaceAll("\n", "");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isSensitiveGitHubPath(path: string): boolean {
  return /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))/iu.test(
    path
  );
}

function isApprovedRepository(value: unknown): value is {
  id: number;
  permissions: { pull: boolean; push: boolean; admin: boolean };
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    permissions?: unknown;
  };
  if (
    Object.keys(value).sort().join(",") !== "id,permissions" ||
    !Number.isSafeInteger(candidate.id) ||
    (candidate.id as number) <= 0 ||
    typeof candidate.permissions !== "object" ||
    candidate.permissions === null ||
    Object.keys(candidate.permissions).sort().join(",") !== "admin,pull,push"
  ) {
    return false;
  }
  const permissions = candidate.permissions as Record<string, unknown>;
  return (
    typeof permissions.pull === "boolean" &&
    typeof permissions.push === "boolean" &&
    typeof permissions.admin === "boolean"
  );
}

export function isDailyFullReconciliation(scheduledTime: number): boolean {
  if (!Number.isFinite(scheduledTime)) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const scheduled = new Date(scheduledTime);
  return scheduled.getUTCHours() === 0 && scheduled.getUTCMinutes() === 0;
}

async function recordInvalidCredentialObservation(
  database: D1Database,
  credentialVersion: string,
  observedAt: number
): Promise<void> {
  const observedAtIso = scheduledIso(observedAt);
  await database.prepare(
    `INSERT INTO github_credential_states
     (credential_version, expires_at, last_observed_at, credential_status,
      warning_threshold_days, last_error_code, updated_at)
     VALUES (?, NULL, ?, 'invalid', NULL, 'GITHUB_CREDENTIAL_EXPIRED', ?)
     ON CONFLICT(credential_version) DO UPDATE SET
       last_observed_at = excluded.last_observed_at,
       credential_status = CASE
         WHEN github_credential_states.credential_status = 'expired' THEN 'expired'
         ELSE 'invalid'
       END,
       warning_threshold_days = NULL,
       last_error_code = 'GITHUB_CREDENTIAL_EXPIRED',
       updated_at = excluded.updated_at`
  )
    .bind(credentialVersion, observedAtIso, observedAtIso)
    .run();
}

async function claimRepositorySync(
  database: D1Database,
  repository: RepositoryRow,
  scheduledTime: number,
  fullReconciliation: boolean
): Promise<string | null> {
  const scheduledFor = scheduledIso(scheduledTime);
  const claimedAtMs = Date.now();
  const claimedAt = new Date(claimedAtMs).toISOString();
  const leaseExpiresAt = new Date(claimedAtMs + SYNC_RUN_LEASE_MS).toISOString();
  const runId = await sha256(
    [
      "github.repository.sync.run",
      repository.project_id,
      repository.repository_id,
      scheduledFor
    ].join("\n")
  );
  const staleRunStatement = database.prepare(
    `UPDATE github_repository_sync_runs
     SET status = 'failed', completed_at = ?,
         last_error_code = 'GITHUB_RECONCILIATION_REQUIRED'
     WHERE project_id = ? AND repository_id = ? AND status = 'running'
       AND lease_expires_at <= ?`
  ).bind(
    claimedAt,
    repository.project_id,
    repository.repository_id,
    claimedAt
  );
  const claimStatement = database.prepare(
    `INSERT INTO github_repository_sync_runs
     (run_id, project_id, repository_id, scheduled_for, full_reconciliation,
      status, started_at, lease_expires_at)
     SELECT ?, ?, ?, ?, ?, 'running', ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM github_repository_sync_runs
       WHERE project_id = ? AND repository_id = ? AND status = 'running'
         AND lease_expires_at > ?
     )
     ON CONFLICT(project_id, repository_id, scheduled_for) DO NOTHING`
  ).bind(
    runId,
    repository.project_id,
    repository.repository_id,
    scheduledFor,
    fullReconciliation ? 1 : 0,
    claimedAt,
    leaseExpiresAt,
    repository.project_id,
    repository.repository_id,
    claimedAt
  );
  await staleRunStatement.run();
  const result = await claimStatement.run();
  return (result.meta.changes ?? 0) === 1 ? runId : null;
}

async function finishRepositorySyncRun(
  database: D1Database,
  runId: string,
  errorCode: string | null
): Promise<void> {
  const completedAt = new Date().toISOString();
  await database.prepare(
    `UPDATE github_repository_sync_runs
     SET status = ?, completed_at = ?, last_error_code = ?
     WHERE run_id = ? AND status = 'running'`
  )
    .bind(errorCode === null ? "complete" : "failed", completedAt, errorCode, runId)
    .run();
}

function scheduledIso(scheduledTime: number): string {
  if (!Number.isFinite(scheduledTime)) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  return new Date(scheduledTime).toISOString();
}

async function recordSyncFailure(
  database: D1Database,
  repository: RepositoryRow,
  ref: string,
  error: GitHubSyncError,
  scheduledTime: number,
  knownCredentialStatus: "active" | "expiring" = "active"
): Promise<void> {
  const historyGapPossible =
    error.code === "GITHUB_RECONCILIATION_REQUIRED" ? 1 : 0;
  const credentialStatus = [
    "GITHUB_AUTHORIZATION_REQUIRED",
    "GITHUB_CREDENTIAL_EXPIRED",
    "GITHUB_SSO_REQUIRED",
    "GITHUB_CLASSIC_PAT_BLOCKED",
    "GITHUB_PERMISSION_INSUFFICIENT"
  ].includes(error.code)
    ? "blocked"
    : knownCredentialStatus;
  await database.prepare(
    `INSERT INTO sync_cursors
     (project_id, repository_id, ref, status, next_sync_at, history_gap_possible,
      last_error_code, credential_status, updated_at)
     VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, repository_id, ref) DO UPDATE SET
       status = excluded.status, next_sync_at = excluded.next_sync_at,
       history_gap_possible = excluded.history_gap_possible,
       last_error_code = excluded.last_error_code,
       credential_status = excluded.credential_status, updated_at = excluded.updated_at`
  )
    .bind(
      repository.project_id,
      repository.repository_id,
      ref,
      computeNextSyncAt(
        scheduledTime,
        error.rateLimit,
        error.retryable ? error.retryAfterMs : undefined
      ),
      historyGapPossible,
      error.code,
      credentialStatus,
      new Date().toISOString()
    )
    .run();
}

async function markUnchanged(
  database: D1Database,
  repository: RepositoryRow,
  ref: string,
  scheduledTime: number,
  etag: string | undefined,
  rateLimit: GitHubRateLimit | undefined,
  credentialStatus: "active" | "expiring"
): Promise<void> {
  await database.prepare(
    `UPDATE sync_cursors
     SET status = 'complete', last_sync_at = ?, next_sync_at = ?, etag = ?,
         credential_status = ?, last_error_code = NULL, updated_at = ?
     WHERE project_id = ? AND repository_id = ? AND ref = ?`
  )
    .bind(
      new Date(scheduledTime).toISOString(),
      computeNextSyncAt(scheduledTime, rateLimit),
      etag ?? null,
      credentialStatus,
      new Date().toISOString(),
      repository.project_id,
      repository.repository_id,
      ref
    )
    .run();
}

function toSyncError(error: unknown): GitHubSyncError {
  return error instanceof GitHubSyncError
    ? error
    : new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
}
