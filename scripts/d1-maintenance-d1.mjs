import { createD1BindingRestRuntime } from "./d1-rest-runtime.mjs";
import {
  assertMigrationTableContract,
  assertExpectedSchemaInventory,
  localMigrationFiles,
  parseMigrationHistory,
  parseSchemaInventory,
  remoteSchemaProbeSql
} from "./d1-maintenance-schema.mjs";

const MEMORY_TABLES = Object.freeze([
  "github_credential_sync_lane",
  "github_repository_sync_runs",
  "github_sync_dispatch_items",
  "github_sync_dispatches",
  "outbox_events",
  "projection_snapshots",
  "projects",
  "session_consolidations",
  "workflow_runs"
]);

const SEARCH_TABLES = Object.freeze([
  "d1_migrations",
  "memory_fts",
  "memory_fts_chunk_ledger",
  "memory_fts_chunk_ledger_assertions",
  "memory_projection_heads",
  "memory_search_projection_deletions",
  "memory_search_projection_write_leases",
  "memory_search_vector_cleanup_janitor_state",
  "memory_search_vector_cleanup_receipts"
]);

const SELECT_ONLY = /^\s*(?:SELECT|WITH\s+[^;]+\s+SELECT)\b/iu;

export class SearchAdmissionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SearchAdmissionError";
    this.code = code;
  }
}

export function assertReadOnlyD1Statement(sql) {
  if (
    typeof sql !== "string" ||
    !SELECT_ONLY.test(sql) ||
    /\b(?:ALTER|CREATE|DELETE|DROP|INSERT|REINDEX|REPLACE|UPDATE|VACUUM)\b/iu.test(sql)
  ) {
    throw new Error("Maintenance admission permits only bounded read-only D1 statements.");
  }
  return sql;
}

function statement(sql, params = []) {
  return { sql: assertReadOnlyD1Statement(sql), params };
}

function requireRows(result, label) {
  if (!Array.isArray(result?.results)) {
    throw new Error(`${label} returned an invalid D1 result set.`);
  }
  return result.results;
}

async function readRemoteSchemaProbe(runtime, database, trailingStatement, label) {
  const probeSql = remoteSchemaProbeSql(database);
  const detailStatements = [
    ...probeSql.columns,
    ...probeSql.foreignKeys,
    ...probeSql.indexes
  ];
  const results = await runtime.batch(
    [statement(probeSql.objects), ...detailStatements.map((sql) => statement(sql)), trailingStatement],
    label
  );
  let offset = 0;
  const objects = requireRows(results[offset], `${database} schema object probe`);
  offset += 1;
  const takeDetailRows = (statements, detailLabel) => {
    const rows = [];
    for (let index = 0; index < statements.length; index += 1) {
      rows.push(...requireRows(
        results[offset],
        `${database} ${detailLabel} probe part ${index + 1}`
      ));
      offset += 1;
    }
    return rows;
  };
  const columns = takeDetailRows(probeSql.columns, "column");
  const foreignKeys = takeDetailRows(probeSql.foreignKeys, "foreign-key");
  const indexes = takeDetailRows(probeSql.indexes, "index");
  const trailingRows = requireRows(results[offset], `${database} trailing schema probe`);
  offset += 1;
  if (offset !== results.length) throw new Error(`${database} schema probe returned extra results.`);
  return { objects, columns, foreignKeys, indexes, trailingRows };
}

function exactCount(result, label) {
  const rows = requireRows(result, label);
  const count = rows.length === 1 ? rows[0]?.count : undefined;
  if (!Number.isSafeInteger(count) || count < 0 || Object.keys(rows[0]).length !== 1) {
    throw new Error(`${label} did not return one non-negative integer count.`);
  }
  return count;
}

function uniqueNames(rows, allowed, label) {
  const names = [];
  const observed = new Set();
  for (const row of rows) {
    const name = row?.name;
    if (
      typeof name !== "string" ||
      Object.keys(row).length !== 1 ||
      !allowed.has(name) ||
      observed.has(name)
    ) {
      throw new Error(`${label} contains an unknown or duplicate name.`);
    }
    observed.add(name);
    names.push(name);
  }
  return names.sort();
}

