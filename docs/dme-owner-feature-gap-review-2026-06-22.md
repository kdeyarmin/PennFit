# DME-Owner Feature & Function Gap Review — 2026-06-22

**Audience:** Penn Home Medical Supply ownership + engineering.
**Question:** _"What feature/function gaps remain that would be necessary or
favorable for this type of software to the DME owner?"_
**Method:** Code-verified inventory of the current `main` (**migration 0464**,
~220 admin routes, ~76 worker jobs) across the four owner lenses, via four
parallel domain scans **followed by direct code verification of every
candidate gap**. Nothing is listed as a gap unless it was grep-confirmed
absent (or confirmed merely flag-dormant). Cited as `path` / `migration`.

> This is the successor to
> [`dme-owner-feature-gap-review-2026-06-21.md`](./dme-owner-feature-gap-review-2026-06-21.md).
> That review's entire backlog — all the Wave-1 items **and all three
> "strategic builds"** (referral-source CRM, provider RTM dashboard,
> per-location billing identity) — has since **shipped and merged**. This
> re-scan is against the materially more complete platform that resulted.

---

## Headline

**The platform got materially more complete since 2026-06-21** (migrations
`0431 → 0464`). Closed in that window, verified in code:

- **Inventory reservation / oversell guard** — `0434`/`0454`,
  `lib/inventory/reservations.ts`, `worker/jobs/inventory-reservation-sweep.ts`.
  Stock is now **held at checkout time** via a `reserve_inventory()` RPC
  serialized by a `pg_advisory_xact_lock` per `(org, sku)`, consumed on paid /
  released on expiry. The concurrent-checkout race the 06-21 PR explicitly
  deferred is **closed**.
- **Patient dunning / collections engine** — `0461`/`0462`,
  `worker/jobs/dunning-engine.ts` (open-scan + tick), `collections-worklist.ts`.
- **Claim ADR / audit-response packets** — `0460`, `routes/admin/claim-adr.ts`,
  `worker/jobs/adr-sla-sweep.ts`.
- **Per-location billing identity** — `0450`, **wired into the 837P builder**
  (see the false-positive note below).
- **Referral CRM Phase 3 — automated 90-day adherence report to the referring
  provider** — `0451`/`0452`/`0455`, `worker/jobs/referral-adherence-report.ts`.
- **Slack ops integration** (`0457`–`0459`), **server-side LTV/CAC + resupply
  KPI RPCs** (`0436`/`0437`), **patient access log** (`0456`), **DaVinci PAS
  per-payer credentials** (`0453`), **prior-auth auto-submit** (`0433`).

**Two findings dominate, and neither is "build more":**

1. **The biggest remaining lever is activation, not engineering.** A large set
   of high-value revenue/denial/collections programs are fully built and
   fail-soft but ship behind **seeded-OFF** feature flags + opt-in crons (the
   full list is in _Activation state_ below). Turning them on is a
   consent/staffing decision in System Configuration, not a build.
2. **Naive "what's missing" scans still over-state gaps — badly.** This re-scan
   ran four domain agents; **three of their headline "gaps" were false** on
   direct code verification (documented below). The genuinely-open list is
   short, and most of it is either deliberate non-goals or minor polish.

---

## Verification catches — candidate "gaps" that are NOT gaps

Listed first, on purpose: each was surfaced by a scan and **rejected** after
reading the code. They are exactly the rebuilds an owner must not fund.

