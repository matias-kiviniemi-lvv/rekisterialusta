/**
 * Case creation service (Architecture §2.3, §3, §4).
 *
 * Creating a case is a single transaction that:
 *   1. allocates a gapless diary number for the registry+year (D-01),
 *   2. inserts the case with the internal BIGINT key (D-02) and its
 *      statutory field values (typed columns, D-03),
 *   3. links parties for customer ownership authorization (§6.2),
 *   4. writes the initial "case_created" operation to history (§2.3).
 *
 * Because all of this is one transaction, a failure leaves neither an orphan
 * number nor a case without history.
 */

import type { DbAdapter } from "../db/db.ts";
import { dialectFor } from "../db/dialect.ts";
import type { DiaryFormat, RegistryFieldDef } from "../config/registry-catalog.ts";
import { allocateDiaryNumber } from "./diary-number.ts";
import { appendOperation } from "./operations.ts";
import { normalizePath } from "./categories.ts";
import { appendAudit, appendOutbox } from "./audit.ts";

export interface CreateCaseInput {
  readonly registryId: string;
  readonly diaryFormat: DiaryFormat;
  readonly fieldDefs: readonly RegistryFieldDef[];
  readonly year: number;
  readonly category: string;
  readonly initialState: string;
  /** Statutory field values, keyed by field name. Validated against fieldDefs. */
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
  readonly parties: ReadonlyArray<{ customerId: string; role: string }>;
  readonly actorKind: "worker" | "customer" | "system";
  readonly actorId?: string;
  readonly correlationId?: string;
}

export interface CreatedCase {
  readonly caseKey: bigint;
  readonly diaryNumber: string;
}

function validateFields(
  defs: readonly RegistryFieldDef[],
  values: Readonly<Record<string, unknown>>,
): void {
  const known = new Set(defs.map((d) => d.name));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new Error(`Unknown field "${key}" for registry`);
    const def = defs.find((d) => d.name === key)!;
    if (!def.writableOnCreate) throw new Error(`Field "${key}" is not writable on create`);
    const value = values[key];
    if (value === null) {
      if (!def.nullable) throw new Error(`Field "${key}" is required`);
      continue;
    }
    const valid =
      (def.type === "text" && typeof value === "string") ||
      (def.type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
      (def.type === "decimal" && typeof value === "number" && Number.isFinite(value)) ||
      (def.type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) ||
      (def.type === "boolean" && typeof value === "boolean");
    if (!valid) throw new Error(`Field "${key}" has invalid ${def.type} value`);
  }
  for (const d of defs) {
    const v = values[d.name];
    if ((v === undefined || v === null) && !d.nullable) {
      throw new Error(`Field "${d.name}" is required`);
    }
  }
}

export async function createCase(db: DbAdapter, input: CreateCaseInput, now: string): Promise<CreatedCase> {
  // Validate category shape and required fields up front (fail before any write).
  normalizePath(input.category);
  validateFields(input.fieldDefs, input.fields);
  const d = dialectFor(db.dialect);

  return db.transaction(async (tx) => {
    const { diaryNumber } = await allocateDiaryNumber(tx, d, input.diaryFormat, input.registryId, input.year);

    const fieldNames = input.fieldDefs.map((d) => d.name).filter((n) => n in input.fields);
    const cols = ["diary_number", "created", "modified", "category", "state", "is_published", ...fieldNames];
    const placeholders = cols.map(() => "?").join(", ");
    const values = [
      diaryNumber,
      now,
      now,
      input.category,
      input.initialState,
      0,
      ...fieldNames.map((n) => {
        const v = input.fields[n];
        return typeof v === "boolean" ? (v ? 1 : 0) : (v ?? null);
      }),
    ];

    const res = await tx.run(`INSERT INTO cases (${cols.join(", ")}) VALUES (${placeholders})`, values);
    const caseKey = res.lastInsertRowId;

    for (const p of input.parties) {
      await tx.run("INSERT INTO case_parties (case_key, customer_id, party_role) VALUES (?, ?, ?)", [
        caseKey,
        p.customerId,
        p.role,
      ]);
    }

    await appendOperation(
      tx,
      {
        caseKey,
        direction: "internal",
        type: "case_created",
        properties: { diaryNumber, category: input.category, initialState: input.initialState },
        actorKind: input.actorKind,
        actorId: input.actorId ?? "",
      },
      now,
    );

    const correlationId = input.correlationId ?? `case:${diaryNumber}`;
    await appendAudit(tx, {
      actorKind: input.actorKind, ...(input.actorId !== undefined ? { actorId: input.actorId } : {}), action: "case.create", targetType: "case",
      targetId: String(caseKey), correlationId, details: { diaryNumber, category: input.category },
    }, now);
    await appendOutbox(tx, {
      eventType: "case.created", aggregateType: "case", aggregateId: String(caseKey), correlationId,
      payload: { diaryNumber, category: input.category, state: input.initialState },
    }, now);

    return { caseKey, diaryNumber };
  });
}