async function readMigrationState(runtime, database) {
  const historyLimit = localMigrationFiles(database).length + 1;
  const [historyResult, columnsResult, indexesResult, sequenceResult] = await runtime.batch(
    [
      statement(
        `SELECT MIN(id) AS id, name, COUNT(*) AS count
         FROM d1_migrations GROUP BY name ORDER BY id LIMIT ${historyLimit}`
      ),
      statement(
        `SELECT cid, name, type, "notnull" AS not_null,
           dflt_value AS default_value, pk AS primary_key, hidden
         FROM pragma_table_xinfo('d1_migrations') ORDER BY cid`
      ),
      statement(
        `SELECT seq, name, "unique" AS is_unique, origin, partial
         FROM pragma_index_list('d1_migrations') ORDER BY seq`
      ),
      statement(
        "SELECT seq FROM sqlite_sequence WHERE name = 'd1_migrations' ORDER BY name"
      )
    ],
    `Read ${database} migration contract`
  );
  const appliedMigrations = parseMigrationHistory(
    requireRows(historyResult, `${database} migration history`),
    database
  );
  assertMigrationTableContract(
    database,
    requireRows(columnsResult, `${database} migration columns`),
    requireRows(indexesResult, `${database} migration indexes`),
    requireRows(sequenceResult, `${database} migration sequence`),
    appliedMigrations
  );
  return appliedMigrations;
}

function requireExpectedMemorySchema(tables) {
  if (tables.length === 0) return "fresh";
  const present = new Set(tables);
  const baseline = [
    "outbox_events",
    "projection_snapshots",
    "projects",
    "session_consolidations",
    "workflow_runs"
  ];
  for (const name of baseline) {
    if (!present.has(name)) {
      throw new Error(`MEMORY_DB maintenance schema is missing baseline table ${name}.`);
    }
  }
  const githubTables = [
    "github_credential_sync_lane",
    "github_sync_dispatch_items",
    "github_sync_dispatches"
  ];
  const githubPresent = githubTables.filter((name) => present.has(name));
  if (githubPresent.length !== 0 && githubPresent.length !== githubTables.length) {
    throw new Error("MEMORY_DB contains a partial GitHub sync maintenance schema.");
  }
  return "initialized";
}

