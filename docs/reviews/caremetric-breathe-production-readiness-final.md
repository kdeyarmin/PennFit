# CareMetric Breathe — production readiness, final review

**Date:** 2026-09-01
**Branch:** `claude/complete-breathe-production-readiness-smzz3r`
**Base commit reviewed:** `08d177620` — _feat(resupply): give every cycle
an ending, tie cadence to shipment evidence (#1366)_ (`main`)

---

## 1. Executive summary

The resupply lifecycle is now a **closed loop in code**. Cycles open,
close, and record why they closed; shipment evidence has exactly one
writer and one canonical path into it; claims can be traced from an
eligible patient through to a paid ERA and back out into a report that
distinguishes a clearinghouse rejection from a payer denial, an in-flight
claim from a loss, and an assumed shipment from a real one.

It is **not production validated**, and this document does not claim it
is. Nine external validations remain outstanding — every one of them
requiring a counterparty this repository cannot supply: a real PacWare
export, three manufacturer sandboxes, a physical device in someone's
hand, two inbound telephone calls on two tenants' own numbers, a
clearinghouse sandbox round trip, and a per-tenant flag cutover. The
harness, the runbook and the evidence requirements for each are built and
tracked in
[`external-validation-checklist.md`](./external-validation-checklist.md).

What changed in this work, in one line each:

- A preview deployment can no longer migrate the production database, and
  the guard refuses on **ambiguity** rather than guessing.
- The two lifecycle feature flags became a **per-tenant cutover with an
  auditable record**, not a switch anyone can flip.
- The PacWare shipment import became something an operator can actually
  work: preview mode, file-hash idempotency, ten disposition categories
  with separate downloadable reports, and an exception workflow for a
  date that would change a billed claim.
- Manufacturer connectors now tell a bad credential apart from a bad URL,
  retry only what is retryable, and cannot be labelled live-validated
  without a timestamp from a real call.
- The fitter gained a diagnostic that detects a **reversed pose
  convention** on a real device — showing derived angles only, never a
  photograph.
- Voice tenant attribution is proven deterministically for two tenants,
  for a shared DID split across channels, and fails closed on an
  ambiguous caller — without dialling a telephone.
- Two `NOT VALID` constraints gained a read-only preflight and a
  follow-up VALIDATE migration that refuses rather than rewrites.
- Every human-approval queue gained an age, an owner, an SLA and a
  working link.
- The whole order-to-cash path gained a deterministic end-to-end test
  plus nineteen branch cases.
- Twenty-seven lifecycle signals are now watched, with aggregate,
  deduplicated, PHI-safe alerting and a response procedure per signal.

---

## 2. Repository commit reviewed

| Field            | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Repository       | `kdeyarmin/PennFit`                                   |
| Base (`main`)    | `08d177620`                                           |
| Branch           | `claude/complete-breathe-production-readiness-smzz3r` |
| Commits added    | 11                                                    |
| Migrations added | `0539` – `0543`                                       |
| Files changed    | 115+                                                  |

Commits, in order:

| Commit      | Workstream | Subject                                                                 |
| ----------- | ---------- | ----------------------------------------------------------------------- |
| `f2587e224` | WS1        | stop a preview deployment from migrating production                     |
| `7774f14f8` | WS7        | survey and validate the episode lifecycle constraints                   |
| `6b5f4e14c` | WS2        | make the lifecycle flags a cutover, not a switch                        |
| `8e8ba4d33` | WS3        | make a shipment import something an operator can work                   |
| `65e62ee39` | WS4        | tell a bad credential apart from a bad URL                              |
| `0fc8f928f` | WS5        | find out whether the pose matrix means what we assume                   |
| `650909b87` | WS6        | prove tenant attribution without dialling a telephone                   |
| `b2e4f0024` | WS8        | give every approval queue an age, an owner and a live link              |
| `a98c914c4` | WS9        | prove the full lifecycle end to end, and each way it ends               |
| `c063fca43` | WS10       | watch the resupply lifecycle for the failures that never raise an error |
| _(final)_   | WS11       | correct stale claims, restore two empty test files, publish this review |

---

## 3. Completed work by workstream

### WS1 — Preview deployments cannot mutate production

**The problem.** Railway shared variables propagate into preview
environments, so a deployment's self-declared identity is not
trustworthy. `NODE_ENV=production` is set in every environment that
builds for production, preview included.

**What was built.** `lib/resupply-db/scripts/deploy-environment.mjs`
resolves a deployment tier by cross-checking `DEPLOY_ENV` against
markers Railway does **not** inherit (`RAILWAY_ENVIRONMENT_NAME`,
`RAILWAY_GIT_BRANCH`). Disagreement resolves to `ambiguous`, and
ambiguous is **blocked** — the guard refuses rather than guessing.

Database identity is a salted SHA-256 fingerprint of `host:port/dbname`
with credentials and query parameters excluded, so a preview can
recognise the production database without anyone ever having to print a
connection string. The governing rule:

> A deployment that is not production may not migrate a database that is
> not positively non-production.

Production → production stays possible. Preview → preview-DB stays
possible.

**Break-glass** requires two values: an exact phrase
(`I-UNDERSTAND-THIS-WRITES-TO-PRODUCTION`) and a reason of at least 20
characters. It is named to be alarming, emits a prominent audit line,
and `preflight:prod` **fails** while it is armed.

**Asymmetry, deliberately.** The migration guard refuses on ambiguity
(a refused `preDeployCommand` keeps the previous release serving). The
boot-time data-path guard only refuses on a _positive_ cross-tier match
and warns on ambiguity — a refused boot has no fallback and would take
production dark over an unset variable.

Tests: 63 unit + 9 spawning the real scripts + 9 boot-guard + 6
preflight. Runbook:
[`../runbooks/migration-environment-guard.md`](../runbooks/migration-environment-guard.md).

### WS2 — Lifecycle flags became a cutover

`resupply.due_at_authoritative` and `resupply.ship_evidence_required`
change how cycles close and how claims are dated. Enabling one is now:
a read-only readiness assessment, a set of blockers that must all clear,
an explicit typed confirmation, an evidence identifier, and a
`resupply_cutover_records` row capturing org, flag, previous value, new
value, actor, timestamp, readiness result and evidence id.

The assessment is **re-run at enable time**, so a stale pass cannot
authorise a flip. Readiness expires after 14 days
(`validation_expired`). A **truncated** assessment is a blocker: an
incomplete survey is not a passing one.

Rollback is deliberately **not** gated on a passing assessment — it must
always be available — and records its own reason (≥10 chars, enforced by
a DB CHECK).

No migration enables either flag anywhere. Migration `0540` writes no
flag values at all.

### WS3 — PacWare shipment confirmations

Preview and commit modes; file-hash idempotency with a partial unique
index on `(org_id, file_hash) WHERE mode='commit'`; ten disposition
categories (matched, ambiguous, unmatched, duplicate, cancelled, invalid,
too-old, future-dated, already-recorded, date-conflict) each with its own
downloadable CSV carrying **no cell values**; a fixed match precedence
where `date_conflict` outranks `matched`; and an exception workflow for a
ship date that would change a claim already filed.

`recordShipmentEvidence` is the single canonical writer of
`fulfillments.shipped_at`. An ambiguous row is never guessed. A claim is
never sourced from `assumed_shipped`.

A safe offline validator (`pacware:validate-shipments`) reads a file in
place with no database, no network and no writes.

Sample template + data dictionary shipped. Live validation **not
performed** — see checklist row 1.

### WS4 — Manufacturer integration validation

Twelve error kinds across three classes (configuration / transient /
no_data), so `403 Forbidden` no longer reads as "no data". The remedy for
`forbidden` explicitly says **do not rotate the secret** — the credential
authenticated and was refused, so the problem is entitlement.

Bounded retries with full jitter that never retry a configuration
failure; a circuit breaker keyed `(source, org)` that a `no_data`
response does not trip; a nine-step per-connector validator; and
`integration_connector_status` with a **DB-level CHECK** that
`status='live_validated'` requires `last_validation_success_at`.

A sync outcome cannot promote a connector to live-validated. The opt-in
live suite skips **visibly** rather than passing vacuously, and refuses
to run when `DEPLOY_ENV=production`.

No connector is labelled Production Validated. All three remain
`unvalidated` — checklist rows 2–4.

### WS5 — MediaPipe pose diagnostics

A dev-only page (`/internal/pose-diagnostics`, excluded from production
bundles) runs a seven-step guided sequence — level, chin up, chin down,
turn left, turn right, roll left, roll right — and reports per-axis
verdicts including **reversed**, which is the convention error a fixture
cannot find.

Movement is judged on the **geometric** estimate, so a broken
transformation matrix cannot declare everything inconclusive and pass by
default. Frame usability is computed from landmark geometry rather than
by reading pixels back, which makes "no image is captured" structurally
true rather than a promise. The geometric fallback is preserved
unchanged.

The device matrix ships with all eight rows marked "not run" and its
release gate cannot read as passed while any is — checklist row 5.

**No clinical sizing threshold was changed.**

### WS6 — Voice tenant attribution

Sixteen deterministic tests: two tenants with two DIDs; the same DID
registered by one tenant for SMS and another for voice (asserting the
resolver probes **only** the channel's own column, and that a
channel-blind cache cannot serve one answer for the other); a patient
phone that exists in two tenants failing **closed**; hostile filter
metacharacters; and a failed directory read resolving to `null` rather
than to the seed org.

Recency of contact is never used as evidence of ownership.

A simulated-inbound CLI reproduces the Twilio HMAC independently, refuses
production hosts **even with the override flag**, refuses
`DEPLOY_ENV=production`, refuses a non-local host without an explicit
acknowledgement, and prints response **shape** only. Ten spawn-based
refusal tests.

**No call was placed and no patient was contacted** — checklist rows 6–7.

### WS7 — `NOT VALID` constraints

A read-only preflight (`constraint-preflight`) that sets
`default_transaction_read_only = on` and counts violations with
Postgres's own violation predicate (`WHERE (<check body>) IS FALSE` — a
CHECK passes on NULL). It reports counts and sanitised identifiers,
groups only allowlisted vocabulary columns, and its `--repair-plan`
output is **entirely commented out** with a blank target.

