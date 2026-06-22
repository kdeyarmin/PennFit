# Remaining Gaps — What's Left to Address (2026-06-22)

**Purpose.** The four gap reviews under `docs/` (May–June 2026) catalogued a
large set of "gaps." Most have since shipped — in particular **PR #1200**
(`DME-owner feature-gap review + RCM/fulfillment improvements`, commit
`1259c2d7`) merged the bulk of the 2026-06-21 review into `main`. This
document is the **trustworthy residual to-do list**: only the items that are
still genuinely open after verifying each against current `main`. When one of
these ships, update this file rather than the older reviews.

**Source reviews (now largely historical):**
[`competitive-gap-analysis-2026-05-19.md`](./competitive-gap-analysis-2026-05-19.md),
[`feature-gaps-analysis-2026-06-14.md`](./feature-gaps-analysis-2026-06-14.md),
[`backlog-reconciliation-2026-06-18.md`](./backlog-reconciliation-2026-06-18.md),
[`dme-owner-feature-gap-review-2026-06-21.md`](./dme-owner-feature-gap-review-2026-06-21.md).

---

## Shipped since the reviews — do NOT re-open

Verified present on `main`, mostly via PR #1200. Listed so nobody funds a
rebuild:

- **Batch claim creation from fulfillments**, **backorder auto-clear on
  restock**, **stock-decrement oversell guard** (no migration each).
- **Appeals lifecycle** — `responded_at` / `outcome` + aging
  (migration `0428_claim_appeal_outcome.sql`).
- **Stripe dispute persistence** — `stripe_disputes` table + webhook wiring
  (migration `0429_stripe_disputes.sql`; route
  `routes/admin/billing-disputes.ts`).
- **`partially_paid` claim status** through the state machine + ERA
  reconciler (migration `0430_insurance_claims_partially_paid_status.sql`).
- **Carrier tracking webhook ingest** — `routes/webhooks/carrier-tracking.ts`
  (HMAC-signed EasyPost/Shippo, rate-limited).
- **Membership ↔ Stripe reconciliation** — downgrades a lapsed sub to `payg`.
- **Referral-source CRM** (migration `0431_referral_source_crm.sql`) — backend
  **and** the admin SPA (`pages/admin/admin-referral-sources.tsx` +
  `lib/admin/referral-sources-api.ts`), further along than the 06-21 doc
  claimed.
- **Resupply-due → draft order** — `worker/jobs/resupply-auto-draft.ts` +
  `routes/admin/resupply-order-drafts.ts`, flag-gated (`resupply.auto_order_drafts`,
  migration 0391). This is an **activation** decision, not an open build.

---

## 1. Activation decisions (owner's call — ~0 engineering)

The single highest-ROI action across every review. These levers are **built,
fail-open, and seeded OFF**; flipping each is a consent/staffing decision the
**owner** makes in `/admin/control-center`, not an engineering task. (Confirm
live state there — production may already differ from the seeded default.)

| Lever                                               | Flag                                                      | Why it's off           | Impact                                          |
| --------------------------------------------------- | --------------------------------------------------------- | ---------------------- | ----------------------------------------------- |
| Entitlement enforcement (too-soon / over-cap block) | `resupply.entitlement_enforcement` (seed OFF, 0172)       | adds a CSR review step | **Denial prevention — biggest unflipped lever** |
| Eligibility enforcement (dead-coverage block)       | `resupply.eligibility_enforcement` (seed OFF, 0185)       | adds a CSR review step | Denial prevention                               |
| Continued-use (adherence) check                     | `resupply.usage_compliance_check` (seed OFF, 0300)        | adds a CSR review step | Audit-exposed denial prevention                 |
| Patient autopay                                     | `billing.patient_autopay` (seed OFF, 0260) + cron         | consent / saved-card   | Collections                                     |
| Payment-plan autocharge                             | `billing.payment_plan_autocharge` (seed OFF, 0255) + cron | consent                | Collections                                     |
| Voice escalation tier (AI check-in call)            | `reminder_escalation.voice` (seed OFF, 0395)              | patient contact        | Connection rate                                 |
| Cart-abandonment recurring cron                     | `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED` (env, off)       | consent                | Cash-pay recovery                               |
| Review-request automation                           | _(no cron yet — dispatcher + button only)_                | needs a cron           | Reviews / SEO                                   |

> The revenue / CSR-cost levers (auto-reminder enrollment, cart-abandonment
> dispatcher, email auto-reply, claim auto-submit) are **already ON** per the
> 0325 seed — don't re-flag them.

---

## 2. UI loose ends from the backend-first PR #1200 (small, low-risk)

PR #1200 landed some capabilities backend-first. The data is captured but
operators can't see or act on it yet:

- **Stripe disputes have no admin surface.** `routes/admin/billing-disputes.ts`
  exposes a read endpoint (`GET`, `requirePermission("reports.read")`) but **no
  SPA page consumes it** (no `stripe_disputes` reference under
  `artifacts/cpap-fitter/src`). A missed dispute = a missed deadline = lost
  revenue, which is the whole point of persisting them. Build an
  `/admin/billing/disputes` page. _Effort: S (1–2d)._
