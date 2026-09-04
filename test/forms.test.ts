import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import { getCaseByDiaryNumber, getCaseHistory } from "../src/core/queries.ts";
import { validate } from "../src/domain/json-schema.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const asCustomer = (id: string) => `Bearer customer:${id}`;
const asWorker = (id: string) => `Bearer worker:${id}`;

test("operation property validation treats mandatory as non-empty and supports constraints", () => {
  const schema = {
    type: "object" as const,
    properties: {
      reference: { type: "string" as const, pattern: "^[A-Z]{2}$", errorMessage: "Use two capital letters" },
      amount: { type: "number" as const, minimum: 1, maximum: 10 },
    },
    required: ["reference"],
  };
  assert.deepEqual(validate(schema, { reference: "" }).errors, ['missing required property "reference"']);
  assert.deepEqual(validate(schema, { reference: "ab", amount: 11 }).errors, ["Use two capital letters", 'property "amount" must be at most 10']);
  assert.equal(validate(schema, { reference: "AB", amount: 5 }).valid, true);
});

test("forms have persistent common and type-specific models", async () => {
  const { platform } = await buildSamplePlatform(fixedClock(NOW));
  const base = await platform.shared.get("SELECT title, description FROM form_definitions WHERE form_id = ?", ["update-site-address"]);
  assert.equal(base?.title, "Update site address");
  assert.equal(base?.description, "Enter the new address for the permit site.");
  assert.equal(Number((await platform.shared.get("SELECT requires_approval FROM case_form_definitions WHERE form_id = ?", ["update-site-address"]))?.requires_approval), 1);
  assert.equal(Number((await platform.shared.get("SELECT allow_attachments FROM operation_form_definitions WHERE form_id = ?", ["submit-document"]))?.allow_attachments), 1);

  const response = await dispatch(platform, { method: "GET", url: "/api/registries/permit/meta", authorization: asWorker("w-admin"), body: undefined });
  const metadata = response.body as { caseForms: Array<{ description: string }>; operationForms: Array<{ operationType: string }> };
  assert.equal(metadata.caseForms[0]?.description, "Anna lupakohteen uusi osoite.");
  assert.equal(metadata.operationForms[0]?.operationType, "document");
});

test("a form with both audience is visible to customers and workers", async () => {
  const { platform } = await buildSamplePlatform(fixedClock(NOW));
  const created = await dispatch(platform, {
    method: "POST", url: "/api/admin/registries/permit/operation-forms", authorization: asWorker("w-admin"),
    body: { formId: "shared-note", title: "Shared note", description: "Add a note.", audience: "both", operationType: "note" },
  });
  assert.equal(created.status, 201);
  assert.equal((await platform.shared.get("SELECT audience FROM form_definitions WHERE form_id = ?", ["shared-note"]))?.audience, "both");

  for (const authorization of [asCustomer("c-1"), asWorker("w-anna")]) {
    const response = await dispatch(platform, { method: "GET", url: "/api/registries/permit/meta", authorization, body: undefined });
    const metadata = response.body as { operationForms: Array<{ formId: string }> };
    assert.ok(metadata.operationForms.some((form) => form.formId === "shared-note"));
  }
});

test("API tokens cannot submit forms with the combined audience", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const created = await dispatch(p, {
    method: "POST", url: "/api/admin/registries/permit/operation-forms", authorization: asWorker("w-admin"),
    body: { formId: "shared-token-test", title: "Shared note", description: "Add a note.", audience: "both", operationType: "note" },
  });
  assert.equal(created.status, 201);

  const minted = await dispatch(p, {
    method: "POST", url: "/api/admin/registries/grant/tokens", authorization: asWorker("w-admin"),
    body: { methods: ["POST"], resources: ["cases"], categoryScope: "300", publishedOnly: false },
  });
  const { raw } = minted.body as { raw: string };
  const submitted = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/forms/shared-token-test/submit", authorization: `Bearer ${raw}`,
    body: { category: "105.04.03", properties: {} },
  });
  assert.equal(submitted.status, 403);
  assert.deepEqual(submitted.body, { error: "actor authentication required" });
});

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

  const detail = await dispatch(p, {
    method: "GET", url: `/api/registries/permit/cases/${encodeURIComponent(diary)}`, authorization: asCustomer("c-1"), body: undefined,
  });
  const history = (detail.body as { history: Array<{ type: string; properties: unknown }> }).history;
  assert.deepEqual(history.find((operation) => operation.type === "document")?.properties, { documentTitle: "Deed", pages: 2 });

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
