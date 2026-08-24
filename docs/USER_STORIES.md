# Implemented user stories

This document describes the user-facing capabilities implemented in the
Registry Platform so far. The numbering follows the requested hierarchy:

1. **user role**
2. **portal or component**
3. **use case**
4. **automated test coverage and priority cases to add**

The stories describe working behavior in the current MVP, not planned future
functionality. Unless a story explicitly refers to the REST API or a background
component, it is available through the web console.

The fourth level maps the current automated tests to the behavior they protect
and records the next cases worth implementing. A test can support more than one
story. “Implemented” means that the cited test exercises at least the stated
part of the story; it does not imply that every combination or failure mode is
covered.

## 1. Customer

### 1.1 Customer portal

#### 1.1.1 Select a registry

As a customer, I can select any registry hosted by the platform so that I can
work with the cases and forms belonging to that registry.

##### 1.1.1.1 Automated test coverage

**Implemented:** `portal-endpoints.test.ts`: registry listing and registry metadata; `multi-registry.test.ts`: Grant registry end-to-end.

**Priority cases to add:** Verify switching registries cannot retain a case, form, or cached field definition from the previous registry.

#### 1.1.2 View my cases

As a customer, I can list my own open and closed cases so that I can follow all
of my matters without seeing another customer's cases.

##### 1.1.2.1 Automated test coverage

**Implemented:** `spine.test.ts`: customer case listing and ownership isolation; `api.test.ts`: another customer is forbidden.

**Priority cases to add:** Cover mixed open/closed cases, empty lists, pagination, and simultaneous cases in multiple registries.

#### 1.1.3 Open a case

As a customer, I can create a case in an active category by entering the
registry-specific statutory fields so that I can start a new matter. The
platform assigns the configured initial state, makes me the applicant, and
allocates the public diary number.

##### 1.1.3.1 Automated test coverage

**Implemented:** `spine.test.ts`: diary allocation, initial operation, and required fields; `api.test.ts`: customer create/read; `hardening.test.ts`: customer cannot choose protected state/parties/operations; `diary-number.test.ts`: sequence, isolation, and rollback.

**Priority cases to add:** Add duplicate/retry idempotency, every field type/boundary, inactive/unknown category, and injected failure proving no partial case, party, operation, or consumed diary number.

#### 1.1.4 View case details and history

As a customer, I can open one of my cases and view its current data and
append-only operation history so that I can understand its status and activity.

##### 1.1.4.1 Automated test coverage

**Implemented:** `api.test.ts` and `spine.test.ts`: owner can read and non-owner is forbidden; `hardening.test.ts`: public projection cannot leak internal data.

**Priority cases to add:** Verify the complete chronological history after every supported customer action and redaction of worker-only properties.

#### 1.1.5 Update a case with a case form

As a customer, I can submit a configured customer case form containing only
its allowed field subset so that I can provide updated information. If the form
requires approval, my change remains pending until a suitably authorized case
worker approves it.

##### 1.1.5.1 Automated test coverage

**Implemented:** `forms.test.ts`: approval staging, unauthorized approval, and wrong audience; `multi-registry.test.ts`: immediate no-approval form; `user-story-state.test.ts`: exact intermediate/final projections for both approval modes.

**Priority cases to add:** Add rejection, repeat decision, empty/no-op update, concurrent update, forbidden field, invalid type, non-owner, and transaction rollback projections.

#### 1.1.6 Add an operation with a form

As a customer, I can submit a configured operation form so that I can add
structured information to my case. The platform validates the properties
against the form's JSON schema before recording the operation.

##### 1.1.6.1 Automated test coverage

**Implemented:** `forms.test.ts`: JSON-schema rejection and successful operation creation.

**Priority cases to add:** Cover additional properties, type/size boundaries, non-owner access, operation ordering, and retry/idempotency.

#### 1.1.7 Attach a file through an operation form

As a customer, I can include an attachment when the selected operation form
allows files so that supporting material is stored with the recorded operation.

##### 1.1.7.1 Automated test coverage

**Implemented:** `forms.test.ts`: attachment metadata and blob bytes are stored.

**Priority cases to add:** Cover disallowed files, zero/max/oversize files, malformed base64, filename/content-type limits, multiple files, blob failure, DB failure, and orphan cleanup.

## 2. Case worker

### 2.1 Case-worker portal

#### 2.1.1 View assigned cases

