# PennFit App Review — Current State + Engineering-Health Enhancements — 2026-06-09 (PM)

**Audience:** Penn Home Medical Supply ownership + engineering.
**Goal:** A complete review of the app as it stands **after PRs #629–#635
merged**, and a prioritized list of enhancement opportunities. The repo
already has an excellent product/growth review from this morning
([`app-review-customer-growth-clinical-billing-2026-06-09.md`](./app-review-customer-growth-clinical-billing-2026-06-09.md))
and the persona gap map from 06-07
([`feature-review-and-gap-research-2026-06-07.md`](./feature-review-and-gap-research-2026-06-07.md)).
This document does **not** re-derive those. Its two original contributions:

1. **A shipped-status reconciliation** — most of what the corpus still lists
   as "open" has since shipped; the backlog docs are now materially stale
   (§2).
2. **An engineering-health review** — security hardening, worker/job
   reliability, frontend quality, SEO, and test/CI posture — the lens the
   existing corpus under-covers (§3–§6). Every finding below was produced by
   a code sweep this session and the headline items were independently
   re-verified against source (false positives from the sweep were dropped;
   the notable ones are recorded in §7 so they aren't re-reported later).

**Method:** Four parallel code audits (backend security/code health, frontend
SPA quality, worker + data-layer reliability, shipped-item verification +
test/CI health), cross-checked against the prior `docs/` review corpus, with
manual re-verification of each headline claim.

---

## 1. What the app is today (brief)

PennFit is a production-grade DME/CPAP-resupply platform: a privacy-first
storefront SPA (~60 patient pages, on-device MediaPipe mask fitter — images
never transmitted), an admin console (~115 pages, ~343 route files), an
in-process pg-boss worker (55 job modules + an OpenAI-Realtime↔Twilio voice
agent), a full X12 5010 billing suite (837P/835/270-271/276-277/PAS), four
therapy-cloud integrations, and a Claude/OpenAI AI layer with offline-safe
fallback. The 06-07 review's verdict stands and has strengthened: the basics
are built, and since then the **last-mile billing gaps it flagged have been
closed** (see §2).

---

## 2. Shipped-status reconciliation (corrects the morning doc)

Verified in code this session. Items the corpus lists as 🔴 open that are now
**SHIPPED**:

| Item (corpus tag)                       | Status now   | Evidence                                                                                                                                                                                              |
| --------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbound fax (C-B1 / B1)                | ✅ SHIPPED   | Telnyx Programmable Fax client `lib/resupply-telecom/src/telnyx-fax.ts` (`sendFax()`); `routes/admin/physician-fax-outreach.ts`. Inbound returned-fax auto-file + barcode landed in #633/#635.        |
| 276/277 claim-status inquiry (B-3 / B3) | ✅ SHIPPED   | `lib/resupply-integrations-office-ally/src/edi/276.ts` builder; `routes/admin/claim-status.ts`; 277 dispatch in `office-ally-inbound-poll.ts`.                                                        |
| CMN/DWO/SWO PDF generation (C-B2 / B4)  | ✅ SHIPPED   | `routes/admin/dwo-documents.ts` renders/streams via `lib/billing/dwo-pdf` (`renderDwoPdf()`); form types `dwo`, `cmn_484`, `cmn_843`, `swo`.                                                          |
| Acquisition-funnel dashboard (G1)       | ✅ SHIPPED   | `routes/admin/acquisition-funnel.ts` reads the `acquisition_funnel_steps` RPC over `usage_events`; admin page wired.                                                                                  |
| Card-on-file + autopay (G4)             | ✅ SHIPPED   | #634: `pages/account-billing.tsx` saved-card + autopay toggle; workers `patient-autopay-charge.ts`, `payment-plan-autocharge.ts` (triple-gated: opt-in cron, seeded-OFF flag, per-patient authorize). |
| Installments / financing (B7 / C-B3)    | ✅ SHIPPED   | `lib/billing/payment-plan-autocharge.ts` + worker; off-session Stripe charges, inert by default.                                                                                                      |
| RT cohort campaign targeting (C-R1)     | ✅ SHIPPED   | `routes/admin/bulk-campaigns.ts` `audienceKind='by_therapy_cohort'` (low_adherence / no_checkin_response / at_risk) via `lib/bulk-campaigns/resolve-audience.ts`.                                     |
| HSAT capture (C-R3)                     | ✅ SHIPPED\* | `routes/patients/sleep-studies.ts` (`study_type='hsat'`, `source='home_test_vendor'`) + patient self-report `routes/shop/me-sleep-study.ts`. \*In-funnel _vendor ordering_ still partner-gated.       |
| Provider e-signature                    | ✅ SHIPPED   | #629 secure provider e-sign portal with MFA.                                                                                                                                                          |
| Statement delivery (emailed vs mailed)  | ✅ SHIPPED   | #631.                                                                                                                                                                                                 |

Still genuinely **open** from the product corpus (carried forward, not
re-derived — anchors in the 06-07/06-09 docs):

- **NPS→review-request / referral→reward loop closure** — PARTIAL. Collection
  and attribution exist (`nps-summary.ts`, `referrals-attribute.ts`); the
  promoter→review ask and reward-conversion closure are not wired. (S)
- **Unified clinical comms timeline** (C-R2/R3) — PARTIAL. Clinical encounters
  and the customer timeline exist as separate surfaces; no merged RT view. (M)
- **Wave-0 activation decisions** (unchanged): `storefront.auto_reminder_enrollment`
  consent decision, cart-abandonment/escalation crons, ResMed/Philips BAAs.
- Owner-scale items: multi-location (O1, L), GL auto-posting (O3, M),
  real-time CSR alerting (C1, S–M), inbound sentiment hint (C4, S),
  call-recording archive (C5, S–M), in-composer KB search (C6, S),
  DME onboarding checklist (O5, S), ML adherence model (data-gated).

**Action:** the recommended-sequencing sections of the 06-07 and 06-09 docs
should be read through this table — Waves 1–2 are substantially done.

---

## 3. Security hardening (backend)

Posture is strong overall — verified handled-well: global error redaction +
request-ID correlation (`middlewares/errorHandler.ts`), layered admin MFA
brute-force limits (`routes/admin/mfa.ts`), Stripe signature verification via
the SDK's timing-safe check, pre-auth IP-keyed admin rate limiting, Twilio
signature + per-phone limiter on SMS inbound (`routes/sms/inbound.ts`),
1MB-capped MIME-checked uploads, `uncaughtException`/`unhandledRejection`
handlers with log flush. Remaining hardening, highest-confidence first:

| #   | Finding                                                                                                                                                                                                                                                                       | Effort | Anchor                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| S1  | **IDOR source-check tests for the 40+ signed-in `shop/me/*` routes.** They scope by `req.userCustomerId`, but unlike the patient AI routes there is no test asserting every `me-*.ts` filters on the session customer id. One missed `.eq()` is a silent cross-customer leak. | S      | `routes/shop/me-*.ts`; pattern exists in `routes/patients/insurance-claims-ai-idor.test.ts`                       |
| S2  | ~~Zod-validate TwiML callback query params~~ — **withdrawn on implementation review** (§7): `day` is allowlisted, `patientId` is UUID-checked at the press callback, `ref` is an opaque server-side store key, and all output is XML-escaped behind Twilio signature checks.  | —      | `routes/voice/checkin-twiml.ts:58-74,131`, `routes/voice/alert-twiml.ts:63-77`                                    |
| S3  | **Centralize signed-link token TTLs.** Patient-packet (30d), fax-document, fitter-invite, and mask-fit tokens each hard-code their own TTL; a single config point (env-overridable) prevents one long-TTL outlier extending a leaked-link window.                             | S      | `lib/patient-packet-token.ts`, `lib/fax-document-token.ts`, `lib/fitter-invite-token.ts`, `lib/mask-fit-token.ts` |
| S4  | ✅ **Verified (this PR): delegated webhook signature checks are timing-safe.** SendGrid uses ECDSA `crypto.verify`, Telnyx fax uses Ed25519 `crypto.verify`, Twilio uses `timingSafeEqual` — all constant-time by construction. No change needed.                             | done   | `lib/resupply-email/src/signature.ts:137`, `lib/resupply-telecom/src/{telnyx-signature.ts:110,signature.ts:35}`   |
| S5  | **`.strict()` sweep on admin mutation schemas.** 258 `safeParse` calls across 167 files — adoption is broad, but older schemas without `.strict()` silently accept extra fields. A lint rule or source-grep CI check closes it permanently.                                   | M      | `routes/admin/**` (pattern check, like `check-admin-route-gates.sh`)                                              |
| S6  | **Reject unknown webhook `eventType`s with 400** instead of `.passthrough()` persistence in the partner integrations webhook.                                                                                                                                                 | S      | `routes/integrations-webhooks.ts:116`                                                                             |
| S7  | ✅ **Implemented (this PR): measure the graceful-shutdown drain.** The `shutdown: complete` log now carries `httpDrainMs` / `httpClosedInTime` / `workerStopMs` / `totalMs` / `budgetMs` so ops can see when the 25s budget runs hot against Railway's 30s grace.             | done   | `artifacts/resupply-api/src/index.ts` (`shutdown()`)                                                              |

---

## 4. Worker / job reliability

Verified handled-well: send-job idempotency (dedup keys TTL 22h, atomic
status claims, UNIQUE constraints), bulk-campaign stale-`sending` lease
reclaim, chunked RPCs, fail-open DB-write posture after vendor accept, DLQ
queues configured per job. pg-boss `schedule()` dedupes cron fires
internally and Railway runs a single replica, so cron double-fire is **not**
a current risk (revisit only if replicas scale). Real gaps:

| #   | Finding                                                                                                                                                                                                                                                                                               | Effort | Anchor                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| W1  | ~~Re-check opt-out immediately before SMS/email vendor call~~ — **withdrawn on implementation review** (§7): STOP pauses the patient (`status='paused'`) and both send helpers re-fetch the patient row and reject non-active status _inside_ the send function, milliseconds before the vendor call. | —      | `send-sms.ts:53-64`, `send-email.ts:53-61`; STOP → `pausePatient` in `routes/sms/inbound.ts` |
| W2  | **Sustained-failure alerting on integration crons.** Therapy nightly sync and the Office Ally poller log "unavailable, skipping" but return ok — three days of vendor downtime looks like 72 green runs. Track consecutive-failure count and surface it on `/admin/operations` after N≥3.             | M      | `worker/jobs/therapy-integrations-nightly-sync.ts`, `office-ally-inbound-poll.ts`            |
| W3  | **DLQ visibility in the admin console.** Dead-letter inspection currently requires raw SQL against `pgboss_resupply.job`. A small `/admin/operations` panel (per-queue DLQ counts + sample payload + requeue) makes on-call diagnosable without DB access.                                            | M      | `worker/lib/queue-options.ts:38` (documents the SQL)                                         |
| W4  | **Auto-disable persistently failing webhook subscriptions.** Outbound webhook dispatch retries 8× with backoff per delivery; a permanently-broken subscriber URL consumes delivery slots forever. After N consecutive terminal failures, set `is_active=false` with a reason and surface it.          | M      | `worker/jobs/webhook-dispatcher.ts:282`                                                      |
| W5  | **Timeout/abort on LLM + RPC calls inside jobs.** The AI denial analyzer and chunked-RPC jobs have per-call timeouts in places but no consistent abort posture; a hung vendor call burns the job's wall clock. Standardize `AbortSignal.timeout()` per external call in job context.                  | M      | `lib/billing/ai-denial-analyzer.ts:173`, `worker/jobs/deductible-reset-push.ts:145`          |
| W6  | **Respect `Retry-After` on SendGrid 429 in bulk-campaign ticks** instead of generic exponential backoff.                                                                                                                                                                                              | M      | `worker/jobs/bulk-campaign-tick.ts:96`                                                       |
| W7  | ✅ **Implemented (this PR), reclaim half: stale-`sending` reclaims now log a warn with `reclaimedCount`** (each reclaim implies a crashed/killed prior tick). The cron-overlap warning half is folded into W2's observability work — it needs the same per-job run-state tracking.                    | done/M | `worker/jobs/bulk-campaign-tick.ts` (reclaim block); overlap → W2                            |

Carried over from [`performance-review-2026-06-05.md`](./performance-review-2026-06-05.md)
(still open, not re-derived): `count:'exact'`→`'estimated'` on hot dashboards,
the two missing billing indexes, and the `.limit(20000)` in-memory aggregation
caps.

---

## 5. Frontend quality (storefront + admin SPA)

Verified handled-well: route-level code splitting with lazy-retry recovery,
error boundaries, React Query data layer, eager-Home-only LCP strategy,
near-strict TS (`noImplicitAny` + `strictNullChecks` on). Gaps:

| #   | Finding                                                                                                                                                                                                                                                                                                                                                   | Effort | Anchor                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| F1  | ✅ **Implemented (this PR).** Was: hand-written sitemap with 13 URLs, only 3 of 30 `learn-*` pages. Now lists all 62 public content routes, and a drift test (`sitemap.drift.test.ts`) fails CI when a public route in `App.tsx` is missing from the sitemap (or vice versa) — chosen over a build step to keep `public/` static and the diff reviewable. | done   | `public/sitemap.xml`, `src/sitemap.drift.test.ts`                   |
| F2  | ✅ **Implemented (this PR).** `Product` + `Offer` + `AggregateRating` JSON-LD already shipped on `/shop/p/:id` (verified). Added `FAQPage` JSON-LD to `/faq` via `useDocumentMeta` — all Q&A entries from `sections` are emitted as `Question`/`Answer` pairs; Google's Rich Results Test can now surface FAQ accordions in SERPs.                       | done   | `pages/faq.tsx` (`Faq` component), `hooks/use-document-meta.ts`     |
| F3  | ✅ **Implemented (this PR).** Added `web-vitals` package + `lib/web-vitals-reporter.ts`; calls `onLCP/onCLS/onINP/onFCP/onTTFB` after root render and pipes each metric (value, rating, navigationType, path) into the existing `/api/usage-events` sink via a new `web_vital` track step. No new vendor or endpoint needed.                          | done   | `lib/web-vitals-reporter.ts`, `main.tsx`, `lib/track.ts`            |
| F4  | **Expand the axe e2e beyond 5 public routes** to a few high-traffic `learn-*` pages and 1–2 admin surfaces (sign-in is covered; dashboards are not).                                                                                                                                                                                                      | M      | `e2e/tests/a11y.spec.ts:23`                                         |
| F5  | ✅ **Implemented (this PR).** `ScrollToTop` now also moves focus to the `#main-content` landmark on every client-side navigation (skipping initial load); the landmark already had `tabIndex={-1}` + focus-visible-only outline, so pointer users see no change.                                                                                          | done   | `components/layout.tsx` (`ScrollToTop`)                             |
| F6  | **MediaPipe model download progress.** The ~5.5MB `face_landmarker.task` loads on `/measure` entry with no progress indicator — on slow connections the fitter looks frozen at its highest-intent moment.                                                                                                                                                 | M      | `public/mediapipe/models/face_landmarker.task`, measure page loader |
| F7  | ~~Hide unpublished video cards~~ — **withdrawn on implementation review** (§7): empty-id videos are already filtered out (and the whole section hides when none are publishable); the "Coming soon" branch is unreachable defensive code.                                                                                                                 | —      | `components/learn-video-library.tsx:35-39`                          |
| F8  | **Distinguish transient vs permanent failure on `/results`.** Both render the same generic error; a Retry button on 5xx/timeout keeps the patient in-funnel at the most expensive drop-off point.                                                                                                                                                         | S      | `pages/results.tsx:200`                                             |
| F9  | **Consolidate query `staleTime` policy.** Admin pages mix 30s/60s ad hoc; one documented default per surface removes confusing tab-to-tab inconsistency.                                                                                                                                                                                                  | S      | `components/admin/*.tsx`                                            |

Deferred (real but L-effort, defer until justified): SSR/prerender for link
unfurls (OG tags are client-injected), offline/workbox caching for the
capture flow.

---

## 6. Test & CI posture

Current state (counted this session): **3 Playwright e2e specs** (storefront
smoke, axe on 5 routes, results resilience); worker jobs **44/55 tested
(~80%)**; route files **217/343 with tests (~63%)**; 10-job CI pipeline with
required lint/typecheck/drift/test/migrations/smoke/railway-build and
soft-gated integration/a11y/e2e-dev/audit. No coverage gate; `pnpm audit`
high-CVE check was non-blocking (now blocking — item 3 below).

Targeted asks (not a coverage program):

1. **E2E happy paths for checkout and fitter→order** — still the top gap, as
   the 06-09 doc's §7 noted; now more pressing because payments
   (card-on-file/autopay) shipped. (M)
2. **Tests for the money-touching untested jobs** — of the 11 untested worker
   jobs, prioritize `office-ally-inbound-poll.ts` (claims ingest),
   `capped-rental-advance.ts`, `dwo-expiry-sweep.ts`, and
   `lapsed-customer-winback.ts`. (S each)
3. ✅ **Implemented (this PR): the CVE audit job is now blocking.**
   `pnpm audit --audit-level=high` reports a clean tree, so
   `continue-on-error` was flipped to `false`; the job comment documents
   the `ignoreCves` escape hatch for unpatchable advisory churn.
4. S1's IDOR source-check test doubles as the shop-route test seed. (S)

---

## 7. False positives dropped (so they aren't re-reported)

Recorded because future sweeps will likely re-surface them:

- "SMS inbound webhooks lack rate limiting" — **wrong**; `routes/sms/inbound.ts`
  has `requireTwilioSignature` + a per-phone limiter (verified line 115–160).
- "Cron jobs can double-fire without `singletonKey`" — pg-boss `schedule()`
  dedupes internally and production is single-replica; hardening only matters
  if replicas scale.
- "tsconfig isn't strict" — `noImplicitAny`, `strictNullChecks`,
  `useUnknownInCatchVariables` are all on (`tsconfig.base.json:12-19`); only
  `strictFunctionTypes` is off.
- Any recommendation to add new `audit_log` writers/readers (e.g. logging CSRF
  failures to audit) — **disallowed by the hard rules**; the audit package is
  a no-op stub by design.

Found during Wave-1 implementation (same PR):

- **S2 "TwiML query params unvalidated"** — `day` is allowlist-validated with
  a safe fallback, `patientId` is Zod-UUID-checked before any DB write,
  `alert-twiml`'s `ref` is an opaque in-process store key that claims a
  server-side script (a miss renders a neutral hangup), and every
  interpolation goes through `escapeXmlText`/`escapeXmlAttr` behind Twilio
  signature verification.
- **W1 "STOP race between enqueue and send"** — STOP sets
  `patients.status='paused'`, and `sendReminderSms`/`sendReminderEmail`
  re-fetch the patient row and reject non-active status inside the send
  function itself; the only remaining window is the milliseconds between that
  select and the vendor call, which no application-level check can close.
- **F7 "Coming-soon video cards shown to customers"** — `LearnVideoLibrary`
  filters empty-id videos at line 35 and hides the entire section when none
  are publishable; the per-card placeholder branch is unreachable defensive
  code (its own header comment says exactly this).
- **S4 resolved as "already handled"** — all three delegated signature checks
  are constant-time by construction (ECDSA / Ed25519 `crypto.verify`,
  `timingSafeEqual` for the Twilio HMAC).

---

## 8. Recommended sequencing

**Wave 0 — decisions (unchanged from the morning doc):** auto-reminder
enrollment consent, cart-abandonment/escalation cron flips, ResMed/Philips
BAAs. Now also: the **autopay/installment activation decisions** that #634
shipped inert.

**Wave 1 — quick wins (XS–S): ✅ done in this PR.**
Implemented: F1 sitemap + drift test · F5 focus reset · W7 reclaim logging ·
S7 shutdown drain timings · CI item 3 (blocking CVE audit).
Resolved without code: S4 (verified timing-safe) · S2, W1, F7 (withdrawn as
false positives — see §7).

**Wave 2 — high-leverage S–M:**
S1 shop/me IDOR tests + CI item 1 (checkout/fitter e2e) — both protect the
newly-shipped payment surface · W2 integration sustained-failure alerting ·
W3 DLQ admin panel · ✅ F2 FAQPage JSON-LD · ✅ F3 Web-Vitals RUM · ✅ F8 results
retry · NPS/referral loop closure (last open S-sized product item).

**Wave 3 — M+:**
S5 `.strict()` sweep · W4 webhook auto-disable · W5 job-call abort posture ·
W6 429 Retry-After · F4 a11y expansion · F6 MediaPipe progress · unified
clinical comms timeline (C-R2) · then the owner-scale product items
(multi-location, GL posting) as business need dictates.

---

_The PR that introduces this document also ships its Wave 1: the full
sitemap + drift test, route-change focus reset, bulk-campaign reclaim
logging, shutdown drain timings, and the blocking CVE audit gate._
