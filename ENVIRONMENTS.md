# Running in three environments (with and without SQL Server)

The platform runs the same code on three targets. The database is the only thing
that changes, and it changes by **configuration**, not by editing code. This is
possible because every driver call goes through the async `DbAdapter` seam
(`src/db/db.ts`), the adapter is chosen by a factory (`src/db/factory.ts`), and
SQL dialect differences live in one place (`src/db/dialect.ts`).

## The three environments

| # | Environment | How it's selected | Dependencies |
|---|-------------|-------------------|--------------|
| 1 | Offline AI workspace / CI / dev | `DB_DIALECT` unset (or `sqlite`), no `DB_DIR` → in-memory SQLite | **none** (built-in `node:sqlite`) |
| 2 | Local SQL Server | `DB_DIALECT=sqlserver`, `SQLSERVER_HOST=localhost` | `mssql` (optional dep) |
| 3 | Azure SQL (RBAC) | `DB_DIALECT=sqlserver`, `SQLSERVER_AUTH=managed-identity`, Azure host | `mssql` (optional dep) — passwordless, no extra dep |

### Env 1 — offline, zero dependency (the important one)

`mssql` is an **optional** dependency and is **loaded lazily** — the factory only
imports the SQL Server adapter when `DB_DIALECT=sqlserver`, and that adapter only
`import()`s `mssql` inside `connect()`. So in an offline workspace where `mssql`
is not installed, nothing in the SQLite path ever touches it.

```bash
npm ci --omit=optional        # installs TypeScript/types; skips only optional mssql
node --version                # must be >= 22.6; node:sqlite is built into Node
npm test                      # always uses isolated, in-memory SQLite databases
npm run typecheck
npm run demo                  # end-to-end walkthrough on in-memory SQLite
```

Verified: with `node_modules/mssql` removed entirely, `bootstrapFromEnv()` builds
the platform, creates cases, and serves reads — because the SQLite path never
imports `mssql`.

### Env 2 — local SQL Server

```bash
npm ci                        # installs the optional mssql dependency
export DB_DIALECT=sqlserver
export SQLSERVER_HOST=localhost
export SQLSERVER_USER=sa
export SQLSERVER_PASSWORD='Your_password123'
export SQLSERVER_TRUST_CERT=true   # local self-signed cert
# Each registry maps to its own database; create them first (operational step):
#   CREATE DATABASE registry_shared; CREATE DATABASE registry_pool_a_permit; ...
node --experimental-strip-types -e "import('./src/bootstrap.ts').then(m=>m.bootstrapFromEnv(m.fixedClock(new Date().toISOString())))"
```

The current `npm test` suite deliberately constructs in-memory SQLite adapters;
setting `DB_DIALECT=sqlserver` does **not** redirect those unit and service tests.
To smoke-test a live SQL Server, create the shared and registry databases, set
the variables above, and run the bootstrap command. It connects, applies every
migration, applies the sample configuration, and fails with a non-zero exit if
bootstrap fails. The dialect/configuration tests can be run without a server:

```bash
node --test --experimental-strip-types \
  test/dialect.test.ts test/sqlserver-config.test.ts test/sqlserver-migration-ddl.test.ts
```

### Env 3 — Azure SQL with RBAC (passwordless, managed identity)

The Azure environment authenticates with a **managed identity** (Entra ID /
RBAC) — no username, no password, no secret in config. The app's identity is
created as a user in each Azure SQL database and granted DB roles; that grant is
an operational step (like `CREATE DATABASE`), not part of migrations:

```sql
-- once per database, run as an Entra admin:
CREATE USER [my-app-identity] FROM EXTERNAL PROVIDER;
ALTER ROLE db_datareader ADD MEMBER [my-app-identity];
ALTER ROLE db_datawriter ADD MEMBER [my-app-identity];
ALTER ROLE db_ddladmin  ADD MEMBER [my-app-identity];  -- migrations create/alter tables
```

```bash
export DB_DIALECT=sqlserver
export SQLSERVER_HOST=yourserver.database.windows.net
export SQLSERVER_AUTH=managed-identity    # passwordless RBAC (aliases: msi, rbac)
export SQLSERVER_MSI_TYPE=app-service      # App Service / Flex Functions host (default); use `vm` for IMDS
# export SQLSERVER_MSI_CLIENT_ID=<guid>    # ONLY for a user-assigned identity
export SQLSERVER_ENCRYPT=true              # required for Azure SQL (default)
```

This uses tedious's built-in Managed Service Identity auth — **no new npm
dependency**: `@azure/identity` is deliberately not added; MSI support ships
inside the already-optional `mssql`. So Env 1 stays zero-dependency.

> Local dev against Azure with your own Entra account instead of user/password
> is out of scope here (it would need `@azure/identity`); use Env 2
> (username/password) for local work, and the managed identity in Azure.

Env vars (all read in `src/config/db-config.ts`): `DB_DIALECT`, `DB_DIR`,
`SQLSERVER_HOST`, `SQLSERVER_PORT`, `SQLSERVER_AUTH`, `SQLSERVER_USER`,
`SQLSERVER_PASSWORD`, `SQLSERVER_MSI_TYPE`, `SQLSERVER_MSI_CLIENT_ID`,
`SQLSERVER_ENCRYPT`, `SQLSERVER_TRUST_CERT`, `SQLSERVER_SHARED_DB`,
`SQLSERVER_DB_PREFIX`.

**Auth mode** is selected by `SQLSERVER_AUTH`: unset/`sql` → username/password
(Envs 2, and Env 3 if you really want a SQL login); `managed-identity` (or `msi`
/ `rbac`) → passwordless RBAC. The mapping to the `mssql` config lives in
`buildPoolConfig` (`src/db/sqlserver-adapter.ts`) and is unit-tested offline in
`test/sqlserver-config.test.ts` (no live DB).

## What changed to make this work

1. **The DB seam is async** (`Db.run/all/get` return Promises; `transaction`
   takes an async callback). Forced by `mssql` being async; also correct for
   serverless. The whole domain/service/api/test layer was converted (122 call
   sites) and the existing behavior suite stays green.
2. **`mssql` is optional + lazy** — Env 1 never installs or imports it.
3. **Dialect divergences are centralized** in `src/db/dialect.ts`: identity
   columns, upserts (`ON CONFLICT`↔`MERGE`), insert-if-absent, `RETURNING`↔
   `OUTPUT`, introspection (`PRAGMA`/`sqlite_master`↔`INFORMATION_SCHEMA`),
   add-column, create-if-not-exists, `?`→`@pN`, boolean 0/1↔`BIT`.

## Status and the one open item

- `tsc --noEmit`: clean (SQL Server adapter included).
- Tests: **73/73**, including SQLite behavior/security regressions and offline
  dialect tests asserting the emitted T-SQL with no database.
- Env 1 offline path: verified end-to-end with `mssql` absent.

**Open item — validate the SQL Server path against a live instance.** The SQL
Server adapter is compile-verified and its emitted T-SQL is unit-verified, but it
has not yet run against a real SQL Server (this workspace can't host one). The
one place that specifically needs a live check is the **DDL type widths** in
`translateDdl` (`src/db/dialect.ts`): SQLite `TEXT` is mapped to `NVARCHAR(200)`
for identifier-ish columns and `NVARCHAR(MAX)` for known large/JSON columns. That
heuristic keeps keys/indexes within SQL Server's key-length limits, but the exact
widths per column should be confirmed against a running database (local `mssql`
in Docker, or an Azure SQL dev DB). Everything else — migrations, upserts,
transactions, identity — is designed to run unchanged; only the emitted SQL
differs by dialect.
