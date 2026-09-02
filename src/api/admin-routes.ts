/**
 * Management-portal REST routes (Architecture §5.8). All require an admin
 * principal (worker with is_admin). These are the backend the management portal
 * UI drives; exposing them as the same REST surface keeps one auth model.
 */

import type { Platform } from "./platform.ts";
import { defineRoute, type Route } from "./router.ts";
import type { ApiHandler, ApiRequest, ApiResponse } from "./http-types.ts";
import {
  isAdmin, addField, addState, addTransition, addForm, addCaseForm, addOperationForm, addRule, addCategory,
  grantAuthorization, mintToken, revokeToken,
} from "../services/admin.ts";
import { exportAllRegistries } from "../services/exports.ts";
import { listConfigVersions } from "../services/config-promote.ts";
import type { HttpMethod } from "./tokens.ts";

function obj(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** Wrap a handler so it runs only for admins; else 403. */
function admin(fn: ApiHandler): ApiHandler {
  return async (platform, req) => {
    if (!(await isAdmin(platform, req.principal))) return { status: 403, body: { error: "admin authentication required" } };
    try {
      return await fn(platform, req);
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message } };
    }
  };
}

const fields: ApiHandler = async (p, req) => {
  const b = obj(req.body);
  const r = await addField(p, req.params.registry!, {
    name: String(b.name), type: b.type as "text" | "integer" | "decimal" | "date" | "boolean", nullable: b.nullable !== false,
    writableOnCreate: b.writableOnCreate === true, writableOnUpdate: b.writableOnUpdate === true,
    publicationEligible: b.publicationEligible === true,
    legalBasis: String(b.legalBasis ?? ""), purpose: String(b.purpose ?? ""),
    sensitivity: b.sensitivity as "public" | "normal" | "sensitive" | "restricted",
    retentionPolicy: String(b.retentionPolicy ?? ""),
  }, p.clock.now());
  return { status: 201, body: { version: r.version, addedColumns: r.addedColumns } };
};

const states: ApiHandler = async (p, req) => {
  const b = obj(req.body);
  const r = await addState(p, req.params.registry!, { id: String(b.id), name: String(b.name ?? b.id), isOpen: b.isOpen !== false, isWaitingForCustomer: b.isWaitingForCustomer === true }, p.clock.now());
  return { status: 201, body: { version: r.version } };
};

const transitions: ApiHandler = async (p, req) => {
  const b = obj(req.body);
  const r = await addTransition(p, req.params.registry!, String(b.from), String(b.to), p.clock.now());
  return { status: 201, body: { version: r.version } };
};

const forms: ApiHandler = async (p, req) => {
  const b = obj(req.body);
  const r = await addForm(p, req.params.registry!, b as never, p.clock.now());
  return { status: 201, body: { version: r.version } };
};

const caseForms: ApiHandler = async (p, req) => {
  const r = await addCaseForm(p, req.params.registry!, obj(req.body) as never, p.clock.now());
  return { status: 201, body: { version: r.version } };
};

const operationForms: ApiHandler = async (p, req) => {
  const r = await addOperationForm(p, req.params.registry!, obj(req.body) as never, p.clock.now());
  return { status: 201, body: { version: r.version } };
};

const rules: ApiHandler = async (p, req) => {
  const b = obj(req.body);
  const r = await addRule(p, req.params.registry!, b as never, p.clock.now());
  return { status: 201, body: { version: r.version } };
};

const categories: ApiHandler = async (p, req) => {
  const b = obj(req.body);
  await addCategory(p, String(b.code), String(b.name ?? b.code), p.clock.now());
  return { status: 201, body: { ok: true } };
};

const authorizations: ApiHandler = async (p, req) => {
  const b = obj(req.body);
  await grantAuthorization(p, {
    workerId: String(b.workerId), registryId: String(b.registryId), categoryId: String(b.categoryId),
    ...(typeof b.canRead === "boolean" ? { canRead: b.canRead } : {}),
    ...(typeof b.canWrite === "boolean" ? { canWrite: b.canWrite } : {}),
    ...(typeof b.canTransition === "boolean" ? { canTransition: b.canTransition } : {}),
    ...(typeof b.canApprove === "boolean" ? { canApprove: b.canApprove } : {}),
    ...(typeof b.optedIn === "boolean" ? { optedIn: b.optedIn } : {}),
    ...(b.validFrom !== undefined ? { validFrom: String(b.validFrom) } : {}),
    ...(b.validUntil !== undefined ? { validUntil: String(b.validUntil) } : {}),
  });
  return { status: 201, body: { ok: true } };
};

const tokens: ApiHandler = async (p, req) => {
  const b = obj(req.body);
  const minted = await mintToken(p, req.params.registry!, {
    methods: (Array.isArray(b.methods) ? b.methods : []) as HttpMethod[],
    resources: (Array.isArray(b.resources) ? b.resources : []) as string[],
    ...(b.categoryScope !== undefined ? { categoryScope: String(b.categoryScope) } : {}),
    ...(b.publishedOnly !== undefined ? { publishedOnly: b.publishedOnly === true } : {}),
    ...(b.description !== undefined ? { description: String(b.description) } : {}),
  }, p.clock.now());
  // The raw token is returned ONCE, here, and never stored in plain text.
  return { status: 201, body: minted };
};

const revoke: ApiHandler = async (p, req) => {
  const ok = await revokeToken(p, req.params.tokenId!);
  return ok ? { status: 200, body: { revoked: true } } : { status: 404, body: { error: "token not found" } };
};

const runExports: ApiHandler = async (p) => {
  return { status: 200, body: { results: await exportAllRegistries(p, p.clock.now()) } };
};

const configVersions: ApiHandler = async (p, req) => {
  return { status: 200, body: { versions: await listConfigVersions(p.shared, req.params.registry!) } };
};

export const adminRoutes: readonly Route<ApiHandler>[] = [
  defineRoute("POST", "/api/admin/registries/:registry/fields", admin(fields)),
  defineRoute("POST", "/api/admin/registries/:registry/states", admin(states)),
  defineRoute("POST", "/api/admin/registries/:registry/transitions", admin(transitions)),
  defineRoute("POST", "/api/admin/registries/:registry/forms", admin(forms)),
  defineRoute("POST", "/api/admin/registries/:registry/case-forms", admin(caseForms)),
  defineRoute("POST", "/api/admin/registries/:registry/operation-forms", admin(operationForms)),
  defineRoute("POST", "/api/admin/registries/:registry/rules", admin(rules)),
  defineRoute("GET", "/api/admin/registries/:registry/config-versions", admin(configVersions)),
  defineRoute("POST", "/api/admin/registries/:registry/tokens", admin(tokens)),
  defineRoute("POST", "/api/admin/registries/:registry/tokens/:tokenId/revoke", admin(revoke)),
  defineRoute("POST", "/api/admin/categories", admin(categories)),
  defineRoute("POST", "/api/admin/authorizations", admin(authorizations)),
  defineRoute("POST", "/api/admin/exports/run", admin(runExports)),
];
