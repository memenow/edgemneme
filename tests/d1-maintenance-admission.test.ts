import { describe, expect, it, vi } from "vitest";

// Production maintenance admission is plain ESM for direct use in GitHub Actions.
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as maintenanceAdmissionModule from "../scripts/d1-maintenance-admission.mjs";
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as maintenanceD1Module from "../scripts/d1-maintenance-d1.mjs";
// @ts-expect-error The JavaScript module has no separate declaration file.
import * as maintenanceSchemaModule from "../scripts/d1-maintenance-schema.mjs";

const {
  assertMaintenanceReady,
  maintenanceViolationCodes,
  runMaintenanceAdmission
} = maintenanceAdmissionModule;
const {
  SearchAdmissionError,
  assertReadOnlyD1Statement,
  observeMemoryD1,
  observeSearchD1
} = maintenanceD1Module;
const {
  expectedSchemaObjects,
  expectedSchemaProbeRows,
  localMigrationFiles
} = maintenanceSchemaModule;

interface D1Statement {
  sql: string;
  params: unknown[];
}

interface SchemaProbe {
  objects: Record<string, unknown>[];
  columns: Record<string, unknown>[];
  foreignKeys: Record<string, unknown>[];
  indexes: Record<string, unknown>[];
}

const result = (results: Record<string, unknown>[]) => ({ results, meta: {} });

const migrationColumns = [
  {
    cid: 0,
    name: "id",
    type: "INTEGER",
    not_null: 0,
    default_value: null,
    primary_key: 1,
    hidden: 0
  },
  {
    cid: 1,
    name: "name",
    type: "TEXT",
    not_null: 0,
    default_value: null,
    primary_key: 0,
    hidden: 0
  },
  {
    cid: 2,
    name: "applied_at",
    type: "TIMESTAMP",
    not_null: 1,
    default_value: "CURRENT_TIMESTAMP",
    primary_key: 0,
    hidden: 0
  }
];

const migrationIndexes = [{
  seq: 0,
  name: "sqlite_autoindex_d1_migrations_1",
  is_unique: 1,
  origin: "u",
  partial: 0
}];

function migrationContractResults(
  appliedMigrations: string[],
  options: {
    historyRows?: Record<string, unknown>[];
    columns?: Record<string, unknown>[];
    indexes?: Record<string, unknown>[];
    sequenceRows?: Record<string, unknown>[];
  } = {}
) {
  return [
    result(options.historyRows ?? appliedMigrations.map((name, index) => ({
      id: index + 1,
      name,
      count: 1
    }))),
    result(options.columns ?? migrationColumns),
    result(options.indexes ?? migrationIndexes),
    result(options.sequenceRows ?? (
      appliedMigrations.length === 0 ? [] : [{ seq: appliedMigrations.length }]
    ))
  ];
}

function schemaProbe(
  database: "MEMORY_DB" | "SEARCH_DB",
  migrationCount: number,
  objectIdentities?: string[]
): SchemaProbe {
  const probe = expectedSchemaProbeRows(database, migrationCount) as SchemaProbe;
  if (objectIdentities === undefined) return probe;
  const expectedByIdentity = new Map<string, Record<string, unknown>>(
    probe.objects.map((row) => [`${row.type}:${row.name}`, row] as const)
  );
  probe.objects = objectIdentities.map((identity) => {
    const expected = expectedByIdentity.get(identity);
    if (expected !== undefined) return expected;
    const separator = identity.indexOf(":");
    const type = identity.slice(0, separator);
    const name = identity.slice(separator + 1);
    return {
      type,
      name,
      table_name: name,
      definition: `CREATE ${type} ${name}`
    };
  });
  const tables = new Set(probe.objects
    .filter((row) => row.type === "table")
    .map((row) => row.name));
  probe.columns = probe.columns.filter((row) => tables.has(row.table_name));
  probe.foreignKeys = probe.foreignKeys.filter((row) => tables.has(row.table_name));
  probe.indexes = probe.indexes.filter((row) => tables.has(row.table_name));
  return probe;
}

function addMigrationTable(probe: SchemaProbe): SchemaProbe {
  probe.objects.push({
    type: "table",
    name: "d1_migrations",
    table_name: "d1_migrations",
    definition: "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT)"
  });
  return probe;
}

