# Multilingual support and translation management plan

## 1. Goal and scope

Add language support without changing stable domain identifiers or duplicating
registry behavior. Finnish (`fi`) is the default and the only required locale
for now; Swedish (`sv`) and English (`en`) can be added when translations are
available. Each deployment can eventually configure its supported locales. The
design must cover:

- the static web-console shell;
- registry-configured names for registries, categories, states, fields, and
  forms;
- API validation and error messages;
- accessibility text, dates, numbers, and currency; and
- the management and config-promotion workflow used to maintain translations.

Case content entered by customers or workers, diary numbers, attachment names,
audit records, and external legal documents are **not** automatically
translated. Those are records, not interface copy, and must remain exactly as
submitted unless a separate, audited content-translation feature is approved.

## 2. Design principles

1. **Identifiers remain language-neutral.** Existing values such as
   `registryId`, state `id`, category `code`, field `name`, and `formId` remain
   the values stored in the database and sent in commands. A translated label
   is presentation metadata, never an identifier.
2. **Separate product copy from registry copy.** Static console text belongs in
   version-controlled locale catalogs. Configurable registry labels belong in
   the promotable `RegistryConfig` artifact so promotion reproduces both
   behavior and wording.
3. **No silent data-language assumptions.** Locale selection affects display
   and messages, not authorization, search semantics, workflow, or stored case
   values.
4. **Deterministic fallback.** Resolve requested locale to an exact supported
   locale, then its base language, then the deployment default. Missing
   registry translations fall back to the registry's declared source locale.
   The UI must never show raw `undefined`; development and CI should report
   every fallback.
5. **Keep the dependency-free runtime.** Use browser `Intl` and small JSON
   catalogs rather than adding a framework. Add a library only if later needs
   (notably complex ICU message formatting) justify its operational cost.
6. **Accessible language switching.** Update the document `lang`, preserve the
   active portal and case when safe, announce the change, and translate
   visible labels as well as `title`, placeholder, and ARIA text.

## 3. Translation model

### 3.1 Platform configuration

Extend `PlatformConfig` with locale policy:

```ts
interface LocaleConfig {
  readonly supported: readonly string[]; // initially ["fi", "sv", "en"]
  readonly default: string;              // initially "fi"
}
```

Locale tags must be normalized and validated using BCP 47 rules. Reject an
empty supported set, duplicates after normalization, or a default not present
in `supported`.

### 3.2 Registry configuration

Introduce a reusable localized value while retaining the current scalar during
one compatibility release:

```ts
interface LocalizedText {
  readonly sourceLocale: string;
  readonly values: Readonly<Record<string, string>>;
}

// migration shape; `name` remains accepted temporarily
interface StateDef {
  readonly id: string;
  readonly name?: string;
  readonly labels?: LocalizedText;
  // existing behavioral properties remain unchanged
}
```

Apply the same pattern to registry names, category names, state names and
descriptions, field display labels and help text, and form titles/descriptions.
Do **not** localize governance metadata (`legalBasis`, `purpose`, sensitivity,
and retention policy) yet. Individual registries may later introduce legal
review requirements; defer that workflow until a concrete requirement exists.

Validation must require a nonblank source-locale value and valid locale keys.
Require Finnish for every user-visible configured item. Additional locale
coverage rules can be introduced only when another locale is enabled.

Persist localized registry metadata as part of `config_versions.config_json`.
For efficient metadata reads, add normalized shared tables such as
`category_translations(entity_id, locale, name)` and registry-database tables
such as `state_translations(state_id, locale, name, description)`. Add the
equivalent form translation table in the shared database. Uniqueness must be
`(entity_id, locale)`, and foreign keys should cascade only where the current
entity lifecycle permits deletion. Avoid one column per language so adding a
locale does not require schema changes.

### 3.3 Static console catalogs

Create one JSON module per locale under `public/locales/`, using stable semantic
keys rather than English source text:

```json
{
  "nav.customer": "Asiointi",
  "case.create.action": "Aloita uusi asia",
  "error.generic": "Pyyntö epäonnistui"
}
```

Keep catalogs flat for simple lookup and easy duplicate/missing-key checks.
Interpolation should accept named parameters and escape them as text. Do not
allow translated HTML; compose markup in code so catalogs cannot introduce XSS
or invalid accessibility structure. Plural-sensitive messages should use
`Intl.PluralRules`; dates, numbers, and currency should use the corresponding
`Intl` formatters with the selected locale.

## 4. Locale negotiation and API contract

Use this precedence for a browser request:

1. explicit `?lang=` URL parameter (shareable and testable);
2. a previously selected locale in `localStorage`;
3. `Accept-Language`;
4. deployment default.

The language selector writes both the URL and local storage. Unsupported
values resolve through the documented fallback and must not produce a server
error. Set `<html lang>` immediately after resolution and return
`Content-Language` on localized API responses. Add `Vary: Accept-Language`
where a cacheable representation changes by locale.

Metadata endpoints should accept `?lang=fi` and return both stable identifiers
and resolved presentation values. During migration, keep the current `name`
and `title` fields as the resolved values and add response metadata:

```json
{
  "locale": "sv",
  "fallbackLocales": ["fi"],
  "states": [{ "id": "received", "name": "Mottagen" }]
}
```

Do not return every language by default. Add `include=translations` only for
the management portal, restricted by its existing admin authorization.

API errors should gain stable machine-readable codes and parameters:

```json
{
  "error": {
    "code": "validation.required",
    "params": { "field": "applicant_name" },
    "message": "Hakijan nimi on pakollinen"
  }
}
```

