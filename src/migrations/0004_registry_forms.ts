/**
 * Migration 0004 — per-registry data for forms/attachments (Architecture §5.4).
 *
 *   - pending_case_updates: staged customer form submissions awaiting worker
 *     approval (§5.4 approval workflow). Applied to the case only on approval.
 *   - attachments: blob references for operation-form file uploads (D-10).
 *     Only the reference lives in the DB; bytes live in the blob store.
 */

import type { Db } from "../db/db.ts";
import type { Migration } from "./runner.ts";

export const m0004: Migration = {
  id: "0004",
  name: "registry_forms",
  async up(tx, d) {
    await tx.run(`
      CREATE TABLE pending_case_updates (
        ${d.identityPk("pending_id")},
        case_key     ${d.columnType("integer")} NOT NULL REFERENCES cases(case_key),
        form_id      TEXT NOT NULL,
        payload      TEXT NOT NULL,
        submitted_by TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        decided_by   TEXT NULL,
        decided_at   TEXT NULL
      )
    `);
    await tx.run("CREATE INDEX ix_pending_case ON pending_case_updates(case_key, status)");

    await tx.run(`
      CREATE TABLE attachments (
        ${d.identityPk("attachment_id")},
        case_key      ${d.columnType("integer")} NOT NULL REFERENCES cases(case_key),
        operation_key ${d.columnType("integer")} NULL REFERENCES operations(operation_key),
        filename      TEXT NOT NULL,
        content_type  TEXT NOT NULL,
        size          INTEGER NOT NULL,
        blob_key      TEXT NOT NULL,
        checksum      TEXT NOT NULL,
        created       TEXT NOT NULL
      )
    `);
    await tx.run("CREATE INDEX ix_attachments_case ON attachments(case_key)");
  },
};
