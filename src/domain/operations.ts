/**
 * Operations service (Architecture §2.3).
 *
 * Operations are the append-only history of a case. This module only ever
 * INSERTs; it never updates payloads. operation_id is the human-facing 1..n
 * sequence within a case, allocated from an atomic case-row counter under the
 * same transaction as the insert. Every actor (worker/customer/system) is stamped
 * for audit, so machine actions are as traceable as human ones.
 */

import type { Db } from "../db/db.ts";

export type Direction = "incoming" | "outgoing" | "internal";
export type ActorKind = "worker" | "customer" | "system";

export interface AppendOperationInput {
  readonly caseKey: bigint;
  readonly direction: Direction;
  readonly type: string;
  readonly subtype?: string | undefined;
  readonly properties?: unknown; // serialized to JSON
  readonly comment?: string | undefined;
  readonly actorKind: ActorKind;
  readonly actorId?: string | undefined;
}

export interface OperationRecord {
  readonly operationKey: bigint;
  readonly operationId: number;
}

export async function appendOperation(tx: Db, input: AppendOperationInput, now: string): Promise<OperationRecord> {
  // Allocation is serialized by the case row in the same transaction. MAX+1
  // races under concurrent writers; this counter does not.
  const allocated = await tx.run(
    "UPDATE cases SET next_operation_id = next_operation_id + 1 WHERE case_key = ?",
    [input.caseKey],
  );
  if (allocated.changes !== 1) throw new Error("CASE_NOT_FOUND");
  const seqRow = await tx.get("SELECT next_operation_id FROM cases WHERE case_key = ?", [input.caseKey]);
  const operationId = Number(seqRow?.next_operation_id ?? 1) - 1;

  const res = await tx.run(
    `
    INSERT INTO operations
      (case_key, operation_id, created, modified, direction, type, subtype, properties, comment, actor_kind, actor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.caseKey,
      operationId,
      now,
      now,
      input.direction,
      input.type,
      input.subtype ?? null,
      input.properties === undefined ? null : JSON.stringify(input.properties),
      input.comment ?? null,
      input.actorKind,
      input.actorId ?? null,
    ],
  );

  return { operationKey: res.lastInsertRowId, operationId };
}
