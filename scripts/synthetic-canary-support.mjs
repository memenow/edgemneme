import { createHash, randomUUID } from "node:crypto";

export const SYNTHETIC_AI_PROBE_CONTENT =
  "EdgeMneme uses a project-scoped Durable Object to serialize formal memory changes.";
export const SYNTHETIC_FORMAL_MEMORY_CONTENT =
  "EdgeMneme stores formal memory in D1 and treats search indexes as rebuildable projections.";
export const AI_ANALYSIS_DIAGNOSTIC_CODES = [
  "AI_ANALYSIS_DEFERRED_MODEL_CALL",
  "AI_ANALYSIS_DEFERRED_RESPONSE_DECODE",
  "AI_ANALYSIS_DEFERRED_SCHEMA",
  "AI_ANALYSIS_DEFERRED_SCOPE_EVIDENCE",
  "AI_ANALYSIS_DEFERRED_TEMPORAL"
];
const AI_ANALYSIS_DIAGNOSTIC_CODE_SET = new Set(AI_ANALYSIS_DIAGNOSTIC_CODES);
export const PROJECT_SCOPED_TABLES = [
  "consolidation_outputs",
  "consolidation_inputs",
  "session_consolidations",
  "review_decisions",
  "review_requests",
  "version_evidence",
  "conflicts",
  "memory_versions",
  "memory_repository_contexts",
  "observation_evidence",
  "memories",
  "evidence",
  "observations",
  "workflow_runs",
  "idempotency_records",
  "taxonomy_policies",
  "github_repository_sync_runs",
  "github_tree_ref_heads",
  "github_tree_manifest_deltas",
  "github_tree_manifest_lifecycle_events",
  "github_tree_manifest_entries",
  "github_tree_manifests",
  "sync_cursors",
  "project_grant_repository_contexts",
  "project_grants",
  "sessions",
  "repositories",
  "outbox_events",
  "projection_snapshots",
  "audit_events",
  "synthetic_cleanup_registry"
];

export function syntheticSeedSql(input) {
  const createdAt = new Date(input.now);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error("The synthetic cleanup registration time is invalid.");
  }
  const projectIdValue = sqlLiteral(input.projectId);
  const principalIdValue = sqlLiteral(input.principalId);
  const repositoryIdValue = sqlLiteral(input.repositoryId);
  const projectRefValue = sqlLiteral(input.projectRef);
  const tokenDigestValue = sqlLiteral(input.tokenDigest);
  const candidateIdValue = sqlLiteral(input.promotionCandidateId);
  const nowValue = sqlLiteral(input.now);
  const expiresAtValue = sqlLiteral(
    new Date(createdAt.getTime() + 23 * 60 * 60 * 1_000).toISOString()
  );
  const contentValue = sqlLiteral(SYNTHETIC_FORMAL_MEMORY_CONTENT);
  const contentShaValue = sqlLiteral(
    createHash("sha256").update(SYNTHETIC_FORMAL_MEMORY_CONTENT).digest("hex")
  );
  const evidenceLocator = `${input.projectRef}/formal-promotion`;
  const evidenceLocatorValue = sqlLiteral(evidenceLocator);
  const evidenceId = createHash("sha256")
    .update(`${input.projectId}\nsynthetic_canary\n${evidenceLocator}`)
    .digest("hex");
  const evidenceIdValue = sqlLiteral(evidenceId);
  const analysisJsonValue = sqlLiteral(
    JSON.stringify({
      persistent_value: true,
      evidence_source_ids: [evidenceId]
    })
  );
  const excerptHashValue = sqlLiteral(
    createHash("sha256").update(evidenceLocator).digest("hex")
  );
  return [
    `INSERT INTO projects (project_id, project_ref, locator, display_name, project_version, created_at, updated_at) VALUES (${projectIdValue}, ${projectRefValue}, ${projectRefValue}, 'EdgeMneme Synthetic Canary', 0, ${nowValue}, ${nowValue});`,
    `INSERT INTO repositories (repository_id, project_id, provider, external_id, owner, name, default_branch, tracked_refs_json, sync_enabled, created_at, updated_at) VALUES (${repositoryIdValue}, ${projectIdValue}, ${sqlLiteral(`system.synthetic.${input.projectId}`)}, 1, 'system.synthetic', ${repositoryIdValue}, 'main', '["refs/heads/main"]', 0, ${nowValue}, ${nowValue});`,
    `INSERT INTO principals (principal_id, issuer, subject, token_digest, display_name, created_at) VALUES (${principalIdValue}, 'system.synthetic', ${principalIdValue}, ${tokenDigestValue}, 'Synthetic Canary', ${nowValue});`,
    `INSERT INTO synthetic_cleanup_registry (project_id, principal_id, expires_at, created_at) VALUES (${projectIdValue}, ${principalIdValue}, ${expiresAtValue}, ${nowValue});`,
    `INSERT INTO project_grants (grant_id, project_id, principal_id, role, scope_kind, scope_id, created_at) VALUES (${sqlLiteral(randomUUID())}, ${projectIdValue}, ${principalIdValue}, 'maintainer', 'project', ${projectIdValue}, ${nowValue});`,
    `INSERT INTO observations (observation_id, project_id, principal_id, candidate_version, status, content, content_sha256, evidence_json, kind, memory_class, scope, scope_id, analysis_json, created_at, updated_at) VALUES (${candidateIdValue}, ${projectIdValue}, ${principalIdValue}, 1, 'pending_review', ${contentValue}, ${contentShaValue}, '[]', 'fact', 'semantic', 'project', ${projectIdValue}, ${analysisJsonValue}, ${nowValue}, ${nowValue});`,
    `INSERT INTO evidence (evidence_id, project_id, source_type, locator, excerpt_hash, sensitivity_status, recorded_at) VALUES (${evidenceIdValue}, ${projectIdValue}, 'synthetic_canary', ${evidenceLocatorValue}, ${excerptHashValue}, 'clear', ${nowValue});`,
    `INSERT INTO observation_evidence (project_id, observation_id, evidence_id, created_at) VALUES (${projectIdValue}, ${candidateIdValue}, ${evidenceIdValue}, ${nowValue});`,
    `INSERT INTO review_requests (review_request_id, project_id, candidate_id, status, required_role, created_at, updated_at) VALUES (${candidateIdValue}, ${projectIdValue}, ${candidateIdValue}, 'pending', 'maintainer', ${nowValue}, ${nowValue});`
  ].join("\n");
}

