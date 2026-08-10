#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECTION_REBUILD_QUERY_BATCH_SIZE,
  PROJECTION_REBUILD_EVENT_TYPE,
  assertProjectionRebuildCleanupDebtClear,
  assertProjectionRebuildWaitBudget,
  buildProjectionRebuildSql,
  decodeD1Rows,
  estimateProjectionRebuildEtaSeconds,
  projectionRebuildDescriptors,
  projectionRebuildEnqueueIssues,
  requireVectorizeIndexedString,
  requireActiveSearchGeneration,
  requireProjectionRebuildCleanupDebt,
  sameProjectionRebuildTargets,
  selectLatestProjectionRebuildEvents,
  selectProjectionRebuildEvents,
  splitProjectionRebuildBatches,
  splitProjectionRebuildQueryBatches,
  sqlLiteral,
  summarizeProjectionRebuildPlan,
  summarizeProjectionRebuildVerification
} from "./projection-rebuild-support.mjs";

const QUERY_TIMEOUT_MS = 240_000;
const MUTATION_TIMEOUT_MS = 900_000;
const CAPTURE_LIMIT_BYTES = 4 * 1024 * 1024;
const VERIFY_POLL_MS = 5_000;
export const DEFAULT_PROJECTION_REBUILD_CONFIG =
  "wrangler/.wrangler/memory-orchestrator.generated.jsonc";
export const PROJECTION_REBUILD_PAGE_SIZE = 500;
// SEARCH_DB migrations maintain this indexed ledger value. Verification never reads FTS5.
export const SEARCH_PROJECTION_CHUNK_COUNT_COLUMN = "chunk_count";
export const ACTIVE_SEARCH_GENERATION_QUERY =
  "SELECT generation_id FROM search_generations " +
  "WHERE status = 'active' ORDER BY generation_id ASC LIMIT 2;";

export function projectionRebuildTargetQuery(options = {}) {
  const limit = requirePageLimit(options.limit);
  const clauses = [admittedProjectPredicate("p")];
  if (options.projectId !== undefined) {
    clauses.push(
      `p.project_id = ${sqlLiteral(
        requireProjectNamespace(options.projectId, "project ID")
      )}`
    );
  }
  if (options.cursor !== undefined) {
    requireProjectCursor(options.cursor);
    clauses.push(`p.project_id > ${sqlLiteral(options.cursor.projectId)}`);
  }
  return `SELECT p.project_id, p.project_version,
                 (SELECT COUNT(*) FROM memories m
                  WHERE m.project_id = p.project_id
                    AND m.current_revision_id IS NOT NULL
                    AND m.status IN ('active', 'contested')) AS memory_count,
                 (SELECT COUNT(*)
                  FROM memory_versions v
                  JOIN memories m
                    ON m.project_id = v.project_id AND m.memory_id = v.memory_id
                   AND m.current_revision_id = v.revision_id
                  WHERE v.project_id = p.project_id
                    AND m.status IN ('active', 'contested')) AS revision_count,
                 (SELECT COUNT(DISTINCT m.scope_id) FROM memories m
                  WHERE m.project_id = p.project_id
                    AND m.current_revision_id IS NOT NULL
                    AND m.status IN ('active', 'contested')) AS scope_count,
                 COALESCE((
                   SELECT SUM(length(CAST(v.content AS BLOB)))
                   FROM memory_versions v
                   JOIN memories m
                     ON m.project_id = v.project_id AND m.memory_id = v.memory_id
                    AND m.current_revision_id = v.revision_id
                   WHERE v.project_id = p.project_id
                     AND m.status IN ('active', 'contested')
                 ), 0) AS content_bytes
          FROM projects p
          WHERE ${clauses.join(" AND ")}
          ORDER BY p.project_id ASC
          LIMIT ${limit};`;
}

