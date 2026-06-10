# Full-app review — 2026-06-10

Whole-app review at `main` = `762786ca` ("fix(cors): reject disallowed
origins with false"). Scope: every artifact and workspace package —
public API, admin API (187 route files), pg-boss worker (50 jobs), auth
stack, DB layer + 262-prefix migration corpus, storefront SPA, admin
console SPA (127 pages), AI/voice/messaging stack, integrations layer,
and deploy/boot posture. The **five P0 fixes (Wave 1)**, the **three
money-safety P1 fixes — P1-1, P1-8, P1-9 (Wave 2)**, and the **three
TCPA/consent P1 fixes — P1-2, P1-3, P1-4 (Wave 3)** ship in this same
PR, each with regression tests; everything else is report-only — each
finding cites file:line so fixes can land as focused follow-ups.

Verification levels used below:

- **[verified-live]** — confirmed against the production host.
- **[verified]** — confirmed by reading/executing the actual code path
  (including one empirical Express middleware-order repro).
- **[needs-verification]** — plausible from code, needs a runtime or
  production-data check before acting.

---

## Verdict

The engineering fundamentals are unusually strong: typecheck, ESLint
(zero warnings), the full Vitest suite (4,961 tests / 471 files), the
architecture + route-gate + migration checks, and `pnpm audit` are all
green at this commit; zero TODO/FIXME markers exist in the source tree;
CI is comprehensive (9 jobs including from-scratch migration replay on
real Postgres and a required Playwright smoke). The headline privacy
invariant — **camera frames never leave the browser** — was traced end
to end and **holds**. PostgREST-injection discipline, webhook signature
hygiene, the boot/shutdown contract, and the migrator are all
production-grade.

But the review found **five P0 bugs that are broken in production right
now** — including the storefront's core feature — plus a cluster of
TCPA/consent and money-safety issues in the worker tier. The app is
_close_ to "best and easiest to use", and the fixes are individually
small; they are listed in recommended order at the end.

---

## P0 — broken in production today (all five FIXED in this PR)

Fixes + regression tests, in this PR:

- P0-1 → `camera=(self)` in `securityHeaders.ts` + `securityHeaders.test.ts`.
- P0-2 → app-level `express.raw()` mounts for both webhook paths ahead
  of the global parser in `app.ts` +
  `app-webhook-raw-body-ordering.test.ts` (goes through the real app).
- P0-3 → `csrfHeader()` on both wrappers in `shop-api.ts` +
  `shop-api-csrf.test.ts`.
- P0-4 → reactive `attachStream()` effect in `capture.tsx` +
  `capture.retry.render.test.tsx`.
- P0-5 → `readQueryParam` reads `window.location.search` in
  `conversations.tsx` / `episodes.tsx` +
  `conversations.deeplink.render.test.tsx`.

### P0-1. `Permissions-Policy: camera=()` blocks the face-scan [verified-live]

`artifacts/resupply-api/src/middlewares/securityHeaders.ts:75-78` emits
`camera=(), microphone=()` on **every** response, and it is mounted
first (`app.ts:62`) — ahead of the SPA static serving (`app.ts:564`)
and the `index.html` fallback (`app.ts:604`). The middleware's own
rationale ("the API serves JSON, not HTML; CSP belongs on the SPA HTML,
served by the static host") predates the May 2026 consolidation that
folded SPA serving into this same process.

Confirmed live: both `https://pennfit.up.railway.app` and
`https://pennpaps.com` return
`permissions-policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()`.
An empty `camera` allowlist on the top-level document denies
`getUserMedia` in Chromium — `capture.tsx`'s face-scan fails with
`NotAllowedError`. The e2e suite can't catch it: it stubs
`navigator.mediaDevices.getUserMedia`
(`e2e/tests/results-page-resilience.spec.ts:62`).

**Fix:** `camera=(self)` (and consider `microphone=(self)` if anything
ever needs it), or scope the strict policy to `/api` + `/resupply-api`
responses and emit an SPA-appropriate policy on HTML/static.

### P0-2. SendGrid event + integrations webhooks always 400 — raw body is consumed by the global JSON parser [verified]

`routes/email/sendgrid-events.ts:48` and
`routes/integrations-webhooks.ts:43,146-150` register
`express.raw({ type: "application/json" })` at **router** level, but
those routers live inside the `/resupply-api` tree mounted at
`app.ts:518` — _after_ the global `express.json()` at `app.ts:256`. The
global parser consumes the stream first; the router-level `express.raw`
no-ops and `req.body` arrives as a parsed object, never a Buffer
(reproduced empirically against the installed Express 5).

Consequences: the SendGrid Event Webhook signature middleware
(`lib/resupply-email/src/signature.ts:206-221`) returns **400 for every
event** — delivery/bounce/dropped status updates silently never happen
— and every integrations-webhook push gets 400
`missing_signature_or_body`. Stripe (`app.ts:224`) and fax
(`app.ts:239`) use the correct pattern: `express.raw` mounted on `app`
_before_ `express.json()`.

Why tests pass: `sendgrid-events.test.ts:71-72` mounts the router
without the app-level parser, so the production middleware order is
never reproduced.

**Fix:** mount both raw-body webhook routes on `app` before
`express.json()` (the Stripe/fax pattern), and make at least one test
mount through the real `app`.

### P0-3. "Update shipping address" and "Resend receipt" deterministically 403 [verified]

`artifacts/cpap-fitter/src/lib/shop-api.ts:655-680`
(`resendOrderReceipt`) and `:697-742` (`updateOrderShippingAddress`)
are the only two signed-in mutation wrappers that don't attach the
`X-PF-CSRF` header. Both server routes are `requireSignedIn` POSTs, and
the app-level conditional CSRF gate (`app.ts:504` →
`requireCsrfWhenSessionOnShopMutations`) enforces the header whenever a
`pf_session` cookie is present — always, for these routes. Result: a
permanent 403 `csrf_failed`, surfaced to the customer as "Something
went wrong. Please try again." (`pages/shop-orders.tsx:1054`). Route
unit tests pass because they mount the router without the app-level
middleware.

**Fix:** spread `csrfHeader()` into both fetches (and add
`credentials: "include"` to `resendOrderReceipt`).

### P0-4. Camera-error "Try again" can never recover; capture page wedges with the camera light on [verified]

`pages/capture.tsx:38-78` + error branch `:173-259`: the error screen
renders without the `<video>` element. "Try again" →
`startCamera()` → on success `if (videoRef.current)` is `null`, so
`srcObject` is never attached; the freshly mounted `<video>` has no
stream, `videoReady` never flips, the button stays disabled on
"warming up", and the stream's tracks stay live (camera indicator on).
Only a full page refresh recovers — and this is the exact path of every
user who just fixed browser permissions per the page's own
instructions. (Compounded by P0-1: on production, _everyone_ currently
lands in this error path.)

**Fix:** attach the stream reactively (effect that sets
`videoRef.current.srcObject` whenever both ref and stream exist), or
keep the `<video>` mounted (hidden) in the error state.

### P0-5. Admin dashboard deep-link filters are silently ignored [verified]

`pages/admin/conversations.tsx:82-89,335-339` and
`pages/admin/episodes.tsx:115-121,720-723` parse query params out of
wouter's `useLocation()` string — but wouter v3 returns **pathname
only** (verified against installed `wouter@3.9.0`), so `readQueryParam`
always returns null. Every KPI tile / quick link on the Home dashboard
(`dashboard.tsx:40-132`) and `admin-operations.tsx:133` lands operators
on the **unfiltered/default** queue while the URL claims otherwise
("Awaiting reply (12)" → unfiltered inbox; "Fulfillments this week" →
the _overdue_ queue). Episodes additionally `replace`-rewrites the URL
on mount (`episodes.tsx:168-176`), destroying the inbound param, so its
own URL-sync feature can never round-trip. `patients.tsx:70` does it
right (`window.location.search`), which is why patient deep links work.

**Fix:** read `window.location.search` at mount or use wouter's
`useSearch()`; seed state before the URL-sync effect first runs.

---

## P1 — high: money safety, TCPA/consent, security posture

Wave 2 (this PR) fixed the three money-safety items:

- **P1-1** → atomic draft → `'submitting'` batch claim before the SFTP
  transmit, with conflict release and transport-failure release back to
  `'draft'` (`office-ally-batch.ts`, migration 0263, new
  `concurrent_submission` result kind mapped to 409).
- **P1-8** → claim-then-send on electronic statements: conditional
  pending/failed → `'sending'` claim in `deliverOnChannel`, conditional
  outcome persist (`statement-send.ts`, migration 0262). A side effect:
  an already-`sent` statement can no longer be re-dispatched at all.
- **P1-9** → CAS claim on the scanned `last_charge_attempt_at` (plus an
  enabled/revoked re-check) before any Stripe call in
  `patient-autopay-charge.ts`; the losing tick backs out before a
  payment row / idempotency key exists.

Wave 3 (this PR) fixed the three TCPA/consent items:

- **P1-2** → `worker/lib/dedup-keys.ts:claimDedupKey` clears EXPIRED
  rows before claiming (the plain INSERT conflicted on stale rows too,
  making the "14-day" therapy-SMS cap permanent), both therapy jobs use
  it, and the daily `idempotency-keys.prune` job now also sweeps
  `worker_dedup_keys` — the sweeper migration 0160 promised.
- **P1-3** → shared `isOutsideSmsSendWindow` gate in `lib/comm-prefs.ts`
  (9am–8pm patient-local; timezone → ZIP → ET fallback), applied to the
  rx-renewal dispatcher, smart-trigger dispatcher, both therapy jobs,
  the onboarding check-in dispatcher (mirroring its voice guard), and
  both fitter jobs (deferring the WHOLE touch so the one-nudge claim
  isn't burned email-only). The six daily night-UTC SMS crons moved to
  staggered 19:xx UTC slots (afternoon in every US timezone) — a gate
  alone on a fixed night-UTC daily cron would skip the same patients
  at the same local hour forever. Quiet-hours skips never claim, so
  the next in-window run sends.
- **P1-4** → the rx-renewal patient resolve now filters
  `status='active'`, so STOP'd/paused patients are never claimed or
  contacted on either channel.

### P1-1. Office Ally claim batch submit can double-transmit claims [verified]

`lib/billing/office-ally-batch.ts:129-141` checks "all claims draft"
read-then-act; claims flip to `submitted` only **after** the SFTP
upload (60s+ × 3 retries). The route
(`routes/admin/billing-batch-submit.ts:38-42`) has no `withIdempotency`
wrapper, and there are four concurrent entry points (manual batch,
resubmit, secondary claims, `auto-submit-batch` worker). Two submits
seconds apart double-transmit the same claims under different ISA13s —
both accepted by the clearinghouse, duplicate claims billed to payers.

**Fix:** optimistic transition before building the EDI
(`UPDATE … SET status='submitting' WHERE id IN (…) AND status='draft'`,
assert affected count, revert on transport failure) + `withIdempotency`
on the route.

### P1-2. `worker_dedup_keys` is never pruned — the "14-day" therapy-SMS cooldown is permanent [verified]

Migration `0160_worker_dedup_keys.sql:25-26` promises "a separate
sweeper job prunes expired rows"; none exists
(`idempotency-keys-prune.ts:53-57` only touches `idempotency_keys`).
The claim insert returns false on PK conflict **regardless of
`expires_at`** — so after one adherence SMS, the non-date-scoped key
`therapy-alert-sms:<patientId>`
(`therapy-fleet-alerts-scan.ts:386-396`,
`therapy-setup-deadline-outreach.ts:278-287`) suppresses that patient
forever. Date-scoped reminder keys stay correct but grow unbounded.

**Fix:** add `worker_dedup_keys` (`WHERE expires_at <= now()`) to the
daily prune and/or make claims expiry-aware.

### P1-3. Quiet hours are enforced only in `reminders.scan` — other SMS crons text patients at night (TCPA) [verified]

`reminders.ts:273-315` enforces a 9am–8pm patient-local window. Not
enforced in: `rx-renewal-send` (04:43 UTC daily ≈ 23:43/00:43 ET — no
flag, no comm-prefs, no DND, live whenever Twilio is configured),
`smart-trigger-send` (04:13 UTC; `smartTriggerChannelAllowed` returns
true for any patient with no `shop_customers` row —
`lib/smart-triggers/dispatcher.ts:79-90`), `fitter-lead-first-day-nudge`
(hourly; an 18–30h window means a 9am lead is texted ~3am),
`fitter-supply-campaign`, `therapy-fleet-alerts-scan` /
`therapy-setup-deadline-outreach` (05:05–05:15 UTC; DND default is
null/null so it protects nobody unconfigured), `onboarding-checkins`
(14:17 UTC = 06:17 PST in winter, under the TCPA 8am floor for Pacific
patients).

**Fix:** lift the quiet-hours gate (keyed on `patients.timezone` /
`lib/comm-prefs.ts:resolveTimezone`) into a shared pre-send gate used
by every SMS dispatcher.

### P1-4. Rx-renewal dispatcher ignores `patients.status` — STOP'd/paused patients still contacted [verified]

STOP is modeled as `patients.status='paused'`
(`lib/messaging/order-flow.ts:544`); the reminders path filters on
`status='active'` in both scan and send. The rx-renewal dispatcher
(`lib/rx-renewal/dispatcher.ts:101-114,266`) selects patients with no
status filter and sends via the raw Twilio/SendGrid clients, bypassing
the shared consent checks. The sibling smart-trigger dispatcher checks
status — this is an oversight, not policy.

**Fix:** add `.eq("status", "active")` (or route through
`sendReminderSms` / a shared consent gate).

### P1-5. `trust proxy = 1` is one hop short behind Cloudflare — all per-IP limits key on Cloudflare edge IPs [verified, impact needs runtime confirmation]

`app.ts:56`. The custom domain adds Cloudflare in front of Railway's
edge (2 hops). With one trusted hop, `req.ip` resolves to the CF edge
IP for all custom-domain traffic: every IP-keyed limiter (sign-in
30/15min, forgot/reset/verify, orders, chat, recommend, webhooks)
buckets all CF-routed visitors into a handful of colo IPs — honest
users get 429'd by strangers' traffic while attackers rotating colos
dilute the cap — and audit rows record Cloudflare IPs. Nothing reads
`CF-Connecting-IP` (grep-verified). Traffic on `*.up.railway.app`
(1 hop) keys correctly, which masks the bug in testing. Flagged as
"verify" in the hosting review (R7); never resolved in code.

**Fix:** trust both hops / derive the client from `CF-Connecting-IP`
after validating the immediate peer; confirm Railway's exact XFF
behavior live.

### P1-6. Email auto-reply has no replay protection or per-sender cap [verified; gated — flag seeded OFF]

`routes/email/inbound-parse.ts:46,84`: no `Message-ID` dedupe (the SMS
path has a `MessageSid` idempotency check, `routes/sms/inbound.ts:437`)
and the 120/min limiter keys on SendGrid's posting IPs, not the sender.
With `email.auto_reply` ON, one replayed/spoofed inbound email triggers
N model calls and N outbound replies (the RFC-3834 loop guard only
catches auto-generated headers).

**Fix before enabling the flag:** dedupe on the already-extracted
`Message-ID` (`:336,879`) + per-`fromEmail` auto-reply cap.

### P1-7. Public `/api/chat` has no global LLM spend/concurrency budget [verified]

`routes/storefront/chat.ts:93,319`: unauthenticated, 20 req/min **per
IP** only; each request can drive 2 upstream LLM calls. A botnet gets
effectively free Claude/OpenAI usage — the bill is the blast radius.

**Fix:** process-wide token/spend counter that trips to the offline
reply, or a global concurrency/RPS cap alongside the per-IP one.

### P1-8. Statement send has a check-then-act race — patients can be double-billed by SMS/email [verified]

`lib/billing/statement-send.ts:399-501`: `persistOutcome` flips
`delivery_status` to `sent` unconditionally (`:259` lacks
`.eq("delivery_status","pending")`), and the single-send route
(`routes/admin/billing-statement-send.ts:109-154`) has no idempotency
or rate limit. An operator click racing the batch sweep delivers twice.
The mail path (`markStatementsMailed`, `:298-318`) guards correctly.

**Fix:** claim-then-send — conditional UPDATE on
`delivery_status='pending'`, dispatch only when a row returns.

### P1-9. `patient-autopay-charge` lacks an atomic per-authorization claim — double-charge window [verified; triple-gated today]

`worker/jobs/patient-autopay-charge.ts:178-192,261-288`: the
once-per-day rule is evaluated on the tick-start snapshot;
`last_charge_attempt_at` is stamped _after_ the charge; the Stripe
idempotency key is per freshly-inserted `patient_payments` row, so
overlapping ticks (pg-boss 15-min expiry retry during a deploy
rollover) mint different keys → two real PaymentIntents. Contrast
`payment-plan-autocharge`'s deterministic per-installment key.

**Fix:** conditional-UPDATE claim on
`patient_autopay_authorizations.last_charge_attempt_at` before
charging.

---

## P2 — medium: correctness, resilience, UX

| #     | Finding                                                                                                                                                                                                                                                                                    | Where                                                                                                                                                                                                                                 | Status                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| P2-1  | No fetch timeout on the entire Supabase runtime data path — a stalled PostgREST call holds requests up to ~300s (undici default). `pool.ts:62` shows the team fixed this for raw pg; the Supabase client never got it.                                                                     | `lib/resupply-db/src/supabase-client.ts:90-101`                                                                                                                                                                                       | verified                                |
| P2-2  | `bulk-campaign-tick` step-6 status re-read discards the PostgREST error — a transient blip is indistinguishable from "cancelled"; the self-re-enqueueing chain dies and the campaign wedges in `'sending'` until manual pause→resume.                                                      | `worker/jobs/bulk-campaign-tick.ts:596-609`                                                                                                                                                                                           | verified                                |
| P2-3  | `payment-plan-autocharge` plans query unpaginated — silent truncation at PostgREST's ~1000-row cap; plans past the cap never autocharge. Sibling jobs all paginate.                                                                                                                        | `worker/jobs/payment-plan-autocharge.ts:171-179`                                                                                                                                                                                      | verified                                |
| P2-4  | Opt-in env-cron jobs never `unschedule` — pg-boss schedules persist in the DB, so unsetting the env var does NOT stop the cron; only the feature flag remains as a kill switch.                                                                                                            | `payment-plan-autocharge.ts:274-289`, `patient-autopay-charge.ts:389-402`, `eligibility-reverify-batch.ts:69-79`, `auto-submit-batch.ts:89`, `bill-hold-sweep.ts:191`, `clinical-outreach-batch.ts:67`, `sla-escalation-sweep.ts:201` | verified                                |
| P2-5  | ISA13 control numbers: no unique index, no transaction; claims and eligibility derive independent sequences from the same time base under one ETIN — same-second collisions are 999-rejected (silent claim delay).                                                                         | `lib/resupply-integrations-office-ally/src/edi/control-numbers.ts:10-14`, `office-ally-batch.ts:287-298`, `eligibility-verifier.ts:164-171`                                                                                           | verified                                |
| P2-6  | A partially-reconciled 835 gets permanently stuck: `dispatch_failed` is terminal, and the manual replay path hits the `era_files` sha256 dedupe and skips reconciliation entirely. `reconcileEra` is not idempotent (double-posts money on re-run, per its own comment).                   | `worker/jobs/office-ally-inbound-poll.ts:592-651`, `routes/admin/office-ally-upload-ack.ts:186`                                                                                                                                       | verified                                |
| P2-7  | `?demo=1` silently and persistently flips the production storefront into a fake-data sandbox (localStorage), with no banner and no exit for the customer-facing surface.                                                                                                                   | `cpap-fitter/src/demo/state.ts:49-77`, `demo/install.ts`                                                                                                                                                                              | verified                                |
| P2-8  | Back-button trap at `/measure`: post-extraction mount effect pushes `/capture` (not replace) — user can never navigate back past it and is pushed toward re-taking the photo.                                                                                                              | `pages/measure.tsx:131-138`                                                                                                                                                                                                           | verified                                |
| P2-9  | Typing "0" in the cart quantity input silently deletes the line with no Undo (the explicit Remove button has one).                                                                                                                                                                         | `pages/shop-cart.tsx:779-794`, `hooks/use-cart.ts:281-294`                                                                                                                                                                            | verified                                |
| P2-10 | `patients.email` is unindexed; ~22 `.ilike("email", …)` resolver callsites on the hottest signed-in portal paths seq-scan `patients` per page load. Mirror the `shop_customers.email_lower` pattern (0013).                                                                                | e.g. `routes/storefront/me-billing.ts:65-70`                                                                                                                                                                                          | needs-verification (prod row count)     |
| P2-11 | Conversations inbox/thread never live-refresh (no `refetchInterval` / focus refetch; global `staleTime` 60s) — the nav badge announces a new message the open inbox won't show.                                                                                                            | `pages/admin/conversations.tsx:125-131`, `conversation-detail.tsx:68` vs `AppShell.tsx:1496-1504`                                                                                                                                     | verified                                |
| P2-12 | Episodes bulk SMS/email send fires on a single click — no confirmation dialog (bulk campaigns and patients bulk-close both have one).                                                                                                                                                      | `pages/admin/episodes.tsx:386-418,597-607`                                                                                                                                                                                            | verified                                |
| P2-13 | "Send due reminders now" failure is completely silent (no UI renders `send.error`); operator re-click risks double-sends.                                                                                                                                                                  | `pages/admin/pennpaps-reminders.tsx:37-43`                                                                                                                                                                                            | verified                                |
| P2-14 | Patient names in GET query strings (admin lookup `?q=`, patients `?search=`, CSV export, episodes URL-sync) — PHI-adjacent leak into edge/access logs and browser history under the repo's "every log line is world-readable" posture.                                                     | `GlobalLookup.tsx:61`, `patients.tsx:331`, `admin-customer-detail.tsx:304`, `episodes.tsx:168-176`                                                                                                                                    | needs-verification (edge log config)    |
| P2-15 | Duplicate migration prefixes still landing (0208×3, 0248, 0250, 0253×3, 0254, 0257) — the CI tree-wide duplicate check designed in the prefix-check script's own header never shipped.                                                                                                     | `lib/resupply-db/drizzle/`, `scripts/check-resupply-migration-prefix.sh`                                                                                                                                                              | verified                                |
| P2-16 | `RUN_DB_MIGRATIONS` gate is exact-string `"true"` — `TRUE`/`1` silently skips migrations and the deploy proceeds (the exact schema-drift incident class in the repo's post-mortem).                                                                                                        | `lib/resupply-db/scripts/deploy-migrate.mjs:40`                                                                                                                                                                                       | verified                                |
| P2-17 | Body-limit mismatches: fee-schedule import accepts 1 MiB via Zod but the global 100kb parser 413s first; `/patients/import-csv` at 500 rows can exceed 100kb. PacWare and packet-sign got per-path raises; these didn't.                                                                   | `routes/admin/payer-fee-schedules-import.ts:25`, `app.ts:256`                                                                                                                                                                         | verified                                |
| P2-18 | DB-backed auth rate limiter fails open on DB error; its only backstop is the (P1-5-weakened) per-IP edge limiter.                                                                                                                                                                          | `lib/resupply-auth/src/rate-limit.ts:118-128`                                                                                                                                                                                         | verified                                |
| P2-19 | `requireAdmin` granular-role lookup failure falls back to the coarse role — a deliberately downgraded staffer (admin→csr in `admin_users`) regains `super_admin` during any `admin_users` read hiccup. Fail closed instead.                                                                | `middlewares/requireAdmin.ts:130-153`                                                                                                                                                                                                 | verified                                |
| P2-20 | Vision-runtime "degraded" is a dead end: one-shot HEAD probe never re-checks, Take Photo stays disabled, and the copy says "wait and try again" — waiting does nothing.                                                                                                                    | `hooks/use-vision-runtime-health.ts`, `pages/capture.tsx:379-383`                                                                                                                                                                     | verified                                |
| P2-21 | Anthropic streaming path can't abort the upstream on client disconnect (no AbortSignal plumb-through) — tool rounds and token spend continue after the tab closes (bounded by the 30s timeout).                                                                                            | `lib/resupply-ai/src/anthropic-client.ts:355`, `routes/storefront/chat.ts:1116`                                                                                                                                                       | verified                                |
| P2-22 | Twilio signature verification reconstructs the URL from `publicBaseUrl` + `req.originalUrl` — if Twilio posts to the Cloudflare custom domain but the env resolves to the railway.app host (or vice versa), every inbound SMS/voice webhook silently 403s. Fail-closed, availability-only. | `routes/sms/inbound.ts:147-155`, `lib/resupply-telecom/src/signature.ts:25-33`                                                                                                                                                        | needs-verification (live Twilio config) |
| P2-23 | Patient-documents retention sweep aborts the whole nightly batch on one bad row, blocking every other document's retention processing.                                                                                                                                                     | `worker/jobs/patient-documents-retention-sweep.ts:82-94`                                                                                                                                                                              | verified                                |
| P2-24 | `/readyz` is an unauthenticated, uncached, unlimited DB probe — free amplification against PostgREST. Memoize ~5s and/or rate-limit.                                                                                                                                                       | `routes/health.ts:21`, `lib/readiness.ts:90-113`                                                                                                                                                                                      | verified                                |

---

## P3 — low / hygiene (abridged)

- **Auth:** `invite_expired` 403 fires before password verify — account-state enumeration + timing oracle (`sign-in.ts:240-266`). Cross-purpose email-token burn (`supabase-repository.ts:375` consumes before the purpose check). Link-token HMACs share one key with no purpose-tag domain separation — `patient-packet` and `provider-portal` payload shapes are mutually accepted; only disjoint ID namespaces prevent cross-use (`signed-link-tokens.ts:106` vs the `mfa-challenge.ts:35` pattern).
- **Admin API:** `shop-returns.ts:203-206` NaN `?limit` → `.limit(NaN)`. Dead/shadowed duplicate route `GET /admin/analytics/resupply-funnel` (`resupply-funnel.ts` is unreachable behind `analytics.ts`; a future "fix the funnel" edit there would do nothing). Two `.ilike` escapes omit backslash (`payer-profiles.ts:274`). `routes/shop/me.ts:167` echoes raw PostgREST `error.message` to a customer (34 more admin-gated routes do the same — consider a lint rule).
- **Worker:** webhook-dispatcher swallows candidate-SELECT errors (`webhook-dispatcher.ts:80-88`); bulk-campaign counter drift on step-5 failure; one job registration failure keeps all ~50 jobs offline in retry (consider per-registration try/catch); stale "fatal + exit(1)" comment in `prescription-attachment-sweep.ts:516-524`.
- **Integrations:** `OFFICE_ALLY_STUB` honors only exactly `"1"` — `=true` silently runs live; stub mode flips claims to `submitted` while writing files to the ephemeral filesystem. `quoteSftpArg` doesn't strip newlines (admin-controlled dir → sftp batch injection; admin-only). PacWare DOB parser requires strict `YYYY-MM-DD` — a native `MM/DD/YYYY` export fails 100% of rows (safely) [needs-verification against a real export]. Stale comments at `routes/admin/pacware.ts:106-109` describe field-_clearing_ behavior the code correctly does not implement — delete before someone "fixes the code to match". `file_sha256` polluted with `${sha}::${timestamp}` sentinel rows.
- **DB:** RLS-enablement practice silently stopped at ~0201 (~25 newer tables incl. `voice_calls`, `patient_packets` are grants-only; not an exposure — 0169 revoked defaults — but drifts from 0170's stated end-state and will re-trip the Supabase advisor). Fresh replay of 0169 needs `anon`/`authenticated` roles nothing in the migrator creates (CI pre-creates them; local onboarding trap). `CREATE INDEX CONCURRENTLY IF NOT EXISTS` re-run can silently keep an INVALID index (check `pg_index.indisvalid` in prod for the 0208 pair). Two non-CONCURRENT late index builds on `insurance_claims` (0228, 0253) regressed the 0208 posture. `public`-schema dependency (orders/usage_events/admin_audit_log/reminder_subscriptions from 0027) is undocumented in the exposed-schemas guidance and contradicted by the `supabase-client.ts:18` comment. `migrate.mjs` never adds newly applied hashes to its in-memory set (`applyPendingMigrations`).
- **Storefront:** `role="radio"` groups aren't keyboard-conformant (questionnaire tiles, cart options — Radix RadioGroup exists in the codebase). `basePath` double-prefix in sign-in/forgot-password links. Measurements don't survive refresh while the rest of the fitter store does (results-page copy even claims they're saved) — needs a deliberate decision. Privacy copy nit: `results.tsx:402-404` should say "your photo" not "these dimensions". Stale consent-checkbox comment in `order.tsx:141-148`.
- **Admin SPA:** CSV-import error rows mis-numbered when client-invalid rows interleave (`patients.tsx:1406-1417` vs server 0-based batch index). Orders rows styled clickable but aren't (`pennpaps-orders.tsx:168`). UTC "today" in reminders due-highlighting (`pennpaps-reminders.tsx:139`). Dead retry button (`conversation-detail.tsx:1303`). Stale "audit log" copy on two pages (the audit package is a no-op stub per 0156).
- **Docs/ops:** CLAUDE.md lists `SUPABASE_STORAGE_BUCKET_PRIVATE` as required-at-boot; `env-check.ts` doesn't check it (preflight does). AirView timeout env vars read at module load (restart needed to change; creds rotate live, which is the part that matters).
- **Test coverage:** e2e is 3 specs (storefront load, results resilience, a11y) — no checkout, fitter-flow, or admin-sign-in journey. Two P0s (P0-2, P0-3) shipped precisely because route tests mount routers without the real `app` middleware chain; add at least one full-app-mount test per webhook/CSRF-gated surface.

---

## Verified strengths (what's done well)

- **The camera-privacy invariant is engineered, not just promised:** the only frame produced (`capture.tsx:126`) lives in in-memory React state, is consumed solely by the local MediaPipe decode, is nulled on navigation, and nothing image-shaped ever reaches fetch/XHR/WS/storage/analytics (grep-verified). MediaPipe is self-hosted, lazy-loaded only in the `/measure` chunk.
- **PostgREST-injection discipline:** a single audited helper (`escapePostgRESTFilterValue`) handles both the LIKE-metachar and `.or()` delimiter layers; every user-influenced filter across 187 admin route files is escaped, validated, or server-derived. Zero injectable sinks found.
- **Access control:** 0 ungated admin mutations out of 299 scanned (238 `requirePermission`, 61 coarse `requireAdmin`); CSRF is enforced at the single `requireAdmin` chokepoint; sessions are SHA-256-hashed at rest with fresh token+CSRF on every login and full revocation on reset; constant-time comparisons are used consistently, including a memoized argon2 cost on the "no such user" path.
- **Boot/shutdown contract is exemplary and matches the documented invariants:** listener-first, background worker retry with single-flight guard, no `process.exit` anywhere in the worker tree, shared 25s shutdown budget under Railway's 30s grace, `/healthz` dependency-free.
- **The migrator is production-grade:** advisory lock, per-migration transactions with the ledger INSERT inside, content-hash dedup, adoption guard, from-scratch replay + idempotency tested in CI against real Postgres.
- **Idempotency engineering on send paths:** reminders' claim-before-vendor with release-on-retryable-failure; bulk-campaign's lease reclaim and "park, never re-send" posture; deterministic Stripe keys in payment-plan autocharge; webhook dispatcher's SSRF re-validation + DNS pinning.
- **Webhook signature hygiene:** Twilio (constant-time, fail-closed), SendGrid Event Webhook (ECDSA over raw body + replay window), Stripe (raw-before-json), Inbound Parse (constant-time basic auth, fails closed 503 when unconfigured) — the design is right everywhere; P0-2 is a mounting-order bug, not a design gap.
- **PHI log hygiene holds** across routes, workers, and integrations (counts/SIDs only; query strings dropped from request logs; EDI stderr classified, never verbatim).

---

## Recommended fix order

1. **P0-1** — `camera=(self)` (one line; un-breaks the core product).
2. **P0-2** — move the two raw-body webhook mounts before `express.json()` (restores email delivery tracking).
3. **P0-3 + P0-4** — CSRF headers on the two shop wrappers; reactive stream attach on capture retry.
4. **P0-5** — `useSearch()`/`window.location.search` in conversations + episodes.
5. **P1-1, P1-8, P1-9** — the three money-safety claims/races (claim-then-act everywhere).
6. **P1-2, P1-3, P1-4** — the SMS-suppression prune + shared quiet-hours/consent gate (TCPA).
7. **P1-5** — trust-proxy/CF-Connecting-IP (then re-test the auth limiters).
8. **P1-6, P1-7** — before enabling `email.auto_reply`; global chat budget.
9. P2 cluster — start with P2-1 (Supabase fetch timeout), P2-15/P2-16 (migration-process guards), P2-2/P2-3 (worker money/wedge), then the UX items.
