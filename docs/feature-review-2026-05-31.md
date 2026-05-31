# Feature Review & Improvement Opportunities — 2026-05-31

**Audience:** Penn Home Medical Supply ownership + engineering.
**Method:** Aligned to `origin/main`, then fanned out a full read of the
five product surfaces (customer storefront, admin console, in-process
worker + voice agent, AI/integrations layer, and cross-cutting gaps) and
**spot-verified the load-bearing claims against current code** rather
than trusting the (fast-moving) planning docs in `docs/`. Several items
flagged as "open" in
[`dme-resupply-automation-research-and-recommendations-2026-05-30.md`](./dme-resupply-automation-research-and-recommendations-2026-05-30.md)
turned out to be already shipped — those are noted inline so we don't
re-do finished work.

> This doc complements (does not supersede) the 2026-05-30 research doc.
> It re-scopes the Tier-1 recommendations against what's actually in the
> tree as of this date, and records which of them this branch addresses.

---

## 1. What PennFit is today

This is a broad, production-grade DME platform, not a single-purpose
tool. The capability map:

- **Privacy-first CV mask fitter** — on-device MediaPipe facial
  measurement (5 metrics via iris calibration), images never
  transmitted, stateless recommendation engine, 11-question clinical
  flow (`artifacts/cpap-fitter/src/pages/{consent,capture,measure,questionnaire,results,order}.tsx`).
- **D2C storefront** — Stripe catalog/cart/checkout + express
  quick-checkout, subscriptions, wishlist, reviews/Q&A, NPS, Apple
  Wallet, 35+ educational pages, referrals.
- **Deep customer account** — orders, subscriptions, documents, e-sign,
  clinical info, therapy insights, mask-leak/maintenance wizards,
  returns, caregiver proxies, web push.
- **Two customer AI assistants + sleep coach** — public PennBot (with
  live mask-recommend tools), account-scoped bot with per-user DB
  context, personalized sleep coach. Claude-primary, OpenAI fallback,
  offline-safe.
- **Resupply outreach engine** — hourly Medicare-LCD cadence scan, TCPA
  gating, idempotent SMS/email sends, inbound `YES/EDIT/STOP` + AI
  intent fallback, multi-touch fitter "supply campaign" lifecycle FSM,
  escalation ladder.
- **Voice agent** — outbound OpenAI Realtime (cedar) ↔ Twilio bridge, 7
  tools with a hard identity-verification gate, optional Deepgram audit
  transcript, Claude post-call summary + auto-handoff to CSR queue.
- **~99-page admin console / 140+ endpoints** — patient 360,
  conversations inbox with routing/SLA, "My Today" worklist, RT board,
  clinical analytics + KPIs, full **billing suite** (837P/835/277CA/999
  EDI, eligibility 270/271, ERA reconcile, denial catalog, payer
  profiles/fee schedules, AI claim scrubber, capped-rental automation,
  PA/DWO sweeps, PECOS sync), 3-role RBAC with module-load assertions,
  feature flags, reporting.
- **Integrations layer** — 4 therapy-cloud adapters (ResMed/Philips/3B/
  Health Connect), 2 inbound order channels (Parachute HMAC,
  SMART-on-FHIR), 2 payer rails (Office Ally clearinghouse, Da Vinci
  PAS).
- **41 background jobs** — reminders, smart-triggers (leak/AHI/adherence
  detection → nudges), therapy nightly-sync + milestones, coaching-plan
  progress, lifecycle/winback/deductible-reset, claims poller, PHI
  retention sweep, and more.

## 2. Maturity verdict

The platform is **~90% feature-complete, and the team has already
executed most of its own 2026-05-30 roadmap.** Verified against current
code, several items the docs list as "scaffolded but unwired" are done:

- ✅ **HCPCS↔SKU mapping + entitlement enforcement** — `sku_hcpcs_map`
  (migration 0171) + `resolveSkuEntitlement` enforced in the SMS/email
  confirm path (`artifacts/resupply-api/src/lib/messaging/order-flow.ts:160`).
- ✅ **Eligibility 270→271 round-trip is closed** — `dispatch271`
  parses coverage into `eligibility_checks` and a recent fix stopped
  271s being silently dropped
  (`artifacts/resupply-api/src/worker/jobs/office-ally-inbound-poll.ts:634`).
- ✅ **Claims loop** — 837P out + 999/277CA/835 inbound poller + ERA
  reconciler all present.
- ✅ **Nightly therapy sync + adherence alerting** —
  `therapy-integrations.nightly-sync` (04:30 UTC) +
  smart-triggers detecting `leak_rising`/`ahi_elevated`/
  `non_adherent_30d`/`cushion_wear` (`lib/.../smart-triggers/index.ts`).
