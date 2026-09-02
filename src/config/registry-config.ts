/**
 * Declarative registry configuration (config-as-code, Decision D-05).
 *
 * A RegistryConfig fully describes a registry — its statutory fields, lifecycle,
 * forms, and rules — as data. Standing up a new registry is authoring one of
 * these and applying it (services/config-apply.ts); NO application code changes.
 * This is the concrete realization of the platform's core promise: many
 * registries, configured not coded (Plan Phase 5).
 *
 * These objects are the promotable artifact that flows dev → test → prod.
 */

import type { RegistryFieldDef, DiaryFormat } from "./registry-catalog.ts";
import type { ObjectSchema } from "../domain/json-schema.ts";
import type { Condition } from "../domain/rule-types.ts";

export interface CategoryDef {
  readonly code: string; // e.g. "105.04.03"
  readonly name: string;
  readonly labels?: LocalizedText;
}

export interface LocalizedText {
  readonly sourceLocale: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface StateDef {
  readonly id: string;
  readonly name: string;
  readonly labels?: LocalizedText;
  readonly descriptions?: LocalizedText;
  readonly isOpen: boolean;
  readonly isWaitingForCustomer: boolean;
}

export type TransitionDef = readonly [from: string, to: string];

export interface FormBaseConfig {
  readonly formId: string;
  readonly audience: "worker" | "customer" | "both";
  readonly title: string;
  /** Form-filling instructions shown before the fields. */
  readonly description: string;
  readonly titles?: LocalizedText;
  readonly descriptions?: LocalizedText;
}

export interface CaseFormConfig extends FormBaseConfig {
  readonly requiresApproval?: boolean;
  readonly fieldSubset?: readonly string[];
}

export interface OperationFormConfig extends FormBaseConfig {
  readonly propertySchema?: ObjectSchema;
  readonly allowAttachments?: boolean;
  readonly operationType?: string;
}

export type FormConfig = (CaseFormConfig & { readonly kind: "case" }) | (OperationFormConfig & { readonly kind: "operation" });

export interface RuleConfig {
  readonly ruleId: string;
  readonly onToState?: string | null;
  readonly condition?: Condition;
  readonly actionType: string;
  readonly actionParams?: Record<string, unknown>;
  readonly ordering?: number;
}

export interface RegistryConfig {
  readonly registryId: string;
  readonly name: string;
  readonly labels?: LocalizedText;
  readonly database: string;
  readonly diary: DiaryFormat;
  readonly initialState: string;
  readonly categoryRoots: readonly string[];
  readonly fields: readonly RegistryFieldDef[];
  readonly states: readonly StateDef[];
  readonly transitions: readonly TransitionDef[];
  readonly caseForms?: readonly CaseFormConfig[];
  readonly operationForms?: readonly OperationFormConfig[];
  /** @deprecated Accepted when importing older config artifacts. */
  readonly forms?: readonly FormConfig[];
  readonly rules?: readonly RuleConfig[];
  /** Config schema version, bumped as the definition evolves (promotion aid). */
  readonly version?: number;
}

/** Platform-wide configuration shared by all registries (the category registry). */
export interface PlatformConfig {
  readonly categories: readonly CategoryDef[];
  readonly locales?: LocaleConfig;
}

export interface LocaleConfig {
  readonly supported: readonly string[];
  readonly default: string;
}
