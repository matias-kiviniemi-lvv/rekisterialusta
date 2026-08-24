/**
 * Dialect layer — the ONE place SQLite and SQL Server differences live.
 *
 * Two kinds of difference, handled two ways:
 *
 *  1. STRUCTURAL differences that call sites must author deliberately (identity
 *     columns, upserts, insert-if-absent, RETURNING, schema introspection,
 *     add-column, create-if-not-exists). These are NOT string-rewritten at
 *     runtime — call sites use the `Dialect` builders, chosen from the active
 *     adapter's `dialect`. There are only a handful of such sites.
 *
 *  2. MECHANICAL rewrites the adapter applies transparently: `?`→`@pN`
 *     parameter markers, stripping connection PRAGMAs, and translating the
 *     raw fixed-schema DDL type keywords (`TEXT`, identity) for T-SQL.
 *
 * All builders emit `?` positional placeholders regardless of dialect; the
 * SQL Server adapter converts `?`→`@pN`. So call sites stay placeholder-agnostic.
 *
 * NOTE ON DDL TYPE WIDTHS: `translateDdl` maps SQLite `TEXT` to `NVARCHAR`. The
 * width heuristic (identifiers → NVARCHAR(200); known large/JSON columns →
 * NVARCHAR(MAX)) is a sensible first cut but is the one thing that MUST be
 * validated against a live SQL Server (index key-length limits, exact widths).
 * See ENVIRONMENTS.md.
 */

import type { DialectName } from "./db.ts";

export type FieldType = "text" | "integer" | "decimal" | "date" | "boolean";

/** Upsert that overwrites a set of columns on key conflict (no returned row). */
export interface UpsertSpec {
  readonly table: string;
  readonly insertColumns: readonly string[];
  readonly conflictColumns: readonly string[];
  /** Columns to overwrite with the incoming values when the key already exists. */
  readonly updateColumns: readonly string[];
}

/** Upsert that increments/sets via a raw expression and returns one column. */
export interface UpsertReturningSpec {
  readonly table: string;
  readonly insertColumns: readonly string[];
  readonly conflictColumns: readonly string[];
  /** Existing numeric column to increment atomically when the row exists. */
  readonly updateColumn: string;
  readonly returning: string;
}

export interface Dialect {
  readonly name: DialectName;

  /** DDL fragment for a 64-bit auto-incrementing primary key column. */
  identityPk(column: string): string;

  /** Neutral registry field type → concrete column type. */
  columnType(t: FieldType): string;

  /** `CREATE TABLE IF NOT EXISTS name (body)` equivalent. */
  createTableIfNotExists(name: string, body: string): string;

  /** `ALTER TABLE table ADD [COLUMN] columnDef`. */
  addColumn(table: string, columnDef: string): string;

  /** Upsert overwriting `updateColumns` on conflict. */
  upsert(spec: UpsertSpec): string;

  /** Increment-or-insert returning one column (diary counter primitive). */
  upsertReturning(spec: UpsertReturningSpec): string;

  /** Insert that silently does nothing if an identical row already exists. */
  insertIfAbsent(table: string, columns: readonly string[]): string;

  /** Query returning one row per column of `table`, each aliased as `name`. */
  columnsOf(table: string): string;

  /** Query returning a single row `{ ok: 1 }` iff a table (param) exists. */
  tableExists(): string;

  /** Restrict a SELECT to its first row. */
  limitOne(query: string): string;
}

// ---------------------------------------------------------------------------
// SQLite — matches the foundation's existing SQL verbatim.
// ---------------------------------------------------------------------------

