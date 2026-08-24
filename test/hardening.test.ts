import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapFromEnv, buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import { workerCanAccessCategory } from "../src/core/authorization.ts";
import { getCaseByDiaryNumber, getCaseHistory } from "../src/core/queries.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const customer = (id: string) => `Bearer customer:${id}`;
const worker = (id: string) => `Bearer worker:${id}`;
const createBody = {
  category: "105.04.03",
  initialState: "received",
  fields: { applicant_name: "Private Applicant", permit_kind: "water", site_address: "Secret 1", fee_paid: false },
};

test("customer input cannot choose lifecycle state, parties, transitions, or generic operations", async () => {
  const { platform } = await buildSamplePlatform(fixedClock(NOW));

  const closed = await dispatch(platform, {
    method: "POST", url: "/api/registries/permit/cases", authorization: customer("c-1"),
    body: { ...createBody, initialState: "closed" },
  });
  assert.equal(closed.status, 400);

  const forgedParty = await dispatch(platform, {
    method: "POST", url: "/api/registries/permit/cases", authorization: customer("c-1"),
    body: { ...createBody, parties: [{ customerId: "c-2", role: "applicant" }] },
  });
  assert.equal(forgedParty.status, 400);

  const created = await dispatch(platform, {
    method: "POST", url: "/api/registries/permit/cases", authorization: customer("c-1"), body: createBody,
  });
  const diary = (created.body as { diaryNumber: string }).diaryNumber;
  assert.equal((await dispatch(platform, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/transition`,
    authorization: customer("c-1"), body: { toState: "in_preparation" },
  })).status, 403);
  assert.equal((await dispatch(platform, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/operations`,
    authorization: customer("c-1"), body: { direction: "outgoing", type: "official_decision" },
  })).status, 403);
});

test("public reads contain only explicitly selected fields and operations", async () => {
  const { platform, db } = await buildSamplePlatform(fixedClock(NOW));
  const created = await dispatch(platform, {
    method: "POST", url: "/api/registries/permit/cases", authorization: worker("w-anna"), body: createBody,
  });
  const diary = (created.body as { diaryNumber: string }).diaryNumber;
  await dispatch(platform, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/operations`,
    authorization: worker("w-anna"), body: { type: "private_note", comment: "not public" },
  });

  const ineligible = await dispatch(platform, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/publish`,
    authorization: worker("w-anna"), body: { publish: true, fields: ["fee_paid"] },
  });
  assert.equal(ineligible.status, 400);

  assert.equal((await dispatch(platform, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/publish`,
    authorization: worker("w-anna"), body: { publish: true, fields: ["permit_kind"], operations: [1] },
  })).status, 200);

  const publicRead = await dispatch(platform, {
    method: "GET", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}`, body: undefined,
  });
  assert.equal(publicRead.status, 200);
  const result = publicRead.body as { case: Record<string, unknown>; history: Array<Record<string, unknown>> };
  assert.deepEqual(result.case.fields, { permit_kind: "water" });
  assert.equal("caseKey" in result.case, false);
  assert.equal("version" in result.case, false);
  assert.equal("modified" in result.case, false);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0]?.type, "case_created");
  assert.equal(result.history[0]?.actorKind, "published");

  assert.ok(Number((await db.get("SELECT COUNT(*) AS n FROM audit_events"))?.n) >= 3);
  assert.ok(Number((await db.get("SELECT COUNT(*) AS n FROM outbox"))?.n) >= 3);
});

test("anonymous metadata omits restricted fields and internal workflow configuration", async () => {
  const { platform } = await buildSamplePlatform(fixedClock(NOW));
  const response = await dispatch(platform, {
    method: "GET", url: "/api/registries/permit/meta", body: undefined,
  });
  assert.equal(response.status, 200);
  const meta = response.body as { fields: Array<{ name: string }>; transitions: unknown[]; forms: unknown[]; categories: Array<{ code: string }> };
  assert.equal(meta.fields.some((field) => field.name === "fee_paid"), false);
  assert.deepEqual(meta.transitions, []);
  assert.deepEqual(meta.forms, []);
  assert.equal(meta.categories.some((category) => category.code.startsWith("300")), false);
});

test("worker grants are isolated by registry and validity interval", async () => {
  const { platform, shared } = await buildSamplePlatform(fixedClock(NOW));
  assert.equal(await workerCanAccessCategory(shared, "w-anna", "grant", "105.04.03", "read", NOW), false);

  await shared.run(
    "INSERT INTO worker_authorizations (worker_id, registry_id, category_id, valid_until) VALUES (?, ?, ?, ?)",
    ["w-bo", "permit", "105", "2026-01-01T00:00:00.000Z"],
  );
  assert.equal(await workerCanAccessCategory(shared, "w-bo", "permit", "105.04.03", "read", NOW), false);
  assert.equal((await dispatch(platform, {
    method: "POST", url: "/api/registries/permit/cases", authorization: worker("w-bo"), body: createBody,
  })).status, 403);
});

test("state transition and cascading rules roll back as one transaction", async () => {
  const { platform, db } = await buildSamplePlatform(fixedClock(NOW));
  for (const rule of [
    { ruleId: "loop-to-waiting", onToState: "in_preparation", condition: null, actionType: "set_state", actionParams: { toState: "waiting_customer" } },
    { ruleId: "loop-to-preparation", onToState: "waiting_customer", condition: null, actionType: "set_state", actionParams: { toState: "in_preparation" } },
  ]) {
    assert.equal((await dispatch(platform, {
      method: "POST", url: "/api/admin/registries/permit/rules", authorization: worker("w-admin"), body: rule,
    })).status, 201);
  }

  const created = await dispatch(platform, {
    method: "POST", url: "/api/registries/permit/cases", authorization: worker("w-anna"), body: createBody,
  });
  const diary = (created.body as { diaryNumber: string }).diaryNumber;
  const transition = await dispatch(platform, {
    method: "POST", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}/transition`,
    authorization: worker("w-anna"), body: { toState: "in_preparation" },
  });
  assert.equal(transition.status, 400);
  assert.match(String((transition.body as { error: string }).error), /RULE_CASCADE_LIMIT/);

  const c = await getCaseByDiaryNumber(db, diary);
  assert.equal(c?.state, "received");
  assert.equal((await getCaseHistory(db, c!.caseKey)).length, 1);
});

test("trust zones hide privileged routes and production bootstrap fails closed", async () => {
  const { platform } = await buildSamplePlatform(fixedClock(NOW));
  assert.equal((await dispatch(platform, {
    method: "GET", url: "/api/registries/permit/worker/cases", authorization: worker("w-anna"),
    body: undefined, trustZone: "public",
  })).status, 404);
  assert.equal((await dispatch(platform, {
    method: "GET", url: "/api/registries", authorization: customer("c-1"),
    body: undefined, trustZone: "integration",
  })).status, 404);

  const silent = { info() {}, error() {} };
  await assert.rejects(
    () => bootstrapFromEnv(fixedClock(NOW), silent, { environment: "production" }),
    /explicit IdentityProvider/,
  );
  await assert.rejects(
    () => bootstrapFromEnv(fixedClock(NOW), silent, { environment: "production", identity: { resolve: () => undefined } }),
    /explicit BlobStore/,
  );
});