function quotedPragmaArguments(sql: string, pragma: string): Set<string> {
  const names = new Set<string>();
  const pattern = new RegExp(`${pragma}\\('((?:[^']|'')*)'\\)`, "giu");
  for (const match of sql.matchAll(pattern)) {
    const argument = match[1];
    if (argument === undefined) throw new Error("Missing quoted pragma argument");
    names.add(argument.replaceAll("''", "'"));
  }
  return names;
}

function remoteSchemaBatchResults(
  requests: D1Statement[],
  probe: SchemaProbe,
  trailingRows: Record<string, unknown>[]
) {
  return requests.map((request, index) => {
    if (index === 0) return result(probe.objects);
    if (index === requests.length - 1) return result(trailingRows);
    if (request.sql.includes("pragma_foreign_key_list")) {
      const tables = quotedPragmaArguments(request.sql, "pragma_foreign_key_list");
      return result(probe.foreignKeys.filter((row) => tables.has(String(row.table_name))));
    }
    if (request.sql.includes("pragma_index_xinfo")) {
      const indexes = quotedPragmaArguments(request.sql, "pragma_index_xinfo");
      return result(probe.indexes.filter((row) => indexes.has(String(row.index_name))));
    }
    if (request.sql.includes("pragma_table_xinfo")) {
      const tables = quotedPragmaArguments(request.sql, "pragma_table_xinfo");
      return result(probe.columns.filter((row) => tables.has(String(row.table_name))));
    }
    throw new Error("Unexpected remote schema probe statement");
  });
}

function searchRuntime(options: {
  appliedMigrations?: string[];
  schemaObjects?: string[];
  hasMigrationTable?: boolean;
  historyRows?: Record<string, unknown>[];
  migrationColumns?: Record<string, unknown>[];
  migrationIndexes?: Record<string, unknown>[];
  sequenceRows?: Record<string, unknown>[];
  schemaProbe?: SchemaProbe;
  columns?: string[];
  counts?: Record<string, number>;
}) {
  const statements: D1Statement[] = [];
  const counts = options.counts ?? {};
  const appliedMigrations = options.appliedMigrations ?? [];
  const hasMigrationTable = options.hasMigrationTable ?? appliedMigrations.length !== 0;
  const observedSchema = options.schemaProbe ?? schemaProbe(
    "SEARCH_DB",
    appliedMigrations.length,
    options.schemaObjects
  );
  if (hasMigrationTable) addMigrationTable(observedSchema);
  return {
    statements,
    runtime: {
      async batch(requests: D1Statement[], label: string) {
        statements.push(...requests);
        if (label === "Probe SEARCH_DB chunk ledger schema") {
          return remoteSchemaBatchResults(
            requests,
            observedSchema,
            (options.columns ?? []).map((name) => ({ name }))
          );
        }
        if (label === "Observe SEARCH_DB maintenance counts") {
          return requests.map((request) => {
            const entry = Object.entries(counts).find(([name]) =>
              request.sql.includes(searchTableForCount(name))
            );
            return result([{ count: entry?.[1] ?? 0 }]);
          });
        }
        if (label === "Read SEARCH_DB migration contract") {
          return migrationContractResults(appliedMigrations, {
            ...(options.historyRows === undefined ? {} : { historyRows: options.historyRows }),
            ...(options.migrationColumns === undefined
              ? {}
              : { columns: options.migrationColumns }),
            ...(options.migrationIndexes === undefined
              ? {}
              : { indexes: options.migrationIndexes }),
            ...(options.sequenceRows === undefined
              ? {}
              : { sequenceRows: options.sequenceRows })
          });
        }
        throw new Error(`Unexpected Search batch ${label}`);
      }
    }
  };
}

function searchTableForCount(name: string): string {
  return ({
    legacy_fts: "memory_fts",
    legacy_heads: "memory_projection_heads",
    chunk_ledger: "memory_fts_chunk_ledger",
    write_leases: "memory_search_projection_write_leases",
    projection_deletions: "memory_search_projection_deletions",
    cleanup_receipts: "memory_search_vector_cleanup_receipts",
    janitor_cursor: "memory_search_vector_cleanup_janitor_state",
    ledger_assertions: "memory_fts_chunk_ledger_assertions"
  } as Record<string, string>)[name] ?? name;
}

