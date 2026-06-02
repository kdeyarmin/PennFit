# Backend DME Efficiency Audit & Enhancement Backlog — 2026-06-02

A deep-dive audit of the `artifacts/resupply-api` backend (Express API +
in-process pg-boss worker) and the `lib/resupply-*` packages, viewed
through one lens: **can a DME company efficiently run its business on this
software, and where are the highest-leverage enhancements?**

Scope covered: order/resupply/fulfillment lifecycle, the revenue cycle
(eligibility → prior auth → claims → remittance → denials), patient /
clinical / Rx management, therapy-cloud integrations, analytics &
operational dashboards, and the cross-cutting data-access + HTTP layer.

Every finding below is grounded in `file:line` evidence gathered during
the audit and spot-verified against the current tree (branch tip =
`origin/main`, PR #472 merge; latest migration `0207`).

> **Posture note.** This is an audit + prioritized backlog, not a code
> change. The platform is a live DME billing system; the recommendations
> are sequenced so each can be implemented and reviewed in isolation.
> Nothing here has been applied to the runtime — see
> [§7 Quick wins](#7-quick-wins-shippable-in-isolation) for the items
> safe to ship first.

---

## 1. Executive summary

**The platform is genuinely mature.** It is not a thin CRUD app with a
CPAP theme. The in-process worker registers **~60 scheduled jobs**
(`artifacts/resupply-api/src/worker/index.ts:330-640`) covering DME
machinery most resupply shops buy from three or four separate vendors:

- **Revenue cycle**: full ASC X12 5010 round-trip — 837P batch submit,
  999/277CA acknowledgement dispatch, 835 ERA parse + auto-posting with a
  terminal-status idempotency guard
  (`lib/resupply-integrations-office-ally/src/edi/*`,
  `artifacts/resupply-api/src/lib/billing/era-reconciler.ts`), plus an
  AI denial analyzer + auto-workflow engine
  (`src/lib/billing/ai-denial-analyzer.ts`, `auto-workflow-engine.ts`).
- **DME-specific billing**: capped-rental month advance with KH/KI/KX
  modifier rotation (`worker/jobs/capped-rental-advance.ts`), DWO/CMN
  expiry sweeps, PA/MCO 7-day SLA tracking, PECOS ordering-provider sync,
  prior-auth expiry sweeps, secondary/COB claim generation.
- **Patient lifecycle**: automated, multi-channel, atomically-claimed Rx
  renewal (`src/lib/rx-renewal/dispatcher.ts`), therapy-cloud nightly
  sync with vendor throttling (`worker/jobs/therapy-integrations-nightly-sync.ts`),
  quarterly therapy summaries, milestone/lifecycle touchpoints.
- **Sound engineering hygiene**: per-request correlation IDs, structured
  PHI-safe logging, idempotency middleware, CSRF double-submit, layered
  rate limits, graceful boot/shutdown decoupled from the worker, and a
  pg-boss DLQ-alert heartbeat.

**Where the gaps are.** They cluster in three places:

1. **Cross-cutting data-layer efficiency** — a handful of patterns that
   are correct today but scale poorly: `count: 'exact'` on hot dashboards,
   in-memory aggregation of unbounded reads, a few missing indexes on
   hot billing-query columns, and no HTTP response compression. These are
   the cheapest, highest-confidence wins.
2. **"Last-mile" automation gaps** — the system *notifies* beautifully
   but stops short of *acting*: resupply eligibility never becomes an
   order without a CSR click; backorders never auto-clear; there's no
   inventory reservation; claims are created one-at-a-time.
3. **Revenue-cycle operationalization** — the hard EDI plumbing is built,
   but the operator-facing surfaces that turn it into daily throughput
   are thin: no A/R aging, no denial worklist, 271 inbound not yet
   dispatched, Da Vinci PAS library built but unwired.

The rest of this document details each finding with evidence and a
prioritized backlog ([§6](#6-prioritized-enhancement-backlog)).

---

## 2. Cross-cutting data-layer & HTTP efficiency

These affect every operator on every page load and are the highest
ROI-per-line-of-code changes in the audit.

### 2.1 — No HTTP response compression `[P0, trivial]`

`artifacts/resupply-api/src/app.ts` mounts security headers, CORS, pino,
body parsers, CSRF, and rate limits — but **no `compression`
middleware**. Every admin list/dashboard JSON payload ships uncompressed
over the wire. DME admin responses (claims lists, customer rollups,
funnel data) are large, highly compressible JSON.

- **Evidence**: no `compression` import anywhere in `src/`; not in
  `package.json`.
- **Fix**: add `compression()` early in the chain (after
  `securityHeaders`, before routers). One dependency, ~3 lines, immediate
  egress + latency win on every JSON response. Exclude the Stripe raw-body
  webhook (already mounted before `express.json`, so naturally excluded).

### 2.2 — `count: 'exact'` on hot dashboards over growing tables `[P0, low]`

**66 `count: 'exact'` call sites, 0 `'estimated'/'planned'`** across the
API. Postgres satisfies an exact PostgREST count with a `COUNT(*)
OVER()` that scans every matching row — fine on a filtered/partial-index
predicate, expensive on large tables, and these fire on **every admin
dashboard render**.

- **Worst offenders** (`src/routes/admin/ops-status.ts:86-152`): eight
  exact counts per load, including `shop_orders` (`:98-99`) and
  `shop_abandoned_carts` — both unbounded-growth tables.
- Also hot: `inbox-counts.ts:65-107` (six counts; these are mostly OK —
  they ride partial indexes), `billing-dashboard.ts`, `resupply-funnel.ts`,
  `customers.ts`, `insurance-leads.ts`, `fitter-leads.ts`.
- **Fix**: switch the large-table, non-critical-precision counts to
  `count: 'estimated'` (PostgREST → `reltuples` planner estimate, O(1)).
  Keep `'exact'` where the predicate rides a selective partial index
  (the inbox badges) or where precision matters. This is a per-call-site
  judgement, not a blanket sweep.

### 2.3 — Missing indexes on hot billing-query columns `[P0, low]`

`insurance_claims` carries 11 indexes (patient, status+updated_at partial,
claim_number, providers, payer_profile, predicted-denial, …) but **none
on `decision_at` or `submitted_at`** — both of which back hot
billing-director queries:

- `src/routes/admin/billing-director.ts:120-126` — 90-day denial-trend
  read filters `.gte("decision_at", t90d)` with `.limit(20000)`. No
  supporting index → range scan that worsens linearly with claim volume.
- `billing-director.ts:69-72` — "stuck submitted" read filters
  `.lte("submitted_at", t48h)`. No index.
- **Fix (migration `0208`)**: `CREATE INDEX CONCURRENTLY` on
  `insurance_claims (decision_at DESC)` and a partial
  `(status, submitted_at)` for the stuck-submitted lane. Follow the
  existing hand-written-SQL migration convention; do **not** touch
  `_journal.json` (frozen per CLAUDE.md).

### 2.4 — Patient name/email search full-scans `[P1, low]`

`src/routes/patients/list.ts` is index-aware for the common path (E.164
phone `.eq()` at `:88`, indexed `pacware_id`), but the name/email
fallback at `:95-96` uses `.ilike()` on plaintext `legal_first_name /
legal_last_name / email`. **No `pg_trgm` / GIN trigram index exists**
(verified: no `gin_trgm_ops` anywhere in `drizzle/*.sql`). At 10k+
patients, "search by last name" sequential-scans.

- **Fix**: `CREATE EXTENSION pg_trgm` + GIN trigram indexes on the
  searched columns. Note: CLAUDE.md says Postgres is run "no extensions";
  confirm `pg_trgm` availability on the Supabase instance first (it's
  enabled by default on Supabase) — if disallowed, fall back to a
  generated `search_vector tsvector` column + GIN.

### 2.5 — In-memory aggregation of unbounded reads `[P1, medium]`

Several analytics endpoints fetch a large row set with a hard
`.limit(20000)`/`.limit(50000)` and aggregate in JS. They're correct at
today's volume but **silently truncate** once the cap is hit, and they
pull far more data than the answer needs:

| Endpoint | File:line | Read | Risk |
| --- | --- | --- | --- |
| LTV/CAC | `ltv-cac.ts:60-71, 83-91` | `shop_orders` + `customer_acquisition`, `.limit(20000)`, **no time window** | grows unbounded with revenue; silent truncation |
| Denial trend | `billing-director.ts:120-126` | `insurance_claims` 90d, `.limit(20000)` | high-volume billing can exceed cap |
| Compliance cohorts | `analytics.ts:207-243` | all `patient_therapy_nights` for cohort, JS-partition + per-patient `findBestAdherenceWindow()` | CPU-heavy on 1000+ patients |
| Mask-fit rec-signal | `mask-fit-worklist.ts:128-133` | `mask_fit_outcomes` `.limit(20000)`, no window | silent truncation as outcomes accrue |

- **Fix**: the team *already* has the right pattern — SQL RPCs in
  `lib/resupply-db/drizzle/0164_admin_aggregate_rpcs.sql`
  (`resupply.billing_denial_rate`, `resupply.shop_back_in_stock_queue`),
  called from 10 route files via `.rpc()`. Push these aggregations into
  `resupply.*` SQL functions (`GROUP BY`/`date_trunc` server-side) so the
  DB returns the bucketed answer, not 20k rows. At minimum, add explicit
  `.gte("created_at", cutoff)` windows so reads are bounded by time, not
  by a magic row cap.

### 2.6 — `reminders.scan` hot path `[P1, medium — by design, but watch it]`

The hourly `reminders.scan` (`src/worker/jobs/reminders.ts:420`) loads
**all** active prescriptions (paged 1000), their episodes (paged per
200-Rx chunk), all active patients (200/batch), all fulfillments
(200/batch), and recent conversations, then resolves cadence in
TypeScript. This is a *deliberate* loosening (`reminders.ts:461-467`):
SQL can't express the override-rule precedence (per-patient override →
frequency_rule → prescription default), so an SQL `due` filter would
miss patients made due *earlier* by a rule.

- **Not a bug** — the comment history shows a prior SQL filter silently
  dropped patients. But it's the single heaviest recurring scan and will
  dominate worker CPU/DB as the patient base grows.
- **Fix (when it bites)**: precompute a `next_due_at` per (patient, SKU)
  materialized nightly from the resolved rules, and have the hourly scan
  read only `next_due_at <= now()`. Keeps rule precedence (resolved in the
  nightly pass) while making the hourly scan a cheap indexed read.

### 2.7 — `conversation-routing` load-balancer fetches all admins+convos `[P2, low]`

`src/routes/admin/conversation-routing.ts:187-206` fetches every active
admin then every open conversation assigned to them, unbounded, to pick a
least-loaded assignee. Fine at ≤dozens of admins; add a `.limit()` / recent
window before it's a 50-CSR shop.

---

## 3. Order, resupply & fulfillment — the "last-mile automation" gap

The system's notification automation is excellent; its **action**
automation stops one step short. A DME operator feels this as "the
software tells me what to do, then makes me do it by hand."

### 3.1 — Resupply eligibility never becomes an order `[P0, high value]`

`reminders.scan` and `/admin/therapy-resupply/opportunities`
(`therapy-resupply.ts:204`) surface *who is due* and even pull device
`nextEligibleDate` from the therapy nightly sync — but **no path converts
eligibility into a draft order/fulfillment**. Every order is a manual CSR
action. There is no auto-create, no batch-create, no "one patient, three
due SKUs → one order" consolidation.

- **Fix**: add `POST /admin/therapy-resupply/batch-order` (and/or a
  feature-flagged cron) that drafts orders for consented, eligible,
  entitlement-passing patients. Gate behind `resolveResupplyEntitlement()`
  (`lib/resupply-domain/src/entitlement.ts`) + dispense-readiness so it
  never drafts something un-billable. This is the single biggest
  labor-saving feature for a resupply DME.

### 3.2 — No inventory reservation; oversell risk `[P1, medium]`

Stock lives as a point-in-time `shop_products.metadata.stock_count` in
Stripe; `low-stock-alerts.ts` reads and alerts but nothing **reserves**
stock against in-flight orders. Concurrent orders can over-allocate the
same units. There is also no auto-reorder / draft-PO generation.

- **Fix**: a lightweight `inventory_reservations` ledger decremented at
  order creation and reconciled on fulfillment, plus optional draft-PO
  emission when on-hand minus reserved crosses the reorder point.

### 3.3 — Backorders clear only by manual click `[P1, low]`

`shop-backorders.ts:171-234` clears a backorder only via an admin POST;
nothing auto-clears when stock arrives or fulfillments resume for that
SKU. New orders keep substituting against a SKU that's actually back in
stock. Wire auto-clear to the same restock signal as 3.2.

### 3.4 — Claims created one-at-a-time `[P1, medium]`

`fulfillment-to-claim.ts:46` is single-fulfillment → single draft claim.
Batch 837P *submission* exists (`billing-batch-submit.ts`, up to 100
claims), but **claim creation** has no batch endpoint, so the billing
queue bottlenecks at "click create-claim N times." Add
`POST /admin/fulfillments/batch-create-claims`.

### 3.5 — Carrier delivery is manual `[P2, low]`

`shipped_at`/`delivered_at` are stamped by admins, not by carrier tracking
webhooks/polling. A tracking-webhook ingest (EasyPost/Shippo or
carrier-direct) would auto-advance state and trigger the existing
delivery-followup job without CSR data entry.

---

## 4. Revenue cycle — operationalizing the EDI plumbing

The hard part (X12 generation/parsing, ERA posting, control-number
monotonicity, PHI-safe audit) is **done and good**. The gaps are the
operator-facing surfaces and two unwired pipelines.

### 4.1 — 271 eligibility response not yet dispatched `[P0, medium]`

`src/lib/billing/eligibility-verifier.ts:1-10` ships the 270 over Office
Ally SFTP and writes an `eligibility_checks` row as `submitted`, but the
inbound poller doesn't yet parse/dispatch the **271** that lands in the
SFTP outbound dir (999/277CA/835 dispatch *are* wired in
`office-ally-inbound-poll.ts:361-580`). So eligibility results sit
`submitted` until an operator hand-checks the row.

- **Fix**: add a `dispatch271()` alongside the existing 999/277CA/835
  dispatchers and a `parse-271.ts` to the office-ally EDI package; post
  the parsed coverage/benefit back onto the `eligibility_checks` row so
  the 24h cache (`getCachedEligibility()`) and claim preflight can use it.

### 4.2 — Da Vinci PAS prior-auth library built but unwired `[P1, medium]`

`lib/resupply-integrations-davinci-pas/` is a complete, Zod-validated
FHIR PAS v2.2 (CMS-0057-F) implementation — `buildPasBundle`,
`submitPasBundle`, `parseClaimResponse` — but **no route or worker calls
`submitPasBundle()`**. Items requiring PA can be claimed without one,
inviting immediate denials.

- **Fix**: wire it into the prior-auth queue: a route to submit a PAS
  bundle for a patient/coverage/HCPCS set, persist the `ClaimResponse`
  decision + auth number onto `prior_authorizations`, and block claim
  submit when a PA-required payer/HCPCS lacks an approved auth.

### 4.3 — No A/R aging / DSO `[P0, medium]`

No aging buckets, no days-sales-outstanding, no "claims pending >90 days
by payer." `billing-reports.ts` covers denial rate + timely-filing but a
revenue-cycle manager can't answer "what's stuck and how old is it?"

- **Fix**: an `/admin/billing/ar-aging` endpoint backed by a SQL RPC that
  buckets open `insurance_claims` by `age(now(), submitted_at)` × payer ×
  status. (Pairs naturally with the 2.3 `submitted_at` index.)

### 4.4 — No denial worklist `[P1, medium]`

The AI denial analyzer writes thorough `claim_denial_analyses` rows
(recommendation ∈ {auto_resubmit, appeal, bill_patient, write_off,
manual_review}) but there's **no prioritized worklist UI/route** to drive
them — CSRs must hand-join `insurance_claims` ⋈ `claim_denial_analyses`.
Add `/admin/billing/denial-worklist` grouped by recommendation with bulk
patch-apply (reusing the safe-patch whitelist in `ai-patch.ts`).

### 4.5 — Secondary/COB and appeals lack closure `[P2, medium]`

- Secondary claims generate to draft (`secondary-claims.ts`) but there's
  no auto-submit job and no secondary-ERA reconciliation — the COB loop
  doesn't close.
- Appeal **letters** generate (`appeal-pdf.ts`) but there's no appeal
  **tracking** table (submitted/responded/outcome), so appeals can't be
  aged or measured.

### 4.6 — Copay/coinsurance/deductible are implicit `[P2, low]`

Patient responsibility is a residual (`billed − allowed − paid`) on
`insurance_claims`; there's no explicit copay/coinsurance/deductible
structure. Adequate for collection via Stripe today; revisit if payer
benefit modeling is needed for accurate pre-service estimates.

---

## 5. Patient, clinical & operations management

### 5.1 — No patient dedup / merge `[P1, medium]`

`patients/create.ts` enforces unique `pacware_id` only — no cross-field
(name + DOB + phone) duplicate detection or CSR merge workflow. DME intake
from faxes/referrals routinely produces variant spellings and phone
formats; without "find similar patients" + merge, CSRs accumulate
duplicate records. Add a fuzzy-match suggestion (pairs with the 2.4
trigram index) and a guarded merge endpoint.

### 5.2 — Therapy-cloud: ResMed/Philips adapters are stubs `[P1, external]`

`src/lib/therapy-cloud/index.ts:69-112` — AirView (ResMed) and Care
Orchestrator (Philips) adapters are stubs that throw until env-configured;
React Health (3B) lives implemented in its own package. The **nightly
sync framework is production-ready** (`therapy-integrations-nightly-sync.ts`,
throttled, capped, idempotent) — these just need partner BAA + OAuth
credentials. Track as an integration/onboarding task, not a code defect.

### 5.3 — No real-time staffing/queue dashboard `[P2, medium]`

Productivity surfaces (`productivity.ts`, `today.ts`, `work-items.ts`) are
strong on *lagging* metrics (closed-this-week, queue snapshots) but there's
no real-time "which CSR is overloaded right now," and no voice queue
metrics (wait time, handle time) despite a full voice stack. Relevant once
the shop runs 10+ concurrent CSRs.

### 5.4 — Inbound fax → referral is manual `[P2, medium]`

Inbound faxes land in a `new` queue (`today.ts` `inboundFaxes`) but there's
no OCR/parse → structured referral. Parachute/EHR-FHIR webhooks are
automated; fax (still the dominant DME referral channel) is hand-triaged.

### 5.5 — Audit/analytics degradation is acknowledged `[informational]`

Per CLAUDE.md, migration 0156 retired the compliance/audit-log machinery;
`@workspace/resupply-audit` is a no-op stub and the three historical
`audit_log` readers short-circuit to degraded responses. CSR-productivity
analytics correctly return `degraded: true` when audit data is thin
(`analytics.ts:283-302`). This is by design — flagged only so it isn't
mistaken for a regression. Do **not** add new `audit_log` readers.

---

## 6. Prioritized enhancement backlog

Sequenced by **value ÷ effort**. P0 = cheap, high-confidence, ship soon.

| # | Enhancement | Area | Value | Effort | Pri |
| --- | --- | --- | --- | --- | --- |
| 1 | Add `compression` middleware (§2.1) | Perf | M | XS | **P0** |
| 2 | `count: 'estimated'` on large-table dashboard counts (§2.2) | Perf | M | S | **P0** |
| 3 | Indexes on `insurance_claims.decision_at` + `(status, submitted_at)` (§2.3) | Perf | M | S | **P0** |
| 4 | Wire 271 inbound dispatch + parser (§4.1) | Rev-cycle | H | M | **P0** |
| 5 | A/R aging / DSO endpoint + RPC (§4.3) | Rev-cycle | H | M | **P0** |
| 6 | Resupply eligibility → batch order creation (§3.1) | Fulfillment | H | M-H | **P0** |
| 7 | pg_trgm/GIN index for patient name/email search (§2.4) | Perf | M | S | P1 |
| 8 | Push analytics aggregation into SQL RPCs / bound reads (§2.5) | Perf | M | M | P1 |
| 9 | Wire Da Vinci PAS into prior-auth queue (§4.2) | Rev-cycle | H | M | P1 |
| 10 | Denial worklist route + bulk patch-apply (§4.4) | Rev-cycle | H | M | P1 |
| 11 | Batch claim creation endpoint (§3.4) | Fulfillment | M | S | P1 |
| 12 | Inventory reservation ledger + auto-reorder (§3.2) | Fulfillment | M | M-H | P1 |
| 13 | Auto-clear backorders on restock (§3.3) | Fulfillment | M | S | P1 |
| 14 | Patient dedup/merge workflow (§5.1) | Patient | M | M | P1 |
| 15 | Materialized `next_due_at` for reminders.scan (§2.6) | Perf | M | M | P2 |
| 16 | Carrier tracking-webhook ingest (§3.5) | Fulfillment | M | M | P2 |
| 17 | Secondary auto-submit + secondary ERA (§4.5) | Rev-cycle | M | M | P2 |
| 18 | Appeal tracking table + aging (§4.5) | Rev-cycle | M | S | P2 |
| 19 | Real-time staffing/queue dashboard (§5.3) | Ops | M | M | P2 |
| 20 | Inbound-fax OCR → referral (§5.4) | Intake | M | H | P2 |
| 21 | Bound `conversation-routing` admin/convo reads (§2.7) | Perf | L | XS | P2 |

---

## 7. Quick wins (shippable in isolation)

The P0 perf items are self-contained, low-risk, and independently
reviewable. Recommended first PR(s):

1. **`compression` middleware** — one dep, ~3 lines in `app.ts`, exclude
   the Stripe raw-body route (already excluded by mount order).
2. **`count: 'estimated'` on `ops-status.ts` large-table counts** — per
   call-site; keep `'exact'` on partial-index-backed inbox badges.
3. **Migration `0208`** — `CREATE INDEX CONCURRENTLY` on
   `insurance_claims (decision_at DESC)` and partial `(status,
   submitted_at)`. Hand-written SQL per convention; **do not** touch
   `_journal.json` (frozen at 52 entries per CLAUDE.md).

Each ships independently behind its own PR with no schema-shape or
behavior change to the EDI/billing core.

---

## 8. Verified evidence index

- Worker job registry (~60 jobs): `artifacts/resupply-api/src/worker/index.ts:330-640`
- No compression / 66 `count:'exact'`, 0 `'estimated'`: `src/app.ts`; grep of `src/**`
- `insurance_claims` indexes (no `decision_at`/`submitted_at`): `lib/resupply-db/drizzle/0118_insurance_claims.sql`, `0129_billing_enhancements.sql` et al.; latest migration `0207`
- Aggregate-RPC precedent: `lib/resupply-db/drizzle/0164_admin_aggregate_rpcs.sql` (`billing_denial_rate`, `shop_back_in_stock_queue`); 10 `.rpc()` call sites
- ERA posting + idempotency: `src/lib/billing/era-reconciler.ts`; X12: `lib/resupply-integrations-office-ally/src/edi/{837p,parse-999,parse-277ca,parse-835}.ts`
- 271 gap: `src/lib/billing/eligibility-verifier.ts:1-10`; dispatch wiring: `src/worker/jobs/office-ally-inbound-poll.ts:361-580`
- PAS unwired: `lib/resupply-integrations-davinci-pas/src/{index,client,build-bundle,parse-claim-response}.ts`
- Resupply→order gap: `src/lib/storefront/order-reminder-enrollment.ts`, `src/routes/admin/therapy-resupply.ts:204`, `reminders.ts:420`
- Unbounded reads: `src/routes/admin/{ltv-cac.ts:60-91, billing-director.ts:69-126, analytics.ts:207-243, mask-fit-worklist.ts:128-133}`
- Patient search: `src/routes/patients/list.ts:88-96`; therapy adapters: `src/lib/therapy-cloud/index.ts:69-112`
</content>
</invoke>
