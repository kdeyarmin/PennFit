# PennFit Operator Feature Roadmap

_Authored 2026-05-31. A dependency-aware, phased plan to build **every**
brainstormed feature across the four operator personas — DME owner,
customer-service agent (CSR), respiratory therapist (RT), and medical
biller — plus the four shared foundations they sit on._

This is a planning document, not a spec. Each item lists **where it
plugs into the existing codebase**, the **new migration / permission /
job** it needs, a **T-shirt size**, and its **exit criteria**. Nothing
here should be built in a way that violates the invariants in
[`CLAUDE.md`](../CLAUDE.md) — those are restated as ground rules below
because several items brush right up against them.

> **Scope note.** PennFit is already a deep platform (127 admin route
> files, 80+ admin pages, full 837→835 EDI pipeline, 90-day CMS
> adherence tracking, AI voice agent). Almost every item below is an
> _addition to_ or _force-multiplier on_ shipped functionality, not a
> from-scratch build. Each item's "Already in the app" line says what
> we're extending.

---

## How to read this

- **Sizes:** S ≤ 2 dev-days · M = 3–5 · L = 1–2 weeks · XL = 3+ weeks
  (one engineer).
- **Phases** are ordered by dependency, then value. Phase 0 is the
  shared substrate; Phases 2–5 are largely **parallelizable across
  engineers** once Phase 0 lands (Owner / RT / CSR / Biller tracks
  barely touch each other). Phase 6 is the data-dependent tail.
- Every item maps back to the brainstorm in the master table at the
  end (§ "All 37 items at a glance").

---

## Engineering ground rules (apply to every item)

These come straight from `CLAUDE.md`'s "Hard rules" and the service-boot
contract. A violation is a correctness bug, not a style nit.

1. **Migrations** are hand-written SQL in `lib/resupply-db/drizzle/`.
   The next free prefix is **`0186`**; numbers are **collision-prone on
   merge trains** (`0179`–`0181` already doubled up), so claim your
   number in the PR that _lands_, not when you start, and rebase-bump if
   you collide. **Never** hand-edit `drizzle/meta/_journal.json` (frozen
   at 52 entries). `scripts/check-resupply-migration-prefix.sh` gates
   this.
2. **One data path: Supabase.** Read/write only through
   `getSupabaseServiceRoleClient()` from `@workspace/resupply-db`. No
   `drizzle-orm`, no direct `pg` outside `lib/resupply-db` (Rule 7 in
   `scripts/check-resupply-architecture.sh`). Any new `resupply` table
   must be added to Studio → Exposed schemas or every query 503s.
3. **Every new admin route** gets a Zod body/query schema **and** a
   gate — `requirePermission("…")`, `requireAdminOnly`, or
   `requireAdmin`. `scripts/check-admin-route-gates.sh` fails CI on any
   ungated mutation. New permission keys live in
   `lib/resupply-auth/src/rbac.ts`.
4. **No `audit_log` readers.** The table is retired; that is _why_
   `/admin/analytics/csr-productivity` is currently broken. All new
   productivity / outcomes / analytics endpoints derive from event
   tables (`insurance_claim_events`, `conversations`, the new
   `clinical_encounters`, therapy-metrics RPCs) and return **aggregates
   / counts only — never PHI**.
5. **No new column-level encryption** (migration 0025 stripped it) and
   **no PHI in logs** — no order request bodies, no camera image bytes,
   base64, or data URLs, anywhere in the backend.
6. **Admin UI scoping:** every new admin page wraps its outer `<div>` in
   `className="admin-root"`; do **not** add a global `@theme` block to
   `admin.css` (it leaks Tailwind v4 utilities into the storefront).
   Register pages in `components/admin/AppShell.tsx` nav + the SPA route
   table; lazy-load. Enforced by `admin.scope.test.ts`.
7. **One From address:** all email funnels through
   `lib/resupply-email`'s `createSendgridClient()`
   (`info@pennpaps.com`). Used by the owner digest and patient
   statements below — don't bypass it.
8. **Voice/SMS** reuse `lib/resupply-telecom` (Twilio) and
   `lib/resupply-reminders`; any outbound patient contact is
   **consent-/DND-/frequency-cap-aware**, following the existing
   `therapy_fleet.auto_outreach` pattern.
