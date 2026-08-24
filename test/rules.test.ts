import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import { getCaseByDiaryNumber, getCaseHistory } from "../src/core/queries.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const asWorker = (id: string) => `Bearer worker:${id}`;

async function seedAndAdvance(feePaid: boolean) {
  const { platform: p, db } = await buildSamplePlatform(fixedClock(NOW));
  const created = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/cases", authorization: asWorker("w-anna"),
    body: { category: "105.04.03", initialState: "received", fields: { applicant_name: "A", permit_kind: "water", fee_paid: feePaid } },
  });
  const diary = (created.body as { diaryNumber: string }).diaryNumber;
  const url = `/api/registries/permit/cases/${encodeURIComponent(diary)}/transition`;
  await dispatch(p, { method: "POST", url, authorization: asWorker("w-anna"), body: { toState: "in_preparation" } });
  return { p, db, diary, url };
}

test("set_state rule auto-closes a decided case when its condition holds (fee paid)", async () => {
  const { p, db, diary, url } = await seedAndAdvance(true);
  const r = await dispatch(p, { method: "POST", url, authorization: asWorker("w-anna"), body: { toState: "decided" } });
  assert.equal(r.status, 200);
  assert.equal((r.body as { rulesFired: number }).rulesFired, 1);
  // The autoclose rule moved decided -> closed via the state machine.
  const c = (await getCaseByDiaryNumber(db, diary))!;
  assert.equal(c.state, "closed");
  // History shows the worker's transition to decided AND the rule's transition to closed.
  const types = (await getCaseHistory(db, c.caseKey)).map((o) => o.type);
  assert.ok(types.filter((t) => t === "state_change").length >= 2);
});

test("condition gates the rule: unpaid decided case stays decided", async () => {
  const { p, db, diary, url } = await seedAndAdvance(false);
  const r = await dispatch(p, { method: "POST", url, authorization: asWorker("w-anna"), body: { toState: "decided" } });
  assert.equal(r.status, 200);
  assert.equal((r.body as { rulesFired: number }).rulesFired, 0);
  assert.equal((await getCaseByDiaryNumber(db, diary))!.state, "decided");
});

test("notify rule fires (as a recorded action) on reaching waiting_customer", async () => {
  const { p, db, diary, url } = await seedAndAdvance(false);
  await dispatch(p, { method: "POST", url, authorization: asWorker("w-anna"), body: { toState: "waiting_customer" } });
  const c = (await getCaseByDiaryNumber(db, diary))!;
  const actions = (await getCaseHistory(db, c.caseKey)).filter((o) => o.type === "rule_action");
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.subtype, "notify_customer");
});