export function projectionRebuildHeadQuery(options) {
  const limit = requirePageLimit(options?.limit);
  const clauses = [
    admittedProjectPredicate("p"),
    "m.current_revision_id IS NOT NULL",
    "m.status IN ('active', 'contested')"
  ];
  if (options?.projectId !== undefined) {
    clauses.push(
      `p.project_id = ${sqlLiteral(
        requireProjectNamespace(options.projectId, "project ID")
      )}`
    );
  }
  if (options?.cursor !== undefined) {
    requireHeadCursor(options.cursor);
    clauses.push(
      `(m.project_id > ${sqlLiteral(options.cursor.projectId)} OR ` +
        `(m.project_id = ${sqlLiteral(options.cursor.projectId)} AND ` +
        `m.memory_id > ${sqlLiteral(options.cursor.memoryId)}))`
    );
  }
  return `SELECT p.project_id, p.project_version,
                 m.memory_id, m.current_revision_id AS revision_id,
                 m.scope, m.scope_id, memory_context.repository_id
          FROM projects p
          JOIN memories m ON m.project_id = p.project_id
          LEFT JOIN memory_repository_contexts memory_context
            ON memory_context.project_id = m.project_id
           AND memory_context.memory_id = m.memory_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY m.project_id ASC, m.memory_id ASC
          LIMIT ${limit};`;
}

export function projectionRebuildSearchHeadQuery(options) {
  const generationId = requireVectorizeIndexedString(
    requireIdentifier(options?.searchGenerationId, "search generation ID"),
    "search generation ID"
  );
  const limit = requirePageLimit(options?.limit);
  const clauses = [
    `h.generation_id = ${sqlLiteral(generationId)}`,
    "g.status = 'active'"
  ];
  if (options?.projectId !== undefined) {
    clauses.push(
      `h.project_id = ${sqlLiteral(
        requireProjectNamespace(options.projectId, "project ID")
      )}`
    );
  }
  if (options?.cursor !== undefined) {
    requireHeadCursor(options.cursor);
    clauses.push(
      `(h.project_id > ${sqlLiteral(options.cursor.projectId)} OR ` +
        `(h.project_id = ${sqlLiteral(options.cursor.projectId)} AND ` +
        `h.memory_id > ${sqlLiteral(options.cursor.memoryId)}))`
    );
  }
  return `SELECT h.generation_id, h.project_id, h.memory_id,
                 h.project_version, h.revision_id,
                 h.repository_partition, h.${SEARCH_PROJECTION_CHUNK_COUNT_COLUMN} AS chunk_count
          FROM memory_projection_heads h
          JOIN search_generations g ON g.generation_id = h.generation_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY h.project_id ASC, h.memory_id ASC
          LIMIT ${limit};`;
}

export function projectionRebuildCleanupDebtQuery(options) {
  const generationId = requireVectorizeIndexedString(
    requireIdentifier(options?.searchGenerationId, "search generation ID"),
    "search generation ID"
  );
  const projectClause = options?.projectId === undefined
    ? ""
    : ` AND debt.project_id = ${sqlLiteral(
        requireProjectNamespace(options.projectId, "project ID")
      )}`;
  const headlessOwner =
    `NOT EXISTS (
       SELECT 1 FROM memory_projection_heads head
       WHERE head.generation_id = debt.generation_id
         AND head.project_id = debt.project_id
         AND head.memory_id = debt.memory_id
     )`;
  return `SELECT
            (SELECT COUNT(*)
             FROM memory_search_vector_cleanup_receipts debt
             INDEXED BY memory_search_vector_cleanup_by_owner
             WHERE debt.generation_id = ${sqlLiteral(generationId)}${projectClause}
               AND ${headlessOwner}) AS vector_cleanup_count,
            (SELECT COUNT(*)
             FROM memory_search_projection_deletions debt
             WHERE debt.generation_id = ${sqlLiteral(generationId)}${projectClause}
               AND ${headlessOwner}) AS projection_deletion_count;`;
}

export function resolveProjectionRepositoryPartition(input) {
  const projectId = requireProjectNamespace(input?.projectId, "project ID");
  const scope = requireIdentifier(input?.scope, "memory scope");
  const scopeId = requireIdentifier(input?.scopeId, "memory scope ID");
  if (scope === "project" && scopeId === projectId) {
    return "*";
  }
  return requireVectorizeIndexedString(
    requireIdentifier(input?.repositoryId, "repository partition"),
    "repository partition"
  );
}