- ✅ **HTTP timeouts on all therapy adapters, RBAC assertions,
  bundle-size, lint** — the older audit's "HIGH" items are fixed.

So the right framing for "what to improve / add" is the **next layer**,
not the already-built one.

## 3. Tier-1 gaps still open (verified) — and what this branch does

| #   | Opportunity                                              | Verified status before this branch                                                                                                                                                                                                               | This branch                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Rich magic-link confirmation page**                    | The two-step `GET` landing (due-items + category chips) → `POST` confirm/edit/stop flow already exists (`routes/email/click.ts`, `lib/resupply-messaging` `renderClickLanding`). The remaining delta from the 05-30 doc was **product visuals**. | Adds a per-category product **visual** (inline-SVG icon, with an optional real-photo `imageUrl` slot) to every due-item card. Respects the existing "no PHI on a forwardable page" rule — the address is **not** echoed.                                                                                         |
| 2   | **Consult the eligibility result at order/confirm time** | The 270/271 loop now lands a parsed coverage row, but `getCachedEligibility()` had **zero callers** outside its test — the cadence half was enforced, the **coverage** half wasn't.                                                              | Adds a fail-open, feature-flagged **coverage guard** in `order-flow.ts` mirroring the entitlement guard: a cached 271 saying _not active_ / _PA required_ raises a `csr_compliance_alert` and routes the conversation to the CSR queue instead of auto-shipping. Defaults **off** until 270/271 data is flowing. |
| 3   | **Inbound "call to reorder" IVR**                        | Outbound-only. The Realtime bridge, 7 tools, and the DOB identity gate exist; only an inbound entrypoint was missing.                                                                                                                            | Adds an inbound Twilio voice webhook that resolves the caller's phone → patient, opens an inbound voice session, and connects it to the existing bridge with an inbound-tuned greeting.                                                                                                                          |

## 4. Tier-2 — improve what's already there

- **Storefront ↔ resupply bridge.** A storefront `orders` purchase does
  not create a resupply episode/fulfillment, so CSRs reconcile two
  queues and storefront buyers aren't on a tracked reorder cadence.
- **Insurance estimate that learns.** The estimate uses a static
  `PAYER_ESTIMATES` table; real `claims` + paid amounts can compute
  P50/P90 patient OOP per (payer, SKU).
- **Close the mask-recommendation loop.** The recommender is an
  open-loop static formula; returns/NPS/refit signals are captured but
  never feed back. A `mask_outcome_signals` table + weekly score-nudge
  job improves recommendation quality (no ML needed).
- **Predictive denial scoring at claim preflight.** The AI scrubber +
  denial-code catalog + claim history already exist — surface "payer X
  denies E0601 without KX 38% of the time" before submission.
- **`patient-detail.tsx` is ~4,556 LOC.** ADR-020 sets a LOC budget but
  it isn't CI-enforced; decomposition is regressing under the feature
  wave.

## 5. Tier-3 — net-new ideas

- **Per-claim patient payment in the portal** (`account-billing.tsx:199`
  defers it; the claims suite + `billing_statements` exist to support
  it).
- **Card-update flow** (saved cards are read-only today; a $0 SetupIntent
  route fixes it).
- **Cash-pay membership tier** (free shipping + % off + Rx-renewal) on
  `shop_customers`.
- **Sleep coach grounded in real therapy data** (the coach exists; feed
  it the last-7-day snapshot — depends on therapy data flowing).
- **CSR-productivity metrics replacement** (the analytics tile is
  intentionally degraded since the `audit_log` tamper-chain was dropped;
  a lightweight per-operator event log would restore it).

## 6. The one strategic risk worth naming

All four therapy-cloud adapters are production-quality **but their API
endpoint paths are placeholders pending partner specs/contracts.** Until
ResMed/Philips/3B onboarding completes, live device data can only arrive
via Health Connect (patient-push) or stubs — and adherence monitoring,
smart-triggers, coaching plans, and the RT board all depend on that
data. This is a business/contract blocker, not a code one, but it gates
a whole value pillar and is worth tracking explicitly.

## 7. Smaller polish (low effort, still valid)

- Drop the double-consent moment (`/consent` then `/order`); pre-fill
  `/order` for signed-in shoppers; in-app redirect for
  `/reminders/manage` when signed in (see
  [`process-simplification-review-2026-05-21.md`](./process-simplification-review-2026-05-21.md)).
- Auto-action obvious admin queues: auto-approve low-risk RMAs, schedule
  cart-abandonment (a cron exists but is flag-gated off), daily
  failed-order-email digest.
- `maskCatalog.ts` is ~1,589 LOC of hardcoded data → move to DB.
- Da Vinci PAS mTLS + auto-submit trigger, Parachute Phase-5 callbacks,
  and an OpenAI fallback for inbound-referral AI classification are all
  small, clearly-scoped follow-ups.
