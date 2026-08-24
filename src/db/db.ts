/**
 * Database adapter abstraction — the single seam isolating the vendor- and
 * runtime-specific database surface (Decisions D-04, D-11).
 *
 * The seam is ASYNC. That is forced by the driver, not by taste: every
 * production-grade SQL Server client for Node (`mssql`/tedious) is asynchronous
 * because it talks over a socket, and there is no synchronous SQL Server driver.
 * Async is also the correct posture on serverless (Flex Functions) where DB I/O
 * must never block the event loop. The dev/test SQLite path (built-in
 * node:sqlite, synchronous) is wrapped to honour the same async contract, so
 * ONE seam serves both dialects and the domain layer is written once.
 *
 *   - Env 1 (offline AI workspace) / dev / CI:  SqliteAdapter — zero runtime
 *       dependencies, no network, no `mssql`.
 *   - Env 2 (local SQL Server) / Env 3 (Azure): SqlServerAdapter over `mssql`,
 *       loaded lazily so it is never required where it is not installed.
 *
 * The platform core and domain services depend ONLY on this interface.
 */

export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

export interface Row {
  [column: string]: SqlParam;
}

/**
 * A handle usable both for a plain connection and inside a transaction.
 * Domain services accept a Db so the same code runs transactionally or not.
 */
export interface Db {
  /** Run a statement that returns no rows (INSERT/UPDATE/DDL). */
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number; lastInsertRowId: bigint }>;
  /** Run a query returning all rows. */
  all(sql: string, params?: SqlParam[]): Promise<Row[]>;
  /** Run a query returning the first row or undefined. */
  get(sql: string, params?: SqlParam[]): Promise<Row | undefined>;
}

export interface DbAdapter extends Db {
  /**
   * Execute `fn` inside a single transaction. Commits if `fn` resolves,
   * rolls back if it rejects. Compose nested domain work by passing the supplied
   * transaction-scoped `Db`; never start another adapter transaction inside it.
   * The diary-number allocator and state-machine service rely on this boundary.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Close the underlying connection/pool. */
  close(): Promise<void>;
  /** Dialect name — lets call sites obtain the matching SQL builders. */
  readonly dialect: DialectName;
}

export type DialectName = "sqlite" | "sqlserver";