export function withProjectionRebuildEnumerationBudget(plan, input) {
  if (
    typeof plan !== "object" ||
    plan === null ||
    !Number.isSafeInteger(plan.etaSeconds) ||
    plan.etaSeconds < 0
  ) {
    throw new TypeError("The projection rebuild plan ETA is invalid.");
  }
  if (
    typeof input !== "object" ||
    input === null ||
    !Number.isSafeInteger(input.queryCount) ||
    input.queryCount < 0 ||
    !Number.isSafeInteger(input.elapsedMilliseconds) ||
    input.elapsedMilliseconds < 0
  ) {
    throw new TypeError("The projection rebuild enumeration metrics are invalid.");
  }
  const enumerationSeconds = Math.ceil(input.elapsedMilliseconds / 1_000);
  const etaSeconds = plan.etaSeconds + enumerationSeconds;
  if (!Number.isSafeInteger(etaSeconds)) {
    throw new TypeError("The projection rebuild total ETA exceeds the safe integer range.");
  }
  return {
    ...plan,
    rebuildEtaSeconds: plan.etaSeconds,
    enumerationQueryCount: input.queryCount,
    enumerationSeconds,
    etaSeconds
  };
}

export function projectionRebuildHistoryQuery(projectionTargetIds) {
  if (
    !Array.isArray(projectionTargetIds) ||
    projectionTargetIds.length === 0 ||
    projectionTargetIds.length > PROJECTION_REBUILD_QUERY_BATCH_SIZE
  ) {
    throw new TypeError(
      `Projection rebuild history queries require between 1 and ` +
        `${PROJECTION_REBUILD_QUERY_BATCH_SIZE} targets.`
    );
  }
  const ids = projectionTargetIds.map((value) => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
      throw new TypeError("The projection target ID is invalid.");
    }
    return sqlLiteral(value);
  });
  const requestedTargets = ids.map((id) => `(${id})`).join(", ");
  const indexedPredicate = (alias) =>
    `${alias}.event_type = ${sqlLiteral(PROJECTION_REBUILD_EVENT_TYPE)}
              AND ${alias}.event_id GLOB 'projection-rebuild:*'
              AND json_extract(${alias}.payload_json, '$.projectionMode')
                  IN ('snapshot', 'search', 'delete')
              AND json_extract(${alias}.payload_json, '$.projectionTargetId') =
                  requested.projection_target_id`;
  return `WITH requested_targets(projection_target_id) AS (
            VALUES ${requestedTargets}
          ),
          selected_event_ids(event_id) AS (
            SELECT (
              SELECT first.event_id FROM outbox_events first
              WHERE ${indexedPredicate("first")}
                AND json_extract(first.payload_json, '$.executionOrdinal') = 0
              ORDER BY first.event_id DESC LIMIT 1
            )
            FROM requested_targets requested
            UNION
            SELECT (
              SELECT latest.event_id FROM outbox_events latest
              WHERE ${indexedPredicate("latest")}
              ORDER BY json_extract(latest.payload_json, '$.executionOrdinal') DESC,
                       latest.event_id DESC LIMIT 1
            )
            FROM requested_targets requested
          )
          SELECT e.event_id, e.project_id, e.project_version, e.event_type,
                 e.payload_digest, e.payload_json, e.dispatched_at, e.failed_at,
                 e.last_error_code, e.projection_unknown_count,
                 e.projection_unknown_first_observed_at,
                 e.projection_unknown_last_observed_at,
                 e.projection_unknown_alerted_at,
                 json_extract(e.payload_json, '$.projectionTargetId') AS projection_target_id,
                 json_extract(e.payload_json, '$.executionOrdinal') AS execution_ordinal,
                 (SELECT wr.status FROM workflow_runs wr
                  WHERE wr.project_id = e.project_id
                    AND wr.root_workflow_id = e.event_id
                  ORDER BY wr.updated_at DESC, wr.workflow_id DESC LIMIT 1) AS workflow_status,
                 (SELECT wr.updated_at FROM workflow_runs wr
                  WHERE wr.project_id = e.project_id
                    AND wr.root_workflow_id = e.event_id
                  ORDER BY wr.updated_at DESC, wr.workflow_id DESC LIMIT 1) AS workflow_updated_at
          FROM outbox_events e
          JOIN selected_event_ids selected ON selected.event_id = e.event_id
          ORDER BY projection_target_id ASC, execution_ordinal ASC, e.event_id ASC;`;
}