As a case worker, I can view cases assigned to me within the current registry so
that I can manage my personal queue.

##### 2.1.1.1 Automated test coverage

**Implemented:** `portal-endpoints.test.ts`: assigned queue view.

**Priority cases to add:** Cover multiple handlers, removed assignment, registry isolation, closed cases, and deterministic paging/order.

#### 2.1.2 View authorized cases

As a case worker, I can view cases in categories covered by my active,
registry-scoped read grants so that I can work only within my remit. A grant on
a parent category also covers its descendant categories.

##### 2.1.2.1 Automated test coverage

**Implemented:** `spine.test.ts`: inherited category access and boundaries; `portal-endpoints.test.ts`: authorized queue; `hardening.test.ts`: registry and validity-window isolation.

**Priority cases to add:** Cover expired/future/revoked grants, inactive categories, overlapping grants, and each permission independently.

#### 2.1.3 View opted-in unassigned cases

As a case worker, I can view unassigned cases in categories for which I have an
active opted-in grant so that I can pick up suitable work.

##### 2.1.3.1 Automated test coverage

**Implemented:** `portal-endpoints.test.ts`: opted-in unassigned queue.

**Priority cases to add:** Cover opted-out, assigned-to-another-worker, expired grant, and concurrent assignment disappearance.

#### 2.1.4 Assign a case to myself

As a case worker, I can assign an authorized case to myself so that it becomes
part of my assigned queue.

##### 2.1.4.1 Automated test coverage

**Implemented:** `portal-endpoints.test.ts`: worker queue scenario includes assignment behavior.

**Priority cases to add:** Add direct success/forbidden/conflict tests, idempotent self-assignment, concurrent workers, audit/outbox, and rollback.

#### 2.1.5 View case details and full history

As a case worker, I can open an authorized case and view its internal fields and
append-only operation history so that I have the context needed to process it.

##### 2.1.5.1 Automated test coverage

**Implemented:** `spine.test.ts`: worker access rules and case history; `api.test.ts`: category authorization.

**Priority cases to add:** Verify full internal fields/history, inaccessible category, expired grant, unknown case, and stable operation order.

#### 2.1.6 Move a case through its lifecycle

As a case worker with transition permission, I can select a configured outgoing
state transition so that the case follows the registry's state machine. An
illegal transition is rejected and each successful transition is recorded in
history.

##### 2.1.6.1 Automated test coverage

**Implemented:** `spine.test.ts`: allowed transition/history and illegal transition rejection; `api.test.ts`: endpoint authorization/state machine.

**Priority cases to add:** Cover every configured edge, actor restrictions, stale version/concurrent transition, terminal states, unchanged projection on rejection, and audit/outbox atomicity.

#### 2.1.7 Trigger state-change rules

As a case worker, when I complete a state transition, I can have matching rules
run automatically so that configured follow-up actions occur consistently. The
transition and all cascading rule actions succeed or roll back atomically.

##### 2.1.7.1 Automated test coverage

**Implemented:** `rules.test.ts`: matching/nonmatching conditions, set-state and notify actions; `hardening.test.ts`: transition plus cascading rules roll back atomically.

**Priority cases to add:** Cover action ordering, multiple matching rules, each action type, cycles/depth limit, malformed config, retries, and exact audit/outbox projection.

#### 2.1.8 Add a structured operation

As a case worker, I can submit a worker operation form, including an attachment
when allowed, so that validated work activity is added to the case history.

##### 2.1.8.1 Automated test coverage

**Implemented:** No direct worker-operation-form test; customer operation behavior is covered by `forms.test.ts`.

**Priority cases to add:** Add worker audience success, customer rejection, authorization boundaries, schema/attachment limits, and atomic operation/blob/audit/outbox state.

#### 2.1.9 Review pending customer changes

As a case worker with approval permission, I can view customer case-form
submissions awaiting approval in my authorized categories so that I can review
proposed changes.

##### 2.1.9.1 Automated test coverage

**Implemented:** `portal-endpoints.test.ts`: pending approvals are scoped to approval grants.

**Priority cases to add:** Cover empty/multiple queues, registry/category/validity boundaries, already-decided exclusion, ordering, and pagination.

#### 2.1.10 Approve or reject a pending change

As a case worker with approval permission, I can approve a pending submission
to apply its field changes, or reject it without applying them, so that
controlled case data remains governed.

##### 2.1.10.1 Automated test coverage

