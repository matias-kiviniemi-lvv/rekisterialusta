/**
 * Adapter factory — the one place that chooses SQLite vs SQL Server.
 *
 * The SQL Server adapter is imported LAZILY (dynamic import) so that selecting
 * SQLite never loads it, and the offline workspace (Env 1) — where `mssql` is
 * not installed — never touches that code path. This is what lets the exact
 * same build run "with and without SQL Server".
 */

import type { DbAdapter } from "./db.ts";
import { SqliteAdapter } from "./sqlite-adapter.ts";
import type { SqlServerConfig } from "./sqlserver-adapter.ts";

export type DbTarget =
  | { readonly dialect: "sqlite"; readonly file?: string }
  | ({ readonly dialect: "sqlserver" } & SqlServerConfig);

export async function createAdapter(target: DbTarget): Promise<DbAdapter> {
  if (target.dialect === "sqlite") {
    return new SqliteAdapter(target.file ?? ":memory:");
  }
  // Lazy: this import (and, inside it, `mssql`) is only reached for SQL Server.
  const { SqlServerAdapter } = await import("./sqlserver-adapter.ts");
  return SqlServerAdapter.connect(target);
}