| Claimed gap                                                                      | Verdict                     | Evidence that refutes it                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Multi-location billing identity is schema-only; claims still bill at org level" | **FALSE — fully wired**     | `resolveBillingIdentity({ locationId })` (`lib/billing/identity-resolver.ts:216-270`) loads the location row and overlays `billing_legal_name` / `billing_tax_id` / `billing_ptan` / `billing_address_*`, per-field-falling-back to the org. The 837P builder calls it at `lib/billing/office-ally-batch.ts:352,737,1011,1158` ("a branch with no billing NPI falls back to org"). |
| "No inventory reconciliation / no audit trail of count-vs-system delta"          | **FALSE — workflow exists** | `routes/admin/inventory-reconciliation.ts` + `inventory_reconciliations` / `inventory_reconciliation_lines` (migration 0143) persist `system_count` / `counted_qty` / `variance` per line behind an atomic `submit_inventory_reconciliation` RPC, with audit rows. It is operator-driven (a monthly physical count) **by design**, not absent.                                     |
| "Newsletter is capture-only; nothing ever sends"                                 | **FALSE (refined)**         | `worker/jobs/demo-drip.ts` runs a 3-stage nurture drip to `newsletter_subscribers` where `source='breathe-demo'` (gated by `RESUPPLY_DEMO_DRIP_ENABLED`). What's genuinely absent is a _general_ broadcast/campaign tool (see Lens A).                                                                                                                                             |

---

## Gap map — by the four owner lenses

Status legend: **OPEN** (grep-confirmed absent) · **PARTIAL** (built, loop not
closed) · **DORMANT** (built, off by seeded flag/cron — an activation
decision) · **DONE** (for contrast / "don't rebuild").

### Lens A — Recurring resupply revenue

| Capability                                                                                        | Status           | Evidence                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storefront **self-serve membership** join flow                                                    | **OPEN**         | `shop_customers.membership_tier` is **CSR-set only** (`routes/admin/shop-membership.ts`); the webhook reconciles cancel/renewal (`membership-reconcile.ts`) but there is **no `/shop` buy flow** to purchase a membership tier. Verified: no membership checkout route under `routes/shop/` or `routes/storefront/`. The biggest genuinely-OPEN recurring-revenue item. |
| Post-purchase **review-request automation**                                                       | **OPEN (minor)** | `routes/admin/shop-review-requests.ts` + `lib/messaging/review-request-email.ts` exist, but dispatch is **manual** — no schedule in `worker/index.ts` (grep: no review-request cron). Win-back, cart-abandonment, lapsed-customer all have crons; reviews don't.                                                                                                        |
| General **newsletter / broadcast campaign** tool                                                  | **OPEN (minor)** | Only the demo-lead drip auto-sends (above). No surface to compose + send a one-off campaign to the `newsletter_subscribers` list.                                                                                                                                                                                                                                       |
| Resupply-due → draft order (auto-staging)                                                         | **DORMANT**      | `resupply.auto_order_drafts` seeded OFF (0391); full flow + daily worker shipped.                                                                                                                                                                                                                                                                                       |
| Voice escalation tier                                                                             | **DORMANT**      | `reminder_escalation.voice` seeded OFF (0395).                                                                                                                                                                                                                                                                                                                          |
| Payment-plan auto-charge                                                                          | **DORMANT**      | `billing.payment_plan_autocharge` seeded OFF (0255) + env cron.                                                                                                                                                                                                                                                                                                         |
| Subscribe & Save, autopay setup, win-back, reminders, signed-link YES/EDIT/STOP, cart-abandonment | **DONE**         | self-service subscription manage (`routes/shop/my-subscriptions.ts`), `lapsed-customer-winback.ts`, `reminders.ts` + escalation ladder.                                                                                                                                                                                                                                 |

### Lens B — Denials & faster cash

**Essentially complete — no genuinely-absent capability at 0464.** 837P
build/submit/batch, 270/271 eligibility, 276/277 status, 835/ERA auto-post,
AI denial analysis + appeals, secondary/COB, DaVinci PAS (+ auto-submit),
**ADR audit packets**, Stripe disputes, collections-forecast, **patient
dunning** are all built with routes + worker automation + flag controls.

| Residual item                                                                           | Status                  | Evidence                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appeal **outcome** auto-update                                                          | **PARTIAL (by design)** | `claim_appeal_letters.outcome` / `responded_at` (0428) are operator-set; there is no standard EDI message for an appeal decision, so a human records it.                                                              |
| `extractAdrFromFax` auto-parse                                                          | **PARTIAL**             | imported in `routes/admin/claim-adr.ts` but not called — ADR intake is manual entry (deliberate: RAC/CERT/TPE letter formats vary). Low value to wire.                                                                |
| Auto-submit claims / secondary / prior-auth / eligibility-refresh / dunning / ADR queue | **DORMANT**             | flags `billing.auto_submit_claims` (0215), `billing.auto_secondary_claims`, `billing.auto_submit_prior_auths` (0433), `collections.dunning` (0461), `billing.adr_queue` (0460) all seeded OFF. Activation, not build. |

