import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAiAnalysis,
  assertSyntheticMemoryObjects,
  assertSyntheticVectorProjection,
  decodeSyntheticClientResult,
  decodeD1Rows,
  executeSyntheticCleanup,
  expectedProjectionObjectKeys,
  PROJECT_SCOPED_TABLES,
  projectionObjectKeys,
  sqlLiteral,
  SYNTHETIC_FORMAL_MEMORY_CONTENT,
  syntheticCleanupSql,
  syntheticAiAnalysisVerificationSql,
  syntheticSearchProjectionVerificationSql,
  syntheticSeedSql,
  validateSyntheticCleanupLedger,
  vectorIdsFromProjectionRows
} from "./synthetic-canary-support.mjs";
import {
  canaryUuid,
  clientEnvironment,
  delay,
  requireGatewayUrl,
  requireResourceName,
  requiredEnvironment,
  runProcess,
  runProcessAsync,
  runProcessAsyncStatus,
  runProcessCapture,
  runProcessCaptureIfFound,
  sha256Text,
  waitForCredentialPropagation,
  wranglerEnvironment
} from "./canary-process.mjs";

const cleanupOnly = process.argv.slice(2).includes("--cleanup-only");
if (process.argv.slice(2).some((argument) => argument !== "--cleanup-only")) {
  throw new Error("The synthetic canary received an unsupported argument.");
}
const configPath =
  process.env.EDGEMNEME_WRANGLER_CONFIG ??
  "wrangler/.wrangler/memory-gateway.generated.jsonc";
const projectionBucket =
  process.env.EDGEMNEME_PROJECTION_BUCKET ?? "edgemneme-projections";
const vectorIndex = process.env.EDGEMNEME_VECTOR_INDEX ?? "edgemneme-memory";
requireResourceName(projectionBucket, "projection bucket");
requireResourceName(vectorIndex, "Vectorize index");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "edgemneme-canary-"));
chmodSync(temporaryDirectory, 0o700);
const seedPath = join(temporaryDirectory, "seed.sql");
const cleanupPath = join(temporaryDirectory, "cleanup.sql");
const clientResultPath = join(temporaryDirectory, "client-result.json");
const cleanupLedgerPath =
  process.env.EDGEMNEME_CANARY_CLEANUP_LEDGER ??
  join(temporaryDirectory, "cleanup-ledger.json");
const projectId = canaryUuid("EDGEMNEME_CANARY_PROJECT_ID", cleanupOnly);
const principalId = canaryUuid("EDGEMNEME_CANARY_PRINCIPAL_ID", cleanupOnly);
const repositoryId = canaryUuid("EDGEMNEME_CANARY_REPOSITORY_ID", false);
const promotionCandidateId = canaryUuid(
  "EDGEMNEME_CANARY_PROMOTION_CANDIDATE_ID",
  false
);
const projectRef = `system.synthetic.${projectId}`;
const gatewayUrl = cleanupOnly ? null : requireGatewayUrl("EDGEMNEME_GATEWAY_URL");
const pepper = cleanupOnly ? null : requiredEnvironment("TOKEN_DIGEST_PEPPER");
if (pepper !== null && pepper.length < 32) {
  throw new Error("TOKEN_DIGEST_PEPPER must contain at least 32 characters.");
}
const token = cleanupOnly ? null : randomBytes(48).toString("base64url");
const tokenDigest =
  token === null || pepper === null
    ? null
    : createHmac("sha256", pepper).update(token).digest("base64url");
const now = new Date().toISOString();
let seedAttempted = cleanupOnly;
let operationError;

if (!cleanupOnly) {
  writeFileSync(
    seedPath,
    syntheticSeedSql({
      projectId,
      principalId,
      repositoryId,
      promotionCandidateId,
      projectRef,
      tokenDigest,
      now
    }),
    { mode: 0o600 }
  );
}
writeFileSync(cleanupPath, syntheticCleanupSql(projectId, principalId), { mode: 0o600 });

