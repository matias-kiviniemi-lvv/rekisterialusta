/**
 * Environment-driven database configuration — resolves the three deployment
 * environments to concrete adapter targets, WITHOUT any code change:
 *
 *   Env 1  offline AI workspace / CI   DB_DIALECT unset or "sqlite", no DB_DIR
 *                                      → in-memory SQLite, zero dependencies.
 *   Env 2  local SQL Server            DB_DIALECT=sqlserver, SQLSERVER_HOST=localhost
 *   Env 3  Azure SQL                   DB_DIALECT=sqlserver, SQLSERVER_HOST=*.database.windows.net
 *
 * A registry maps to its own database (D-04). For SQLite that is a file (or
 * :memory:); for SQL Server it is a database name on the server. The registry's
 * `database` placement key (e.g. "pool-a/permit") is sanitized into that name.
 */

import type { DbTarget } from "../db/factory.ts";
import type { DialectName } from "../db/db.ts";
import type { SqlServerAuth } from "../db/sqlserver-adapter.ts";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, "_");
}

export interface DbConfig {
  readonly dialect: DialectName;
  /** Target for the shared master/config database. */
  sharedTarget(): DbTarget;
  /** Target for a registry's own database, from its placement key. */
  registryTarget(databaseKey: string): DbTarget;
}

export function loadDbConfig(): DbConfig {
  const dialect: DialectName = env("DB_DIALECT") === "sqlserver" ? "sqlserver" : "sqlite";

  if (dialect === "sqlite") {
    const dir = env("DB_DIR"); // unset → in-memory (Env 1 default)
    const mk = (name: string): DbTarget =>
      dir ? { dialect: "sqlite", file: `${dir}/${sanitize(name)}.sqlite` } : { dialect: "sqlite" };
    return { dialect, sharedTarget: () => mk("shared"), registryTarget: (key) => mk(key) };
  }

  // Auth mode selects between Env 2 (username/password) and Env 3 (passwordless
  // Azure RBAC via managed identity). Default is `sql` for back-compat.
  const authEnv = (env("SQLSERVER_AUTH") ?? "sql").toLowerCase();
  const isManagedIdentity =
    authEnv === "managed-identity" || authEnv === "msi" || authEnv === "rbac";

  let auth: SqlServerAuth;
  if (isManagedIdentity) {
    const msiType = env("SQLSERVER_MSI_TYPE") === "vm" ? "vm" : "app-service"; // Flex Functions → app-service
    const clientId = env("SQLSERVER_MSI_CLIENT_ID"); // set only for a user-assigned identity
    auth = { kind: "managed-identity", msiType, ...(clientId !== undefined ? { clientId } : {}) };
  } else {
    const user = env("SQLSERVER_USER");
    const password = env("SQLSERVER_PASSWORD");
    auth = {
      kind: "sql",
      ...(user !== undefined ? { user } : {}),
      ...(password !== undefined ? { password } : {}),
    };
  }

  const base = {
    dialect: "sqlserver" as const,
    server: env("SQLSERVER_HOST") ?? "localhost",
    port: env("SQLSERVER_PORT") ? Number(env("SQLSERVER_PORT")) : 1433,
    encrypt: env("SQLSERVER_ENCRYPT") !== "false", // Azure requires; default on
    trustServerCertificate: env("SQLSERVER_TRUST_CERT") === "true", // local self-signed
    auth,
  };
  const sharedDb = env("SQLSERVER_SHARED_DB") ?? "registry_shared";
  const prefix = env("SQLSERVER_DB_PREFIX") ?? "registry_";
  return {
    dialect,
    sharedTarget: () => ({ ...base, database: sharedDb }),
    registryTarget: (key) => ({ ...base, database: prefix + sanitize(key) }),
  };
}
