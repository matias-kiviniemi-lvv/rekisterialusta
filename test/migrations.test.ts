import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteAdapter } from "../src/db/sqlite-adapter.ts";
import { m0008 } from "../src/migrations/0008_form_audience_both.ts";
import { migrate } from "../src/migrations/runner.ts";

test("audience migration preserves populated SQLite foreign-key dependants", async () => {
  const db = new SqliteAdapter(":memory:");
  try {
    await db.run(`CREATE TABLE form_definitions (
      form_id TEXT PRIMARY KEY, registry_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('case','operation')),
      audience TEXT NOT NULL CHECK (audience IN ('worker','customer')),
      title TEXT NOT NULL, requires_approval INTEGER NOT NULL DEFAULT 0,
      field_subset TEXT NULL, property_schema TEXT NULL,
      allow_attachments INTEGER NOT NULL DEFAULT 0, operation_type TEXT NULL,
      active INTEGER NOT NULL DEFAULT 1, description TEXT NULL)`);
    await db.run(`CREATE TABLE form_translations (
      form_id TEXT NOT NULL REFERENCES form_definitions(form_id), locale TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NULL, PRIMARY KEY (form_id, locale))`);
    await db.run(`CREATE TABLE case_form_definitions (
      form_id TEXT PRIMARY KEY REFERENCES form_definitions(form_id),
      requires_approval INTEGER NOT NULL DEFAULT 0, field_subset TEXT NULL)`);
    await db.run(`CREATE TABLE operation_form_definitions (
      form_id TEXT PRIMARY KEY REFERENCES form_definitions(form_id),
      allow_attachments INTEGER NOT NULL DEFAULT 0, operation_type TEXT NULL,
      property_schema TEXT NULL)`);
    await db.run(`INSERT INTO form_definitions
      (form_id, registry_id, kind, audience, title, description)
      VALUES ('existing', 'permit', 'case', 'customer', 'Existing', 'Existing form')`);
    await db.run("INSERT INTO form_translations VALUES ('existing', 'fi', 'Olemassa', 'Kuvaus')");
    await db.run("INSERT INTO case_form_definitions VALUES ('existing', 1, '[\"site_address\"]')");

    await migrate(db, [m0008], "2026-09-02T00:00:00.000Z");

    assert.equal((await db.get("SELECT title FROM form_translations WHERE form_id = 'existing'"))?.title, "Olemassa");
    assert.equal(Number((await db.get("SELECT requires_approval FROM case_form_definitions WHERE form_id = 'existing'"))?.requires_approval), 1);
    assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
    await db.run(`INSERT INTO form_definitions
      (form_id, registry_id, kind, audience, title, description)
      VALUES ('combined', 'permit', 'operation', 'both', 'Combined', 'Combined form')`);
  } finally {
    await db.close();
  }
});
