/**
 * Rule condition grammar (Architecture §9), in a neutral module so both the
 * rule engine and the declarative config layer can reference it without a
 * dependency cycle.
 *
 * A condition is a small, safe, declarative expression — never code.
 */

export type Condition =
  | null
  | { field: string; equals: unknown }
  | { field: string; notEquals: unknown }
  | { categoryWithin: string }
  | { all: Condition[] }
  | { any: Condition[] };
