import type { Migration } from "./runner.ts";

/** Normalized translation storage: adding a locale never changes the schema. */
export const m0006Shared: Migration = {
  id: "0006",
  name: "shared_localized_metadata",
  async up(tx) {
    await tx.run(`CREATE TABLE registry_translations (
      registry_id TEXT NOT NULL REFERENCES registry_catalog(registry_id), locale TEXT NOT NULL,
      name TEXT NOT NULL, PRIMARY KEY (registry_id, locale))`);
    await tx.run(`CREATE TABLE category_translations (
      category_id TEXT NOT NULL REFERENCES categories(category_id), locale TEXT NOT NULL,
      name TEXT NOT NULL, PRIMARY KEY (category_id, locale))`);
    await tx.run(`CREATE TABLE field_translations (
      registry_id TEXT NOT NULL REFERENCES registry_catalog(registry_id), field_name TEXT NOT NULL,
      locale TEXT NOT NULL, label TEXT NOT NULL, help_text TEXT NULL,
      PRIMARY KEY (registry_id, field_name, locale))`);
    await tx.run(`CREATE TABLE form_translations (
      form_id TEXT NOT NULL REFERENCES form_definitions(form_id), locale TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NULL, PRIMARY KEY (form_id, locale))`);
  },
};

export const m0006Registry: Migration = {
  id: "0006",
  name: "registry_localized_metadata",
  async up(tx) {
    await tx.run(`CREATE TABLE state_translations (
      state_id TEXT NOT NULL REFERENCES states(id), locale TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT NULL, PRIMARY KEY (state_id, locale))`);
  },
};
