/**
 * Phase 5 demo — multi-registry, management portal, config promotion, exports.
 *   node --experimental-strip-types scripts/phase5-demo.ts
 */

import { buildSamplePlatform, fixedClock } from "../src/bootstrap.ts";
import { dispatch } from "../src/api/server.ts";
import { exportAllRegistries } from "../src/services/exports.ts";
import { listConfigVersions } from "../src/services/config-promote.ts";

const log = (s: string) => process.stdout.write(s + "\n");
const { platform: p, dbs } = await buildSamplePlatform(fixedClock("2026-08-11T09:00:00.000Z"));
const call = (m: string, u: string, a: string | undefined, b?: unknown) => dispatch(p, { method: m, url: u, authorization: a, body: b });
const worker = (id: string) => `Bearer worker:${id}`;
const enc = encodeURIComponent;

log("TWO REGISTRIES ON ONE ENGINE (Grant added purely as config):");
const permit = await call("POST", "/api/registries/permit/cases", worker("w-anna"), { category: "105.04.03", initialState: "received", fields: { applicant_name: "Citizen One", permit_kind: "water", fee_paid: true } });
const grant = await call("POST", "/api/registries/grant/cases", worker("w-cara"), { category: "300.01", initialState: "submitted", fields: { organisation: "Choir Society", amount_requested: 5000, purpose: "Concert" } });
log(`  permit case: ${(permit.body as { diaryNumber: string }).diaryNumber}   (own DB, PERMIT/YYYY/NNNNN)`);
log(`  grant case:  ${(grant.body as { diaryNumber: string }).diaryNumber}   (own DB, GRANT-YYYY-NNNNNN)`);
log(`  isolation: permit DB has ${(await dbs.permit!.get("SELECT COUNT(*) AS n FROM cases"))?.n} case(s), grant DB has ${(await dbs.grant!.get("SELECT COUNT(*) AS n FROM cases"))?.n}`);

log("\nMANAGEMENT PORTAL (admin changes a registry without a release):");
const addField = await call("POST", "/api/admin/registries/permit/fields", worker("w-admin"), {
  name: "coordinate", type: "text", nullable: true,
  writableOnCreate: true, writableOnUpdate: true, publicationEligible: false,
  legalBasis: "statutory permit processing", purpose: "site location",
  sensitivity: "normal", retentionPolicy: "permit-case-retention",
});
log(`  [${addField.status}] admin added field 'coordinate' → config v${(addField.body as { version: number }).version}, columns added: ${JSON.stringify((addField.body as { addedColumns: string[] }).addedColumns)}`);
const addState = await call("POST", "/api/admin/registries/permit/states", worker("w-admin"), { id: "appealed", name: "Appealed", isOpen: true });
await call("POST", "/api/admin/registries/permit/transitions", worker("w-admin"), { from: "decided", to: "appealed" });
log(`  [${addState.status}] admin added state 'appealed' + transition decided→appealed`);
const nonAdmin = await call("POST", "/api/admin/registries/permit/fields", worker("w-anna"), { name: "x", type: "text" });
log(`  [${nonAdmin.status}] non-admin worker refused (expect 403)`);

log("\nCONFIG VERSIONS (the promotable, versioned artifact):");
for (const v of await listConfigVersions(p.shared, "permit")) log(`  permit v${v.version}: ${v.summary}`);

log("\nSCHEDULED CSV EXPORT (all registries):");
for (const r of await exportAllRegistries(p, "2026-08-11T09:00:00.000Z"))
  log(`  ${r.registryId.padEnd(7)} ${r.status}  ${r.caseCount} case(s) → ${r.casesBlobKey}`);

log("\nphase5-demo complete.");
