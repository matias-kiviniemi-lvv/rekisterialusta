/**
 * Migration 0005 — shared: management + exports (Architecture §5.8, §5.11, §12).
 *
 *   - workers.is_admin: gates the management-portal (admin) API.
 *   - config_versions: records each applied registry config version, per
 *     environment — the audit trail of the config-as-code promotion (§5.12).
 *   - export_runs: log of scheduled CSV export runs, so a missed/failed export
 *     is visible, not silent (§12).
 */

import type { Db } from "../db/db.ts";
import type { Migration } from "./runner.ts";

export const m0005: Migration = {
  id: "0005",
  name: "admin_exports",
  async up(tx, d) {
    await tx.run(d.addColumn("workers", "is_admin INTEGER NOT NULL DEFAULT 0"));

    await tx.run(`
      CREATE TABLE config_versions (
        registry_id  TEXT NOT NULL,
        version      INTEGER NOT NULL,
        applied_at   TEXT NOT NULL,
        summary      TEXT NULL,
        config_json  TEXT NOT NULL,
        PRIMARY KEY (registry_id, version)
      )
    `);

    await tx.run(`
      CREATE TABLE export_runs (
        ${d.identityPk("run_id")},
        registry_id  TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        finished_at  TEXT NULL,
        status       TEXT NOT NULL CHECK (status IN ('running','ok','failed')),
        case_count   INTEGER NULL,
        blob_key     TEXT NULL,
        error        TEXT NULL
      )
    `);
    await tx.run("CREATE INDEX ix_export_runs_registry ON export_runs(registry_id, started_at)");
  },
};
