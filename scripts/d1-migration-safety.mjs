#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const BOOKMARK_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const BACKUP_FORMAT = "edgemneme.d1-migration-backup";
const SEARCH_EXPORT_BOUNDARY = "logical-snapshot-required-because-fts5-is-not-exportable";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_SCHEMA_CACHE = new Map();
const OPTIONAL_SEARCH_TABLES = new Set([
  "memory_fts_chunk_ledger",
  "memory_search_projection_deletions",
  "memory_search_projection_write_leases",
  "memory_search_vector_cleanup_receipts",
  "memory_search_vector_cleanup_janitor_state"
]);

const BACKUP_FILES = Object.freeze([
  { name: "memory.sql", mediaType: "application/sql", records: false },
  {
    name: "search-generations.jsonl",
    mediaType: "application/x-ndjson",
    records: true
  },
  { name: "memory-fts.jsonl", mediaType: "application/x-ndjson", records: true },
  {
    name: "memory-projection-heads.jsonl",
    mediaType: "application/x-ndjson",
    records: true
  },
  {
    name: "memory-fts-chunk-ledger.jsonl",
    mediaType: "application/x-ndjson",
    records: true
  },
  {
    name: "memory-search-projection-deletions.jsonl",
    mediaType: "application/x-ndjson",
    records: true
  },
  {
    name: "memory-search-projection-write-leases.jsonl",
    mediaType: "application/x-ndjson",
    records: true
  },
  {
    name: "memory-search-vector-cleanup-receipts.jsonl",
    mediaType: "application/x-ndjson",
    records: true
  },
  {
    name: "memory-search-vector-cleanup-janitor-state.jsonl",
    mediaType: "application/x-ndjson",
    records: true
  }
]);

const DATABASE_MIGRATION_DIRECTORIES = Object.freeze({
  MEMORY_DB: "migrations",
  SEARCH_DB: "migrations/search"
});

export function extractD1PageRows(source) {
  const commands = parseD1CommandOutput(source, "D1 page");
  if (commands.length !== 1 || commands[0]?.success !== true) {
    throw new Error("D1 page output must contain exactly one successful query result.");
  }
  const rows = commands[0].results;
  if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) {
    throw new Error("D1 page output contains an invalid results array.");
  }
  return rows;
}

export function detectSearchTablePresence(source, expectedTable) {
  if (!OPTIONAL_SEARCH_TABLES.has(expectedTable)) {
    throw new Error("Only optional Search projection tables can be probed.");
  }
  const rows = extractD1PageRows(source);
  if (rows.length === 0) {
    return false;
  }
  if (
    rows.length !== 1 ||
    Object.keys(rows[0]).length !== 1 ||
    rows[0].table_name !== expectedTable
  ) {
    throw new Error(`Search table presence output is invalid for ${expectedTable}.`);
  }
  return true;
}

export function buildSearchKeysetPredicate(cursorSource, keyMapSource) {
  const cursor = parseJson(cursorSource, "Search snapshot cursor");
  const keyMap = parseSearchKeyMap(keyMapSource);
  if (!isRecord(cursor) || Object.keys(cursor).length !== keyMap.length) {
    throw new Error("Search snapshot cursor does not match its key map.");
  }
  const columns = [];
  const values = [];
  for (const [resultColumn, databaseColumn] of keyMap) {
    if (!Object.hasOwn(cursor, resultColumn)) {
      throw new Error(`Search snapshot cursor is missing ${resultColumn}.`);
    }
    columns.push(databaseColumn);
    values.push(sqlLiteral(cursor[resultColumn], resultColumn));
  }
  if (columns.length === 1) {
    return `WHERE ${columns[0]} > ${values[0]}`;
  }
  return `WHERE (${columns.join(", ")}) > (${values.join(", ")})`;
}

