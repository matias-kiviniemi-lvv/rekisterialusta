/**
 * Authorization enforcement (Architecture §6).
 *
 * The ONE place both authorization models live, so portals and the REST API
 * share it (Decision: single enforcement point). Two populations, two rules:
 *   - customers: ownership — must be a party on the case (§6.2), equal rights.
 *   - workers:   category — case category must fall within one of the worker's
 *                grants via prefix containment, with inheritance (§6.3).
 *
 * Both are evaluated as index-friendly SQL prefix tests over the normalized
 * category path, not graph walks.
 */

import type { Db, DbAdapter } from "../db/db.ts";
import { dialectFor } from "../db/dialect.ts";
import { normalizePath } from "../domain/categories.ts";

export interface WorkerAccess {
  readonly allowed: boolean;
}

/** Does the customer own (is a party to) this case? */
export async function customerOwnsCase(
  shared: DbAdapter,
  registryDb: DbAdapter,
  caseKey: bigint,
  customerId: string,
): Promise<boolean> {
  const active = await shared.get("SELECT 1 AS ok FROM customers WHERE customer_id = ? AND active = 1", [customerId]);
  if (!active) return false;
  const d = dialectFor(registryDb.dialect);
  const row = await registryDb.get(
    d.limitOne("SELECT 1 AS ok FROM case_parties WHERE case_key = ? AND customer_id = ?"),
    [caseKey, customerId],
  );
  return !!row;
}

/**
 * May the worker act on a case in `caseCategory` with the given permission?
 * A grant on a parent category covers all descendants (prefix containment).
 *
 * We fetch the worker's granted category paths from the shared DB and test
 * containment. In production the containment test is pushed into SQL
 * (path LIKE grant || '%'); done here in code over the small grant set for
 * clarity and because a worker holds few grants.
 */
export async function workerCanAccessCategory(
  shared: Db,
  workerId: string,
  registryId: string,
  caseCategory: string,
  permission: "read" | "write" | "transition" | "approve",
  at = new Date().toISOString(),
): Promise<boolean> {
  const permCol = {
    read: "can_read",
    write: "can_write",
    transition: "can_transition",
    approve: "can_approve",
  }[permission];

  const grants = await shared.all(
    `SELECT c.path AS path
       FROM worker_authorizations wa
       JOIN categories c ON c.category_id = wa.category_id
       JOIN workers w ON w.worker_id = wa.worker_id
      WHERE wa.worker_id = ? AND wa.registry_id = ? AND wa.${permCol} = 1
        AND w.active = 1 AND c.active = 1
        AND (wa.valid_from IS NULL OR wa.valid_from <= ?)
        AND (wa.valid_until IS NULL OR wa.valid_until >= ?)`,
    [workerId, registryId, at, at],
  );

  const casePath = normalizePath(caseCategory);
  return grants.some((g) => casePath.startsWith(String(g.path)));
}
