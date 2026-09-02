import type { Migration } from "./runner.ts";

/** Persist common form data once and type-specific data in dedicated tables. */
export const m0007: Migration = {
  id: "0007",
  name: "split_case_and_operation_forms",
  async up(tx, d) {
    await tx.run(`ALTER TABLE form_definitions ADD description ${d.name === "sqlserver" ? "NVARCHAR(MAX)" : "TEXT"} NULL`);
    await tx.run(`CREATE TABLE case_form_definitions (
      form_id TEXT PRIMARY KEY REFERENCES form_definitions(form_id),
      requires_approval INTEGER NOT NULL DEFAULT 0,
      field_subset TEXT NULL
    )`);
    await tx.run(`CREATE TABLE operation_form_definitions (
      form_id TEXT PRIMARY KEY REFERENCES form_definitions(form_id),
      allow_attachments INTEGER NOT NULL DEFAULT 0,
      operation_type TEXT NULL,
      property_schema TEXT NULL
    )`);
    await tx.run(`INSERT INTO case_form_definitions (form_id, requires_approval, field_subset)
      SELECT form_id, requires_approval, field_subset FROM form_definitions WHERE kind = 'case'`);
    await tx.run(`INSERT INTO operation_form_definitions (form_id, allow_attachments, operation_type, property_schema)
      SELECT form_id, allow_attachments, operation_type, property_schema FROM form_definitions WHERE kind = 'operation'`);
  },
};
