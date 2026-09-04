import type { RegistryConfig, RuleConfig } from "./registry-config.ts";
import type { RegistryFieldDef } from "./registry-catalog.ts";
import type { Condition } from "../domain/rule-types.ts";
import { isWithin, normalizePath } from "../domain/categories.ts";
import { validateLocalizedText } from "./localization.ts";
import { isSafePattern } from "../domain/json-schema.ts";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(value: string, label = "identifier"): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${label} is not a safe SQL identifier: ${value}`);
}

function assertGovernedField(field: RegistryFieldDef): void {
  assertIdentifier(field.name, "field name");
  if (!field.legalBasis.trim()) throw new Error(`field ${field.name} requires legalBasis`);
  if (!field.purpose.trim()) throw new Error(`field ${field.name} requires purpose`);
  if (!field.retentionPolicy.trim()) throw new Error(`field ${field.name} requires retentionPolicy`);
  if (!new Set(["public", "normal", "sensitive", "restricted"]).has(field.sensitivity)) {
    throw new Error(`field ${field.name} has invalid sensitivity`);
  }
  if (field.labels) validateLocalizedText(field.labels, `field ${field.name} label`);
  if (field.helpText) validateLocalizedText(field.helpText, `field ${field.name} help text`);
}

function assertCondition(condition: Condition | undefined, fields: ReadonlySet<string>, roots: readonly string[]): void {
  if (condition === undefined || condition === null) return;
  if ("all" in condition) {
    for (const item of condition.all) assertCondition(item, fields, roots);
    return;
  }
  if ("any" in condition) {
    for (const item of condition.any) assertCondition(item, fields, roots);
    return;
  }
  if ("categoryWithin" in condition) {
    normalizePath(condition.categoryWithin);
    if (!roots.some((root) => isWithin(condition.categoryWithin, root))) {
      throw new Error(`rule condition category ${condition.categoryWithin} is outside registry scope`);
    }
    return;
  }
  if (!fields.has(condition.field)) throw new Error(`rule condition references unknown field ${condition.field}`);
}

function assertRule(rule: RuleConfig, fields: ReadonlyMap<string, RegistryFieldDef>, states: ReadonlySet<string>, roots: readonly string[]): void {
  if (!rule.ruleId.trim()) throw new Error("ruleId is required");
  if (rule.onToState && !states.has(rule.onToState)) throw new Error(`rule ${rule.ruleId} references unknown state`);
  assertCondition(rule.condition, new Set(fields.keys()), roots);
  if (rule.actionType === "update_values") {
    const values = rule.actionParams?.fields;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`rule ${rule.ruleId} requires fields`);
    for (const name of Object.keys(values)) {
      assertIdentifier(name, "rule field");
      const field = fields.get(name);
      if (!field) throw new Error(`rule ${rule.ruleId} references unknown field ${name}`);
      if (!field.writableOnUpdate) throw new Error(`rule ${rule.ruleId} cannot update governed field ${name}`);
    }
  }
  if (rule.actionType === "set_state") {
    const target = String(rule.actionParams?.toState ?? "");
    if (!states.has(target)) throw new Error(`rule ${rule.ruleId} references unknown target state`);
  }
  if (rule.actionType === "create_operation" && rule.actionParams?.direction !== undefined) {
    if (!new Set(["incoming", "outgoing", "internal"]).has(String(rule.actionParams.direction))) {
      throw new Error(`rule ${rule.ruleId} has invalid operation direction`);
    }
  }
}

/** Validate the complete promotable artifact before it can produce DDL or rules. */
export function validateRegistryConfig(config: RegistryConfig): void {
  if (!config.registryId.trim()) throw new Error("registryId is required");
  if (!config.name.trim()) throw new Error(`registry ${config.registryId} requires a name`);
  if (config.labels) validateLocalizedText(config.labels, `registry ${config.registryId} label`);
  if (!config.database.trim()) throw new Error(`registry ${config.registryId} requires a database key`);
  if (!config.diary.registryCode.trim() || config.diary.registryCode.length > 30) throw new Error("invalid diary registry code");
  if (!Number.isSafeInteger(config.diary.numberPadding) || config.diary.numberPadding < 1 || config.diary.numberPadding > 12) throw new Error("invalid diary number padding");
  if (!config.diary.separator || config.diary.separator.length > 3) throw new Error("invalid diary separator");
  if (!config.initialState || !config.states.some((s) => s.id === config.initialState)) {
    throw new Error(`registry ${config.registryId} has invalid initialState`);
  }
  if (config.categoryRoots.length === 0) throw new Error(`registry ${config.registryId} requires categoryRoots`);
  for (const root of config.categoryRoots) normalizePath(root);

  const names = new Set<string>();
  const fieldDefs = new Map<string, RegistryFieldDef>();
  for (const field of config.fields) {
    assertGovernedField(field);
    if (names.has(field.name)) throw new Error(`duplicate field ${field.name}`);
    names.add(field.name);
    fieldDefs.set(field.name, field);
  }

  const states = new Set(config.states.map((s) => s.id));
  if (states.size !== config.states.length) throw new Error("duplicate state id");
  for (const state of config.states) {
    if (state.labels) validateLocalizedText(state.labels, `state ${state.id} label`);
    if (state.descriptions) validateLocalizedText(state.descriptions, `state ${state.id} description`);
  }
  for (const [from, to] of config.transitions) {
    if (!states.has(from) || !states.has(to)) throw new Error(`transition ${from} -> ${to} references unknown state`);
  }
  const formIds = new Set<string>();
  const forms = [...(config.caseForms ?? []), ...(config.operationForms ?? []), ...(config.forms ?? [])];
  for (const form of forms) {
    if (!form.formId.trim() || formIds.has(form.formId)) throw new Error(`invalid or duplicate form id ${form.formId}`);
    formIds.add(form.formId);
    if (!form.title.trim()) throw new Error(`form ${form.formId} requires a title`);
    if ("description" in form && !form.description.trim()) throw new Error(`form ${form.formId} requires a description`);
    if (!new Set(["worker", "customer", "both"]).has(form.audience)) throw new Error(`form ${form.formId} has invalid audience`);
    if (form.titles) validateLocalizedText(form.titles, `form ${form.formId} title`);
    if (form.descriptions) validateLocalizedText(form.descriptions, `form ${form.formId} description`);
    if ("propertySchema" in form && form.propertySchema) {
      for (const [name, property] of Object.entries(form.propertySchema.properties)) {
        if (property.pattern !== undefined && !isSafePattern(property.pattern)) {
          throw new Error(`form ${form.formId} property ${name} has an invalid or unsafe pattern`);
        }
      }
    }
    if ("fieldSubset" in form && form.fieldSubset) {
      for (const name of form.fieldSubset) if (!names.has(name)) throw new Error(`form ${form.formId} references unknown field ${name}`);
    }
  }
  const ruleIds = new Set<string>();
  for (const rule of config.rules ?? []) {
    if (ruleIds.has(rule.ruleId)) throw new Error(`duplicate rule id ${rule.ruleId}`);
    ruleIds.add(rule.ruleId);
    assertRule(rule, fieldDefs, states, config.categoryRoots);
  }
}

export function categoryBelongsToRegistry(config: Pick<RegistryConfig, "categoryRoots">, category: string): boolean {
  normalizePath(category);
  return config.categoryRoots.some((root) => isWithin(category, root));
}
