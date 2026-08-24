# Registry Platform — Foundation (Phases 0–3, 5)

This package includes the security/integrity port described in
[`HARDENING_PORT.md`](HARDENING_PORT.md): explicit publication projections,
registry/time-scoped grants, optimistic concurrency, atomic rules, audit/outbox,
field governance, trust zones, and production fail-closed composition.

The Registry Platform ("Rekisterialusta"), built against the accepted decisions
in `04-decision-record.md`. Real, runnable, tested — not a mock. No build step,
no external services, no dependencies at runtime (Node 22 native type-stripping
+ built-in `node:sqlite`).

The implemented product behavior is summarized as a numbered, role-oriented
set of [`user stories`](docs/USER_STORIES.md), grouped by portal or component.

## What's here

- **Phase 0** — walking skeleton, stateless handler pattern.
- **Phase 1** — cases/operations data spine, diary numbers, categories.
- **Phase 2** — REST API over `node:http` with one authorization model for
  portals and integrations: two auth systems (customer ownership, worker
  category) plus **API tokens scoped to HTTP method × category** (§7). A
  pluggable identity layer with a dev stub (the D-12 fallback) so real
  eID/OIDC + staff SSO slot in without touching the authorization model.
- **Phase 3** — **forms platform** (case forms with field-subset updates and
  the customer-submission **approval workflow**; operation forms validated
  against a JSON schema, with **file attachments** to a blob store), and the
  **rule engine** (on state change; fixed action catalog + 3 parameterized
  actions; cascade-guarded; every action recorded as an operation).
- **Phase 5** — the multi-registry promise made real: a **second registry
  (Grant) added purely as configuration** on its own database, config-as-code
  (`applyRegistryConfig`) with **dev→test→prod promotion** (versioned config
  artifact), the **management-portal backend** (admin API: add field →
  schema migration, states/transitions, forms, rules, categories, worker
  authorizations, mint/revoke API tokens), and **scheduled CSV exports** across
  all registries with an `export_runs` log.

  (**Phase 4** — message queue + external integrations — is intentionally
  deferred until there is a concrete integration case; rule actions with
  external effects currently record an operation where they will later enqueue.)
- **Web console (MVP)** — a dependency-free vanilla-JS single-page app (in
  `public/`) served by the same HTTP server, exercising all four portals. An
  "Acting as" switch changes the stub-identity bearer so you can watch the two
  auth systems and admin gating behave differently per role. Run `npm run serve`
  and open http://localhost:8080.

- **Internal BIGINT key + public diary number** (D-01/D-02) — `cases.case_key`
  is the surrogate PK; `diary_number` (`REGISTRY/YEAR/NUMBER`) is a unique public
  id, allocated gaplessly per registry+year inside the case-creation transaction.
- **Typed columns from field config** (D-03) — a registry's statutory fields
  become real typed columns via a migration factory, not an EAV bag.
- **Forward-only migration runner** (D-05) — ordered, idempotent, recorded.
- **Integrity in the DBMS** (D-06) — FKs, checks, uniqueness enforced by the DB.
- **Category prefix authorization** (D-09) — hierarchical codes normalized to a
  fixed-width materialized path; a grant on `105` covers `105.04.03` by prefix.
- **Append-only history** — every change is an immutable `operations` row.
- **Single authorization point** — customer ownership + worker category rules
  enforced in the platform core, shared by portals and (later) the REST API.
- **Stateless handler** — the shape every portal/API endpoint will take.

## Run it

Requires Node.js ≥ 22.6 (uses native TypeScript type-stripping and `node:sqlite`).

```bash
npm run demo         # domain-level walkthrough (in-memory DB)
npm run api-demo     # REST walkthrough: auth, forms+approval, rule engine
npm run phase5-demo  # multi-registry, admin edits, config versions, CSV export
npm run serve        # start the HTTP console on :8080. DB chosen by env:
                     #   (default)                → in-memory SQLite + demo seed
                     #   DB_DIR=./data            → on-disk SQLite, persists
                     #   DB_DIALECT=sqlserver ... → SQL Server (see ENVIRONMENTS.md)
                     # load a .env: node --env-file=.env --experimental-strip-types scripts/serve.ts
npm test             # 73 tests: spine, authz, hardening, API, forms, rules, HTTP, multi-
                     #   registry, admin, promotion, exports, dialect, db-config
npm run typecheck    # strict tsc --noEmit (needs `npm install` first)
npm run migrate      # apply migrations to data/dev.sqlite
```