function memoryRuntime(
  counts: Record<string, number>,
  options: {
    appliedMigrations?: string[];
    schemaObjects?: string[];
    hasMigrationTable?: boolean;
    historyRows?: Record<string, unknown>[];
    migrationColumns?: Record<string, unknown>[];
    migrationIndexes?: Record<string, unknown>[];
    sequenceRows?: Record<string, unknown>[];
    schemaProbe?: SchemaProbe;
    consolidationColumns?: string[];
  } = {}
) {
  const appliedMigrations = options.appliedMigrations ?? localMigrationFiles("MEMORY_DB");
  const hasMigrationTable = options.hasMigrationTable ?? true;
  const observedSchema = options.schemaProbe ?? schemaProbe(
    "MEMORY_DB",
    appliedMigrations.length,
    options.schemaObjects
  );
  if (hasMigrationTable) addMigrationTable(observedSchema);
  const tables = [
    "github_credential_sync_lane",
    "github_repository_sync_runs",
    "github_sync_dispatch_items",
    "github_sync_dispatches",
    "outbox_events",
    "projection_snapshots",
    "projects",
    "session_consolidations",
    "workflow_runs"
  ];
  const statements: D1Statement[] = [];
  return {
    statements,
    runtime: {
      async batch(requests: D1Statement[], label: string) {
        statements.push(...requests);
        if (label === "Probe MEMORY_DB maintenance schema") {
          return remoteSchemaBatchResults(
            requests,
            observedSchema,
            (options.consolidationColumns ?? (appliedMigrations.length === 0 ? [] : [
              "status",
              "lease_owner",
              "lease_claim_id",
              "lease_expires_at",
              "lease_operation_id"
            ])).map((name) => ({ name }))
          );
        }
        if (label === "Observe MEMORY_DB maintenance counts") {
          return requests.map((request) => {
            if (request.sql.includes(" + ")) {
              return result([{
                count: Object.values(counts).reduce((total, count) => total + count, 0)
              }]);
            }
            const table = tables.find((name) => request.sql.includes(`FROM ${name}`));
            return result([{ count: table === undefined ? 0 : counts[table] ?? 0 }]);
          });
        }
        if (label === "Read MEMORY_DB migration contract") {
          return migrationContractResults(appliedMigrations, {
            ...(options.historyRows === undefined ? {} : { historyRows: options.historyRows }),
            ...(options.migrationColumns === undefined
              ? {}
              : { columns: options.migrationColumns }),
            ...(options.migrationIndexes === undefined
              ? {}
              : { indexes: options.migrationIndexes }),
            ...(options.sequenceRows === undefined
              ? {}
              : { sequenceRows: options.sequenceRows })
          });
        }
        throw new Error(`Unexpected Memory batch ${label}`);
      }
    }
  };
}

function greenfieldObservation(): any {
  return {
    cloudflare: {
      workers: [],
      core_versions: {
        "edgemneme-github-sync": "absent",
        "edgemneme-memory-gateway": "absent",
        "edgemneme-memory-orchestrator": "absent"
      },
      binding_targets: {
        d1_databases: {
          MEMORY_DB: "22222222-2222-4222-8222-222222222222",
          SEARCH_DB: "33333333-3333-4333-8333-333333333333"
        },
        backup_r2_bucket: "edgemneme-d1-migration-backups"
      },
      worker_bindings: [],
      gateway_ingress: { workers_dev: null, custom_domains: [], routes: [] },
      schedules: {
        "edgemneme-memory-orchestrator": [],
        "edgemneme-github-sync": []
      },
      queues: [
        {
          id: "main",
          name: "edgemneme-memory-events",
          consumers: [],
          producers: [],
          metrics: {
            backlog_bytes: 0,
            backlog_count: 0,
            oldest_message_timestamp_ms: 0
          }
        }
      ],
      workflows: []
    },
    d1: {
      memory: { state: "fresh", tables: [], counts: {}, inflight: 0, production_rows: 0 },
      search: {
        state: "installed",
        tables: [],
        objects: [],
        migration_count: 0,
        counts: {},
        inflight: 0,
        production_rows: 0
      }
    }
  };
}

