/**
 * REST route handlers (Architecture §5, §7).
 *
 * Handlers are pure functions of (platform, request) → response. They resolve
 * the target registry, authorize via authz.ts (never trusting the caller), then
 * use the domain services. No raw table access is ever exposed. This is the
 * machine surface AND what the portals call — one authorization model for both.
 *
 * Handlers are async because the DB seam is async.
 */

import type { Platform } from "./platform.ts";
import { defineRoute, type Route } from "./router.ts";
import type { Principal } from "./authz.ts";
import type { ApiRequest, ApiResponse, ApiHandler } from "./http-types.ts";
import { adminRoutes } from "./admin-routes.ts";
import { canReadCase, canWriteCase, canTransitionCase } from "./authz.ts";
import { getCaseByDiaryNumber, getCaseHistory, getPublishedCaseByDiaryNumber, getPublishedHistory, listCustomerCases, searchPublishedCases, type PublishedSearchOptions } from "../core/queries.ts";
import { authorizedCases, assignedCases, unassignedOptedInCases, pendingToApprove } from "../core/worker-queries.ts";
import { createCase } from "../domain/cases.ts";
import { appendOperation, type Direction } from "../domain/operations.ts";
import { changeStateTx, IllegalTransitionError } from "../domain/state-machine.ts";
import { runRulesForStateChangeTx } from "../services/rules.ts";
import { submitForm, decidePending } from "../services/forms.ts";
import { dialectFor } from "../db/dialect.ts";
import { categoryBelongsToRegistry } from "../config/validation.ts";
import { appendAudit, appendOutbox } from "../domain/audit.ts";
import { DEFAULT_LOCALE_CONFIG, resolveRequestedLocale } from "../config/localization.ts";

export type { ApiRequest, ApiResponse, ApiHandler } from "./http-types.ts";

function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

// ---- Case read -------------------------------------------------------------

const getCase: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  const projectionOnly = req.principal.kind === "public" || (req.principal.kind === "token" && req.principal.scope.publishedOnly);
  if (projectionOnly) {
    const published = await getPublishedCaseByDiaryNumber(h.db, req.params.diary!);
    if (!published) return { status: 403, body: { error: "forbidden" } };
    if (req.principal.kind === "token" && !(await canReadCase(platform, req.principal, h, c))) return { status: 403, body: { error: "forbidden" } };
    return {
      status: 200,
      body: {
        case: { diaryNumber: published.diaryNumber, category: published.category, state: published.state, fields: published.fields, publishedAt: published.publishedAt },
        history: await getPublishedHistory(h.db, published.caseKey),
      },
    };
  }
  if (!(await canReadCase(platform, req.principal, h, c))) return { status: 403, body: { error: "forbidden" } };
  return { status: 200, body: { case: { ...c, caseKey: Number(c.caseKey) }, history: await getCaseHistory(h.db, c.caseKey) } };
};

// ---- Case create -----------------------------------------------------------

