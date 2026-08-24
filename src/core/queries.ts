/**
 * Platform-core read queries (Architecture §5, §6).
 *
 * Domain-shaped reads the portals and REST API call. They never expose raw
 * table access; authorization is applied by the caller (handler) via
 * authorization.ts before these run, or as a filter within them.
 */

import type { Db } from "../db/db.ts";

export interface CaseView {
  caseKey: bigint;
  diaryNumber: string;
  category: string;
  state: string;
  isPublished: boolean;
  created: string;
  modified: string;
  version: number;
}

export interface PublishedCaseView {
  diaryNumber: string;
  category: string;
  state: string;
  fields: Record<string, unknown>;
  publishedAt: string;
}

export interface PublishedSearchOptions {
  readonly query?: string;
  readonly categoryPrefix?: string;
  readonly limit?: number;
}

interface PublishedCaseRecord extends PublishedCaseView {
  caseKey: bigint;
}

export interface OperationView {
  operationId: number;
  created: string;
  direction: string;
  type: string;
  subtype: string | null;
  comment: string | null;
  actorKind: string;
}

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

export async function getCaseByDiaryNumber(registryDb: Db, diaryNumber: string): Promise<CaseView | undefined> {
  const row = await registryDb.get(
    "SELECT case_key, diary_number, category, state, is_published, created, modified, version FROM cases WHERE diary_number = ?",
    [diaryNumber],
  );
  return row ? toCaseView(row) : undefined;
}

export async function getCaseHistory(registryDb: Db, caseKey: bigint): Promise<OperationView[]> {
  const rows = await registryDb.all(
    `SELECT operation_id, created, direction, type, subtype, comment, actor_kind
       FROM operations WHERE case_key = ? ORDER BY operation_id`,
    [caseKey],
  );
  return rows.map((r) => ({
    operationId: Number(r.operation_id),
    created: String(r.created),
    direction: String(r.direction),
    type: String(r.type),
    subtype: r.subtype === null ? null : String(r.subtype),
    comment: r.comment === null ? null : String(r.comment),
    actorKind: String(r.actor_kind),
  }));
}

/** Customer portal: this customer's cases (ownership-filtered) (§5.5, §6.2). */
export async function listCustomerCases(registryDb: Db, customerId: string): Promise<CaseView[]> {
  const rows = await registryDb.all(
    `SELECT c.case_key, c.diary_number, c.category, c.state, c.is_published, c.created, c.modified, c.version
       FROM cases c
       JOIN case_parties p ON p.case_key = c.case_key
      WHERE p.customer_id = ?
      ORDER BY c.created DESC`,
    [customerId],
  );
  return rows.map(toCaseView);
}

/**
 * Publishing portal: scan only the explicit public projection (§5.7).
 * Matching is a normalized literal substring test over public case metadata,
 * public field values, and explicitly published operation content.
 */
export async function searchPublishedCases(registryDb: Db, options: PublishedSearchOptions = {}): Promise<PublishedCaseView[]> {
  const rows = options.categoryPrefix
    ? await registryDb.all(
        `SELECT p.diary_number, p.category, p.state, p.fields_json, p.published_at
           FROM published_cases p
          WHERE p.category LIKE ? ORDER BY p.published_at DESC`,
        [options.categoryPrefix + "%"],
      )
    : await registryDb.all(
        `SELECT p.diary_number, p.category, p.state, p.fields_json, p.published_at
           FROM published_cases p
          ORDER BY p.published_at DESC`,
      );
  const query = options.query ? normalizeSearchText(options.query) : "";
  const operationsByCase = new Map<string, string[]>();
  if (query) {
    const operations = await registryDb.all(
      `SELECT pc.diary_number, po.type, po.subtype, po.properties, po.comment
         FROM published_operations po
         JOIN published_cases pc ON pc.case_key = po.case_key
        ORDER BY po.operation_id`,
    );
    for (const operation of operations) {
      const diaryNumber = String(operation.diary_number);
      const values = operationsByCase.get(diaryNumber) ?? [];
      values.push(...searchableScalars(operation.type), ...searchableScalars(operation.subtype),
        ...searchableScalars(parseJson(operation.properties)), ...searchableScalars(operation.comment));
      operationsByCase.set(diaryNumber, values);
    }
  }

  const matches: PublishedCaseView[] = [];
  for (const row of rows) {
    const view = toPublishedCaseView(row);
    const values = [view.diaryNumber, view.category, view.state, ...searchableScalars(view.fields),
      ...(operationsByCase.get(view.diaryNumber) ?? [])];
    if (!query || values.some((value) => normalizeSearchText(value).includes(query))) matches.push(view);
    if (matches.length >= (options.limit ?? 50)) break;
  }
  return matches;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en");
}

function searchableScalars(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(searchableScalars);
  if (typeof value === "object") return Object.values(value).flatMap(searchableScalars);
  return [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export async function getPublishedCaseByDiaryNumber(registryDb: Db, diaryNumber: string): Promise<PublishedCaseRecord | undefined> {
  const row = await registryDb.get(
    `SELECT p.case_key, p.diary_number, p.category, p.state, p.fields_json, p.published_at
       FROM published_cases p
      WHERE p.diary_number = ?`,
    [diaryNumber],
  );
  return row ? { caseKey: BigInt(row.case_key as number), ...toPublishedCaseView(row) } : undefined;
}

function toPublishedCaseView(row: Record<string, unknown>): PublishedCaseView {
  return {
    diaryNumber: String(row.diary_number), category: String(row.category), state: String(row.state),
    fields: JSON.parse(String(row.fields_json)), publishedAt: String(row.published_at),
  };
}

export async function getPublishedHistory(registryDb: Db, caseKey: bigint): Promise<OperationView[]> {
  const rows = await registryDb.all(
    `SELECT operation_id, created, direction, type, subtype, comment, 'published' AS actor_kind
       FROM published_operations WHERE case_key = ? ORDER BY operation_id`,
    [caseKey],
  );
  return rows.map((r) => ({
    operationId: Number(r.operation_id), created: String(r.created), direction: String(r.direction), type: String(r.type),
    subtype: r.subtype === null ? null : String(r.subtype), comment: r.comment === null ? null : String(r.comment), actorKind: "published",
  }));
}
