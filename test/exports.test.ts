import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import { exportAllRegistries } from "../src/services/exports.ts";

const NOW = "2026-08-11T09:00:00.000Z";
const asWorker = (id: string) => `Bearer worker:${id}`;

async function seed(p: Awaited<ReturnType<typeof buildSamplePlatform>>["platform"]) {
  await dispatch(p, { method: "POST", url: "/api/registries/permit/cases", authorization: asWorker("w-anna"), body: { category: "105.04.03", initialState: "received", fields: { applicant_name: "A", permit_kind: "water", fee_paid: false } } });
  await dispatch(p, { method: "POST", url: "/api/registries/permit/cases", authorization: asWorker("w-anna"), body: { category: "105", initialState: "received", fields: { applicant_name: "B", permit_kind: "air", fee_paid: true } } });
  await dispatch(p, { method: "POST", url: "/api/registries/grant/cases", authorization: asWorker("w-cara"), body: { category: "300.01", initialState: "submitted", fields: { organisation: "Choir", amount_requested: 500, purpose: "Concert" } } });
}

test("scheduled export writes CSV for every registry and logs each run", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  await seed(p);

  const results = await exportAllRegistries(p, NOW);
  assert.equal(results.length, 2); // permit + grant
  const byId = Object.fromEntries(results.map((r) => [r.registryId, r]));
  assert.equal(byId.permit!.status, "ok");
  assert.equal(byId.permit!.caseCount, 2);
  assert.equal(byId.grant!.status, "ok");
  assert.equal(byId.grant!.caseCount, 1);

  // The CSV is in the blob store and has a header + one line per case.
  const csv = new TextDecoder().decode(p.blobs.get(byId.permit!.casesBlobKey!)!);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3); // header + 2 cases
  assert.ok(lines[0]!.includes("diary_number"));
  assert.ok(lines[0]!.includes("applicant_name")); // registry-specific typed column exported

  // Each run is logged in export_runs (visible, not silent).
  const runs = await p.shared.all("SELECT registry_id, status, case_count FROM export_runs ORDER BY registry_id");
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => String(r.status) === "ok"));
});

test("an export run for an empty registry still succeeds with a header-only CSV", async () => {
  const { platform: p } = await buildSamplePlatform(fixedClock(NOW));
  const results = await exportAllRegistries(p, NOW);
  const permit = results.find((r) => r.registryId === "permit")!;
  assert.equal(permit.status, "ok");
  assert.equal(permit.caseCount, 0);
  const csv = new TextDecoder().decode(p.blobs.get(permit.casesBlobKey!)!);
  assert.equal(csv.trim().split("\n").length, 1); // header only
});
