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
  readonly nullable?: boolean;
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
    if (!present || v === undefined) {
      if (required.has(name)) errors.push(`missing required property "${name}"`);
      continue;
    }
    if (v === null) {
      if (!prop.nullable) errors.push(`property "${name}" may not be null`);
      continue;
    }
    if (!typeMatches(prop.type, v)) errors.push(`property "${name}" must be ${prop.type}`);
  }

  return { valid: errors.length === 0, errors };
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
