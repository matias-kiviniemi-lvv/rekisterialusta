/**
 * Test bootstrap: an in-memory database migrated and seeded with the example
 * registry. Shared and registry schemas co-locate in one SQLite db for tests;
 * the DbAdapter interface still keeps the two logically separate (the same
 * adapter is passed as both `shared` and `registryDb`).
 */

import { SqliteAdapter } from "../src/db/sqlite-adapter.ts";
import { migrate } from "../src/migrations/runner.ts";
import { m0001 } from "../src/migrations/0001_shared_schema.ts";
import { registrySpineMigration } from "../src/migrations/0002_registry_spine.ts";
import { normalizePath, levelOf } from "../src/domain/categories.ts";
import {
  PERMIT_REGISTRY,
  PERMIT_STATES,
  PERMIT_TRANSITIONS,
} from "../src/config/sample-registry.ts";

export const NOW = "2026-08-11T00:00:00.000Z";

export async function setupDb(): Promise<SqliteAdapter> {
  const db = new SqliteAdapter(":memory:");
  await migrate(db, [m0001, registrySpineMigration(PERMIT_REGISTRY)], NOW);

  // Seed lifecycle.
  for (const s of PERMIT_STATES) {
    await db.run(
      "INSERT INTO states (id, name, is_open, is_waiting_for_customer) VALUES (?, ?, ?, ?)",
      [s.id, s.name, s.isOpen, s.isWaitingForCustomer],
    );
  }
  for (const [from, to] of PERMIT_TRANSITIONS) {
    await db.run("INSERT INTO state_transitions (from_state, to_state) VALUES (?, ?)", [from, to]);
  }

  // Seed catalog + a couple of categories + workers/customers.
  await db.run(
    "INSERT INTO registry_catalog (registry_id, name, database_key, registry_code, number_padding, separator) VALUES (?, ?, ?, ?, ?, ?)",
    [PERMIT_REGISTRY.registryId, PERMIT_REGISTRY.name, PERMIT_REGISTRY.database, PERMIT_REGISTRY.diary.registryCode, PERMIT_REGISTRY.diary.numberPadding, PERMIT_REGISTRY.diary.separator],
  );
  await seedCategory(db, "105", "Environment");
  await seedCategory(db, "105.04", "Water permits");
  await seedCategory(db, "105.04.03", "Small water permits");
  await seedCategory(db, "200", "Building");

  await db.run("INSERT INTO workers (worker_id, name) VALUES (?, ?)", ["w-anna", "Anna"]);
  await db.run("INSERT INTO workers (worker_id, name) VALUES (?, ?)", ["w-bo", "Bo"]);
  await db.run("INSERT INTO customers (customer_id, name) VALUES (?, ?)", ["c-1", "Citizen One"]);
  await db.run("INSERT INTO customers (customer_id, name) VALUES (?, ?)", ["c-2", "Citizen Two"]);

  // Anna authorized on 105 (covers 105.04.03); Bo only on 200.
  await grant(db, "w-anna", "permit", "105");
  await grant(db, "w-bo", "permit", "200");
  return db;
}

async function seedCategory(db: SqliteAdapter, code: string, name: string): Promise<void> {
  await db.run(
    "INSERT INTO categories (category_id, display_code, path, parent_id, level, name) VALUES (?, ?, ?, ?, ?, ?)",
    [code, code, normalizePath(code), null, levelOf(code), name],
  );
}

async function grant(db: SqliteAdapter, workerId: string, registryId: string, categoryId: string): Promise<void> {
  await db.run(
    "INSERT INTO worker_authorizations (worker_id, registry_id, category_id, can_approve, opted_in) VALUES (?, ?, ?, 1, 1)",
    [workerId, registryId, categoryId],
  );
}
