/**
 * Production DbAdapter backed by `mssql` (tedious) — Envs 2 (local SQL Server)
 * and 3 (Azure SQL).
 *
 * OPTIONAL DEPENDENCY, LOADED LAZILY. `mssql` is imported only inside
 * `connect()` via dynamic `import()`, and the type import is `import type`
 * (erased at runtime). Nothing in this module forces `mssql` to be resolved at
 * load time — so importing this file in the offline workspace (Env 1), where
 * `mssql` is not installed, is harmless; only calling `connect()` requires it.
 * The adapter factory (factory.ts) further defers even importing THIS file
 * until SQL Server is actually selected.
 *
 * `mssql`'s ConnectionPool also covers the serverless connection-caching concern
 * (arch §2.2): keep one module-level pool across warm Flex Function invocations
 * and connection setup is amortized — no separate caching data app needed.
 */

import type * as Mssql from "mssql";
import type { Db, DbAdapter, Row, SqlParam } from "./db.ts";
import { convertPlaceholders, stripSqlitePragmas, translateDdl } from "./dialect.ts";

/**
 * How the adapter authenticates to SQL Server. Selected by environment
 * (`src/config/db-config.ts`), not by code:
 *
 *   - `sql`               username/password — local SQL Server (Env 2) and the
 *                         default. This is the only mode with a secret.
 *   - `managed-identity`  passwordless Azure RBAC (Env 3). Uses tedious's
 *                         built-in Managed Service Identity auth — NO extra npm
 *                         dependency (`@azure/identity` is deliberately not
 *                         added). The Azure SQL "user" is an Entra principal
 *                         (the app's managed identity) that has been granted DB
 *                         roles; the platform presents no password.
 *
 * `app-service` targets an Azure App Service / Flex Functions identity (reads
 * the IDENTITY_ENDPOINT/IDENTITY_HEADER injected by the host); `vm` targets the
 * IMDS endpoint. `clientId` is set only for a user-assigned managed identity.
 */
export type SqlServerAuth =
  | { readonly kind: "sql"; readonly user?: string; readonly password?: string }
  | {
      readonly kind: "managed-identity";
      readonly msiType: "app-service" | "vm";
      readonly clientId?: string;
    };

export interface SqlServerConfig {
  readonly server: string;
  readonly database: string;
  /**
   * Authentication descriptor. When omitted, falls back to `sql` auth using the
   * top-level `user`/`password` below — so existing callers keep working.
   */
  readonly auth?: SqlServerAuth;
  /** Back-compat convenience for `sql` auth; ignored when `auth` is set. */
  readonly user?: string;
  readonly password?: string;
  /** Azure SQL requires encryption; keep true in production. */
  readonly encrypt?: boolean;
  /** Local dev with a self-signed cert may need this true. */
  readonly trustServerCertificate?: boolean;
  readonly port?: number;
}

/**
 * Build the `mssql` ConnectionPool config from our target. PURE DATA: it uses
 * only the erased `import type` of mssql, so it neither imports nor requires the
 * `mssql` package at runtime — which is what lets it be unit-tested offline
 * (Env 1, no `mssql` installed) exactly like the dialect T-SQL builders.
 */
