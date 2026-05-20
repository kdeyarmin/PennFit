# PennFit Phased Polish Plan — 2026-05-20

**Branch:** `claude/polish-features-plan-fu33D`
**Scope:** Sequence the open backlog from
[`docs/app-review-2026-05-13.md`](./app-review-2026-05-13.md) (which
itself builds on
[`docs/codebase-enhancements-2026-05-08.md`](./codebase-enhancements-2026-05-08.md))
into PR-sized waves, and layer in storefront/admin UX polish,
accessibility, perf, and test-coverage themes that are not yet tracked.

Source-of-truth for individual findings stays in the review docs; this
file is the **operational rollout strategy**. Every line item below
cites the canonical finding so reviewers can drill in.

> **Revision (2026-05-20, same-day):** the initial draft of this plan
> built on `docs/app-review-2026-05-13.md` without re-verifying every
> finding against the tree. A spot-check found several items already
> shipped (PR #204 closed both halves of original Phase 1 PR 1.1; the
> HIPAA per-doc audit and storefront CSRF have also landed; the
> admin-rate-limit middleware exists; `requirePermission` jumped from
> 7 → 78 admin routes). The phase list below has been re-keyed to the
> _genuinely open_ work as of this revision. The shipped items are
> retained in the [Already-shipped log](#already-shipped-log) at the
> bottom for traceability.

---

## Snapshot at start of plan (2026-05-20, post-verification)

| Signal                                 | 5/8     | 5/13    | **5/20**    | Direction       |
| -------------------------------------- | ------- | ------- | ----------- | --------------- |
| SQL files vs `_journal.json` entries   | 119 / 51 (Δ 68) | 120 / 52 (Δ 68) | **148 / 52 (Δ 96)** | **Worse**       |
| `patient-detail.tsx` LOC               | 3,948   | 4,522   | **4,556**   | Worse           |
| `account.tsx` LOC                      | 1,918   | 2,069   | **2,148**   | Worse           |
| `patients.tsx` LOC                     | 1,694   | 1,694   | **1,694**   | Stable          |
| `shop-product-detail.tsx` LOC          | 1,480   | 1,488   | **1,488**   | Stable          |
| Admin routes using `requirePermission` | —       | 7 / 108 | **78 / 126** | **Better**     |
| Admin routes wired to `adminRateLimit` middleware | — | — (middleware didn't exist) | **19 / 126** | New (middleware shipped; sweep open) |
| Integration clients with `AbortSignal.timeout()` | — | 0 / 4 (per 5/13) | **3 / 3** (health-connect has no fetch) | **Fixed** |
| Atomic MFA recovery-code consumption   | No      | No      | **Yes** (`auth-deps.ts:275`) | **Fixed** |
| HIPAA retention sweep audit rows       | No      | No      | **Yes** (`patient-documents-retention-sweep.ts:129`) | **Fixed** |
| Storefront CSRF on `/shop/orders`      | No      | No      | **Yes** (`routes/storefront/orders.ts:43`) | **Fixed** |
| E2E specs                              | 2       | 2       | **2**       | Stable          |

The migration-journal gap widened by 28 files in the seven days since
the last review. With Phase 1's S-effort security items already shipped
(by an unrelated PR wave), **the new single load-bearing item for the
first phase is migration-drift reconciliation** (P0.1/P0.2).

---

## Governing principles

1. **Each phase = a deployable slice.** No phase carries a half-merged
   intermediate state into the next. If a phase is partial, the items
   that did land must be safe to ship as-is.
2. **Effort before scope.** Sequence S-effort fixes that unblock HIGH-
   severity items ahead of M-effort fixes that touch many files. The
   first PR of every phase should be the smallest one in that phase.
3. **No new tech debt in flight.** Every PR in this plan carries a
   working agreement: don't grow `patient-detail.tsx`, don't add a new
   bare `fetch()` in an integration client, don't add an admin route
   without `requirePermission`. These are listed in
   [Working agreements](`#working-agreements-active-during-all-phases`) below.
4. **Build on existing infra.** Reuse `withMetrics()`, `requestContext`,
   `logAuditBestEffort`, `csrfHeader()`, `attachSignedIn`,
   `checkLoginRateLimit`. Don't introduce new patterns when an
   existing one fits.
5. **Plan-only doc.** This file does not modify code. The PRs land
   per phase below.

---

## Phase 1 — Stop the bleeding (1 week, 1 PR)

**Goal:** Address the one remaining compounding hazard (migration
drift). The S-effort security items originally bundled here have all
shipped (see [Already-shipped log](#already-shipped-log)).

### PR 1.2 — Migration drift reconciliation (M, P0) — **only Phase 1 item**

Per P0.1 + P0.2 in 5/13 review and
[`migration-drift-status-2026-05-13.md`](./migration-drift-status-2026-05-13.md).
**Gap widened to Δ 96 files between 5/13 and 5/20** — the longer this
waits, the bigger the reconciliation surface.

- Inspect production `drizzle.resupply_migrations` history table; build
  a mapping of applied tags → on-disk SQL files. (Requires read access;
  coordinate with the deploy-side operator before opening the PR.)
- Backfill `_journal.json` with the 96 missing entries _in applied
  order_. Do not change SQL contents.
- Resolve the 6 duplicate prefixes (0016, 0017, 0049, 0050, 0052,
  0065) by renaming the **unapplied** member of each pair to the next
  free prefix; record the rename in the journal as a no-op tag rewrite.
- Flip `ci.yml` drift check from `continue-on-error: true` → `false`
  in the **same PR** that reconciles. (Don't flip earlier; flip is
  the gating event.) **Note (5/20):** `ci.yml` no longer references
  `check-drizzle-drift.sh` — the carve-out may already be retired.
  Verify before opening the PR; if the step is gone, this work
  reduces to the journal backfill + duplicate-prefix rename.
- Add `pnpm migrate:dry-run` script that diffs disk vs journal and
  exits non-zero on mismatch — same logic the CI step runs.

**Exit criteria:** `scripts/check-drizzle-drift.sh` (or its
replacement) exits 0; the CI check is mandatory (not
`continue-on-error`).

---

## Phase 2 — Security hardening (1–2 weeks, 3 PRs)

**Goal:** Close the open security items so the platform passes
external pen-test review without compensating controls. The CSRF item
(originally PR 2.3) has shipped; the middleware for admin rate-limits
exists but adoption is still 19/126.

### PR 2.1 — `adminRateLimit` adoption sweep (M, P0.7)

The middleware exists at
`artifacts/resupply-api/src/middlewares/admin-rate-limit.ts` with a
4-preset shape (`destroy`, `bulk`, `sensitive`, `mutation`) and a
test. **Adoption sweep is the open work.**

- Inventory: ~107 admin route files don't mount `adminRateLimit`
  (19/126 do today).
- Sweep in batches of ~15 per commit. Map each route's HTTP verbs to
  the existing preset:
  - `destroy` for DELETE on PHI / financial rows.
  - `bulk` for POST that fan out (campaigns, mass scans, exports).
  - `sensitive` for role/permission/template mutations.
  - `mutation` for standard POST/PATCH writes.
- Add an architecture-check rule
  (`scripts/check-resupply-architecture.sh`) that fails CI if a
  route under `routes/admin/` defines a POST/PATCH/DELETE handler
  without mounting `adminRateLimit`. Read-only routes (GET) are
  exempt.

**Exit criteria:** Every mutating admin route is rate-limited; the
arch check enforces it on new PRs.

### PR 2.2 — RBAC `requirePermission` sweep + permission catalog (S–M, N4)

`requirePermission` is now in 78/126 admin route files (up from 7 on
5/13). 48 remain on bare `requireAdmin`. The remaining sweep:

- Define the permission catalog in
  `lib/resupply-domain/src/permissions.ts` as a `const` union if it
  doesn't already exist there (it may be inline today — verify and
  centralize). Naming: `<area>.<action>` (e.g., `billing.write`,
  `loss-claims.read`, `recall.remediate`, `coaching-plan.author`).
- Audit each of the 48 remaining `requireAdmin`-only admin routes and
  replace with `requirePermission(...)` OR add a code comment
  `// requireAdmin: full-admin gating justified because …`.
- Add a startup assertion in `artifacts/resupply-api/src/app.ts`:
  every route under `/admin` must call `requirePermission` OR carry
  the justification comment. Boot fails fast on violation.
- Add a read-only admin "Roles & permissions" page under
  `/admin/team/roles` that surfaces what each role can do.

**Exit criteria:** `requireAdmin`-only admin routes count drops from
48 → near-zero with remainders explicitly justified.

### PR 2.4 — MFA enforcement ADR + audit row (S, N5)

- Either write `docs/adr/0007-mfa-enforcement-env-only.md`
  documenting the env-only posture, or add an admin route + audit
  trail. Recommend (a) — current posture is appropriate; doc-only
  is cheaper.
- If (a): cross-link the ADR from `docs/PRODUCTION_READINESS.md`
  and from the admin operations page.

**Exit criteria:** Surveyor question "when did MFA enforcement
change?" has a one-link answer.

---

## Phase 3 — Reliability & observability (1–2 weeks, ~3 PRs)

**Goal:** Eliminate the remaining P1 reliability gaps; instrument
the parts we can't see yet.

### PR 3.1 — Stripe mutation idempotency sweep + session-cookie test (S, P1.5 + P1.11)

- Sweep remaining Stripe mutation call-sites for idempotency keys
  (P1.7 closed Stripe checkout + refund; carry the rest forward).
- Land a `lib/resupply-auth/src/cookies.test.ts` that asserts the
  central cookie config (`secure: true` in prod, `sameSite: 'lax'`,
  `httpOnly: true`, `path: '/'`).

**Exit criteria:** Every Stripe `create*`/`update*` call carries an
idempotency key; cookie regressions fail CI.

### PR 3.2 — `writeAudit` failure alerting + reminder date propagation (S, P1.8 + P1.9)

- Wrap `writeAudit`'s catch in a structured `logger.warn` with
  enough context to alert on (`event`, `actor`, `subject`, error
  class).
- Add a Pino metric counter `audit.write.failures.total` so the
  ops dashboard can graph it.
- For the reminder job, propagate invalid-date `Result.err` to the
  caller instead of silently no-op'ing; emit a structured warn.

**Exit criteria:** Audit-write failures and invalid-date reminder
attempts are both visible in the application log + counter.

### PR 3.3 — Bundle visualizer + chunk budgets + Lighthouse smoke (M, P2.12 + P3.x)

- Add `rollup-plugin-visualizer` to
  `artifacts/cpap-fitter/vite.config.ts`, gated to `pnpm build
  --report`.
- Set `build.chunkSizeWarningLimit: 400` (kB) and pre-split obvious
  chunks (recharts, framer-motion, jspdf) via `manualChunks`.
- Add a one-page Lighthouse CI run on the storefront homepage +
  product detail page; fail at <80 perf, <90 a11y. (One spec, runs
  in CI on PRs touching `artifacts/cpap-fitter/`.)

**Exit criteria:** `pnpm build --report` emits a `bundle-stats.html`;
Lighthouse scores baseline + fail-on-regression policy is in CI.

---

## Phase 4 — Code structure & DB integrity (2 weeks, ~4 PRs)

**Goal:** Stop the SPA-file growth and tighten the schema.

### PR 4.1 — Working agreement + first tab extract from `patient-detail.tsx` (S, P2.1)

- Add a CI check that fails if `patient-detail.tsx` exceeds 4,000
  LOC after a PR (current: 4,556; budget bites on the second PR
  after this one).
- Extract the **Overview** tab into
  `artifacts/cpap-fitter/src/pages/admin/patient-detail/overview-tab.tsx`
  as the pattern. ~400 LOC drop.
- Document the pattern in
  [`replit.md`](../replit.md) under "Admin SPA conventions."

**Exit criteria:** `patient-detail.tsx` drops to ~4,150 LOC; the
ratchet is in CI.

### PR 4.2 — `account.tsx` ratchet + first extract (S, P2.2)

Same pattern, target the largest tab. Budget: 1,800 LOC.

### PR 4.3 — `shop_orders` FK + composite index (S, P1.10 + P2.10)

- Add `customer_id` FK constraint to `auth.users(id)` (or
  `customers.id` — verify which table is canonical).
- Add `idx_shop_orders_status_created` on `(status, created_at desc)`
  to back the admin orders list query.
- Migration file follows the existing prefix convention.

**Exit criteria:** Two new SQL migrations applied; admin orders list
query plan uses the new index.

### PR 4.4 — `maskCatalog.ts` → DB-backed table (M, P2.6)

- Land `resupply.mask_catalog` table + migration.
- Seed from the existing
  `artifacts/resupply-api/src/data/maskCatalog.ts` (1,589 LOC).
- Replace the TS read in
  `lib/resupply-domain/src/mask-fit.ts` (or equivalent caller)
  with a Supabase query, cached for 1 hour.
- Delete the TS file after one deploy.

**Exit criteria:** Mask catalog is editable from `/admin/shop-products`
without a deploy.

---

## Phase 5 — UX, accessibility, performance polish (2 weeks, ~5 PRs)

**Goal:** Close the qualitative gap. Each PR is scoped to one user
surface so QA stays bounded.

### PR 5.1 — Storefront a11y sweep (M)

- Expand `e2e/tests/a11y.spec.ts` to cover `/shop`,
  `/shop-product-detail`, `/shop-cart`, `/shop-checkout-success`,
  `/account`, `/account-billing`, `/reminders`. Each page must pass
  axe at WCAG 2.1 AA.
- Fix violations as they surface — common gaps to expect:
  unlabeled icon buttons, color-contrast on muted text, missing
  `aria-live` on toast notifications, focus traps in modals.
- Add a `pnpm test:a11y` script.

**Exit criteria:** All 7 storefront pages pass axe AA in CI.

### PR 5.2 — Admin a11y sweep (M)

Same shape, target the admin SPA. Start with `/admin/dashboard`,
`/admin/patient-list`, `/admin/conversations`, then extend.

### PR 5.3 — Storefront UX polish (M)

- Loading skeletons on `/shop`, `/shop-product-detail`, `/account`.
- Empty-state copy + illustration on `/shop-orders` (no orders),
  `/account-billing` (no statements), `/reminders` (no reminders
  set yet).
- Error toast standardization — every catch in `lib/shop-api.ts`
  surfaces a single design-system `<Toast variant="error">`.
- Form validation timing: validate on blur, not on every keystroke.

**Exit criteria:** Storefront has consistent loading, empty, and
error states.

### PR 5.4 — Admin UX polish (M)

- Sticky filter bars on `/admin/patient-list`, `/admin/conversations`,
  `/admin/admin-billing-*` so they survive scroll.
- Persist column choices + sort order in URL query for shareable
  links.
- Bulk-action toolbar pattern on the list views that currently
  require row-by-row clicks.

**Exit criteria:** Top-5 admin list views (patient-list,
conversations, billing-aging, billing-denials, shop-orders) share
the same filter/sort/bulk pattern.

### PR 5.5 — Storefront + admin perf budget (S)

- Land `web-vitals` reporting from `artifacts/cpap-fitter/src/main.tsx`
  to the `/shop/usage-events` endpoint (LCP, CLS, INP).
- Add a `/admin/admin-reports/web-vitals` page that surfaces the
  rolling p50/p75/p95 from the new column on `usage_events`.

**Exit criteria:** Core Web Vitals are visible in the admin
dashboard within a week of deploy.

---

## Phase 6 — DX, docs, test coverage (1 week, ~3 PRs)

**Goal:** Make the next polish wave cheaper than this one.

### PR 6.1 — `cpap-fitter` ESLint enforcement (S, P3.1)

- Extend `pnpm lint:resupply` to fail on warnings inside
  `artifacts/cpap-fitter/src/**/*.{ts,tsx}` (it currently lints the
  files but doesn't fail on the existing warnings).
- Fix or `eslint-disable-next-line` with justification each existing
  warning. Cap PR size — split into 2 if it exceeds ~600 LOC of
  diff.

**Exit criteria:** `pnpm lint:resupply` exits 0 with
`--max-warnings 0` on the storefront.

### PR 6.2 — Test coverage thresholds + new specs (M, P3.x)

- Set per-package coverage floors in each `vitest.config.ts`:
  `lib/resupply-auth` 85%, `lib/resupply-db` 70%, route handlers
  60%. Don't raise floors above current to avoid blocking PRs.
- Add E2E specs for: sign-up + verify + order-create happy path,
  admin sign-in + MFA, refund initiated by admin.

**Exit criteria:** Coverage report in CI; 3 new E2E specs green.

### PR 6.3 — ADR backfill + runbook completeness (S, P3.15)

- Add ADRs for: (a) RBAC catalog approach (Phase 2 PR 2.2),
  (b) integration timeout policy (Phase 1 PR 1.1), (c) SPA
  decomposition LOC budget (Phase 4 PR 4.1).
- Confirm runbooks exist for: worker recovery (✅), link-HMAC
  rotation (✅), production launch (✅). Add ones for: Stripe
  refund operator, MFA reset for a locked-out admin, audit-log
  retention sweep failure.

**Exit criteria:** Each runbook has at least one referenced
ADR; on-call has a runbook for every paged alert.

---

## Working agreements (active during all phases)

1. **No new top-level tab** in `patient-detail.tsx` lands without
   extracting its content into a sibling component file. Same for
   `account.tsx`.
2. **No new bare `fetch()`** in `lib/resupply-integrations-*/src/`.
   Use the `withTimeout()` helper from Phase 1.
3. **No new admin route** without `requirePermission` (or a
   justifying comment per Phase 2 PR 2.2).
4. **No new SQL migration** without a corresponding `_journal.json`
   entry in the same PR (until Phase 1 PR 1.2 lands; the ratchet
   takes over after).
5. **No new `console.*` in `artifacts/cpap-fitter/src/`** outside
   error boundaries; use the structured logger.

---

## Out of scope (deliberate)

- **Re-architecting the in-process worker.** The ADR for in-process
  pg-boss stands; no Temporal migration is planned.
- **Replacing Drizzle/Supabase.** The data path is settled per the
  Task #37 / Supabase consolidation.
- **Password pepper, column-level encryption, third-party password
  hash.** Removed deliberately; do not re-add.
- **OpenAPI spec generation.** Task #37 retired the spec packages;
  hand-edited client types are the contract now.
- **Multiple From addresses for outbound email.** One From address
  (`info@pennpaps.com`) per CLAUDE.md.

---

## Quick reference — phase totals (post-revision)

| Phase | Theme                          | Duration   | PRs | Risk | Blocks                                  |
| ----- | ------------------------------ | ---------- | --- | ---- | --------------------------------------- |
| 1     | Stop the bleeding              | 1 week     | 1   | Med  | Production deploys (drift)              |
| 2     | Security hardening             | 1–2 weeks  | 3   | Med  | External pen-test, RBAC promise         |
| 3     | Reliability & observability    | 1–2 weeks  | 3   | Low  | Incident response time                  |
| 4     | Code structure & DB integrity  | 2 weeks    | 4   | Med  | Feature velocity on patient-detail      |
| 5     | UX, a11y, perf polish          | 2 weeks    | 5   | Low  | Customer NPS, accreditation review      |
| 6     | DX, docs, coverage             | 1 week     | 3   | Low  | Cost of the next polish wave            |

**Total:** ~9 weeks, **~19 PRs** (down from 22 in the initial draft;
3 already-shipped items removed). Phases 1–3 are the production-
critical spine; phases 4–6 are leverage investments that pay back in
the next quarter's velocity.

## Recommended starting order (post-revision)

| # | Item                                              | Effort | Why                                                                                        |
| - | ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| 1 | Phase 4 PR 4.1 (extract Overview tab from `patient-detail.tsx`) | S | The file-growth trend is the most visible code-quality regression and the simplest stop.   |
| 2 | Phase 2 PR 2.1 (`adminRateLimit` adoption sweep)  | M      | Middleware exists; sweep is mechanical batches. Closes the largest open P0 surface.        |
| 3 | Phase 2 PR 2.2 (RBAC sweep finish)                | S–M    | 48 routes left; pairs naturally with PR 2.1's batches.                                     |
| 4 | Phase 1 PR 1.2 (migration drift reconciliation)   | M      | Highest leverage but needs production DB inspection — schedule when operator is available. |

---

## Already-shipped log

Items removed from the active phases above because verification on
2026-05-20 found them already in the tree. Citations point to the
verifying evidence.

| Original phase item                       | Shipped by | Evidence                                                                                        |
| ----------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| Phase 1 PR 1.1 — integration HTTP timeouts | PR #204    | `lib/resupply-integrations-airview/src/client.ts:99-118` (`fetchWithTimeout` + env overrides). Same pattern in care-orchestrator and react-health. health-connect has no `fetch()`. |
| Phase 1 PR 1.1 — atomic MFA recovery code | PR #204    | `artifacts/resupply-api/src/lib/auth-deps.ts:275-303` (`consumeRecoveryCode` runs UPDATE with `.is("used_at", null)` in the WHERE). |
| Phase 1 PR 1.3 — HIPAA per-doc audit rows | (unconfirmed PR) | `artifacts/resupply-api/src/worker/jobs/patient-documents-retention-sweep.ts:38,123,129` (`logAuditBestEffort` imported and called per flagged batch). |
| Phase 2 PR 2.3 — storefront CSRF          | (unconfirmed PR) | `artifacts/resupply-api/src/routes/storefront/orders.ts:43` (`requireCsrfWhenSession` imported and mounted).                              |
| Phase 2 PR 2.1 (middleware only)          | (unconfirmed PR) | `artifacts/resupply-api/src/middlewares/admin-rate-limit.ts` + adjacent test exist with 4 presets. **Adoption sweep is still open** — see PR 2.1 above. |
| Phase 2 PR 2.2 (partial)                  | (in flight) | `requirePermission` jumped from 7 → 78 admin route files since 5/13. **Remaining 48-file sweep is open** — see PR 2.2 above.            |

**Lesson for future plan docs:** always run a tree spot-check against
the source-of-truth review doc before sequencing — the codebase moves
faster than the review cadence implies.

---

## Cross-references

- [`docs/app-review-2026-05-13.md`](./app-review-2026-05-13.md) — status of the 5/8 plan + 5 new findings.
- [`docs/codebase-enhancements-2026-05-08.md`](./codebase-enhancements-2026-05-08.md) — original P0–P3 catalog.
- [`docs/migration-drift-status-2026-05-13.md`](./migration-drift-status-2026-05-13.md) — Phase 1 PR 1.2 prework.
- [`docs/migration-state-investigation-2026-05-08.md`](./migration-state-investigation-2026-05-08.md) — production-state inspection method.
- [`docs/PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md) — deploy checklist (Phase 2 PR 2.4 cross-links).
- [`CLAUDE.md`](../CLAUDE.md) — hard rules and conventions referenced in working agreements.