- **Appeals outcome / mark-delivered have no UI control.** The `0428` columns
  and the `mark-delivered` / `outcome` transitions exist server-side, but the
  denials/appeals SPA (`pages/admin/admin-billing-denials*.tsx`) doesn't yet
  let a CSR record an appeal's delivery or outcome — so win-rate stays
  unmeasurable in the UI. Wire the controls into the existing denials surface.
  _Effort: S (1–2d)._

---

## 3. Partial engineering items (loop not closed)

- **Prior-auth automation is manual-only.** Da Vinci PAS submit is a manual
  click (`routes/admin/davinci-pas-submit.ts`); **no worker or auto-engine
  invokes `submitPasBundle`** (grep-confirmed none under `worker/`). PA-required
  items wait on a human. Add an opt-in pass (mirroring the auto-submit posture)
  that front-loads PAs. Also note the per-payer token still lives in process env
  (`DAVINCI_PAS_TOKEN_<PAYER_SLUG>`), not `clearinghouse_credentials` — a
  multi-tenant tail. _Effort: M (3–5d)._
- **Inventory reservation / oversell under concurrency.** PR #1200 added a
  stock-**decrement** guard, but there is still **no `inventory_reservations`
  table** (no such migration) — stock remains `shop_products.metadata.stock_count`
  (Stripe, point-in-time), so concurrent cash-pay checkouts can still race.
  _Effort: M (3–5d)._
- **Secondary / COB** — effectively end-to-end with both `billing.auto_secondary_claims`
  and `billing.auto_submit_claims` ON; residual gap is a secondary needing
  primary-EOB / COB completeness to clear preflight. Verify, don't rebuild.

---

## 4. Performance / correctness hygiene (carried forward, still open)

- **JS-side aggregation caps.** 13 `.limit(20000/50000)`-then-aggregate-in-JS
  sites remain across `routes/admin/` (`analytics.ts`, `billing-director.ts`,
  `ltv-cac.ts`, `payer-profitability.ts`, `billing-collections-forecast.ts`,
  `billing-benchmarks.ts`, `mask-fit-worklist.ts`, `voice-metrics.ts`,
  `staffing-live.ts`). Silent truncation past the cap; push into SQL RPCs.
  _Effort: S–M._
- **`count:'exact'` on hot dashboards.** ~100+ across admin files vs a handful
  of `'estimated'`; switch where the exact total isn't user-visible
  (`inbox-counts.ts`, `ops-status.ts`, `billing-director.ts`). _Effort: S._

---

## 5. Test-coverage gaps (carried forward)

- No tests on `routes/admin/patient-packets.ts` (~1.5k LOC, state machine +
  token substitution + multi-channel delivery).
- No tests on `routes/admin/provider-esign.ts` (~1.1k LOC, e-signature).
- No tests on `routes/patients/insurance-claims-ai.ts` (~969 LOC, Claude spend
  - error paths).
- No checkout / fitter→order e2e happy-path.
- 4 soft-gated CI jobs (`integration` / `a11y` / `e2e-dev` / `e2e-admin`) are
  `continue-on-error: true` — promote to required once green.

---

## 6. Strategic builds (L — need owner direction, not quick wins)

These are the **growth ceiling**, not near-term profit levers. Each has a build
sketch in the 06-21 review; don't start without an explicit business trigger.

- **Multi-location — per-branch billing identity** (the hard requirement: each
  branch bills under its own NPI/PTAN). `resupply.locations` (0235) +
  `multi_location.enabled` (0257) are a UI/grouping shell only; the flag never
  touches claims. Extend `lib/billing/identity-resolver.ts` to prefer a
  location-level identity. _Phase 1 is the only piece a multi-branch owner needs
  first._
- **Provider-facing RTM dashboard** — the portal is e-sign only
  (`routes/provider/portal.ts`); referring providers can't see how their
  patients are doing on therapy. Reuses the MFA-gated portal shell +
  `patient-therapy-snapshot.ts`. (Thread `req.orgId` — the portal currently
  resolves the seed org.)
- **Supplier purchasing / procurement** — no PO-to-distributor, reorder points,
  lot/serial. Buy-side loop absent (warehouse pick/pack is intentionally
  3PL-owned; per-branch stock is out of scope by architecture Rule 14).
- **Multi-tenant tail (S–M)** — finish the narrow seed-org callsites: davinci-pas
  Bearer-token namespace and the object-storage helpers (resolve seed org rather
  than caller org).

---

## Suggested order

1. **Activation pass** (§1) — owner decision, ~0 engineering, highest ROI.
2. **UI loose ends** (§2) — disputes page + appeals outcome controls; finishes
   what PR #1200 started backend-first.
3. **Perf hygiene** (§4) — fast, low-risk latency wins on hot admin views.
4. **Prior-auth automation + inventory reservation** (§3) — the real PARTIAL
   builds.
5. **Tests** (§5), then promote the soft-gated CI jobs.
6. **Strategic L-builds** (§6) — only on a concrete second-location / referral /
   resale trigger.

_Verified against `main` after PR #1200 (`1259c2d7`)._