export function buildPoolConfig(cfg: SqlServerConfig): Mssql.config {
  const base: Mssql.config = {
    server: cfg.server,
    database: cfg.database,
    port: cfg.port ?? 1433,
    options: {
      encrypt: cfg.encrypt ?? true,
      trustServerCertificate: cfg.trustServerCertificate ?? false,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
  };

  const auth: SqlServerAuth = cfg.auth ?? {
    kind: "sql",
    ...(cfg.user !== undefined ? { user: cfg.user } : {}),
    ...(cfg.password !== undefined ? { password: cfg.password } : {}),
  };

  if (auth.kind === "managed-identity") {
    // Passwordless Azure RBAC: no user/password on the config at all.
    const options = auth.clientId ? { clientId: auth.clientId } : {};
    const authentication: NonNullable<Mssql.config["authentication"]> =
      auth.msiType === "vm"
        ? { type: "azure-active-directory-msi-vm", options }
        : { type: "azure-active-directory-msi-app-service", options };
    return { ...base, authentication };
  }

  // SQL auth (username/password) — modes 1/2 and the default.
  return {
    ...base,
    ...(auth.user !== undefined ? { user: auth.user } : {}),
    ...(auth.password !== undefined ? { password: auth.password } : {}),
  };
}

function toBigInt(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  return BigInt(String(v));
}

class SqlServerConn implements Db {
  protected readonly mssql: typeof Mssql;
  protected readonly makeRequest: () => Mssql.Request;

  constructor(mssql: typeof Mssql, makeRequest: () => Mssql.Request) {
    this.mssql = mssql;
    this.makeRequest = makeRequest;
  }

  #bind(req: Mssql.Request, names: string[], params: readonly SqlParam[]): void {
    const t = this.mssql;
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      const v = params[i] ?? null;
      if (typeof v === "bigint") req.input(name, t.BigInt, v.toString());
      else if (typeof v === "boolean") req.input(name, t.Bit, v);
      else if (v instanceof Uint8Array) req.input(name, t.VarBinary, Buffer.from(v));
      else req.input(name, v);
    }
  }

  #prepare(sql: string): { text: string; names: string[] } | null {
    const stripped = stripSqlitePragmas(sql);
    if (stripped.trim() === "") return null;
    return convertPlaceholders(translateDdl(stripped));
  }

  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number; lastInsertRowId: bigint }> {
    const prepared = this.#prepare(sql);
    if (!prepared) return { changes: 0, lastInsertRowId: 0n };

    // Only plain INSERTs need SCOPE_IDENTITY; MERGE/OUTPUT flow through get()/all().
    const wantsIdentity = /^\s*INSERT\b/i.test(sql) && !/\bOUTPUT\b/i.test(sql);
    const finalSql = wantsIdentity
      ? `${prepared.text}; SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS __lastid;`
      : prepared.text;

    const req = this.makeRequest();
    this.#bind(req, prepared.names, params);
    const res = await req.query(finalSql);

    const changes = (res.rowsAffected ?? []).reduce((a, b) => a + b, 0);
    let lastInsertRowId = 0n;
    if (wantsIdentity) {
      const last = res.recordset?.[0] as { __lastid?: unknown } | undefined;
      lastInsertRowId = toBigInt(last?.__lastid ?? null);
    }
    return { changes, lastInsertRowId };
  }

  async all(sql: string, params: SqlParam[] = []): Promise<Row[]> {
    const prepared = this.#prepare(sql);
    if (!prepared) return [];
    const req = this.makeRequest();
    this.#bind(req, prepared.names, params);
    const res = await req.query(prepared.text);
    return (res.recordset ?? []) as unknown as Row[];
  }

  async get(sql: string, params: SqlParam[] = []): Promise<Row | undefined> {
    const rows = await this.all(sql, params);
    return rows[0];
  }
}

export class SqlServerAdapter extends SqlServerConn implements DbAdapter {
  readonly dialect = "sqlserver" as const;
  readonly #pool: Mssql.ConnectionPool;

  private constructor(mssql: typeof Mssql, pool: Mssql.ConnectionPool) {
    super(mssql, () => pool.request());
    this.#pool = pool;
  }

  /** Connect and return a ready adapter. One pool per process; reuse it. */
  static async connect(cfg: SqlServerConfig): Promise<SqlServerAdapter> {
    const mod = (await import("mssql")) as unknown as { default?: typeof Mssql } & typeof Mssql;
    const mssql = (mod.default ?? mod) as typeof Mssql;
    const pool = new mssql.ConnectionPool(buildPoolConfig(cfg));
    await pool.connect();
    return new SqlServerAdapter(mssql, pool);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Transaction state belongs to this invocation, never to the shared pool
    // adapter. Concurrent HTTP requests therefore cannot join each other's
    // transaction or savepoint chain.
    const transaction = new this.mssql.Transaction(this.#pool);
    await transaction.begin();
    const connection = new SqlServerConn(this.mssql, () => new this.mssql.Request(transaction));
    try {
      const result = await fn(connection);
      await transaction.commit();
      return result;
    } catch (err) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        // A failed DDL statement can make SQL Server abort the transaction
        // before the adapter rolls it back. Keep the original query error—the
        // secondary EABORT otherwise hides the actionable database message.
        if (err instanceof Error) {
          Object.defineProperty(err, "rollbackError", { value: rollbackError, enumerable: false });
        }
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.#pool.close();
  }
}
