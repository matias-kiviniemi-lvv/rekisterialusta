/**
 * Scheduled CSV exports (Architecture §5.11, §12).
 *
 * Produces a CSV export of every registry's cases and operations, writes them
 * to the blob store, and logs each run in export_runs so a missed or failed
 * export is visible, not silent. Shaped as a plain function a timer trigger
 * calls (Plan Phase 5); the scheduler itself is infrastructure.
 *
 * Column discovery goes through the Dialect (PRAGMA table_info on SQLite,
 * INFORMATION_SCHEMA on SQL Server) so the same exporter runs on both.
 */

import type { Platform, RegistryHandle } from "../api/platform.ts";
import type { DbAdapter } from "../db/db.ts";
import { dialectFor } from "../db/dialect.ts";

export interface RegistryExportResult {
  readonly registryId: string;
  readonly status: "ok" | "failed";
  readonly caseCount: number;
  readonly casesBlobKey?: string;
  readonly operationsBlobKey?: string;
  readonly error?: string;
}

/** Export a single registry. Records an export_run row (running → ok/failed). */
export async function exportRegistry(platform: Platform, h: RegistryHandle, now: string): Promise<RegistryExportResult> {
  const runId = await beginRun(platform.shared, h.def.registryId, now);
  try {
    const casesCsv = await tableToCsv(h.db, "cases");
    const opsCsv = await tableToCsv(h.db, "operations");
    const casesKey = `exports/${h.def.registryId}/${sanitize(now)}/cases.csv`;
    const opsKey = `exports/${h.def.registryId}/${sanitize(now)}/operations.csv`;
    platform.blobs.put(casesKey, new TextEncoder().encode(casesCsv.text));
    platform.blobs.put(opsKey, new TextEncoder().encode(opsCsv.text));
    await finishRun(platform.shared, runId, "ok", casesCsv.rows, casesKey, now);
    return { registryId: h.def.registryId, status: "ok", caseCount: casesCsv.rows, casesBlobKey: casesKey, operationsBlobKey: opsKey };
  } catch (err) {
    await finishRun(platform.shared, runId, "failed", null, null, now, (err as Error).message);
    return { registryId: h.def.registryId, status: "failed", caseCount: 0, error: (err as Error).message };
  }
}

/** Export ALL registries. One registry's failure does not stop the others. */
export async function exportAllRegistries(platform: Platform, now: string): Promise<RegistryExportResult[]> {
  const results: RegistryExportResult[] = [];
  for (const h of platform.allRegistries()) {
    results.push(await exportRegistry(platform, h, now));
  }
  return results;
}

// ---- CSV building ----------------------------------------------------------

async function tableToCsv(db: DbAdapter, table: string): Promise<{ text: string; rows: number }> {
  const d = dialectFor(db.dialect);
  const columns = (await db.all(d.columnsOf(table))).map((r) => String(r.name));
  const rows = await db.all(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1`);
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return { text: lines.join("\n") + "\n", rows: rows.length };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sanitize(now: string): string {
  return now.replace(/[^0-9A-Za-z]/g, "");
}

// ---- export_runs log -------------------------------------------------------

async function beginRun(shared: DbAdapter, registryId: string, now: string): Promise<bigint> {
  const res = await shared.run(
    "INSERT INTO export_runs (registry_id, started_at, status) VALUES (?, ?, 'running')",
    [registryId, now],
  );
  return res.lastInsertRowId;
}

async function finishRun(
  shared: DbAdapter,
  runId: bigint,
  status: "ok" | "failed",
  caseCount: number | null,
  blobKey: string | null,
  now: string,
  error?: string,
): Promise<void> {
  await shared.run(
    "UPDATE export_runs SET finished_at = ?, status = ?, case_count = ?, blob_key = ?, error = ? WHERE run_id = ?",
    [now, status, caseCount, blobKey, error ?? null, runId],
  );
}
