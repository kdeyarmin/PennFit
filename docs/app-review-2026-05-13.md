# PennFit App Review — 2026-05-13

**Branch:** `claude/review-app-improvements-ZxJaH`
**Scope:** Refresh of [`docs/codebase-enhancements-2026-05-08.md`](./codebase-enhancements-2026-05-08.md)
against the current tree (~20 feature commits since 5/8) + survey of new
code introduced by the feature wave for fresh issues. No code changes —
recommendations only.

This doc is a status delta on the 5/8 plan plus 5 new findings, framed
so it can drop into the existing P0–P3 backlog.

---

## TL;DR

- **Of the 7 P0 items from 5/8:** 4 fixed, 2 still open, 1 partial.
  Migration-journal drift (P0.1/P0.2) has _gotten worse_ — the SQL→journal
  gap widened from 21 files to 68 in 5 days, and the `ci.yml` drift check
  is currently `continue-on-error: true`, masking the failure.
- **Of the 12 P1 items:** 3 fixed (worker DLQ, fax callback Zod, external-
  API retries / idempotency), 9 still open.
- **P2 SPA decomposition has regressed.** `patient-detail.tsx` grew +574
  LOC, `account.tsx` grew +151 LOC. The feature wave is out-pacing the
  cleanup.
- **5 new issues** introduced by the recent commits (1 HIGH, 3 MEDIUM,
  1 LOW). The HIGH is missing HTTP timeouts on the four new therapy-
  cloud integration clients.
- **Top single PR by leverage:** integration `withTimeout()` helper +
  atomic MFA recovery-code consumption. Both S-effort; together they
  unblock the HIGH (timeouts) and one MEDIUM (recovery-code TOCTOU).
  Migration drift cleanup (P0.1/P0.2) is the next-highest leverage
  but is M-effort and needs coordination with open PRs.

---

## Status of the 2026-05-08 plan

### P0 — schema-deploy + loudest security

| ID   | Item                                                                  | Status                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0.1 | Drizzle journal drift                                                 | **OPEN — WORSE.** `_journal.json` still has 51 entries; `lib/resupply-db/drizzle/*.sql` now has 119 files (was 73 on 5/8). The new `.github/workflows/ci.yml:97` runs `scripts/check-drizzle-drift.sh` but with `continue-on-error: true`, so PRs don't fail.                                                                                                                                          |
| P0.2 | Six duplicate migration prefixes (0016, 0017, 0049, 0050, 0052, 0065) | **OPEN.** `ls lib/resupply-db/drizzle/*.sql \| awk -F_ '{print $1}' \| sort \| uniq -d` still returns all six.                                                                                                                                                                                                                                                                                         |
| P0.3 | CI workflow                                                           | **FIXED.** `.github/workflows/ci.yml` exists with `pnpm typecheck`, `pnpm lint:resupply`, codegen + architecture + migration-pair drift checks. (The drizzle-drift step is the one carve-out — see P0.1.)                                                                                                                                                                                              |
| P0.5 | Stripe webhook raw-body regression test                               | **FIXED.** `artifacts/resupply-api/src/app-stripe-webhook-ordering.test.ts:66` asserts `Buffer.isBuffer(req.body)`.                                                                                                                                                                                                                                                                                    |
| P0.6 | Auth-recovery rate limits                                             | **FIXED.** All three routes wire `checkLoginRateLimit`: `forgot-password.ts:61`, `reset-password.ts:54`, `verify-email.ts:46`. _(Correction 2026-05-13: an earlier draft of this doc claimed `forgot-password` and `reset-password` were missing the call; spot-checking the actual files showed the calls were present. The sub-agent that surfaced the original claim had read past the call site.)_ |
| P0.7 | Admin write per-actor rate-limits                                     | **PARTIAL.** 12 admin route files now have ad-hoc limiters (e.g., `routes/admin/csr-compliance-alerts.ts:37,44` defines `adminScanLimiter` + `adminCreateLimiter` keyed by `req.adminUserId`). The remaining ~89 admin route files are unprotected. No unified `adminRateLimit` middleware exists in `middlewares/`.                                                                                   |
| P0.8 | Duplicate router registrations in `routes/index.ts`                   | **FIXED.** Current file (427 LOC) mounts each router exactly once.                                                                                                                                                                                                                                                                                                                                     |

