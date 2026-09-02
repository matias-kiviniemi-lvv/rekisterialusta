/**
 * Migration 0003 — shared config: API tokens, form definitions, rules
 * (Architecture §5.4, §7, §9).
 *
 * These are platform CONFIGURATION (config-as-code, D-05), stored in the shared
 * database keyed by registry where registry-specific:
 *   - api_tokens:        method+category scoped REST tokens (§7). Distinct from
 *                        the internal oino-ts tokens, which are never exposed.
 *   - form_definitions:  case forms and operation forms (§5.4).
 *   - rules:             when-state-change / if / then rules (§9).
 */

import type { Db } from "../db/db.ts";
import type { Migration } from "./runner.ts";

export const m0003: Migration = {
  id: "0003",
  name: "api_forms_rules",
  async up(tx, _d) {
    // API tokens: scope = allowed methods × category subtree × resource.
    // token_hash stores a hash, never the raw token (§14). methods/resources are
    // comma-separated for simplicity here; category_scope is a display code whose
    // normalized path drives prefix containment (same logic as worker grants).
    await tx.run(`
      CREATE TABLE api_tokens (
        token_id       TEXT PRIMARY KEY,
        token_hash     TEXT NOT NULL,
        description    TEXT NULL,
        registry_id    TEXT NOT NULL,
        methods        TEXT NOT NULL,
        resources      TEXT NOT NULL,
        category_scope TEXT NULL,
        published_only INTEGER NOT NULL DEFAULT 1,
        active         INTEGER NOT NULL DEFAULT 1,
        created        TEXT NOT NULL
      )
    `);

    await tx.run(`
      CREATE TABLE form_definitions (
        form_id          TEXT PRIMARY KEY,
        registry_id      TEXT NOT NULL,
        kind             TEXT NOT NULL CHECK (kind IN ('case','operation')),
        audience         TEXT NOT NULL CHECK (audience IN ('worker','customer','both')),
        title            TEXT NOT NULL,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        field_subset     TEXT NULL,
        property_schema  TEXT NULL,
        allow_attachments INTEGER NOT NULL DEFAULT 0,
        operation_type   TEXT NULL,
        active           INTEGER NOT NULL DEFAULT 1
      )
    `);

    await tx.run(`
      CREATE TABLE rules (
        rule_id      TEXT PRIMARY KEY,
        registry_id  TEXT NOT NULL,
        [trigger]    TEXT NOT NULL DEFAULT 'state_change',
        on_to_state  TEXT NULL,
        condition    TEXT NULL,
        action_type  TEXT NOT NULL,
        action_params TEXT NULL,
        ordering     INTEGER NOT NULL DEFAULT 0,
        active       INTEGER NOT NULL DEFAULT 1
      )
    `);
    await tx.run("CREATE INDEX ix_rules_registry ON rules(registry_id, active)");
  },
};