**Implemented:** `forms.test.ts`: approval success and unauthorized worker; `user-story-state.test.ts`: exact approved projection.

**Priority cases to add:** Add rejection with unchanged case data, double approve/reject conflict, concurrent decisions, stale case version, and rollback of pending/case/history/audit/outbox.

#### 2.1.11 Publish an explicit case projection

As a case worker with write permission, I can publish a case while selecting
exactly which publication-eligible fields and operations are exposed so that no
internal case data becomes public implicitly.

##### 2.1.11.1 Automated test coverage

**Implemented:** `portal-endpoints.test.ts`: worker-gated publish; `hardening.test.ts`: only explicitly selected fields/operations become public; `api.test.ts`: public projection.

**Priority cases to add:** Cover ineligible/unknown selections, republish replacement semantics, concurrent case change, audit/outbox, and rollback without partial projection.

#### 2.1.12 Unpublish a case

As a case worker with write permission, I can withdraw a case from publication
so that it no longer appears on the anonymous publishing surface.

##### 2.1.12.1 Automated test coverage

**Implemented:** No dedicated automated unpublish test.

**Priority cases to add:** Verify public disappearance, internal data preservation, repeated unpublish semantics, authorization, audit/outbox, and transaction rollback.

## 3. Public visitor

### 3.1 Publishing portal

#### 3.1.1 Search published cases

As a public visitor, I can search a registry's published cases, optionally by
category prefix, so that I can discover public registry information without
signing in.

##### 3.1.1.1 Automated test coverage

**Implemented:** `spine.test.ts`: only published cases are searched; `api.test.ts`: public published API.

**Priority cases to add:** Cover category-prefix boundaries, multiple registries, ordering/pagination, no results, and unpublish disappearance.

#### 3.1.2 View a published case

As a public visitor, I can open a published case by diary number so that I can
view its category, state, publication timestamp, and explicitly selected public
fields.

##### 3.1.2.1 Automated test coverage

**Implemented:** `api.test.ts`: public reads use published projections; `hardening.test.ts`: restricted/internal fields are absent.

**Priority cases to add:** Cover unknown/unpublished diary numbers, stale versus republished projection semantics, and cross-registry diary isolation.

#### 3.1.3 View published operations

As a public visitor, I can view only the operations explicitly included in a
case's publication projection so that internal history remains private.

##### 3.1.3.1 Automated test coverage

**Implemented:** `hardening.test.ts`: only explicitly selected operations are exposed.

**Priority cases to add:** Cover no operations, selection changes on republish, attachment exclusion, internal properties, ordering, and unpublish.

## 4. Registry administrator

### 4.1 Management portal

#### 4.1.1 Access administration features

As a registry administrator, I can use management features after authenticating
as a worker marked as an administrator so that ordinary workers and customers
cannot change platform configuration.

##### 4.1.1.1 Automated test coverage

**Implemented:** `admin.test.ts`: non-admin refusal; `hardening.test.ts`: trust-zone route hiding.

**Priority cases to add:** Cover customer/public/token denial, disabled/removed admin, production identity claims, and denied-attempt auditing.

#### 4.1.2 Add a statutory field

As a registry administrator, I can add a typed statutory field together with
its writability, publication, legal-basis, purpose, sensitivity, and retention
metadata so that the registry schema can evolve through a forward-only database
migration.

##### 4.1.2.1 Automated test coverage

**Implemented:** `admin.test.ts`: field migration and subsequent use.

**Priority cases to add:** Cover duplicate/invalid names, every type, incompatible metadata, existing-row defaults/nullability, migration failure rollback, and concurrent config edits.

#### 4.1.3 Add a lifecycle state

As a registry administrator, I can add an open or closed state and mark whether
it waits for the customer so that the registry lifecycle can evolve.

##### 4.1.3.1 Automated test coverage

**Implemented:** `admin.test.ts`: state addition as part of state/transition scenario.

**Priority cases to add:** Cover duplicate/invalid state, open/closed flags, config version/audit, and rollback.

#### 4.1.4 Add an allowed state transition

As a registry administrator, I can connect two configured states with an
allowed transition so that workers can use the new lifecycle path.

##### 4.1.4.1 Automated test coverage

**Implemented:** `admin.test.ts`: transition addition and subsequent case use.

**Priority cases to add:** Cover missing endpoints, duplicate/self/invalid edges, actor restriction, config version/audit, and rollback.

#### 4.1.5 Add a form