export function validateSearchSnapshotCountOutput(source, snapshots) {
  const rows = extractD1PageRows(source);
  if (rows.length !== 1) {
    throw new Error("Search snapshot count query must return exactly one row.");
  }
  const expected = {
    search_generations: countJsonLines(
      requireFile(snapshots, "search-generations.jsonl"),
      "search-generations.jsonl"
    ),
    memory_fts: countJsonLines(requireFile(snapshots, "memory-fts.jsonl"), "memory-fts.jsonl"),
    memory_projection_heads: countJsonLines(
      requireFile(snapshots, "memory-projection-heads.jsonl"),
      "memory-projection-heads.jsonl"
    ),
    memory_fts_chunk_ledger: countJsonLines(
      requireFile(snapshots, "memory-fts-chunk-ledger.jsonl"),
      "memory-fts-chunk-ledger.jsonl"
    ),
    memory_search_projection_deletions: countJsonLines(
      requireFile(snapshots, "memory-search-projection-deletions.jsonl"),
      "memory-search-projection-deletions.jsonl"
    ),
    memory_search_projection_write_leases: countJsonLines(
      requireFile(snapshots, "memory-search-projection-write-leases.jsonl"),
      "memory-search-projection-write-leases.jsonl"
    ),
    memory_search_vector_cleanup_receipts: countJsonLines(
      requireFile(snapshots, "memory-search-vector-cleanup-receipts.jsonl"),
      "memory-search-vector-cleanup-receipts.jsonl"
    ),
    memory_search_vector_cleanup_janitor_state: countJsonLines(
      requireFile(snapshots, "memory-search-vector-cleanup-janitor-state.jsonl"),
      "memory-search-vector-cleanup-janitor-state.jsonl"
    )
  };
  for (const [column, expectedCount] of Object.entries(expected)) {
    const actual = rows[0][column];
    if (!Number.isSafeInteger(actual) || actual < 0 || actual !== expectedCount) {
      throw new Error(`Search logical snapshot row count does not match ${column}.`);
    }
  }
}

export function buildBackupManifest(input) {
  const createdAt = requireCanonicalTimestamp(input.createdAt);
  const sourceCommit = requireMatch(input.sourceCommit, COMMIT_PATTERN, "source commit");
  const runId = requireMatch(input.runId, POSITIVE_INTEGER_PATTERN, "workflow run ID");
  const runAttempt = requireMatch(
    input.runAttempt,
    POSITIVE_INTEGER_PATTERN,
    "workflow run attempt"
  );
  const memoryBookmark = requireStableBookmark(
    input.memoryBookmarkBefore,
    input.memoryBookmarkAfter,
    "MEMORY_DB"
  );
  const searchBookmark = requireStableBookmark(
    input.searchBookmarkBefore,
    input.searchBookmarkAfter,
    "SEARCH_DB"
  );
  const files = BACKUP_FILES.map((specification) => {
    const bytes = requireFile(input.files, specification.name);
    if (specification.name === "memory.sql" && bytes.byteLength === 0) {
      throw new Error("The MEMORY_DB SQL export is empty.");
    }
    const descriptor = {
      name: specification.name,
      media_type: specification.mediaType,
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    };
    if (specification.records) {
      descriptor.records = countJsonLines(bytes, specification.name);
    }
    return descriptor;
  });

  return {
    format: BACKUP_FORMAT,
    status: "complete",
    created_at: createdAt,
    source_commit: sourceCommit,
    workflow: { run_id: runId, run_attempt: runAttempt },
    databases: {
      memory: { binding: "MEMORY_DB", bookmark: memoryBookmark },
      search: {
        binding: "SEARCH_DB",
        bookmark: searchBookmark,
        export_boundary: SEARCH_EXPORT_BOUNDARY
      }
    },
    files
  };
}

