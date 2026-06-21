# DME-Owner Feature & Function Gap Review — 2026-06-21

**Audience:** Penn Home Medical Supply ownership + engineering.
**Question asked:** _"Perform a comprehensive review and identify any feature
or function gaps that would be necessary or favorable for this type of software
to the DME owners."_
**Method:** Full code-verified inventory of the admin console (~170 admin
routes / ~145 pages), the billing/RCM + EDI stack, the resupply engine + ~70
worker jobs, the patient storefront/portal, and the integrations layer — then
**direct code verification of every candidate gap** before listing it. Cited as
`path` / `migration` evidence. Benchmarked against current DME-resupply
practice (Brightree ReSupply, WellSky/S3, NikoHealth) and the VGM Total Sleep
Services bureau model.

> This review is deliberately **additive** to the recent reviews — it does not
> re-derive them. See [`feature-gaps-analysis-2026-06-14.md`](./feature-gaps-analysis-2026-06-14.md)
> (built-but-dormant levers), [`backlog-reconciliation-2026-06-18.md`](./backlog-reconciliation-2026-06-18.md)
> (DONE/OPEN ledger), and [`complete-domain-review-2026-06-20.md`](./complete-domain-review-2026-06-20.md)
> (correctness/bug audit, mostly fixed). This doc is the **owner-facing feature
> gap map**, not a bug audit.

---

## Headline

**CareMetric Breathe is not short on features.** By any DME-resupply benchmark
it is one of the most complete platforms in the category — it already ships, in
code, the things competitors sell as premium add-ons: real-time 270/271
eligibility, 276/277 claim status, 837P batch submit + 835/ERA auto-posting,
AI claim scrubbing + denial analysis, capped-rental modifier rotation, Da Vinci
PAS prior auth, secondary/COB generation, outbound fax for PA/appeals, patient
autopay + payment plans, lapsed-customer win-back, the privacy-first on-device
mask fitter, an omnichannel inbox, and a three-vendor AI voice/SMS/email stack.

**Two findings dominate, and neither is "build more":**

1. **The biggest revenue/denial levers are activation decisions, not
   engineering** — several high-value programs are built and fail-soft but
   shipped behind feature flags / crons that default OFF (see Lens A).
2. **Naive "what's missing" scans over-state the gaps.** Verified this session:
   AOB, ABN, and Proof-of-Delivery were reported "not implemented" by one
   sub-scan — **all three ship and are mature**
   (`lib/resupply-db/migrations/0417_abn_acknowledgement_hcpcs_scope.sql`,
   `0106_patient_form_acknowledgements.sql`,
   `0111_shop_orders_pod_photo.sql`, `routes/shop/order-pod.ts`,
   `lib/paperwork/require-signed-paperwork.ts`, claim-paperwork gate
   `0248`/`0253`). The 06-18 doc's "unbounded revenue read" in
   `worker/jobs/metrics-snapshot.ts` is now **bounded to one day per org**.
   The genuinely-open list below is short and specific.

The genuinely-open, owner-favorable gaps cluster in **fulfillment last-mile
automation**, **a handful of RCM automation/accuracy items**, and the larger
**growth ceiling** (multi-location, referral-source development). The two
highest-leverage low-risk items were **implemented in this PR** (see
"Shipped in this PR").

---

## Gap map — by the four owner lenses

Status legend: **OPEN** (not built) · **PARTIAL** (built, loop not closed) ·
**DORMANT** (built, off by flag/cron — an activation decision) · **DONE** (for
contrast / "don't rebuild").

### Lens A — Recurring resupply revenue

| Capability | Status | Evidence | Owner impact |
| --- | --- | --- | --- |
| **Resupply-due → order/draft action** | **OPEN — #1 lever** | `routes/admin/therapy-resupply.ts` lists due/overdue device-driven items (summary / opportunities / CSV) with **no "create order" action** | The "who's due" worklist is read-only; every order is a manual hand-off. Converting it to one-click (entitlement-gated, queued for CSR review) is the single biggest recurring-revenue lever. |
| **Dormant lifecycle programs** | **DORMANT** | review-request cron absent (`routes/admin/shop-review-requests.ts`); abandoned-cart cron `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED` OFF; auto-reminder enrollment seeded off (`migrations/0174…`, verify in `/admin/control-center`) | Highest ROI is a one-time **consent/CAN-SPAM + staffing decision**, then flip. No engineering for the first wave. |
| **Membership / subscription tier (cash-pay)** | **PARTIAL** | `routes/admin/shop-membership.ts` — CSR-set only; Stripe subscription webhooks never reconcile `membership_tier`; no storefront join flow | Recurring cash-pay revenue + retention left on the table; a lapsed sub keeps its tier forever. |
| **Multi-channel voice escalation** | **PARTIAL** | reminder/escalation workers downgrade a configured `voice` first-touch to SMS/email; bulk voice is not cron-scheduled | Multi-channel cadence (SMS→email→voice) is how vendors lift connection 15%→45%. |

