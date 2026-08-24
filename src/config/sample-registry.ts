/**
 * Backward-compatible views of the Permit registry, derived from the
 * declarative PERMIT_CONFIG. Used by the domain-level demo/migrate scripts and
 * the spine/diary/category tests, which predate the config-as-code layer.
 * New code should use PERMIT_CONFIG (config/registries/permit.ts) and the
 * config applier instead.
 */

import type { RegistryDefinition } from "./registry-catalog.ts";
import { PERMIT_CONFIG } from "./registries/permit.ts";

export const PERMIT_REGISTRY: RegistryDefinition = {
  registryId: PERMIT_CONFIG.registryId,
  name: PERMIT_CONFIG.name,
  database: PERMIT_CONFIG.database,
  diary: PERMIT_CONFIG.diary,
  initialState: PERMIT_CONFIG.initialState,
  categoryRoots: PERMIT_CONFIG.categoryRoots,
  fields: PERMIT_CONFIG.fields,
};

export const PERMIT_STATES = PERMIT_CONFIG.states.map((s) => ({
  id: s.id,
  name: s.name,
  isOpen: s.isOpen ? 1 : 0,
  isWaitingForCustomer: s.isWaitingForCustomer ? 1 : 0,
}));

export const PERMIT_TRANSITIONS = PERMIT_CONFIG.transitions;
