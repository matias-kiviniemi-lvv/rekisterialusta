# Testing the Registry Platform

This is a runnable foundation — a real backend plus a web console — with no build
step and **no runtime dependencies**. Everything below runs straight from the
source with Node.js.

---

## Prerequisites

- **Node.js 22.6 or newer** (uses native TypeScript type-stripping and the
  built-in `node:sqlite` module). Check your version:

  ```
  node --version
  ```

  If it prints something older than `v22.6`, install a current release from
  <https://nodejs.org> and re-check. This is the only common snag — if a command
  complains about `--experimental-strip-types`, your Node is too old.

- **No `npm install` needed** to run the app, the demos, or the tests. The only
  thing that needs an install is the optional type-check (step 5).

> All data is in **in-memory SQLite** — it resets every time the server restarts.
> That's expected at this stage; persistence arrives when the SQL Server adapter
> is wired up (see the note at the end).

---

## 0. Get into the project folder

Unzip `registry-platform-foundation.zip` (right-click → Extract All on Windows),
then open a terminal in the `registry-platform` folder:

```
cd C:\_PROJECTS\Rekisterialusta\registry-platform
```

(Adjust the path if you extracted it elsewhere.)

---

## 1. The web console — click through all four portals

This is the main way to try the system by hand.

```
npm run serve
```

Then open **http://localhost:8080** in a browser. It starts with a little demo
data already loaded. Stop the server any time with **Ctrl+C**.

The **"Acting as"** dropdown (top-right) switches your identity. This is a dev
stub for logging in — it lets you feel the two authorization systems and the
admin gating without a real identity provider. Try this tour:

| Act as | Portal | What to try | What it shows |
|---|---|---|---|
| **Citizen One** | Customer | Open a case; "Start a new case"; submit "Update site address" | Customers see only their own cases; the address change needs worker approval |
| **Anna — worker (105)** | Case-worker | Queue tabs (assigned / unassigned / authorized); open a case → "Move to" a state → Apply; "Assign to me"; "Publish"; approve the pending address change | A worker's queue is bounded by category; the history is append-only; a rule fires on some transitions |
| **Bo — worker (200)** | Case-worker | Try to open one of Anna's `105` cases | "Not visible to this identity" — category authorization denies it |
| **Public** | Publishing | Click Search | Only **published** cases appear; nothing private is ever shown |
| **Admin** | Management | Add a field; add a state + transition; mint an API token; "Run export now" | Configure a registry with no code change; each edit bumps the config version |
| **Anna** (again) | Management | Try any admin action | Refused — the management portal is admin-only |

Also switch the **Registry** dropdown (top-right) between **Permit** and
**Grant** — the Grant registry has different fields, states, and diary-number
format, yet runs on the same engine (it was added purely as configuration).

---

## 2. Run the automated tests

Proves the backend behaves correctly — authorization, the state machine, forms
and approval, the rule engine, multi-registry isolation, config promotion,
exports, and a real over-the-socket HTTP check.

```
npm test
```

Expected result:

```
# tests 73
# pass 73
# fail 0
```

If you want to run a single area, point the runner at one file, e.g.:

```
node --test --experimental-strip-types test/api.test.ts
node --test --experimental-strip-types test/multi-registry.test.ts
```

Test files live in `test/` and are named by area (`spine`, `api`, `forms`,
`rules`, `admin`, `multi-registry`, `config-promote`, `exports`, `http-smoke`, …).

### User-story state-transition tests

`test/user-story-state.test.ts` is the higher-level data-integrity layer. Each
test starts a fresh platform with fixed time and controlled master/config data,
creates its own case through the public API, performs the same commands as a
portal user, and compares a stable projection of persisted customer state after
each important step. The projection includes the case value and version,
append-only operations, and pending approval records, while intentionally
excluding generated database keys and event UUIDs.

Add scenarios as a table of **arrange → command → expected projection**. Keep
one fresh database per test; never make scenarios depend on execution order or
share a mutable golden database. Assert intermediate state as well as the final
state, especially when a command must *not* mutate customer data. Approval and
no-approval forms are the baseline examples:

```
node --test --experimental-strip-types test/user-story-state.test.ts
```

For destructive or multi-write operations, extend the projection with the
relevant tables and include a failure-injection scenario that verifies the
whole projection is unchanged after rollback. Prefer semantic inline expected
objects over raw database dumps: review diffs then describe actual business
state changes and remain stable across database implementations.

---

## 3. Narrated command-line walk-throughs (no browser)

Each prints a short story of what it did, end-to-end:

```
npm run demo          # domain-level: create a case, move it, enforce authorization
npm run api-demo      # over the REST API: auth, forms + approval, the rule engine
npm run phase5-demo   # two registries, admin edits, config versions, CSV export
```

---

## 4. Poke the REST API directly (optional)

With `npm run serve` running, in a second terminal:

```
# list registries
curl http://localhost:8080/api/registries

# a worker (stub identity) creates a permit case
curl -X POST http://localhost:8080/api/registries/permit/cases ^
  -H "authorization: Bearer worker:w-anna" ^
  -H "content-type: application/json" ^
  -d "{\"category\":\"105.04.03\",\"initialState\":\"received\",\"fields\":{\"applicant_name\":\"A\",\"permit_kind\":\"water\",\"fee_paid\":true}}"

# public sees only published cases
curl http://localhost:8080/api/registries/permit/published
```

Stub-identity bearer tokens are `worker:w-anna`, `worker:w-bo`, `worker:w-cara`,
`worker:w-admin`, `customer:c-1`, `customer:c-2`. Sending no `authorization`
header is the "public" identity.

(The `^` above is the Windows line-continuation character for `cmd`. In
PowerShell use a backtick `` ` `` instead, or just put the whole command on one
line.)

---

## 5. Type-check (optional — the one step that needs an install)

```
npm install
npm run typecheck
```

This installs TypeScript (a dev-only dependency) and runs `tsc --noEmit` under
strict settings. It should complete with no output (no errors).

---

## What "passing" looks like

- `npm run serve` → the console loads at http://localhost:8080 and every portal
  responds; switching identity visibly changes what you can see and do.
- `npm test` → `# pass 73 / # fail 0`.
- `npm run typecheck` → no errors.

---

## A note on persistence and SQL Server

The default run uses in-memory SQLite, while `DB_DIR` selects persistent SQLite
and `DB_DIALECT=sqlserver` selects the optional `mssql` adapter. SQL Server SQL
generation is tested offline, but the complete adapter/migration path still
needs a live SQL Server integration run before production approval. See
`ENVIRONMENTS.md` and `HARDENING_PORT.md`.