describe("SEARCH_DB maintenance preflight", () => {
  const searchMigrations = localMigrationFiles("SEARCH_DB");

  it("accepts only an exact fresh database when no migrations have run", async () => {
    const { runtime } = searchRuntime({ appliedMigrations: [], hasMigrationTable: false });
    await expect(observeSearchD1(runtime)).resolves.toMatchObject({
      state: "fresh",
      applied_migrations: []
    });
  });

  it("accepts Wrangler's exact empty migration table as fresh", async () => {
    const { runtime } = searchRuntime({ appliedMigrations: [], hasMigrationTable: true });
    await expect(observeSearchD1(runtime)).resolves.toMatchObject({
      state: "fresh",
      applied_migrations: []
    });
  });

  it("rejects any migration history that is not the exact local prefix", async () => {
    const { runtime, statements } = searchRuntime({
      appliedMigrations: searchMigrations,
      columns: ["chunk_count"],
      historyRows: [
        { id: 1, name: searchMigrations[0], count: 1 },
        { id: 2, name: "0002_legacy.sql", count: 1 }
      ],
      counts: { legacy_fts: 0, legacy_heads: 0 }
    });
    await expect(observeSearchD1(runtime)).rejects.toThrow("exact local prefix");
    expect(statements.length).toBeGreaterThan(0);
    expect(() => statements.forEach(({ sql }) => assertReadOnlyD1Statement(sql))).not.toThrow();
    expect(statements.map(({ sql }) => sql).join("\n")).not.toMatch(
      /\b(?:DELETE|INSERT|UPDATE|ALTER|CREATE|DROP)\b/iu
    );
  });

  it("accepts the complete installed chunk-ledger contract and counts its in-flight state", async () => {
    const { runtime } = searchRuntime({
      appliedMigrations: searchMigrations,
      columns: ["chunk_count"],
      counts: { write_leases: 1 }
    });
    await expect(observeSearchD1(runtime)).resolves.toMatchObject({
      state: "installed",
      migration_count: 1,
      inflight: 1
    });
  });

  it("fails closed on a migration record with a partial installed schema", async () => {
    const { runtime } = searchRuntime({
      appliedMigrations: searchMigrations,
      schemaObjects: expectedSchemaObjects("SEARCH_DB", 1)
        .filter((identity: string) => identity !== "table:memory_fts"),
      columns: ["chunk_count"],
    });
    await expect(observeSearchD1(runtime)).rejects.toThrow(/partial|migration history/iu);
  });

  it("rejects missing schema, unknown objects, history gaps, and duplicate records", async () => {
    const prefix = searchMigrations;
    const expected = expectedSchemaObjects("SEARCH_DB", 1);
    await expect(observeSearchD1(searchRuntime({
      appliedMigrations: prefix,
      schemaObjects: expected.filter((identity: string) => identity !== "table:memory_fts")
    }).runtime)).rejects.toThrow(/partial|unknown/iu);
    await expect(observeSearchD1(searchRuntime({
      appliedMigrations: [],
      hasMigrationTable: false,
      schemaObjects: ["table:wrong_database_table"]
    }).runtime)).rejects.toThrow(/exact fresh|column inventory/iu);
    await expect(observeSearchD1(searchRuntime({
      appliedMigrations: prefix,
      historyRows: [{ id: 2, name: prefix[0], count: 1 }]
    }).runtime)).rejects.toThrow("malformed");
    await expect(observeSearchD1(searchRuntime({
      appliedMigrations: prefix,
      historyRows: prefix.map((name: string, index: number) => ({
        id: index + 1,
        name,
        count: index === 0 ? 2 : 1
      }))
    }).runtime)).rejects.toThrow(/duplicated|malformed/iu);
  });

  it("rejects a malformed or previously consumed empty migration table", async () => {
    await expect(observeSearchD1(searchRuntime({
      appliedMigrations: [],
      hasMigrationTable: true,
      migrationIndexes: []
    }).runtime)).rejects.toThrow("Wrangler's contract");
    await expect(observeSearchD1(searchRuntime({
      appliedMigrations: [],
      hasMigrationTable: true,
      sequenceRows: [{ seq: 4 }]
    }).runtime)).rejects.toThrow("residual sequence");
  });

  it("rejects same-name table, ledger, and trigger definition changes", async () => {
    const legacyProbe = schemaProbe("SEARCH_DB", 1);
    const legacyHeads = legacyProbe.objects.find((row) =>
      row.type === "table" && row.name === "memory_projection_heads"
    );
    if (legacyHeads === undefined) throw new Error("Missing legacy heads fixture.");
    legacyHeads.definition = `${legacyHeads.definition} WITHOUT ROWID`;
    await expect(observeSearchD1(searchRuntime({
      appliedMigrations: searchMigrations,
      schemaProbe: legacyProbe
    }).runtime)).rejects.toThrow("schema definition");

    const ledgerProbe = schemaProbe("SEARCH_DB", 1);
    const ledger = ledgerProbe.objects.find((row) =>
      row.type === "table" && row.name === "memory_fts_chunk_ledger"
    );
    if (ledger === undefined) throw new Error("Missing chunk-ledger fixture.");
    ledger.definition = `${ledger.definition} STRICT`;
    await expect(observeSearchD1(searchRuntime({
      appliedMigrations: searchMigrations,
      columns: ["chunk_count"],
      schemaProbe: ledgerProbe
    }).runtime)).rejects.toThrow("schema definition");

    const triggerProbe = schemaProbe("SEARCH_DB", 1);
    const trigger = triggerProbe.objects.find((row) => row.type === "trigger");
    if (trigger === undefined) throw new Error("Missing Search trigger fixture.");
    trigger.definition = `${trigger.definition} SELECT 1`;
    await expect(observeSearchD1(searchRuntime({
      appliedMigrations: searchMigrations,
      columns: ["chunk_count"],
      schemaProbe: triggerProbe
    }).runtime)).rejects.toThrow("schema definition");
  });
});

