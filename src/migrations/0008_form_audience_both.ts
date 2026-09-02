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

    await tx.run("PRAGMA defer_foreign_keys = ON");
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
    await tx.run("DROP TABLE form_definitions");
    await tx.run("ALTER TABLE form_definitions_new RENAME TO form_definitions");
  },
};