try {
  if (!cleanupOnly) {
    seedAttempted = true;
    runD1File(seedPath, "Synthetic seed");
    await waitForCredentialPropagation(gatewayUrl, token);
    runProcess(
      process.execPath,
      ["scripts/synthetic-canary-client.mjs"],
      "Synthetic MCP client",
      clientEnvironment({
        EDGEMNEME_GATEWAY_URL: gatewayUrl,
        EDGEMNEME_GATEWAY_EXPECTED_HOST:
          process.env.EDGEMNEME_GATEWAY_EXPECTED_HOST ?? "",
        EDGEMNEME_CANARY_TOKEN: token,
        EDGEMNEME_CANARY_PROJECT_REF: projectRef,
        EDGEMNEME_CANARY_PROJECT_ID: projectId,
        EDGEMNEME_CANARY_REPOSITORY_ID: repositoryId,
        EDGEMNEME_CANARY_PROMOTION_CANDIDATE_ID: promotionCandidateId,
        EDGEMNEME_CANARY_RESULT_FILE: clientResultPath
      }),
      "inherit"
    );
    const clientResult = readSyntheticClientResult(clientResultPath);
    verifyWorkersAiAnalysis(
      projectId,
      clientResult.candidateId,
      clientResult.workflowId
    );
    await verifyFormalProjection(projectId);
  }
} catch (error) {
  operationError = error;
}

let cleanupError;
if (seedAttempted) {
  try {
    await cleanupSyntheticProject(projectId, principalId, cleanupPath, cleanupLedgerPath);
    console.log("Synthetic D1, Vectorize, and R2 records cleaned.");
  } catch (error) {
    cleanupError = new Error(`Synthetic cleanup failed for reserved project ${projectRef}.`, {
      cause: error
    });
  }
}
if (!cleanupError) {
  rmSync(temporaryDirectory, { recursive: true, force: true });
} else {
  console.error(`Synthetic cleanup recovery files retained at ${temporaryDirectory}.`);
}

if (cleanupError) {
  throw cleanupError;
}
if (operationError) {
  throw operationError;
}
if (!cleanupOnly) {
  console.log(
    "Synthetic canary passed: Workers AI, 8 MCP tools, formal revision, FTS, Vectorize, R2, resources, and session CAS verified."
  );
}

function runD1File(file, label) {
  runProcess(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "MEMORY_DB",
      "--remote",
      "--config",
      configPath,
      "--file",
      file
    ],
    label,
    wranglerEnvironment(),
    "ignore"
  );
}

function runD1Query(database, command, label) {
  const result = runProcessCapture(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      database,
      "--remote",
      "--config",
      configPath,
      "--command",
      command,
      "--json"
    ],
    label
  );
  return decodeD1Rows(result, label);
}

function verifyWorkersAiAnalysis(syntheticProjectId, candidateId, workflowId) {
  const rows = runD1Query(
    "MEMORY_DB",
    syntheticAiAnalysisVerificationSql(syntheticProjectId, candidateId, workflowId),
    "Workers AI canary verification"
  );
  assertAiAnalysis(rows);
}

function readSyntheticClientResult(resultPath) {
  try {
    return decodeSyntheticClientResult(readFileSync(resultPath, "utf8"));
  } catch {
    throw new Error("The synthetic MCP client did not return valid candidate and workflow IDs.");
  }
}