export function validateBackupManifest(manifest, files) {
  if (!isRecord(manifest) || manifest.format !== BACKUP_FORMAT || manifest.status !== "complete") {
    throw new Error("The D1 migration backup manifest envelope is invalid.");
  }
  requireCanonicalTimestamp(manifest.created_at);
  requireMatch(manifest.source_commit, COMMIT_PATTERN, "source commit");
  if (!isRecord(manifest.workflow)) {
    throw new Error("The D1 migration backup workflow identity is invalid.");
  }
  requireMatch(manifest.workflow.run_id, POSITIVE_INTEGER_PATTERN, "workflow run ID");
  requireMatch(
    manifest.workflow.run_attempt,
    POSITIVE_INTEGER_PATTERN,
    "workflow run attempt"
  );
  validateManifestDatabase(manifest.databases?.memory, "MEMORY_DB");
  validateManifestDatabase(
    manifest.databases?.search,
    "SEARCH_DB",
    SEARCH_EXPORT_BOUNDARY
  );
  if (!Array.isArray(manifest.files) || manifest.files.length !== BACKUP_FILES.length) {
    throw new Error("The D1 migration backup manifest file set is invalid.");
  }
  const descriptors = new Map();
  for (const descriptor of manifest.files) {
    if (!isRecord(descriptor) || typeof descriptor.name !== "string") {
      throw new Error("The D1 migration backup manifest contains an invalid file descriptor.");
    }
    if (descriptors.has(descriptor.name)) {
      throw new Error("The D1 migration backup manifest contains a duplicate file descriptor.");
    }
    descriptors.set(descriptor.name, descriptor);
  }
  for (const specification of BACKUP_FILES) {
    const descriptor = descriptors.get(specification.name);
    const bytes = requireFile(files, specification.name);
    if (
      !isRecord(descriptor) ||
      descriptor.media_type !== specification.mediaType ||
      descriptor.bytes !== bytes.byteLength ||
      descriptor.sha256 !== sha256(bytes)
    ) {
      throw new Error(`Backup size or checksum validation failed for ${specification.name}.`);
    }
    if (
      specification.records &&
      descriptor.records !== countJsonLines(bytes, specification.name)
    ) {
      throw new Error(`Backup row count validation failed for ${specification.name}.`);
    }
  }
}

export function validateD1IntegrityOutput(database, source) {
  requireDatabase(database);
  const commands = parseD1CommandOutput(source, `${database} integrity`);
  if (commands.length !== 2 || commands.some((command) => command?.success !== true)) {
    throw new Error(`${database} integrity output must contain two successful checks.`);
  }
  const quickChecks = commands.filter(
    (command) =>
      Array.isArray(command.results) &&
      command.results.some((row) => isRecord(row) && Object.hasOwn(row, "quick_check"))
  );
  if (
    quickChecks.length !== 1 ||
    quickChecks[0].results.length !== 1 ||
    quickChecks[0].results[0]?.quick_check !== "ok"
  ) {
    throw new Error(`${database} PRAGMA quick_check did not return ok.`);
  }
  const foreignKeyChecks = commands.filter((command) => command !== quickChecks[0]);
  if (foreignKeyChecks.length !== 1 || !Array.isArray(foreignKeyChecks[0].results)) {
    throw new Error(`${database} PRAGMA foreign_key_check output is invalid.`);
  }
  if (foreignKeyChecks[0].results.length !== 0) {
    throw new Error(`${database} PRAGMA foreign_key_check found violations.`);
  }
}