9. **New vendors fail soft.** Anything that needs a new third-party key
   (e.g. video hosting) exposes a `read…ConfigOrNull()` helper and an
   `availability()` status; missing env → degraded, **never** a boot
   failure. The HTTP listener must not couple to it.
10. **New worker jobs** go in `artifacts/resupply-api/src/worker/jobs/`,
    are registered in `worker/index.ts`, are **idempotent**, and must
    not `process.exit` on failure (the listener is decoupled from the
    worker on purpose).
11. **API client types** are hand-edited in
    `lib/api-client-react/src/{admin,storefront}/generated/` — the
    OpenAPI/orval pipeline was deleted; there is no codegen.
12. **PR hygiene:** one phase = several small, reviewable PRs (one per
    item where practical). `pnpm typecheck && pnpm lint:resupply &&
pnpm test` plus the three `check-*` scripts must be green.

---

## Phase 0 — Foundations (build first; everything leans on these)

Four substrates unlock the persona clusters. Until these exist, the
high-value items in Phases 2–5 have nowhere to read from.

### F1 · Cost / COGS data capture — **M**

- **Why:** Owner margin, payer profitability, LTV, inventory turnover,
  and the cash-flow forecast are all blocked on "what did this cost
  us?" — a number the system never records today.
- **Build:** migration adding `unit_cost_cents` to the product mirror
  and a `cost_snapshots` concept; stamp a **cost snapshot** onto
  `shop_orders`, `fulfillments`, and `insurance_claim_line_items` at
  creation (cost is point-in-time, so snapshot — don't join live). Add
  fulfillment/shipping/clearinghouse/Stripe-fee fields.
- **Plugs into:** `seed-stripe-products.ts` (cost alongside price),
  fulfillment dispatch in the Stripe webhook handler, claim-line
  creation.
- **Exit:** every new order/claim line carries a captured cost; a
  read-only `cost.read` permission exists; backfill script for historic
  rows (cost = null → "unknown", surfaced honestly).
- **Status (2026-05-31):** ⏳ in progress. Landed: migration
  `0186_cost_capture` (`product_costs` + nullable cost-snapshot columns
  on `shop_order_items` / `insurance_claim_line_items` + order-level fee
  columns on `shop_orders`); the finance-gated `cost.read` / `cost.write`
  RBAC permissions; the pure unknown-cost-aware margin/COGS math in
  `@workspace/resupply-domain` (`computeMargin` / `aggregateMargin`); and
  the **`/admin/product-costs` API** (`GET` list on `cost.read`, `PUT`
  upsert on `cost.write`) so operators can enter and view per-SKU cost;
  the `supabase-types.ts` schema mirror synced to 0186; the fail-soft
  `fetchUnitCostsBySku` batch helper; and **order-path capture** — the
  Stripe webhook now stamps `unit_cost_cents` / `cost_source` /
  `cost_captured_at` onto `shop_order_items` from `product_costs` at
  paid-session ingest (SKU resolved from Stripe product metadata,
  fail-soft). **Claim-path capture** also landed — the claim builder
  resolves cost from the fulfillment SKU and `buildClaimLineRows` stamps
  it onto `insurance_claim_line_items` at fulfillment→claim persist; and
  the **`seed:product-costs`** operator script (CSV → `product_costs`
  upsert, idempotent, `--dry-run`). **✅ F1 complete.** Historic
  order/claim lines whose SKU wasn't persisted stay "unknown" by design —
  surfaced honestly by the margin layer's costed/uncosted split, not
  guessed. Next foundation: **F2 (metrics + threshold-alert substrate)**.

### F2 · Metrics-snapshot + threshold-alert substrate — **M**

- **Why:** KPI alerting, the owner digest, and goal pace-tracking all
  need a daily rollup to diff against, and a push channel.
- **Build:** `metrics_daily` table (one row/day of headline KPIs:
  revenue, net collections, denial rate, churn, NPS, A/R buckets,
  adherence cohort sizes — all already computed by existing endpoints,
  just persisted). A `metrics-snapshot.nightly` worker job to populate
  it, and a generic `metric_thresholds` + `metric_alerts` pair with an
  evaluator job. Push via the shared SendGrid client + an in-app alert
  row.
- **Plugs into:** existing analytics route logic (reuse the query
  helpers behind `/admin/analytics/*` and `/admin/billing/*`), new
  `worker/jobs/metrics-snapshot.ts`.
- **Exit:** nightly snapshot persists; a configurable threshold (e.g.
  "denial rate WoW +5pts") fires an email + in-app alert; **derives
  from event tables, never `audit_log`.**
- **Status (2026-05-31):** ⏳ in progress. Landed: migration
  `0187_metrics_substrate` (`metrics_daily` keyed `(date, key)` rollup +
  `metric_thresholds` + `metric_alerts`, all RLS deny-all) and the pure
  `evaluateThreshold` logic in `@workspace/resupply-domain` (absolute /
  `delta_7d` / `delta_pct_7d` modes, baseline-safe); and the nightly
  **`metrics.daily-snapshot`** worker job (06:30 UTC) writing the first
  KPI set (orders + gross/refunded/net revenue from `shop_orders`) into
  `metrics_daily`, idempotent on the `(date, key)` PK and extensible to
  more KPIs; and the **`metrics.alerts-evaluator`** job (06:45 UTC) that
  runs each enabled threshold's latest + 7-day-baseline values through
  `evaluateThreshold` and writes idempotent `metric_alerts` on a breach.
  Next: the email notifier (shared SendGrid digest of new alerts) + an
  admin alert-feed endpoint. (F2 nearly complete.)

### F3 · Clinical encounters + RT role + clinician portal shell — **L**

- **Why:** The single biggest missing primitive. There is no surface
  for a clinician to document a patient interaction; today the only
  "notes" are supervisor→CSR coaching notes. This unlocks the entire RT
  cluster.
- **Build:**
  - `clinical_encounters` table (patient_id, author_user_id,
    encounter_type [`mask_fit` | `troubleshoot` | `setup_education` |
    `adherence_intervention` | `phone` | `other`], structured fields
    [reason, assessment, intervention, plan, follow_up_at], free-text
    note, linked alert/episode id). Append-only with edit-history, like
    the existing order/customer notes.
  - **New granular role:** add `rt` (clinician) across the
    `AdminRole` enum/check constraint, `lib/resupply-db/src/types.ts`,
    `lib/resupply-auth/src/rbac.ts`, and `routes/admin/team.ts`
    (`ROLE_VALUES` + `coarseAuthRoleFor`) with `clinical.read`,
    `clinical.note.write`, `clinical.intervention.write`,
    `patients.read`. Coarse `auth.users.role` stays `agent` so the
    existing staff gate admits them.
  - **Clinician portal shell:** a new `/admin/clinical` area
    (AppShell nav entry gated on `clinical.read`) scoped to _flagged /
    panel_ patients rather than the full CSR firehose. Wrap in
    `.admin-root`.
- **Exit:** an RT can open a flagged patient, write a structured
  encounter note, and it persists + audits (counts only); RBAC test
  covers the new role; portal renders only with `clinical.read`.

### F4 · Unified work-item model + lightweight case object — **L**

- **Why:** CSRs juggle ~6 separate triage surfaces. Normalizing them is
  the prerequisite for the unified queue, the cross-channel timeline,
  and a real case/ticket.
- **Build:**
  - A `work_items` **read model** (DB view or materialized rollup) that
    UNIONs the open rows from conversations, followups, inbound faxes,
    shop reviews, product questions, and inbound referrals into one
    shape: `{kind, ref_id, patient/customer_id, channel, priority,
sla_due_at, assigned_to, snippet}`. No new writes — it reads what
    already exists (`inbox-counts.ts` already knows every source).
  - A `cases` table + `case_links` (case ↔ many work-items /
    conversations / orders) so a multi-channel issue ("lost order
    #12345" spanning an SMS, a fax, and a refund) has a persistent home.
- **Exit:** one query returns a unioned, prioritized work list for an
  agent; a case can be opened and linked to ≥2 items; `cases.manage`
  permission exists.

---

## Phase 1 — Quick wins (parallel, no foundation needed)

Thin layers that ship fast and build momentum. All independent; run them
alongside Phase 0.

| #   | Item                                                                                                | Size | Where it plugs in                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 26  | **Therapy-trend sparklines** on the patient panel (90-day usage/AHI mini-charts)                    | S    | `Patient360Panel.tsx`; data already in the therapy-fleet RPCs (`0183_therapy_fleet_daily_metrics.sql`). Render-only.                                                         |
| 36  | **Timely-filing countdown** on every open claim ("X days left to file/appeal")                      | S    | `admin-billing-*` claim rows; derive from `date_of_service` + per-payer filing window in `payer_profiles`. No write.                                                         |
| 14  | **Save-as-macro** from the composer ("save this reply as a macro")                                  | S    | `admin-macros` + `csr-macros-api.ts`; add a POST that snapshots the current draft.                                                                                           |
| 16  | **Agent status toggle** (on-break / do-not-assign)                                                  | S–M  | New `admin_users.availability` field (migration); skill-router (`auto-assign.ts`) skips unavailable agents.                                                                  |
| 18  | **Live queue counts** (real-time badge refresh)                                                     | S    | `inbox-counts.ts`; add SSE or shorten poll + optimistic decrement on claim.                                                                                                  |
| 8   | **Goal / target tracking** (set a monthly net-collections / new-patient target, watch pace-to-goal) | S    | New `business_targets` table; basic version ships standalone, pace automation lands with **F2**.                                                                             |
| 27  | **Setup-guidance checklist** for new patients (humidifier / ramp / mask-seal, check off on a call)  | S–M  | Standalone `setup_checklists` table now; later attaches to the **F3** encounter note.                                                                                        |
| 34  | **Fee-schedule bulk upload** (paste/CSV import of payer fee updates)                                | S–M  | `payer_fee_schedules` (`0129_billing_enhancements.sql`) already exists; add an import route + validation. Variance detection already consumes it.                            |
| 37  | **Webhook re-delivery UI** (reprocess a failed ERA/ACK without engineering)                         | S–M  | Director summary already tracks queued/exhausted webhook counts; add a list + "reprocess" action over the pg-boss DLQ.                                                       |
| 13  | **Conversation full-text search** (search thread _content_, not just status/channel)                | M    | Postgres FTS / `pg_trgm` index on message bodies; new search param on the conversations list route. PHI stays server-side; results are snippets.                             |
| ★   | **Fix the broken CSR-productivity report** (re-derive from event tables, not `audit_log`)           | M    | `/admin/analytics/csr-productivity`; rebuild on `conversations` + `insurance_claim_events` + returns events. Unblocks a currently-dead page and sets the pattern for §RT-24. |

---

## Phase 2 — Owner financial intelligence (needs F1 + F2)

The owner's blind spot is money/margin/forward-looking. These turn
revenue-only reporting into a real P&L view. Parallelizable with Phases
3–5.

| #   | Item                                                                                                     | Size | Notes                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Gross-margin / COGS dashboard** (margin $ and % by SKU, category, order)                               | M    | Reads **F1** cost snapshots; new `/admin/analytics/margin` + page. The most important missing number.                                                                   |
| 2   | **Payer-mix profitability** (net-yield by payer: billed→allowed→collected minus cost-to-collect)         | M    | Joins `insurance_claim_events` + denial/appeal counts + **F1**; new `/admin/billing/payer-profitability`. Answers "stay in-network with Payer X?"                       |
| 3   | **LTV & CAC cohort economics** (lifetime value per patient; acquisition cost by source)                  | L    | Cohorts from signup month + a new `referrals_attribute` attribution table for channel; **F1** for margin-based LTV. Aggregates only.                                    |
| 7   | **Inventory turnover & stockout-cost** view                                                              | M    | Reconciliation + Stripe stock counts already exist; add turnover (COGS ÷ avg inventory, from **F1**) and "revenue lost to stockouts" from back-in-stock demand signals. |
| 5   | **KPI threshold alerting** (push when denial rate spikes, churn jumps, claims stall)                     | M    | Consumes **F2** thresholds/evaluator; ships the owner-facing config UI + alert feed.                                                                                    |
| 6   | **Weekly owner digest email** (one screen: revenue, margin, A/R, denial trend, churn, NPS, biggest fire) | S–M  | **F2** snapshot + the existing Claude summarizer (same one used for post-call summaries); send via shared SendGrid client.                                              |
| 8   | **Goal pace automation** (auto pace-to-goal vs. target)                                                  | S    | Enriches the Phase-1 `business_targets` with **F2** daily actuals.                                                                                                      |

---

## Phase 3 — RT clinical workflow (needs F3)

Turns monitoring into _intervention_. All build on the F3 encounter +
role.

| #   | Item                                                                                                             | Size | Notes                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21  | **Structured non-adherence intervention plan** (capture _why_ usage dropped + the plan; track whether it worked) | M    | New encounter_type `adherence_intervention`; links the fleet alert → assessment (mask leak / claustrophobia / pressure intolerance / motivation) → plan → follow-up; re-checks outcome against therapy metrics. |
| 22a | **Mask-fit confirmation loop — capture** (post-fit feedback: seal good / leaking / uncomfortable)                | M    | Patient-facing micro-survey (storefront, post-order) + RT-side entry in the encounter; `mask_fit_outcomes` table. (The _feedback→rec-engine_ learning loop is §6/22b.)                                          |
| 23  | **Clinical-alert patient outreach, RT-approved** (high-AHI / high-leak alerts reach the patient safely)          | M    | Today only low-usage nudges go out. Extend `therapy-fleet-alerts-scan.ts` so an RT can review→approve a templated clinical-flag outreach; consent/DND/frequency-cap gated (ground rule 8).                      |
| 24  | **Per-RT outcomes dashboard** (patients managed, adherence lift, interventions that worked)                      | M    | Derives from `clinical_encounters` + therapy-metrics RPCs — **never `audit_log`** (ground rule 4). Same pattern as the Phase-1 productivity-report fix.                                                         |

---

## Phase 4 — CSR unified workspace (needs F4)

Collapses the six fragmented inboxes into one workspace.

| #   | Item                                                                                                      | Size | Notes                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | **Unified, prioritized work queue** ("everything waiting on you, most-urgent first," across all channels) | M    | Renders the **F4** `work_items` model; filters/sort by SLA/urgency; one screen replaces six triage surfaces.                                       |
| 12  | **Cross-channel customer timeline** ("everything this person contacted us about in 30 days")              | M    | Reads **F4** unioned events for one patient/customer into `Patient360`/`Customer360`.                                                              |
| 17  | **Case / ticket surfacing** (a multi-channel issue with a persistent home)                                | M    | UI over the **F4** `cases` table; open a case from any work-item, link related threads/orders.                                                     |
| 11  | **Click-to-dial + call-back queue** (dial from the patient panel; auto-log disposition)                   | L    | Outbound via `lib/resupply-telecom` Twilio client; call-back queue ties to followups/**F4**; post-call disposition writes a note (no PHI in logs). |
| 15  | **AI reply drafting in the composer** (suggest a reply grounded in the patient's therapy + order context) | M    | Reuse the Claude provider (`selectLlmProvider()`); draft is editable-before-send; PII redaction via existing `chatbotPii.ts` pattern.              |

---

## Phase 5 — Biller automation (mostly independent)

Targets the manual 10–20% the modern pipeline doesn't yet cover. Note:
A/R aging, DSO-by-payer, denial-rate trends, and a denials _page_
**already exist** — so the denials item below is the _worklist UX_, not
the data.

| #   | Item                                                                                                          | Size | Notes                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 28  | **Automated secondary / COB claims** (auto-drop the secondary when the primary 835 posts)                     | L    | The 837P builder already emits 2320/2330 COB loops; add a trigger in `era-reconciler.ts` → build+queue the secondary 837P. Biggest single time-saver for a Medicare book.      |
| 29  | **CMN / DIF generation** (Certificates of Medical Necessity / Detailed Item Forms)                            | L    | Entirely absent today. New doc templates fed by data already held (HCPCS, dx, prescriber NPI, sleep study); render via the existing PDF path used for appeal letters.          |
| 30  | **Patient-statement automation** (batch + schedule)                                                           | M    | `patient_billing_statements` table + PDF render already exist; add a `statements.nightly` job + schedule, with the Stripe pay-link already generated. Email via shared client. |
| 31  | **Scheduled / batch eligibility** (re-verify the panel monthly; auto-check coverages near `termination_date`) | M    | Extend the 270 path + `eligibility-checks` route with a worker job; respect the existing 10/15-min rate limit per coverage.                                                    |
| 32  | **Manual / adjustment claim entry** (key a corrected / void-replacement / paper-backup claim)                 | M    | New "manual claim" route + UI feeding the same draft→scrub→submit pipeline; every claim today originates from a fulfillment, this is the exception path.                       |
| 33  | **Denials _worklist_** (prioritized by recoverable $ × win-probability, AI action inline)                     | M    | Data + AI analyzer (`claim_denial_analyses`) already exist; build the ranked queue UX with one-click resubmit/appeal.                                                          |
| 35  | **Prior-auth expiry → auto-renewal nudge**                                                                    | S–M  | Extend the existing `prior-auth-expiry-sweep.ts` job from "flag" to "draft a renewal + nudge the biller."                                                                      |

---

## Phase 6 — Advanced, data-dependent & content (last)

These need accumulated data from earlier phases or new content/vendors.

| #   | Item                                                             | Size | Notes                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | **Revenue forecast / cash-flow projection**                      | L    | The entitlement engine already knows every patient's next-eligible date — a deterministic forward order book. Combine with **F1** margin + A/R "money in flight" for a real projection. Needs a little history to calibrate confirm-rates.                                                         |
| 22b | **Mask-fit feedback → rec-engine tuning loop**                   | M–L  | Once §3 (22a) has accumulated `mask_fit_outcomes`, feed real seal/comfort results back to calibrate `recommendationEngine.ts` weights. Closes the loop the engine flies blind on today.                                                                                                            |
| 25  | **Short-video education library** (mask fitting, ramp, cleaning) | M    | Content-heavy; new vendor (video hosting) must be **fail-soft** (ground rule 9). Surfaced in the storefront learn pages + sendable from an RT encounter.                                                                                                                                           |
| 9   | **Compliance reporting reinstatement** _(optional / strategic)_  | XL   | ⚠️ HIPAA/DMEPOS/ACHC machinery was **deliberately retired** (migration 0156); compliance is handled out-of-band by the owner. Rebuilding any of it is an **architectural reversal**, not a feature — **gated behind an explicit owner decision**, not auto-included. Listed for completeness only. |

---

## Sequencing & parallelization

```
        ┌─────────────────────────── Phase 0 (foundations) ───────────────────────────┐
        │  F1 cost   F2 metrics   F3 clinical+RT role   F4 work-items+cases            │
        └───────────────────────────────────┬──────────────────────────────────────────┘
                                             │  (Phase 1 quick wins run in parallel here)
        ┌───────────────┬────────────────────┼────────────────────┬───────────────────┐
        ▼               ▼                     ▼                    ▼                   ▼
   Phase 2 Owner   Phase 3 RT          Phase 4 CSR          Phase 5 Biller     (Phase 1 tail)
   (needs F1,F2)   (needs F3)          (needs F4)           (mostly indep.)
        └───────────────┴────────────────────┴────────────────────┘
                                             ▼
                                 Phase 6 (needs accumulated data / content)
```

- **One engineer:** ~6–8 months end-to-end (Phase 0 ≈ 3–4 wks, Phase 1
  ≈ 2–3 wks overlapping, Phases 2–5 ≈ 4–6 wks each, Phase 6 ≈ 3–4 wks).
- **Two-plus engineers:** after Phase 0, the Owner / RT / CSR / Biller
  tracks barely overlap — split them and the calendar compresses to
  ~3–4 months. Phase 1 quick wins are good "between bigger items"
  filler.
- **Hard ordering:** F1→Phase 2, F3→Phase 3, F4→Phase 4 are real
  blockers. Phase 5 (biller) has the fewest dependencies — a good
  early-parallel track. Phase 6 genuinely needs the earlier data to
  exist.

## Risks & watch-items

- **Migration-number collisions** on a multi-PR program (see ground
  rule 1) — the most likely day-to-day friction. Claim numbers late.
- **RBAC role sprawl:** adding `rt` is clean, but audit the rbac catalog
  so the new clinical permissions don't accidentally widen `agent`.
- **PHI discipline** on every new analytics/outcomes endpoint
  (aggregates only) and every new log line (no order bodies, no image
  bytes). The productivity-report fix and §RT-24 are the easiest places
  to slip back into an `audit_log`-shaped habit — don't.
- **Service-boot decoupling:** the video-library vendor (§25) and any
  new outbound channel must degrade, never block the listener.
- **Don't re-couple health checks** to new dependencies; keep
  `/resupply-api/healthz` dependency-free.

## All 37 items at a glance

| #   | Persona | Item                               | Phase  | Size    | Key dependency  |
| --- | ------- | ---------------------------------- | ------ | ------- | --------------- |
| F1  | shared  | Cost / COGS capture                | 0      | M       | —               |
| F2  | shared  | Metrics + threshold substrate      | 0      | M       | —               |
| F3  | shared  | Clinical encounters + RT role      | 0      | L       | —               |
| F4  | shared  | Work-item model + cases            | 0      | L       | —               |
| 1   | Owner   | Gross-margin / COGS dashboard      | 2      | M       | F1              |
| 2   | Owner   | Payer-mix profitability            | 2      | M       | F1              |
| 3   | Owner   | LTV & CAC cohort economics         | 2      | L       | F1              |
| 4   | Owner   | Revenue / cash-flow forecast       | 6      | L       | F1, eligibility |
| 5   | Owner   | KPI threshold alerting             | 2      | M       | F2              |
| 6   | Owner   | Weekly owner digest                | 2      | S–M     | F2              |
| 7   | Owner   | Inventory turnover & stockout cost | 2      | M       | F1              |
| 8   | Owner   | Goal / target tracking             | 1→2    | S       | F2 (pace)       |
| 9   | Owner   | Compliance reporting _(optional)_  | 6      | XL      | owner decision  |
| 10  | CSR     | Unified work queue                 | 4      | M       | F4              |
| 11  | CSR     | Click-to-dial + call-back queue    | 4      | L       | F4, telecom     |
| 12  | CSR     | Cross-channel customer timeline    | 4      | M       | F4              |
| 13  | CSR     | Conversation full-text search      | 1      | M       | —               |
| 14  | CSR     | Save-as-macro                      | 1      | S       | —               |
| 15  | CSR     | AI reply drafting                  | 4      | M       | —               |
| 16  | CSR     | Agent status toggle                | 1      | S–M     | —               |
| 17  | CSR     | Case / ticket object               | 4      | M       | F4              |
| 18  | CSR     | Live queue counts                  | 1      | S       | —               |
| 19  | RT      | Clinical encounter note            | 0 (F3) | L       | —               |
| 20  | RT      | RT role & portal                   | 0 (F3) | L       | —               |
| 21  | RT      | Non-adherence intervention plan    | 3      | M       | F3              |
| 22  | RT      | Mask-fit confirmation loop         | 3 / 6  | M / M–L | F3 / §22a       |
| 23  | RT      | Clinical-alert patient outreach    | 3      | M       | F3              |
| 24  | RT      | Per-RT outcomes dashboard          | 3      | M       | F3              |
| 25  | RT      | Short-video education library      | 6      | M       | vendor          |
| 26  | RT      | Therapy-trend sparklines           | 1      | S       | —               |
| 27  | RT      | Setup-guidance checklist           | 1      | S–M     | —               |
| 28  | Biller  | Automated secondary / COB claims   | 5      | L       | —               |
| 29  | Biller  | CMN / DIF generation               | 5      | L       | —               |
| 30  | Biller  | Patient-statement automation       | 5      | M       | —               |
| 31  | Biller  | Scheduled / batch eligibility      | 5      | M       | —               |
| 32  | Biller  | Manual / adjustment claim entry    | 5      | M       | —               |
| 33  | Biller  | Denials worklist                   | 5      | M       | —               |
| 34  | Biller  | Fee-schedule bulk upload           | 1      | S–M     | —               |
| 35  | Biller  | PA expiry → auto-renewal nudge     | 5      | S–M     | —               |
| 36  | Biller  | Timely-filing countdown            | 1      | S       | —               |
| 37  | Biller  | Webhook re-delivery UI             | 1      | S–M     | —               |
| ★   | shared  | Fix broken CSR-productivity report | 1      | M       | —               |

_That's all 37 brainstormed features + the 4 foundations + the
productivity-report fix, every one placed in a phase with a size and its
blocking dependency._