Migration `0539` surveys first and `RAISE`s with the offending values
rather than validating over dirty data. Verified against real PostgreSQL:
it refuses with dirty rows and succeeds after repair. **No historical
status was silently rewritten.**

No production migration was run.

### WS8 — Human-approval queues

All 14 gates now carry an age column, an SLA (or an explicit `null` for a
standing task), a priority, a recorded disposition, and — for the four
that cannot be counted — a written reason, so a permanent dash is not
mistaken for an outage.

Four states stay four: `waiting: 0` (empty), `countable: false` (no
queue, with a reason), `waiting: null` + `countFailed` (the read failed),
`partlyAutomated` (the count is a **ceiling**, not a backlog).

A failed **age** read deliberately does not fail the **count**. `escalate`
is `breached` past a configurable multiplier. A repo-level check verifies
every gate's href is a real SPA route, and it self-tests.

A spec pins that only `claim_submit` carries `conditionalOn`, so a manual
gate cannot quietly become automatic.

### WS9 — End-to-end order-to-cash

Thirty deterministic tests over a synthetic in-memory ledger, using the
**real** `build837P`, `parse277CA`, `parse835`, `buildEpisodeClosure` and
`aggregateOrderOutcomeFunnel` rather than restating their outputs.

Covers the full happy path plus nineteen branches. Four distinctions are
asserted rather than assumed: a 277CA rejection is not a payer denial; an
in-flight claim is not a loss; `assumed_shipped` is not shipped and can
never source a date of service; shipped-but-unbilled is its own visible
number. `partially_paid` stays distinct from `paid`.