export function parseProjectionRebuildArguments(args) {
  if (!Array.isArray(args) || !["plan", "enqueue", "verify"].includes(args[0])) {
    throw new Error("The projection rebuild command must be plan, enqueue, or verify.");
  }
  const parsed = {
    command: args[0],
    config: DEFAULT_PROJECTION_REBUILD_CONFIG,
    projectId: undefined,
    resume: false,
    waitSeconds: 0,
    maxWaitSeconds: undefined
  };
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--resume") {
      parsed.resume = true;
      continue;
    }
    if (!["--config", "--project-id", "--wait-seconds", "--max-wait-seconds"].includes(argument)) {
      throw new Error(`Unknown projection rebuild argument: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Projection rebuild argument ${argument} requires a value.`);
    }
    index += 1;
    if (argument === "--config") {
      if (value.trim() === "" || value.includes("\0")) {
        throw new Error("The Wrangler config path is invalid.");
      }
      parsed.config = value;
    } else if (argument === "--project-id") {
      parsed.projectId = requireProjectNamespace(value, "project ID");
    } else if (argument === "--wait-seconds") {
      const seconds = Number(value);
      if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 3_600) {
        throw new Error("The verification wait must be between 0 and 3600 seconds.");
      }
      parsed.waitSeconds = seconds;
    } else {
      const seconds = Number(value);
      if (!Number.isSafeInteger(seconds) || seconds < 0) {
        throw new Error("The maximum wait must be a non-negative safe integer.");
      }
      parsed.maxWaitSeconds = seconds;
    }
  }
  if (parsed.command === "verify" && parsed.resume) {
    throw new Error("--resume is valid only with the plan or enqueue command.");
  }
  if (parsed.command !== "verify" && parsed.waitSeconds !== 0) {
    throw new Error("--wait-seconds is valid only with the verify command.");
  }
  if (parsed.command === "verify" && parsed.maxWaitSeconds !== undefined) {
    throw new Error("--max-wait-seconds is valid only with the plan or enqueue command.");
  }
  return parsed;
}

