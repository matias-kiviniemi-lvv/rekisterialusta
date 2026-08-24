import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { SqliteAdapter } from "../src/db/sqlite-adapter.ts";
import { migrate } from "../src/migrations/runner.ts";
import { m0001 } from "../src/migrations/0001_shared_schema.ts";
import { m0003 } from "../src/migrations/0003_api_forms_rules.ts";
import { m0005 } from "../src/migrations/0005_admin_exports.ts";
import { applyPlatformConfig } from "../src/services/config-apply.ts";
import { PLATFORM_CONFIG } from "../src/config/platform-config.ts";
import { PERMIT_CONFIG } from "../src/config/registries/permit.ts";
import { exportRegistryConfig, promoteRegistry } from "../src/services/config-promote.ts";
import { createCase } from "../src/domain/cases.ts";
import { changeState } from "../src/domain/state-machine.ts";

const NOW = "2026-08-11T09:00:00.000Z";

test("the stored config artifact round-trips exactly", async () => {
  const { platform } = await buildSamplePlatform(fixedClock(NOW));
  const exported = await exportRegistryConfig(platform.shared, "permit");
  // JSON round-trip of the declarative config equals the source config.
  assert.deepEqual(exported, JSON.parse(JSON.stringify(PERMIT_CONFIG)));
});

test("promoting a registry config to a fresh environment reproduces its behavior", async () => {
  const clock = fixedClock(NOW);
  const { platform: source } = await buildSamplePlatform(clock);

  // A fresh "prod" environment: base migrations + shared categories only.
  const targetShared = new SqliteAdapter(":memory:");
  await migrate(targetShared, [m0001, m0003, m0005], NOW);
  await applyPlatformConfig(targetShared, PLATFORM_CONFIG, NOW);
  const targetGrantDb = new SqliteAdapter(":memory:");

  // Promote the Grant registry from source → target.
  const res = await promoteRegistry(source.shared, targetShared, targetGrantDb, "grant", NOW);
  assert.equal(res.promoted, true);
  assert.equal(res.version, 1);

  // Target now has the grant lifecycle and catalog.
  assert.equal(Number((await targetGrantDb.get("SELECT COUNT(*) AS n FROM states"))?.n), 6);
  assert.equal(Number((await targetGrantDb.get("SELECT COUNT(*) AS n FROM state_transitions"))?.n), 6);
  assert.ok(await targetShared.get("SELECT 1 AS ok FROM registry_catalog WHERE registry_id = 'grant'"));

  // Behavioral parity: a case created in the promoted env has the grant diary
  // format and its transitions work — identical to the source environment.
  const cfg = (await exportRegistryConfig(targetShared, "grant"))!;
  const created = await createCase(
    targetGrantDb,
    { registryId: "grant", diaryFormat: cfg.diary, fieldDefs: cfg.fields, year: 2026, category: "300.01", initialState: "submitted", fields: { organisation: "Org", amount_requested: 10, purpose: "P" }, parties: [], actorKind: "system" },
    NOW,
  );
  assert.match(created.diaryNumber, /^GRANT-2026-\d{6}$/);
  await changeState(targetGrantDb, { caseKey: created.caseKey, toState: "under_review", actorKind: "system" }, NOW);
  assert.equal(String((await targetGrantDb.get("SELECT state FROM cases WHERE case_key = ?", [created.caseKey]))?.state), "under_review");
});
