/**
 * Rule engine (Architecture §9, Decision D-07).
 *
 * Evaluates on state change: when a case reaches a state, active rules for the
 * registry whose (optional) target-state matches are evaluated; where a rule's
 * condition holds, its action runs. Actions are a FIXED catalog plus three
 * PARAMETERIZED actions (set_state, update_values, create_operation) — no
 * arbitrary code. Every action is recorded as an operation, and a rule-driven
 * set_state routes through the state-machine service, so a rule can neither
 * bypass the allowed-transition rule nor escape the audit trail.
 *
 * Cascade safety: a set_state action may re-trigger rules; recursion is capped
 * at MAX_CASCADE to prevent infinite loops.
 */

import type { Platform, RegistryHandle } from "../api/platform.ts";
import type { Db } from "../db/db.ts";
import { appendOperation } from "../domain/operations.ts";
import { changeStateTx, IllegalTransitionError } from "../domain/state-machine.ts";
import { isWithin } from "../domain/categories.ts";
import type { Condition } from "../domain/rule-types.ts";
import { appendAudit, appendOutbox } from "../domain/audit.ts";

const MAX_CASCADE = 5;

interface RuleRow {
  ruleId: string;
  onToState: string | null;
  condition: Condition;
  actionType: string;
  actionParams: Record<string, unknown>;
}

export async function runRulesForStateChange(
  platform: Platform,
  h: RegistryHandle,
  caseKey: bigint,
  toState: string,
  depth = 0,
): Promise<number> {
  return h.db.transaction((tx) => runRulesForStateChangeTx(platform, h, tx, caseKey, toState, depth));
}

/** Run every matching internal effect in the caller's registry transaction. */
export async function runRulesForStateChangeTx(
  platform: Platform,
  h: RegistryHandle,
  tx: Db,
  caseKey: bigint,
  toState: string,
  depth = 0,
  correlationId = `rule:${caseKey}:${platform.clock.now()}`,
): Promise<number> {
  if (depth > MAX_CASCADE) throw new Error("RULE_CASCADE_LIMIT");

  const rules = await loadRules(platform.shared, h.def.registryId, toState);
  let fired = 0;

  for (const rule of rules) {
    const caseRow = await tx.get("SELECT * FROM cases WHERE case_key = ?", [caseKey]);
    if (!caseRow) break;
    if (!evalCondition(rule.condition, caseRow)) continue;
    await executeAction(platform, h, tx, caseKey, rule, depth, correlationId);
    await appendAudit(tx, { actorKind: "system", actorId: `rule:${rule.ruleId}`, action: "rule.execute", targetType: "case", targetId: String(caseKey), correlationId, details: { ruleId: rule.ruleId, actionType: rule.actionType } }, platform.clock.now());
    fired++;
  }
  return fired;
}

async function loadRules(shared: Db, registryId: string, toState: string): Promise<RuleRow[]> {
  const rows = await shared.all(
    `SELECT rule_id, on_to_state, condition, action_type, action_params
       FROM rules
      WHERE registry_id = ? AND active = 1 AND [trigger] = 'state_change'
        AND (on_to_state IS NULL OR on_to_state = ?)
      ORDER BY ordering, rule_id`,
    [registryId, toState],
  );
  return rows.map((r) => ({
    ruleId: String(r.rule_id),
    onToState: r.on_to_state === null ? null : String(r.on_to_state),
    condition: r.condition ? (JSON.parse(String(r.condition)) as Condition) : null,
    actionType: String(r.action_type),
    actionParams: r.action_params ? (JSON.parse(String(r.action_params)) as Record<string, unknown>) : {},
  }));
}

function evalCondition(cond: Condition, caseRow: Record<string, unknown>): boolean {
  if (cond === null) return true;
  if ("all" in cond) return cond.all.every((c) => evalCondition(c, caseRow));
  if ("any" in cond) return cond.any.some((c) => evalCondition(c, caseRow));
  if ("categoryWithin" in cond) return isWithin(String(caseRow.category), cond.categoryWithin);
  if ("equals" in cond) return normalize(caseRow[cond.field]) === normalize(cond.equals);
  if ("notEquals" in cond) return normalize(caseRow[cond.field]) !== normalize(cond.notEquals);
  return false;
}