### P1 — reliability + DB integrity

| ID    | Item                                                        | Status                                                                                                                                                                   |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1.1  | Order create + facial-measurement mirror transaction        | **OPEN.** `routes/storefront/orders.ts:97–198` still does sequential awaits across insert → `ensureShopCustomerRow` → mirror update with no `db.transaction()` wrapping. |
| P1.2  | Worker DLQ / job-failure alerting                           | **FIXED.** `src/worker/index.ts:138–150` subscribes to `boss.on("monitor-states")`, tracks per-queue `lastFailedCounts`, emits structured warn on delta.                 |
| P1.3  | CSRF on storefront state-changing endpoints                 | **OPEN.** `routes/storefront/orders.ts:43` is still `attachSignedIn`-only; no CSRF middleware. Cookie-auth + cross-origin still possible.                                |
| P1.4  | Fax status callback body cast                               | **FIXED.** `routes/fax/status-callback.ts:80–86` defines `faxStatusCallbackBody` Zod schema; `:110` `safeParse(req.body ?? {})`.                                         |
| P1.5  | Session cookie config central test                          | Not re-validated; carry forward.                                                                                                                                         |
| P1.6  | `STRIPE_SESSION_RE` length cap                              | Not re-validated; carry forward.                                                                                                                                         |
| P1.7  | External API retries (Stripe / SendGrid / Twilio)           | **FIXED.** `withMetrics()` wrapper landed; idempotency keys added on Stripe `checkout.sessions.create` and `refund.create` call-sites.                                   |
| P1.8  | `writeAudit` silent-catch alerting                          | Not re-validated; carry forward.                                                                                                                                         |
| P1.9  | Reminder job invalid-date propagation                       | Not re-validated; carry forward.                                                                                                                                         |
| P1.10 | `shop_orders.customer_id` foreign key                       | **OPEN.** `lib/resupply-db/src/schema/shop-orders.ts` `customer_id` still bare `text()`, no `.references()`.                                                             |
| P1.11 | Audit other Stripe mutation call-sites for idempotency keys | Partially closed by P1.7; remainder carry forward.                                                                                                                       |
| P1.12 | Audit-log retention / redaction policy                      | Open question — carry forward.                                                                                                                                           |

### P2 — code quality / perf / UX

| ID                 | Item                                                      | Status                                                                                                                                                 |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2.1               | `patient-detail.tsx` decomposition                        | **OPEN — WORSE.** 3,948 LOC → 4,522 LOC (+574). Every feature in this wave (recall remediation, mask-leak wizard, coaching plans) added more sections. |
| P2.2               | `account.tsx` decomposition                               | **OPEN — WORSE.** 1,918 → 2,069 LOC (+151).                                                                                                            |
| P2.3               | `patients.tsx` decomposition                              | **STABLE.** Unchanged at 1,694 LOC.                                                                                                                    |
| P2.4               | `shop-product-detail.tsx`                                 | **STABLE-ISH.** 1,480 → 1,488 LOC (+8).                                                                                                                |
| P2.6               | `maskCatalog.ts` → DB                                     | **OPEN.** Still 1,589 LOC of TS data in `artifacts/resupply-api/src/data/maskCatalog.ts`.                                                              |
| P2.7 / P2.8 / P2.9 | Naming / response-shape / shared types                    | Not re-validated; carry forward.                                                                                                                       |
| P2.10              | `shop_orders` composite index `(status, created_at desc)` | **OPEN.** `lib/resupply-db/src/schema/shop-orders.ts` has 0 `.index()` calls.                                                                          |
| P2.11              | Chatbot knowledge cache TTL                               | Not re-validated; carry forward.                                                                                                                       |
| P2.12              | Bundle visualizer / chunk budgets                         | **OPEN.** `artifacts/cpap-fitter/vite.config.ts` has no `rollup-plugin-visualizer` and no `build.chunkSizeWarningLimit`.                               |
| P2.13              | `getCsrfToken()` consolidation                            | **FIXED.** `artifacts/cpap-fitter/src/lib/shop-api.ts` now exposes `csrfHeader()` helper; 6 inline calls collapsed to 1.                               |
| P2.14–P2.21        | UX/a11y/DB carryover                                      | Not individually re-validated; carry forward.                                                                                                          |