As a registry administrator, I can create a case or operation form, choose its
customer or worker audience, and configure its field subset, approval behavior,
property schema, operation type, and attachment support so that users can
submit governed data.

##### 4.1.5.1 Automated test coverage

**Implemented:** No dedicated automated admin-form creation test.

**Priority cases to add:** Cover both kinds/audiences, approval flag, field subset, schema, attachment/operation settings, invalid combinations, immediate usability, and rollback.

#### 4.1.6 Add a state-change rule

As a registry administrator, I can create an ordered conditional rule for a
state change using the fixed action catalog so that lifecycle automation can
set state, update values, create an operation, or record an external-effect
action.

##### 4.1.6.1 Automated test coverage

**Implemented:** No dedicated automated admin-rule creation test; configured rule execution is covered by `rules.test.ts`.

**Priority cases to add:** Cover each action/condition, invalid parameters/state/field, ordering, immediate execution, config version/audit, and rollback.

#### 4.1.7 Add a category

As a registry administrator, I can add an active hierarchical category so that
cases and permissions can use it.

##### 4.1.7.1 Automated test coverage

**Implemented:** Category path behavior is covered by `categories.test.ts`; no admin endpoint state-transition test exists.

**Priority cases to add:** Cover parent existence, duplicate/malformed/depth codes, registry roots, inactive parent, immediate authorization use, and rollback.

#### 4.1.8 Grant worker authorization

As a registry administrator, I can grant a worker registry- and category-scoped
read, write, transition, and approval permissions, optionally with opt-in and a
validity interval, so that access follows the worker's duties.

##### 4.1.8.1 Automated test coverage

**Implemented:** `hardening.test.ts`: registry and validity-window grant boundaries; authorization behavior appears in `spine.test.ts`.

**Priority cases to add:** Add admin endpoint tests for every permission, opt-in, validity bounds, overlap/revocation, immediate queue effect, audit, and rollback.

#### 4.1.9 Mint a scoped API token

As a registry administrator, I can mint a token scoped by registry, HTTP
methods, resources, category prefix, and published-only access so that an
integration receives only the access it needs. The raw secret is returned only
when the token is created.

##### 4.1.9.1 Automated test coverage

**Implemented:** `admin.test.ts`: minting a scoped API token; `api.test.ts`: method/category enforcement.

**Priority cases to add:** Cover invalid/overbroad scopes, one-time secret visibility, secure stored hash, registry/resource combinations, audit, and rollback.

#### 4.1.10 Revoke an API token

As a registry administrator, I can revoke a token by ID so that the integration
can no longer authenticate with it.

##### 4.1.10.1 Automated test coverage

**Implemented:** `admin.test.ts`: token revocation.

**Priority cases to add:** Verify immediate denial, repeated/unknown revocation, other tokens unaffected, concurrent use/revoke semantics, and auditing.

#### 4.1.11 View configuration versions

As a registry administrator, I can view the applied, versioned configuration
artifacts for a registry so that its configuration history is traceable.

##### 4.1.11.1 Automated test coverage

**Implemented:** `config-promote.test.ts`: stored artifact exact round trip.

**Priority cases to add:** Add admin list/detail authorization, ordering, immutable old versions, diffs, and concurrent updates.

#### 4.1.12 Run an all-registry CSV export

As a registry administrator, I can start the scheduled-export workflow on
demand and see the result for every registry so that I can verify export
production.

##### 4.1.12.1 Automated test coverage

**Implemented:** `exports.test.ts`: all-registry export and empty registry; admin-trigger route has no dedicated assertion.

**Priority cases to add:** Cover endpoint authorization, overlapping runs, partial registry failure, result reporting, and retry semantics.

## 5. Integration client

### 5.1 REST API

#### 5.1.1 Authenticate with a token

As an integration client, I can authenticate with a minted bearer token so that
the platform evaluates the same authorization model used by its portals.

##### 5.1.1.1 Automated test coverage

**Implemented:** `admin.test.ts`: token lifecycle; `api.test.ts`: scoped token use.

**Priority cases to add:** Cover malformed/expired/revoked secrets, hash comparison, token isolation, header variants, and authentication audit without secret leakage.

#### 5.1.2 Discover permitted registry metadata

As an integration client, I can list my token's registry and request metadata
when the token permits that resource so that I can understand the available
fields and other public contract information.

##### 5.1.2.1 Automated test coverage

