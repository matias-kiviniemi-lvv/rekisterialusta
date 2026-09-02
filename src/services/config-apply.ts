/**
 * Config-as-code applier (Architecture §5.12, Decision D-05).
 *
 * Applies a declarative RegistryConfig to a registry database + the shared
 * config database, idempotently and FORWARD-ONLY:
 *   - creates the spine on first apply; on later applies, ADDs any missing
 *     statutory field columns (a config-driven schema migration — "add a field"
 *     is deliberately a migration, D-03) but never drops.
 *   - upserts catalog, states, transitions, forms, rules to match the config.
 *   - records the applied version in config_versions.
 *
 * Applying the SAME config to dev, then test, then prod yields identical
 * behavior — this function IS the promotion mechanism (services/config-promote).
 *
 * All upserts, schema introspection, and ADD COLUMN go through the Dialect
 * builders (obtained from the adapter's dialect), so this runs on SQLite and
 * SQL Server without branching.
 */

import type { DbAdapter } from "../db/db.ts";
import { dialectFor } from "../db/dialect.ts";
import { migrate } from "../migrations/runner.ts";
import type { MigrationProgress } from "../migrations/runner.ts";
import { registrySpineMigration } from "../migrations/0002_registry_spine.ts";
import { m0004 } from "../migrations/0004_registry_forms.ts";
import { m0006Registry, m0006Shared } from "../migrations/0006_localized_metadata.ts";
import { m0007 } from "../migrations/0007_split_forms.ts";
import { m0008 } from "../migrations/0008_form_audience_both.ts";
import type { RegistryConfig, PlatformConfig } from "../config/registry-config.ts";
import { normalizePath, levelOf } from "../domain/categories.ts";
import { validateRegistryConfig } from "../config/validation.ts";
import { DEFAULT_LOCALE_CONFIG, normalizeLocale, resolveLocalizedText, validateLocaleConfig, validateLocalizedText } from "../config/localization.ts";

/** Apply platform-wide config (the shared category registry). Idempotent. */
export async function applyPlatformConfig(shared: DbAdapter, config: PlatformConfig, now: string): Promise<void> {
  validateLocaleConfig(config.locales ?? DEFAULT_LOCALE_CONFIG);
  await migrate(shared, [m0006Shared], now);
  const d = dialectFor(shared.dialect);
  const sql = d.upsert({
    table: "categories",
    insertColumns: ["category_id", "display_code", "path", "parent_id", "level", "name"],
    conflictColumns: ["category_id"],
    updateColumns: ["display_code", "path", "level", "name"],
  });
  await shared.transaction(async (tx) => {
    for (const cat of config.categories) {
      if (cat.labels) validateLocalizedText(cat.labels, `category ${cat.code} label`);
      await tx.run(sql, [cat.code, cat.code, normalizePath(cat.code), null, levelOf(cat.code), cat.name]);
      for (const [locale, name] of Object.entries(cat.labels?.values ?? { fi: cat.name })) {
        await tx.run(d.upsert({ table: "category_translations", insertColumns: ["category_id", "locale", "name"], conflictColumns: ["category_id", "locale"], updateColumns: ["name"] }), [cat.code, normalizeLocale(locale), name]);
      }
    }
  });
}

/**
 * Apply a registry config to its own database (regDb) + shared config (shared).
 * `regDb` must be the registry's database (may be fresh — the spine is created
 * on first apply). Returns the applied version.
 */