describe("MEMORY_DB maintenance state", () => {
  it("uses only fixed schema identities in remote pragma probes", async () => {
    const observed = memoryRuntime({});
    const authorizerRuntime = {
      async batch(requests: D1Statement[], label: string) {
        for (const request of requests) {
          const pragmaCalls = request.sql.matchAll(
            /\bpragma_(?:foreign_key_list|index_list|index_xinfo|table_xinfo)\(([^)]*)\)/giu
          );
          for (const match of pragmaCalls) {
            const argument = match[1];
            if (argument === undefined || !/^'(?:[^']|'')*'$/u.test(argument.trim())) {
              throw new Error("not authorized: SQLITE_AUTH");
            }
          }
        }
        return observed.runtime.batch(requests, label);
      }
    };

    await expect(observeMemoryD1(authorizerRuntime)).resolves.toMatchObject({
      state: "initialized"
    });
    const sql = observed.statements.map((statement) => statement.sql).join("\n");
    expect(sql).toContain("pragma_table_xinfo('projects')");
    expect(sql).toContain("pragma_index_list('session_consolidations')");
    expect(sql).not.toMatch(/pragma_[a-z_]+\(\s*(?:m|il)\.name\s*\)/iu);
  });

  it("accepts only an exact object-free database or exact empty Wrangler history as fresh", async () => {
    await expect(observeMemoryD1(memoryRuntime({}, {
      appliedMigrations: [],
      hasMigrationTable: false
    }).runtime)).resolves.toMatchObject({ state: "fresh", applied_migrations: [] });
    await expect(observeMemoryD1(memoryRuntime({}, {
      appliedMigrations: [],
      hasMigrationTable: true
    }).runtime)).resolves.toMatchObject({ state: "fresh", applied_migrations: [] });
  });

  it.each([
    ["outbox_events"],
    ["workflow_runs"],
    ["session_consolidations"],
    ["projection_snapshots"],
    ["github_sync_dispatches"],
    ["github_sync_dispatch_items"],
    ["github_repository_sync_runs"],
    ["github_credential_sync_lane"]
  ])("counts %s as in-flight and never emits mutation SQL", async (table) => {
    const { runtime, statements } = memoryRuntime({ [table]: 1 });
    await expect(observeMemoryD1(runtime)).resolves.toMatchObject({ inflight: 1 });
    expect(() => statements.forEach(({ sql }) => assertReadOnlyD1Statement(sql))).not.toThrow();
  });

  it("treats ordinary project data as a deployed production instance", async () => {
    const { runtime } = memoryRuntime({ projects: 1 });
    await expect(observeMemoryD1(runtime)).resolves.toMatchObject({
      production_rows: 1,
      inflight: 0
    });
  });

  it("rejects a wrong database or unknown application table instead of calling it fresh", async () => {
    const { runtime } = memoryRuntime({}, {
      appliedMigrations: [],
      schemaObjects: ["table:wrong_database_table"]
    });
    await expect(observeMemoryD1(runtime)).rejects.toThrow(/partial|unknown|column inventory/iu);
  });

  it("rejects a migration-history gap and a residual sequence", async () => {
    const migrations = localMigrationFiles("MEMORY_DB");
    await expect(observeMemoryD1(memoryRuntime({}, {
      appliedMigrations: migrations,
      historyRows: [{ id: 1, name: "0000_unknown.sql", count: 1 }]
    }).runtime)).rejects.toThrow("exact local prefix");
    await expect(observeMemoryD1(memoryRuntime({}, {
      appliedMigrations: [],
      sequenceRows: [{ seq: 1 }]
    }).runtime)).rejects.toThrow("residual sequence");
  });

  it("rejects same-name index-column and foreign-key contract changes", async () => {
    const migrations = localMigrationFiles("MEMORY_DB");
    const indexProbe = schemaProbe("MEMORY_DB", migrations.length);
    const indexedColumn = indexProbe.indexes.find((row) =>
      row.column_name !== null && row.is_key === 1
    );
    if (indexedColumn === undefined) throw new Error("Missing index-column fixture.");
    indexedColumn.column_name = "wrong_contract_column";
    await expect(observeMemoryD1(memoryRuntime({}, {
      appliedMigrations: migrations,
      schemaProbe: indexProbe
    }).runtime)).rejects.toThrow("schema definition");

    const foreignKeyProbe = schemaProbe("MEMORY_DB", migrations.length);
    const foreignKey = foreignKeyProbe.foreignKeys[0];
    if (foreignKey === undefined) throw new Error("Missing foreign-key fixture.");
    foreignKey.on_delete = foreignKey.on_delete === "CASCADE" ? "RESTRICT" : "CASCADE";
    await expect(observeMemoryD1(memoryRuntime({}, {
      appliedMigrations: migrations,
      schemaProbe: foreignKeyProbe
    }).runtime)).rejects.toThrow("schema definition");
  });
});