const postCase: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const b = asObject(req.body);
  const category = String(b.category ?? "");
  if (!category) return { status: 400, body: { error: "category required" } };
  if (!categoryBelongsToRegistry(h.def, category)) return { status: 400, body: { error: "category is outside registry scope" } };
  if (!(await platform.shared.get("SELECT 1 AS ok FROM categories WHERE display_code = ? AND active = 1", [category]))) {
    return { status: 400, body: { error: "unknown category" } };
  }
  // The lifecycle start is registry configuration, never request data. Accept
  // the legacy property only when it repeats that configured value: stale
  // clients keep working, while callers cannot select another lifecycle state.
  const initialState = h.def.initialState;
  if (b.initialState !== undefined && String(b.initialState) !== initialState) {
    return { status: 400, body: { error: "initialState is server controlled" } };
  }

  // Authorization for creation: workers need write on the category; customers
  // may create their own case; tokens need POST cases within scope.
  const p = req.principal;
  let actorKind: "worker" | "customer" | "system" = "system";
  let actorId = "";
  let parties: Array<{ customerId: string; role: string }> = Array.isArray(b.parties)
    ? (b.parties as Array<Record<string, unknown>>).map((x) => ({ customerId: String(x.customerId), role: String(x.role ?? "party") }))
    : [];

  if (p.kind === "actor" && p.actor.kind === "worker") {
    if (!(await workerWrite(platform, p.actor.workerId, h.def.registryId, category))) return { status: 403, body: { error: "forbidden" } };
    actorKind = "worker";
    actorId = p.actor.workerId;
  } else if (p.kind === "actor" && p.actor.kind === "customer") {
    actorKind = "customer";
    actorId = p.actor.customerId;
    // Untrusted callers cannot grant case access to other customer identities.
    if (parties.length > 0) return { status: 400, body: { error: "parties are server controlled" } };
    parties = [{ customerId: actorId, role: "applicant" }];
  } else if (p.kind === "token") {
    if (p.scope.registryId !== h.def.registryId || !tokenCreate(p, category)) return { status: 403, body: { error: "forbidden" } };
    actorKind = "system";
    actorId = p.scope.tokenId;
  } else {
    return { status: 403, body: { error: "forbidden" } };
  }

  try {
    const created = await createCase(
      h.db,
      {
        registryId: h.def.registryId,
        diaryFormat: h.def.diary,
        fieldDefs: h.def.fields,
        year: new Date(platform.clock.now()).getUTCFullYear(),
        category,
        initialState,
        fields: asObject(b.fields) as Record<string, string | number | boolean | null>,
        parties,
        actorKind,
        actorId,
        correlationId: req.correlationId,
      },
      platform.clock.now(),
    );
    return { status: 201, body: { caseKey: Number(created.caseKey), diaryNumber: created.diaryNumber } };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
};

// small local wrappers to avoid importing internals widely
import { workerCanAccessCategory } from "../core/authorization.ts";
import { tokenAllows } from "./tokens.ts";
async function workerWrite(platform: Platform, workerId: string, registryId: string, category: string): Promise<boolean> {
  return workerCanAccessCategory(platform.shared, workerId, registryId, category, "write", platform.clock.now());
}
function tokenCreate(p: Extract<Principal, { kind: "token" }>, category: string): boolean {
  return tokenAllows(p.scope, "POST", "cases", category);
}

// ---- Operation append ------------------------------------------------------

const postOperation: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  if (!(await canWriteCase(platform, req.principal, h, c))) return { status: 403, body: { error: "forbidden" } };
  const b = asObject(req.body);
  const { actorKind, actorId } = actorStamp(req.principal);
  const direction = String(b.direction ?? "internal");
  const type = String(b.type ?? "note");
  if (!new Set(["incoming", "outgoing", "internal"]).has(direction)) return { status: 400, body: { error: "invalid direction" } };
  if (!type.trim() || type.length > 200) return { status: 400, body: { error: "invalid operation type" } };
  const rec = await h.db.transaction(async (tx) => {
    const operation = await appendOperation(tx, {
        caseKey: c.caseKey,
        direction: direction as Direction,
        type,
        subtype: b.subtype === undefined ? undefined : String(b.subtype),
        properties: b.properties,
        comment: b.comment === undefined ? undefined : String(b.comment),
        actorKind,
        actorId,
      }, platform.clock.now());
    await appendAudit(tx, { actorKind, actorId, action: "operation.append", targetType: "case", targetId: String(c.caseKey), correlationId: req.correlationId, details: { operationId: operation.operationId, type } }, platform.clock.now());
    await appendOutbox(tx, { eventType: "operation.created", aggregateType: "case", aggregateId: String(c.caseKey), correlationId: req.correlationId, payload: { operationId: operation.operationId, type } }, platform.clock.now());
    return operation;
  });
  return { status: 201, body: { operationId: rec.operationId } };
};

// ---- State transition ------------------------------------------------------

