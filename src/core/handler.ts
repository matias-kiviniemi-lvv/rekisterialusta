/**
 * Walking-skeleton stateless handler (Architecture §1, §13; Plan Phase 0/2).
 *
 * This is the shape every portal/API endpoint takes: a STATELESS function that
 *   1. receives a request with an authenticated actor,
 *   2. authorizes it in the platform core (never trusting the caller),
 *   3. reads/writes domain data through the DbAdapter,
 *   4. returns a plain result — no server-side session state.
 *
 * It holds no state between calls, so it scales horizontally on serverless
 * (Flex Functions). Here it is a plain function; wiring it to an HTTP trigger
 * is an infrastructure detail added in a later phase.
 */

import type { DbAdapter } from "../db/db.ts";
import { customerOwnsCase, workerCanAccessCategory } from "./authorization.ts";
import { getCaseByDiaryNumber, getCaseHistory, type CaseView, type OperationView } from "./queries.ts";

export type Actor =
  | { kind: "customer"; customerId: string }
  | { kind: "worker"; workerId: string }
  | { kind: "public" };

export interface GetCaseRequest {
  readonly diaryNumber: string;
  readonly actor: Actor;
}

export type GetCaseResult =
  | { status: "ok"; case: CaseView; history: OperationView[] }
  | { status: "not_found" }
  | { status: "forbidden" };

/**
 * Return a case + history if the actor is allowed to see it.
 * Enforces the two authorization models and the published-vs-private boundary.
 */
export async function handleGetCase(
  shared: DbAdapter,
  registryDb: DbAdapter,
  req: GetCaseRequest,
): Promise<GetCaseResult> {
  const c = await getCaseByDiaryNumber(registryDb, req.diaryNumber);
  if (!c) return { status: "not_found" };

  const allowed = await isAllowedToView(shared, registryDb, c, req.actor);
  if (!allowed) return { status: "forbidden" };

  return { status: "ok", case: c, history: await getCaseHistory(registryDb, c.caseKey) };
}

async function isAllowedToView(
  shared: DbAdapter,
  registryDb: DbAdapter,
  c: CaseView,
  actor: Actor,
): Promise<boolean> {
  switch (actor.kind) {
    case "public":
      return c.isPublished; // nothing private is ever public (§5.7)
    case "customer":
      return await customerOwnsCase(shared, registryDb, c.caseKey, actor.customerId);
    case "worker":
      // The legacy walking-skeleton does not carry a registry handle; resolve it
      // from the catalog using the registry database's case namespace.
      const catalog = await shared.get("SELECT registry_id FROM registry_catalog ORDER BY registry_id");
      return !!catalog && await workerCanAccessCategory(shared, actor.workerId, String(catalog.registry_id), c.category, "read");
  }
}