async function verifyFormalProjection(syntheticProjectId) {
  const project = sqlLiteral(syntheticProjectId);
  const authority = runD1Query(
    "MEMORY_DB",
    `SELECT m.memory_id, m.scope_id, v.revision_id, v.content, v.content_sha256,
            p.project_version, ps.manifest_key, ps.manifest_sha256
     FROM projects p
     JOIN memories m ON m.project_id = p.project_id
     JOIN memory_versions v
       ON v.project_id = m.project_id AND v.revision_id = m.current_revision_id
     JOIN projection_snapshots ps
       ON ps.project_id = p.project_id AND ps.snapshot_id = p.active_snapshot_id
     WHERE p.project_id = ${project} AND m.status = 'active'
       AND ps.status = 'active'`,
    "Synthetic formal authority verification"
  );
  if (authority.length !== 1) {
    throw new Error("The synthetic formal memory does not have one active snapshot.");
  }
  const head = authority[0];
  if (
    typeof head.memory_id !== "string" ||
    typeof head.revision_id !== "string" ||
    head.content !== SYNTHETIC_FORMAL_MEMORY_CONTENT ||
    head.content_sha256 !== sha256Text(SYNTHETIC_FORMAL_MEMORY_CONTENT) ||
    head.scope_id !== syntheticProjectId ||
    !Number.isSafeInteger(head.project_version) ||
    head.project_version !== 1 ||
    typeof head.manifest_key !== "string" ||
    !/^[a-f0-9]{64}$/u.test(String(head.manifest_sha256))
  ) {
    throw new Error("The synthetic formal memory authority is invalid.");
  }

  const searchRows = runD1Query(
    "SEARCH_DB",
    syntheticSearchProjectionVerificationSql(syntheticProjectId),
    "Synthetic FTS projection verification"
  );
  if (
    searchRows.length !== 1 ||
    searchRows[0]?.project_id !== syntheticProjectId ||
    searchRows[0]?.memory_id !== head.memory_id ||
    searchRows[0]?.revision_id !== head.revision_id ||
    searchRows[0]?.chunk_id !== "chunk-0" ||
    searchRows[0]?.status !== "active" ||
    searchRows[0]?.kind !== "fact" ||
    searchRows[0]?.memory_class !== "semantic" ||
    searchRows[0]?.scope !== "project" ||
    searchRows[0]?.scope_id !== syntheticProjectId ||
    searchRows[0]?.repository_partition !== "*" ||
    searchRows[0]?.chunk_count !== 1 ||
    !Number.isSafeInteger(searchRows[0]?.fts_rowid) ||
    searchRows[0].fts_rowid < 1 ||
    searchRows[0]?.content !== SYNTHETIC_FORMAL_MEMORY_CONTENT ||
    searchRows[0]?.generation_status !== "active"
  ) {
    throw new Error("The synthetic FTS projection is incomplete.");
  }

  const vectorIds = vectorIdsFromProjectionRows(syntheticProjectId, searchRows);
  if (searchRows[0]?.ledger_vector_id !== vectorIds[0]) {
    throw new Error("The synthetic FTS projection ledger ownership is invalid.");
  }
  const vectors = await waitForVectorizeVectors(vectorIds);
  if (vectors.length !== 1) {
    throw new Error("The synthetic Vectorize projection is incomplete.");
  }
  const vector = vectors[0];
  const expectedVector = {
    id: vectorIds[0],
    projectId: syntheticProjectId,
    memoryId: head.memory_id,
    revisionId: head.revision_id,
    chunkId: "chunk-0",
    generationId: searchRows[0]?.generation_id,
    repositoryPartition: "*"
  };
  assertSyntheticVectorProjection(vector, expectedVector);
  const filteredMatches = queryVectorizeRepositoryPartition(
    vectorIds[0],
    syntheticProjectId
  );
  if (filteredMatches.length !== 1) {
    throw new Error("The synthetic Vectorize repository filter did not match project memory.");
  }
  assertSyntheticVectorProjection(filteredMatches[0], expectedVector, {
    requireValues: false
  });

  const manifestBody = readR2Object(head.manifest_key, "Synthetic R2 manifest read");
  if (sha256Text(manifestBody) !== head.manifest_sha256) {
    throw new Error("The synthetic R2 manifest checksum is invalid.");
  }
  const manifestKeys = new Set(
    projectionObjectKeys(
      syntheticProjectId,
      head.project_version,
      head.manifest_key,
      manifestBody
    )
  );
  const expectedKeys = new Set(
    expectedProjectionObjectKeys(syntheticProjectId, head.project_version, [
      {
        memory_id: head.memory_id,
        revision_id: head.revision_id,
        scope_id: head.scope_id
      }
    ])
  );
  if (
    manifestKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !manifestKeys.has(key))
  ) {
    throw new Error("The synthetic R2 snapshot file set is incomplete.");
  }
  const manifest = JSON.parse(manifestBody);
  const memory = Array.isArray(manifest.memories)
    ? manifest.memories.find(
        (entry) =>
          entry?.memory_id === head.memory_id && entry?.revision_id === head.revision_id
      )
    : undefined;
  if (
    typeof memory !== "object" ||
    memory === null ||
    typeof memory.object_key !== "string" ||
    typeof memory.revision_key !== "string" ||
    !manifestKeys.has(memory.object_key) ||
    !manifestKeys.has(memory.revision_key) ||
    !/^[a-f0-9]{64}$/u.test(String(memory.object_sha256)) ||
    !/^[a-f0-9]{64}$/u.test(String(memory.revision_sha256))
  ) {
    throw new Error("The synthetic R2 manifest memory entry is invalid.");
  }
  const objectBody = readR2Object(memory.object_key, "Synthetic R2 head object read");
  const revisionBody = readR2Object(
    memory.revision_key,
    "Synthetic R2 revision object read"
  );
  assertSyntheticMemoryObjects(objectBody, revisionBody, memory);
}