export async function main(args = process.argv.slice(2), runtime = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }
  const queryRunner = runtime.runQuery ?? runD1Query;
  const enqueueProjectionEvents = runtime.enqueueEvents ?? enqueueEvents;
  if (typeof queryRunner !== "function" || typeof enqueueProjectionEvents !== "function") {
    throw new TypeError("The projection rebuild command runtime is invalid.");
  }
  const options = parseProjectionRebuildArguments(args);
  const configPath = resolve(options.config);
  if (!existsSync(configPath)) {
    throw new Error(
      `The rendered Wrangler config does not exist: ${options.config}. Run the config renderer first.`
    );
  }
  const enumerationStartedAt = Date.now();
  const enumerationMetrics = { queryCount: 0 };
  const meteredQuery = (...parameters) => {
    enumerationMetrics.queryCount += 1;
    return queryRunner(...parameters);
  };
  const targets = loadRebuildTargets(configPath, options.projectId, {
    runQuery: meteredQuery
  });
  const descriptors = targets.flatMap(projectionRebuildDescriptors);
  const searchGenerationId = targets[0]?.search_generation_id ??
    loadActiveSearchGeneration(configPath, meteredQuery);
  if (options.command === "verify") {
    await verifyTargets(
      configPath,
      targets,
      descriptors,
      options,
      searchGenerationId,
      meteredQuery
    );
    return;
  }

  assertProjectionRebuildCleanupDebtClear(loadProjectionRebuildCleanupDebt(
    configPath,
    searchGenerationId,
    options.projectId,
    { runQuery: meteredQuery }
  ));
  const historyRows = loadHistoryRows(configPath, descriptors, meteredQuery);
  const selection = selectProjectionRebuildEvents(descriptors, historyRows, {
    resume: options.resume
  });
  const plan = withProjectionRebuildEnumerationBudget(
    summarizeProjectionRebuildPlan(targets, selection),
    {
      queryCount: enumerationMetrics.queryCount,
      elapsedMilliseconds: Date.now() - enumerationStartedAt
    }
  );
  printSummary("Projection rebuild plan", plan);
  enforceWaitBudget(plan, options.maxWaitSeconds);
  if (options.command === "plan") {
    return;
  }

  const preEnqueueTargets = loadRebuildTargets(configPath, options.projectId, {
    runQuery: meteredQuery
  });
  if (!sameProjectionRebuildTargets(targets, preEnqueueTargets)) {
    throw new Error(
      "The authoritative project version, search generation, snapshot capacity, or memory " +
      "heads changed before enqueue; rerun the projection rebuild."
    );
  }
  const preEnqueueSearchGenerationId = preEnqueueTargets[0]?.search_generation_id ??
    loadActiveSearchGeneration(configPath, meteredQuery);
  if (preEnqueueSearchGenerationId !== searchGenerationId) {
    throw new Error(
      "The active search generation changed before enqueue; rerun the projection rebuild."
    );
  }
  assertProjectionRebuildCleanupDebtClear(loadProjectionRebuildCleanupDebt(
    configPath,
    preEnqueueSearchGenerationId,
    options.projectId,
    { runQuery: meteredQuery }
  ));
  enqueueProjectionEvents(configPath, selection.events);
  const issues = projectionRebuildEnqueueIssues(
    selection.events,
    loadHistoryRows(configPath, descriptors, meteredQuery)
  );
  if (issues.length !== 0) {
    throw new Error(`Projection rebuild enqueue verification failed:\n${issues.join("\n")}`);
  }
  if (!sameProjectionRebuildTargets(
    targets,
    loadRebuildTargets(configPath, options.projectId, { runQuery: meteredQuery })
  )) {
    throw new Error(
      "The authoritative project version, search generation, snapshot capacity, or memory " +
        "heads changed during enqueue; rerun the projection rebuild."
    );
  }
  printSummary("Projection rebuild enqueue complete", plan);
}

export function loadRebuildTargets(configPath, projectId, runtime = {}) {
  const runQuery = runtime.runQuery ?? runD1Query;
  if (typeof runQuery !== "function") {
    throw new TypeError("The projection rebuild query runner is invalid.");
  }
  const pageSize = requirePageLimit(runtime.pageSize);
  const generationId = loadActiveSearchGeneration(configPath, runQuery);
  const projectRows = loadProjectPages(configPath, projectId, pageSize, runQuery);
  if (projectId !== undefined && projectRows.length === 0) {
    throw new Error(`The requested projection rebuild project does not exist: ${projectId}`);
  }
  const targets = projectRows.map((row) => ({
    ...row,
    search_generation_id: generationId,
    memory_heads: [],
    search_heads: []
  }));
  const targetsByProject = new Map(targets.map((target) => [target.project_id, target]));

  for (const row of loadMemoryHeadPages(configPath, projectId, pageSize, runQuery)) {
    const target = targetsByProject.get(row.project_id);
    if (target === undefined || target.project_version !== row.project_version) {
      throw new Error(
        "The authoritative project set or project version changed while loading memory heads."
      );
    }
    target.memory_heads.push({
      memory_id: row.memory_id,
      revision_id: row.revision_id,
      repository_partition: resolveProjectionRepositoryPartition({
        projectId: row.project_id,
        scope: row.scope,
        scopeId: row.scope_id,
        repositoryId: row.repository_id
      })
    });
  }

  for (const row of loadSearchHeadPages(
    configPath,
    projectId,
    generationId,
    pageSize,
    runQuery
  )) {
    const target = targetsByProject.get(row.project_id);
    if (target === undefined) {
      if (projectId === undefined) {
        throw new Error(
          `Active search projection head belongs to a project outside the admitted ` +
            `authority set: ${row.project_id}`
        );
      }
      continue;
    }
    const { project_id: ignoredProjectId, ...head } = row;
    target.search_heads.push(head);
  }

  assertSameProjectAuthority(
    projectRows,
    loadProjectPages(configPath, projectId, pageSize, runQuery)
  );
  if (loadActiveSearchGeneration(configPath, runQuery) !== generationId) {
    throw new Error("The active search generation changed while loading rebuild targets.");
  }
  for (const target of targets) {
    projectionRebuildDescriptors(target);
  }
  return targets;
}