### P3 — DX / observability / docs

| ID        | Item                                    | Status                                                                                                          |
| --------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| P3.1      | cpap-fitter ESLint enforcement          | Carry forward.                                                                                                  |
| P3.7      | Request-ID / correlation-ID propagation | **FIXED.** `artifacts/resupply-api/src/app.ts:138–184` wires `pino-http genReqId` + `requestContextMiddleware`. |
| P3.12     | Worker-recovery runbook                 | **FIXED.** `docs/runbooks/worker-recovery.md` shipped.                                                          |
| P3.15     | ADRs                                    | **FIXED (partial).** `docs/adr/` populated with at least the in-process worker and single-From-address ADRs.    |
| P3.others | DX / docs / bundle budgets / Lighthouse | Carry forward.                                                                                                  |

---

## New findings (2026-05-08 → 2026-05-13)

All five were introduced by code committed in the feature wave and
verified directly against the current tree (not just inferred from agent
summaries).

### N1 · HIGH — Therapy-cloud integration clients have no HTTP timeouts

**Files:** `lib/resupply-integrations-react-health/src/client.ts:57,83`,
`lib/resupply-integrations-airview/src/client.ts:54,88`,
`lib/resupply-integrations-care-orchestrator/src/client.ts` (same shape),
plus `lib/resupply-integrations-health-connect/`.

Each of the four new integration clients issues bare `fetch()` calls for
both OAuth token acquisition and downstream API requests with no
`AbortController` / `signal` option. There is no timeout configured at
the global `fetch` layer either. A slow or hanging upstream (3B Medical,
ResMed AirView, Philips Care Orchestrator) will stall the calling
worker / request indefinitely.

**Why it matters here specifically:** the `resupply-api` artifact serves
both the customer-facing storefront and the admin SPA from the same
Node process that also runs the in-process `pg-boss` worker (per the
May 2026 consolidation). A long-tail upstream stall on a therapy-cloud
fetch consumes one of the event-loop's pending I/O slots and degrades
unrelated requests.

**Fix sketch:** Add a single shared `withTimeout(ms)` helper exported from
`lib/resupply-integrations/src/http.ts` (which already exists as the
shared package) and pipe `signal: AbortSignal.timeout(ms)` into every
`fetch()` call across the four packages. Default ~30 s for OAuth, ~60 s
for API GETs, configurable per call. **Effort: S.**

---

### N2 · MEDIUM — MFA recovery-code consumption is non-atomic (TOCTOU)

**Files:** `lib/resupply-auth/src/http/verify-sign-in-mfa.ts:225,263`,
implementation at `artifacts/resupply-api/src/lib/auth-deps.ts:205–244`.

The recovery-code flow is two separate Supabase calls:

1. `findRecoveryCodeMatch` — `SELECT id FROM admin_mfa_recovery_codes
WHERE staff_user_id = $1 AND code_hash = $2 AND used_at IS NULL`.
2. `markRecoveryCodeUsed` — `UPDATE admin_mfa_recovery_codes SET used_at
= now() WHERE id = $1`.

These are not in a transaction and don't use compare-and-set. Two
concurrent submissions of the same valid recovery code can both pass the
SELECT (used_at still NULL) and then both run the UPDATE — the code is
spent twice. The contract at `lib/resupply-auth/src/http/types.ts:224–236`
acknowledges that `markRecoveryCodeUsed` write failures are intentionally
swallowed (DB-blip recovery), but the contract claim that
"`findRecoveryCodeMatch` already gates on `used_at IS NULL`" is only true
serially, not under concurrent submission.

**Threat surface:** small — an attacker would need (a) a valid unused
recovery code, and (b) the ability to submit two MFA-verify requests
within the SELECT-UPDATE window (typically <100 ms over the same
Supabase REST round-trips). But this _is_ a defense-in-depth gap on a
single-use credential.

**Fix sketch:** Replace `markRecoveryCodeUsed` with an atomic
`UPDATE … SET used_at = now(), used_ip = $2 WHERE id = $1 AND used_at IS
NULL RETURNING id`. Treat zero rows returned as "already spent → fail
the sign-in." Same call replaces both steps. **Effort: S.**

---

### N3 · MEDIUM — HIPAA retention sweep doesn't write per-document audit rows