export function syntheticCleanupSql(projectId, principalId) {
  const project = sqlLiteral(projectId);
  const principal = sqlLiteral(principalId);
  return [
    `DELETE FROM github_credential_expiry_warnings WHERE credential_version IN (SELECT credential_version FROM github_access_baselines WHERE approved_by_principal_id = ${principal} AND credential_version = 'system.synthetic.' || ${project});`,
    `DELETE FROM github_credential_states WHERE credential_version IN (SELECT credential_version FROM github_access_baselines WHERE approved_by_principal_id = ${principal} AND credential_version = 'system.synthetic.' || ${project});`,
    `DELETE FROM github_rate_observations WHERE credential_version IN (SELECT credential_version FROM github_access_baselines WHERE approved_by_principal_id = ${principal} AND credential_version = 'system.synthetic.' || ${project});`,
    `DELETE FROM github_access_baselines WHERE approved_by_principal_id = ${principal} AND credential_version = 'system.synthetic.' || ${project};`,
    ...PROJECT_SCOPED_TABLES.map(
      (table) => `DELETE FROM ${table} WHERE project_id = ${project};`
    ),
    `DELETE FROM principals WHERE principal_id = ${principal};`,
    `DELETE FROM projects WHERE project_id = ${project};`
  ].join("\n");
}

