/**
 * Run the Registry Platform with the MVP web console.
 *   node --experimental-strip-types scripts/serve.ts [port]
 * then open http://localhost:8080
 *
 * The database is chosen by ENVIRONMENT (src/config/db-config.ts) — same as the
 * rest of the platform — via bootstrapFromEnv(), so all three run modes work
 * here without editing code:
 *
 *   mode 1 (sandbox)   DB_DIALECT unset, no DB_DIR  → in-memory SQLite (default).
 *                      Demo data is seeded and resets on restart.
 *   on-disk SQLite     DB_DIR=./data               → persists across restarts.
 *   mode 2 (local)     DB_DIALECT=sqlserver + SQLSERVER_USER/PASSWORD
 *   mode 3 (Azure RBAC)DB_DIALECT=sqlserver + SQLSERVER_AUTH=managed-identity
 *
 * To load a .env file: `node --env-file=.env --experimental-strip-types scripts/serve.ts`.
 *
 * Demo seeding (a few cases so the portals aren't empty) runs ONLY on the
 * ephemeral in-memory DB. Against any persistent target we don't auto-insert
 * demo cases — you manage your own data. Master data (workers/customers) is
 * seeded once by bootstrapFromEnv on a fresh DB and skipped thereafter.
 * Use the "Acting as" switch in the UI to move between customer/worker/admin/public.
 */

import { bootstrapFromEnv, fixedClock } from "../src/bootstrap.ts";
import { loadDbConfig } from "../src/config/db-config.ts";
import { createServer } from "../src/api/server.ts";
import { dispatch } from "../src/api/server.ts";

const port = Number(process.argv[2] ?? 8080);

// Ephemeral = in-memory SQLite (no persistence). Only then do we seed demo data.
const dbConfig = loadDbConfig();
const isEphemeral = dbConfig.dialect === "sqlite" && !process.env.DB_DIR;

const { platform } = await bootstrapFromEnv(fixedClock(new Date().toISOString()));

function call(method: string, url: string, bearer: string | undefined, body?: unknown) {
  return dispatch(platform, { method, url, authorization: bearer ? `Bearer ${bearer}` : undefined, body });
}

// --- seed demo data ---------------------------------------------------------
async function seed(): Promise<void> {
  // Permit: two citizen cases; a worker advances and publishes one.
  const p1 = (await call("POST", "/api/registries/permit/cases", "customer:c-1", { category: "105.04.03", initialState: "received", fields: { applicant_name: "Citizen One", permit_kind: "water abstraction", site_address: "Rantatie 5", fee_paid: true } })).body as { diaryNumber: string };
  await call("POST", "/api/registries/permit/cases", "customer:c-1", { category: "105.04", initialState: "received", fields: { applicant_name: "Citizen One", permit_kind: "discharge", fee_paid: false } });
  await call("POST", "/api/registries/permit/cases", "customer:c-2", { category: "105", initialState: "received", fields: { applicant_name: "Citizen Two", permit_kind: "noise", fee_paid: false } });
  const u1 = `/api/registries/permit/cases/${encodeURIComponent(p1.diaryNumber)}`;
  await call("POST", u1 + "/assign", "worker:w-anna");
  await call("POST", u1 + "/transition", "worker:w-anna", { toState: "in_preparation" });
  await call("POST", u1 + "/transition", "worker:w-anna", { toState: "waiting_customer", comment: "Need proof of ownership" });
  await call("POST", u1 + "/publish", "worker:w-anna", { publish: true });

  // Grant: a citizen application Cara moves into review.
  const g1 = (await call("POST", "/api/registries/grant/cases", "customer:c-1", { category: "300.01", initialState: "submitted", fields: { organisation: "Choir Society", amount_requested: 5000, purpose: "Spring concert" } })).body as { diaryNumber: string };
  await call("POST", `/api/registries/grant/cases/${encodeURIComponent(g1.diaryNumber)}/transition`, "worker:w-cara", { toState: "under_review" });
}

if (isEphemeral) await seed();

const trustZone = (process.env.TRUST_ZONE ?? "combined") as "combined" | "public" | "worker" | "integration";
createServer(platform, undefined, { trustZone }).listen(port, () => {
  process.stdout.write(`\n  Registry Platform console → http://localhost:${port}\n`);
  process.stdout.write(`  DB: ${describeDb()}\n`);
  process.stdout.write(`  Trust zone: ${trustZone}\n`);
  if (isEphemeral) {
    process.stdout.write(`  Seeded: permit + grant demo cases. Data resets on restart.\n\n`);
  } else {
    process.stdout.write(`  Persistent DB — no demo seeding; your data is kept across restarts.\n\n`);
  }
});

/** One-line description of the active target for the startup banner. */
function describeDb(): string {
  if (dbConfig.dialect === "sqlite") {
    return process.env.DB_DIR ? `on-disk SQLite (DB_DIR=${process.env.DB_DIR})` : "in-memory SQLite (ephemeral)";
  }
  const auth = (process.env.SQLSERVER_AUTH ?? "sql").toLowerCase();
  const mode = auth === "sql" ? "username/password" : "managed identity (RBAC)";
  return `SQL Server ${process.env.SQLSERVER_HOST ?? "localhost"} — ${mode}`;
}