export function loadProjectionRebuildCleanupDebt(
  configPath,
  searchGenerationId,
  projectId,
  runtime = {}
) {
  const runQuery = runtime.runQuery ?? runD1Query;
  if (typeof runQuery !== "function") {
    throw new TypeError("The projection rebuild query runner is invalid.");
  }
  return requireProjectionRebuildCleanupDebt(
    runQuery(
      "SEARCH_DB",
      projectionRebuildCleanupDebtQuery({ searchGenerationId, projectId }),
      configPath,
      "Load headless search projection cleanup debt"
    )
  );
}

function loadProjectPages(configPath, projectId, pageSize, runQuery) {
  const rows = [];
  let cursor;
  while (true) {
    const page = runQuery(
      "MEMORY_DB",
      projectionRebuildTargetQuery({
        projectId,
        cursor,
        limit: pageSize
      }),
      configPath,
      "Load authoritative projection rebuild targets"
    );
    rows.push(...page);
    if (page.length < pageSize) {
      return rows;
    }
    cursor = { projectId: page.at(-1).project_id };
  }
}

function loadActiveSearchGeneration(configPath, runQuery = runD1Query) {
  return requireActiveSearchGeneration(
    runQuery(
      "SEARCH_DB",
      ACTIVE_SEARCH_GENERATION_QUERY,
      configPath,
      "Load active search generation"
    )
  );
}

function loadMemoryHeadPages(configPath, projectId, pageSize, runQuery) {
  return loadHeadPages((cursor) =>
    runQuery(
      "MEMORY_DB",
      projectionRebuildHeadQuery({
        projectId,
        cursor,
        limit: pageSize
      }),
      configPath,
      "Load authoritative projection rebuild memory heads"
    ), pageSize);
}

function loadSearchHeadPages(
  configPath,
  projectId,
  searchGenerationId,
  pageSize,
  runQuery
) {
  return loadHeadPages((cursor) =>
    runQuery(
      "SEARCH_DB",
      projectionRebuildSearchHeadQuery({
        projectId,
        searchGenerationId,
        cursor,
        limit: pageSize
      }),
      configPath,
      "Load active search projection ledger heads"
    ), pageSize);
}

function loadHeadPages(loadPage, pageSize) {
  const heads = [];
  let cursor;
  while (true) {
    const page = loadPage(cursor);
    heads.push(...page);
    if (page.length < pageSize) {
      return heads;
    }
    cursor = {
      projectId: page.at(-1).project_id,
      memoryId: page.at(-1).memory_id
    };
  }
}

function assertSameProjectAuthority(expected, actual) {
  if (expected.length !== actual.length) {
    throw new Error("The authoritative project set changed while loading rebuild targets.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (
      expected[index].project_id !== actual[index].project_id ||
      expected[index].project_version !== actual[index].project_version ||
      expected[index].memory_count !== actual[index].memory_count ||
      expected[index].revision_count !== actual[index].revision_count ||
      expected[index].scope_count !== actual[index].scope_count ||
      expected[index].content_bytes !== actual[index].content_bytes
    ) {
      throw new Error(
        "The authoritative project set, version, or snapshot capacity changed while loading " +
          "rebuild targets."
      );
    }
  }
}