export function validateD1SchemaOutput(database, source) {
  requireDatabase(database);
  const expected = expectedSchemaDefinitions(database);
  const rows = extractD1PageRows(source);
  const observed = new Map();
  for (const row of rows) {
    if (
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw new Error(`${database} returned an invalid schema definition.`);
    }
    if (isInternalSchemaObject(row.name)) {
      continue;
    }
    const identity = `${row.type}:${row.name}`;
    if (observed.has(identity)) {
      throw new Error(`${database} returned a duplicate schema definition for ${identity}.`);
    }
    observed.set(identity, normalizeSchemaSql(row.sql));
  }
  const missing = [...expected.keys()].filter((identity) => !observed.has(identity));
  if (missing.length > 0) {
    throw new Error(`${database} is missing required schema objects: ${missing.join(", ")}.`);
  }
  const mismatched = [...expected.keys()].filter(
    (identity) => observed.get(identity) !== expected.get(identity)
  );
  if (mismatched.length > 0) {
    throw new Error(
      `${database} contains unexpected schema definitions: ${mismatched.join(", ")}.`
    );
  }
  const unexpected = [...observed.keys()].filter((identity) => !expected.has(identity));
  if (unexpected.length > 0) {
    throw new Error(`${database} contains unknown application schema objects: ${unexpected.join(", ")}.`);
  }
}

function expectedSchemaDefinitions(database) {
  const cached = EXPECTED_SCHEMA_CACHE.get(database);
  if (cached !== undefined) {
    return cached;
  }
  const migrationsDirectory = join(REPOSITORY_ROOT, requireDatabase(database));
  const migrationFiles = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[0-9]{4}_.+\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (migrationFiles.length === 0) {
    throw new Error(`${database} has no local reference migrations.`);
  }
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec("PRAGMA foreign_keys = ON;");
    for (const migration of migrationFiles) {
      reference.exec(readFileSync(join(migrationsDirectory, migration), "utf8"));
    }
    const definitions = new Map(
      reference
        .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL")
        .all()
        .filter(
          (row) =>
            typeof row.type === "string" &&
            typeof row.name === "string" &&
            typeof row.sql === "string" &&
            !isInternalSchemaObject(row.name)
        )
        .map((row) => [`${row.type}:${row.name}`, normalizeSchemaSql(row.sql)])
    );
    if (definitions.size === 0) {
      throw new Error(`${database} local migrations produced no application schema objects.`);
    }
    EXPECTED_SCHEMA_CACHE.set(database, definitions);
    return definitions;
  } finally {
    reference.close();
  }
}

function isInternalSchemaObject(name) {
  return (
    name.startsWith("sqlite_") ||
    name === "_cf_KV" ||
    name === "_cf_METADATA" ||
    name === "d1_migrations" ||
    /^memory_fts_(?:config|content|data|docsize|idx)$/u.test(name)
  );
}

