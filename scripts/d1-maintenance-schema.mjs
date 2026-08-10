import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_DIRECTORIES = Object.freeze({
  MEMORY_DB: "migrations",
  SEARCH_DB: "migrations/search"
});
const EXPECTED_SCHEMAS = new Map();
const MAX_SCHEMA_OBJECTS = 4_096;
const MAX_SCHEMA_DETAILS = 32_768;

export const SCHEMA_PROBE_SQL = Object.freeze({
  objects: `SELECT type, name, tbl_name AS table_name, sql AS definition
    FROM sqlite_master
    WHERE type IN ('index', 'table', 'trigger', 'view') AND sql IS NOT NULL
    ORDER BY type, name LIMIT ${MAX_SCHEMA_OBJECTS + 1}`,
  columns: `SELECT m.name AS table_name, p.cid, p.name AS column_name,
      p.type AS declared_type, p."notnull" AS not_null,
      p.dflt_value AS default_value, p.pk AS primary_key, p.hidden
    FROM sqlite_master AS m JOIN pragma_table_xinfo(m.name) AS p
    WHERE m.type = 'table' AND m.sql IS NOT NULL
    ORDER BY m.name, p.cid LIMIT ${MAX_SCHEMA_DETAILS + 1}`,
  foreignKeys: `SELECT m.name AS table_name, p.id, p.seq,
      p."table" AS referenced_table, p."from" AS from_column,
      p."to" AS to_column, p.on_update, p.on_delete, p.match
    FROM sqlite_master AS m JOIN pragma_foreign_key_list(m.name) AS p
    WHERE m.type = 'table' AND m.sql IS NOT NULL
    ORDER BY m.name, p.id, p.seq LIMIT ${MAX_SCHEMA_DETAILS + 1}`,
  indexes: `SELECT m.name AS table_name, il.name AS index_name,
      il."unique" AS is_unique, il.origin, il.partial,
      ix.seqno, ix.cid, ix.name AS column_name,
      ix.desc AS is_descending, ix.coll AS collation, ix.key AS is_key
    FROM sqlite_master AS m
    JOIN pragma_index_list(m.name) AS il
    JOIN pragma_index_xinfo(il.name) AS ix
    WHERE m.type = 'table' AND m.sql IS NOT NULL
    ORDER BY m.name, il.name, ix.seqno LIMIT ${MAX_SCHEMA_DETAILS + 1}`
});

const D1_MIGRATION_COLUMNS = Object.freeze([
  Object.freeze({
    cid: 0,
    name: "id",
    type: "INTEGER",
    not_null: 0,
    default_value: null,
    primary_key: 1,
    hidden: 0
  }),
  Object.freeze({
    cid: 1,
    name: "name",
    type: "TEXT",
    not_null: 0,
    default_value: null,
    primary_key: 0,
    hidden: 0
  }),
  Object.freeze({
    cid: 2,
    name: "applied_at",
    type: "TIMESTAMP",
    not_null: 1,
    default_value: "CURRENT_TIMESTAMP",
    primary_key: 0,
    hidden: 0
  })
]);

const D1_MIGRATION_INDEXES = Object.freeze([
  Object.freeze({
    seq: 0,
    name: "sqlite_autoindex_d1_migrations_1",
    is_unique: 1,
    origin: "u",
    partial: 0
  })
]);

function migrationDirectory(database) {
  const directory = MIGRATION_DIRECTORIES[database];
  if (directory === undefined) throw new Error("Unknown D1 migration authority.");
  return join(REPOSITORY_ROOT, directory);
}

export function localMigrationFiles(database) {
  const files = readdirSync(migrationDirectory(database), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[0-9]{4}_.+\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (
    files.length === 0 ||
    new Set(files).size !== files.length ||
    files.some((name, index) => Number(name.slice(0, 4)) !== index + 1)
  ) {
    throw new Error(`${database} local migration inventory is invalid.`);
  }
  return files;
}

export function isD1PlatformObject(name) {
  return name.startsWith("sqlite_") ||
    name === "_cf_KV" ||
    name === "_cf_METADATA" ||
    name === "d1_migrations";
}

function exactKeys(row, keys) {
  return row !== null &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...keys].sort());
}

