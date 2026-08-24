import { test } from "node:test";
import assert from "node:assert/strict";
import { setupDb, NOW } from "./helpers.ts";
import { PERMIT_REGISTRY } from "../src/config/sample-registry.ts";
import { createCase } from "../src/domain/cases.ts";
import { changeState, IllegalTransitionError } from "../src/domain/state-machine.ts";
import { handleGetCase } from "../src/core/handler.ts";
import { workerCanAccessCategory, customerOwnsCase } from "../src/core/authorization.ts";
import { getCaseHistory, listCustomerCases, searchPublishedCases } from "../src/core/queries.ts";

async function newCase(db: Awaited<ReturnType<typeof setupDb>>, category = "105.04.03", customerId = "c-1") {
  return createCase(
    db,
    {
      registryId: PERMIT_REGISTRY.registryId,
      diaryFormat: PERMIT_REGISTRY.diary,
      fieldDefs: PERMIT_REGISTRY.fields,
      year: 2026,
      category,
      initialState: "received",
      fields: { applicant_name: "Test Applicant", permit_kind: "water", fee_paid: false },
      parties: [{ customerId, role: "applicant" }],
      actorKind: "customer",
      actorId: customerId,
    },
    NOW,
  );
}

test("createCase allocates a diary number and writes an initial operation", async () => {
  const db = await setupDb();
  const c = await newCase(db);
  assert.equal(c.diaryNumber, "PERMIT/2026/00001");
  const history = await getCaseHistory(db, c.caseKey);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.type, "case_created");
  db.close();
});

test("createCase rejects missing required statutory fields", async () => {
  const db = await setupDb();
  await assert.rejects(
    () =>
      createCase(
        db,
        {
          registryId: "permit",
          diaryFormat: PERMIT_REGISTRY.diary,
          fieldDefs: PERMIT_REGISTRY.fields,
          year: 2026,
          category: "105",
          initialState: "received",
          fields: { applicant_name: "X" }, // permit_kind + fee_paid missing
          parties: [],
          actorKind: "worker",
        },
        NOW,
      ),
    /required/,
  );
  db.close();
});

test("state machine allows configured transitions and records history", async () => {
  const db = await setupDb();
  const c = await newCase(db);
  await changeState(db, { caseKey: c.caseKey, toState: "in_preparation", actorKind: "worker", actorId: "w-anna" }, NOW);
  await changeState(db, { caseKey: c.caseKey, toState: "waiting_customer", actorKind: "worker", actorId: "w-anna" }, NOW);
  const history = await getCaseHistory(db, c.caseKey);
  assert.equal(history.length, 3); // created + 2 transitions
  assert.equal(history[2]?.type, "state_change");
  db.close();
});

test("state machine rejects illegal transitions", async () => {
  const db = await setupDb();
  const c = await newCase(db);
  // received -> decided is not configured
  await assert.rejects(
    () => changeState(db, { caseKey: c.caseKey, toState: "decided", actorKind: "worker", actorId: "w-anna" }, NOW),
    IllegalTransitionError,
  );
  db.close();
});

test("worker category authorization respects inheritance and boundaries", async () => {
  const db = await setupDb();
  // Anna granted on 105 -> can access 105.04.03; Bo granted on 200 -> cannot.
  assert.ok(await workerCanAccessCategory(db, "w-anna", "permit", "105.04.03", "read", NOW));
  assert.equal(await workerCanAccessCategory(db, "w-bo", "permit", "105.04.03", "read", NOW), false);
  assert.equal(await workerCanAccessCategory(db, "w-anna", "permit", "200", "read", NOW), false);
  db.close();
});

test("customer ownership isolates cases between customers", async () => {
  const db = await setupDb();
  const c = await newCase(db, "105.04.03", "c-1");
  assert.ok(await customerOwnsCase(db, db, c.caseKey, "c-1"));
  assert.equal(await customerOwnsCase(db, db, c.caseKey, "c-2"), false);
  db.close();
});

test("handleGetCase enforces all three access rules", async () => {
  const db = await setupDb();
  const c = await newCase(db, "105.04.03", "c-1");

  // Owner customer: allowed.
  assert.equal((await handleGetCase(db, db, { diaryNumber: c.diaryNumber, actor: { kind: "customer", customerId: "c-1" } })).status, "ok");
  // Non-owner customer: forbidden.
  assert.equal((await handleGetCase(db, db, { diaryNumber: c.diaryNumber, actor: { kind: "customer", customerId: "c-2" } })).status, "forbidden");
  // Authorized worker: allowed.
  assert.equal((await handleGetCase(db, db, { diaryNumber: c.diaryNumber, actor: { kind: "worker", workerId: "w-anna" } })).status, "ok");
  // Out-of-category worker: forbidden.
  assert.equal((await handleGetCase(db, db, { diaryNumber: c.diaryNumber, actor: { kind: "worker", workerId: "w-bo" } })).status, "forbidden");
  // Public on an unpublished case: forbidden (safe-by-default).
  assert.equal((await handleGetCase(db, db, { diaryNumber: c.diaryNumber, actor: { kind: "public" } })).status, "forbidden");
  // Unknown case: not_found.
  assert.equal((await handleGetCase(db, db, { diaryNumber: "PERMIT/2026/99999", actor: { kind: "public" } })).status, "not_found");
  db.close();
});

test("publishing surface reads the explicit publication projection", async () => {
  const db = await setupDb();
  const c = await newCase(db, "105.04.03", "c-1");
  assert.equal((await searchPublishedCases(db)).length, 0);
  await db.run(
    "INSERT INTO published_cases (case_key, diary_number, category, state, fields_json, published_at, published_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [c.caseKey, c.diaryNumber, "105.04.03", "received", "{}", NOW, "w-anna"],
  );
  const published = await searchPublishedCases(db);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.diaryNumber, c.diaryNumber);
  db.close();
});

test("customer portal lists a customer's own cases", async () => {
  const db = await setupDb();
  await newCase(db, "105.04.03", "c-1");
  await newCase(db, "105.04", "c-1");
  await newCase(db, "105", "c-2");
  assert.equal((await listCustomerCases(db, "c-1")).length, 2);
  assert.equal((await listCustomerCases(db, "c-2")).length, 1);
  db.close();
});
