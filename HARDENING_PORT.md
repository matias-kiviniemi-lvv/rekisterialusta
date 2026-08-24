# Hardening port

This branch keeps Prototype 2 as the configurable multi-registry baseline and
ports the strongest integrity and security patterns identified during the
prototype review.

## Ported controls

- **Explicit publication projections.** Anonymous and `publishedOnly` token
  reads use `published_cases` and `published_operations`; they never serialize
  internal case rows or the full operation history. A worker selects eligible
  fields and operation IDs during publication.
- **Registry- and time-scoped worker grants.** Authorization keys include the
  registry and optional `valid_from` / `valid_until` boundaries. Active worker
  and category records are required.
- **Server-owned customer commands.** Customer input cannot choose an initial
  state, forge case parties, call the generic operation command, or transition
  lifecycle state. Customer changes use configured forms and approval flows.
- **Optimistic concurrency and safe sequencing.** Case-changing commands use a
  version compare-and-swap. Per-case operation IDs use an atomic case-row
  counter instead of `MAX(id)+1`.
- **Atomic state/rule execution.** A requested transition, cascading rule
  actions, history, audit, and outbox records commit or roll back together.
- **Audit and transactional outbox.** Material commands write correlated audit
  events and integration-ready outbox events in the aggregate transaction.
- **Governed statutory fields.** Each field declares create/update
  writability, publication eligibility, legal basis, purpose, sensitivity, and
  retention policy. Complete registry artifacts are validated before DDL or
  rule application.
- **Trust-zone route boundaries.** The server supports `public`, `worker`, and
  `integration` deployments in addition to the development `combined` mode.
  A public deployment does not expose worker/admin commands, and integration
  deployments accept machine tokens only.
- **Production fail-closed composition.** `APP_ENV=production` requires an
  explicit `IdentityProvider` and `BlobStore`; the development bearer parser,
  in-memory attachments, and sample identity seeding are not selected.
- **Input and attachment limits.** HTTP JSON bodies default to 1 MiB;
  attachments have count, encoding, filename, media-type, and decoded-size
  checks. Blob writes are compensated if their SQL transaction rolls back.
- **SQL Server transaction isolation.** Each adapter transaction owns its own
  `mssql.Transaction`; concurrent requests cannot accidentally share adapter
  transaction state.

## Deployment notes

Use separate processes/endpoints for the three trust zones:

```bash
npm run serve:public
npm run serve:worker
npm run serve:integration
```

`combined` remains convenient for the local demonstration console, but should
not be internet-facing. Production composition must pass real identity and blob
adapters to `bootstrapFromEnv`; no permissive fallback is provided.

The schema changes are included in the prototype's fresh migrations. For an
existing environment created by the original prototype, create explicit
forward migrations for `worker_authorizations`, the case version/counter, the
publication projections, audit, and outbox tables before deploying this code.
Do not edit an already-recorded migration in a real environment.

## Verification

The behavior suite includes targeted regressions for customer privilege
boundaries, selective publication, registry/time grant isolation, atomic rule
rollback, trust zones, and production fail-closed startup. Run:

```bash
node --test --experimental-strip-types test/*.test.ts
```

The offline suite passes 73/73 tests. SQL Server SQL generation remains covered
by unit tests, but—as in the source prototype—the complete SQL Server path still
needs a live integration run before production approval.

## Deliberately still external

This port defines the production seams but does not invent organization-specific
OIDC/eID, staff-directory, object-storage, key-management, SIEM, or message-bus
adapters. It also does not implement retention execution, malware scanning,
outbox delivery/retry workers, or a full denial-event audit strategy. Those
require the target organization's providers and policies.