function prepareSearchCleanup(syntheticProjectId) {
  const project = sqlLiteral(syntheticProjectId);
  const projectedRows = runD1Query(
    "SEARCH_DB",
    `SELECT generation_id, revision_id, chunk_id
     FROM memory_fts WHERE project_id = ${project}
     ORDER BY generation_id, revision_id, chunk_id`,
    "Synthetic search projection lookup"
  );
  const generations = runD1Query(
    "SEARCH_DB",
    "SELECT generation_id FROM search_generations ORDER BY generation_id",
    "Synthetic search generation lookup"
  );
  const authoritativeRevisions = runD1Query(
    "MEMORY_DB",
    `SELECT revision_id FROM memory_versions
     WHERE project_id = ${project} ORDER BY revision_id`,
    "Synthetic authoritative revision lookup"
  );
  const fallbackRows = generations.flatMap((generation) =>
    authoritativeRevisions.map((revision) => ({
      generation_id: generation.generation_id,
      revision_id: revision.revision_id,
      chunk_id: "chunk-0"
    }))
  );
  const vectorIds = [
    ...new Set(
      vectorIdsFromProjectionRows(syntheticProjectId, [...projectedRows, ...fallbackRows])
    )
  ];
  return vectorIds;
}

function deleteSearchProjection(syntheticProjectId, vectorIds) {
  if (vectorIds.length > 0) {
    runProcess(
      "pnpm",
      [
        "exec",
        "wrangler",
        "vectorize",
        "delete-vectors",
        vectorIndex,
        "--ids",
        ...vectorIds,
        "--config",
        configPath
      ],
      "Synthetic Vectorize cleanup",
      wranglerEnvironment(),
      "ignore"
    );
  }
  runD1Query(
    "SEARCH_DB",
    `DELETE FROM memory_fts WHERE project_id = ${sqlLiteral(syntheticProjectId)}`,
    "Synthetic FTS cleanup"
  );
  runD1Query(
    "SEARCH_DB",
    `DELETE FROM memory_projection_heads
     WHERE project_id = ${sqlLiteral(syntheticProjectId)}`,
    "Synthetic projection head cleanup"
  );
}