export async function observeMemoryD1(runtime) {
  const schemaProbe = await readRemoteSchemaProbe(
    runtime,
    "MEMORY_DB",
    statement(
      `SELECT name FROM pragma_table_xinfo('session_consolidations')
       WHERE name IN (
         'status', 'lease_owner', 'lease_claim_id', 'lease_expires_at',
         'lease_operation_id'
       ) ORDER BY cid`
    ),
    "Probe MEMORY_DB maintenance schema"
  );
  const inventory = parseSchemaInventory(
    {
      objects: schemaProbe.objects,
      columns: schemaProbe.columns,
      foreignKeys: schemaProbe.foreignKeys,
      indexes: schemaProbe.indexes
    },
    "MEMORY_DB"
  );
  const consolidationColumns = uniqueNames(
    schemaProbe.trailingRows,
    new Set([
      "status",
      "lease_owner",
      "lease_claim_id",
      "lease_expires_at",
      "lease_operation_id"
    ]),
    "MEMORY_DB consolidation column probe"
  );
  if (!inventory.hasMigrationTable) {
    if (inventory.objects.length !== 0 || consolidationColumns.length !== 0) {
      throw new Error("MEMORY_DB is not an exact fresh database.");
    }
    return Object.freeze({
      state: "fresh",
      applied_migrations: [],
      objects: inventory.objects,
      counts: Object.freeze({}),
      inflight: 0,
      production_rows: 0
    });
  }

  const appliedMigrations = await readMigrationState(runtime, "MEMORY_DB");
  assertExpectedSchemaInventory("MEMORY_DB", appliedMigrations.length, inventory.schema);
  if (appliedMigrations.length === 0) {
    if (consolidationColumns.length !== 0) {
      throw new Error("MEMORY_DB empty migration history has residual application columns.");
    }
    return Object.freeze({
      state: "fresh",
      applied_migrations: [],
      objects: inventory.objects,
      counts: Object.freeze({}),
      inflight: 0,
      production_rows: 0
    });
  }
  const tables = inventory.objects
    .filter((identity) => identity.startsWith("table:"))
    .map((identity) => identity.slice("table:".length))
    .filter((name) => MEMORY_TABLES.includes(name));
  const state = requireExpectedMemorySchema(tables);

  const present = new Set(tables);
  const presentConsolidationColumns = new Set(consolidationColumns);
  const checks = [];
  const addCount = (name, sql) => {
    if (present.has(name)) checks.push([name, statement(sql)]);
  };
  addCount("projects", "SELECT COUNT(*) AS count FROM projects");
  const applicationTables = inventory.objects
    .filter((identity) => identity.startsWith("table:"))
    .map((identity) => identity.slice("table:".length))
    .filter((name) => name !== "github_tree_manifest_retention_cursors");
  if (applicationTables.some((name) => !/^[a-z_][a-z0-9_]*$/u.test(name))) {
    throw new Error("MEMORY_DB contains an unsupported application table identifier.");
  }
  checks.push([
    "production_rows",
    statement(
      `SELECT ${applicationTables.map((name) =>
        `(SELECT COUNT(*) FROM ${name})`
      ).join(" + ")} AS count`
    )
  ]);
  addCount(
    "outbox_events",
    `SELECT COUNT(*) AS count FROM outbox_events
     WHERE failed_at IS NULL AND (
       dispatched_at IS NULL OR next_attempt_at IS NOT NULL OR last_error_code IS NULL OR
       last_error_code NOT IN (
         'WORKFLOW_COMPLETE', 'SYNTHETIC_CLEANUP_FENCED',
         'PROJECTION_REBUILD_COMPLETE', 'PROJECTION_REBUILD_WORKFLOW_FAILED',
         'PROJECTION_REBUILD_WORKFLOW_TERMINATED'
       )
     )`
  );
  addCount(
    "workflow_runs",
    "SELECT COUNT(*) AS count FROM workflow_runs WHERE status NOT IN ('complete', 'failed', 'terminated')"
  );
  if (present.has("session_consolidations")) {
    if (!presentConsolidationColumns.has("status")) {
      throw new Error("MEMORY_DB session_consolidations is missing its status column.");
    }
    const consolidationConditions = ["status IN ('queued', 'running')"];
    for (const column of [
      "lease_owner",
      "lease_claim_id",
      "lease_expires_at",
      "lease_operation_id"
    ]) {
      if (presentConsolidationColumns.has(column)) {
        consolidationConditions.push(`${column} IS NOT NULL`);
      }
    }
    checks.push([
      "session_consolidations",
      statement(
        `SELECT COUNT(*) AS count FROM session_consolidations
         WHERE ${consolidationConditions.join(" OR ")}`
      )
    ]);
  }
  addCount(
    "projection_snapshots",
    "SELECT COUNT(*) AS count FROM projection_snapshots WHERE status IN ('building', 'ready')"
  );
  addCount(
    "github_sync_dispatches",
    "SELECT COUNT(*) AS count FROM github_sync_dispatches WHERE status IN ('materialized', 'dispatching')"
  );
  addCount(
    "github_sync_dispatch_items",
    "SELECT COUNT(*) AS count FROM github_sync_dispatch_items WHERE status IN ('pending', 'running')"
  );
  addCount(
    "github_repository_sync_runs",
    "SELECT COUNT(*) AS count FROM github_repository_sync_runs WHERE status = 'running'"
  );
  addCount(
    "github_credential_sync_lane",
    `SELECT COUNT(*) AS count FROM github_credential_sync_lane
     WHERE holder_id IS NOT NULL OR lease_claim_id IS NOT NULL OR lease_until IS NOT NULL`
  );
  const results = await runtime.batch(
    checks.map(([, request]) => request),
    "Observe MEMORY_DB maintenance counts"
  );
  if (!Array.isArray(results) || results.length !== checks.length) {
    throw new Error("MEMORY_DB maintenance counts returned an invalid batch.");
  }
  const counts = Object.fromEntries(
    checks.map(([name], index) => [name, exactCount(results[index], `MEMORY_DB ${name}`)])
  );
  const productionRows = counts.production_rows ?? 0;
  const inflight = Object.entries(counts)
    .filter(([name]) => name !== "projects" && name !== "production_rows")
    .reduce((total, [, count]) => total + count, 0);
  if (!Number.isSafeInteger(inflight)) {
    throw new Error("MEMORY_DB maintenance count total exceeds the supported bound.");
  }
  return Object.freeze({
    state,
    applied_migrations: appliedMigrations,
    objects: inventory.objects,
    tables,
    counts: Object.freeze(counts),
    inflight,
    production_rows: productionRows
  });
}

