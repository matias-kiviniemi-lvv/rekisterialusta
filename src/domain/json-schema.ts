/**
 * Minimal JSON-schema-subset validator (Architecture §5.4).
 *
 * Operation forms declare their payload as a JSON schema: each property's name,
 * type, and whether it is mandatory. A full validator (e.g. Ajv) is the
 * production choice; this dependency-free subset covers exactly what the forms
 * platform needs (object with typed, required/optional properties) so the
 * foundation validates untrusted form input without adding a dependency or a
 * build step. The stored schema shape is forward-compatible with Ajv.
 */

export interface PropertySchema {
  readonly type: "string" | "number" | "integer" | "boolean";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  /** Message shown when this property's value does not satisfy its constraints. */
  readonly errorMessage?: string;
}

export interface ObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, PropertySchema>>;
  readonly required?: readonly string[];
  /** Reject properties not named in `properties`. Default true. */
  readonly additionalProperties?: boolean;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const MAX_PATTERN_LENGTH = 256;
const MAX_PATTERN_VALUE_LENGTH = 1024;

/**
 * Conservative, dependency-free policy for regular expressions evaluated on
 * request data. It deliberately excludes constructs whose runtime can grow
 * super-linearly in JavaScript's backtracking regexp engine.
 */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH || /\\[1-9]/.test(pattern)) return false;
  let escaped = false;
  let inClass = false;
  let unboundedQuantifiers = 0;
  const groups: Array<{ containsQuantifier: boolean; containsAlternation: boolean }> = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === "[") { inClass = true; continue; }
    if (char === "]" && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === "(") groups.push({ containsQuantifier: false, containsAlternation: false });
    else if (char === "|") { if (groups.length) groups[groups.length - 1]!.containsAlternation = true; }
    else if (char === "*" || char === "+") {
      unboundedQuantifiers++;
      for (const group of groups) group.containsQuantifier = true;
    } else if (char === ")") {
      const group = groups.pop();
      const next = pattern[i + 1];
      if (group && (next === "*" || next === "+" || next === "{") && (group.containsQuantifier || group.containsAlternation)) return false;
    }
  }
  if (escaped || inClass || groups.length || unboundedQuantifiers > 1) return false;
  try { new RegExp(pattern); return true; } catch { return false; }
}

export function validate(schema: ObjectSchema, value: unknown): ValidationResult {
  const errors: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["payload must be an object"] };
  }
  const obj = value as Record<string, unknown>;
  const required = new Set(schema.required ?? []);

  if (schema.additionalProperties !== true) {
    for (const key of Object.keys(obj)) {
      if (!(key in schema.properties)) errors.push(`unexpected property "${key}"`);
    }
  }

  for (const [name, prop] of Object.entries(schema.properties)) {
    const present = name in obj;
    const v = obj[name];
    if (!present || v === undefined || (required.has(name) && (v === null || v === ""))) {
      if (required.has(name)) errors.push(`missing required property "${name}"`);
      continue;
    }
    if (v === null) {
      errors.push(`property "${name}" may not be null`);
      continue;
    }
    if (!typeMatches(prop.type, v)) {
      errors.push(prop.errorMessage || `property "${name}" must be ${prop.type}`);
      continue;
    }
    const constraintError = validateConstraints(prop, v);
    if (constraintError) errors.push(prop.errorMessage || `property "${name}" ${constraintError}`);
  }

  return { valid: errors.length === 0, errors };
}

function validateConstraints(prop: PropertySchema, value: unknown): string | undefined {
  if ((prop.type === "number" || prop.type === "integer") && typeof value === "number") {
    if (prop.minimum !== undefined && value < prop.minimum) return `must be at least ${prop.minimum}`;
    if (prop.maximum !== undefined && value > prop.maximum) return `must be at most ${prop.maximum}`;
  }
  if (prop.type === "string" && prop.pattern !== undefined && typeof value === "string") {
    if (!isSafePattern(prop.pattern)) return "has an invalid or unsafe configured pattern";
    if (value.length > MAX_PATTERN_VALUE_LENGTH) return `must be at most ${MAX_PATTERN_VALUE_LENGTH} characters when pattern validation is configured`;
    if (!new RegExp(prop.pattern).test(value)) return `must match pattern ${prop.pattern}`;
  }
  return undefined;
}

function typeMatches(type: PropertySchema["type"], v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
  }
}