function requireName(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireFlag(value, label) {
  if (value !== 0 && value !== 1) throw new Error(`${label} is invalid.`);
  return value;
}

export function canonicalizeSchemaSql(value, label = "Schema definition") {
  if (typeof value !== "string" || value.trim() === "" || value.length > 1_048_576) {
    throw new Error(`${label} is invalid.`);
  }
  const tokens = [];
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && value[index + 1] === "-") {
      index += 2;
      while (index < value.length && !/[\r\n]/u.test(value[index])) index += 1;
      continue;
    }
    if (character === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      if (end === -1) throw new Error(`${label} contains an unterminated comment.`);
      index = end + 2;
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      let token = character;
      index += 1;
      let closed = false;
      while (index < value.length) {
        token += value[index];
        if (value[index] === character) {
          if (value[index + 1] === character) {
            token += value[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error(`${label} contains an unterminated quoted token.`);
      tokens.push(token);
      continue;
    }
    if (character === "[") {
      const end = value.indexOf("]", index + 1);
      if (end === -1) throw new Error(`${label} contains an unterminated identifier.`);
      tokens.push(value.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/u.test(character)) {
      let end = index + 1;
      while (end < value.length && /[A-Za-z0-9_$]/u.test(value[end])) end += 1;
      tokens.push(value.slice(index, end).toLowerCase());
      index = end;
      continue;
    }
    tokens.push(character);
    index += 1;
  }
  while (tokens.at(-1) === ";") tokens.pop();
  if (tokens.length === 0) throw new Error(`${label} is empty after normalization.`);
  return JSON.stringify(tokens);
}

function normalizeObjects(rows, database) {
  if (!Array.isArray(rows) || rows.length > MAX_SCHEMA_OBJECTS) {
    throw new Error(`${database} schema inventory is invalid or exceeds its bound.`);
  }
  const objects = [];
  const identities = new Set();
  let hasMigrationTable = false;
  for (const row of rows) {
    if (!exactKeys(row, ["type", "name", "table_name", "definition"])) {
      throw new Error(`${database} schema inventory contains an invalid object.`);
    }
    if (!["index", "table", "trigger", "view"].includes(row.type)) {
      throw new Error(`${database} schema inventory contains an unknown object type.`);
    }
    const objectName = requireName(row.name, `${database} schema object name`);
    const tableName = requireName(row.table_name, `${database} schema owner name`);
    const identity = `${row.type}:${objectName}`;
    if (identities.has(identity)) throw new Error(`${database} schema inventory has a duplicate.`);
    identities.add(identity);
    if (row.type === "table" && objectName === "d1_migrations") hasMigrationTable = true;
    if (isD1PlatformObject(objectName)) continue;
    objects.push({
      identity,
      type: row.type,
      name: objectName,
      table_name: tableName,
      definition: canonicalizeSchemaSql(row.definition, `${database} ${identity}`)
    });
  }
  return {
    hasMigrationTable,
    objects: objects.sort((left, right) => left.identity.localeCompare(right.identity))
  };
}

function normalizeColumns(rows, database, tableNames) {
  if (!Array.isArray(rows) || rows.length > MAX_SCHEMA_DETAILS) {
    throw new Error(`${database} column inventory is invalid or exceeds its bound.`);
  }
  const columns = [];
  const identities = new Set();
  for (const row of rows) {
    if (!exactKeys(row, [
      "table_name", "cid", "column_name", "declared_type", "not_null",
      "default_value", "primary_key", "hidden"
    ])) {
      throw new Error(`${database} column inventory contains an invalid row.`);
    }
    const tableName = requireName(row.table_name, `${database} column table`);
    if (isD1PlatformObject(tableName)) continue;
    if (!tableNames.has(tableName)) throw new Error(`${database} columns name an unknown table.`);
    const cid = requireInteger(row.cid, `${database} column ordinal`);
    const identity = `${tableName}\0${cid}`;
    if (identities.has(identity)) throw new Error(`${database} column inventory has a duplicate.`);
    identities.add(identity);
    columns.push({
      table_name: tableName,
      cid,
      column_name: requireName(row.column_name, `${database} column name`),
      declared_type: canonicalizeSchemaSql(row.declared_type || "NONE", "Declared column type"),
      not_null: requireFlag(row.not_null, `${database} not-null flag`),
      default_value: row.default_value === null
        ? null
        : canonicalizeSchemaSql(row.default_value, `${database} column default`),
      primary_key: requireInteger(row.primary_key, `${database} primary-key ordinal`),
      hidden: requireInteger(row.hidden, `${database} hidden-column flag`)
    });
  }
  for (const tableName of tableNames) {
    if (!columns.some((column) => column.table_name === tableName)) {
      throw new Error(`${database} table ${tableName} has no complete column inventory.`);
    }
  }
  return columns.sort((left, right) =>
    left.table_name.localeCompare(right.table_name) || left.cid - right.cid
  );
}

function normalizeForeignKeys(rows, database, tableNames) {
  if (!Array.isArray(rows) || rows.length > MAX_SCHEMA_DETAILS) {
    throw new Error(`${database} foreign-key inventory is invalid or exceeds its bound.`);
  }
  const foreignKeys = [];
  const identities = new Set();
  for (const row of rows) {
    if (!exactKeys(row, [
      "table_name", "id", "seq", "referenced_table", "from_column", "to_column",
      "on_update", "on_delete", "match"
    ])) {
      throw new Error(`${database} foreign-key inventory contains an invalid row.`);
    }
    const tableName = requireName(row.table_name, `${database} foreign-key table`);
    if (isD1PlatformObject(tableName)) continue;
    if (!tableNames.has(tableName)) throw new Error(`${database} foreign key names an unknown table.`);
    const id = requireInteger(row.id, `${database} foreign-key id`);
    const sequence = requireInteger(row.seq, `${database} foreign-key sequence`);
    const identity = `${tableName}\0${id}\0${sequence}`;
    if (identities.has(identity)) throw new Error(`${database} foreign-key inventory has a duplicate.`);
    identities.add(identity);
    foreignKeys.push({
      table_name: tableName,
      id,
      seq: sequence,
      referenced_table: requireName(row.referenced_table, `${database} referenced table`),
      from_column: requireName(row.from_column, `${database} foreign-key source column`),
      to_column: requireName(row.to_column, `${database} foreign-key target column`),
      on_update: requireName(row.on_update, `${database} foreign-key update action`).toLowerCase(),
      on_delete: requireName(row.on_delete, `${database} foreign-key delete action`).toLowerCase(),
      match: requireName(row.match, `${database} foreign-key match`).toLowerCase()
    });
  }
  return foreignKeys.sort((left, right) =>
    left.table_name.localeCompare(right.table_name) || left.id - right.id || left.seq - right.seq
  );
}

function normalizeIndexes(rows, database, tableNames, schemaObjects) {
  if (!Array.isArray(rows) || rows.length > MAX_SCHEMA_DETAILS) {
    throw new Error(`${database} index inventory is invalid or exceeds its bound.`);
  }
  const groups = new Map();
  for (const row of rows) {
    if (!exactKeys(row, [
      "table_name", "index_name", "is_unique", "origin", "partial", "seqno", "cid",
      "column_name", "is_descending", "collation", "is_key"
    ])) {
      throw new Error(`${database} index inventory contains an invalid row.`);
    }
    const tableName = requireName(row.table_name, `${database} index table`);
    if (isD1PlatformObject(tableName)) continue;
    if (!tableNames.has(tableName)) throw new Error(`${database} index names an unknown table.`);
    const indexName = requireName(row.index_name, `${database} index name`);
    const key = `${tableName}\0${indexName}`;
    const metadata = {
      table_name: tableName,
      index_name: indexName.startsWith("sqlite_autoindex_") ? "<auto>" : indexName,
      is_unique: requireFlag(row.is_unique, `${database} unique-index flag`),
      origin: requireName(row.origin, `${database} index origin`).toLowerCase(),
      partial: requireFlag(row.partial, `${database} partial-index flag`)
    };
    const group = groups.get(key) ?? { metadata, columns: [], sequences: new Set() };
    if (JSON.stringify(group.metadata) !== JSON.stringify(metadata)) {
      throw new Error(`${database} index metadata changed within one index.`);
    }
    const seqno = requireInteger(row.seqno, `${database} index-column sequence`);
    if (group.sequences.has(seqno)) throw new Error(`${database} index columns contain a duplicate.`);
    group.sequences.add(seqno);
    group.columns.push({
      seqno,
      cid: requireInteger(row.cid, `${database} indexed-column id`, -2),
      column_name: row.column_name === null
        ? null
        : requireName(row.column_name, `${database} indexed-column name`),
      is_descending: requireFlag(
        row.is_descending,
        `${database} descending-index flag`
      ),
      collation: row.collation === null
        ? null
        : requireName(row.collation, `${database} index collation`).toLowerCase(),
      is_key: requireFlag(row.is_key, `${database} index-key flag`)
    });
    groups.set(key, group);
  }
  const namedSchemaIndexes = new Set(
    schemaObjects.filter(({ type }) => type === "index").map(({ name }) => name)
  );
  const indexes = [];
  for (const [rawKey, group] of groups) {
    const rawName = rawKey.slice(rawKey.indexOf("\0") + 1);
    if (!rawName.startsWith("sqlite_autoindex_") && !namedSchemaIndexes.has(rawName)) {
      throw new Error(`${database} index detail has no matching schema definition.`);
    }
    indexes.push({
      ...group.metadata,
      columns: group.columns.sort((left, right) => left.seqno - right.seqno)
    });
  }
  return indexes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function readReferenceProbe(reference) {
  return {
    objects: reference.prepare(SCHEMA_PROBE_SQL.objects).all(),
    columns: reference.prepare(SCHEMA_PROBE_SQL.columns).all(),
    foreignKeys: reference.prepare(SCHEMA_PROBE_SQL.foreignKeys).all(),
    indexes: reference.prepare(SCHEMA_PROBE_SQL.indexes).all()
  };
}

function copyProbe(probe) {
  return Object.fromEntries(Object.entries(probe).map(([key, rows]) => [
    key,
    rows.map((row) => ({ ...row }))
  ]));
}

export function parseSchemaInventory(probe, database) {
  if (probe === null || typeof probe !== "object" || Array.isArray(probe)) {
    throw new Error(`${database} schema probe is invalid.`);
  }
  const normalizedObjects = normalizeObjects(probe.objects, database);
  const tableNames = new Set(
    normalizedObjects.objects
      .filter(({ type }) => type === "table")
      .map(({ name }) => name)
  );
  const schema = Object.freeze({
    objects: normalizedObjects.objects,
    columns: normalizeColumns(probe.columns, database, tableNames),
    foreign_keys: normalizeForeignKeys(probe.foreignKeys, database, tableNames),
    indexes: normalizeIndexes(probe.indexes, database, tableNames, normalizedObjects.objects)
  });
  return {
    hasMigrationTable: normalizedObjects.hasMigrationTable,
    objects: normalizedObjects.objects.map(({ identity }) => identity),
    schema
  };
}

function expectedSchema(database, migrationCount) {
  const files = localMigrationFiles(database);
  if (
    !Number.isSafeInteger(migrationCount) ||
    migrationCount < 0 ||
    migrationCount > files.length
  ) {
    throw new Error(`${database} migration count is outside the local history.`);
  }
  const cacheKey = `${database}:${migrationCount}`;
  const cached = EXPECTED_SCHEMAS.get(cacheKey);
  if (cached !== undefined) return cached;
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec("PRAGMA foreign_keys = ON;");
    for (const migration of files.slice(0, migrationCount)) {
      reference.exec(readFileSync(join(migrationDirectory(database), migration), "utf8"));
    }
    const probe = readReferenceProbe(reference);
    const parsed = parseSchemaInventory(probe, database);
    const expected = Object.freeze({ probe: copyProbe(probe), parsed });
    EXPECTED_SCHEMAS.set(cacheKey, expected);
    return expected;
  } finally {
    reference.close();
  }
}

export function expectedSchemaObjects(database, migrationCount) {
  return expectedSchema(database, migrationCount).parsed.objects;
}

export function expectedSchemaProbeRows(database, migrationCount) {
  return copyProbe(expectedSchema(database, migrationCount).probe);
}

export function parseMigrationHistory(rows, database) {
  const files = localMigrationFiles(database);
  if (!Array.isArray(rows)) throw new Error(`${database} has an invalid d1_migrations history.`);
  const names = [];
  for (const [index, row] of rows.entries()) {
    if (
      !Number.isSafeInteger(row?.id) ||
      row.id !== index + 1 ||
      !Number.isSafeInteger(row?.count) ||
      row.count !== 1 ||
      typeof row?.name !== "string" ||
      Object.keys(row).length !== 3
    ) {
      throw new Error(`${database} migration history is malformed or duplicated.`);
    }
    names.push(row.name);
  }
  if (names.length > files.length || names.some((name, index) => name !== files[index])) {
    throw new Error(`${database} migration history is not an exact local prefix.`);
  }
  return names;
}

export function assertMigrationTableContract(
  database,
  columns,
  indexes,
  sequenceRows,
  appliedMigrations
) {
  if (
    !Array.isArray(columns) ||
    JSON.stringify(columns) !== JSON.stringify(D1_MIGRATION_COLUMNS) ||
    !Array.isArray(indexes) ||
    JSON.stringify(indexes) !== JSON.stringify(D1_MIGRATION_INDEXES) ||
    !Array.isArray(sequenceRows) ||
    !Array.isArray(appliedMigrations)
  ) {
    throw new Error(`${database} d1_migrations table does not match Wrangler's contract.`);
  }
  if (appliedMigrations.length === 0) {
    if (sequenceRows.length !== 0) {
      throw new Error(`${database} empty migration history has a residual sequence.`);
    }
    return;
  }
  if (
    sequenceRows.length !== 1 ||
    Object.keys(sequenceRows[0]).length !== 1 ||
    !Number.isSafeInteger(sequenceRows[0]?.seq) ||
    sequenceRows[0].seq !== appliedMigrations.length
  ) {
    throw new Error(`${database} migration sequence does not match its exact history.`);
  }
}

export function assertExpectedSchemaInventory(database, migrationCount, observed) {
  const expected = expectedSchema(database, migrationCount).parsed.schema;
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(
      `${database} schema definition is partial, unknown, or does not match its migration history.`
    );
  }
}