const postTransition: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  if (!(await canTransitionCase(platform, req.principal, h, c))) return { status: 403, body: { error: "forbidden" } };
  const b = asObject(req.body);
  const toState = String(b.toState ?? "");
  if (!toState) return { status: 400, body: { error: "toState required" } };
  const { actorKind, actorId } = actorStamp(req.principal);
  try {
    const fired = await h.db.transaction(async (tx) => {
      await changeStateTx(tx, { caseKey: c.caseKey, toState, actorKind, actorId, comment: b.comment === undefined ? undefined : String(b.comment), correlationId: req.correlationId }, platform.clock.now());
      return runRulesForStateChangeTx(platform, h, tx, c.caseKey, toState, 0, req.correlationId);
    });
    return { status: 200, body: { state: toState, rulesFired: fired } };
  } catch (err) {
    if (err instanceof IllegalTransitionError) return { status: 409, body: { error: err.message } };
    return { status: 400, body: { error: (err as Error).message } };
  }
};

// ---- Published search + my-cases -------------------------------------------

const getPublished: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const options = publishedSearchOptions(req.query);
  if ("error" in options) return { status: 400, body: { error: options.error } };
  return { status: 200, body: { cases: await searchPublishedCases(h.db, options) } };
};

const getPublishedAcrossRegistries: ApiHandler = async (platform, req) => {
  const options = publishedSearchOptions(req.query);
  if ("error" in options) return { status: 400, body: { error: options.error } };
  const requestedRegistry = req.query.get("registry");
  if (requestedRegistry && !platform.registry(requestedRegistry)) return { status: 404, body: { error: "unknown registry" } };
  const visible = platform.allRegistries().filter((h) =>
    (!requestedRegistry || h.def.registryId === requestedRegistry) &&
    (req.principal.kind !== "token" || h.def.registryId === req.principal.scope.registryId));
  const pages = await Promise.all(visible.map(async (h) => ({
    registryId: h.def.registryId,
    cases: await searchPublishedCases(h.db, options),
  })));
  const cases = pages.flatMap((page) => page.cases.map((publishedCase) => ({ registryId: page.registryId, ...publishedCase })))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.registryId.localeCompare(b.registryId) || a.diaryNumber.localeCompare(b.diaryNumber))
    .slice(0, options.limit ?? 50);
  return { status: 200, body: { cases } };
};

function publishedSearchOptions(query: URLSearchParams): PublishedSearchOptions | { error: string } {
  const q = query.get("q")?.trim() ?? "";
  if (q && q.length < 3) return { error: "q must be at least 3 characters" };
  if (q.length > 200) return { error: "q must be at most 200 characters" };
  const rawLimit = query.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return { error: "limit must be an integer from 1 to 50" };
  return {
    ...(q ? { query: q } : {}),
    ...(query.get("category") ? { categoryPrefix: query.get("category")! } : {}),
    limit,
  };
}

const getMyCases: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "customer")
    return { status: 403, body: { error: "customer authentication required" } };
  return { status: 200, body: { cases: serializeCases(await listCustomerCases(h.db, req.principal.actor.customerId)) } };
};

// ---- Forms (Phase 3) -------------------------------------------------------

const postFormSubmit: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  try {
    const result = await submitForm(platform, h, req.params.formId!, req.principal, asObject(req.body), platform.clock.now());
    return { status: result.status, body: result.body };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
};

const postPendingDecision: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  const decision = req.params.decision === "approve" ? "approved" : "rejected";
  try {
    const result = await decidePending(platform, h, Number(req.params.pendingId!), decision, req.principal, platform.clock.now());
    return { status: result.status, body: result.body };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
};

// ---- registry list + meta (for the UI) -------------------------------------

function requestLocale(req: ApiRequest): string {
  const accepted = (req.acceptLanguage ?? "").split(",").map((item) => item.split(";")[0]?.trim()).filter((item): item is string => !!item);
  return resolveRequestedLocale([req.query.get("lang"), ...accepted], DEFAULT_LOCALE_CONFIG);
}