**File:** `artifacts/resupply-api/src/worker/jobs/patient-documents-retention-sweep.ts:100–115`.

The sweep flags eligible documents by stamping `retention_marked_at =
now()` on the `patient_documents` row, then exits. It only emits an
aggregate `logger.info` count (`patient-documents.retention-sweep.completed`)
— there is **no per-document `logAudit` row** capturing what was flagged
and why.

The flagged-at timestamp persists on the document row itself, so there
is _some_ trail. But for HIPAA accreditation reviews the expected artifact
is a queryable audit-log entry per document (or per sweep batch with
document IDs in metadata). The current shape requires reconstructing
flagging history by joining `patient_documents` against historical
backups — surveyors will ask for it as a single SELECT against
`audit_logs`.

**Fix sketch:** After the batch UPDATE returns `flaggedRows`, emit a
single `logAudit({ event: "patient-documents.retention-sweep.flagged",
actor: "system:retention-sweep", subjects: flaggedRows.map(r => r.id),
metadata: { count, retention_until_at } })` row. Optionally one row per
document if compliance prefers single-subject audit entries (cheap — a
nightly sweep is bounded to 5k rows by the existing defensive cap at
line 97). **Effort: S.**

---

### N4 · MEDIUM — RBAC Phase A is partial; most admin routes still use `requireAdmin`

**Evidence:** `grep -rln "requirePermission" artifacts/resupply-api/src/routes/admin/`
returns 7 files; `requireAdmin` is used in 101 admin route files.
Concrete example: `routes/admin/shop-order-loss-claims.ts:48,89,154`
gates GET / POST / PATCH with `requireAdmin` only — no permission check.

The RBAC Phase A wave introduced `requirePermission(perm)` as the
intended gate, but only the seven files below currently use it:
`accreditation-policies.ts`, `csr-compliance-alerts.ts`, `analytics.ts`,
`conversation-coaching-notes.ts`, `patient-documents-retention.ts`,
`shop-returns.ts`, `productivity.ts`. The rest of the new wave (loss-
claims, telehealth, provider portal, POD, coaching plans, recall
remediation, mask-leak wizard, accreditation attestations, etc.) still
defaults to "any admin can do anything." This defeats the wave's stated
goal of granular roles.

**Fix sketch:** (a) Define the permission catalog explicitly — every
new admin feature gets a `<area>.<action>` permission. (b) Audit the
~25 new admin routes from the feature wave and gate each on the
appropriate permission. (c) Add a startup assertion: every admin
route must call `requirePermission` _or_ explicitly opt-out with
`requireAdmin` + a code comment justifying full-admin gating.
**Effort: S–M.**

---

### N5 · LOW — MFA enforcement mode is env-var-only with no audit trail

**File:** `artifacts/resupply-api/src/routes/admin/mfa.ts:58–61`.

`getEnforcementMode()` reads `AUTH_REQUIRE_MFA_FOR_ADMINS` from the
environment at request time. There is no admin UI to flip the toggle and
no audit row capturing _when_ MFA enforcement changed. Acceptable as a
deploy-time-only setting, but undocumented in any of the ADRs added
during this wave — surveyors will ask "when did you turn MFA on for
admins?" and "who has the env-var access?"

**Fix sketch:** Either (a) add a one-page ADR
(`docs/adr/0007-mfa-enforcement-env-only.md`) stating the env-only
posture, the reason (deploy-time policy, not runtime), and the audit
trail (deploy logs / Replit secrets history), or (b) add an admin route
that flips the setting and writes an audit row. **Effort: S (doc)
or M (route).**

---

## Trend concern — SPA decomposition regressed under the feature wave

| File                             | 5/8 LOC | 5/13 LOC | Δ        |
| -------------------------------- | ------- | -------- | -------- |
| `pages/admin/patient-detail.tsx` | 3,948   | 4,522    | **+574** |
| `pages/account.tsx`              | 1,918   | 2,069    | +151     |
| `pages/admin/patients.tsx`       | 1,694   | 1,694    | 0        |
| `pages/shop-product-detail.tsx`  | 1,480   | 1,488    | +8       |

