/**
 * State-machine service (Architecture §4).
 *
 * The SINGLE code path allowed to change a case's state. It verifies a
 * configured transition exists, applies the change, and writes the transition
 * to history — all in one transaction, so state and history never diverge.
 * Rule-engine "set state" actions route through here too (Decision D-07), so
 * automation cannot bypass the allowed-transition rule.
 *
 * Authorization (worker category / customer ownership) is layered by the
 * platform core before this is called; the actorKind/actorId are recorded here
 * for the audit trail.
 */

import type { Db, DbAdapter } from "../db/db.ts";
import { appendOperation, type ActorKind } from "./operations.ts";
import { appendAudit, appendOutbox } from "./audit.ts";

export class IllegalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`No allowed transition from "${from}" to "${to}"`);
    this.name = "IllegalTransitionError";
  }
}

export interface ChangeStateInput {
  readonly caseKey: bigint;
  readonly toState: string;
  readonly actorKind: ActorKind;
  readonly actorId?: string | undefined;
  readonly comment?: string | undefined;
  readonly correlationId?: string | undefined;
}

export async function changeState(db: DbAdapter, input: ChangeStateInput, now: string): Promise<void> {
  await db.transaction(async (tx) => { await changeStateTx(tx, input, now); });
}

/** Transaction-scoped variant used by the atomic state+rule orchestration. */
export async function changeStateTx(db: Db, input: ChangeStateInput, now: string): Promise<{ fromState: string; toState: string; version: number }> {
    const current = await db.get("SELECT state, version FROM cases WHERE case_key = ?", [input.caseKey]);
    if (!current) throw new Error(`Case ${input.caseKey} not found`);
    const fromState = String(current.state);
    const version = Number(current.version);

    const allowed = await db.get(
      "SELECT 1 AS ok FROM state_transitions WHERE from_state = ? AND to_state = ?",
      [fromState, input.toState],
    );
    if (!allowed) throw new IllegalTransitionError(fromState, input.toState);

    const changed = await db.run("UPDATE cases SET state = ?, modified = ?, version = version + 1 WHERE case_key = ? AND state = ? AND version = ?", [
      input.toState,
      now,
      input.caseKey,
      fromState,
      version,
    ]);
    if (changed.changes !== 1) throw new Error("CONCURRENCY_CONFLICT");

    await appendOperation(
      db,
      {
        caseKey: input.caseKey,
        direction: "internal",
        type: "state_change",
        properties: { from: fromState, to: input.toState },
        comment: input.comment ?? "",
        actorKind: input.actorKind,
        actorId: input.actorId ?? "",
      },
      now,
    );
    const correlationId = input.correlationId ?? `state:${input.caseKey}:${now}`;
    await appendAudit(db, { actorKind: input.actorKind, actorId: input.actorId, action: "case.transition", targetType: "case", targetId: String(input.caseKey), correlationId, details: { from: fromState, to: input.toState } }, now);
    await appendOutbox(db, { eventType: "case.state.changed", aggregateType: "case", aggregateId: String(input.caseKey), correlationId, payload: { from: fromState, to: input.toState } }, now);
    return { fromState, toState: input.toState, version: version + 1 };
}
