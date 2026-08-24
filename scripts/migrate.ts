/**
 * CLI migration entrypoint (Decision D-05).
 *
 * Applies pending migrations to a database file. In CI this runs against SQL
 * Server; locally it targets a SQLite file. Forward-only: it only applies
 * not-yet-applied migrations and records them.
 *
 *   node --experimental-strip-types scripts/migrate.ts [dbfile]
 */

import { SqliteAdapter } from "../src/db/sqlite-adapter.ts";
import { migrate } from "../src/migrations/runner.ts";
import { m0001 } from "../src/migrations/0001_shared_schema.ts";
import { registrySpineMigration } from "../src/migrations/0002_registry_spine.ts";
import { PERMIT_REGISTRY } from "../src/config/sample-registry.ts";

const dbfile = process.argv[2] ?? "data/dev.sqlite";
const now = new Date().toISOString();

const db = new SqliteAdapter(dbfile);
const applied = await migrate(db, [m0001, registrySpineMigration(PERMIT_REGISTRY)], now);
db.close();

if (applied.length === 0) process.stdout.write(`up to date (${dbfile})\n`);
else process.stdout.write(`applied ${applied.length} migration(s) to ${dbfile}: ${applied.join(", ")}\n`);
