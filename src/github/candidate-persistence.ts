import type { MemoryEvent } from "../gateway/service";
import { sha256 } from "../security/crypto";
import { GitHubSyncError } from "./client";

const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_ROWS = 100;

export interface PersistableGitHubCandidate {
  evidenceId: string;
  locator: string;
  repositoryId: string;
  repositoryRef: string;
  repositoryPath: string | null;
  repositoryAuthority: "default_branch" | "tracked_ref";
  excerptHash: string;
  sensitivityStatus: "clear" | "tombstone";
  observation?: {
    observationId: string;
    content: string;
    contentSha256: string;
    evidenceJson: string;
    event: Extract<MemoryEvent, { type: "candidate.submitted" }>;
  };
}

interface PreparedCandidate {
  candidate: PersistableGitHubCandidate;
  eventPayloadJson: string | null;
  eventPayloadDigest: string | null;
  encodedBytes: number;
}

interface CandidateTargetRow {
  repository_authority: "default_branch" | "tracked_ref";
  observed_sha: string;
  external_id: number;
}

export async function persistGitHubCandidates(input: {
  database: D1Database;
  projectId: string;
  repositoryId: string;
  repositoryRef: string;
  externalRepositoryId: number;
  manifestId: string;
  observedSha: string;
  candidates: readonly PersistableGitHubCandidate[];
}): Promise<void> {
  const statements = await prepareGitHubCandidateStatements(input);
  if (statements.length > 0) {
    await input.database.batch(statements);
  }
}

export async function prepareGitHubCandidateStatements(input: {
  database: D1Database;
  projectId: string;
  repositoryId: string;
  repositoryRef: string;
  externalRepositoryId: number;
  manifestId: string;
  observedSha: string;
  candidates: readonly PersistableGitHubCandidate[];
}): Promise<D1PreparedStatement[]> {
  const target = await input.database
    .withSession("first-primary")
    .prepare(
      `SELECT manifest.repository_authority, manifest.observed_sha,
              repository.external_id
       FROM github_tree_manifests AS manifest
       JOIN repositories AS repository
         ON repository.project_id = manifest.project_id
        AND repository.repository_id = manifest.repository_id
       WHERE manifest.project_id = ? AND manifest.repository_id = ?
         AND manifest.ref = ? AND manifest.manifest_id = ?
         AND manifest.status = 'complete'`
    )
    .bind(
      input.projectId,
      input.repositoryId,
      input.repositoryRef,
      input.manifestId
    )
    .first<CandidateTargetRow>();
  if (
    target === null ||
    target.observed_sha !== input.observedSha ||
    target.external_id !== input.externalRepositoryId
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  const prepared = await Promise.all(
    input.candidates.map(async (candidate): Promise<PreparedCandidate> => {
      if (
        candidate.repositoryId !== input.repositoryId ||
        candidate.repositoryRef !== input.repositoryRef ||
        candidate.repositoryAuthority !== target.repository_authority ||
        !Number.isSafeInteger(input.externalRepositoryId) ||
        input.externalRepositoryId <= 0 ||
        !/^[0-9A-Fa-f]{40,128}$/u.test(input.observedSha) ||
        (candidate.sensitivityStatus === "tombstone" &&
          (candidate.observation !== undefined ||
            candidate.repositoryPath !== null ||
            !hasDigestOnlyLocator(
              candidate.locator,
              input.externalRepositoryId,
              input.observedSha
            ))) ||
        (candidate.sensitivityStatus === "clear" &&
          (candidate.observation === undefined ||
            candidate.repositoryPath === null ||
            candidate.locator !==
              clearLocator(
                input.externalRepositoryId,
                input.observedSha,
                candidate.repositoryPath
              )))
      ) {
        throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
      }
      if (
        candidate.observation !== undefined &&
        (candidate.observation.event.projectId !== input.projectId ||
          candidate.observation.event.eventId !== candidate.observation.observationId ||
          candidate.observation.event.candidateId !==
            candidate.observation.observationId ||
          candidate.observation.contentSha256 !==
            (await sha256(candidate.observation.content)))
      ) {
        throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
      }
      const eventPayloadJson =
        candidate.observation === undefined
          ? null
          : JSON.stringify(candidate.observation.event);
      const eventPayloadDigest =
        eventPayloadJson === null ? null : await sha256(eventPayloadJson);
      const encodedBytes = new TextEncoder().encode(
        JSON.stringify([candidate, eventPayloadJson, eventPayloadDigest])
      ).byteLength;
      if (encodedBytes > MAX_BATCH_BYTES) {
        throw new GitHubSyncError("GITHUB_PARTIAL_SYNC");
      }
      return { candidate, eventPayloadJson, eventPayloadDigest, encodedBytes };
    })
  );

  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunkPreparedCandidates(prepared)) {
    statements.push(...buildChunkStatements(input, chunk));
  }
  return statements;
}