describe("production maintenance admission", () => {
  it("allows only stable greenfield observations", async () => {
    const observation = greenfieldObservation();
    const cloudflareObserver = vi.fn(async () => observation.cloudflare);
    const d1Observer = vi.fn(async () => observation.d1);
    const wait = vi.fn(async () => undefined);
    const captured = await runMaintenanceAdmission({ cloudflareObserver, d1Observer, wait });
    expect(captured.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    await expect(runMaintenanceAdmission({
      cloudflareObserver,
      d1Observer,
      wait,
      expectedFingerprint: captured.fingerprint
    })).resolves.toMatchObject({ fingerprint: captured.fingerprint });
    expect(cloudflareObserver).toHaveBeenCalledTimes(4);
    expect(d1Observer).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["public ingress", (value: ReturnType<typeof greenfieldObservation>) => {
      value.cloudflare.gateway_ingress.custom_domains.push("memory.example.com");
    }, "PUBLIC_GATEWAY_INGRESS_ACTIVE"],
    ["service binding", (value: ReturnType<typeof greenfieldObservation>) => {
      value.cloudflare.worker_bindings.push({
        script: "caller",
        bindings: [{
          name: "GATEWAY",
          type: "service",
          service: "edgemneme-memory-gateway"
        }]
      });
    }, "INBOUND_GATEWAY_SERVICE_BINDING_ACTIVE"],
    ["target D1 binding", (value: ReturnType<typeof greenfieldObservation>) => {
      value.cloudflare.worker_bindings.push({
        script: "renamed-writer",
        bindings: [{
          name: "DB",
          type: "d1",
          database_id: value.cloudflare.binding_targets.d1_databases.MEMORY_DB
        }]
      });
    }, "TARGET_D1_BINDING_ACTIVE"],
    ["backup R2 binding", (value: ReturnType<typeof greenfieldObservation>) => {
      value.cloudflare.worker_bindings.push({
        script: "backup-reader",
        bindings: [{
          name: "BACKUPS",
          type: "r2_bucket",
          bucket_name: value.cloudflare.binding_targets.backup_r2_bucket
        }]
      });
    }, "BACKUP_R2_BINDING_ACTIVE"],
    ["Cron", (value: ReturnType<typeof greenfieldObservation>) => {
      value.cloudflare.schedules["edgemneme-memory-orchestrator"].push("* * * * *");
    }, "ORCHESTRATOR_CRON_ACTIVE"],
    ["consumer", (value: ReturnType<typeof greenfieldObservation>) => {
      value.cloudflare.queues[0].consumers.push({ script: "edgemneme-memory-orchestrator" });
    }, "QUEUE_CONSUMER_ACTIVE"],
    ["producer", (value: ReturnType<typeof greenfieldObservation>) => {
      value.cloudflare.queues[0].producers.push({ source: "writer" });
    }, "QUEUE_PRODUCER_ACTIVE"],
    ["approximate backlog", (value: ReturnType<typeof greenfieldObservation>) => {
      value.cloudflare.queues[0].metrics.backlog_count = 1;
    }, "QUEUE_APPROXIMATE_BACKLOG_NONZERO"],
    ["active Workflow", (value: ReturnType<typeof greenfieldObservation>) => {
      value.cloudflare.workflows.push({ nonterminal_instances: [{ id: "running" }] });
    }, "NONTERMINAL_WORKFLOW_INSTANCE"],
    ["MEMORY_DB work", (value: ReturnType<typeof greenfieldObservation>) => {
      value.d1.memory.inflight = 1;
    }, "MEMORY_D1_INFLIGHT"]
  ])("blocks %s", (_name, mutate, code) => {
    const observation = greenfieldObservation();
    mutate(observation);
    expect(maintenanceViolationCodes(observation)).toContain(code);
    expect(() => assertMaintenanceReady(observation)).toThrow(code);
  });

  it("uses the explicit missing-fence code for deployed writers or production data", () => {
    const worker = greenfieldObservation();
    worker.cloudflare.core_versions["edgemneme-memory-gateway"] =
      "22222222-2222-4222-8222-222222222222";
    expect(maintenanceViolationCodes(worker)).toContain("MISSING_DURABLE_MAINTENANCE_FENCE");

    const data = greenfieldObservation();
    data.d1.memory.production_rows = 1;
    expect(maintenanceViolationCodes(data)).toEqual(expect.arrayContaining([
      "PRODUCTION_DATA_PRESENT",
      "MISSING_DURABLE_MAINTENANCE_FENCE"
    ]));
  });

  it("fails on drift between observations and against the captured fingerprint", async () => {
    const first = greenfieldObservation();
    const second = greenfieldObservation();
    second.cloudflare.workers.push({ name: "unrelated-worker" });
    const cloudflareObserver = vi.fn()
      .mockResolvedValueOnce(first.cloudflare)
      .mockResolvedValueOnce(second.cloudflare);
    const d1Observer = vi.fn(async () => first.d1);
    await expect(runMaintenanceAdmission({
      cloudflareObserver,
      d1Observer,
      wait: async () => undefined
    })).rejects.toThrow("MAINTENANCE_STATE_DRIFT");

    await expect(runMaintenanceAdmission({
      cloudflareObserver: async () => first.cloudflare,
      d1Observer: async () => first.d1,
      wait: async () => undefined,
      expectedFingerprint: "0".repeat(64)
    })).rejects.toThrow("MAINTENANCE_FINGERPRINT_DRIFT");
  });
});
