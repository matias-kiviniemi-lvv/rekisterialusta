/**
 * SQL Server auth/config unit tests — verify the exact `mssql` ConnectionPool
 * config the adapter builds for each of the three run modes, WITHOUT a live
 * database and WITHOUT importing `mssql`. Same philosophy as dialect.test.ts:
 * `buildPoolConfig` is pure data, so this runs on the offline workspace (Env 1).
 *
 *   Mode 1 (sandbox)          → SQLite; never reaches this code (covered elsewhere).
 *   Mode 2 (local SQL Server) → `sql` auth: username/password, no `authentication`.
 *   Mode 3 (Azure RBAC)       → `managed-identity`: passwordless, MSI authentication.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPoolConfig } from "../src/db/sqlserver-adapter.ts";
import { loadDbConfig } from "../src/config/db-config.ts";

test("mode 2 — sql auth: username/password, no authentication block", () => {
  const cfg = buildPoolConfig({
    server: "localhost",
    database: "registry_shared",
    auth: { kind: "sql", user: "sa", password: "Secret123" },
  });
  assert.equal(cfg.user, "sa");
  assert.equal(cfg.password, "Secret123");
  assert.equal(cfg.authentication, undefined);
  assert.equal(cfg.options?.encrypt, true); // default on
});

test("mode 2 — legacy top-level user/password (no auth field) still works", () => {
  const cfg = buildPoolConfig({
    server: "localhost",
    database: "registry_shared",
    user: "sa",
    password: "Secret123",
    trustServerCertificate: true,
  });
  assert.equal(cfg.user, "sa");
  assert.equal(cfg.password, "Secret123");
  assert.equal(cfg.authentication, undefined);
  assert.equal(cfg.options?.trustServerCertificate, true);
});

test("mode 3 — managed identity (app-service): passwordless MSI auth", () => {
  const cfg = buildPoolConfig({
    server: "myserver.database.windows.net",
    database: "registry_shared",
    auth: { kind: "managed-identity", msiType: "app-service" },
  });
  assert.equal(cfg.user, undefined);
  assert.equal(cfg.password, undefined);
  assert.equal(cfg.authentication?.type, "azure-active-directory-msi-app-service");
  assert.deepEqual(cfg.authentication?.options, {});
  assert.equal(cfg.options?.encrypt, true); // Azure requires encryption
});

test("mode 3 — managed identity (vm) with user-assigned clientId", () => {
  const cfg = buildPoolConfig({
    server: "myserver.database.windows.net",
    database: "registry_shared",
    auth: { kind: "managed-identity", msiType: "vm", clientId: "abc-123" },
  });
  assert.equal(cfg.user, undefined);
  assert.equal(cfg.authentication?.type, "azure-active-directory-msi-vm");
  assert.deepEqual(cfg.authentication?.options, { clientId: "abc-123" });
});

test("loadDbConfig — SQLSERVER_AUTH=managed-identity resolves to passwordless target", () => {
  const saved = { ...process.env };
  try {
    process.env.DB_DIALECT = "sqlserver";
    process.env.SQLSERVER_HOST = "myserver.database.windows.net";
    process.env.SQLSERVER_AUTH = "managed-identity";
    process.env.SQLSERVER_MSI_CLIENT_ID = "abc-123";
    delete process.env.SQLSERVER_USER;
    delete process.env.SQLSERVER_PASSWORD;

    const target = loadDbConfig().sharedTarget();
    assert.equal(target.dialect, "sqlserver");
    assert.ok(target.dialect === "sqlserver");
    assert.equal(target.auth?.kind, "managed-identity");
    assert.equal(target.user, undefined);
    assert.equal(target.password, undefined);
    // The built pool config is passwordless with MSI auth; default type is app-service.
    const pool = buildPoolConfig(target);
    assert.equal(pool.authentication?.type, "azure-active-directory-msi-app-service");
    assert.deepEqual(pool.authentication?.options, { clientId: "abc-123" });
    assert.equal(pool.password, undefined);
  } finally {
    process.env = saved;
  }
});

test("loadDbConfig — default SQLSERVER_AUTH is sql (username/password)", () => {
  const saved = { ...process.env };
  try {
    process.env.DB_DIALECT = "sqlserver";
    process.env.SQLSERVER_HOST = "localhost";
    process.env.SQLSERVER_USER = "sa";
    process.env.SQLSERVER_PASSWORD = "Secret123";
    delete process.env.SQLSERVER_AUTH;

    const target = loadDbConfig().sharedTarget();
    assert.ok(target.dialect === "sqlserver");
    assert.equal(target.auth?.kind, "sql");
  } finally {
    process.env = saved;
  }
});
