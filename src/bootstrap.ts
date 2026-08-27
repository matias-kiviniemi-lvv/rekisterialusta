/**
 * Compose root — build a fully-migrated, seeded, MULTI-REGISTRY Platform from
 * declarative config. Each registry gets its OWN database (the production
 * multi-database model, D-04); the shared database holds master data + config.
 * Shared by the demos, the HTTP server, and the tests, so there is one wiring.
 *
 * Two entry points:
 *   - buildSamplePlatform: in-memory SQLite, fresh per call — used by tests and
 *     quick demos. Zero dependencies, no env needed (Env 1 friendly).
 *   - bootstrapFromEnv: resolves adapters from environment config via the
 *     factory, so the SAME code runs on in-memory SQLite (Env 1), a local SQL
 *     Server (Env 2), or Azure SQL (Env 3) with no code change.
 */

import type { DbAdapter } from "./db/db.ts";
import { SqliteAdapter } from "./db/sqlite-adapter.ts";
import { createAdapter, type DbTarget } from "./db/factory.ts";
import { loadDbConfig } from "./config/db-config.ts";
import { migrate } from "./migrations/runner.ts";
import { m0001 } from "./migrations/0001_shared_schema.ts";
import { m0003 } from "./migrations/0003_api_forms_rules.ts";
import { m0005 } from "./migrations/0005_admin_exports.ts";
import { m0006Shared } from "./migrations/0006_localized_metadata.ts";
import { Platform, type Clock } from "./api/platform.ts";
import { StubIdentityProvider, type IdentityProvider } from "./auth/identity.ts";
import { MemoryBlobStore, type BlobStore } from "./blob/blob.ts";
import { applyPlatformConfig, applyRegistryConfig } from "./services/config-apply.ts";
import { PLATFORM_CONFIG, ALL_REGISTRIES } from "./config/platform-config.ts";
import { createLogger, type Logger } from "./logging/logger.ts";

export function fixedClock(now: string): Clock {
  return { now: () => now };
}

export interface SamplePlatform {
  platform: Platform;
  shared: DbAdapter;
  /** The Permit registry DB (kept for tests that predate the Grant registry). */
  db: DbAdapter;
  dbs: Record<string, DbAdapter>;
}

/** @deprecated Prefer the application-wide Logger name. */
export type BootstrapLogger = Logger;

export interface RuntimeAdapters {
  /** Required in production; the development token parser is intentionally fail-closed there. */
  readonly identity?: IdentityProvider;
  /** Required in production; attachments must not silently use process memory. */
  readonly blobs?: BlobStore;
  readonly environment?: "development" | "test" | "production";
}

const defaultBootstrapLogger = createLogger();

function describeTarget(target: DbTarget): string {
  if (target.dialect === "sqlite") return target.file ?? ":memory:";
  const auth = target.auth?.kind ?? "sql";
  return `${target.server}:${target.port ?? 1433}/${target.database} (auth=${auth})`;
}