### Lens B — Denials & faster cash

| Capability | Status | Evidence | Owner impact |
| --- | --- | --- | --- |
| **Batch claim creation from fulfillments** | **✅ Shipped in this PR** | was: `routes/admin/fulfillment-to-claim.ts` created one claim per click | Clean claims stopped aging in the "to bill" queue; one-click batch. |
| **Backorder auto-clear on restock** | **✅ Shipped in this PR** | was: `routes/admin/shop-backorders.ts` manual-clear only | Stops the order-flow substituting a SKU that's actually back in stock. |
| **Secondary / COB auto-submit** | **PARTIAL** | auto-**draft** exists (`lib/billing/secondary-claim-generator.ts`); no worker auto-**submits** on primary 835 post | Adjudicated-ready secondary balances depend on a CSR noticing the worklist. |
| **Prior-auth automation** | **PARTIAL** | Da Vinci PAS submit works (`routes/admin/davinci-pas-submit.ts`) but is **not auto-triggered before claims**; no bulk PA engine; token env-only | PA-required items wait on a manual click; front-loading PAs prevents the denial. |
| **Appeals lifecycle tracking** | **PARTIAL** | appeal **letters** tracked (`migrations/0137`, `routes/admin/claim-appeals.ts`); mail/manual appeals have no "mark mailed" transition; no `responded_at`/`outcome`/aging columns | Can't measure appeal win-rate or age the appeal clock. |
| **Collections-forecast / AR aging accuracy** | **OPEN** | no `partially_paid` status; denied/appealed aged as collectible (`lib/billing/collections-forecast.ts`, `routes/admin/billing-reports.ts`) | Owner cash forecast is overstated — a correctness gap that affects a money decision. |
| **Chargeback / dispute persistence** | **OPEN** | Stripe `charge.dispute.*` only WARN-logs (`lib/stripe/webhook-handler.ts`); no disputes table/flag | A missed dispute alert = a silently lost deadline = lost revenue. |

### Lens C — Fulfillment & inventory operations

| Capability | Status | Evidence | Owner impact |
| --- | --- | --- | --- |
| **Carrier tracking webhook ingest** | **OPEN** | `shipped_at`/`delivered_at` are admin-stamped; no EasyPost/Shippo webhook handler | No auto-advance of fulfillment state, no auto-POD/auto-follow-up; manual status entry. |
| **Inventory reservation / oversell guard** | **OPEN** | stock is `shop_products.metadata.stock_count` (Stripe, point-in-time); no `inventory_reservations` table | Oversell risk under concurrency on cash-pay checkout. |
| **Supplier purchasing / procurement** | **OPEN — strategic** | inventory catalog + COGS + monthly reconciliation exist (`routes/admin/inventory-reconciliation.ts`); no purchase-orders-to-distributor, reorder points, multi-location stock, lot/serial | Buy-side loop is absent (note: warehouse pick/pack is intentionally provider/3PL-owned). Brightree/WellSky include purchasing. |

### Lens D — Growth & referral sources (the strategic builds)

| Capability | Status | Evidence | Owner impact |
| --- | --- | --- | --- |
| **Multi-location / multi-tenant completion** | **PARTIAL — strategic** | org threading mid-migration (06-20 §2, mostly fixed for the authenticated surface; a few seed-org leaks remain); `dme_organization` singleton surfaces | Hard ceiling on a second branch / acquired DME / SaaS resale. |
| **Referral-source / physician CRM + adherence reporting back to referrers** | **OPEN — strategic** | physician/NP registry + referral intake (Parachute / e-prescribe / fax / AI referral reviewer) exist; **no B2B referral-relationship management** (rep visit logs, referral volume by source/scorecards) and **no automated adherence/outcome report back to the referring physician/sleep lab** | DMEs grow on referral relationships; reporting adherence back is the stickiest retention lever for a referral source. |
| **Provider-facing RTM dashboard** | **OPEN — strategic** | provider portal is login + e-sign only (`routes/provider/portal.ts`); therapy device data is ingested but not surfaced to referring providers | Referral stickiness + a clinical-value differentiator vs. a fulfillment bureau. |

### Lens E — Clinical / adherence (supporting)

- **Real-time compliance alerts** — detection is nightly-batch
  (`worker/jobs/therapy-integrations-nightly-sync.ts`); no same-night "dropped
  below 4 hr" flag to the RT board. _Favorable, not blocking._
