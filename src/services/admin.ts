/**
 * Management-portal backend (Architecture §5.8). The administrative operations
 * that shape a registry WITHOUT a software release: edit fields, states,
 * transitions, categories, forms, rules, worker authorizations, and API tokens.
 *
 * Config edits are expressed as mutations of the registry's stored config
 * artifact, then re-applied via applyRegistryConfig — so a management change and
 * a config-as-code change go through exactly the same forward-only path and are
 * versioned identically (Decision D-05). This is what makes "change without a
 * release" safe rather than ad-hoc.
 */

import type { Platform } from "../api/platform.ts";
import type { Principal } from "../api/authz.ts";
import { dialectFor } from "../db/dialect.ts";
import type { RegistryConfig, StateDef, FormConfig, RuleConfig } from "../config/registry-config.ts";
import type { RegistryFieldDef } from "../config/registry-catalog.ts";
import { applyRegistryConfig, applyPlatformConfig } from "./config-apply.ts";
import { exportRegistryConfig } from "./config-promote.ts";
import { mintApiToken, type HttpMethod } from "../api/tokens.ts";
import { categoryBelongsToRegistry } from "../config/validation.ts";

/** True iff the principal is an authenticated admin worker. */
export async function isAdmin(platform: Platform, principal: Principal): Promise<boolean> {
  if (principal.kind !== "actor" || principal.actor.kind !== "worker") return false;
  const row = await platform.shared.get("SELECT is_admin FROM workers WHERE worker_id = ? AND active = 1", [principal.actor.workerId]);
  return !!row && Number(row.is_admin) === 1;
}

/**
 * Load the current config artifact, apply a mutation, bump the version, and
 * re-apply. Returns the new version. This is the spine of every config edit.
 */
export async function mutateRegistryConfig(
  platform: Platform,
  registryId: string,
  mutate: (cfg: RegistryConfig) => RegistryConfig,
  now: string,
): Promise<{ version: number; addedColumns: string[] }> {
  const current = await exportRegistryConfig(platform.shared, registryId);
  if (!current) throw new Error(`unknown registry ${registryId}`);
  const next = mutate(current);
  const bumped: RegistryConfig = { ...next, version: (current.version ?? 1) + 1 };
  const h = platform.registry(registryId);
  if (!h) throw new Error(`registry ${registryId} not registered`);
  const result = await applyRegistryConfig(platform.shared, h.db, bumped, now);
  // Refresh the live registry definition so subsequent requests see the change
  // (e.g. a newly added field is immediately usable). RegistryConfig is
  // structurally a RegistryDefinition.
  platform.registerRegistry(bumped, h.db);
  return result;
}

export async function addField(platform: Platform, registryId: string, field: RegistryFieldDef, now: string) {
  return mutateRegistryConfig(platform, registryId, (cfg) => {
    if (cfg.fields.some((f) => f.name === field.name)) throw new Error(`field ${field.name} already exists`);
    return { ...cfg, fields: [...cfg.fields, field] };
  }, now);
}

export async function addState(platform: Platform, registryId: string, state: StateDef, now: string) {
  return mutateRegistryConfig(platform, registryId, (cfg) => ({ ...cfg, states: [...cfg.states, state] }), now);
}

export async function addTransition(platform: Platform, registryId: string, from: string, to: string, now: string) {
  return mutateRegistryConfig(platform, registryId, (cfg) => {
    const known = new Set(cfg.states.map((s) => s.id));
    if (!known.has(from) || !known.has(to)) throw new Error("transition references unknown state");
    if (cfg.transitions.some(([f, t]) => f === from && t === to)) return cfg;
    return { ...cfg, transitions: [...cfg.transitions, [from, to]] };
  }, now);
}

export async function addForm(platform: Platform, registryId: string, form: FormConfig, now: string) {
  return mutateRegistryConfig(platform, registryId, (cfg) => ({ ...cfg, forms: [...(cfg.forms ?? []).filter((f) => f.formId !== form.formId), form] }), now);
}

export async function addRule(platform: Platform, registryId: string, rule: RuleConfig, now: string) {
  return mutateRegistryConfig(platform, registryId, (cfg) => ({ ...cfg, rules: [...(cfg.rules ?? []).filter((r) => r.ruleId !== rule.ruleId), rule] }), now);
}

export async function addCategory(platform: Platform, code: string, name: string, now: string): Promise<void> {
  await applyPlatformConfig(platform.shared, { categories: [{ code, name }] }, now);
}

export async function grantAuthorization(
  platform: Platform,
  input: { workerId: string; registryId: string; categoryId: string; canRead?: boolean; canWrite?: boolean; canTransition?: boolean; canApprove?: boolean; optedIn?: boolean; validFrom?: string; validUntil?: string },
): Promise<void> {
  const registry = platform.registry(input.registryId);
  if (!registry) throw new Error(`unknown registry ${input.registryId}`);
  if (!categoryBelongsToRegistry(registry.def, input.categoryId)) throw new Error("authorization category is outside registry scope");
  const worker = await platform.shared.get("SELECT 1 AS ok FROM workers WHERE worker_id = ? AND active = 1", [input.workerId]);
  if (!worker) throw new Error(`unknown or inactive worker ${input.workerId}`);
  const category = await platform.shared.get("SELECT 1 AS ok FROM categories WHERE category_id = ? AND active = 1", [input.categoryId]);
  if (!category) throw new Error(`unknown or inactive category ${input.categoryId}`);
  const validFrom = input.validFrom === undefined ? undefined : Date.parse(input.validFrom);
  const validUntil = input.validUntil === undefined ? undefined : Date.parse(input.validUntil);
  if (validFrom !== undefined && Number.isNaN(validFrom)) throw new Error("invalid validFrom");
  if (validUntil !== undefined && Number.isNaN(validUntil)) throw new Error("invalid validUntil");
  if (validFrom !== undefined && validUntil !== undefined && validFrom > validUntil) throw new Error("validFrom must not be after validUntil");
  const d = dialectFor(platform.shared.dialect);
  await platform.shared.run(
    d.upsert({
      table: "worker_authorizations",
      insertColumns: ["worker_id", "registry_id", "category_id", "can_read", "can_write", "can_transition", "can_approve", "opted_in", "valid_from", "valid_until"],
      conflictColumns: ["worker_id", "registry_id", "category_id"],
      updateColumns: ["can_read", "can_write", "can_transition", "can_approve", "opted_in", "valid_from", "valid_until"],
    }),
    [
      input.workerId, input.registryId, input.categoryId,
      input.canRead === false ? 0 : 1,
      input.canWrite === false ? 0 : 1,
      input.canTransition === false ? 0 : 1,
      input.canApprove ? 1 : 0,
      input.optedIn === false ? 0 : 1,
      input.validFrom ?? null,
      input.validUntil ?? null,
    ],
  );
}

export async function mintToken(
  platform: Platform,
  registryId: string,
  input: { methods: HttpMethod[]; resources: string[]; categoryScope?: string; publishedOnly?: boolean; description?: string },
  now: string,
): Promise<{ tokenId: string; raw: string }> {
  return mintApiToken(platform.shared, {
    registryId,
    methods: input.methods,
    resources: input.resources,
    ...(input.categoryScope !== undefined ? { categoryScope: input.categoryScope } : {}),
    ...(input.publishedOnly !== undefined ? { publishedOnly: input.publishedOnly } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  }, now);
}

export async function revokeToken(platform: Platform, tokenId: string): Promise<boolean> {
  const res = await platform.shared.run("UPDATE api_tokens SET active = 0 WHERE token_id = ?", [tokenId]);
  return res.changes > 0;
}
