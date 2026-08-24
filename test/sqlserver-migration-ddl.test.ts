import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../src/db/db.ts";
import { SqlServerDialect, translateDdl } from "../src/db/dialect.ts";
import { PERMIT_CONFIG } from "../src/config/registries/permit.ts";
import { registrySpineMigration } from "../src/migrations/0002_registry_spine.ts";
import { m0004 } from "../src/migrations/0004_registry_forms.ts";

test("registry migrations emit compatible SQL Server foreign keys and bounded composite keys", async () => {
  const statements: string[] = [];
  const tx: Db = {
    async run(sql) {
      statements.push(translateDdl(sql));
      return { changes: 0, lastInsertRowId: 0n };
    },
    async all() { return []; },
    async get() { return undefined; },
  };

  await registrySpineMigration(PERMIT_CONFIG).up(tx, SqlServerDialect);
  await m0004.up(tx, SqlServerDialect);
  const ddl = statements.join("\n");

  assert.doesNotMatch(ddl, /case_key\s+INTEGER/i);
  assert.doesNotMatch(ddl, /operation_key\s+INTEGER/i);
  assert.match(ddl, /case_key\s+BIGINT NOT NULL REFERENCES cases\(case_key\)/i);
  assert.match(ddl, /operation_key\s+BIGINT NULL REFERENCES operations\(operation_key\)/i);
  assert.match(ddl, /from_state NVARCHAR\(200\).*to_state NVARCHAR\(200\)/s);
  assert.match(ddl, /case_key\s+BIGINT.*worker_id NVARCHAR\(200\).*role NVARCHAR\(200\)/s);
});
