/**
 * Request authorization — the single place the API decides who may do what
 * (Architecture §6.4). Unifies the two human actor models and API tokens so a
 * browser click and an integration call are judged by one implementation.
 */

import type { Platform } from "./platform.ts";
import type { Actor } from "../core/handler.ts";
import type { CaseView } from "../core/queries.ts";
import { verifyApiToken, tokenAllows, type TokenScope, type HttpMethod } from "./tokens.ts";
import { customerOwnsCase, workerCanAccessCategory } from "../core/authorization.ts";
import type { RegistryHandle } from "./platform.ts";

export type Principal =
  | { kind: "actor"; actor: Actor }
  | { kind: "token"; scope: TokenScope }
  | { kind: "public" };

/** Resolve an Authorization header value to a principal. */
export async function resolvePrincipal(platform: Platform, authHeader: string | undefined): Promise<Principal> {
  if (!authHeader) return { kind: "public" };
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return { kind: "public" };
  if (bearer.startsWith("rk_")) {
    const scope = await verifyApiToken(platform.shared, bearer);
    return scope ? { kind: "token", scope } : { kind: "public" };
  }
  const actor = platform.identity.resolve(bearer);
  if (!actor) return { kind: "public" };
  const table = actor.kind === "customer" ? "customers" : actor.kind === "worker" ? "workers" : null;
  const column = actor.kind === "customer" ? "customer_id" : actor.kind === "worker" ? "worker_id" : null;
  if (!table || !column) return { kind: "public" };
  const id = actor.kind === "customer" ? actor.customerId : actor.kind === "worker" ? actor.workerId : "";
  const active = await platform.shared.get(`SELECT 1 AS ok FROM ${table} WHERE ${column} = ? AND active = 1`, [id]);
  return active ? { kind: "actor", actor } : { kind: "public" };
}

/** May the principal READ this case? */
export async function canReadCase(platform: Platform, principal: Principal, h: RegistryHandle, c: CaseView): Promise<boolean> {
  switch (principal.kind) {
    case "public":
      return c.isPublished;
    case "actor":
      return await actorCanAccess(platform, principal.actor, h, c, "read");
    case "token":
      return tokenCanAccess(principal.scope, h.def.registryId, "GET", "cases", c);
  }
}

/** May the principal WRITE (add operation) to this case? */
export async function canWriteCase(platform: Platform, principal: Principal, h: RegistryHandle, c: CaseView): Promise<boolean> {
  switch (principal.kind) {
    case "public":
      return false;
    case "actor":
      // Customer mutations are form commands, never the generic operation API.
      if (principal.actor.kind === "customer") return false;
      return await actorCanAccess(platform, principal.actor, h, c, "write");
    case "token":
      return tokenCanAccess(principal.scope, h.def.registryId, "POST", "operations", c);
  }
}

/** May the principal TRANSITION this case's state? */
export async function canTransitionCase(platform: Platform, principal: Principal, h: RegistryHandle, c: CaseView): Promise<boolean> {
  switch (principal.kind) {
    case "public":
      return false;
    case "actor":
      // Ownership allows reading and form submission, not exercising a worker
      // state-machine command.
      if (principal.actor.kind === "customer") return false;
      return await actorCanAccess(platform, principal.actor, h, c, "transition");
    case "token":
      return tokenCanAccess(principal.scope, h.def.registryId, "POST", "transition", c);
  }
}

async function actorCanAccess(
  platform: Platform,
  actor: Actor,
  h: RegistryHandle,
  c: CaseView,
  permission: "read" | "write" | "transition",
): Promise<boolean> {
  if (actor.kind === "customer") {
    // Customers act only on cases they own; equal rights, no category scope.
    return await customerOwnsCase(platform.shared, h.db, c.caseKey, actor.customerId);
  }
  if (actor.kind === "worker") {
    return await workerCanAccessCategory(platform.shared, actor.workerId, h.def.registryId, c.category, permission, platform.clock.now());
  }
  return false;
}

function tokenCanAccess(scope: TokenScope, registryId: string, method: HttpMethod, resource: string, c: CaseView): boolean {
  if (scope.registryId !== registryId) return false;
  if (scope.publishedOnly && !c.isPublished) return false;
  return tokenAllows(scope, method, resource, c.category);
}
