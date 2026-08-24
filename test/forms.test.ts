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
