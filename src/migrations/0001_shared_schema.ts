/**
 * Migration 0001 — shared database schema (Architecture §2.1, §6, §11).
 *
 * The shared database holds cross-registry master data and platform config:
 *   - registry_catalog: registry → database placement + diary format
 *   - workers, customers: shared master tables (Decision D-09)
 *   - categories: hierarchical codes with a normalized path for prefix
 *     authorization (Decision D-09, Architecture §2.4)
 *   - worker_authorizations: category grants with inheritance + opt-in (§6.3)
 *
 * (The diary-number counter lives in each registry's own database — see
 * migration 0002 — so allocation shares the case-insert transaction.)
 */

import type { Db } from "../db/db.ts";
import type { Migration } from "./runner.ts";

export const m0001: Migration = {
  id: "0001",
  name: "shared_schema",
  async up(tx, _d) {
    await tx.run(`
      CREATE TABLE registry_catalog (
        registry_id    TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        database_key   TEXT NOT NULL,
        registry_code  TEXT NOT NULL,
        number_padding INTEGER NOT NULL DEFAULT 5,
        separator      TEXT NOT NULL DEFAULT '/'
      )
    `);

    await tx.run(`
      CREATE TABLE workers (
        worker_id  TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        active     INTEGER NOT NULL DEFAULT 1
      )
    `);

    await tx.run(`
      CREATE TABLE customers (
        customer_id TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        active      INTEGER NOT NULL DEFAULT 1
      )
    `);

    // categories.path is the normalized, fixed-width, sortable materialized
    // path enabling index-friendly prefix-containment authorization (§2.4).
    // e.g. display_code "105.04.03" -> path "0105.0004.0003."
    await tx.run(`
      CREATE TABLE categories (
        category_id  TEXT PRIMARY KEY,
        display_code TEXT NOT NULL UNIQUE,
        path         TEXT NOT NULL,
        parent_id    TEXT NULL REFERENCES categories(category_id),
        level        INTEGER NOT NULL,
        name         TEXT NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1
      )
    `);
    await tx.run("CREATE INDEX ix_categories_path ON categories(path)");

    // A worker's grant on a category covers that category and everything
    // beneath it (prefix test on path). opted_in separates "allowed to see"
    // from "wants unassigned work from" (§6.3).
    await tx.run(`
      CREATE TABLE worker_authorizations (
        worker_id     TEXT NOT NULL REFERENCES workers(worker_id),
        registry_id   TEXT NOT NULL REFERENCES registry_catalog(registry_id),
        category_id   TEXT NOT NULL REFERENCES categories(category_id),
        can_read      INTEGER NOT NULL DEFAULT 1,
        can_write     INTEGER NOT NULL DEFAULT 1,
        can_transition INTEGER NOT NULL DEFAULT 1,
        can_approve   INTEGER NOT NULL DEFAULT 0,
        opted_in      INTEGER NOT NULL DEFAULT 1,
        valid_from    TEXT NULL,
        valid_until   TEXT NULL,
        PRIMARY KEY (worker_id, registry_id, category_id)
      )
    `);
  },
};