Synthetic patients and synthetic claims only. **Nothing was sent to a
live clearinghouse** — checklist row 8.

### WS10 — Monitoring, alerting and data quality

Twenty-seven signals in one catalog, one pure evaluator, one collection
pass, a two-hourly scan and a live admin panel sharing both collectors and
evaluator — so the page and the alert cannot disagree about a number.

Six states, because four of them are not "ok": `disabled` (this tenant
does not use the feature), `not_configured` (the feature exists and
nothing is set up, so the value is genuinely unknown), and `unknown` (the
read failed) each render distinctly and are counted separately. An
`unknown` never resolves an open alert.

Suppression is enforced: a new problem notifies, a worsening one
notifies, an unchanged one notifies at most once a day, a recovery
notifies once, and a failure improving to a warning is silent. A
simulated day of two-hourly scans over one persistent failure produces
**one** notification. Deduplication is arbitrated by a partial unique
index, not by a read-then-write check.

Every signal is a count, age or ratio over a population, so per-patient
alerting is unreachable. Row-fetching collectors are paged and capped, a
capped read marks its number a **floor**, and a meta-signal names which
collectors truncated.

Two platform-scope signals cover rows that belong to no tenant. Inbound
attribution failures had no record at all before this — dropping is
correct but unrecorded meant the failure rate was zero by construction —
so migration `0543` adds a day/channel/reason rollup with no phone number
in it and no column for one.

Every signal has a runbook section, and a spec reads the shipped markdown
to prove it.

### WS11 — Stale claims and honest documentation

- `docs/app-logic-workflow-review-2026-08-26.md` gained a **status
  banner** naming which of its findings are now closed and by what. The
  body is deliberately not rewritten: it is a dated record.
- `docs/resupply-reminder-algorithm.md` now says a decline ends **this
  cycle** and not the patient's enrolment, and that START re-opens the
  ladder (with why that second half is load-bearing).