function normalizeSchemaSql(sql) {
  let normalized = "";
  let pendingWhitespace = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (/\s/u.test(character)) {
      pendingWhitespace = normalized.length > 0;
      continue;
    }
    if (pendingWhitespace) {
      normalized += " ";
      pendingWhitespace = false;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const terminator = character === "[" ? "]" : character;
      normalized += character;
      for (index += 1; index < sql.length; index += 1) {
        const quotedCharacter = sql[index];
        normalized += quotedCharacter;
        if (quotedCharacter !== terminator) {
          continue;
        }
        if (sql[index + 1] === terminator) {
          normalized += sql[index + 1];
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    normalized += character.toLowerCase();
  }
  return normalized.replace(/;$/u, "");
}

function validateManifestDatabase(database, binding, exportBoundary) {
  if (
    !isRecord(database) ||
    database.binding !== binding ||
    typeof database.bookmark !== "string" ||
    !BOOKMARK_PATTERN.test(database.bookmark)
  ) {
    throw new Error(`The ${binding} backup manifest entry is invalid.`);
  }
  if (exportBoundary !== undefined && database.export_boundary !== exportBoundary) {
    throw new Error(`The ${binding} export boundary is invalid.`);
  }
}

function requireStableBookmark(beforeSource, afterSource, database) {
  const before = parseBookmark(beforeSource, database);
  const after = parseBookmark(afterSource, database);
  if (before !== after) {
    throw new Error(`${database} changed while the backup was captured.`);
  }
  return before;
}

function parseBookmark(source, database) {
  const payload = parseJson(source, `${database} bookmark`);
  if (!isRecord(payload) || typeof payload.bookmark !== "string") {
    throw new Error(`${database} bookmark output is invalid.`);
  }
  if (!BOOKMARK_PATTERN.test(payload.bookmark)) {
    throw new Error(`${database} bookmark has an invalid format.`);
  }
  return payload.bookmark;
}

function parseD1CommandOutput(source, label) {
  const payload = parseJson(source, label);
  if (!Array.isArray(payload) || payload.some((command) => !isRecord(command))) {
    throw new Error(`${label} output must be a JSON array.`);
  }
  return payload;
}

function parseJson(source, label) {
  try {
    return typeof source === "string" || Buffer.isBuffer(source)
      ? JSON.parse(source.toString())
      : source;
  } catch {
    throw new Error(`${label} output is not valid JSON.`);
  }
}

function parseSearchKeyMap(source) {
  const value = parseJson(source, "Search snapshot key map");
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("Search snapshot key map must be a non-empty JSON object.");
  }
  const entries = Object.entries(value);
  for (const [resultColumn, databaseColumn] of entries) {
    if (
      !/^[a-z_][a-z0-9_]*$/u.test(resultColumn) ||
      typeof databaseColumn !== "string" ||
      !/^[a-z_][a-z0-9_]*$/u.test(databaseColumn)
    ) {
      throw new Error("Search snapshot key map contains an invalid SQL identifier.");
    }
  }
  return entries;
}

function sqlLiteral(value, label) {
  if (typeof value === "string") {
    return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
  }
  if (Number.isSafeInteger(value)) {
    return String(value);
  }
  throw new Error(`Search snapshot cursor ${label} must be text or a safe integer.`);
}

function appendKeysetPage(source, outputPath, cursorPath, keyMapSource) {
  const rows = extractD1PageRows(source);
  const keyMap = parseSearchKeyMap(keyMapSource);
  if (rows.length > 0) {
    const lastRow = rows.at(-1);
    const cursor = Object.fromEntries(
      keyMap.map(([resultColumn]) => {
        if (!Object.hasOwn(lastRow, resultColumn)) {
          throw new Error(`Search snapshot row is missing key column ${resultColumn}.`);
        }
        const value = lastRow[resultColumn];
        sqlLiteral(value, resultColumn);
        return [resultColumn, value];
      })
    );
    appendFileSync(outputPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    writeFileSync(cursorPath, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
  }
  return rows.length;
}

function countJsonLines(source, name) {
  const text = toBuffer(source).toString("utf8");
  if (text === "") {
    return 0;
  }
  if (!text.endsWith("\n")) {
    throw new Error(`${name} must end with a newline.`);
  }
  const lines = text.slice(0, -1).split("\n");
  for (const line of lines) {
    const value = parseJson(line, name);
    if (!isRecord(value)) {
      throw new Error(`${name} must contain one JSON object per line.`);
    }
  }
  return lines.length;
}

function requireFile(files, name) {
  if (!isRecord(files) || !Object.hasOwn(files, name)) {
    throw new Error(`Required backup file ${name} is missing.`);
  }
  return toBuffer(files[name]);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    return Buffer.from(value);
  }
  throw new Error("Backup file content must be bytes or text.");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireCanonicalTimestamp(value) {
  if (typeof value !== "string") {
    throw new Error("Backup creation timestamp is invalid.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Backup creation timestamp must be canonical UTC ISO-8601.");
  }
  return value;
}

function requireMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requireDatabase(database) {
  const directory = DATABASE_MIGRATION_DIRECTORIES[database];
  if (directory === undefined) {
    throw new Error("Only MEMORY_DB and SEARCH_DB can be validated.");
  }
  return directory;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readBackupFiles(directory) {
  return Object.fromEntries(
    BACKUP_FILES.map(({ name }) => [name, readFileSync(resolve(directory, name))])
  );
}

function readSearchSnapshotFiles(directory) {
  return Object.fromEntries(
    BACKUP_FILES.filter(({ records }) => records).map(({ name }) => [
      name,
      readFileSync(resolve(directory, name))
    ])
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Required workflow environment ${name} is missing.`);
  }
  return value;
}

function requireArguments(actual, expected, usage) {
  if (actual.length !== expected) {
    throw new Error(`Usage: d1-migration-safety.mjs ${usage}`);
  }
}

function runCli(arguments_) {
  const [command, ...args] = arguments_;
  if (command === "append-page") {
    requireArguments(args, 2, "append-page <input-json> <output-jsonl>");
    const rows = extractD1PageRows(readFileSync(args[0]));
    if (rows.length > 0) {
      appendFileSync(args[1], `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    }
    process.stdout.write(`${rows.length}\n`);
    return;
  }
  if (command === "append-keyset-page") {
    requireArguments(
      args,
      4,
      "append-keyset-page <input-json> <output-jsonl> <cursor-json> <key-map-json>"
    );
    const count = appendKeysetPage(readFileSync(args[0]), args[1], args[2], args[3]);
    process.stdout.write(`${count}\n`);
    return;
  }
  if (command === "keyset-predicate") {
    requireArguments(args, 2, "keyset-predicate <cursor-json> <key-map-json>");
    process.stdout.write(`${buildSearchKeysetPredicate(readFileSync(args[0]), args[1])}\n`);
    return;
  }
  if (command === "detect-search-table") {
    requireArguments(args, 2, "detect-search-table <table-name> <input-json>");
    process.stdout.write(`${detectSearchTablePresence(readFileSync(args[1]), args[0]) ? 1 : 0}\n`);
    return;
  }
  if (command === "validate-search-snapshot") {
    requireArguments(args, 2, "validate-search-snapshot <count-json> <backup-directory>");
    validateSearchSnapshotCountOutput(
      readFileSync(args[0]),
      readSearchSnapshotFiles(args[1])
    );
    return;
  }
  if (command === "create-backup-manifest") {
    requireArguments(args, 2, "create-backup-manifest <backup-directory> <output-json>");
    const directory = args[0];
    const manifest = buildBackupManifest({
      createdAt: requiredEnvironment("EDGEMNEME_D1_BACKUP_CAPTURED_AT"),
      sourceCommit: requiredEnvironment("GITHUB_SHA"),
      runId: requiredEnvironment("GITHUB_RUN_ID"),
      runAttempt: requiredEnvironment("GITHUB_RUN_ATTEMPT"),
      memoryBookmarkBefore: readFileSync(resolve(directory, "memory-bookmark-before.json")),
      memoryBookmarkAfter: readFileSync(resolve(directory, "memory-bookmark.json")),
      searchBookmarkBefore: readFileSync(resolve(directory, "search-bookmark-before.json")),
      searchBookmarkAfter: readFileSync(resolve(directory, "search-bookmark.json")),
      files: readBackupFiles(directory)
    });
    writeFileSync(args[1], `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  if (command === "verify-backup") {
    requireArguments(args, 2, "verify-backup <manifest-json> <backup-directory>");
    validateBackupManifest(JSON.parse(readFileSync(args[0], "utf8")), readBackupFiles(args[1]));
    return;
  }
  if (command === "validate-integrity") {
    requireArguments(args, 2, "validate-integrity <database> <input-json>");
    validateD1IntegrityOutput(args[0], readFileSync(args[1]));
    return;
  }
  if (command === "validate-schema") {
    requireArguments(args, 2, "validate-schema <database> <input-json>");
    validateD1SchemaOutput(args[0], readFileSync(args[1]));
    return;
  }
  throw new Error("Unknown D1 migration safety command.");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "D1 migration safety validation failed."}\n`
    );
    process.exitCode = 1;
  }
}