function localizedHeaders(locale: string): Readonly<Record<string, string>> {
  return { "Content-Language": locale, "Vary": "Accept-Language" };
}

function translationMap(rows: readonly Record<string, unknown>[], idColumn: string, valueColumn: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const id = String(row[idColumn]);
    const values = result.get(id) ?? new Map<string, string>();
    values.set(String(row.locale), String(row[valueColumn]));
    result.set(id, values);
  }
  return result;
}

function pick(values: Map<string, string> | undefined, legacy: string, locale: string, fallbacks: Set<string>): string {
  const exact = values?.get(locale);
  if (exact) return exact;
  const source = values?.get("fi") ?? legacy;
  if (locale !== "fi") fallbacks.add("fi");
  return source;
}

const getRegistries: ApiHandler = async (platform, req) => {
  const locale = requestLocale(req);
  const fallbacks = new Set<string>();
  const translations = translationMap(await platform.shared.all("SELECT registry_id, locale, name FROM registry_translations"), "registry_id", "name");
  const tokenRegistry = req.principal.kind === "token" ? req.principal.scope.registryId : undefined;
  const visible = tokenRegistry ? platform.allRegistries().filter((h) => h.def.registryId === tokenRegistry) : platform.allRegistries();
  const list = visible.map((h) => ({
    registryId: h.def.registryId,
    name: pick(translations.get(h.def.registryId), h.def.name, locale, fallbacks),
    diaryCode: h.def.diary.registryCode,
  }));
  return { status: 200, headers: localizedHeaders(locale), body: { locale, fallbackLocales: [...fallbacks], registries: list } };
};

