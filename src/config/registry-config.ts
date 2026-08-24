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
}

export interface StateDef {
  readonly id: string;
  readonly name: string;
  readonly isOpen: boolean;
  readonly isWaitingForCustomer: boolean;
}

export type TransitionDef = readonly [from: string, to: string];

export interface FormConfig {
  readonly formId: string;
  readonly kind: "case" | "operation";
  readonly audience: "worker" | "customer";
  readonly title: string;
  readonly requiresApproval?: boolean;
  readonly fieldSubset?: readonly string[];
  readonly propertySchema?: ObjectSchema;
  readonly allowAttachments?: boolean;
  readonly operationType?: string;
}

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
  readonly database: string;
  readonly diary: DiaryFormat;
  readonly initialState: string;
  readonly categoryRoots: readonly string[];
  readonly fields: readonly RegistryFieldDef[];
  readonly states: readonly StateDef[];
  readonly transitions: readonly TransitionDef[];
  readonly forms?: readonly FormConfig[];
  readonly rules?: readonly RuleConfig[];
  /** Config schema version, bumped as the definition evolves (promotion aid). */
  readonly version?: number;
}

/** Platform-wide configuration shared by all registries (the category registry). */
export interface PlatformConfig {
  readonly categories: readonly CategoryDef[];
}
