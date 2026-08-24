/**
 * Diary-number allocation (Architecture §3, Decision D-01).
 *
 * Public case identity is REGISTRY/YEAR/NUMBER with NUMBER a per-registry,
 * per-year, zero-padded, GAPLESS sequence. Allocation happens inside the same
 * transaction that inserts the case, from a diary_counters row, so numbers are
 * collision-free and gapless under concurrency. The internal BIGINT case_key
 * (Decision D-02) is separate and is the real primary key.
 *
 * The increment-or-insert-returning statement is the one true dialect
 * divergence here (SQLite ON CONFLICT…RETURNING vs SQL Server MERGE…OUTPUT), so
 * it is built from the Dialect passed down by the caller.
 */

import type { Db } from "../db/db.ts";
import type { Dialect } from "../db/dialect.ts";
import type { DiaryFormat } from "../config/registry-catalog.ts";

export function formatDiaryNumber(fmt: DiaryFormat, year: number, n: number): string {
  const num = String(n).padStart(fmt.numberPadding, "0");
  return `${fmt.registryCode}${fmt.separator}${year}${fmt.separator}${num}`;
}

/**
 * Allocate the next number for (registry, year) atomically.
 * MUST be called inside a transaction (tx) that also inserts the case, so a
 * rolled-back case does not consume a number. Uses an upsert that increments
 * and returns the new value in one statement.
 */
export async function allocateDiaryNumber(
  tx: Db,
  d: Dialect,
  fmt: DiaryFormat,
  registryId: string,
  year: number,
): Promise<{ number: number; diaryNumber: string }> {
  const row = await tx.get(
    d.upsertReturning({
      table: "diary_counters",
      insertColumns: ["registry_id", "year", "last_number"],
      conflictColumns: ["registry_id", "year"],
      updateColumn: "last_number",
      returning: "last_number",
    }),
    [registryId, year, 1],
  );
  if (!row) throw new Error("diary counter allocation failed");
  const n = Number(row.last_number);
  return { number: n, diaryNumber: formatDiaryNumber(fmt, year, n) };
}