const getMeta: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind === "token" && (req.principal.scope.registryId !== h.def.registryId || !tokenAllows(req.principal.scope, "GET", "meta"))) return { status: 403, body: { error: "forbidden" } };
  const locale = requestLocale(req);
  const fallbacks = new Set<string>();
  const includeTranslations = req.query.get("include")?.split(",").includes("translations") === true;
  const isAdmin = req.principal.kind === "actor" && req.principal.actor.kind === "worker" && !!(await platform.shared.get("SELECT 1 AS ok FROM workers WHERE worker_id = ? AND is_admin = 1", [req.principal.actor.workerId]));
  if (includeTranslations && !isAdmin) return { status: 403, body: { error: "translations require admin authorization" } };
  const isWorker = req.principal.kind === "actor" && req.principal.actor.kind === "worker";
  const isCustomer = req.principal.kind === "actor" && req.principal.actor.kind === "customer";
  const projectionMetadata = req.principal.kind === "public" || (req.principal.kind === "token" && req.principal.scope.publishedOnly);

  const stateNames = translationMap(await h.db.all("SELECT state_id, locale, name FROM state_translations"), "state_id", "name");
  const states = (await h.db.all("SELECT id, name, is_open, is_waiting_for_customer FROM states")).map((r) => ({
    id: String(r.id), name: pick(stateNames.get(String(r.id)), String(r.name), locale, fallbacks),
    isOpen: Number(r.is_open) === 1, isWaitingForCustomer: Number(r.is_waiting_for_customer) === 1,
    ...(includeTranslations ? { translations: Object.fromEntries(stateNames.get(String(r.id)) ?? []) } : {}),
  }));
  const transitions = (await h.db.all("SELECT from_state, to_state FROM state_transitions")).map((r) => ({ from: String(r.from_state), to: String(r.to_state) }));
  const formNames = translationMap(await platform.shared.all("SELECT ft.form_id, ft.locale, ft.title FROM form_translations ft JOIN form_definitions f ON f.form_id = ft.form_id WHERE f.registry_id = ?", [h.def.registryId]), "form_id", "title");
  const forms = (await platform.shared.all("SELECT form_id, kind, audience, title, requires_approval, field_subset, property_schema, allow_attachments, operation_type FROM form_definitions WHERE registry_id = ? AND active = 1", [h.def.registryId])).map((r) => ({
    formId: String(r.form_id), kind: String(r.kind), audience: String(r.audience), title: pick(formNames.get(String(r.form_id)), String(r.title), locale, fallbacks),
    requiresApproval: Number(r.requires_approval) === 1, fieldSubset: r.field_subset ? JSON.parse(String(r.field_subset)) : null,
    propertySchema: r.property_schema ? JSON.parse(String(r.property_schema)) : null, allowAttachments: Number(r.allow_attachments) === 1,
    operationType: r.operation_type === null ? null : String(r.operation_type),
    ...(includeTranslations ? { translations: Object.fromEntries(formNames.get(String(r.form_id)) ?? []) } : {}),
  }));
  const categoryNames = translationMap(await platform.shared.all("SELECT category_id, locale, name FROM category_translations"), "category_id", "name");
  const categories = (await platform.shared.all("SELECT category_id, display_code, name FROM categories WHERE active = 1 ORDER BY display_code"))
    .map((r) => ({ code: String(r.display_code), name: pick(categoryNames.get(String(r.category_id)), String(r.name), locale, fallbacks), ...(includeTranslations ? { translations: Object.fromEntries(categoryNames.get(String(r.category_id)) ?? []) } : {}) }))
    .filter((category) => categoryBelongsToRegistry(h.def, category.code));
  const fieldNames = translationMap(await platform.shared.all("SELECT field_name, locale, label FROM field_translations WHERE registry_id = ?", [h.def.registryId]), "field_name", "label");
  const visibleFields = h.def.fields.filter((field) => projectionMetadata ? field.publicationEligible : isCustomer ? field.writableOnCreate || field.writableOnUpdate : true);
  const fields = visibleFields.map((field) => ({
    ...(isWorker ? field : { name: field.name, type: field.type, nullable: field.nullable, writableOnCreate: field.writableOnCreate, writableOnUpdate: field.writableOnUpdate, publicationEligible: field.publicationEligible }),
    label: pick(fieldNames.get(field.name), field.name, locale, fallbacks),
    ...(includeTranslations ? { translations: Object.fromEntries(fieldNames.get(field.name) ?? []) } : {}),
  }));
  const registryNames = translationMap(await platform.shared.all("SELECT registry_id, locale, name FROM registry_translations WHERE registry_id = ?", [h.def.registryId]), "registry_id", "name");
  const visibleForms = isWorker ? forms : isCustomer ? forms.filter((form) => form.audience === "customer") : [];
  return { status: 200, headers: localizedHeaders(locale), body: {
    locale, fallbackLocales: [...fallbacks], registryId: h.def.registryId,
    name: pick(registryNames.get(h.def.registryId), h.def.name, locale, fallbacks), fields, states,
    initialState: h.def.initialState, transitions: isWorker ? transitions : [], forms: visibleForms, categories,
  } };
};

// ---- worker portal ---------------------------------------------------------

const getWorkerCases: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "worker")
    return { status: 403, body: { error: "worker authentication required" } };
  const workerId = req.principal.actor.workerId;
  const view = req.query.get("view") ?? "authorized";
  const cases =
    view === "assigned" ? await assignedCases(h.db, workerId)
    : view === "unassigned" ? await unassignedOptedInCases(platform.shared, h.db, workerId, h.def.registryId, platform.clock.now())
    : await authorizedCases(platform.shared, h.db, workerId, h.def.registryId, platform.clock.now());
  return { status: 200, body: { view, cases: serializeCases(cases) } };
};

const getWorkerPending: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "worker")
    return { status: 403, body: { error: "worker authentication required" } };
  return { status: 200, body: { pending: await pendingToApprove(platform.shared, h.db, req.principal.actor.workerId, h.def.registryId, platform.clock.now()) } };
};