### Lens C — Fulfillment & inventory operations

| Capability                                                                                                                                                                                          | Status                         | Evidence                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Supplier purchasing / procurement** (POs, reorder points, lead time, spend)                                                                                                                       | **OPEN (deliberate non-goal)** | grep for procurement/purchase-order/supplier/reorder/`po_` across `artifacts/` + migrations → **no matches**. Replenishment is manual (low-stock alert → ops contacts supplier → edits Stripe `stock_count`). Note: the warehouse is **intentionally 3PL/provider-owned** (CLAUDE.md), so this is a documented non-goal, not an oversight. |
| **Lot / serial tracking**                                                                                                                                                                           | **OPEN**                       | no lot/serial/batch columns or routes. Consumables (masks/filters) rarely need it; durable goods (machines) could for warranty/recall.                                                                                                                                                                                                     |
| **Returns / RMA** auto-restock + reverse logistics                                                                                                                                                  | **PARTIAL**                    | `routes/admin/shop-returns.ts` lists + emails status, but return-to-inventory is manual and there's no reverse-shipping label / refund-on-receipt orchestration.                                                                                                                                                                           |
| Inventory reservation / oversell guard, carrier-tracking ingest, backorder auto-clear + substitution, low-stock alerts, POD upload, fulfillment tracking, PacWare CSV, **inventory reconciliation** | **DONE**                       | see Headline + Verification-catches.                                                                                                                                                                                                                                                                                                       |

### Lens D — Growth, referral, provider, multi-location

| Capability                                                                                                                                                                                                                                     | Status                | Evidence                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-location OPERATIONS** beyond billing (per-location inventory allocation, order routing, stock transfer)                                                                                                                                | **PARTIAL / DORMANT** | `multi_location.enabled` seeded OFF (0257). Billing identity per location is wired (above); but the inventory ledger is per-`(org, sku)` with **no location dimension**, and there's no order-routing/transfer logic. Only relevant if a tenant runs multiple branches. |
| Provider **sleep-study upload** (provider-submitted EDF/structured study → `ahi`)                                                                                                                                                              | **OPEN (minor)**      | `patient_therapy_nights.ahi` is populated from device syncs and shown in the RTM detail; no provider upload path.                                                                                                                                                       |
| Referral-source CRM (scorecard + rep log), **automated adherence report to referrer**, referral attribution + review, **provider RTM dashboard** (roster/detail/attestation PDF), e-sign portal, LTV/CAC + KPI RPCs, Slack, patient access log | **DONE**              | `routes/admin/referral-sources.ts`, `worker/jobs/referral-adherence-report.ts`, `routes/provider/rtm.ts` + SPA, `0436`/`0437`, `0457`-`0459`, `0456`.                                                                                                                   |

### Lens E — Clinical / adherence (supporting)

Real-time (vs nightly-batch) clinical alerting is **absent**, but batch +
event-swept Slack/digest alerting is the appropriate design for this workload
— **not** a recommended build.

---

## Activation state — the real ROI lever

Built, fail-soft, and **seeded OFF** (flip in System Configuration once the
consent/staffing/vendor-config prerequisite is met):