function loadHistoryRows(configPath, descriptors, runQuery = runD1Query) {
  const rows = [];
  for (const batch of splitProjectionRebuildQueryBatches(descriptors)) {
    rows.push(
      ...runQuery(
        "MEMORY_DB",
        projectionRebuildHistoryQuery(batch.map((descriptor) =>
          descriptor.projectionTargetId
        )),
        configPath,
        "Load projection rebuild execution history"
      )
    );
  }
  return rows;
}

function enqueueEvents(configPath, events) {
  const createdAt = new Date().toISOString();
  for (const batch of splitProjectionRebuildBatches(events)) {
    runD1MutationFile(
      "MEMORY_DB",
      buildProjectionRebuildSql(batch, { createdAt }),
      configPath,
      "Enqueue projection rebuild events"
    );
  }
}

async function verifyTargets(
  configPath,
  targets,
  descriptors,
  options,
  searchGenerationId,
  runQuery = runD1Query
) {
  const deadline = Date.now() + options.waitSeconds * 1_000;
  let summary;
  do {
    const cleanupDebt = assertProjectionRebuildCleanupDebtClear(
      loadProjectionRebuildCleanupDebt(
        configPath,
        searchGenerationId,
        options.projectId,
        { runQuery }
      )
    );
    const historyRows = loadHistoryRows(configPath, descriptors, runQuery);
    const selection = selectLatestProjectionRebuildEvents(descriptors, historyRows);
    const currentTargets = loadRebuildTargets(configPath, options.projectId, { runQuery });
    if (!sameProjectionRebuildTargets(targets, currentTargets)) {
      throw new Error(
        "The authoritative project version, search generation, or memory heads changed during " +
          "verification; enqueue a new rebuild."
      );
    }
    const currentSearchGenerationId = currentTargets[0]?.search_generation_id ??
      loadActiveSearchGeneration(configPath, runQuery);
    if (currentSearchGenerationId !== searchGenerationId) {
      throw new Error(
        "The active search generation changed during verification; enqueue a new rebuild."
      );
    }
    summary = summarizeProjectionRebuildVerification({
      targets,
      events: selection.events,
      outboxRows: historyRows,
      snapshotRows: loadSnapshotRows(configPath, targets, runQuery),
      searchRows: currentTargets.flatMap((target) =>
        target.search_heads.map((head) => ({ ...head, project_id: target.project_id }))
      ),
      cleanupDebt
    });
    if (summary.complete) {
      printSummary("Projection rebuild verification complete", {
        ...summary,
        etaSeconds: estimateProjectionRebuildEtaSeconds(summary.pendingCount)
      });
      return;
    }
    printSummary("Projection rebuild verification pending", {
      ...summary,
      etaSeconds: estimateProjectionRebuildEtaSeconds(summary.pendingCount)
    });
    if (Date.now() >= deadline) {
      break;
    }
    await delay(Math.min(VERIFY_POLL_MS, deadline - Date.now()));
  } while (true);
  throw new Error(
    `Projection rebuild is incomplete (pending=${summary.pendingCount}):\n` +
      summary.issues.join("\n")
  );
}

function loadSnapshotRows(configPath, targets, runQuery = runD1Query) {
  const rows = [];
  for (const batch of splitProjectionRebuildQueryBatches(
    targets.map((target) => target.project_id)
  )) {
    rows.push(
      ...runQuery(
        "MEMORY_DB",
        `SELECT p.project_id, p.project_version, p.active_snapshot_id,
                s.snapshot_id, s.status, s.manifest_key, s.manifest_sha256
         FROM projects p
         LEFT JOIN projection_snapshots s
           ON s.project_id = p.project_id
          AND s.snapshot_id = p.active_snapshot_id
         WHERE p.project_id IN (${batch.map(sqlLiteral).join(", ")});`,
        configPath,
        "Load active projection snapshots"
      )
    );
  }
  return rows;
}

function enforceWaitBudget(plan, maximumWaitSeconds) {
  assertProjectionRebuildWaitBudget(plan, maximumWaitSeconds);
}

