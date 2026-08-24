import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.ts";

export interface AuditInput {
  actorKind: "worker" | "customer" | "system";
  actorId?: string;
  action: string;
  targetType: string;
  targetId: string;
  correlationId: string;
  outcome?: "success" | "failure" | "denied";
  details?: unknown;
}

export async function appendAudit(tx: Db, input: AuditInput, now: string): Promise<void> {
  await tx.run(
    `INSERT INTO audit_events
      (event_id, occurred_at, actor_kind, actor_id, action, target_type, target_id, correlation_id, outcome, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), now, input.actorKind, input.actorId ?? null, input.action, input.targetType, input.targetId,
      input.correlationId, input.outcome ?? "success", input.details === undefined ? null : JSON.stringify(input.details)],
  );
}

export async function appendOutbox(
  tx: Db,
  input: { eventType: string; aggregateType: string; aggregateId: string; correlationId: string; payload: unknown },
  now: string,
): Promise<void> {
  await tx.run(
    `INSERT INTO outbox
      (event_id, created_at, event_type, aggregate_type, aggregate_id, correlation_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), now, input.eventType, input.aggregateType, input.aggregateId, input.correlationId, JSON.stringify(input.payload)],
  );
}