- `artifacts/cpap-fitter/src/lib/admin/pacware-api.ts` no longer reads as
  though `shipped_at` still has no writer, and says plainly that PacWare
  remains a file exchange.
- A duplicated doc comment in `refit-campaign.ts` was removed.
- Two **zero-byte** `.test.ts` files — committed empty in `9c4e30457`,
  failing every run since as "no test suite found" — were replaced with
  real suites (18 + 22 tests). They were pre-existing failures on
  unmodified `main`; deleting them would have been the cheap fix and
  would have removed the signal.

Claims searched for and **not found** anywhere in the repository: "voice
calls cannot be tenant attributed", "all fitting confidence paths are
equivalent", "claims are automatically submitted by default", and any
statement equating fixture coverage with production validation (the two
places that discuss it say the opposite, explicitly).

---

## 4. Security and tenant-isolation findings

**Fixed or hardened in this work:**

| Area                      | Finding                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment isolation      | A non-production deployment could migrate the production database. Now refused, including on ambiguity.                                                                                             |
| Runtime data path         | A preview holding production Supabase credentials could serve production PHI. Now refused at boot on a positive cross-tier match.                                                                   |
| Inbound attribution       | Dropped events left no record, so a misrouted DID could swallow a practice's inbound traffic indefinitely. Now counted, aggregate and PHI-free.                                                     |
| Voice channel attribution | The same DID registered by two tenants on different channels resolved to the wrong one. Pinned by test — the resolver probes only the channel's own column, and the cache key includes the channel. |
| Ambiguous caller          | Tie-breaking on recency would hand a patient's thread and its PHI to whichever tenant messaged last. Fails closed; pinned by test.                                                                  |
| Public NPS endpoint       | Now covered: a tampered, forged or expired token writes nothing, and a rating lands in the tenant that owns the **order**, never a default.                                                         |
| Catalog writes            | Substitution rules stay admin-only while backorder marks stay CSR-level — pinned by test, because a CSR re-ordering mask substitutions is a clinical decision.                                      |

**Invariants verified as still holding:**

- `check-tenant-isolation.sh`: no direct `getSupabaseServiceRoleClient()`
  in application code — **PASS**.
- `check-raw-org-scope.sh`: every `.raw()` access to a guarded table
  carries an `org_id` filter — **PASS**. The two new platform-scope reads
  carry an explicit `raw-org-scope-exempt` marker with a written
  justification; both count rows that belong to **no** tenant, where an
  org filter would return zero by construction.
- `check-admin-route-gates.sh`: every admin mutation carries
  `requireAdmin` or `requirePermission` — **PASS**. The new
  `/admin/lifecycle-health` route is `requirePermission("reports.read")`
  and is read-only.
- `check-approval-gate-links.sh`: every gate leads to a real page —
  **PASS**.
- No tenant resolution was made to fall back to the seed organization.
- No RBAC gate was widened.

---

## 5. Compliance safeguards

Preserved and, where touched, strengthened:

- **No shipment date is ever invented.** `recordShipmentEvidence` is the
  single writer of `fulfillments.shipped_at`; the grace sweep advances a
  cycle as `assumed_shipped` and touches nothing else; a claim's date of
  service comes from a real shipment or the claim is not raised. A
  critical signal counts claims raised without it.
- **A grace-period advance is not evidence.** `assumed_shipped` is
  reported apart from `fulfilled` everywhere — the funnel, the panel, the
  monitor — precisely so it can never be counted as product that shipped.
- **Eligibility is not authorization.** The fitter ends in a _request_
  worked by staff; `POST /api/orders` refuses while
  `fitter.lead_capture_only` is on, and that flag fails toward ON.
- **No uncontrolled automatic shipment.** Nothing added here ships,
  submits or contacts. The monitor's only writes are to its own tables.
- **Affirmative patient need and confirmation preserved.** No
  confirmation requirement was relaxed.
- **PHI discipline.** No image, biometric frame, patient identifier,
  credential or vendor payload reaches a log, an alert body, a Slack
  message or a disposition CSV. The NPS detractor ping carries a
  "has a comment" flag and never the comment; the attribution rollup has
  no column that could hold a phone number; the pose diagnostic never
  sees an image.
- **Human review preserved.** No manual gate was made automatic; a spec
  asserts it.
- **Audit trails preserved.** Nothing was deleted or rewritten.
  Migration `0539` refuses rather than reconciling historical statuses.
- **PostgREST row caps respected.** Every scan either uses a database-side
  `head: true` count or pages with an explicit truncation report.

---

## 6. Automated verification performed

Run on Node v24.20.0 / pnpm 11.7.0, against PostgreSQL 16 for the
migration work.