function prepareR2Cleanup(syntheticProjectId) {
  const project = sqlLiteral(syntheticProjectId);
  const projectRows = runD1Query(
    "MEMORY_DB",
    `SELECT project_version FROM projects WHERE project_id = ${project}`,
    "Synthetic project version lookup"
  );
  const projectVersion = projectRows[0]?.project_version;
  if (!Number.isSafeInteger(projectVersion) || projectVersion < 1) {
    return [];
  }
  const revisionRows = runD1Query(
    "MEMORY_DB",
    `SELECT v.memory_id, v.revision_id, m.scope_id
     FROM memory_versions v JOIN memories m
       ON m.project_id = v.project_id AND m.memory_id = v.memory_id
     WHERE v.project_id = ${project}
     ORDER BY v.memory_id, v.memory_version`,
    "Synthetic R2 authority lookup"
  );
  const keys = new Set(
    expectedProjectionObjectKeys(syntheticProjectId, projectVersion, revisionRows)
  );
  const snapshots = runD1Query(
    "MEMORY_DB",
    `SELECT project_version, manifest_key FROM projection_snapshots
     WHERE project_id = ${project} ORDER BY project_version`,
    "Synthetic projection snapshot lookup"
  );
  for (const snapshot of snapshots) {
    if (
      typeof snapshot !== "object" ||
      snapshot === null ||
      !Number.isSafeInteger(snapshot.project_version) ||
      snapshot.project_version !== projectVersion ||
      (snapshot.manifest_key !== null && typeof snapshot.manifest_key !== "string")
    ) {
      throw new Error("A synthetic projection snapshot row is invalid.");
    }
    if (snapshot.manifest_key === null) {
      continue;
    }
    const manifestBody = runProcessCaptureIfFound(
      "pnpm",
      [
        "exec",
        "wrangler",
        "r2",
        "object",
        "get",
        `${projectionBucket}/${snapshot.manifest_key}`,
        "--remote",
        "--pipe",
        "--config",
        configPath
      ],
      "Synthetic R2 manifest read",
      "The specified key does not exist."
    );
    if (manifestBody !== null) {
      for (const key of projectionObjectKeys(
        syntheticProjectId,
        snapshot.project_version,
        snapshot.manifest_key,
        manifestBody
      )) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

async function deleteR2Projections(keys) {
  const orderedKeys = [...keys].sort((left, right) => {
    const leftManifest = left.endsWith("/manifest.json") ? 1 : 0;
    const rightManifest = right.endsWith("/manifest.json") ? 1 : 0;
    return leftManifest - rightManifest || left.localeCompare(right);
  });
  for (let offset = 0; offset < orderedKeys.length; offset += 6) {
    const batch = orderedKeys.slice(offset, offset + 6);
    await Promise.all(
      batch.map((key) =>
        runProcessAsync(
          "pnpm",
          [
            "exec",
            "wrangler",
            "r2",
            "object",
            "delete",
            `${projectionBucket}/${key}`,
            "--remote",
            "--force",
            "--config",
            configPath
          ],
          "Synthetic R2 object cleanup"
        )
      )
    );
  }
}

async function cleanupSyntheticProject(
  syntheticProjectId,
  syntheticPrincipalId,
  memoryCleanupPath,
  ledgerPath
) {
  await executeSyntheticCleanup({
    claimAdmissionFence: () =>
      claimSyntheticCleanupFence(syntheticProjectId, syntheticPrincipalId),
    waitForQuiescence: () => waitForSyntheticQuiescence(syntheticProjectId),
    loadLedger: () =>
      loadCleanupLedger(ledgerPath, syntheticProjectId, syntheticPrincipalId),
    createLedger: () => ({
      project_id: syntheticProjectId,
      principal_id: syntheticPrincipalId,
      vector_ids: prepareSearchCleanup(syntheticProjectId),
      r2_keys: prepareR2Cleanup(syntheticProjectId)
    }),
    writeLedger: (ledger) => writeCleanupLedger(ledgerPath, ledger),
    deleteSearchProjection: (ledger) =>
      deleteSearchProjection(syntheticProjectId, ledger.vector_ids),
    deleteR2Projections: (ledger) => deleteR2Projections(ledger.r2_keys),
    verifyProjectionCleanup: (ledger) =>
      verifyProjectionCleanup(syntheticProjectId, ledger.vector_ids, ledger.r2_keys),
    deleteAuthority: () => runD1File(memoryCleanupPath, "Synthetic authority cleanup"),
    verifyAuthorityCleanup: () =>
      verifySyntheticCleanup(syntheticProjectId, syntheticPrincipalId),
    removeLedger: () => unlinkSync(ledgerPath)
  });
}

function claimSyntheticCleanupFence(syntheticProjectId, syntheticPrincipalId) {
  const project = sqlLiteral(syntheticProjectId);
  const principal = sqlLiteral(syntheticPrincipalId);
  const claimedAt = new Date().toISOString();
  const claimExpiresAt = new Date(Date.parse(claimedAt) + 30 * 60 * 1_000).toISOString();
  const claimId = `canary-${sha256Text(`${syntheticProjectId}\n${syntheticPrincipalId}`).slice(0, 48)}`;
  runD1Query(
    "MEMORY_DB",
    `UPDATE synthetic_cleanup_registry
     SET cleanup_fenced_at = COALESCE(cleanup_fenced_at, ${sqlLiteral(claimedAt)}),
         cleanup_claim_id = ${sqlLiteral(claimId)},
         cleanup_claim_expires_at = ${sqlLiteral(claimExpiresAt)},
         last_attempt_at = ${sqlLiteral(claimedAt)}, last_error_code = NULL
     WHERE project_id = ${project} AND principal_id = ${principal}
       AND (
         cleanup_claim_id IS NULL
         OR cleanup_claim_id = ${sqlLiteral(claimId)}
         OR julianday(cleanup_claim_expires_at) <= julianday(${sqlLiteral(claimedAt)})
       )`,
    "Synthetic cleanup admission fence"
  );
  const rows = runD1Query(
    "MEMORY_DB",
    `SELECT cleanup_claim_id FROM synthetic_cleanup_registry
     WHERE project_id = ${project} AND principal_id = ${principal}
       AND cleanup_fenced_at IS NOT NULL`,
    "Synthetic cleanup admission fence verification"
  );
  if (rows.length !== 1 || rows[0]?.cleanup_claim_id !== claimId) {
    throw new Error("The synthetic cleanup admission fence could not be claimed.");
  }
}

async function waitForSyntheticQuiescence(syntheticProjectId) {
  const project = sqlLiteral(syntheticProjectId);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const rows = runD1Query(
      "MEMORY_DB",
      `SELECT
         (SELECT COUNT(*) FROM outbox_events
          WHERE project_id = ${project}
            AND dispatched_at IS NULL AND failed_at IS NULL) AS pending_outbox,
         (SELECT COUNT(*) FROM workflow_runs
          WHERE project_id = ${project}
            AND status NOT IN ('complete', 'failed', 'terminated')) AS pending_workflows`,
      "Synthetic quiescence verification"
    );
    if (
      rows.length === 1 &&
      rows[0]?.pending_outbox === 0 &&
      rows[0]?.pending_workflows === 0
    ) {
      return;
    }
    await delay(5_000);
  }
  throw new Error("Synthetic workflows did not become quiescent before cleanup.");
}

function loadCleanupLedger(ledgerPath, expectedProjectId, expectedPrincipalId) {
  if (!existsSync(ledgerPath)) {
    return null;
  }
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch {
    throw new Error("The synthetic cleanup ledger is invalid.");
  }
  validateSyntheticCleanupLedger(ledger, expectedProjectId, expectedPrincipalId);
  return ledger;
}

function writeCleanupLedger(ledgerPath, ledger) {
  validateSyntheticCleanupLedger(ledger, ledger.project_id, ledger.principal_id);
  writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  chmodSync(ledgerPath, 0o600);
}

async function verifyProjectionCleanup(syntheticProjectId, vectorIds, r2Keys) {
  const project = sqlLiteral(syntheticProjectId);
  const search = runD1Query(
    "SEARCH_DB",
    `SELECT
       (SELECT COUNT(*) FROM memory_fts WHERE project_id = ${project}) AS fts_remaining,
       (SELECT COUNT(*) FROM memory_projection_heads
        WHERE project_id = ${project}) AS heads_remaining`,
    "Synthetic search cleanup verification"
  );
  if (
    search.length !== 1 ||
    search[0]?.fts_remaining !== 0 ||
    search[0]?.heads_remaining !== 0
  ) {
    throw new Error("Synthetic search cleanup left projected rows behind.");
  }
  await waitForVectorizeAbsence(vectorIds);
  await verifyR2Absence(r2Keys);
}

async function waitForVectorizeVectors(vectorIds) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const vectors = readVectorizeVectors(vectorIds);
    if (vectors.length === vectorIds.length) {
      return vectors;
    }
    await delay(5_000);
  }
  return [];
}

