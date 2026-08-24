/**
 * End-to-end walking-skeleton demo (Plan Phase 0/2).
 *
 * Runs the whole foundation against an in-memory database and narrates it:
 * migrate → seed a registry → a citizen creates a case → a worker moves it
 * through its lifecycle → authorization is enforced for every actor → the case
 * is published and appears on the public surface. No infrastructure required:
 *   node --experimental-strip-types scripts/demo.ts
 */

import { SqliteAdapter } from "../src/db/sqlite-adapter.ts";
import { migrate } from "../src/migrations/runner.ts";
import { m0001 } from "../src/migrations/0001_shared_schema.ts";
import { registrySpineMigration } from "../src/migrations/0002_registry_spine.ts";
import { normalizePath, levelOf } from "../src/domain/categories.ts";
import { PERMIT_REGISTRY, PERMIT_STATES, PERMIT_TRANSITIONS } from "../src/config/sample-registry.ts";
import { createCase } from "../src/domain/cases.ts";
import { changeState } from "../src/domain/state-machine.ts";
import { handleGetCase, type Actor } from "../src/core/handler.ts";
import { getCaseHistory, searchPublishedCases } from "../src/core/queries.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const log = (s: string) => process.stdout.write(s + "\n");

const db = new SqliteAdapter(":memory:");
const applied = await migrate(db, [m0001, registrySpineMigration(PERMIT_REGISTRY)], NOW);
log(`migrations applied: ${applied.join(", ")}`);

await db.run(
  "INSERT INTO registry_catalog (registry_id, name, database_key, registry_code, number_padding, separator) VALUES (?, ?, ?, ?, ?, ?)",
  [PERMIT_REGISTRY.registryId, PERMIT_REGISTRY.name, PERMIT_REGISTRY.database, PERMIT_REGISTRY.diary.registryCode, PERMIT_REGISTRY.diary.numberPadding, PERMIT_REGISTRY.diary.separator],
);

// Seed lifecycle + reference data.
for (const s of PERMIT_STATES)
  await db.run("INSERT INTO states (id, name, is_open, is_waiting_for_customer) VALUES (?, ?, ?, ?)", [s.id, s.name, s.isOpen, s.isWaitingForCustomer]);
for (const [f, t] of PERMIT_TRANSITIONS)
  await db.run("INSERT INTO state_transitions (from_state, to_state) VALUES (?, ?)", [f, t]);
const categories: ReadonlyArray<readonly [string, string]> = [["105", "Environment"], ["105.04", "Water permits"], ["105.04.03", "Small water permits"], ["200", "Building"]];
for (const [code, name] of categories)
  await db.run("INSERT INTO categories (category_id, display_code, path, parent_id, level, name) VALUES (?, ?, ?, ?, ?, ?)", [code, code, normalizePath(code), null, levelOf(code), name]);
await db.run("INSERT INTO workers (worker_id, name) VALUES ('w-anna','Anna')");
await db.run("INSERT INTO workers (worker_id, name) VALUES ('w-bo','Bo')");
await db.run("INSERT INTO customers (customer_id, name) VALUES ('c-1','Citizen One')");
await db.run("INSERT INTO customers (customer_id, name) VALUES ('c-2','Citizen Two')");
await db.run("INSERT INTO worker_authorizations (worker_id, registry_id, category_id, can_approve, opted_in) VALUES ('w-anna','permit','105',1,1)");
await db.run("INSERT INTO worker_authorizations (worker_id, registry_id, category_id, can_approve, opted_in) VALUES ('w-bo','permit','200',1,1)");
log("seeded: 5 states, 5 transitions, 4 categories, 2 workers, 2 customers, grants (Anna→105, Bo→200)\n");

// 1) Citizen One starts a case under 105.04.03.
const c = await createCase(db, {
  registryId: "permit", diaryFormat: PERMIT_REGISTRY.diary, fieldDefs: PERMIT_REGISTRY.fields,
  year: 2026, category: "105.04.03", initialState: "received",
  fields: { applicant_name: "Citizen One", permit_kind: "water abstraction", site_address: "Rantatie 5", fee_paid: false },
  parties: [{ customerId: "c-1", role: "applicant" }], actorKind: "customer", actorId: "c-1",
}, NOW);
log(`Citizen One created case ${c.diaryNumber} (internal key ${c.caseKey}) in category 105.04.03`);

// 2) Anna (authorized on 105, so covers 105.04.03) moves it through its lifecycle.
await changeState(db, { caseKey: c.caseKey, toState: "in_preparation", actorKind: "worker", actorId: "w-anna" }, NOW);
await changeState(db, { caseKey: c.caseKey, toState: "waiting_customer", actorKind: "worker", actorId: "w-anna", comment: "Need proof of ownership" }, NOW);
log("Anna moved it: received → in_preparation → waiting_customer");

// 3) An illegal jump is refused.
try {
  await changeState(db, { caseKey: c.caseKey, toState: "closed", actorKind: "worker", actorId: "w-anna" }, NOW);
} catch (e) {
  log(`illegal transition correctly refused: ${(e as Error).message}`);
}

// 4) Authorization across actors.
const show = async (label: string, actor: Actor) =>
  log(`  ${label.padEnd(28)} → ${(await handleGetCase(db, db, { diaryNumber: c.diaryNumber, actor })).status}`);
log("\naccess to " + c.diaryNumber + ":");
await show("owner (Citizen One)", { kind: "customer", customerId: "c-1" });
await show("other citizen (Two)", { kind: "customer", customerId: "c-2" });
await show("worker Anna (105)", { kind: "worker", workerId: "w-anna" });
await show("worker Bo (200 only)", { kind: "worker", workerId: "w-bo" });
await show("public (unpublished)", { kind: "public" });

// 5) Publish and re-check the public surface.
await db.transaction(async (tx) => {
  await tx.run("UPDATE cases SET is_published = 1 WHERE case_key = ?", [c.caseKey]);
  await tx.run(
    "INSERT INTO published_cases (case_key, diary_number, category, state, fields_json, published_at, published_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [c.caseKey, c.diaryNumber, "105.04.03", "waiting_customer", JSON.stringify({ permit_kind: "water abstraction" }), NOW, "w-anna"],
  );
});
log("\ncase published →");
await show("public (published)", { kind: "public" });
log(`public search returns ${(await searchPublishedCases(db)).length} case(s)`);

// 6) History is the complete audit trail.
log("\nfull audit history:");
for (const op of await getCaseHistory(db, c.caseKey))
  log(`  #${op.operationId} ${op.type.padEnd(14)} ${op.direction.padEnd(9)} by ${op.actorKind}`);

db.close();
log("\ndemo complete.");
