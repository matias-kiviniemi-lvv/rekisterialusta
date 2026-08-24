import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const asWorker = (id: string) => `Bearer worker:${id}`;
const asCustomer = (id: string) => `Bearer customer:${id}`;

// The Grant registry was added purely as configuration (config/registries/grant.ts)
// with no application-code change — it runs on the same engine as Permit.
test("the second registry (Grant) works end-to-end via config only", async () => {
  const { platform: p, dbs } = await buildSamplePlatform(fixedClock(NOW));

  // Different diary format (GRANT-YYYY-NNNNNN), different fields, own database.
  const created = await dispatch(p, {
    method: "POST", url: "/api/registries/grant/cases", authorization: asWorker("w-cara"),
    body: { category: "300.01", initialState: "submitted", fields: { organisation: "Choir Society", amount_requested: 5000, purpose: "Spring concert" } },
  });
  assert.equal(created.status, 201);
  const diary = (created.body as { diaryNumber: string }).diaryNumber;
  assert.match(diary, /^GRANT-2026-\d{6}$/);

  // Its own state machine: submitted -> under_review -> granted, then the
  // grant registry's own rule flags it for audit (create_operation).
  const url = `/api/registries/grant/cases/${encodeURIComponent(diary)}/transition`;
  assert.equal((await dispatch(p, { method: "POST", url, authorization: asWorker("w-cara"), body: { toState: "under_review" } })).status, 200);
  const granted = await dispatch(p, { method: "POST", url, authorization: asWorker("w-cara"), body: { toState: "granted" } });
  assert.equal(granted.status, 200);
  assert.equal((granted.body as { rulesFired: number }).rulesFired, 1);

  // Grant and Permit are isolated: a grant case has no row in the permit DB.
  assert.equal((await dbs.permit!.get("SELECT COUNT(*) AS n FROM cases"))?.n, 0);
  assert.equal((await dbs.grant!.get("SELECT COUNT(*) AS n FROM cases"))?.n, 1);
});

test("registries are isolated: a permit worker cannot act in grant categories", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  // Anna is authorized on 105 (permits), not on 300 (grants).
  const r = await dispatch(p, {
    method: "POST", url: "/api/registries/grant/cases", authorization: asWorker("w-anna"),
    body: { category: "300.01", initialState: "submitted", fields: { organisation: "X", amount_requested: 1, purpose: "Y" } },
  });
  assert.equal(r.status, 403);
});

test("grant registry's own form works (provide-iban, no approval)", async () => {
  const { platform: p, dbs } = await buildSamplePlatform(fixedClock(NOW));
  const diary = ((await dispatch(p, {
    method: "POST", url: "/api/registries/grant/cases", authorization: asCustomer("c-1"),
    body: { category: "300.01", initialState: "submitted", fields: { organisation: "Choir", amount_requested: 100, purpose: "P" } },
  })).body as { diaryNumber: string }).diaryNumber;

  const r = await dispatch(p, {
    method: "POST", url: "/api/registries/grant/forms/provide-iban/submit", authorization: asCustomer("c-1"),
    body: { diaryNumber: diary, fields: { iban: "FI2112345600000785" } },
  });
  assert.equal(r.status, 200); // no approval required -> applied immediately
  assert.equal((await dbs.grant!.get("SELECT iban FROM cases WHERE diary_number = ?", [diary]))?.iban, "FI2112345600000785");
});