const postAssign: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "worker")
    return { status: 403, body: { error: "worker authentication required" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  const workerId = req.principal.actor.workerId;
  if (!(await workerCanAccessCategory(platform.shared, workerId, h.def.registryId, c.category, "write", platform.clock.now())))
    return { status: 403, body: { error: "forbidden" } };
  const role = String(asObject(req.body).role ?? "handler");
  if (!role.trim() || role.length > 100) return { status: 400, body: { error: "invalid role" } };
  const d = dialectFor(h.db.dialect);
  await h.db.transaction(async (tx) => {
    const values = [c.caseKey, workerId, role];
    await tx.run(
      d.insertIfAbsent("case_handlers", ["case_key", "worker_id", "role"]),
      h.db.dialect === "sqlserver" ? [...values, ...values] : values,
    );
    await appendAudit(tx, { actorKind: "worker", actorId: workerId, action: "case.assign", targetType: "case", targetId: String(c.caseKey), correlationId: req.correlationId, details: { role } }, platform.clock.now());
    await appendOutbox(tx, { eventType: "case.assigned", aggregateType: "case", aggregateId: String(c.caseKey), correlationId: req.correlationId, payload: { workerId, role } }, platform.clock.now());
  });
  return { status: 200, body: { assigned: true, workerId, role } };
};

// Publish / unpublish a case (§5.7). A deliberate act by an authorized worker;
// recorded as an operation so the publish decision is itself auditable.
const postPublish: ApiHandler = async (platform, req) => {
  const h = platform.registry(req.params.registry!);
  if (!h) return { status: 404, body: { error: "unknown registry" } };
  if (req.principal.kind !== "actor" || req.principal.actor.kind !== "worker")
    return { status: 403, body: { error: "worker authentication required" } };
  const c = await getCaseByDiaryNumber(h.db, req.params.diary!);
  if (!c) return { status: 404, body: { error: "not found" } };
  const workerId = req.principal.actor.workerId;
  if (!(await workerCanAccessCategory(platform.shared, workerId, h.def.registryId, c.category, "transition", platform.clock.now())))
    return { status: 403, body: { error: "forbidden" } };
  const body = asObject(req.body);
  const publish = body.publish !== false;
  const selectedFields = Array.isArray(body.fields) ? body.fields.map(String) : [];
  const selectedOperations = Array.isArray(body.operations) ? body.operations.map(Number) : [];
  const definitions = new Map(h.def.fields.map((field) => [field.name, field]));
  for (const name of selectedFields) {
    const field = definitions.get(name);
    if (!field?.publicationEligible) return { status: 400, body: { error: `field ${name} is not publication eligible` } };
  }
  try {
    await h.db.transaction(async (tx) => {
      const now = platform.clock.now();
      const changed = await tx.run("UPDATE cases SET is_published = ?, modified = ?, version = version + 1 WHERE case_key = ? AND version = ?", [publish ? 1 : 0, now, c.caseKey, c.version]);
      if (changed.changes !== 1) throw new Error("CONCURRENCY_CONFLICT");
      await tx.run("DELETE FROM published_operations WHERE case_key = ?", [c.caseKey]);
      if (!publish) {
        await tx.run("DELETE FROM published_cases WHERE case_key = ?", [c.caseKey]);
      } else {
        const internal = await tx.get("SELECT * FROM cases WHERE case_key = ?", [c.caseKey]);
        if (!internal) throw new Error("CASE_NOT_FOUND");
        const publicFields = Object.fromEntries(selectedFields.map((name) => [name, internal[name]]));
        await tx.run(
          dialectFor(h.db.dialect).upsert({
            table: "published_cases",
            insertColumns: ["case_key", "diary_number", "category", "state", "fields_json", "published_at", "published_by"],
            conflictColumns: ["case_key"],
            updateColumns: ["diary_number", "category", "state", "fields_json", "published_at", "published_by"],
          }),
          [c.caseKey, c.diaryNumber, c.category, c.state, JSON.stringify(publicFields), now, workerId],
        );
        for (const operationId of [...new Set(selectedOperations)]) {
          if (!Number.isSafeInteger(operationId) || operationId < 1) throw new Error("invalid operation selection");
          const op = await tx.get("SELECT operation_id, created, direction, type, subtype, properties, comment FROM operations WHERE case_key = ? AND operation_id = ?", [c.caseKey, operationId]);
          if (!op) throw new Error(`operation ${operationId} not found`);
          await tx.run(
            `INSERT INTO published_operations
              (case_key, operation_id, created, direction, type, subtype, properties, comment, published_at, published_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [c.caseKey, operationId, op.created as string, op.direction as string, op.type as string, op.subtype as string | null,
              op.properties as string | null, op.comment as string | null, now, workerId],
          );
        }
      }
      await appendOperation(tx, { caseKey: c.caseKey, direction: "internal", type: publish ? "published" : "unpublished", actorKind: "worker", actorId: workerId }, platform.clock.now());
      await appendAudit(tx, { actorKind: "worker", actorId: workerId, action: publish ? "case.publish" : "case.unpublish", targetType: "case", targetId: String(c.caseKey), correlationId: req.correlationId, details: { fields: selectedFields, operations: selectedOperations } }, now);
      await appendOutbox(tx, { eventType: publish ? "case.published" : "case.unpublished", aggregateType: "case", aggregateId: String(c.caseKey), correlationId: req.correlationId, payload: { fields: selectedFields, operations: selectedOperations } }, now);
    });
  } catch (error) {
    const message = (error as Error).message;
    return { status: message === "CONCURRENCY_CONFLICT" ? 409 : 400, body: { error: message } };
  }
  return { status: 200, body: { isPublished: publish } };
};

// ---- helpers ---------------------------------------------------------------

function actorStamp(p: Principal): { actorKind: "worker" | "customer" | "system"; actorId: string } {
  if (p.kind === "actor" && p.actor.kind === "worker") return { actorKind: "worker", actorId: p.actor.workerId };
  if (p.kind === "actor" && p.actor.kind === "customer") return { actorKind: "customer", actorId: p.actor.customerId };
  if (p.kind === "token") return { actorKind: "system", actorId: p.scope.tokenId };
  return { actorKind: "system", actorId: "" };
}

function serializeCases(cases: ReadonlyArray<{ caseKey: bigint; diaryNumber: string; category: string; state: string; isPublished: boolean; created: string; modified: string }>) {
  return cases.map((c) => ({ ...c, caseKey: Number(c.caseKey) }));
}

// ---- Route table -----------------------------------------------------------

const coreRoutes: readonly Route<ApiHandler>[] = [
  defineRoute("GET", "/api/registries", getRegistries),
  defineRoute("GET", "/api/published/search", getPublishedAcrossRegistries),
  defineRoute("GET", "/api/registries/:registry/meta", getMeta),
  defineRoute("GET", "/api/registries/:registry/published", getPublished),
  defineRoute("GET", "/api/registries/:registry/my-cases", getMyCases),
  defineRoute("GET", "/api/registries/:registry/worker/cases", getWorkerCases),
  defineRoute("GET", "/api/registries/:registry/worker/pending", getWorkerPending),
  defineRoute("GET", "/api/registries/:registry/cases/:diary", getCase),
  defineRoute("POST", "/api/registries/:registry/cases", postCase),
  defineRoute("POST", "/api/registries/:registry/cases/:diary/operations", postOperation),
  defineRoute("POST", "/api/registries/:registry/cases/:diary/transition", postTransition),
  defineRoute("POST", "/api/registries/:registry/cases/:diary/assign", postAssign),
  defineRoute("POST", "/api/registries/:registry/cases/:diary/publish", postPublish),
  defineRoute("POST", "/api/registries/:registry/forms/:formId/submit", postFormSubmit),
  defineRoute("POST", "/api/registries/:registry/pending/:pendingId/:decision", postPendingDecision),
];

/** Core portal/API routes + the management (admin) routes. */
export const routes: readonly Route<ApiHandler>[] = [...coreRoutes, ...adminRoutes];