- **Sleep-study diagnostic parsing** — studies can be uploaded but AHI/severity
  isn't auto-extracted. _Minor._
- **Live therapy-cloud data** is **contract-blocked, not code-blocked** — the
  ResMed/Philips/3B adapters are production-ready; live pulls await executed
  partner BAAs/OAuth. _Business-development action, not engineering._

---

## Prioritized recommendation

1. **Run a dormant-lever activation pass** (Lens A) — the owner makes the
   consent/staffing call, then flips auto-reminder enrollment, cart-abandonment,
   review-requests, and (with CSR sign-off) the eligibility/entitlement
   enforcement flags in `/admin/control-center`. **Highest ROI, ~0 engineering.**
2. **Shipped in this PR** (Lens B/C): batch claim creation + backorder
   auto-clear (below).
3. **Resupply-due → draft/batch order** (Lens A #1) — add a "create draft
   order(s)" action to `therapy-resupply.ts`, entitlement-gated, queued for CSR
   review. Converts the existing worklist into recurring revenue.
4. **Fulfillment last-mile** (Lens C) — carrier tracking webhook ingest (auto
   POD/follow-up) + an `inventory_reservations` oversell guard.
5. **RCM accuracy/automation** (Lens B) — collections-forecast `partially_paid`
   accuracy, secondary/COB auto-draft on 835 post, dispute persistence.
6. **Strategic** (Lens D) — finish multi-tenant; then referral-source CRM +
   adherence-report-to-referrer; then provider RTM. These are the growth
   ceiling, not quick wins.

---

## Shipped in this PR (the two top quick-wins)

Both are additive, fail-soft, fully tested, and require **no migration**.

- **Batch claim creation from fulfillments** —
  `POST /admin/billing/fulfillments/batch-create-claims`
  (`routes/admin/billing-batch-create-claims.ts`). Reuses the SAME core as the
  single-click route via the extracted `lib/billing/create-claim-from-fulfillment.ts`
  helper (so the two paths can't diverge), with per-item isolation + duplicate
  guard + bill-hold seeding. SPA: a "Create all claims" action on the Billing
  Hub "Fulfillments ready to bill" card. **Lever:** throughput / faster cash —
  clean claims stop aging in the queue.
- **Backorder auto-clear on restock** —
  `lib/backorder/auto-clear-on-restock.ts`, hooked into the admin
  shop-inventory save (`routes/admin/shop-products.ts`) at the same 0→positive
  stock transition that fires the back-in-stock notify queue. Clears any open
  `shop_backorders` row for the product's `metadata.shop_sku`, idempotent +
  audited + fail-soft. **Lever:** fulfillment ops + reorder capture — the
  resupply order-flow stops substituting a SKU that's back in stock.

---

## Appendix — "already shipped, do NOT rebuild"

So the owner doesn't fund rebuilds. Each was, at some point, called a gap; each
is in fact shipped (often automated). Verified this session.

- **Paperwork:** ABN (`migrations/0417`), AOB / financial-responsibility form
  acks (`0106`, `routes/admin/form-acknowledgements.ts`), Proof-of-Delivery
  (`0111`, `routes/shop/order-pod.ts`), signed-paperwork claim gate
  (`0248`/`0253`, `lib/paperwork/require-signed-paperwork.ts`), CMN/DIF
  (`migrations/0202`, `lib/billing/cmn-forms.ts`), DWO, patient packets +
  e-sign.
- **RCM/EDI:** 270/271, 276/277, 837P batch, 835/ERA auto-post, 999, Da Vinci
  PAS, secondary/COB draft, denial analyzer + appeal letters + outbound fax,
  timely-filing, capped-rental KX/RB→RJ, same-or-similar, payer
  profiles/fee-schedules/modifier rules, Good-Faith Estimates.
- **Payments:** Stripe checkout, per-tenant Connect, patient autopay, payment
  plans, statements.
- **Resupply/comms:** Medicare-cadence reminders, signed-link YES/EDIT/STOP,
  inbound-SMS + IVR reorder, bulk campaigns, omnichannel inbox, 3-vendor AI
  (voice/SMS/email/chatbot), sleep coach, on-device mask fitter, RMA/returns,
  asset recovery, lapsed-customer win-back.
- **Analytics:** acquisition funnel, LTV/CAC, margin/COGS, payer profitability,
  AR aging / DSO, inventory turnover, CSR productivity, NPS.

---

_Verified against `claude/upbeat-keller-dcxw5o`. When an OPEN/PARTIAL item ships,
update this file rather than the older reviews._
