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

---

## Snapshot at start of plan (2026-05-20)

| Signal                                 | 5/8     | 5/13    | **5/20**    | Direction       |
| -------------------------------------- | ------- | ------- | ----------- | --------------- |
| SQL files vs `_journal.json` entries   | 119 / 51 (Δ 68) | 120 / 52 (Δ 68) | **148 / 52 (Δ 96)** | **Worse**       |
| `patient-detail.tsx` LOC               | 3,948   | 4,522   | **4,556**   | Worse           |
| `account.tsx` LOC                      | 1,918   | 2,069   | **2,148**   | Worse           |
| `patients.tsx` LOC                     | 1,694   | 1,694   | **1,694**   | Stable          |
| `shop-product-detail.tsx` LOC          | 1,480   | 1,488   | **1,488**   | Stable          |
| Admin routes using `requirePermission` | —       | 7 / 108 | (carry)     | Carry from 5/13 |
| E2E specs                              | 2       | 2       | **2**       | Stable          |

The migration-journal gap widened by 28 files in the seven days since
the last review. The single load-bearing item for the first phase is
unchanged: **stop the bleeding on the drift gap and on file growth.**

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
   [Working agreements](#working-agreements) below.
4. **Build on existing infra.** Reuse `withMetrics()`, `requestContext`,
   `logAuditBestEffort`, `csrfHeader()`, `attachSignedIn`,
   `checkLoginRateLimit`. Don't introduce new patterns when an
   existing one fits.
5. **Plan-only doc.** This file does not modify code. The PRs land
   per phase below.

---

## Phase 1 — Stop the bleeding (1 week, ~3 PRs)

**Goal:** Address the two compounding hazards (migration drift, HIGH
HTTP-timeout gap) and the single-PR S-effort security fixes from the
5/13 review. After this phase, no production incident should be
attributable to an item already on the backlog.

### PR 1.1 — Integration HTTP timeouts + atomic recovery-code consumption (S, P0)

Per N1 + N2 in [`docs/app-review-2026-05-13.md`](./app-review-2026-05-13.md#new-findings-2026-05-08--2026-05-13).

- Add `withTimeout(ms)` helper in `lib/resupply-integrations/src/http.ts`
  using `AbortSignal.timeout()`.
- Pipe `signal:` through all four integration clients
  (`react-health`, `airview`, `care-orchestrator`, `health-connect`).
  Default: 30s OAuth, 60s API GETs; per-call override allowed.
- Replace the two-step recovery-code SELECT-then-UPDATE in
  `artifacts/resupply-api/src/lib/auth-deps.ts:205-244` with an
  atomic `UPDATE … WHERE id=$1 AND used_at IS NULL RETURNING id`.
  Treat zero rows as "already spent → fail."
- Tests: timeout helper (fake timers), recovery-code race (two
  concurrent calls → exactly one wins).

**Exit criteria:** Both packages have no bare `fetch()` and a vitest
suite green; one MFA recovery-code can only be consumed once.

### PR 1.2 — Migration drift reconciliation (M, P0)

Per P0.1 + P0.2 in 5/13 review and
[`migration-drift-status-2026-05-13.md`](./migration-drift-status-2026-05-13.md).

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
  the gating event.)
- Add `pnpm migrate:dry-run` script that diffs disk vs journal and
  exits non-zero on mismatch — same logic the CI step runs.

**Exit criteria:** `scripts/check-drizzle-drift.sh` exits 0; the CI
check is mandatory (not `continue-on-error`).

### PR 1.3 — Per-document HIPAA retention audit rows (S, P0)

Per N3 in 5/13 review.

- After the batch UPDATE in
  `artifacts/resupply-api/src/worker/jobs/patient-documents-retention-sweep.ts:100-115`,
  emit one `logAuditBestEffort` row per flagged document (cap at
  the existing defensive 5k/batch limit).
- Event tag: `patient-documents.retention-sweep.flagged`,
  actor: `system:retention-sweep`, subject: `patient_documents.id`,
  metadata: `{ retention_until_at }`.
- Test: stub `logAuditBestEffort`, run sweep with 3 flagged rows,
  assert 3 calls with the expected shape.

**Exit criteria:** A SELECT on `resupply.audit_log` for
`event = 'patient-documents.retention-sweep.flagged'` returns one row
per flagged document.

---

## Phase 2 — Security hardening (1–2 weeks, ~4 PRs)

**Goal:** Close the open security items so the platform passes
external pen-test review without compensating controls. All items are
existing P0/P1 backlog.

### PR 2.1 — Unified admin rate-limit middleware (M, P0.7)

- Land `adminRateLimit(actorIdGetter, { window, max })` in
  `artifacts/resupply-api/src/middlewares/`. Re-export the existing
  `csr-compliance-alerts.ts` limiter shape so call-sites stay tiny.
- Wire it on the 12 already-protected routes (no behavior change),
  then sweep the remaining ~89 admin route files in batches of ~15
  per follow-up commit.
- Per-route presets in `middlewares/admin-rate-limits.ts`:
  `scan` (high read), `mutate` (POST/PATCH/DELETE), `bulk`
  (campaign/export endpoints).
- Add an architecture-check rule (`scripts/check-resupply-architecture.sh`)
  that fails CI if a route under `routes/admin/` does not mount
  `adminRateLimit`.

**Exit criteria:** Every admin route is rate-limited; the arch
check enforces it.

### PR 2.2 — RBAC Phase B: `requirePermission` catalog (S–M, N4)

- Define the permission catalog in
  `lib/resupply-domain/src/permissions.ts` as a `const` union:
  `<area>.<action>` (e.g., `billing.write`, `loss-claims.read`,
  `recall.remediate`, `coaching-plan.author`).
- Audit the ~25 new admin routes from the recent feature wave
  (loss-claims, telehealth, provider portal, POD, coaching plans,
  recall remediation, mask-leak wizard, accreditation attestations).
  Replace `requireAdmin` with `requirePermission(...)`.
- Add a startup assertion in `artifacts/resupply-api/src/app.ts`:
  every route under `/admin` must call `requirePermission` OR
  carry a code comment `// requireAdmin: full-admin gating justified
  because …`. Boot fails fast on violation.
- Add an admin "Roles & permissions" page (read-only first) under
  `/admin/team/roles` to surface what each role can do.

**Exit criteria:** `requireAdmin`-only admin routes count drops from
101 → near-zero with the remaining ones explicitly justified.

### PR 2.3 — Storefront CSRF on state-changing endpoints (M, P1.3)

- Land a `csrfMiddleware` (or extend the existing
  `attachSignedIn`) that enforces a same-origin token on POST/PATCH/
  DELETE under `/shop/*`, `/api/me/*`, `/shop/me-payments/*`,
  `/shop/me-claims/*`.
- Storefront SPA already exposes `csrfHeader()` via
  `artifacts/cpap-fitter/src/lib/shop-api.ts` (P2.13 fix). Add the
  header on every mutating fetch; confirm the 6 existing call-sites
  pick it up automatically.
- Tests: unit test that POST `/shop/orders` without the header
  returns 403; with the header succeeds.

**Exit criteria:** Cross-origin mutating request to `/shop/*` returns
403 without a valid token.

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

## Quick reference — phase totals

| Phase | Theme                          | Duration   | PRs | Risk | Blocks                                  |
| ----- | ------------------------------ | ---------- | --- | ---- | --------------------------------------- |
| 1     | Stop the bleeding              | 1 week     | 3   | Low  | Production deploys (drift)              |
| 2     | Security hardening             | 1–2 weeks  | 4   | Med  | External pen-test, RBAC promise         |
| 3     | Reliability & observability    | 1–2 weeks  | 3   | Low  | Incident response time                  |
| 4     | Code structure & DB integrity  | 2 weeks    | 4   | Med  | Feature velocity on patient-detail      |
| 5     | UX, a11y, perf polish          | 2 weeks    | 5   | Low  | Customer NPS, accreditation review      |
| 6     | DX, docs, coverage             | 1 week     | 3   | Low  | Cost of the next polish wave            |

**Total:** ~9 weeks, ~22 PRs. Phases 1–3 are the production-critical
spine; phases 4–6 are leverage investments that pay back in the next
quarter's velocity.

---

## Cross-references

- [`docs/app-review-2026-05-13.md`](./app-review-2026-05-13.md) — status of the 5/8 plan + 5 new findings.
- [`docs/codebase-enhancements-2026-05-08.md`](./codebase-enhancements-2026-05-08.md) — original P0–P3 catalog.
- [`docs/migration-drift-status-2026-05-13.md`](./migration-drift-status-2026-05-13.md) — Phase 1 PR 1.2 prework.
- [`docs/migration-state-investigation-2026-05-08.md`](./migration-state-investigation-2026-05-08.md) — production-state inspection method.
- [`docs/PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md) — deploy checklist (Phase 2 PR 2.4 cross-links).
- [`CLAUDE.md`](../CLAUDE.md) — hard rules and conventions referenced in working agreements.
