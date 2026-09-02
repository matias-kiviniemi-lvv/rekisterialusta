import type { Migration } from "./runner.ts";

/** Allow a single form definition to be offered to customers and workers. */
export const m0008: Migration = {
  id: "0008",
  name: "form_audience_both",
  async up(tx, d) {
    if (d.name === "sqlserver") {
      await tx.run(`DECLARE @constraint NVARCHAR(128);
        SELECT TOP 1 @constraint = cc.name
        FROM sys.check_constraints cc
        JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id
        WHERE cc.parent_object_id = OBJECT_ID('form_definitions') AND c.name = 'audience';
        IF @constraint IS NOT NULL EXEC('ALTER TABLE form_definitions DROP CONSTRAINT [' + @constraint + ']');
        ALTER TABLE form_definitions ADD CONSTRAINT CK_form_definitions_audience
          CHECK (audience IN ('worker','customer','both'));`);
      return;
    }

    // SQLite cannot ALTER a CHECK constraint. Rebuild the parent and every
    // table that references it, keeping both the old and new FK graphs valid
    // throughout the transaction. Do not edit sqlite_schema: writable_schema
    // is version/build dependent and is rejected by some supported Node builds.
    await tx.run(`CREATE TABLE form_definitions_new (
      form_id TEXT PRIMARY KEY, registry_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('case','operation')),
      audience TEXT NOT NULL CHECK (audience IN ('worker','customer','both')),
      title TEXT NOT NULL, requires_approval INTEGER NOT NULL DEFAULT 0,
      field_subset TEXT NULL, property_schema TEXT NULL,
      allow_attachments INTEGER NOT NULL DEFAULT 0, operation_type TEXT NULL,
      active INTEGER NOT NULL DEFAULT 1, description TEXT NULL)`);
    await tx.run(`INSERT INTO form_definitions_new
      SELECT form_id, registry_id, kind, audience, title, requires_approval, field_subset,
             property_schema, allow_attachments, operation_type, active, description
      FROM form_definitions`);

    await tx.run(`CREATE TABLE form_translations_new (
      form_id TEXT NOT NULL REFERENCES form_definitions_new(form_id), locale TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NULL, PRIMARY KEY (form_id, locale))`);
    await tx.run(`INSERT INTO form_translations_new SELECT form_id, locale, title, description FROM form_translations`);
    await tx.run(`CREATE TABLE case_form_definitions_new (
      form_id TEXT PRIMARY KEY REFERENCES form_definitions_new(form_id),
      requires_approval INTEGER NOT NULL DEFAULT 0, field_subset TEXT NULL)`);
    await tx.run(`INSERT INTO case_form_definitions_new SELECT form_id, requires_approval, field_subset FROM case_form_definitions`);
    await tx.run(`CREATE TABLE operation_form_definitions_new (
      form_id TEXT PRIMARY KEY REFERENCES form_definitions_new(form_id),
      allow_attachments INTEGER NOT NULL DEFAULT 0, operation_type TEXT NULL,
      property_schema TEXT NULL)`);
    await tx.run(`INSERT INTO operation_form_definitions_new
      SELECT form_id, allow_attachments, operation_type, property_schema FROM operation_form_definitions`);

    await tx.run("DROP TABLE form_translations");
    await tx.run("DROP TABLE case_form_definitions");
    await tx.run("DROP TABLE operation_form_definitions");
    await tx.run("DROP TABLE form_definitions");
    await tx.run("ALTER TABLE form_definitions_new RENAME TO form_definitions");
    await tx.run("ALTER TABLE form_translations_new RENAME TO form_translations");
    await tx.run("ALTER TABLE case_form_definitions_new RENAME TO case_form_definitions");
    await tx.run("ALTER TABLE operation_form_definitions_new RENAME TO operation_form_definitions");
  },
};
