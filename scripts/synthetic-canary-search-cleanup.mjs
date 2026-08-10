import { createHash } from "node:crypto";
import {
  sqlLiteral,
  validateSyntheticCleanupLedger,
  vectorIdsFromProjectionRows
} from "./synthetic-canary-support.mjs";

export const PROJECT_SCOPED_SEARCH_TABLES = [
  "memory_fts",
  "memory_projection_heads",
  "memory_fts_chunk_ledger",
  "memory_search_projection_write_leases",
  "memory_search_projection_deletions",
  "memory_search_vector_cleanup_receipts"
];

const MAX_SYNTHETIC_CLEANUP_VECTOR_IDS = 10_000;
const JANITOR_CURSOR_COLUMN = "memory_search_vector_cleanup_janitor_state";

export function mergeSyntheticCleanupLedgers(
  expectedProjectId,
  expectedPrincipalId,
  ledgers
) {
  const vectorIds = new Set();
  const r2Keys = new Set();
  for (const ledger of ledgers) {
    validateSyntheticCleanupLedger(ledger, expectedProjectId, expectedPrincipalId);
    for (const vectorId of ledger.vector_ids) {
      vectorIds.add(vectorId);
    }
    for (const r2Key of ledger.r2_keys) {
      r2Keys.add(r2Key);
    }
  }
  const merged = {
    project_id: expectedProjectId,
    principal_id: expectedPrincipalId,
    vector_ids: [...vectorIds].sort(),
    r2_keys: [...r2Keys].sort()
  };
  validateSyntheticCleanupLedger(merged, expectedProjectId, expectedPrincipalId);
  return merged;
}

export function syntheticCleanupVectorIds(projectId, projectionRows, deletionRows) {
  requireIdentifier(projectId, "project ID");
  const vectorIds = new Set(vectorIdsFromProjectionRows(projectId, projectionRows));
  assertVectorIdBound(vectorIds);
  for (const row of deletionRows) {
    const generationId = requireRowIdentifier(row, "generation_id");
    const revisionId = requireRowIdentifier(row, "revision_id");
    if (row.project_id !== undefined && row.project_id !== projectId) {
      throw new Error("The synthetic projection row crossed its project boundary.");
    }
    if (
      !Number.isSafeInteger(row.chunk_count) ||
      row.chunk_count < 0 ||
      row.chunk_count > MAX_SYNTHETIC_CLEANUP_VECTOR_IDS
    ) {
      throw new Error("The synthetic projection deletion chunk count is invalid.");
    }
    for (let index = 0; index < row.chunk_count; index += 1) {
      vectorIds.add(
        createHash("sha256")
          .update(`${generationId}\n${projectId}\n${revisionId}\nchunk-${index}`)
          .digest("hex")
      );
      assertVectorIdBound(vectorIds);
    }
  }
  return [...vectorIds].sort();
}

export function syntheticSearchCleanupSql(projectId) {
  requireIdentifier(projectId, "project ID");
  const project = sqlLiteral(projectId);
  return [
    ...PROJECT_SCOPED_SEARCH_TABLES.map(
      (table) => `DELETE FROM ${table} WHERE project_id = ${project};`
    ),
    `UPDATE memory_search_vector_cleanup_janitor_state
     SET cursor_generation_id = NULL, cursor_project_id = NULL,
         cursor_memory_id = NULL, updated_at = NULL
     WHERE state_id = 1 AND cursor_project_id = ${project};`
  ].join("\n");
}

export function syntheticSearchCleanupVerificationSql(projectId) {
  requireIdentifier(projectId, "project ID");
  const project = sqlLiteral(projectId);
  const tableCounts = PROJECT_SCOPED_SEARCH_TABLES.map(
    (table) =>
      `(SELECT COUNT(*) FROM ${table} WHERE project_id = ${project}) AS ${table}`
  );
  tableCounts.push(
    `(SELECT COUNT(*) FROM memory_search_vector_cleanup_janitor_state
      WHERE cursor_project_id = ${project}) AS ${JANITOR_CURSOR_COLUMN}`
  );
  return `SELECT ${tableCounts.join(",\n")}`;
}

export function assertSyntheticSearchCleanup(rows) {
  const expectedColumns = [...PROJECT_SCOPED_SEARCH_TABLES, JANITOR_CURSOR_COLUMN];
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    typeof rows[0] !== "object" ||
    rows[0] === null ||
    Object.keys(rows[0]).sort().join(",") !==
      [...expectedColumns].sort().join(",") ||
    expectedColumns.some((column) => rows[0][column] !== 0)
  ) {
    throw new Error("Synthetic search cleanup left project-scoped rows behind.");
  }
}

function assertVectorIdBound(vectorIds) {
  if (vectorIds.size > MAX_SYNTHETIC_CLEANUP_VECTOR_IDS) {
    throw new Error("The synthetic cleanup exceeded its Vectorize ID bound.");
  }
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