export async function observeSearchD1(runtime) {
  const schemaProbe = await readRemoteSchemaProbe(
    runtime,
    "SEARCH_DB",
    statement(
      `SELECT name FROM pragma_table_xinfo('memory_projection_heads')
       WHERE name = 'chunk_count' ORDER BY cid`
    ),
    "Probe SEARCH_DB chunk ledger schema"
  );
  const inventory = parseSchemaInventory(
    {
      objects: schemaProbe.objects,
      columns: schemaProbe.columns,
      foreignKeys: schemaProbe.foreignKeys,
      indexes: schemaProbe.indexes
    },
    "SEARCH_DB"
  );
  const columns = uniqueNames(
    schemaProbe.trailingRows,
    new Set(["chunk_count"]),
    "SEARCH_DB chunk_count probe"
  );
  let appliedMigrations = [];
  let state;
  if (!inventory.hasMigrationTable) {
    if (inventory.objects.length !== 0 || columns.length !== 0) {
      throw new SearchAdmissionError(
        "SEARCH_MIXED_SCHEMA",
        "SEARCH_DB is neither exact fresh nor backed by a migration history"
      );
    }
    assertExpectedSchemaInventory("SEARCH_DB", 0, inventory.schema);
    state = "fresh";
  } else {
    appliedMigrations = await readMigrationState(runtime, "SEARCH_DB");
    assertExpectedSchemaInventory("SEARCH_DB", appliedMigrations.length, inventory.schema);
    if (appliedMigrations.length === 0) {
      if (columns.length !== 0) {
        throw new SearchAdmissionError(
          "SEARCH_MIXED_SCHEMA",
          "an empty migration history has residual chunk-ledger columns"
        );
      }
      state = "fresh";
    } else {
      // parseMigrationHistory already proved the exact local prefix.
      state = "installed";
      if (columns.length !== 1) {
        throw new SearchAdmissionError(
          "SEARCH_MIXED_SCHEMA",
          "the migration history and chunk_count column do not form one complete state"
        );
      }
    }
  }
  const tables = inventory.objects
    .filter((identity) => identity.startsWith("table:"))
    .map((identity) => identity.slice("table:".length))
    .filter((name) => SEARCH_TABLES.includes(name));
  const present = new Set(tables);

  const countChecks = [];
  const addCount = (name, table, sql) => {
    if (present.has(table)) countChecks.push([name, statement(sql)]);
  };
  addCount("legacy_fts", "memory_fts", "SELECT COUNT(*) AS count FROM memory_fts");
  addCount(
    "legacy_heads",
    "memory_projection_heads",
    "SELECT COUNT(*) AS count FROM memory_projection_heads"
  );
  if (state === "installed") {
    addCount(
      "chunk_ledger",
      "memory_fts_chunk_ledger",
      "SELECT COUNT(*) AS count FROM memory_fts_chunk_ledger"
    );
    addCount(
      "write_leases",
      "memory_search_projection_write_leases",
      "SELECT COUNT(*) AS count FROM memory_search_projection_write_leases"
    );
    addCount(
      "projection_deletions",
      "memory_search_projection_deletions",
      "SELECT COUNT(*) AS count FROM memory_search_projection_deletions"
    );
    addCount(
      "cleanup_receipts",
      "memory_search_vector_cleanup_receipts",
      "SELECT COUNT(*) AS count FROM memory_search_vector_cleanup_receipts"
    );
    addCount(
      "janitor_cursor",
      "memory_search_vector_cleanup_janitor_state",
      `SELECT COUNT(*) AS count FROM memory_search_vector_cleanup_janitor_state
       WHERE cursor_generation_id IS NOT NULL OR cursor_project_id IS NOT NULL OR
         cursor_memory_id IS NOT NULL OR updated_at IS NOT NULL`
    );
    addCount(
      "ledger_assertions",
      "memory_fts_chunk_ledger_assertions",
      "SELECT COUNT(*) AS count FROM memory_fts_chunk_ledger_assertions"
    );
  }
  const countResults = countChecks.length === 0
    ? []
    : await runtime.batch(
      countChecks.map(([, request]) => request),
      "Observe SEARCH_DB maintenance counts"
    );
  if (!Array.isArray(countResults) || countResults.length !== countChecks.length) {
    throw new Error("SEARCH_DB maintenance counts returned an invalid batch.");
  }
  const counts = Object.fromEntries(
    countChecks.map(([name], index) => [name, exactCount(countResults[index], `SEARCH_DB ${name}`)])
  );
  const inflightNames = [
    "write_leases",
    "projection_deletions",
    "cleanup_receipts",
    "janitor_cursor",
    "ledger_assertions"
  ];
  const inflight = inflightNames.reduce((total, name) => total + (counts[name] ?? 0), 0);
  const productionRows =
    (counts.legacy_fts ?? 0) +
    (counts.legacy_heads ?? 0) +
    (counts.chunk_ledger ?? 0);
  if (!Number.isSafeInteger(inflight) || !Number.isSafeInteger(productionRows)) {
    throw new Error("SEARCH_DB maintenance count total exceeds the supported bound.");
  }
  return Object.freeze({
    state,
    applied_migrations: appliedMigrations,
    tables,
    objects: inventory.objects,
    migration_count: appliedMigrations.length,
    counts: Object.freeze(counts),
    inflight,
    production_rows: productionRows
  });
}

export async function observeD1Maintenance(configPath) {
  const memoryRuntime = createD1BindingRestRuntime(configPath, "MEMORY_DB");
  const searchRuntime = createD1BindingRestRuntime(configPath, "SEARCH_DB");
  const [memory, search] = await Promise.all([
    observeMemoryD1(memoryRuntime),
    observeSearchD1(searchRuntime)
  ]);
  return Object.freeze({ memory, search });
}
