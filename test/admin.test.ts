import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const asWorker = (id: string) => `Bearer worker:${id}`;

test("non-admin is refused on management endpoints", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const r = await dispatch(p, { method: "POST", url: "/api/registries/permit/fields".replace("registries", "admin/registries"), authorization: asWorker("w-anna"), body: { name: "x", type: "text", nullable: true } });
  // path: /api/admin/registries/permit/fields
  assert.equal(r.status, 403);
});

test("admin adds a statutory field (config-driven schema migration) and it becomes usable", async () => {
  const { platform: p, dbs } = await buildSamplePlatform(fixedClock(NOW));

  const add = await dispatch(p, {
    method: "POST", url: "/api/admin/registries/permit/fields", authorization: asWorker("w-admin"),
    body: {
      name: "coordinate", type: "text", nullable: true,
      writableOnCreate: true, writableOnUpdate: true, publicationEligible: false,
      legalBasis: "statutory permit processing", purpose: "site location",
      sensitivity: "normal", retentionPolicy: "permit-case-retention",
    },
  });
  assert.equal(add.status, 201);
  assert.deepEqual((add.body as { addedColumns: string[] }).addedColumns, ["coordinate"]);
  assert.equal((add.body as { version: number }).version, 2); // version bumped

  // The new column exists and can be written on case creation.
  const cols = (await dbs.permit!.all("PRAGMA table_info(cases)")).map((r) => String(r.name));
  assert.ok(cols.includes("coordinate"));

  const created = await dispatch(p, {
    method: "POST", url: "/api/registries/permit/cases", authorization: asWorker("w-admin"),
    body: { category: "105.04.03", initialState: "received", fields: { applicant_name: "A", permit_kind: "water", fee_paid: false, coordinate: "60.1,24.9" } },
  });
  assert.equal(created.status, 201);
});

test("admin adds a state + transition and a case can use it", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  assert.equal((await dispatch(p, { method: "POST", url: "/api/admin/registries/permit/states", authorization: asWorker("w-admin"), body: { id: "appealed", name: "Appealed", isOpen: true } })).status, 201);
  assert.equal((await dispatch(p, { method: "POST", url: "/api/admin/registries/permit/transitions", authorization: asWorker("w-admin"), body: { from: "decided", to: "appealed" } })).status, 201);

  const diary = ((await dispatch(p, { method: "POST", url: "/api/registries/permit/cases", authorization: asWorker("w-admin"), body: { category: "105", initialState: "received", fields: { applicant_name: "A", permit_kind: "w", fee_paid: false } } })).body as { diaryNumber: string }).diaryNumber;
  const url = `/api/registries/permit/cases/${encodeURIComponent(diary)}/transition`;
  for (const to of ["in_preparation", "decided", "appealed"]) {
    assert.equal((await dispatch(p, { method: "POST", url, authorization: asWorker("w-admin"), body: { toState: to } })).status, 200);
  }
});

test("admin mints a scoped API token and can revoke it", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  // A token that may read UNPUBLISHED cases under 105 — access public lacks.
  const minted = await dispatch(p, {
    method: "POST", url: "/api/admin/registries/permit/tokens", authorization: asWorker("w-admin"),
    body: { methods: ["GET"], resources: ["cases"], categoryScope: "105", publishedOnly: false, description: "internal reader" },
  });
  assert.equal(minted.status, 201);
  const { tokenId, raw } = minted.body as { tokenId: string; raw: string };
  assert.match(raw, /^rk_/);

  const diary = ((await dispatch(p, { method: "POST", url: "/api/registries/permit/cases", authorization: asWorker("w-admin"), body: { category: "105.04.03", initialState: "received", fields: { applicant_name: "A", permit_kind: "w", fee_paid: false } } })).body as { diaryNumber: string }).diaryNumber;
  const url = `/api/registries/permit/cases/${encodeURIComponent(diary)}`;

  // Before revoke: the token reads the unpublished case.
  assert.equal((await dispatch(p, { method: "GET", url, authorization: `Bearer ${raw}`, body: undefined })).status, 200);
  // Revoke.
  assert.equal((await dispatch(p, { method: "POST", url: `/api/admin/registries/permit/tokens/${tokenId}/revoke`, authorization: asWorker("w-admin"), body: {} })).status, 200);
  // After revoke: the token is unknown -> treated as public -> unpublished case is forbidden.
  assert.equal((await dispatch(p, { method: "GET", url, authorization: `Bearer ${raw}`, body: undefined })).status, 403);
});