function printSummary(label, summary) {
  const enumeration = Number.isSafeInteger(summary.enumerationQueryCount)
    ? ` queries=${summary.enumerationQueryCount} enumeration=${summary.enumerationSeconds}s`
    : "";
  const cleanupDebt = Number.isSafeInteger(summary.vectorCleanupDebtCount)
    ? ` vector-cleanup-debt=${summary.vectorCleanupDebtCount} ` +
      `projection-deletion-debt=${summary.projectionDeletionDebtCount}`
    : "";
  process.stdout.write(
    `${label}: total=${summary.totalCount} project=${summary.projectCount} ` +
      `search=${summary.searchCount} delete=${summary.deleteCount} ` +
      `pending=${summary.pendingCount}${cleanupDebt}${enumeration} ETA=${summary.etaSeconds}s.\n`
  );
}

function runD1Query(database, sql, configPath, label) {
  const result = runWrangler(
    [
      "d1",
      "execute",
      database,
      "--remote",
      "--config",
      configPath,
      "--command",
      sql,
      "--json"
    ],
    label,
    QUERY_TIMEOUT_MS,
    true
  );
  return decodeD1Rows(result.stdout);
}

function runD1MutationFile(database, sql, configPath, label) {
  const directory = mkdtempSync(join(tmpdir(), "edgemneme-projection-rebuild-"));
  const sqlPath = join(directory, "enqueue.sql");
  try {
    writeFileSync(sqlPath, `${sql}\n`, { mode: 0o600 });
    runWrangler(
      [
        "d1",
        "execute",
        database,
        "--remote",
        "--config",
        configPath,
        "--file",
        sqlPath,
        "--yes"
      ],
      label,
      MUTATION_TIMEOUT_MS,
      false
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runWrangler(args, label, timeout, capture) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    timeout,
    maxBuffer: CAPTURE_LIMIT_BYTES
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed.`, { cause: result.error });
  }
  return result;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function admittedProjectPredicate(projectAlias) {
  return `(${projectAlias}.project_ref NOT GLOB 'system.synthetic.*'
            OR EXISTS (
              SELECT 1 FROM synthetic_cleanup_registry registry
              WHERE registry.project_id = ${projectAlias}.project_id
                AND registry.cleanup_fenced_at IS NULL
            ))`;
}

function requireCursor(cursor, key, label) {
  if (typeof cursor !== "object" || cursor === null) {
    throw new TypeError("The projection rebuild cursor is invalid.");
  }
  requireIdentifier(cursor[key], `cursor ${label}`);
}

function requireProjectCursor(cursor) {
  if (typeof cursor !== "object" || cursor === null) {
    throw new TypeError("The projection rebuild cursor is invalid.");
  }
  requireProjectNamespace(cursor.projectId, "cursor project ID");
}

function requireHeadCursor(cursor) {
  requireProjectCursor(cursor);
  requireCursor(cursor, "memoryId", "memory ID");
}

function requirePageLimit(value) {
  const limit = value ?? PROJECTION_REBUILD_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError("The projection rebuild page limit must be between 1 and 1000.");
  }
  return limit;
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`The ${label} is invalid.`);
  }
  return value;
}

function requireProjectNamespace(value, label) {
  return requireVectorizeIndexedString(
    requireIdentifier(value, label),
    "project namespace"
  );
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/enqueue-projection-rebuild.mjs plan [--project-id ID] [--resume] [--max-wait-seconds N] [--config PATH]
  node scripts/enqueue-projection-rebuild.mjs enqueue [--project-id ID] [--resume] [--max-wait-seconds N] [--config PATH]
  node scripts/enqueue-projection-rebuild.mjs verify [--project-id ID] [--wait-seconds N] [--config PATH]

Plan is read-only. Enqueue writes only outbox events in batches of 50. Read-only history
and snapshot queries use batches of 250. Verify reads the ordinary active-generation projection
ledger plus aggregate headless cleanup debt and never queries FTS5. No command applies migrations.
`);
}

const isEntrypoint = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Projection rebuild failed."}\n`
    );
    process.exitCode = 1;
  });
}