async function waitForVectorizeAbsence(vectorIds) {
  if (vectorIds.length === 0) {
    return;
  }
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (readVectorizeVectors(vectorIds).length === 0) {
      return;
    }
    await delay(5_000);
  }
  throw new Error("Synthetic Vectorize cleanup left vectors behind.");
}

function readVectorizeVectors(vectorIds) {
  if (vectorIds.length === 0) {
    return [];
  }
  const output = runProcessCapture(
    "pnpm",
    [
      "exec",
      "wrangler",
      "vectorize",
      "get-vectors",
      vectorIndex,
      "--ids",
      ...vectorIds,
      "--config",
      configPath
    ],
    "Synthetic Vectorize lookup"
  );
  const jsonStart = output.lastIndexOf("\n[");
  if (jsonStart < 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(output.slice(jsonStart + 1).trim());
    if (!Array.isArray(parsed)) {
      throw new Error("invalid vector payload");
    }
    return parsed;
  } catch {
    throw new Error("Synthetic Vectorize lookup returned invalid JSON.");
  }
}

function queryVectorizeRepositoryPartition(vectorId, syntheticProjectId) {
  const output = runProcessCapture(
    "pnpm",
    [
      "exec",
      "wrangler",
      "vectorize",
      "query",
      vectorIndex,
      "--vector-id",
      vectorId,
      "--top-k",
      "1",
      "--return-metadata",
      "all",
      "--namespace",
      syntheticProjectId,
      "--filter",
      JSON.stringify({
        repository_partition: {
          $in: ["*", `repository.synthetic.${syntheticProjectId}`]
        }
      }),
      "--config",
      configPath
    ],
    "Synthetic Vectorize repository filter query"
  );
  const jsonStart = output.lastIndexOf("\n{");
  const jsonText =
    jsonStart >= 0
      ? output.slice(jsonStart + 1).trim()
      : output.trimStart().startsWith("{")
        ? output.trim()
        : null;
  if (jsonText === null) {
    throw new Error("Synthetic Vectorize repository filter returned no JSON result.");
  }
  try {
    const parsed = JSON.parse(jsonText);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Number.isSafeInteger(parsed.count) ||
      !Array.isArray(parsed.matches) ||
      parsed.count !== parsed.matches.length
    ) {
      throw new Error("invalid Vectorize query payload");
    }
    return parsed.matches;
  } catch {
    throw new Error("Synthetic Vectorize repository filter returned invalid JSON.");
  }
}