`patient-detail.tsx` at 4,522 LOC in a single file is the largest
velocity tax in the SPA. The features in this wave (recall remediation,
mask-leak wizard, coaching plans, alert→plan, triage UI) added more tab
sections rather than extracting siblings. Suggest a working agreement:
no new top-level tab in `patient-detail.tsx` lands without extracting
its content into a sibling component file. Pair with a single
introductory PR that extracts one existing tab (the "Overview" tab is
the natural first) to set the pattern.

---

## Recommended next two waves (top 10 items by leverage)

| #   | ID          | Why                                                                                              | Effort |
| --- | ----------- | ------------------------------------------------------------------------------------------------ | ------ |
| 1   | N1          | HIGH severity; single helper unblocks all 4 integration packages. Prevents worker thread stalls. | S      |
| 2   | P0.1 + P0.2 | Migration drift gap widening; deploy-hazard compounds with every new SQL file.                   | M      |
| 3   | P0.7        | Land a single `adminRateLimit(actorId)` middleware; apply incrementally per router.              | M      |
| 4   | N4          | Audit the new admin routes against `requirePermission`; codify the permission catalog.           | S–M    |
| 5   | N2          | Atomic compare-and-set on MFA recovery-code consumption — one query instead of two.              | S      |
| 6   | N3          | Pre-destruction audit row in HIPAA sweep — single `logAudit` call after the batch UPDATE.        | S      |
| 7   | P1.1        | Wrap order create + mirror in `db.transaction()`.                                                | S      |
| 8   | P1.3        | Apply CSRF middleware to storefront state-changing endpoints.                                    | M      |
| 9   | P2.1 slice  | Extract one tab from `patient-detail.tsx` to set the precedent and stop the growth.              | S      |

Items 1 and 5 are S-effort and unblock the loudest production
risks (timeouts, abuse, defense-in-depth on single-use credentials). A
natural single PR opens the next wave.

---

## Verification of findings in this doc

| Finding                            | How verified                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File LOC growth (P2.1, P2.2, P2.4) | `wc -l` on the four SPA files.                                                                                                                                                                                                                            |
| Migration drift (P0.1)             | Count of `_journal.json` entries (51) vs `lib/resupply-db/drizzle/*.sql` files (119).                                                                                                                                                                     |
| Auth-recovery rate-limits (P0.6)   | `grep -n "checkLoginRateLimit" lib/resupply-auth/src/http/{forgot-password,reset-password,verify-email}.ts` — call appears in **all three** at lines 61, 54, 46 respectively. (P0.6 is FIXED; an earlier draft of this doc incorrectly reported PARTIAL.) |
| Admin RBAC sparsity (N4)           | `grep -rln "requirePermission" artifacts/resupply-api/src/routes/admin/` → 7 files; `requireAdmin` → 101 files. Loss-claim file inspected directly.                                                                                                       |
| N1 — missing timeouts              | `grep -n "fetch\|AbortController\|signal"` on the four integration `client.ts` files returns only the bare `fetch()` lines.                                                                                                                               |
| N2 — recovery-code TOCTOU          | Direct read of `auth-deps.ts:205–244` confirms SELECT then UPDATE without atomicity; contract docstring at `lib/resupply-auth/src/http/types.ts:224–236` acknowledges the serial-only assumption.                                                         |
| N3 — no per-document audit         | Direct read of `patient-documents-retention-sweep.ts:100–115` — the only post-flag emission is `logger.info` with aggregate counts; no `logAudit` import in the file.                                                                                     |
| N5 — env-var-only MFA enforcement  | Direct read of `routes/admin/mfa.ts:58–61` — `getEnforcementMode` reads `process.env.AUTH_REQUIRE_MFA_FOR_ADMINS` with no admin-route surface.                                                                                                            |

P1/P2/P3 status entries marked "FIXED" without an explicit citation
above were verified by a separate Explore pass over the same files; the
specific evidence is in this branch's planning notes if a reviewer wants
to re-walk it.

---

## Out of scope

- No code changes in this branch — implementation is left for the team's
  normal backlog. The 5/8 plan + this refresh are the source of items.
- No `prettier --write` sweep on existing files.
- E2E test additions, coverage thresholds, and bundle-size budgets are
  carryover items (P2.12, P3.2–P3.4); status not re-validated here.
- This refresh does _not_ re-audit the codebase from scratch. Items
  not in the 5/8 plan and not introduced by the recent feature wave
  were not surveyed.
