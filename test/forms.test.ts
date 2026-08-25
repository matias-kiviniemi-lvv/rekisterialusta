import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import { getCaseByDiaryNumber, getCaseHistory } from "../src/core/queries.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const asCustomer = (id: string) => `Bearer customer:${id}`;
const asWorker = (id: string) => `Bearer worker:${id}`;

async function seedCase(p: Awaited<ReturnType<typeof buildSamplePlatform>>["platform"], customer = "c-1") {
  const r = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/cases", authorization: asCustomer(customer),
    body: { category: "105.04.03", initialState: "received", fields: { applicant_name: "A", permit_kind: "water", fee_paid: false } },
  });
  return (r.body as { diaryNumber: string }).diaryNumber;
}

test("customer case form requiring approval is staged, not applied, until a worker approves", async () => {
  const { platform: p, db } = await buildSamplePlatform(fixedClock(NOW));
  const diary = await seedCase(p);

  // Customer submits the approval-required address change.
  const submit = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/forms/update-site-address/submit", authorization: asCustomer("c-1"),
    body: { diaryNumber: diary, fields: { site_address: "New Road 9" } },
  });
  assert.equal(submit.status, 202);

  // Not yet applied to the case.
  const c1 = await db.get("SELECT site_address FROM cases WHERE diary_number = ?", [diary]);
  assert.equal(c1?.site_address, null);

  // Worker approves the single pending update (pending_id = 1).
  const approve = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/pending/1/approve", authorization: asWorker("w-anna"), body: {},
  });
  assert.equal(approve.status, 200);

  // Now applied.
  const c2 = await db.get("SELECT site_address FROM cases WHERE diary_number = ?", [diary]);
  assert.equal(c2?.site_address, "New Road 9");
});

test("a worker without approve permission cannot approve", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const diary = await seedCase(p);
  await dispatch(p, { method: "POST", url: "/api/registries/permit/forms/update-site-address/submit", authorization: asCustomer("c-1"), body: { diaryNumber: diary, fields: { site_address: "X" } } });
  // Bo is authorized on 200, not on 105 — cannot approve this case's pending update.
  assert.equal((await dispatch(p, { method: "POST", url: "/api/registries/permit/pending/1/approve", authorization: asWorker("w-bo"), body: {} })).status, 403);
});

test("rejecting a pending case update preserves the case and cannot be decided twice", async () => {
  const { platform: p, db } = await buildSamplePlatform(fixedClock(NOW));
  const diary = await seedCase(p);
  const submitted = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/forms/update-site-address/submit", authorization: asCustomer("c-1"),
    body: { diaryNumber: diary, fields: { site_address: "Rejected Road 1" } },
  });
  assert.equal(submitted.status, 202);

  const rejected = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/pending/1/reject", authorization: asWorker("w-anna"), body: {},
  });
  assert.deepEqual(rejected, { status: 200, body: { decision: "rejected" } });
  assert.equal((await db.get("SELECT site_address FROM cases WHERE diary_number = ?", [diary]))?.site_address, null);
  const pending = await db.get("SELECT status, decided_by FROM pending_case_updates WHERE pending_id = 1");
  assert.equal(pending?.status, "rejected");
  assert.equal(pending?.decided_by, "w-anna");

  for (const decision of ["approve", "reject"]) {
    const repeated = await dispatch(p, {
      method: "POST", url: `/api/registries/permit/pending/1/${decision}`, authorization: asWorker("w-anna"), body: {},
    });
    assert.equal(repeated.status, 409);
  }
  assert.equal((await db.get("SELECT site_address FROM cases WHERE diary_number = ?", [diary]))?.site_address, null);
});

test("operation form validates payload against its JSON schema and stores attachments", async () => {
  const { platform: p, db } = await buildSamplePlatform(fixedClock(NOW));
  const diary = await seedCase(p);

  // Missing required documentTitle -> 400.
  const bad = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/forms/submit-document/submit", authorization: asCustomer("c-1"),
    body: { diaryNumber: diary, properties: { pages: 3 } },
  });
  assert.equal(bad.status, 400);

  // Valid payload + an attachment.
  const ok = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/forms/submit-document/submit", authorization: asCustomer("c-1"),
    body: { diaryNumber: diary, properties: { documentTitle: "Deed", pages: 2 }, attachments: [{ filename: "deed.txt", contentType: "text/plain", base64: Buffer.from("hello").toString("base64") }] },
  });
  assert.equal(ok.status, 201);

  const cse = (await getCaseByDiaryNumber(db, diary))!;
  const att = await db.get("SELECT filename, size, blob_key FROM attachments WHERE case_key = ?", [cse.caseKey]);
  assert.equal(att?.filename, "deed.txt");
  assert.equal(Number(att?.size), 5);
  // The blob bytes are retrievable from the store by key.
  assert.equal(Buffer.from(p.blobs.get(String(att?.blob_key))!).toString("utf8"), "hello");
});

test("wrong audience is rejected (worker submitting a customer form)", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const diary = await seedCase(p);
  const r = await dispatch(p, { method: "POST", url: "/api/registries/permit/forms/update-site-address/submit", authorization: asWorker("w-anna"), body: { diaryNumber: diary, fields: { site_address: "Y" } } });
  assert.equal(r.status, 403);
});

test("a customer cannot submit an operation form against another customer's case", async () => {
  const { platform: p, db } = await buildSamplePlatform(fixedClock(NOW));
  const diary = await seedCase(p, "c-1");
  const before = Number((await db.get("SELECT COUNT(*) AS n FROM operations"))?.n);

  const response = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/forms/submit-document/submit", authorization: asCustomer("c-2"),
    body: { diaryNumber: diary, properties: { documentTitle: "Not mine" } },
  });

  assert.equal(response.status, 403);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM operations"))?.n), before);
});

test("operation form rejects additional schema properties without recording an operation", async () => {
  const { platform: p, db } = await buildSamplePlatform(fixedClock(NOW));
  const diary = await seedCase(p);
  const before = Number((await db.get("SELECT COUNT(*) AS n FROM operations"))?.n);

  const response = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/forms/submit-document/submit", authorization: asCustomer("c-1"),
    body: { diaryNumber: diary, properties: { documentTitle: "Deed", internalOverride: true } },
  });

  assert.equal(response.status, 400);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM operations"))?.n), before);
});