async function bootstrapStep<T>(logger: BootstrapLogger, label: string, fn: () => Promise<T>): Promise<T> {
  logger.info(`[bootstrap] ${label}...`);
  try {
    const result = await fn();
    logger.info(`[bootstrap] ${label}: done`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[bootstrap] ${label}: FAILED — ${message}`);
    throw error;
  }
}

/**
 * Build a platform on FRESH in-memory SQLite (zero dependencies). Used by tests
 * and demos; deterministic and isolated per call.
 */
export async function buildSamplePlatform(clock: Clock): Promise<SamplePlatform> {
  const shared = new SqliteAdapter(":memory:");
  await migrate(shared, [m0001, m0003, m0005, m0006Shared], clock.now());
  await applyPlatformConfig(shared, PLATFORM_CONFIG, clock.now());

  const platform = new Platform(shared, new StubIdentityProvider(), clock, new MemoryBlobStore());
  const dbs: Record<string, DbAdapter> = {};
  for (const cfg of ALL_REGISTRIES) {
    const db = new SqliteAdapter(":memory:");
    await applyRegistryConfig(shared, db, cfg, clock.now());
    platform.registerRegistry(cfg, db);
    dbs[cfg.registryId] = db;
  }
  await seedMasterData(shared);

  return { platform, shared, db: dbs.permit!, dbs };
}

/**
 * Build a platform from environment configuration (Envs 1/2/3). Adapters come
 * from the factory: in-memory SQLite by default, or SQL Server when
 * DB_DIALECT=sqlserver. A registry maps to its own database (D-04).
 *
 * Note: with SQL Server, each registry database must already exist on the
 * server (CREATE DATABASE is an operational step, not part of migrations).
 */
export async function bootstrapFromEnv(
  clock: Clock,
  logger: BootstrapLogger = defaultBootstrapLogger,
  adapters: RuntimeAdapters = {},
): Promise<SamplePlatform> {
  const environment = adapters.environment ?? (process.env.APP_ENV === "production" ? "production" : "development");
  if (environment === "production" && !adapters.identity) {
    throw new Error("production bootstrap requires an explicit IdentityProvider");
  }
  if (environment === "production" && !adapters.blobs) {
    throw new Error("production bootstrap requires an explicit BlobStore");
  }
  const config = loadDbConfig();
  logger.info(`[bootstrap] Starting platform with ${config.dialect}`);

  const sharedTarget = config.sharedTarget();
  const shared = await bootstrapStep(
    logger,
    `Connecting shared database ${describeTarget(sharedTarget)}`,
    () => createAdapter(sharedTarget),
  );
  const applied = await bootstrapStep(
    logger,
    "Running shared database migrations",
    () => migrate(
      shared,
      [m0001, m0003, m0005, m0006Shared],
      clock.now(),
      (message) => logger.info(`[bootstrap] Shared migration: ${message}`),
    ),
  );
  logger.info(`[bootstrap] Shared migrations: ${applied.length > 0 ? `applied ${applied.join(", ")}` : "up to date"}`);
  await bootstrapStep(
    logger,
    "Applying platform configuration",
    () => applyPlatformConfig(shared, PLATFORM_CONFIG, clock.now()),
  );
  const platform = new Platform(
    shared,
    adapters.identity ?? new StubIdentityProvider(),
    clock,
    adapters.blobs ?? new MemoryBlobStore(),
  );
  const dbs: Record<string, DbAdapter> = {};
  for (const cfg of ALL_REGISTRIES) {
    const target = config.registryTarget(cfg.database);
    const db = await bootstrapStep(
      logger,
      `Connecting registry "${cfg.registryId}" database ${describeTarget(target)}`,
      () => createAdapter(target),
    );
    const result = await bootstrapStep(
      logger,
      `Running migrations and applying configuration for registry "${cfg.registryId}"`,
      () => applyRegistryConfig(
        shared,
        db,
        cfg,
        clock.now(),
        (message) => logger.info(`[bootstrap] Registry "${cfg.registryId}" migration: ${message}`),
      ),
    );
    logger.info(
      `[bootstrap] Registry "${cfg.registryId}": config version ${result.version}; ` +
      `${result.addedColumns.length} field column(s) added`,
    );
    platform.registerRegistry(cfg, db);
    dbs[cfg.registryId] = db;
  }
  if (environment !== "production") {
    await bootstrapStep(logger, "Checking shared master data", () => seedMasterDataIfEmpty(shared));
  }

  logger.info(`[bootstrap] Platform ready with ${ALL_REGISTRIES.length} registries`);

  return { platform, shared, db: dbs.permit!, dbs };
}

/**
 * Seed master data only if the shared DB has none yet. `migrate` and the
 * config-apply steps are already idempotent (they track applied migrations and
 * upsert), but `seedMasterData` uses plain INSERTs, so re-running it against a
 * PERSISTENT database (on-disk SQLite, or SQL Server across restarts) would hit
 * duplicate-key errors. A fresh in-memory DB (Env 1) has no workers, so it
 * seeds; a persistent DB seeds once and is skipped thereafter. Plain SELECT →
 * dialect-agnostic.
 */
async function seedMasterDataIfEmpty(shared: DbAdapter): Promise<void> {
  const existing = await shared.get("SELECT 1 AS ok FROM workers");
  if (existing) return;
  await seedMasterData(shared);
}

/** Runtime master data (workers, customers, authorizations) — not config. */
async function seedMasterData(shared: DbAdapter): Promise<void> {
  await shared.run("INSERT INTO workers (worker_id, name, is_admin) VALUES ('w-anna','Anna',0)");
  await shared.run("INSERT INTO workers (worker_id, name, is_admin) VALUES ('w-bo','Bo',0)");
  await shared.run("INSERT INTO workers (worker_id, name, is_admin) VALUES ('w-cara','Cara',0)");
  await shared.run("INSERT INTO workers (worker_id, name, is_admin) VALUES ('w-admin','Admin',1)");
  await shared.run("INSERT INTO customers (customer_id, name) VALUES ('c-1','Citizen One')");
  await shared.run("INSERT INTO customers (customer_id, name) VALUES ('c-2','Citizen Two')");

  // Anna → 105 (permits), Bo → 200, Cara → 300 (grants). Admin → broad + approve.
  await grant(shared, "w-anna", "permit", "105", 1);
  await grant(shared, "w-bo", "permit", "200", 1);
  await grant(shared, "w-cara", "grant", "300", 1);
  await grant(shared, "w-admin", "permit", "105", 1);
  await grant(shared, "w-admin", "grant", "300", 1);
}

async function grant(shared: DbAdapter, workerId: string, registryId: string, categoryId: string, canApprove: number): Promise<void> {
  await shared.run(
    "INSERT INTO worker_authorizations (worker_id, registry_id, category_id, can_approve, opted_in) VALUES (?, ?, ?, ?, 1)",
    [workerId, registryId, categoryId, canApprove],
  );
}
