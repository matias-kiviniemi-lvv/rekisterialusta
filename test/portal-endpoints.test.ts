import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const worker = (id: string) => `Bearer worker:${id}`;
const customer = (id: string) => `Bearer customer:${id}`;

test("GET /api/registries lists both registries", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const r = await dispatch(p, { method: "GET", url: "/api/registries", body: undefined });
  assert.equal(r.status, 200);
  const ids = (r.body as { registries: { registryId: string }[] }).registries.map((x) => x.registryId);
  assert.deepEqual(ids.sort(), ["grant", "permit"]);
});

test("GET meta returns fields, states, transitions, forms, categories", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const r = await dispatch(p, { method: "GET", url: "/api/registries/permit/meta", authorization: worker("w-anna"), body: undefined });
  assert.equal(r.status, 200);
  const b = r.body as { fields: unknown[]; states: unknown[]; transitions: unknown[]; forms: unknown[]; categories: unknown[] };
  assert.equal(b.fields.length, 4);
  assert.equal(b.states.length, 5);
  assert.ok(b.transitions.length >= 5);
  assert.equal(b.forms.length, 2);
  assert.ok(b.categories.length >= 4);
});

test("worker queue views respect assignment, opt-in and authorization", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  // Create a permit case (unassigned) under 105.
  const diary = ((await dispatch(p, { method: "POST", url: "/api/registries/permit/cases", authorization: worker("w-anna"), body: { category: "105.04.03", initialState: "received", fields: { applicant_name: "A", permit_kind: "w", fee_paid: false } } })).body as { diaryNumber: string }).diaryNumber;

  // Authorized: Anna (105) sees it; assigned: none yet; unassigned opted-in: sees it.
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/worker/cases?view=authorized", authorization: worker("w-anna"), body: undefined })).body as { cases: unknown[] }).cases.length, 1);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/worker/cases?view=assigned", authorization: worker("w-anna"), body: undefined })).body as { cases: unknown[] }).cases.length, 0);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/worker/cases?view=unassigned", authorization: worker("w-anna"), body: undefined })).body as { cases: unknown[] }).cases.length, 1);

  // Bo (200) sees none of it.
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/worker/cases?view=authorized", authorization: worker("w-bo"), body: undefined })).body as { cases: unknown[] }).cases.length, 0);

  // Assign to Anna → shows in assigned, leaves unassigned.
  assert.equal((await dispatch(p, { method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/assign`, authorization: worker("w-anna"), body: {} })).status, 200);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/worker/cases?view=assigned", authorization: worker("w-anna"), body: undefined })).body as { cases: unknown[] }).cases.length, 1);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/worker/cases?view=unassigned", authorization: worker("w-anna"), body: undefined })).body as { cases: unknown[] }).cases.length, 0);
});

test("publish endpoint makes a case public and is worker-gated", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const diary = ((await dispatch(p, { method: "POST", url: "/api/registries/permit/cases", authorization: customer("c-1"), body: { category: "105.04.03", initialState: "received", fields: { applicant_name: "A", permit_kind: "w", fee_paid: false } } })).body as { diaryNumber: string }).diaryNumber;

  // Customer cannot publish.
  assert.equal((await dispatch(p, { method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/publish`, authorization: customer("c-1"), body: { publish: true } })).status, 403);
  // Authorized worker can.
  assert.equal((await dispatch(p, { method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/publish`, authorization: worker("w-anna"), body: { publish: true } })).status, 200);
  // Now public sees it.
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/published", body: undefined })).body as { cases: unknown[] }).cases.length, 1);
});

test("published super-search matches literal substrings in public cases and selected operations", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const permitDiary = ((await dispatch(p, {
    method: "POST", url: "/api/registries/permit/cases", authorization: worker("w-anna"),
    body: { category: "105.04.03", fields: { applicant_name: "Northern Water Cooperative", permit_kind: "dredging", site_address: "Harbour Road", fee_paid: false } },
  })).body as { diaryNumber: string }).diaryNumber;
  const publicOp = await dispatch(p, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(permitDiary)}/operations`, authorization: worker("w-anna"),
    body: { type: "inspection", subtype: "site-visit", properties: { finding: "Rare mussel habitat" }, comment: "Shoreline reviewed" },
  });
  await dispatch(p, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(permitDiary)}/operations`, authorization: worker("w-anna"),
    body: { type: "private-note", comment: "Never searchable secret" },
  });
  assert.equal((await dispatch(p, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(permitDiary)}/publish`, authorization: worker("w-anna"),
    body: { publish: true, fields: ["applicant_name", "site_address"], operations: [(publicOp.body as { operationId: number }).operationId] },
  })).status, 200);

  const grantDiary = ((await dispatch(p, {
    method: "POST", url: "/api/registries/grant/cases", authorization: worker("w-cara"),
    body: { category: "300.01", fields: { organisation: "Aurora Arts Foundation", amount_requested: 5000, purpose: "Winter festival" } },
  })).body as { diaryNumber: string }).diaryNumber;
  assert.equal((await dispatch(p, {
    method: "POST", url: `/api/registries/grant/cases/${encodeURIComponent(grantDiary)}/publish`, authorization: worker("w-cara"),
    body: { publish: true, fields: ["organisation", "purpose"] },
  })).status, 200);

  const registryResult = await dispatch(p, { method: "GET", url: "/api/registries/permit/published?q=THERN%20WAT", body: undefined });
  assert.equal(registryResult.status, 200);
  assert.deepEqual((registryResult.body as { cases: { diaryNumber: string }[] }).cases.map((c) => c.diaryNumber), [permitDiary]);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/published?q=mussel", body: undefined })).body as { cases: unknown[] }).cases.length, 1);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/published?q=searchable%20secret", body: undefined })).body as { cases: unknown[] }).cases.length, 0);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/published?q=dredging", body: undefined })).body as { cases: unknown[] }).cases.length, 0);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/published?category=105%25", body: undefined })).body as { cases: unknown[] }).cases.length, 0);

  const globalResult = await dispatch(p, { method: "GET", url: "/api/published/search?q=foundation", body: undefined });
  assert.equal(globalResult.status, 200);
  assert.deepEqual((globalResult.body as { cases: { registryId: string; diaryNumber: string }[] }).cases,
    [{ registryId: "grant", diaryNumber: grantDiary, category: "300.01", state: "submitted", fields: { organisation: "Aurora Arts Foundation", purpose: "Winter festival" }, publishedAt: NOW }]);
});

