/**
 * Worker-portal read queries (Architecture §5.6).
 *
 * The worker portal shows three slices, all bounded by the worker's category
 * authorization: cases assigned to me, the full set I'm authorized to see, and
 * unassigned cases in the categories I've opted into. Plus pending customer
 * submissions I may approve.
 *
 * Categories/authorizations live in the shared DB and cases in the registry DB
 * (separate databases), so we cannot JOIN across them: we read the worker's
 * grant codes from shared, then filter registry rows by prefix containment in
 * code. Fine at portal scale; the production SQL adapter pushes this into an
 * indexed path prefix test.
 */

import type { Db } from "../db/db.ts";
import { isWithin } from "../domain/categories.ts";
import type { CaseView } from "./queries.ts";

interface Grant {
  code: string;
  optedIn: boolean;
  canApprove: boolean;
}

async function workerGrants(shared: Db, workerId: string, registryId: string, at: string): Promise<Grant[]> {
  return (
    await shared.all(
      `SELECT c.display_code AS code, wa.opted_in AS opted_in, wa.can_approve AS can_approve
         FROM worker_authorizations wa
         JOIN categories c ON c.category_id = wa.category_id
         JOIN workers w ON w.worker_id = wa.worker_id
        WHERE wa.worker_id = ? AND wa.registry_id = ? AND wa.can_read = 1
          AND w.active = 1 AND c.active = 1
          AND (wa.valid_from IS NULL OR wa.valid_from <= ?)
          AND (wa.valid_until IS NULL OR wa.valid_until >= ?)`,
      [workerId, registryId, at, at],
    )
  ).map((r) => ({ code: String(r.code), optedIn: Number(r.opted_in) === 1, canApprove: Number(r.can_approve) === 1 }));
}

const CASE_COLS = "case_key, diary_number, category, state, is_published, created, modified, version";

function toCaseView(row: Record<string, unknown>): CaseView {
  return {
    caseKey: BigInt(row.case_key as number),
    diaryNumber: String(row.diary_number),
    category: String(row.category),
    state: String(row.state),
    isPublished: Number(row.is_published) === 1,
    created: String(row.created),
    modified: String(row.modified),
    version: Number(row.version ?? 1),
  };
}

function within(category: string, grants: Grant[]): boolean {
  return grants.some((g) => isWithin(category, g.code));
}

/** All cases the worker is authorized to see (category prefix). */
export async function authorizedCases(shared: Db, regDb: Db, workerId: string, registryId: string, at: string): Promise<CaseView[]> {
  const grants = await workerGrants(shared, workerId, registryId, at);
  return (await regDb.all(`SELECT ${CASE_COLS} FROM cases ORDER BY created DESC`))
    .map(toCaseView)
    .filter((c) => within(c.category, grants));
}

/** Cases assigned to this worker (a handler row exists). */
export async function assignedCases(regDb: Db, workerId: string): Promise<CaseView[]> {
  return (
    await regDb.all(
      `SELECT ${CASE_COLS.split(", ").map((c) => "cs." + c).join(", ")}
         FROM cases cs JOIN case_handlers h ON h.case_key = cs.case_key
        WHERE h.worker_id = ? ORDER BY cs.created DESC`,
      [workerId],
    )
  ).map(toCaseView);
}

/** Unassigned cases in the worker's opted-in categories (§5.6). */
export async function unassignedOptedInCases(shared: Db, regDb: Db, workerId: string, registryId: string, at: string): Promise<CaseView[]> {
  const grants = (await workerGrants(shared, workerId, registryId, at)).filter((g) => g.optedIn);
  return (
    await regDb.all(`SELECT ${CASE_COLS} FROM cases WHERE case_key NOT IN (SELECT case_key FROM case_handlers) ORDER BY created DESC`)
  )
    .map(toCaseView)
    .filter((c) => within(c.category, grants));
}

export interface PendingView {
  pendingId: number;
  caseKey: number;
  diaryNumber: string;
  category: string;
  formId: string;
  payload: unknown;
  submittedBy: string;
  submittedAt: string;
}

/** Pending customer submissions the worker may approve (approve grant). */
export async function pendingToApprove(shared: Db, regDb: Db, workerId: string, registryId: string, at: string): Promise<PendingView[]> {
  const approveGrants = (await workerGrants(shared, workerId, registryId, at)).filter((g) => g.canApprove);
  return (
    await regDb.all(
      `SELECT p.pending_id, p.case_key, p.form_id, p.payload, p.submitted_by, p.submitted_at, c.diary_number, c.category
         FROM pending_case_updates p JOIN cases c ON c.case_key = p.case_key
        WHERE p.status = 'pending' ORDER BY p.submitted_at`,
    )
  )
    .filter((r) => within(String(r.category), approveGrants))
    .map((r) => ({
      pendingId: Number(r.pending_id),
      caseKey: Number(r.case_key),
      diaryNumber: String(r.diary_number),
      category: String(r.category),
      formId: String(r.form_id),
      payload: JSON.parse(String(r.payload)),
      submittedBy: String(r.submitted_by),
      submittedAt: String(r.submitted_at),
    }));
}