Clients should prefer `code` and render locally; `message` provides the
negotiated server fallback and remains useful to integrations and logs. Never
put translated text in rule decisions, audit event types, or programmatic test
assertions.

## 5. Translation-management workflow

### Ownership

- **Product/UI team:** static console and generic API-message catalogs.
- **Registry owner:** registry, category, state, field, and form wording.
- **Translator/reviewer:** optional when another locale is introduced.
- **Developer:** keys, parameters, rendering context, and automated checks—not
  final legal translations.

### Source-of-truth workflow

1. A developer adds or changes a semantic key in the Finnish source catalog,
   including a short translator comment when context is ambiguous.
2. `npm run i18n:check` verifies identical key sets, nonblank values, valid
   interpolation parameters, valid locale tags, and no obsolete keys. Missing
   non-source translations may be explicitly marked pending on feature
   branches, but not silently omitted.
3. Translators edit JSON through pull requests initially. If volume later
   warrants a translation-management system, synchronize it through CI while
   keeping reviewed repository catalogs as the deployable source of truth.
4. Registry owners edit all localized values in the management portal. The UI
   shows per-locale completion, source text, fallback preview, and validation
   errors. Saving creates the next complete config artifact; partial direct
   database edits are forbidden.
5. Promotion displays a translation coverage report and a diff by locale.
   The existing artifact version provides rollback-by-repromotion and an audit
   trail. No formal translation approver is required for now.

Translations should carry status metadata (`draft`, `reviewed`, `approved`) in
management tooling or adjacent artifact metadata, rather than embedding status
in runtime strings. Record actor, timestamp, locale, entity/key, old value, and
new value without logging customer data.

## 6. Delivery plan

### Phase 1 — foundation and static shell

- Add locale policy, resolver, catalog loader, `t(key, params)`, and `Intl`
  formatter helpers.
- Extract every user-visible string from `public/index.html` and
  `public/app.js`; add the language selector and accessible language-change
  behavior.
- Add a complete Finnish catalog. Add Swedish or English only when translations
  are available; empty placeholder catalogs provide no value.
- Add catalog linting and unit tests. This phase changes only presentation and
  can ship behind an `I18N_ENABLED` rollout flag.

**Exit criteria:** no hard-coded visible console copy; all catalogs have the
same keys and parameters; keyboard and screen-reader smoke tests pass.

### Phase 2 — localized registry metadata

- Add `LocalizedText` types, compatibility conversion for existing scalar
  config, validation, migrations, and config-apply support.
- Localize registry-list and metadata endpoints with explicit locale/fallback
  information.
- Convert Permit, Grant, and platform category configuration, and make the
  console consume resolved labels while submitting stable IDs.
- Verify exports remain backward compatible: identifiers and case data stay
  unchanged unless a separate localized-header export format is explicitly
  requested.

**Exit criteria:** each supported locale can complete core customer and worker
flows without displaying raw IDs as labels; promotion reproduces translations.

### Phase 3 — errors and management

- Inventory errors, define the stable error-code catalog, and migrate handlers
  incrementally while preserving HTTP statuses.
- Add admin read/write APIs for all translations and build completion, preview,
  diff, review-status, and audit views in the management portal.
- Enforce production coverage gates in config promotion.

**Exit criteria:** core API errors are code-based and localized; registry owners
can manage wording without code changes; every production translation is
reviewed and traceable.

### Phase 4 — hardening and rollout

- Add pseudo-locales for expansion and missing-key testing, right-to-left
  rendering checks even if RTL is not initially supported, and performance
  measurements for catalog loading and metadata queries.
- Run accessibility, security, legal-language, and integration compatibility
  reviews. Roll out per environment and registry, monitoring missing-key,
  fallback, and unsupported-locale counters without recording personal data.
- Remove scalar-config compatibility only after all stored artifacts and
  supported promotion paths have been migrated.

## 7. Test strategy

### Automated

- Locale normalization, precedence, regional fallback (`sv-FI` to `sv`), and
  unsupported/invalid values.
- Catalog parity, unused keys, interpolation parameter parity, escaping,
  plurals, and locale-specific number/date formatting.
- Config validation for blank values, duplicate normalized locales, source
  locale requirements, and translation persistence through export/promotion.
- API contract tests for `?lang`, `Accept-Language`, `Content-Language`, `Vary`,
  fallback reporting, admin-only complete translations, and stable error codes.
- End-to-end customer, worker, publishing, and management flows in each locale;
  assert submitted IDs and stored data are identical across locales.
- Security regression tests proving translated strings cannot inject HTML and
  locale selection cannot bypass authorization or vary private cache entries.

### Human review

- Native-speaker review in context at narrow and wide viewport sizes.
- Keyboard and assistive-technology review, including focus preservation and
  announcement of language changes.
- Legal review of statutory registry wording and a documented sign-off before
  promotion.

## 8. Operational measures and decisions to confirm

Track missing translation keys, fallback counts by key/locale/registry,
unsupported locale requests, catalog-load failures, and translation coverage.
Alert on a new missing key in production; do not include case values, user IDs,
or free text in these metrics.

Before implementation, product and legal owners must confirm:

1. when Swedish, English, or another locale should be enabled;
2. whether an individual registry introduces statutory wording that needs a
   dedicated review workflow; and
3. whether public search eventually needs language-aware matching of the user
   content it already searches.

Export headers remain language-neutral and unchanged because they are an
integration contract. No formal translation approvers or production coverage
threshold beyond complete Finnish are required for now.

These decisions do not block Phase 1's technical foundation, but they are gates
for localized registry metadata and production rollout.