export function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function decodeD1Rows(output, label) {
  let statements;
  try {
    statements = JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return valid D1 JSON.`);
  }
  if (
    !Array.isArray(statements) ||
    statements.some(
      (statement) =>
        typeof statement !== "object" ||
        statement === null ||
        statement.success !== true ||
        !Array.isArray(statement.results)
    )
  ) {
    throw new Error(`${label} failed.`);
  }
  return statements.flatMap((statement) => statement.results);
}

export function assertAiAnalysis(rows) {
  if (
    rows.length === 1 &&
    rows[0]?.ai_verified === 1 &&
    (rows[0]?.diagnostic_code ?? null) === null
  ) {
    return;
  }
  const diagnosticCode = rows.length === 1 ? rows[0]?.diagnostic_code : null;
  const safeDiagnosticCode =
    typeof diagnosticCode === "string" &&
    AI_ANALYSIS_DIAGNOSTIC_CODE_SET.has(diagnosticCode)
      ? diagnosticCode
      : null;
  throw new Error(
    safeDiagnosticCode === null
      ? "The synthetic candidate did not receive a valid Workers AI analysis."
      : `The synthetic candidate did not receive a valid Workers AI analysis (${safeDiagnosticCode}).`
  );
}

export function syntheticAiAnalysisVerificationSql(projectId, candidateId, workflowId) {
  requireIdentifier(projectId, "project ID");
  requireIdentifier(candidateId, "candidate ID");
  requireIdentifier(workflowId, "workflow ID");
  const allowedDiagnosticCodes = AI_ANALYSIS_DIAGNOSTIC_CODES.map(sqlLiteral).join(", ");
  return `SELECT CASE WHEN session_id IS NOT NULL
       AND analysis_json IS NOT NULL
       AND json_valid(analysis_json)
       AND json_type(analysis_json, '$.persistent_value') IN ('true', 'false')
       AND json_type(analysis_json, '$.confidence') IN ('integer', 'real')
       AND json_extract(analysis_json, '$.confidence') BETWEEN 0 AND 1
       AND (
         (json_extract(analysis_json, '$.persistent_value') = 1
          AND status = 'pending_review'
          AND kind IS NOT NULL AND memory_class IS NOT NULL
          AND scope IS NOT NULL AND scope_id IS NOT NULL)
         OR
         (json_extract(analysis_json, '$.persistent_value') = 0
          AND status = 'noop'
          AND kind IS NULL AND memory_class IS NULL
          AND scope IS NULL AND scope_id IS NULL)
       )
     THEN 1 ELSE 0 END AS ai_verified
     , (
       SELECT CASE
         WHEN workflow.last_error_code IN (${allowedDiagnosticCodes})
           THEN workflow.last_error_code
         ELSE NULL
       END
       FROM workflow_runs AS workflow
       WHERE workflow.project_id = observations.project_id
         AND (workflow.workflow_id = ${sqlLiteral(workflowId)}
           OR workflow.root_workflow_id = ${sqlLiteral(workflowId)})
         AND workflow.workflow_type = 'candidate.submitted'
       ORDER BY workflow.updated_at DESC, workflow.workflow_id DESC
       LIMIT 1
     ) AS diagnostic_code
     FROM observations
     WHERE project_id = ${sqlLiteral(projectId)}
       AND observation_id = ${sqlLiteral(candidateId)}`;
}

export function syntheticSearchProjectionVerificationSql(projectId) {
  requireIdentifier(projectId, "project ID");
  return `SELECT fts.generation_id, fts.project_id, fts.memory_id, fts.revision_id,
       fts.chunk_id, fts.status, fts.kind, fts.memory_class, fts.scope,
       fts.scope_id, fts.content, generation.status AS generation_status,
       head.repository_partition, head.chunk_count, fts.rowid AS fts_rowid,
       ledger.vector_id AS ledger_vector_id
     FROM memory_fts AS fts
     JOIN search_generations AS generation
       ON generation.generation_id = fts.generation_id
     JOIN memory_projection_heads AS head
       ON head.generation_id = fts.generation_id
      AND head.project_id = fts.project_id
      AND head.memory_id = fts.memory_id
      AND head.revision_id = fts.revision_id
     JOIN memory_fts_chunk_ledger AS ledger
       ON ledger.fts_rowid = fts.rowid
      AND ledger.generation_id = fts.generation_id
      AND ledger.project_id = fts.project_id
      AND ledger.memory_id = fts.memory_id
      AND ledger.revision_id = fts.revision_id
      AND ledger.chunk_id = fts.chunk_id
     WHERE fts.project_id = ${sqlLiteral(projectId)}`;
}

export function decodeSyntheticClientResult(serialized) {
  let result;
  try {
    result = JSON.parse(serialized);
  } catch {
    throw new Error("The synthetic MCP client result is invalid.");
  }
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    Object.keys(result).sort().join(",") !== "candidate_id,workflow_id" ||
    typeof result.candidate_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      result.candidate_id
    ) ||
    typeof result.workflow_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      result.workflow_id
    )
  ) {
    throw new Error("The synthetic MCP client result is invalid.");
  }
  return {
    candidateId: result.candidate_id,
    workflowId: result.workflow_id
  };
}

export function vectorIdsFromProjectionRows(projectId, rows) {
  requireIdentifier(projectId, "project ID");
  return rows.map((row) => {
    const generationId = requireRowIdentifier(row, "generation_id");
    const revisionId = requireRowIdentifier(row, "revision_id");
    const chunkId = requireRowIdentifier(row, "chunk_id");
    return createHash("sha256")
      .update(`${generationId}\n${projectId}\n${revisionId}\n${chunkId}`)
      .digest("hex");
  });
}

export function assertSyntheticVectorProjection(
  vector,
  expected,
  { requireValues = true } = {}
) {
  const id = requireIdentifier(expected?.id, "expected vector ID");
  const projectId = requireIdentifier(expected?.projectId, "expected vector project ID");
  const memoryId = requireIdentifier(expected?.memoryId, "expected vector memory ID");
  const revisionId = requireIdentifier(expected?.revisionId, "expected vector revision ID");
  const chunkId = requireIdentifier(expected?.chunkId, "expected vector chunk ID");
  const generationId = requireIdentifier(
    expected?.generationId,
    "expected vector generation ID"
  );
  const repositoryPartition = requireIdentifier(
    expected?.repositoryPartition,
    "expected vector repository partition"
  );
  const kind = requireIdentifier(expected?.kind, "expected vector kind");
  const memoryClass = requireIdentifier(
    expected?.memoryClass,
    "expected vector memory class"
  );
  const scope = requireIdentifier(expected?.scope, "expected vector scope");
  const scopeId = requireIdentifier(expected?.scopeId, "expected vector scope ID");
  const scopeKey = createHash("sha256")
    .update(JSON.stringify(["edgemneme.vector.scope", scope, scopeId]))
    .digest("hex");
  const validFromEpochMs = requireSafeInteger(
    expected?.validFromEpochMs,
    "expected vector valid-from epoch"
  );
  const validUntilEpochMs = requireSafeInteger(
    expected?.validUntilEpochMs,
    "expected vector valid-until epoch"
  );
  if (
    typeof vector !== "object" ||
    vector === null ||
    vector.id !== id ||
    vector.namespace !== projectId ||
    (requireValues &&
      (!Array.isArray(vector.values) || vector.values.length !== 1_024)) ||
    typeof vector.metadata !== "object" ||
    vector.metadata === null ||
    vector.metadata.project_id !== projectId ||
    vector.metadata.memory_id !== memoryId ||
    vector.metadata.revision_id !== revisionId ||
    vector.metadata.chunk_id !== chunkId ||
    vector.metadata.model_generation !== generationId ||
    vector.metadata.status !== "active" ||
    vector.metadata.repository_partition !== repositoryPartition ||
    vector.metadata.kind !== kind ||
    vector.metadata.memory_class !== memoryClass ||
    vector.metadata.scope !== scope ||
    vector.metadata.scope_id !== scopeId ||
    vector.metadata.scope_key !== scopeKey ||
    vector.metadata.valid_from_epoch_ms !== validFromEpochMs ||
    vector.metadata.valid_until_epoch_ms !== validUntilEpochMs
  ) {
    throw new Error("The synthetic Vectorize metadata is invalid.");
  }
}

export function assertSyntheticMemoryObjects(objectBody, revisionBody, memory) {
  if (
    createHash("sha256").update(objectBody).digest("hex") !== memory.object_sha256 ||
    createHash("sha256").update(revisionBody).digest("hex") !==
      memory.revision_sha256 ||
    !objectBody.includes(SYNTHETIC_FORMAL_MEMORY_CONTENT) ||
    !revisionBody.includes(SYNTHETIC_FORMAL_MEMORY_CONTENT) ||
    !objectBody.includes(`memory_id: ${JSON.stringify(memory.memory_id)}`) ||
    !revisionBody.includes(`revision_id: ${JSON.stringify(memory.revision_id)}`)
  ) {
    throw new Error("The synthetic R2 memory objects are invalid.");
  }
}

export function projectionObjectKeys(projectId, projectVersion, manifestKey, manifestBody) {
  requireIdentifier(projectId, "project ID");
  if (!Number.isSafeInteger(projectVersion) || projectVersion < 1) {
    throw new Error("The synthetic project version is invalid.");
  }
  const prefix = `projects/${pathSegment(projectId)}/projections/${projectVersion}/`;
  if (manifestKey !== `${prefix}manifest.json`) {
    throw new Error("The synthetic manifest is outside its exact snapshot prefix.");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBody);
  } catch {
    throw new Error("The synthetic projection manifest is invalid.");
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    manifest.project_id !== projectId ||
    manifest.project_version !== projectVersion ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("The synthetic projection manifest does not match the project snapshot.");
  }
  const keys = manifest.files.map((file) => {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.key !== "string" ||
      !file.key.startsWith(prefix) ||
      file.key === manifestKey ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    ) {
      throw new Error("A synthetic projection object is outside its exact snapshot prefix.");
    }
    return file.key;
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error("The synthetic projection manifest contains duplicate object keys.");
  }
  return [...keys, manifestKey];
}

export function syntheticProjectionPrefix(projectId) {
  requireIdentifier(projectId, "project ID");
  return `projects/${pathSegment(projectId)}/projections/`;
}

export function validateSyntheticCleanupLedger(
  ledger,
  expectedProjectId,
  expectedPrincipalId
) {
  const r2Prefix = syntheticProjectionPrefix(expectedProjectId);
  if (
    typeof ledger !== "object" ||
    ledger === null ||
    ledger.project_id !== expectedProjectId ||
    ledger.principal_id !== expectedPrincipalId ||
    !Array.isArray(ledger.vector_ids) ||
    !Array.isArray(ledger.r2_keys) ||
    ledger.vector_ids.length > 10_000 ||
    ledger.r2_keys.length > 10_000 ||
    ledger.vector_ids.some(
      (id) => typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id)
    ) ||
    ledger.r2_keys.some(
      (key) =>
        typeof key !== "string" ||
        !key.startsWith(r2Prefix) ||
        key.includes("\0")
    ) ||
    new Set(ledger.vector_ids).size !== ledger.vector_ids.length ||
    new Set(ledger.r2_keys).size !== ledger.r2_keys.length
  ) {
    throw new Error("The synthetic cleanup ledger is outside its exact project scope.");
  }
}

export async function executeSyntheticCleanup(steps) {
  await steps.claimAdmissionFence();
  await steps.waitForQuiescence();
  const ledger = steps.loadLedger() ?? steps.createLedger();
  steps.writeLedger(ledger);
  await steps.deleteSearchProjection(ledger);
  await steps.deleteR2Projections(ledger);
  await steps.verifyProjectionCleanup(ledger);
  await steps.deleteAuthority();
  await steps.verifyAuthorityCleanup();
  steps.removeLedger();
}

export function expectedProjectionObjectKeys(projectId, projectVersion, rows) {
  requireIdentifier(projectId, "project ID");
  if (!Number.isSafeInteger(projectVersion) || projectVersion < 1) {
    throw new Error("The synthetic project version is invalid.");
  }
  const prefix = `projects/${pathSegment(projectId)}/projections/${projectVersion}/`;
  const keys = new Set([`${prefix}README.md`, `${prefix}manifest.json`]);
  for (const kind of [
    "decision",
    "fact",
    "convention",
    "procedure",
    "learning",
    "incident",
    "reference",
    "feedback"
  ]) {
    keys.add(`${prefix}indexes/by-kind/${kind}/index.json`);
    keys.add(`${prefix}indexes/by-kind/${kind}/index.md`);
  }
  for (const memoryClass of ["semantic", "procedural", "episodic"]) {
    keys.add(`${prefix}indexes/by-class/${memoryClass}/index.json`);
    keys.add(`${prefix}indexes/by-class/${memoryClass}/index.md`);
  }
  for (const status of ["active", "contested", "superseded", "invalidated", "archived"]) {
    keys.add(`${prefix}indexes/by-status/${status}/index.json`);
  }
  for (const row of rows) {
    const memoryId = requireRowIdentifier(row, "memory_id");
    const revisionId = requireRowIdentifier(row, "revision_id");
    const scopeId = requireRowIdentifier(row, "scope_id");
    const hashPrefix = createHash("sha256").update(memoryId).digest("hex").slice(0, 2);
    keys.add(`${prefix}objects/${hashPrefix}/${pathSegment(memoryId)}.md`);
    keys.add(
      `${prefix}revisions/${hashPrefix}/${pathSegment(memoryId)}/${pathSegment(revisionId)}.md`
    );
    keys.add(`${prefix}indexes/by-scope/${pathSegment(scopeId)}/index.json`);
  }
  return [...keys].sort();
}

function requireRowIdentifier(row, property) {
  if (typeof row !== "object" || row === null) {
    throw new Error("The synthetic search projection row is invalid.");
  }
  return requireIdentifier(row[property], `projection row ${property}`);
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requireSafeInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function pathSegment(value) {
  return encodeURIComponent(value).replaceAll(".", "%2E");
}
