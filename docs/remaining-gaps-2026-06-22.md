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
- **Chargeback disputes admin page** (this branch) — `/admin/billing/disputes`
  (`pages/admin/admin-billing-disputes.tsx` + `lib/admin/billing-disputes-api.ts`),
  the missing UI for the `0429` backend. Open/all worklist ordered by evidence
  deadline, with an approaching/overdue deadline highlighted. Closes §2's
  first bullet.

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

## 2. UI loose ends from the backend-first PR #1200

PR #1200 landed some capabilities backend-first. The data is captured but
operators can't see or act on it yet:

- ✅ **Stripe disputes admin surface — DONE (this branch).** Built
  `/admin/billing/disputes` (`admin-billing-disputes.tsx` +
  `billing-disputes-api.ts`); see "Shipped" above.
- ✅ **Appeal-letter workbench — DONE (this branch).** There had been no
  appeal-letter UI in the SPA at all (the whole flow was backend-only in
  `routes/admin/claim-appeals.ts`). Built `components/admin/ClaimAppealsSection.tsx`
  - `lib/admin/claim-appeals-api.ts`, rendered in the claim drawer
    (`admin-insurance-claims.tsx`) for denied/appealed claims: generate the letter
    PDF, fax to the payer (auto-transitions denied → appealed), record an
    out-of-band mail/email/portal delivery, and record the payer outcome
    (overturned/partial/upheld/withdrawn) so win-rate + response aging are
    measurable.

---

## 3. Partial engineering items (loop not closed)

- ✅ **Prior-auth automation — DONE (this branch).** Extracted the inline PAS
  submit handler into `lib/billing/submit-prior-auth.ts` (`submitPriorAuth()`,
  behaviour byte-for-byte preserved incl. the SSRF guard + DNS-pin + payer
  identifier-binding); the route is now a thin wrapper. Added the flag-gated
  worker `worker/jobs/prior-auth-auto-submit.ts` (two off switches:
  `PRIOR_AUTH_AUTOSUBMIT_CRON` env + `billing.auto_submit_prior_auths` flag,
  seeded OFF in migration 0433). **Note:** CodeQL's `js/request-forgery`
  heuristic flags the relocated PAS-endpoint fetch as a "new" alert; the
  mitigation is fully intact (it mirrors the original route, which carried the
  same already-dismissed FP), so it is dismissed in Security → Code scanning per
  the repo's documented default-setup convention. The per-payer token still
  lives in process env (`DAVINCI_PAS_TOKEN_<PAYER_SLUG>`), not
  `clearinghouse_credentials` — a multi-tenant tail left open.
- **Inventory reservation / oversell under concurrency — own PR.** PR #1200
  added a stock-**decrement** guard, but there is still **no
  `inventory_reservations` table** (no such migration) — stock remains
  `shop_products.metadata.stock_count` (Stripe, point-in-time), so concurrent
  cash-pay checkouts can still race. This is the one **checkout-path,
  concurrency-sensitive** build, so it is being done as its **own focused PR**
  (atomic advisory-lock reserve RPC + fail-open checkout wiring + consume/release
  on the Stripe webhook + an expiry sweep job + the checkout-test updates).
  _Effort: M (3–5d)._
- **Secondary / COB** — effectively end-to-end with both `billing.auto_secondary_claims`
  and `billing.auto_submit_claims` ON; residual gap is a secondary needing
  primary-EOB / COB completeness to clear preflight. Verify, don't rebuild.

---

## 4. Performance / correctness hygiene (carried forward, still open)

- **JS-side aggregation caps.** Several `.limit(20000/50000)`-then-aggregate-in-JS
  sites remain across `routes/admin/` (`analytics.ts`, `billing-director.ts`,
  and related). Silent truncation past PostgREST `max_rows` (~1000). Prefer
  SQL RPCs or newest-first paging + `windowTruncated`. **Shipped /
  mitigated:** `ltv-cac` + `resupply-kpis` RPCs (#1209); `billing-benchmarks`
  / `voice-metrics` / `mask-fit-worklist` keyset or range paging;
  `staffing-live` (#1350); collections-forecast + forward-order-book (#1351);
  `payer-profitability` (#1352); aging-report + dso-by-payer (#1353);
  `rt-outcomes` (#1354); `business-targets` metrics*daily (#1355);
  `mask-catalog` formulary/availability/pending-review + detail reviews
  (this branch). \_Effort: S–M for residual sites.*
- **`count:'exact'` on hot dashboards.** ~100+ across admin files vs a handful
  of `'estimated'`. **Caveat (verified this branch):** this is **not** a safe
  blanket change. The `inbox-counts.ts` calls are **user-visible nav badges**
  over small, selectively-filtered sets — PostgREST `'estimated'` returns the
  planner's whole-table estimate, so it would show wrong badge numbers. `exact`
  is correct (and cheap) there. Only switch counts that are **not** user-visible
  and run over large unbounded sets; treat each callsite individually rather
  than sweeping the file. _Effort: S, but per-callsite._

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

## 7. Follow-up wave (this session) — PRs #1208–#1212 + new gaps

After PR #1207 merged the §2 disputes/appeals + §3 prior-auth work, the rest of
the implementable backlog shipped as draft PRs (each self-verified, hard-rules-
clean, migration bands kept distinct):

| PR    | Item                                                                      | Migrations |
| ----- | ------------------------------------------------------------------------- | ---------- |
| #1208 | §3 inventory reservation / oversell guard (atomic RPC, fail-open)         | 0434       |
| #1209 | §4 perf hygiene — `ltv-cac` + `resupply-kpis` aggregations → SQL RPCs     | 0436/0437  |
| #1210 | §6 multi-location billing identity (Phase 1)                              | 0450       |
| #1211 | §6 provider RTM dashboard (Phase 1)                                       | none       |
| #1212 | §5 test coverage (patient-packets / provider-esign / insurance-claims-ai) | none       |

**New gaps surfaced while building the above** (not in the original review):

- **Unattended crons are seed-org-only.** The new prior-auth auto-submit worker
  (#1207) — like the existing claims auto-submit cron — runs against the seed
  org via `resolveSeedOrgId`, so non-seed tenants get no unattended PA
  submission. Generalize the unattended crons to fan over all active tenants
  (`forEachActiveOrg`, which the #1208 reservation sweep already uses — a good
  template). _Effort: M._
- **`DAVINCI_PAS_TOKEN_<PAYER_SLUG>` is still process-env**, not
  `clearinghouse_credentials` — a multi-tenant tail that matters more now that a
  worker transmits unattended. (Already noted under §6; restated here for the
  automation context.)
- **CodeQL `js/request-forgery` recurs on any relocated outbound fetch** (it
  tripped on the prior-auth extraction, mitigation intact). Worth a permanent
  baseline/dismissal note so future PRs don't re-trip the merge gate.

**Small additions folded in alongside this update:**

- **Appeals letter prefill** — the appeals workbench (#1207) opens a blank
  textarea even though the denial analyzer already produced an
  `appeal_letter_sketch`; prefill it (and link `denial_analysis_id`).
- **Catalog net-of-holds** (on #1208) — `/shop/products` projects raw Stripe
  `stock_count`; subtract live reservations so the catalog doesn't advertise
  held-out units as in stock.
- **Provider portal `orgId` threading** (on #1211) — the new RTM routes thread
  `req.orgId`, but the legacy e-sign routes in `portal.ts` still resolve the
  seed org; apply the same threading so the whole portal is tenant-correct.

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