async function verifyR2Absence(keys) {
  for (let offset = 0; offset < keys.length; offset += 6) {
    const batch = keys.slice(offset, offset + 6);
    const results = await Promise.all(
      batch.map((key) =>
        runProcessAsyncStatus("pnpm", [
          "exec",
          "wrangler",
          "r2",
          "object",
          "get",
          `${projectionBucket}/${key}`,
          "--remote",
          "--pipe",
          "--config",
          configPath
        ])
      )
    );
    for (const result of results) {
      if (result.code === 0) {
        throw new Error("Synthetic R2 cleanup left an object behind.");
      }
      if (!result.output.includes("The specified key does not exist.")) {
        throw new Error("Synthetic R2 cleanup verification failed.");
      }
    }
  }
}

function readR2Object(key, label) {
  return runProcessCapture(
    "pnpm",
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "get",
      `${projectionBucket}/${key}`,
      "--remote",
      "--pipe",
      "--config",
      configPath
    ],
    label
  );
}

function verifySyntheticCleanup(syntheticProjectId, syntheticPrincipalId) {
  const project = sqlLiteral(syntheticProjectId);
  const principal = sqlLiteral(syntheticPrincipalId);
  const tableCounts = PROJECT_SCOPED_TABLES.map(
    (table) => `(SELECT COUNT(*) FROM ${table} WHERE project_id = ${project}) AS ${table}`
  ).join(",\n");
  const authority = runD1Query(
    "MEMORY_DB",
    `SELECT ${tableCounts},
            (SELECT COUNT(*) FROM github_credential_expiry_warnings warning
             JOIN github_access_baselines baseline
               ON baseline.credential_version = warning.credential_version
             WHERE baseline.approved_by_principal_id = ${principal}
               AND baseline.credential_version = 'system.synthetic.' || ${project}) AS github_expiry_warnings,
            (SELECT COUNT(*) FROM github_credential_states state
             JOIN github_access_baselines baseline
               ON baseline.credential_version = state.credential_version
             WHERE baseline.approved_by_principal_id = ${principal}
               AND baseline.credential_version = 'system.synthetic.' || ${project}) AS github_credential_states,
            (SELECT COUNT(*) FROM github_rate_observations observation
             JOIN github_access_baselines baseline
               ON baseline.credential_version = observation.credential_version
             WHERE baseline.approved_by_principal_id = ${principal}
               AND baseline.credential_version = 'system.synthetic.' || ${project}) AS github_rates,
            (SELECT COUNT(*) FROM github_access_baselines
             WHERE approved_by_principal_id = ${principal}
               AND credential_version = 'system.synthetic.' || ${project}) AS github_baselines,
            (SELECT COUNT(*) FROM projects WHERE project_id = ${project}) AS projects,
            (SELECT COUNT(*) FROM principals WHERE principal_id = ${principal}) AS principals`,
    "Synthetic authority cleanup verification"
  );
  const search = runD1Query(
    "SEARCH_DB",
    `SELECT
       (SELECT COUNT(*) FROM memory_fts WHERE project_id = ${project}) AS fts_remaining,
       (SELECT COUNT(*) FROM memory_projection_heads
        WHERE project_id = ${project}) AS heads_remaining`,
    "Synthetic search cleanup verification"
  );
  if (
    authority.length !== 1 ||
    Object.values(authority[0]).some((remaining) => remaining !== 0) ||
    search.length !== 1 ||
    search[0]?.fts_remaining !== 0 ||
    search[0]?.heads_remaining !== 0
  ) {
    throw new Error("Synthetic cleanup left authoritative or search rows behind.");
  }
  const foreignKeys = runD1Query(
    "MEMORY_DB",
    "PRAGMA foreign_key_check",
    "Synthetic foreign key cleanup verification"
  );
  if (foreignKeys.length !== 0) {
    throw new Error("Synthetic cleanup left a foreign key violation.");
  }
}