test("published search validates bounded query parameters", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  assert.equal((await dispatch(p, { method: "GET", url: "/api/published/search?q=ab", body: undefined })).status, 400);
  assert.equal((await dispatch(p, { method: "GET", url: "/api/published/search?limit=51", body: undefined })).status, 400);
  assert.equal((await dispatch(p, { method: "GET", url: "/api/published/search?registry=missing", body: undefined })).status, 404);
});

test("worker pending-to-approve is scoped to approve grants", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const diary = ((await dispatch(p, { method: "POST", url: "/api/registries/permit/cases", authorization: customer("c-1"), body: { category: "105.04.03", initialState: "received", fields: { applicant_name: "A", permit_kind: "w", fee_paid: false } } })).body as { diaryNumber: string }).diaryNumber;
  await dispatch(p, { method: "POST", url: "/api/registries/permit/forms/update-site-address/submit", authorization: customer("c-1"), body: { diaryNumber: diary, fields: { site_address: "New 1" } } });

  // Anna (approve on 105) sees the pending item; Bo (200) does not.
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/worker/pending", authorization: worker("w-anna"), body: undefined })).body as { pending: unknown[] }).pending.length, 1);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/worker/pending", authorization: worker("w-bo"), body: undefined })).body as { pending: unknown[] }).pending.length, 0);
});