export const SqliteDialect: Dialect = {
  name: "sqlite",

  identityPk: (c) => `${c} INTEGER PRIMARY KEY AUTOINCREMENT`,

  columnType(t) {
    switch (t) {
      case "text": return "TEXT";
      case "integer": return "INTEGER";
      case "decimal": return "REAL";
      case "date": return "TEXT";
      case "boolean": return "INTEGER";
    }
  },

  createTableIfNotExists: (name, body) => `CREATE TABLE IF NOT EXISTS ${name} (${body})`,

  addColumn: (table, def) => `ALTER TABLE ${table} ADD COLUMN ${def}`,

  upsert(spec) {
    const cols = spec.insertColumns.join(", ");
    const vals = spec.insertColumns.map(() => "?").join(", ");
    const keys = spec.conflictColumns.join(", ");
    const set = spec.updateColumns.map((c) => `${c} = excluded.${c}`).join(", ");
    return `INSERT INTO ${spec.table} (${cols}) VALUES (${vals}) ON CONFLICT (${keys}) DO UPDATE SET ${set}`;
  },

  upsertReturning(spec) {
    const cols = spec.insertColumns.join(", ");
    const vals = spec.insertColumns.map(() => "?").join(", ");
    const keys = spec.conflictColumns.join(", ");
    return `INSERT INTO ${spec.table} (${cols}) VALUES (${vals}) ` +
      `ON CONFLICT (${keys}) DO UPDATE SET ${spec.updateColumn} = ${spec.updateColumn} + 1 ` +
      `RETURNING ${spec.returning}`;
  },

  insertIfAbsent(table, columns) {
    const cols = columns.join(", ");
    const vals = columns.map(() => "?").join(", ");
    return `INSERT OR IGNORE INTO ${table} (${cols}) VALUES (${vals})`;
  },

  columnsOf: (table) => `PRAGMA table_info(${table})`,

  tableExists: () => `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,

  limitOne: (query) => `${query} LIMIT 1`,
};

// ---------------------------------------------------------------------------
// SQL Server (T-SQL).
// ---------------------------------------------------------------------------

export const SqlServerDialect: Dialect = {
  name: "sqlserver",

  identityPk: (c) => `${c} BIGINT IDENTITY(1,1) PRIMARY KEY`,

  columnType(t) {
    switch (t) {
      case "text": return "NVARCHAR(MAX)";
      case "integer": return "BIGINT";
      case "decimal": return "DECIMAL(38,10)";
      case "date": return "DATE";
      case "boolean": return "BIT";
    }
  },

  createTableIfNotExists: (name, body) =>
    `IF OBJECT_ID(N'${name}', N'U') IS NULL CREATE TABLE ${name} (${body})`,

  addColumn: (table, def) => `ALTER TABLE ${table} ADD ${def}`,

  upsert(spec) {
    const srcVals = spec.insertColumns.map(() => "?").join(", ");
    const srcCols = spec.insertColumns.join(", ");
    const on = spec.conflictColumns.map((c) => `target.${c} = src.${c}`).join(" AND ");
    const set = spec.updateColumns.map((c) => `${c} = src.${c}`).join(", ");
    const insVals = spec.insertColumns.map((c) => `src.${c}`).join(", ");
    return (
      `MERGE ${spec.table} WITH (HOLDLOCK) AS target ` +
      `USING (VALUES (${srcVals})) AS src (${srcCols}) ON ${on} ` +
      `WHEN MATCHED THEN UPDATE SET ${set} ` +
      `WHEN NOT MATCHED THEN INSERT (${srcCols}) VALUES (${insVals});`
    );
  },

  upsertReturning(spec) {
    const srcVals = spec.insertColumns.map(() => "?").join(", ");
    const srcCols = spec.insertColumns.join(", ");
    const on = spec.conflictColumns.map((c) => `target.${c} = src.${c}`).join(" AND ");
    const insVals = spec.insertColumns.map((c) => `src.${c}`).join(", ");
    return (
      `MERGE ${spec.table} WITH (HOLDLOCK) AS target ` +
      `USING (VALUES (${srcVals})) AS src (${srcCols}) ON ${on} ` +
      `WHEN MATCHED THEN UPDATE SET ${spec.updateColumn} = target.${spec.updateColumn} + 1 ` +
      `WHEN NOT MATCHED THEN INSERT (${srcCols}) VALUES (${insVals}) ` +
      `OUTPUT INSERTED.${spec.returning};`
    );
  },

  insertIfAbsent(table, columns) {
    const cols = columns.join(", ");
    const vals = columns.map(() => "?").join(", ");
    const match = columns.map((c) => `${c} = ?`).join(" AND ");
    return (
      `INSERT INTO ${table} (${cols}) SELECT ${vals} ` +
      `WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${match})`
    );
  },

  columnsOf: (table) =>
    `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`,

  tableExists: () =>
    `SELECT 1 AS ok FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = ?`,

  limitOne: (query) => query.replace(/^(\s*SELECT)\b/i, "$1 TOP (1)"),
};

export function dialectFor(name: DialectName): Dialect {
  return name === "sqlite" ? SqliteDialect : SqlServerDialect;
}

// ---------------------------------------------------------------------------
// Mechanical rewrites (applied transparently by the SQL Server adapter).
// ---------------------------------------------------------------------------

/**
 * Convert `?` positional placeholders to `@p0, @p1, …`, ignoring `?` inside
 * single-quoted string literals. Returns rewritten SQL + ordered param names.
 */
export function convertPlaceholders(sql: string): { text: string; names: string[] } {
  let out = "";
  let i = 0;
  let n = 0;
  const names: string[] = [];
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") { out += "''"; i += 2; continue; }
      inString = !inString;
      out += ch;
      i++;
      continue;
    }
    if (ch === "?" && !inString) {
      const name = `p${n++}`;
      names.push(name);
      out += `@${name}`;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, names };
}

/** Connection PRAGMAs with no T-SQL analogue — dropped on SQL Server. */
export function stripSqlitePragmas(sql: string): string {
  return /^\s*PRAGMA\s+(foreign_keys|journal_mode)/i.test(sql) ? "" : sql;
}

/**
 * Columns whose SQLite `TEXT` holds large/JSON content → NVARCHAR(MAX); all
 * other TEXT → NVARCHAR(200) so composite keys and indexes stay within the
 * 900-byte clustered-index limit (two identifiers plus a BIGINT use 808 bytes).
 * This list is the provisional heuristic that live SQL Server validation
 * should confirm.
 */
const LARGE_TEXT_COLUMNS = new Set([
  "properties", "comment", "payload", "config_json", "property_schema",
  "action_params", "field_subset", "resources", "methods", "condition",
]);

/**
 * Translate the raw fixed-schema DDL (migrations 0001/0003 author big CREATE
 * TABLE blocks in SQLite dialect) to T-SQL. Handles identity, TEXT widths, and
 * the AUTOINCREMENT keyword. CREATE-IF-NOT-EXISTS / ADD COLUMN are produced by
 * the builders above, not here.
 */
export function translateDdl(sql: string): string {
  if (!/\b(CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(sql)) return sql;
  let out = sql;
  // Identity PK: SQLite's "INTEGER PRIMARY KEY AUTOINCREMENT" → IDENTITY.
  out = out.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "BIGINT IDENTITY(1,1) PRIMARY KEY");
  // Per-column TEXT → NVARCHAR(width) using the large-column heuristic.
  // Column definitions may be multiline, inline after `(` or `,`, or supplied
  // to ALTER TABLE ... ADD. Preserve that prefix while replacing the type.
  out = out.replace(/(^\s*|[,(]\s*|\bADD\s+)(\[?)([A-Za-z_][A-Za-z0-9_]*)(\]?)\s+TEXT\b/gim, (_m, prefix: string, open: string, col: string, close: string) => {
    const width = LARGE_TEXT_COLUMNS.has(col.toLowerCase()) ? "MAX" : "200";
    return `${prefix}${open}${col}${close} NVARCHAR(${width})`;
  });
  return out;
}