**Implemented:** `portal-endpoints.test.ts`: metadata shape; `hardening.test.ts`: anonymous metadata filtering.

**Priority cases to add:** Add token-specific metadata resource/method scope, restricted field/form/workflow filtering, unknown registry, and revoked token.

#### 5.1.3 Read a case within scope

As an integration client, I can read a case only when its registry, HTTP method,
resource, and category match my token. A published-only token receives only the
explicit publication projection.

##### 5.1.3.1 Automated test coverage

**Implemented:** `api.test.ts`: method/category token scope and public projection; `hardening.test.ts`: projection privacy.

**Priority cases to add:** Cover registry/resource mismatch, category-prefix siblings, unpublished published-only read, full-read scope, expiry/revocation, and no side effects on denial.

#### 5.1.4 Create a case within scope

As an integration client with `POST` access to cases, I can create a case in an
allowed category so that an external system can initiate a matter without being
able to choose its lifecycle state.

##### 5.1.4.1 Automated test coverage

**Implemented:** `hardening.test.ts`: integrations cannot choose lifecycle state; `api.test.ts`: token scope behavior.

**Priority cases to add:** Add successful token create plus method/category/registry denials, required fields, idempotent retries, diary rollback, and full atomic projection.

#### 5.1.5 Add an operation within scope

As an integration client with the required write scope, I can append a valid
operation to an allowed case so that external activity is captured in the
append-only history.

##### 5.1.5.1 Automated test coverage

**Implemented:** `hardening.test.ts`: generic customer operation is blocked; no dedicated integration operation success test.

**Priority cases to add:** Add successful append, schema/type/size validation, scope boundaries, idempotency, ordering, audit/outbox, and rollback.

#### 5.1.6 Transition a case within scope

As an integration client with the required transition scope, I can request an
allowed state change so that integrations participate in the configured
lifecycle without bypassing the state machine or rules.

##### 5.1.6.1 Automated test coverage

**Implemented:** `api.test.ts`: transition endpoint state machine and rules.

**Priority cases to add:** Add token-specific success and method/resource/category denials, illegal edge, concurrency, cascading rollback, audit, and outbox.

#### 5.1.7 Search published cases

As an integration client with the appropriate read scope, I can search
published cases by registry and category prefix so that public registry data is
available for machine consumption.

##### 5.1.7.1 Automated test coverage

**Implemented:** `api.test.ts`: public published search and token scoping.

**Priority cases to add:** Cover published-only scope, category-prefix boundaries, registry isolation, pagination/order, revocation, and no internal fields.

## 6. Platform operator

### 6.1 Multi-registry platform

#### 6.1.1 Host multiple configured registries

As a platform operator, I can host multiple registries from configuration, each
with its own database, diary format, fields, lifecycle, forms, and rules, so
that adding a registry does not require new domain code.

##### 6.1.1.1 Automated test coverage

**Implemented:** `multi-registry.test.ts`: second registry works from configuration; `portal-endpoints.test.ts`: both registries listed.

**Priority cases to add:** Add a third minimal registry fixture, invalid registry config rejection, independent restart, and configuration-scale tests.

#### 6.1.2 Isolate registry data and authorization

As a platform operator, I can rely on separate registry data stores and
registry-scoped grants so that access to one registry does not grant access to
another.

##### 6.1.2.1 Automated test coverage

**Implemented:** `multi-registry.test.ts` and `hardening.test.ts`: database, grant, and category isolation.

**Priority cases to add:** Add identical diary numbers across registries, cross-registry IDs/tokens/forms, failure isolation, backup/restore isolation, and leakage scans.

#### 6.1.3 Use SQLite or SQL Server configuration

As a platform operator, I can select the database dialect and connection mode
through environment configuration so that the same platform supports local
SQLite operation and SQL Server deployment modes.

##### 6.1.3.1 Automated test coverage

**Implemented:** `dialect.test.ts`, `sqlserver-config.test.ts`, and `sqlserver-migration-ddl.test.ts`: offline dialect/config/DDL coverage.

**Priority cases to add:** Run the complete suite against live SQL Server, including transactions, concurrency, Unicode/decimal/date behavior, migrations, and recovery.

#### 6.1.4 Apply forward-only migrations and registry configuration

As a platform operator, I can bootstrap databases by applying ordered,
idempotent migrations and declarative registry configuration so that an
environment reaches the expected schema safely.

##### 6.1.4.1 Automated test coverage