| Command                                                           | Result      |
| ----------------------------------------------------------------- | ----------- |
| `pnpm install --frozen-lockfile`                                  | PASS        |
| `pnpm typecheck` (libs + all three artifacts)                     | PASS        |
| `pnpm lint:resupply` (`--max-warnings 0`)                         | PASS        |
| `pnpm format:check`                                               | See §6 note |
| `node scripts/run-resupply-checks.mjs`                            | PASS        |
| `check-tenant-isolation.sh`                                       | PASS        |
| `check-raw-org-scope.sh`                                          | PASS        |
| `check-admin-route-gates.sh`                                      | PASS        |
| `check-approval-gate-links.sh` (+ `--self-test`)                  | PASS        |
| Migration replay, 0000 → 0543, from an empty database             | PASS        |
| Migration `0539` refusal on dirty data, then success after repair | PASS        |
| Migration `0543` constraint behaviour against real Postgres       | PASS        |
| `resupply-api` test suite                                         | See below   |

**Migration 0543 was verified against a real PostgreSQL 16 instance**, not
only in review: the open-alert unique index refuses a second open alert
for the same `(scope, signal)` in **both** tenant and platform scope
(the `'platform'` sentinel avoids PG14's NULLs-are-distinct behaviour);
resolving frees the slot so a signal may legitimately fire again;
`scope_id` and `org_id` cannot drift apart; a resolved alert must carry a
reason; an off-vocabulary status is refused; the attribution RPC
increments atomically and rejects an off-vocabulary reason; and deleting
a tenant cascades its alerts away.

**Test counts.** The `resupply-api` suite reported **8559 passed / 13
skipped** with two FILES failing as "no test suite found" — both
zero-byte files that were empty on unmodified `main` and are now real
suites (see WS11). New tests added by this work: 63 + 9 + 9 + 6 (WS1),
13 (WS7), WS2/WS3/WS4/WS5 suites, 16 + 10 (WS6), 16 + 19 (WS8), 30
(WS9), 77 + 34 + 19 + 11 (WS10), 18 + 22 (WS11).

The final full-suite figures are recorded in the pull request; anything
this document states as PASS was observed, not assumed.

---

## 7. External validations actually performed

**None.**

No live PacWare file was imported. No manufacturer connection was made.
No physical device ran the fitter diagnostic. No telephone call was
placed. No claim was transmitted to any clearinghouse, sandbox or
otherwise. No production feature flag was changed. No production database
was mutated.

This section is deliberately short and deliberately empty. Every claim of
validation elsewhere in this repository is scoped to what was actually
run.

---

## 8. External validations NOT performed

All nine items in
[`external-validation-checklist.md`](./external-validation-checklist.md):

1. PacWare shipment-confirmation file (live)
2. ResMed AirView connector (live)
3. Philips Care Orchestrator connector (live)
4. React Health / 3B Medical connector (live)
5. Physical-device fitter validation (8-device matrix, all rows "not run")
6. Tenant A inbound voice call
7. Tenant B inbound voice call
8. Clearinghouse sandbox order-to-cash round trip
9. Per-tenant lifecycle feature-flag cutover

For each: the harness is built, the runbook is written, the safe
commands exist, and the evidence requirements are enumerated. What is
missing is the counterparty.

---

## 9. Exact remaining operator actions

Each row is a single action with a command or a screen, a named owner and
a defined pass condition. Full procedures and evidence lists are in the
checklist.

| #   | Action                                                                     | Who                         | Command / screen                                                                                                     | Expected result                                                                                                                       |
| --- | -------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Set the deployment identity variables in Railway                           | Platform operator           | `DEPLOY_ENV` **per environment**; `PRODUCTION_DATABASE_FINGERPRINT` and `PRODUCTION_SUPABASE_FINGERPRINT` **shared** | `pnpm --filter @workspace/scripts preflight:prod` passes in production and a preview's migration attempt is refused with exit code 3  |
| 2   | Validate a real PacWare export offline                                     | Billing operator            | `pnpm --filter @workspace/scripts pacware:validate-shipments -- <path>`                                              | Counts and categories printed; no database or network touched                                                                         |
| 3   | Preview-import the same file                                               | Billing operator            | `/admin/pacware` → preview                                                                                           | Disposition report downloaded; ambiguous and unmatched reviewed before any commit                                                     |
| 4   | Validate each manufacturer connector                                       | Engineer with sandbox creds | `/admin/integrations` → validate, or `INTEGRATION_LIVE_TESTS=1` suite                                                | Nine steps reported individually; `integration_connector_status` gains `last_validation_success_at`                                   |
| 5   | Reconcile against a manufacturer portal export                             | Engineer                    | `/admin/integrations` → reconcile                                                                                    | Four discrepancy counts recorded; `portal_reconciliation_discrepancies` leaves `not_configured`                                       |
| 6   | Run the fitter device matrix                                               | Tester with devices         | `/internal/pose-diagnostics` (dev build)                                                                             | Seven steps, per-axis verdict; **no** `reversed` on any axis; CSV exported                                                            |
| 7   | Place one inbound call to tenant A's number                                | Operator, staff handset     | The tenant's published DID                                                                                           | Tenant A's brand in the greeting; `voice_calls.org_id` = tenant A; visible in tenant A's console only                                 |
| 8   | Repeat for tenant B                                                        | Operator, staff handset     | Tenant B's published DID                                                                                             | Tenant B's brand and org; **contrast with row 7 is the evidence**                                                                     |
| 9   | Run the order-to-cash smoke test in stub mode                              | Biller                      | `OFFICE_ALLY_STUB=1`, synthetic patients                                                                             | 837P written to the outbox and inspected                                                                                              |
| 10  | Repeat against the clearinghouse **sandbox**, incl. a deliberate rejection | Biller                      | Sandbox credentials, synthetic claims                                                                                | 999/277CA received; the rejection lands as `rejected`, never as a denial; ERA reconciles; a partial payment lands as `partially_paid` |
| 11  | Assess cutover readiness per tenant (read-only)                            | Tenant owner                | `pnpm --filter @workspace/scripts resupply:cutover -- --org=<id>`                                                    | A report with all metrics, including truncation; blockers enumerated                                                                  |
| 12  | Enable a lifecycle flag, per tenant                                        | Tenant owner                | `/admin/resupply-cutover`                                                                                            | Assessment re-run at enable time; a `resupply_cutover_records` row written with the evidence id                                       |
| 13  | Tune alert thresholds after a week of real data                            | Platform operator           | `LIFECYCLE_HEALTH_<SIGNAL>_WARN` / `_FAIL`                                                                           | The panel reports `thresholdSource: "env"`; a typo reports `default_after_invalid_env` rather than silently failing                   |
| 14  | Validate the two episode constraints (off the deploy path)                 | DBA                         | `constraint-preflight`, then migration `0539`                                                                        | Preflight exits 0; `0539` validates both constraints                                                                                  |

---

## 10. Go-live criteria

Go-live is **not** gated on all nine external validations. It is gated on
the ones whose absence would cause harm. The rest are gated per feature.

**Must be true before production traffic:**

- [ ] `DEPLOY_ENV` set per environment; both `PRODUCTION_*_FINGERPRINT`
      values set and shared. Break-glass variables **absent**.
- [ ] `pnpm --filter @workspace/scripts preflight:prod` passes.
- [ ] A preview deployment's migration attempt is confirmed refused.
- [ ] `pnpm --filter @workspace/scripts verify:deploy -- https://<host>`
      confirms the API — not just the SPA — is routed.
- [ ] `RESUPPLY_ADMIN_EMAILS` populated, so the monitor's digests reach a
      person.
- [ ] The lifecycle health scan has completed at least once and the panel
      reports a `lastScanAt`.
- [ ] Checklist rows 6 **and** 7 (one inbound call per tenant) — because
      an unattributed inbound call is a live patient reaching nobody.

**Gated per feature, not on go-live:**

- Shipment-evidence billing (`resupply.ship_evidence_required`) — gated
  on checklist rows 1 and 9 for that tenant.
- Therapy-data-driven decisions — gated on checklist rows 2–4 for the
  connectors that tenant uses. Until then the connector reads
  `unvalidated` and the panel says so.
- Fitter recommendations on a given device class — gated on checklist
  row 5 for that device. The geometric fallback remains in place.
- Electronic claim submission — gated on checklist row 8.

**Explicitly NOT required for go-live:** every manufacturer connector, or
every device in the matrix. A tenant with no therapy integration is a
supported configuration, and the panel reports it as `not_configured`
rather than as healthy.

---

## 11. Rollback procedures

| What                                       | How                                                                          | Notes                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A lifecycle feature flag                   | `/admin/resupply-cutover` → rollback, or `resupply:cutover --rollback`       | **Not** gated on a passing assessment, deliberately. Requires a typed `ROLLBACK` and a ≥10-character reason (DB CHECK). Writes a record.                                  |
| A bad alert threshold                      | Unset or correct `LIFECYCLE_HEALTH_<SIGNAL>_WARN` / `_FAIL`                  | Read per scan; takes effect on the next tick, no deploy. A malformed value reverts to the default and says so.                                                            |
| Alert noise during an incident             | Raise `LIFECYCLE_HEALTH_RENOTIFY_HOURS`                                      | Read per scan. Raise it; do not disable the scan.                                                                                                                         |
| A committed PacWare import                 | Resolve the affected rows through the exception workflow at `/admin/pacware` | There is **no bulk un-import**, deliberately: a ship date that reached a claim must be corrected deliberately, per row, with a recorded resolution.                       |
| A connector marked live-validated in error | Re-run the validator                                                         | The status cannot be set without `last_validation_success_at`; correcting it means producing a real result, not editing a field.                                          |
| The monitor itself                         | Unregister `lifecycle.health-scan`                                           | It writes only to its own two tables and changes nothing else, so stopping it loses visibility and nothing more.                                                          |
| Migration `0543`                           | Forward-only                                                                 | Additive: two new tables, one new table, one function. Nothing existing is altered. Dropping them loses alert history and no application state.                           |
| Migration `0539`                           | Forward-only                                                                 | It VALIDATEs existing constraints. To undo, `ALTER TABLE … ALTER CONSTRAINT … NOT VALID` is not available in Postgres; drop and re-add `NOT VALID` if genuinely required. |
| A deploy                                   | Railway release rollback                                                     | The `preDeployCommand` gates on migration success, so a failed migration already keeps the previous release serving.                                                      |

---

## 12. Evidence locations

| Evidence                  | Where it lives                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cutover decisions         | `resupply.resupply_cutover_records` — org, flag, previous, new, actor, timestamp, readiness result, evidence id, rollback reason                                                 |
| Shipment imports          | `resupply.pacware_shipment_imports` — file hash, mode, row counts, dispositions, date range, importer                                                                            |
| Ship-date exceptions      | `resupply.shipment_date_exceptions` — recorded vs proposed date, claim id, resolution                                                                                            |
| Connector validation      | `resupply.integration_connector_status` — last validation attempt/success, error category and step, vendor API version, partial resources, consecutive failures                  |
| Portal reconciliation     | `resupply.integration_reconciliation_runs` — four discrepancy counts per source per run                                                                                          |
| Alert history             | `resupply.lifecycle_health_alerts` — first/last observed, peak status, notify count, resolution and reason                                                                       |
| Last-scan readings        | `resupply.lifecycle_health_observations` — one row per (scope, signal) with `observed_at`                                                                                        |
| Attribution failures      | `resupply.inbound_attribution_failures` — day, channel, reason, count. No identifiers.                                                                                           |
| Episode close-outs        | `resupply.episodes.closed_at` / `closed_reason` / `closing_fulfillment_id` / `cycle_number`                                                                                      |
| Fitter device results     | The exported CSV per device, plus the matrix in [`../runbooks/fitter-device-validation.md`](../runbooks/fitter-device-validation.md)                                             |
| External validations      | [`external-validation-checklist.md`](./external-validation-checklist.md) — the single tracked list                                                                               |
| Structured monitor events | The application log: `lifecycle_health.alert_open` / `_escalate` / `_renotify` / `_resolve` / `_deescalate`, and `lifecycle_health.scan_completed`. Counts and signal keys only. |

---

## 13. Known residual risks

| #   | Risk                                                                                                                                                      | Severity | Mitigation in place                                                                                                                                                                        | What would close it                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | **No external validation has been performed.** Every integration claim rests on fixtures.                                                                 | High     | Nothing is labelled validated; connector status starts `unvalidated`; the device matrix is all "not run"; both live-validation gates are enforced in the database and in the release gate. | The nine checklist rows.                                                                        |
| 2   | PacWare is a file exchange with no API, so a tenant that stops importing produces no evidence and nothing errors.                                         | High     | The `assumed_shipped` bucket is reported separately everywhere, and two critical signals (`assumed_shipped_growth`, `pacware_unmatched_rows`) watch it. Never becomes a ship date.         | An automated feed, which PacWare cannot provide. Operationally: a daily import.                 |
| 3   | The migration guard depends on operators setting `DEPLOY_ENV` per environment. Unset in production, `preflight:prod` fails — but preflight has to be run. | Medium   | Ambiguity blocks the migration; the boot guard warns; preflight fails; documented in the runbook and `.env.example`.                                                                       | Wiring `preflight:prod` into the deploy pipeline as a hard gate.                                |
| 4   | Alert thresholds are defaults sized for a mid-size DME. A larger tenant will see noise; a smaller one may see nothing.                                    | Medium   | Every threshold is env-tunable, read per scan, and its source is visible on the panel. Ratio signals withhold below a minimum sample.                                                      | A week of real data and one tuning pass (operator action 13).                                   |
| 5   | Two row-fetching collectors cap at 5,000 rows. Past that, `shipped_unbilled` and `claims_missing_ship_evidence` are **floors**.                           | Medium   | `truncated` is set, surfaced on the panel and in the alert body, and counted by a meta-signal that names the collector.                                                                    | A backlog small enough not to hit the cap — which is itself the finding.                        |
| 6   | The lifecycle monitor reads a snapshot for dead-letter depth, so that one signal can be up to two hours old.                                              | Low      | The row is marked `fromLastScan` with its age, and the panel warns when the scan itself is stale.                                                                                          | Nothing worth doing; a pg-boss handle in an HTTP request would be worse.                        |
| 7   | `analytics_window_truncated` and `worker_failures` describe the monitor, so a monitor outage partly hides itself.                                         | Low      | An `unknown` never resolves an open alert and is counted separately; the panel reports `lastScanAgeHours`.                                                                                 | External uptime monitoring on `/readyz`.                                                        |
| 8   | The pose diagnostic is dev-only, so a device regression in production would not be caught by it.                                                          | Low      | The geometric fallback is preserved, the agreement gates remain, and the mocked matrix suite covers the nine interpretation cases.                                                         | Periodic re-running of the device matrix on new hardware.                                       |
| 9   | `_journal.json` remains frozen at 52 entries while 180+ migrations exist on disk.                                                                         | Low      | Documented; `migrate.mjs` does not read it for new migrations; the adoption guard protects an unledgered production database.                                                              | Out of scope here — see the migration-state investigation note.                                 |
| 10  | Two zero-byte test files were red on `main` for an unknown period without anyone noticing.                                                                | Low      | Both now carry real suites.                                                                                                                                                                | A CI rule that fails on a `.test.ts` with no test — not added here, as it is beyond this scope. |

---

## 14. Final production-readiness matrix

Legend: **Ready** — implemented, tested, and needing no external
evidence. **Ready pending validation** — implemented and tested; a named
external validation gates the claim. **Not ready** — do not rely on it.

| Area                                                       | Status                       | Gate                                     |
| ---------------------------------------------------------- | ---------------------------- | ---------------------------------------- |
| Deployment isolation (preview cannot migrate production)   | **Ready**                    | Operator action 1                        |
| Runtime data-path guard                                    | **Ready**                    | Operator action 1                        |
| Episode lifecycle: open, close, record why                 | **Ready**                    | —                                        |
| Episode constraint validation                              | **Ready**                    | Operator action 14 (off the deploy path) |
| Lifecycle flag cutover workflow                            | **Ready**                    | Per tenant: checklist 9                  |
| `due_at_authoritative` **enabled**                         | **Not ready** per tenant     | Checklist 9 for that tenant              |
| `ship_evidence_required` **enabled**                       | **Not ready** per tenant     | Checklist 1 + 9 for that tenant          |
| PacWare shipment import (code)                             | **Ready**                    | —                                        |
| PacWare shipment import (live file)                        | **Ready pending validation** | Checklist 1                              |
| Shipment evidence → date of service                        | **Ready**                    | —                                        |
| Manufacturer connectors (code, error handling, resilience) | **Ready**                    | —                                        |
| Manufacturer connectors (live)                             | **Not ready**                | Checklist 2–4                            |
| Portal reconciliation                                      | **Ready pending validation** | Checklist 2–4                            |
| Fitter measurement + recommendation                        | **Ready**                    | —                                        |
| Fitter pose convention on real devices                     | **Not ready**                | Checklist 5                              |
| Voice tenant attribution (logic)                           | **Ready**                    | —                                        |
| Voice inbound on real DIDs                                 | **Not ready**                | Checklist 6–7                            |
| SMS tenant attribution                                     | **Ready**                    | —                                        |
| Human-approval queues                                      | **Ready**                    | —                                        |
| Order-to-cash pipeline (code)                              | **Ready**                    | —                                        |
| Clearinghouse round trip                                   | **Not ready**                | Checklist 8                              |
| Order-outcome reporting                                    | **Ready**                    | —                                        |
| Lifecycle monitoring + alerting                            | **Ready**                    | Operator actions 13 (tuning)             |
| Tenant isolation                                           | **Ready**                    | —                                        |
| PHI handling                                               | **Ready**                    | —                                        |
| Documentation and runbooks                                 | **Ready**                    | —                                        |

**Overall: NOT production validated.** The code is ready to be
validated. Nine external validations stand between this state and a
truthful "production validated" claim, and none of them can be performed
from inside this repository.