function clearLocator(
  externalRepositoryId: number,
  observedSha: string,
  repositoryPath: string
): string {
  const encodedPath = repositoryPath.split("/").map(encodeURIComponent).join("/");
  return `github://${externalRepositoryId}/${observedSha}/${encodedPath}`;
}

function hasDigestOnlyLocator(
  locator: string,
  externalRepositoryId: number,
  observedSha: string
): boolean {
  const prefix =
    `github://${externalRepositoryId}/${observedSha}/path-sha256/`;
  return locator.startsWith(prefix) && /^[0-9a-f]{64}$/u.test(locator.slice(prefix.length));
}

function buildChunkStatements(
  input: {
    database: D1Database;
    projectId: string;
    repositoryId: string;
    repositoryRef: string;
    externalRepositoryId: number;
    manifestId: string;
    observedSha: string;
  },
  chunk: readonly PreparedCandidate[]
): D1PreparedStatement[] {
  const now = new Date().toISOString();
  const evidenceRows = chunk.map(({ candidate }) => [
    candidate.evidenceId,
    candidate.locator,
    candidate.repositoryRef,
    candidate.repositoryPath,
    candidate.repositoryAuthority,
    candidate.excerptHash,
    candidate.sensitivityStatus
  ]);
  const observable = chunk.filter(
    (row): row is PreparedCandidate & {
      candidate: PersistableGitHubCandidate & {
        observation: NonNullable<PersistableGitHubCandidate["observation"]>;
      };
      eventPayloadJson: string;
      eventPayloadDigest: string;
    } =>
      row.candidate.observation !== undefined &&
      row.eventPayloadJson !== null &&
      row.eventPayloadDigest !== null
  );
  const statements: D1PreparedStatement[] = [
    input.database
      .prepare(
        `INSERT INTO evidence
         (evidence_id, project_id, source_type, locator, repository_id,
          repository_ref, repository_path, repository_authority, commit_sha,
          excerpt_hash, object_uri, sensitivity_status, recorded_at)
         SELECT json_extract(value, '$[0]'), ?, 'github_blob',
                json_extract(value, '$[1]'), ?, json_extract(value, '$[2]'),
                json_extract(value, '$[3]'), json_extract(value, '$[4]'), ?,
                json_extract(value, '$[5]'), NULL, json_extract(value, '$[6]'), ?
         FROM json_each(?) AS candidate
         JOIN github_tree_ref_heads AS head
           ON head.project_id = ? AND head.repository_id = ?
          AND head.ref = ? AND head.manifest_id = ?
         JOIN github_tree_manifests AS manifest
           ON manifest.project_id = head.project_id
          AND manifest.manifest_id = head.manifest_id
          AND manifest.observed_sha = ?
         JOIN repositories AS repository
           ON repository.project_id = head.project_id
          AND repository.repository_id = head.repository_id
          AND repository.external_id = ?
         WHERE json_extract(value, '$[4]') = manifest.repository_authority
           AND (
             json_extract(value, '$[6]') <> 'tombstone'
             OR json_extract(value, '$[1]') =
               'github://' || repository.external_id || '/' ||
               manifest.observed_sha || '/path-sha256/' ||
               substr(json_extract(value, '$[1]'), -64)
           )
         ON CONFLICT(project_id, source_type, locator, excerpt_hash) DO NOTHING`
      )
      .bind(
        input.projectId,
        input.repositoryId,
        input.observedSha,
        now,
        JSON.stringify(evidenceRows),
        input.projectId,
        input.repositoryId,
        input.repositoryRef,
        input.manifestId,
        input.observedSha,
        input.externalRepositoryId
      )
  ];

  if (observable.length > 0) {
    const observationRows = observable.map(({ candidate }) => [
      candidate.observation.observationId,
      candidate.observation.content,
      candidate.observation.contentSha256,
      candidate.observation.evidenceJson
    ]);
    const linkRows = observable.map(({ candidate }) => [
      candidate.observation.observationId,
      candidate.evidenceId
    ]);
    const outboxRows = observable.map(
      ({ candidate, eventPayloadDigest, eventPayloadJson }) => [
        candidate.observation.event.eventId,
        eventPayloadDigest,
        eventPayloadJson
      ]
    );
    statements.push(
      input.database
        .prepare(
          `INSERT INTO observations
           (observation_id, project_id, candidate_version, status, content,
            content_sha256, evidence_json, created_at, updated_at)
           SELECT json_extract(value, '$[0]'), ?, 1, 'queued',
                  json_extract(value, '$[1]'), json_extract(value, '$[2]'),
                  json_extract(value, '$[3]'), ?, ?
           FROM json_each(?) AS candidate
           JOIN github_tree_ref_heads AS head
             ON head.project_id = ? AND head.repository_id = ?
            AND head.ref = ? AND head.manifest_id = ?
           WHERE 1
           ON CONFLICT(project_id, observation_id) DO NOTHING`
        )
        .bind(
          input.projectId,
          now,
          now,
          JSON.stringify(observationRows),
          input.projectId,
          input.repositoryId,
          input.repositoryRef,
          input.manifestId
        ),
      input.database
        .prepare(
          `INSERT INTO observation_evidence
           (project_id, observation_id, evidence_id, created_at)
           SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?
           FROM json_each(?)
           WHERE EXISTS (
             SELECT 1 FROM observations AS observation
             WHERE observation.project_id = ?
               AND observation.observation_id = json_extract(value, '$[0]')
           ) AND EXISTS (
             SELECT 1 FROM evidence AS evidence
             WHERE evidence.project_id = ?
               AND evidence.evidence_id = json_extract(value, '$[1]')
           ) AND EXISTS (
             SELECT 1 FROM github_tree_ref_heads AS head
             WHERE head.project_id = ? AND head.repository_id = ?
               AND head.ref = ? AND head.manifest_id = ?
           )
           ON CONFLICT(project_id, observation_id, evidence_id) DO NOTHING`
        )
        .bind(
          input.projectId,
          now,
          JSON.stringify(linkRows),
          input.projectId,
          input.projectId,
          input.projectId,
          input.repositoryId,
          input.repositoryRef,
          input.manifestId
        ),
      input.database
        .prepare(
          `INSERT INTO outbox_events
           (event_id, project_id, project_version, event_type, payload_digest,
            payload_json, created_at)
           SELECT json_extract(value, '$[0]'), project.project_id,
                  project.project_version, 'candidate.submitted',
                  json_extract(value, '$[1]'), json_extract(value, '$[2]'), ?
           FROM json_each(?)
           JOIN projects AS project ON project.project_id = ?
           JOIN github_tree_ref_heads AS head
             ON head.project_id = project.project_id
            AND head.repository_id = ? AND head.ref = ?
            AND head.manifest_id = ?
           WHERE 1
           ON CONFLICT(event_id) DO NOTHING`
        )
        .bind(
          now,
          JSON.stringify(outboxRows),
          input.projectId,
          input.repositoryId,
          input.repositoryRef,
          input.manifestId
        )
    );
  }
  return statements;
}

function chunkPreparedCandidates(
  candidates: readonly PreparedCandidate[]
): PreparedCandidate[][] {
  const chunks: PreparedCandidate[][] = [];
  let current: PreparedCandidate[] = [];
  let currentBytes = 2;
  for (const candidate of candidates) {
    const nextBytes = currentBytes + candidate.encodedBytes + (current.length === 0 ? 0 : 1);
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_ROWS || nextBytes > MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(candidate);
    currentBytes += candidate.encodedBytes + (current.length === 1 ? 0 : 1);
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
