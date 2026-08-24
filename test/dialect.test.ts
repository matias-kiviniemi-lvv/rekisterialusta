/**
 * Dialect unit tests — verify the T-SQL the SQL Server dialect emits and the
 * mechanical rewrites, WITHOUT a live database. This is the CI coverage for the
 * SQL Server path on any machine (including the offline workspace).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SqliteDialect,
  SqlServerDialect,
  convertPlaceholders,
  stripSqlitePragmas,
  translateDdl,
} from "../src/db/dialect.ts";

test("identity PK: AUTOINCREMENT vs IDENTITY", () => {
  assert.equal(SqliteDialect.identityPk("case_key"), "case_key INTEGER PRIMARY KEY AUTOINCREMENT");
  assert.equal(SqlServerDialect.identityPk("case_key"), "case_key BIGINT IDENTITY(1,1) PRIMARY KEY");
});

test("column types per dialect", () => {
  assert.equal(SqliteDialect.columnType("boolean"), "INTEGER");
  assert.equal(SqlServerDialect.columnType("boolean"), "BIT");
  assert.equal(SqlServerDialect.columnType("text"), "NVARCHAR(MAX)");
  assert.equal(SqlServerDialect.columnType("decimal"), "DECIMAL(38,10)");
  assert.equal(SqlServerDialect.columnType("date"), "DATE");
});

test("create-if-not-exists and add-column differ", () => {
  assert.equal(
    SqliteDialect.createTableIfNotExists("t", "id TEXT PRIMARY KEY"),
    "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)",
  );
  assert.match(
    SqlServerDialect.createTableIfNotExists("t", "id TEXT PRIMARY KEY"),
    /^IF OBJECT_ID\(N't', N'U'\) IS NULL CREATE TABLE t \(id TEXT PRIMARY KEY\)$/,
  );
  assert.equal(SqliteDialect.addColumn("t", "c INTEGER"), "ALTER TABLE t ADD COLUMN c INTEGER");
  assert.equal(SqlServerDialect.addColumn("t", "c INTEGER"), "ALTER TABLE t ADD c INTEGER");
});

test("upsert (overwrite columns): ON CONFLICT vs MERGE", () => {
  const spec = {
    table: "categories",
    insertColumns: ["category_id", "display_code", "path", "level", "name"],
    conflictColumns: ["category_id"],
    updateColumns: ["display_code", "path", "level", "name"],
  } as const;
  assert.match(SqliteDialect.upsert(spec), /ON CONFLICT \(category_id\) DO UPDATE SET display_code = excluded\.display_code/);
  const t = SqlServerDialect.upsert(spec);
  assert.match(t, /^MERGE categories WITH \(HOLDLOCK\) AS target/);
  assert.match(t, /WHEN MATCHED THEN UPDATE SET display_code = src\.display_code/);
  assert.match(t, /WHEN NOT MATCHED THEN INSERT \(category_id, display_code, path, level, name\) VALUES \(src\.category_id, src\.display_code, src\.path, src\.level, src\.name\);$/);
});

test("upsertReturning (diary counter): RETURNING vs OUTPUT", () => {
  const spec = {
    table: "diary_counters",
    insertColumns: ["registry_id", "year", "last_number"],
    conflictColumns: ["registry_id", "year"],
    updateColumn: "last_number",
    returning: "last_number",
  } as const;
  assert.match(SqliteDialect.upsertReturning(spec), /RETURNING last_number$/);
  assert.match(SqlServerDialect.upsertReturning(spec), /UPDATE SET last_number = target\.last_number \+ 1/);
  assert.match(SqlServerDialect.upsertReturning(spec), /OUTPUT INSERTED\.last_number;$/);
});

test("insertIfAbsent: INSERT OR IGNORE vs WHERE NOT EXISTS", () => {
  assert.equal(
    SqliteDialect.insertIfAbsent("case_handlers", ["case_key", "worker_id", "role"]),
    "INSERT OR IGNORE INTO case_handlers (case_key, worker_id, role) VALUES (?, ?, ?)",
  );
  assert.equal(
    SqlServerDialect.insertIfAbsent("case_handlers", ["case_key", "worker_id", "role"]),
    "INSERT INTO case_handlers (case_key, worker_id, role) SELECT ?, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM case_handlers WHERE case_key = ? AND worker_id = ? AND role = ?)",
  );
});

test("introspection: PRAGMA/sqlite_master vs INFORMATION_SCHEMA", () => {
  assert.equal(SqliteDialect.columnsOf("cases"), "PRAGMA table_info(cases)");
  assert.match(SqlServerDialect.columnsOf("cases"), /INFORMATION_SCHEMA\.COLUMNS WHERE TABLE_NAME = 'cases'/);
  assert.match(SqlServerDialect.tableExists(), /INFORMATION_SCHEMA\.TABLES/);
});

test("limitOne uses LIMIT on SQLite and TOP on SQL Server", () => {
  const query = "SELECT config_json FROM config_versions ORDER BY version DESC";
  assert.equal(SqliteDialect.limitOne(query), `${query} LIMIT 1`);
  assert.equal(
    SqlServerDialect.limitOne(query),
    "SELECT TOP (1) config_json FROM config_versions ORDER BY version DESC",
  );
});

test("convertPlaceholders numbers ?s and skips string literals", () => {
  const { text, names } = convertPlaceholders("INSERT INTO t (a, b) VALUES (?, ?)");
  assert.equal(text, "INSERT INTO t (a, b) VALUES (@p0, @p1)");
  assert.deepEqual(names, ["p0", "p1"]);
  const q = convertPlaceholders("SELECT * FROM t WHERE note = 'why?' AND x = ?");
  assert.equal(q.text, "SELECT * FROM t WHERE note = 'why?' AND x = @p0");
  assert.deepEqual(q.names, ["p0"]);
});

test("stripSqlitePragmas removes connection PRAGMAs only", () => {
  assert.equal(stripSqlitePragmas("PRAGMA foreign_keys = ON;"), "");
  assert.equal(stripSqlitePragmas("PRAGMA journal_mode = WAL;"), "");
  assert.equal(stripSqlitePragmas("SELECT 1"), "SELECT 1");
});

test("translateDdl maps identity + TEXT widths for T-SQL", () => {
  const ddl = `CREATE TABLE cases (
    case_key INTEGER PRIMARY KEY AUTOINCREMENT,
    diary_number TEXT NOT NULL UNIQUE,
    properties TEXT NULL
  )`;
  const t = translateDdl(ddl);
  assert.match(t, /case_key BIGINT IDENTITY\(1,1\) PRIMARY KEY/);
  assert.match(t, /diary_number NVARCHAR\(200\) NOT NULL UNIQUE/); // identifier-ish → bounded
  assert.match(t, /properties NVARCHAR\(MAX\)/); // large/JSON column → MAX
  // Non-DDL statements pass through untouched.
  assert.equal(translateDdl("SELECT * FROM cases WHERE x = ?"), "SELECT * FROM cases WHERE x = ?");
});

test("translateDdl maps inline and ALTER TABLE TEXT columns", () => {
  assert.equal(
    translateDdl("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NULL)"),
    "CREATE TABLE schema_migrations (id NVARCHAR(200) PRIMARY KEY, name NVARCHAR(200) NOT NULL, payload NVARCHAR(MAX) NULL)",
  );
  assert.equal(
    translateDdl("ALTER TABLE cases ADD external_id TEXT NULL"),
    "ALTER TABLE cases ADD external_id NVARCHAR(200) NULL",
  );
  assert.equal(
    translateDdl("CREATE TABLE rules ([trigger] TEXT NOT NULL DEFAULT 'state_change')"),
    "CREATE TABLE rules ([trigger] NVARCHAR(200) NOT NULL DEFAULT 'state_change')",
  );
});