`npm run api-demo` opens a case as a citizen, blocks another citizen, stages an
approval-required form change and applies it on worker approval, drives the
lifecycle so a rule auto-closes a paid decision, then reads the published case
through a method+category-scoped API token that is correctly denied write.

## Layout

```
src/
  config/   registry-catalog.ts      registry → DB placement + diary format + field defs
            sample-registry.ts       example Permit registry: fields, states, forms, rules (config)
  db/       db.ts                    DbAdapter interface (the vendor/runtime seam)
            sqlite-adapter.ts        dev/test adapter over node:sqlite (+ transactions)
  migrations/
            runner.ts                forward-only ordered migration runner (D-05)
            0001_shared_schema.ts    catalog, workers, customers, categories, grants, counters
            0002_registry_spine.ts   per-registry cases/operations/states/transitions (factory)
            0003_api_forms_rules.ts  api_tokens, form_definitions, rules (shared config)
            0004_registry_forms.ts   pending_case_updates, attachments (per registry)
  domain/   categories.ts            path normalization + prefix containment (D-09)
            diary-number.ts          gapless per registry+year allocation (D-01)
            cases.ts                 transactional case creation
            operations.ts            append-only history writes
            state-machine.ts         the only path that changes state (§4)
            json-schema.ts           dependency-free JSON-schema-subset validator (§5.4)
  core/     authorization.ts         customer ownership + worker category rules (§6)
            queries.ts               domain-shaped reads for portals/API
            handler.ts               stateless walking-skeleton endpoint
  auth/     identity.ts              IdentityProvider interface + dev stub (D-12 fallback)
  blob/     blob.ts                  BlobStore interface + in-memory dev store (D-10)
  api/      platform.ts              compose context: shared DB, registries, identity, blobs
            router.ts                tiny method+path router
            tokens.ts                API token mint/verify, method+category scope (§7)
            authz.ts                 single request-authorization point (actors + tokens)
            routes.ts                REST handlers (cases, operations, transition, forms, ...)
            server.ts                node:http adapter + pure `dispatch` for tests
            registry-config.ts       declarative RegistryConfig/PlatformConfig (config-as-code)
            platform-config.ts       shared categories + the set of hosted registries
            registries/permit.ts     Permit registry as config
            registries/grant.ts      Grant registry — the SECOND registry, config only
  migrations/
            0005_admin_exports.ts    is_admin, config_versions, export_runs
  services/ forms.ts                 forms platform + approval workflow (§5.4)
            rules.ts                 rule engine on state change (§9, D-07)
            config-apply.ts          apply declarative config; forward-only field evolution (§5.12)
            config-promote.ts        export config artifact + promote dev→test→prod
            admin.ts                 management-portal operations (edit config, tokens, authz)
            exports.ts               scheduled CSV export across all registries (§5.11)
  api/      admin-routes.ts          management (admin-only) REST routes
            http-types.ts            shared handler types (breaks the routes↔admin cycle)
  bootstrap.ts                       compose root: migrate + apply config + Platform (multi-DB)
  logging/logger.ts                  replaceable log sink + customer-data-safe logging policy
test/       spine, categories, diary, api, forms, rules, http-smoke,
            multi-registry, admin, config-promote, exports (42 cases)
scripts/    demo.ts, api-demo.ts, phase5-demo.ts, serve.ts, migrate.ts
```

### Logging and customer data

Application logging goes through `src/logging/logger.ts`. It currently defaults
to `console.log`/`console.error`; an external service can be integrated later by
implementing `LogSink` and passing it to `createLogger`.

Customer data must be placed in the separate `customerData` field, not in log
messages or operational `metadata`. Customer data is **omitted by default**. If
an operational need requires correlation, set `customerDataHandling: "redact"`;
values will then contain only a prefix (configured with
`redactionPrefixLength`, default `0`) followed by `[REDACTED]`. Customer data is
never logged in full.

## Production notes (next phases)

- The `DbAdapter` interface has SQLite and optional `mssql` implementations;
  the SQL Server path still requires a live integration run before approval.
- The migration runner is parameterized by registry, ready for the **second
  registry configured-not-coded** (Plan Phase 5).
- Authorization containment is done in code over the small grant set here; in
  production it is pushed into SQL as an indexed `path LIKE grant || '%'` test.
- Deferred by choice: the outbox is written atomically, but a concrete message
  broker dispatcher, retries, and consumer idempotency remain integration work.
- Not yet built: the management-portal **UI** (the admin *backend* is done);
  **Phase 6** — full authorization test matrix, performance, retention, security
  review. Also pending: the real **SQL Server adapter over oino-ts** (D-04,
  postponed) and the real **identity providers** (D-12; a dev stub is in place).