**Implemented:** `config-promote.test.ts`: fresh-environment reproduction; `bootstrap-logging.test.ts`: bootstrap database targets and migration progress; migration behavior is also exercised throughout bootstrap tests.

**Priority cases to add:** Cover repeated bootstrap, partially applied migration recovery, incompatible schema/config, concurrent bootstraps, large existing datasets, and backup/restore.

#### 6.1.5 Promote versioned configuration

As a platform operator, I can export a registry configuration artifact and
promote it from development to test to production so that environments can
reproduce the same registry behavior.

##### 6.1.5.1 Automated test coverage

**Implemented:** `config-promote.test.ts`: exact artifact round trip and behavior reproduction.

**Priority cases to add:** Cover skipped/downgraded versions, tampering/checksum, environment-specific secrets, failed promotion rollback, approval controls, and drift detection.

#### 6.1.6 Separate trust zones

As a platform operator, I can run public, worker, or integration trust zones so
that privileged routes are absent from deployments that must not expose them.
Production startup fails closed when required security configuration is absent.

##### 6.1.6.1 Automated test coverage

**Implemented:** `hardening.test.ts`: trust-zone route absence and production fail-closed bootstrap; `http-smoke.test.ts`: API operation over a real network socket.

**Priority cases to add:** Cover every route in every zone, proxy/path variants, misconfiguration combinations, and deployed-artifact integration smoke tests.

#### 6.1.7 Protect customer data in logs

As a platform operator, I can omit customer data from logs by default or apply
configured redaction so that operational logging does not disclose customer
values.

##### 6.1.7.1 Automated test coverage

**Implemented:** `logger.test.ts`: default omission, configured prefix redaction, and invalid configuration.

**Priority cases to add:** Add nested objects, arrays/errors/URLs, Unicode, every customer field, structured logger transports, and snapshot scans proving secrets/attachments are absent.

### 6.2 Scheduled export component

#### 6.2.1 Export every registry to CSV

As a platform operator, I can run the export component to create one CSV for
each configured registry, including a header-only file for an empty registry,
so that complete registry extracts can be produced consistently.

##### 6.2.1.1 Automated test coverage

**Implemented:** `exports.test.ts`: every registry, correct CSV, and header-only empty registry.

**Priority cases to add:** Cover quoting/Unicode/newlines, large streaming export, stable schema/order, concurrent mutations, filesystem failure, partial failure, and retry/idempotency.

#### 6.2.2 Audit export runs

As a platform operator, I can inspect the recorded status and case count for
each registry export run so that scheduled exports are operationally traceable.

##### 6.2.2.1 Automated test coverage

**Implemented:** `exports.test.ts`: success status and case counts.

**Priority cases to add:** Cover failed/partial runs, timestamps/duration, error sanitization, retry linkage, concurrent runs, and audit retention.

### 6.3 Audit and outbox components

#### 6.3.1 Record sensitive changes in the audit trail

As a platform operator, I can rely on case and administrative changes producing
audit records with actor and correlation information so that important actions
are traceable.

##### 6.3.1.1 Automated test coverage

**Implemented:** Audit assertions are embedded in domain/admin scenarios; there is no comprehensive audit-contract suite.

**Priority cases to add:** Create contract tests for every sensitive command and every denied attempt, actor/correlation/outcome/details, append-only protection, redaction, and rollback.

#### 6.3.2 Record integration events atomically

As a platform operator, I can rely on domain changes writing outbox events in
the same transaction so that a future dispatcher can deliver integrations
without losing committed events.

##### 6.3.2.1 Automated test coverage

**Implemented:** `hardening.test.ts`: state transition and cascading rule rollback; several service tests exercise outbox writes indirectly.

**Priority cases to add:** Create outbox contract tests for every mutation, exact payload/correlation, same-transaction rollback, dispatcher retry/backoff, duplicate delivery, and consumer idempotency.

## Current boundaries

The following items are deliberately not expressed as completed user stories:

- Real customer eID/OIDC and staff SSO providers are not connected; the web
  console uses a development identity stub.
- The management portal is create-oriented in several sections because not all
  configuration types have read/list endpoints.
- External-effect rule actions are recorded as operations, but a concrete
  message-broker dispatcher, retries, and consumer idempotency are deferred.
- The SQL Server implementation has automated dialect and DDL coverage, but it
  still needs validation against a live SQL Server environment.
- Export execution exists, but an external scheduler must invoke it on the
  required timetable.
