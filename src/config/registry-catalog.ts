/**
 * Registry catalog (Architecture §2.1, §11).
 *
 * Maps each registry to its database placement and per-registry settings.
 * In production this lives in the shared database with connection secrets in
 * the cloud secret manager (Key Vault / Secrets Manager); here it is a simple
 * in-memory/config representation sufficient for the foundation. The platform
 * core resolves a request's target registry to a Db through this catalog, so
 * "add or relocate a registry" is a catalog + secret change, not a redeploy.
 */

export interface DiaryFormat {
  /** Prefix used in REGISTRY/YEAR/NUMBER, e.g. "PERMIT". */
  readonly registryCode: string;
  /** Zero-pad width for the running number, e.g. 5 → 00142. */
  readonly numberPadding: number;
  /** Separator between parts. Default "/". */
  readonly separator: string;
}

export interface RegistryFieldDef {
  readonly name: string;
  readonly type: "text" | "integer" | "decimal" | "date" | "boolean";
  readonly nullable: boolean;
  /** Whether an intake command may set the field when the case is created. */
  readonly writableOnCreate: boolean;
  /** Whether a case form or rule may update the field after creation. */
  readonly writableOnUpdate: boolean;
  /** Fields are private unless explicitly eligible for publication. */
  readonly publicationEligible: boolean;
  readonly legalBasis: string;
  readonly purpose: string;
  readonly sensitivity: "public" | "normal" | "sensitive" | "restricted";
  readonly retentionPolicy: string;
}

export interface RegistryDefinition {
  /** Stable internal registry id. */
  readonly registryId: string;
  /** Human-readable name. */
  readonly name: string;
  /** Logical database placement key (server/pool + database). */
  readonly database: string;
  readonly diary: DiaryFormat;
  /** Server-controlled state for every newly-created case. */
  readonly initialState: string;
  /** A case category must fall under one of these registry-owned roots. */
  readonly categoryRoots: readonly string[];
  /** Statutory fields → real typed columns (Decision D-03). */
  readonly fields: readonly RegistryFieldDef[];
}

/** Maps the neutral field type to a SQLite column type. */
export function sqliteColumnType(t: RegistryFieldDef["type"]): string {
  switch (t) {
    case "text":
      return "TEXT";
    case "integer":
      return "INTEGER";
    case "decimal":
      return "REAL";
    case "date":
      return "TEXT"; // ISO-8601 date string
    case "boolean":
      return "INTEGER"; // 0/1
  }
}
