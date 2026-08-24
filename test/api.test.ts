import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import { mintApiToken } from "../src/api/tokens.ts";

const NOW = "2026-08-11T09:00:00.000Z";

function platform() {
  return buildSamplePlatform(fixedClock(NOW));
}

// Auth header helpers for the stub identity provider.
const asCustomer = (id: string) => `Bearer customer:${id}`;
const asWorker = (id: string) => `Bearer worker:${id}`;

function createCaseAs(p: Awaited<ReturnType<typeof platform>>["platform"], auth: string, category = "105.04.03") {
  return dispatch(p, {
    method: "POST",
    url: "/api/registries/permit/cases",
    authorization: auth,
    body: { category, initialState: "received", fields: { applicant_name: "A", permit_kind: "water", fee_paid: false } },
  });
}

test("customer can create and read their own case; other customer is forbidden", async () => {
  const { platform: p } = await platform();
  const created = await createCaseAs(p, asCustomer("c-1"));
  assert.equal(created.status, 201);
  const diary = (created.body as { diaryNumber: string }).diaryNumber;

  const ownerRead = await dispatch(p, { method: "GET", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}`, authorization: asCustomer("c-1"), body: undefined });
  assert.equal(ownerRead.status, 200);

  const otherRead = await dispatch(p, { method: "GET", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}`, authorization: asCustomer("c-2"), body: undefined });
  assert.equal(otherRead.status, 403);
});

test("worker create is bounded by category authorization", async () => {
  const { platform: p } = await platform();
  // Anna (105) can create under 105.04.03; Bo (200) cannot.
  assert.equal((await createCaseAs(p, asWorker("w-anna"), "105.04.03")).status, 201);
  assert.equal((await createCaseAs(p, asWorker("w-bo"), "105.04.03")).status, 403);
});

test("state transition endpoint enforces the state machine and fires rules", async () => {
  const { platform: p } = await platform();
  const diary = ((await createCaseAs(p, asWorker("w-anna"))).body as { diaryNumber: string }).diaryNumber;
  const url = `/api/registries/permit/cases/${encodeURIComponent(diary)}/transition`;

  // Illegal jump received -> decided.
  const bad = await dispatch(p, { method: "POST", url, authorization: asWorker("w-anna"), body: { toState: "decided" } });
  assert.equal(bad.status, 409);

  // Legal path, and reaching waiting_customer fires the notify rule.
  assert.equal((await dispatch(p, { method: "POST", url, authorization: asWorker("w-anna"), body: { toState: "in_preparation" } })).status, 200);
  const toWaiting = await dispatch(p, { method: "POST", url, authorization: asWorker("w-anna"), body: { toState: "waiting_customer" } });
  assert.equal(toWaiting.status, 200);
  assert.equal((toWaiting.body as { rulesFired: number }).rulesFired, 1);
});

test("public sees only published projections via the API", async () => {
  const { platform: p } = await platform();
  const diary = ((await createCaseAs(p, asCustomer("c-1"))).body as { diaryNumber: string }).diaryNumber;
  // Unpublished: public read forbidden, not in published list.
  assert.equal((await dispatch(p, { method: "GET", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}`, body: undefined })).status, 403);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/published", body: undefined })).body as { cases: unknown[] }).cases.length, 0);
  // Publish and re-check.
  assert.equal((await dispatch(p, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/publish`,
    authorization: asWorker("w-anna"), body: { publish: true, fields: ["permit_kind"], operations: [1] },
  })).status, 200);
  assert.equal((await dispatch(p, { method: "GET", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}`, body: undefined })).status, 200);
  assert.equal(((await dispatch(p, { method: "GET", url: "/api/registries/permit/published", body: undefined })).body as { cases: unknown[] }).cases.length, 1);
});

test("API token is scoped to method + category", async () => {
  const { platform: p } = await platform();
  // A read-only token for published cases under 105.
  const { raw } = await mintApiToken(p.shared, { registryId: "permit", methods: ["GET"], resources: ["cases"], categoryScope: "105", publishedOnly: true }, NOW);
  const diary = ((await createCaseAs(p, asWorker("w-anna"), "105.04.03")).body as { diaryNumber: string }).diaryNumber;
  assert.equal((await dispatch(p, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/publish`,
    authorization: asWorker("w-anna"), body: { publish: true },
  })).status, 200);

  const token = `Bearer ${raw}`;
  // GET allowed (published, within 105).
  assert.equal((await dispatch(p, { method: "GET", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}`, authorization: token, body: undefined })).status, 200);
  // POST operation denied — token has no POST/operations scope.
  assert.equal((await dispatch(p, { method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/operations`, authorization: token, body: { type: "note" } })).status, 403);
});

test("unknown route and unknown registry are handled", async () => {
  const { platform: p } = await platform();
  assert.equal((await dispatch(p, { method: "GET", url: "/nope", body: undefined })).status, 404);
  assert.equal((await dispatch(p, { method: "GET", url: "/api/registries/ghost/published", body: undefined })).status, 404);
});
