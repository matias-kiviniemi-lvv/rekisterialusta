import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import type { Db } from "../src/db/db.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const customer = (id: string) => `Bearer customer:${id}`;
const worker = (id: string) => `Bearer worker:${id}`;

/**
 * A deliberately small, stable projection of persisted customer state. Tests
 * compare this after every user action instead of coupling themselves to
 * surrogate keys, UUIDs, or other storage implementation details.
 */
async function customerState(db: Db, diaryNumber: string, field: string) {
  const c = await db.get(
    `SELECT case_key, diary_number, state, version, ${field} AS tested_value
       FROM cases WHERE diary_number = ?`,
    [diaryNumber],
  );
  assert.ok(c, `controlled case ${diaryNumber} must exist`);

  const operations = await db.all(
    `SELECT operation_id, type, actor_kind
       FROM operations WHERE case_key = ? ORDER BY operation_id`,
    [c.case_key!],
  );
  const pending = await db.all(
    `SELECT form_id, payload, status, submitted_by, decided_by
       FROM pending_case_updates WHERE case_key = ? ORDER BY pending_id`,
    [c.case_key!],
  );

  return {
    diaryNumber: c.diary_number,
    state: c.state,
    version: Number(c.version),
    testedValue: c.tested_value,
    operations: operations.map((row) => ({
      id: Number(row.operation_id),
      type: row.type,
      actor: row.actor_kind,
    })),
    pending: pending.map((row) => ({
      form: row.form_id,
      payload: JSON.parse(String(row.payload)) as unknown,
      status: row.status,
      submittedBy: row.submitted_by,
      decidedBy: row.decided_by,
    })),
  };
}

async function createControlledCase(
  platform: Awaited<ReturnType<typeof buildSamplePlatform>>["platform"],
  registry: "permit" | "grant",
) {
  const isPermit = registry === "permit";
  const response = await dispatch(platform, {
    method: "POST",
    url: `/api/registries/${registry}/cases`,
    authorization: customer("c-1"),
    body: isPermit
      ? { category: "105.04.03", fields: { applicant_name: "Controlled applicant", permit_kind: "water", fee_paid: false } }
      : { category: "300.01", fields: { organisation: "Controlled org", amount_requested: 1000, purpose: "Testing" } },
  });
  assert.equal(response.status, 201);
  return (response.body as { diaryNumber: string }).diaryNumber;
}

test("user story: an approval-required form stages data and only approval changes the case", async () => {
  const { platform, db } = await buildSamplePlatform(fixedClock(NOW));
  const diary = await createControlledCase(platform, "permit");

  assert.deepEqual(await customerState(db, diary, "site_address"), {
    diaryNumber: "PERMIT/2026/00001", state: "received", version: 1, testedValue: null,
    operations: [{ id: 1, type: "case_created", actor: "customer" }], pending: [],
  });

  const submitted = await dispatch(platform, {
    method: "POST", url: "/api/registries/permit/forms/update-site-address/submit",
    authorization: customer("c-1"), body: { diaryNumber: diary, fields: { site_address: "New Road 9" } },
  });
  assert.equal(submitted.status, 202);
  assert.deepEqual(await customerState(db, diary, "site_address"), {
    diaryNumber: diary, state: "received", version: 1, testedValue: null,
    operations: [
      { id: 1, type: "case_created", actor: "customer" },
      { id: 2, type: "pending_submission", actor: "customer" },
    ],
    pending: [{ form: "update-site-address", payload: { site_address: "New Road 9" }, status: "pending", submittedBy: "c-1", decidedBy: null }],
  });

  const approved = await dispatch(platform, {
    method: "POST", url: "/api/registries/permit/pending/1/approve",
    authorization: worker("w-anna"), body: {},
  });
  assert.equal(approved.status, 200);
  assert.deepEqual(await customerState(db, diary, "site_address"), {
    diaryNumber: diary, state: "received", version: 2, testedValue: "New Road 9",
    operations: [
      { id: 1, type: "case_created", actor: "customer" },
      { id: 2, type: "pending_submission", actor: "customer" },
      { id: 3, type: "case_updated", actor: "worker" },
    ],
    pending: [{ form: "update-site-address", payload: { site_address: "New Road 9" }, status: "approved", submittedBy: "c-1", decidedBy: "w-anna" }],
  });
});

test("user story: a no-approval form applies the same customer change immediately", async () => {
  const { platform, dbs } = await buildSamplePlatform(fixedClock(NOW));
  const diary = await createControlledCase(platform, "grant");

  const submitted = await dispatch(platform, {
    method: "POST", url: "/api/registries/grant/forms/provide-iban/submit",
    authorization: customer("c-1"), body: { diaryNumber: diary, fields: { iban: "FI2112345600000785" } },
  });
  assert.equal(submitted.status, 200);
  assert.deepEqual(await customerState(dbs.grant!, diary, "iban"), {
    diaryNumber: "GRANT-2026-000001", state: "submitted", version: 2, testedValue: "FI2112345600000785",
    operations: [
      { id: 1, type: "case_created", actor: "customer" },
      { id: 2, type: "case_updated", actor: "customer" },
    ],
    pending: [],
  });
});