export async function applyRegistryConfig(
  shared: DbAdapter,
  regDb: DbAdapter,
  config: RegistryConfig,
  now: string,
  migrationProgress?: MigrationProgress,
): Promise<{ version: number; addedColumns: string[] }> {
  validateRegistryConfig(config);
  await migrate(shared, [m0007, m0008], now, migrationProgress);
  const ds = dialectFor(shared.dialect);
  const dr = dialectFor(regDb.dialect);

  // 1) Ensure the spine exists (fresh registry) — creates cases/operations/etc.
  //    Using the runner keeps it forward-only and recorded per-registry DB.
  const casesExists = await tableExists(regDb, "cases");
  if (!casesExists) {
    await migrate(regDb, [registrySpineMigration(config), m0004, m0006Registry], now, migrationProgress);
  } else {
    await migrate(regDb, [registrySpineMigration(config), m0004, m0006Registry], now, migrationProgress);
  }

  // 2) Forward-only field evolution: add any config field missing as a column.
  const addedColumns = await addMissingFieldColumns(regDb, config);

  // Form IDs are global keys in the shared database. Never let an upsert or a
  // replacement apply move a definition (and its translations) between
  // registries merely because two independently authored configs reuse an ID.
  const hasSplitForms = config.caseForms !== undefined || config.operationForms !== undefined;
  const forms = hasSplitForms ? [
    ...(config.caseForms ?? []).map((form) => ({ ...form, kind: "case" as const })),
    ...(config.operationForms ?? []).map((form) => ({ ...form, kind: "operation" as const })),
  ] : [...(config.forms ?? [])];
  for (const form of forms) {
    const owner = await shared.get("SELECT registry_id FROM form_definitions WHERE form_id = ?", [form.formId]);
    if (owner && String(owner.registry_id) !== config.registryId) {
      throw new Error(`form ${form.formId} belongs to registry ${String(owner.registry_id)}`);
    }
  }

  // 3) Upsert catalog (shared).
  await shared.run(
    ds.upsert({
      table: "registry_catalog",
      insertColumns: ["registry_id", "name", "database_key", "registry_code", "number_padding", "separator"],
      conflictColumns: ["registry_id"],
      updateColumns: ["name", "database_key", "registry_code", "number_padding", "separator"],
    }),
    [config.registryId, config.name, config.database, config.diary.registryCode, config.diary.numberPadding, config.diary.separator],
  );
  for (const [locale, name] of Object.entries(config.labels?.values ?? { fi: config.name })) {
    await shared.run(ds.upsert({ table: "registry_translations", insertColumns: ["registry_id", "locale", "name"], conflictColumns: ["registry_id", "locale"], updateColumns: ["name"] }), [config.registryId, normalizeLocale(locale), name]);
  }

  // 4) States + transitions (registry DB). Replace transitions wholesale to
  //    match config exactly; upsert states so history references stay valid.
  const stateSql = dr.upsert({
    table: "states",
    insertColumns: ["id", "name", "description", "is_open", "is_waiting_for_customer"],
    conflictColumns: ["id"],
    updateColumns: ["name", "is_open", "is_waiting_for_customer"],
  });
  await regDb.transaction(async (tx) => {
    for (const s of config.states) {
      await tx.run(stateSql, [s.id, s.name, null, s.isOpen ? 1 : 0, s.isWaitingForCustomer ? 1 : 0]);
      const locales = new Set([...Object.keys(s.labels?.values ?? { fi: s.name }), ...Object.keys(s.descriptions?.values ?? {})]);
      for (const locale of locales) {
        const name = resolveLocalizedText(s.labels, s.name, locale).value;
        const description = s.descriptions ? resolveLocalizedText(s.descriptions, "", locale).value : null;
        await tx.run(dr.upsert({ table: "state_translations", insertColumns: ["state_id", "locale", "name", "description"], conflictColumns: ["state_id", "locale"], updateColumns: ["name", "description"] }), [s.id, normalizeLocale(locale), name, description]);
      }
    }
    await tx.run("DELETE FROM state_transitions");
    for (const [from, to] of config.transitions) {
      await tx.run("INSERT INTO state_transitions (from_state, to_state) VALUES (?, ?)", [from, to]);
    }
  });

  // 5) Forms + rules (shared config), keyed by id. Upsert configured forms so
  //    multilingual child rows survive a reapply, then remove only stale forms.
  //    Translation rows reference forms in multilingual deployments, so stale
  //    dependants must be removed before their parent definitions. The table is
  //    optional for compatibility with databases predating multilingual support.
  const hasFormTranslations = await tableExists(shared, "form_translations");
  const retainedFormIds = forms.map((form) => form.formId);
  const retainedClause = retainedFormIds.length
    ? ` AND form_id NOT IN (${retainedFormIds.map(() => "?").join(", ")})`
    : "";
  const staleFormParams = [config.registryId, ...retainedFormIds];
  const formSql = ds.upsert({
    table: "form_definitions",
    insertColumns: ["form_id", "registry_id", "kind", "audience", "title", "description", "requires_approval", "field_subset", "property_schema", "allow_attachments", "operation_type"],
    conflictColumns: ["form_id"],
    updateColumns: ["registry_id", "kind", "audience", "title", "description", "requires_approval", "field_subset", "property_schema", "allow_attachments", "operation_type"],
  });
  await shared.transaction(async (tx) => {
    for (const f of forms) {
      await tx.run(
        formSql,
        [
          f.formId, config.registryId, f.kind, f.audience, f.title, f.description || f.title,
          f.kind === "case" && f.requiresApproval ? 1 : 0,
          f.kind === "case" && f.fieldSubset ? JSON.stringify(f.fieldSubset) : null,
          f.kind === "operation" && f.propertySchema ? JSON.stringify(f.propertySchema) : null,
          f.kind === "operation" && f.allowAttachments ? 1 : 0,
          f.kind === "operation" ? f.operationType ?? null : null,
        ],
      );
      if (f.kind === "case") {
        await tx.run(ds.upsert({ table: "case_form_definitions", insertColumns: ["form_id", "requires_approval", "field_subset"], conflictColumns: ["form_id"], updateColumns: ["requires_approval", "field_subset"] }), [f.formId, f.requiresApproval ? 1 : 0, f.fieldSubset ? JSON.stringify(f.fieldSubset) : null]);
        await tx.run("DELETE FROM operation_form_definitions WHERE form_id = ?", [f.formId]);
      } else {
        await tx.run(ds.upsert({ table: "operation_form_definitions", insertColumns: ["form_id", "allow_attachments", "operation_type", "property_schema"], conflictColumns: ["form_id"], updateColumns: ["allow_attachments", "operation_type", "property_schema"] }), [f.formId, f.allowAttachments ? 1 : 0, f.operationType ?? null, f.propertySchema ? JSON.stringify(f.propertySchema) : null]);
        await tx.run("DELETE FROM case_form_definitions WHERE form_id = ?", [f.formId]);
      }
      if (hasFormTranslations) {
        const translationSql = ds.upsert({
          table: "form_translations",
          insertColumns: ["form_id", "locale", "title", "description"],
          conflictColumns: ["form_id", "locale"],
          updateColumns: ["title", "description"],
        });
        const locales = new Set([...Object.keys(f.titles?.values ?? { fi: f.title }), ...Object.keys(f.descriptions?.values ?? {})]);
        for (const locale of locales) {
          const title = resolveLocalizedText(f.titles, f.title, locale).value;
          const description = f.descriptions ? resolveLocalizedText(f.descriptions, "", locale).value : null;
          await tx.run(translationSql, [f.formId, normalizeLocale(locale), title, description]);
        }
      }
    }
    if (hasFormTranslations) {
      await tx.run(
        `DELETE FROM form_translations
         WHERE form_id IN (
           SELECT form_id FROM form_definitions WHERE registry_id = ?${retainedClause}
         )`,
        staleFormParams,
      );
    }
    await tx.run(`DELETE FROM case_form_definitions WHERE form_id IN (SELECT form_id FROM form_definitions WHERE registry_id = ?${retainedClause})`, staleFormParams);
    await tx.run(`DELETE FROM operation_form_definitions WHERE form_id IN (SELECT form_id FROM form_definitions WHERE registry_id = ?${retainedClause})`, staleFormParams);
    await tx.run(`DELETE FROM form_definitions WHERE registry_id = ?${retainedClause}`, staleFormParams);
    await tx.run("DELETE FROM rules WHERE registry_id = ?", [config.registryId]);
    for (const r of config.rules ?? []) {
      await tx.run(
        `INSERT INTO rules (rule_id, registry_id, [trigger], on_to_state, condition, action_type, action_params, ordering)
         VALUES (?, ?, 'state_change', ?, ?, ?, ?, ?)`,
        [
          r.ruleId, config.registryId, r.onToState ?? null,
          r.condition === undefined || r.condition === null ? null : JSON.stringify(r.condition),
          r.actionType,
          r.actionParams ? JSON.stringify(r.actionParams) : null,
          r.ordering ?? 0,
        ],
      );
    }
  });

  await shared.run("DELETE FROM field_translations WHERE registry_id = ?", [config.registryId]);
  for (const field of config.fields) {
    const locales = new Set([...Object.keys(field.labels?.values ?? { fi: field.name }), ...Object.keys(field.helpText?.values ?? {})]);
    for (const locale of locales) {
      await shared.run("INSERT INTO field_translations (registry_id, field_name, locale, label, help_text) VALUES (?, ?, ?, ?, ?)", [
        config.registryId, field.name, normalizeLocale(locale), resolveLocalizedText(field.labels, field.name, locale).value,
        field.helpText ? resolveLocalizedText(field.helpText, "", locale).value : null,
      ]);
    }
  }

  // 6) Record the applied version + the full config artifact (promotion audit
  //    trail; the stored artifact is what config-promote reads back).
  const version = config.version ?? 1;
  await shared.run(
    ds.upsert({
      table: "config_versions",
      insertColumns: ["registry_id", "version", "applied_at", "summary", "config_json"],
      conflictColumns: ["registry_id", "version"],
      updateColumns: ["applied_at", "summary", "config_json"],
    }),
    [config.registryId, version, now, `${config.fields.length} fields, ${config.states.length} states, ${forms.length} forms, ${(config.rules ?? []).length} rules`, JSON.stringify(config)],
  );

  return { version, addedColumns };
}

async function tableExists(db: DbAdapter, name: string): Promise<boolean> {
  const d = dialectFor(db.dialect);
  return !!(await db.get(d.tableExists(), [name]));
}

async function addMissingFieldColumns(regDb: DbAdapter, config: RegistryConfig): Promise<string[]> {
  const d = dialectFor(regDb.dialect);
  const existing = new Set((await regDb.all(d.columnsOf("cases"))).map((r) => String(r.name)));
  const added: string[] = [];
  for (const f of config.fields) {
    if (existing.has(f.name)) continue;
    // Forward-only ADD COLUMN. New columns must be nullable or defaulted since
    // existing rows have no value — enforce that here (a real migration concern).
    // Production evolution remains additive. A new required field cannot be
    // safely invented for existing legal records; it must first be introduced
    // nullable and populated through an explicit migration/workflow.
    if (!f.nullable) throw new Error(`new field ${f.name} must be nullable`);
    const nullClause = "";
    await regDb.run(d.addColumn("cases", `${f.name} ${d.columnType(f.type)}${nullClause}`));
    added.push(f.name);
  }
  return added;
}
