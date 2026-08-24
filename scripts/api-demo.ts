/**
 * End-to-end API demo (Phase 2 + Phase 3) — everything through the REST
 * dispatch layer, exactly as the portals and integrations would call it.
 *   node --experimental-strip-types scripts/api-demo.ts
 *
 * Shows: two auth systems, method+category token scope, forms with approval,
 * the rule engine firing on state change, and the published surface.
 */

import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import { mintApiToken } from "../src/api/tokens.ts";

const log = (s: string) => process.stdout.write(s + "\n");
const { platform, db } = await buildSamplePlatform(fixedClock("2026-08-11T09:00:00.000Z"));
const call = (method: string, url: string, auth: string | undefined, body?: unknown) =>
  dispatch(platform, { method, url, authorization: auth, body });
const worker = (id: string) => `Bearer worker:${id}`;
const customer = (id: string) => `Bearer customer:${id}`;

// 1) Citizen One opens a case through the customer path.
const created = await call("POST", "/api/registries/permit/cases", customer("c-1"), {
  category: "105.04.03", initialState: "received",
  fields: { applicant_name: "Citizen One", permit_kind: "water abstraction", fee_paid: true },
});
const diary = (created.body as { diaryNumber: string }).diaryNumber;
log(`[${created.status}] Citizen One opened ${diary}`);

// 2) Ownership isolation over the API.
log(`[${(await call("GET", `/api/registries/permit/cases/${enc(diary)}`, customer("c-1"))).status}] owner reads own case`);
log(`[${(await call("GET", `/api/registries/permit/cases/${enc(diary)}`, customer("c-2"))).status}] other citizen blocked (expect 403)`);

// 3) Citizen submits an approval-required address change (staged, not applied).
const submit = await call("POST", "/api/registries/permit/forms/update-site-address/submit", customer("c-1"), { diaryNumber: diary, fields: { site_address: "Rantatie 5" } });
log(`[${submit.status}] address change staged for approval (expect 202)`);
log(`   site_address now = ${JSON.stringify((await db.get("SELECT site_address FROM cases WHERE diary_number = ?", [diary]))?.site_address)} (still null)`);

// 4) Worker Anna (authorized on 105) approves it → applied.
log(`[${(await call("POST", "/api/registries/permit/pending/1/approve", worker("w-anna"))).status}] Anna approves`);
log(`   site_address now = ${JSON.stringify((await db.get("SELECT site_address FROM cases WHERE diary_number = ?", [diary]))?.site_address)}`);

// 5) Anna drives the lifecycle; reaching 'decided' with fee_paid=true triggers auto-close.
const url = `/api/registries/permit/cases/${enc(diary)}/transition`;
await call("POST", url, worker("w-anna"), { toState: "in_preparation" });
const decided = await call("POST", url, worker("w-anna"), { toState: "decided" });
log(`[${decided.status}] Anna → decided; rules fired = ${(decided.body as { rulesFired: number }).rulesFired}`);
log(`   state is now = ${(await db.get("SELECT state FROM cases WHERE diary_number = ?", [diary]))?.state} (rule auto-closed it)`);

// 6) Publish an explicit read-model projection, then read it via a
// method+category-scoped API token.
await call("POST", `/api/registries/permit/cases/${enc(diary)}/publish`, worker("w-anna"), {
  publish: true, fields: ["permit_kind", "site_address"], operations: [1],
});
const { raw } = await mintApiToken(platform.shared, { registryId: "permit", methods: ["GET"], resources: ["cases"], categoryScope: "105", publishedOnly: true }, "2026-08-11T09:00:00.000Z");
log(`[${(await call("GET", `/api/registries/permit/cases/${enc(diary)}`, `Bearer ${raw}`)).status}] integration token (GET,105,published) reads it`);
log(`[${(await call("POST", `/api/registries/permit/cases/${enc(diary)}/operations`, `Bearer ${raw}`, { type: "note" })).status}] same token cannot POST (expect 403)`);
log(`   public search returns ${(((await call("GET", "/api/registries/permit/published", undefined)).body as { cases: unknown[] }).cases).length} published case(s)`);

log("\napi-demo complete.");

function enc(s: string): string {
  return encodeURIComponent(s);
}
