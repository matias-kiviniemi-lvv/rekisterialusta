/**
 * Dev/test/offline DbAdapter backed by the built-in node:sqlite module, exposed
 * through the ASYNC seam. This is the ZERO-DEPENDENCY path: no network, no
 * `mssql`, nothing to install — the adapter that runs in the offline AI
 * workspace (Env 1) and in CI. node:sqlite is synchronous; each call is wrapped
 * so the dev path honours the same Promise-based contract as SqlServerAdapter,
 * letting the whole domain layer be written once against one interface.
 *
 * The SQL passed here is the platform's SQLite dialect (chosen via the Dialect
 * builders); translation to T-SQL happens only in SqlServerAdapter. So this
 * file stays as small as the original synchronous adapter — async is the only
 * structural difference, plus boolean→0/1 normalization (node:sqlite has no
 * boolean binding; SQL Server binds BIT natively).
 */

import { DatabaseSync } from "node:sqlite";
import type { Db, DbAdapter, Row, SqlParam } from "./db.ts";

function normalize(params: readonly SqlParam[]): SqlParam[] {
  return params.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
}

class SqliteConn implements Db {
  protected readonly handle: DatabaseSync;

  constructor(handle: DatabaseSync) {
    this.handle = handle;
  }

  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number; lastInsertRowId: bigint }> {
    const stmt = this.handle.prepare(sql);
    const r = stmt.run(...(normalize(params) as never[]));
    return { changes: Number(r.changes), lastInsertRowId: BigInt(r.lastInsertRowid) };
  }

  async all(sql: string, params: SqlParam[] = []): Promise<Row[]> {
    const stmt = this.handle.prepare(sql);
    return stmt.all(...(normalize(params) as never[])) as Row[];
  }

  async get(sql: string, params: SqlParam[] = []): Promise<Row | undefined> {
    const stmt = this.handle.prepare(sql);
    return stmt.get(...(normalize(params) as never[])) as Row | undefined;
  }
}

export class SqliteAdapter extends SqliteConn implements DbAdapter {
  readonly dialect = "sqlite" as const;
  #depth = 0;

  constructor(filename = ":memory:") {
    const handle = new DatabaseSync(filename);
    // Integrity rules belong in the DBMS (D-06).
    handle.exec("PRAGMA foreign_keys = ON;");
    handle.exec("PRAGMA journal_mode = WAL;");
    super(handle);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Savepoints let nested transaction() calls join the outer one safely.
    const name = `sp_${this.#depth}`;
    if (this.#depth === 0) this.handle.exec("BEGIN IMMEDIATE;");
    else this.handle.exec(`SAVEPOINT ${name};`);
    this.#depth++;
    try {
      const result = await fn(this);
      this.#depth--;
      if (this.#depth === 0) this.handle.exec("COMMIT;");
      else this.handle.exec(`RELEASE ${name};`);
      return result;
    } catch (err) {
      this.#depth--;
      if (this.#depth === 0) this.handle.exec("ROLLBACK;");
      else this.handle.exec(`ROLLBACK TO ${name}; RELEASE ${name};`);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.handle.close();
  }
}