| Flag / env                                                             | Program                                 | Prerequisite to turn on                            |
| ---------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| `resupply.auto_order_drafts` (0391)                                    | daily auto-staged resupply drafts       | CSR review-queue staffing                          |
| `reminder_escalation.voice` (0395)                                     | voice tier in the reminder ladder       | TCPA posture + voice creds                         |
| `billing.auto_submit_claims` (0215) + cron                             | unattended 837P submit                  | biller comfort + eligibility on file               |
| `billing.auto_secondary_claims`                                        | auto-draft secondary/COB                | —                                                  |
| `billing.auto_submit_prior_auths` (0433) + cron                        | unattended DaVinci PAS                  | per-payer PAS credentials (0453)                   |
| `collections.dunning` (0461) + crons                                   | patient dunning ladder                  | statement consent + dunning policy sign-off        |
| `billing.adr_queue` (0460)                                             | ADR worklist + SLA sweep                | audit-response staffing                            |
| `referrals.adherence_report` (0451) + cron                             | 90-day adherence report to referrer     | referrer fax/email verified + delivery domain auth |
| `billing.payment_plan_autocharge` (0255) + cron                        | installment auto-charge                 | card-on-file authorization flow                    |
| `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED`, `RESUPPLY_DEMO_DRIP_ENABLED` | cart-abandonment + demo-lead drip crons | CAN-SPAM / sender domain auth                      |

---

## Prioritized recommendation

1. **Activation pass** on the dormant programs above — by far the highest ROI,
   zero engineering. Pick the 2-3 with cleared prerequisites (likely
   `resupply.auto_order_drafts`, `collections.dunning`, `referrals.adherence_report`).
2. **Storefront self-serve membership join** (Lens A) — the one genuinely-OPEN
   recurring-revenue _feature_. A `/shop` buy flow for the cash-pay tier that
   creates the Stripe subscription and sets `membership_tier` (the webhook
   already reconciles cancel/renewal). Small, additive, real revenue.
3. **Review-request cron** (Lens A) — trivial: schedule the existing
   `send-due` dispatcher in `worker/index.ts` behind an env/flag, mirroring
   cart-abandonment.
4. **Returns/RMA polish** (Lens C) — auto-restock on carrier "returned to
   warehouse" + a reverse-shipping-label step.
5. **Strategic, only if the business calls for it:** multi-location operations
   (per-location inventory + order routing) when a second branch opens;
   supplier procurement only if the warehouse moves in-house (today it's a
   deliberate 3PL non-goal).

---

## Implemented in this PR

The three buildable genuinely-open gaps were closed here (additive, fail-soft,
tested; no schema change). The deliberate non-goals (supplier procurement,
multi-location operations) were left as-is.

- **Storefront self-serve membership join** (Lens A) —
  `GET /shop/membership/options` + `POST /shop/membership/checkout` create a
  Stripe subscription Checkout for a tier; the `customer.subscription.*`
  webhook (`joinMembershipFromSubscription`) sets `membership_tier` once
  active. Gated by `STRIPE_MEMBERSHIP_{MONTHLY,QUARTERLY}_PRICE_ID` (unset →
  unavailable, prior behaviour). Storefront `MembershipSection` on `/account`.
- **Review-request cron** (Lens A) — `review-request.scan` worker (hourly :23,
  env `RESUPPLY_REVIEW_REQUEST_CRON_ENABLED=1`) running the same shared
  dispatcher as the admin "Send due" button.
- **Returns/RMA restock** (Lens C) — `mark-received` gained an opt-in
  `restock: true` that adds the returned order's quantities back to tracked
  `stock_count` (default off — most DME consumables aren't resaleable).

---

## Appendix — "already shipped, do NOT rebuild" (verified 2026-06-22)

Paperwork (ABN/AOB/POD/CMN/DWO/e-sign), full RCM/EDI (270/271, 276/277, 837P,
835/ERA, 999, DaVinci PAS, secondary/COB, denials + appeals, **ADR packets**,
**dunning**, disputes), payments (Stripe checkout + Connect, autopay, plans,
statements), resupply/comms (Medicare-cadence reminders, signed-link
YES/EDIT/STOP, inbound SMS/IVR, bulk campaigns, omnichannel inbox, 3-vendor
AI, sleep coach, on-device mask fitter, win-back, **inventory reservations**),
growth/provider (**referral-source CRM + adherence report**, **provider RTM
dashboard**, e-sign portal, **per-location billing identity**, Slack),
analytics (**LTV/CAC**, **resupply KPI**, margin/COGS, AR aging, funnel,
**patient access log**).

---

_Verified against `main` @ migration 0464. Three scan-surfaced "gaps" were
rejected on code verification (see Verification catches) — the discipline that
keeps this list honest._