// SQLite stores booleans as 0/1; normalize so {equals: true} matches a stored 1.
function normalize(v: unknown): unknown {
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}

async function executeAction(platform: Platform, h: RegistryHandle, tx: Db, caseKey: bigint, rule: RuleRow, depth: number, correlationId: string): Promise<void> {
  const now = platform.clock.now();
  const p = rule.actionParams;

  switch (rule.actionType) {
    case "set_state": {
      const toState = String(p.toState ?? "");
      try {
        await changeStateTx(tx, { caseKey, toState, actorKind: "system", actorId: `rule:${rule.ruleId}`, correlationId }, now);
        // Cascade: the new state may trigger further rules (bounded).
        await runRulesForStateChangeTx(platform, h, tx, caseKey, toState, depth + 1, correlationId);
      } catch (err) {
        if (!(err instanceof IllegalTransitionError)) throw err;
        await recordAction(tx, caseKey, rule, { skipped: "illegal transition", toState }, now);
      }
      return;
    }
    case "update_values": {
      const fields = (p.fields && typeof p.fields === "object" ? p.fields : {}) as Record<string, unknown>;
      const definitions = new Map(h.def.fields.map((field) => [field.name, field]));
      const names = Object.keys(fields);
      for (const name of names) if (!definitions.get(name)?.writableOnUpdate) throw new Error(`RULE_FIELD_NOT_WRITABLE:${name}`);
      if (names.length > 0) {
        const setClause = names.map((n) => `${n} = ?`).join(", ");
        const values = names.map((n) => {
          const v = fields[n];
          return typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null);
        });
        const current = await tx.get("SELECT version FROM cases WHERE case_key = ?", [caseKey]);
        if (!current) throw new Error("CASE_NOT_FOUND");
        const changed = await tx.run(`UPDATE cases SET ${setClause}, modified = ?, version = version + 1 WHERE case_key = ? AND version = ?`, [...values, now, caseKey, Number(current.version)]);
        if (changed.changes !== 1) throw new Error("CONCURRENCY_CONFLICT");
      }
      await appendOperation(tx, { caseKey, direction: "internal", type: "rule_update_values", properties: { ruleId: rule.ruleId, fields }, actorKind: "system", actorId: `rule:${rule.ruleId}` }, now);
      return;
    }
    case "create_operation": {
      await appendOperation(
          tx,
          {
            caseKey,
            direction: (String(p.direction ?? "internal") as "incoming" | "outgoing" | "internal"),
            type: String(p.type ?? "rule_operation"),
            subtype: p.subtype === undefined ? undefined : String(p.subtype),
            properties: p.properties,
            comment: p.comment === undefined ? undefined : String(p.comment),
            actorKind: "system",
            actorId: `rule:${rule.ruleId}`,
          },
          now,
        );
      return;
    }
    default: {
      // Fixed catalog actions with external side effects (notify_customer,
      // send_to_integration, export, …). In this foundation they are recorded
      // as operations; the queue-backed execution arrives in Phase 4. This is
      // where an action would be enqueued (outbox), never run inline.
      await recordAction(tx, caseKey, rule, { action: rule.actionType, params: p }, now);
      await appendOutbox(tx, { eventType: rule.actionType, aggregateType: "case", aggregateId: String(caseKey), correlationId, payload: { ruleId: rule.ruleId, params: p } }, now);
      return;
    }
  }
}

async function recordAction(tx: Db, caseKey: bigint, rule: RuleRow, properties: unknown, now: string): Promise<void> {
  await appendOperation(tx, { caseKey, direction: "outgoing", type: "rule_action", subtype: rule.actionType, properties, actorKind: "system", actorId: `rule:${rule.ruleId}` }, now);
}
