# Whole-app review — 2026-06-12

Whole-app review at `main` = `ae590e84`, covering all three artifacts,
all 22 `lib/resupply-*` packages, the worker tier (~60 pg-boss jobs),
the migration corpus, docs/runbooks, and CI. Findings were
cross-checked against the prior reviews
([`app-review-2026-06-10.md`](./app-review-2026-06-10.md),
[`feature-functionality-review-2026-06-11.md`](./feature-functionality-review-2026-06-11.md),
[`feature-review-and-gap-research-2026-06-07.md`](./feature-review-and-gap-research-2026-06-07.md))
so nothing already fixed or already roadmapped is re-reported as new.

**Shipped in this PR:** P2-1, P2-2, P2-15, P2-16, P2-18, P2-19 from
the June-10 audit, plus the new DLQ monitor (B1 below) — each with
regression tests. P1-5 (trust proxy) remains deliberately deferred:
the correct fix needs live confirmation of Railway's XFF behavior
behind Cloudflare, which a code-only change can't provide.

**Verified already fixed on main since the June-10 audit** (no action
needed): P2-3 (payment-plan scan is now keyset-paginated), P2-4 (all
seven env-cron jobs now `unschedule` when their cron var is unset),
P2-5 (ISA13 values come from an atomic counter table, migration 0308),
P2-6 (the ERA reconciler now has per-claim replay idempotency and a
`dispatch_failed` operator-replay path), P2-9 (the cart quantity input
now drafts raw keystrokes, commits only ≥1, and settles 0/empty to 1
on blur), P2-20 (the vision-runtime health probe re-checks on a capped
backoff instead of latching "degraded").

**UX P2 fixes also shipped in this PR:** P2-7 (global demo-mode banner

- one-click exit — `?demo=1` persisted in localStorage with nothing on
  the customer-facing surface saying so), P2-8 (`/measure` redirects to
  `/capture` with `replace`, removing the back-button trap), P2-11 (the
  conversations inbox and open thread now poll on the same 60s cadence
  as the nav badge, plus focus refetch), P2-12 (episodes bulk SMS/email
  now confirms before messaging every selected patient), P2-13 (a failed
  "Send due reminders" batch renders a destructive alert warning about
  double-sends, and the two-click confirm state resets on error).

## Verified-current corrections (things prior docs got wrong or that have since shipped)

- **Shipped since the June-07 gap research:** outbound fax
  (`lib/resupply-telecom/src/telnyx-fax.ts`), 276 claim-status EDI
  (`lib/resupply-integrations-office-ally/src/edi/276.ts`), patient
  payment plans (`routes/admin/payment-plans.ts` +
  `payment-plan-autocharge` job).
- **Not missing (verified present):** customer comm-prefs self-service
  (`routes/shop/me-comm-prefs.ts`), customer review submission
  (`routes/shop/reviews.ts`), self-service returns with auto-approval
  (`routes/shop/my-returns.ts`), A/R aging, 271 auto-processing,
  team/permissions management UI.
- **An audit-log UI is out of scope by policy** — the audit package is
  a no-op stub per the CLAUDE.md hard rules (migration 0156); do not
  build readers on it.
- **E2E IS wired into CI** (required Playwright smoke, 7 specs) — the
  gap is journey breadth (no checkout/auth/admin-mutation flows), not
  CI wiring.

## A. Fixed in this PR

### A1. Supabase fetch timeout (P2-1)

`lib/resupply-db/src/supabase-client.ts` now wraps `global.fetch` with
a per-request `AbortSignal.timeout` (default 30s, env-tunable via
`SUPABASE_FETCH_TIMEOUT_MS`), composed with any caller signal via
`AbortSignal.any`. Previously a stalled PostgREST call rode undici's
~300s default and held the calling request — and its worker slot — the
whole time; the raw-pg pool had the equivalent guard
(`connectionTimeoutMillis`) but the runtime data path never did.

### A2. Bulk-campaign tick chain survives a transient status re-read failure (P2-2)

`worker/jobs/bulk-campaign-tick.ts`: the step-6 campaign-status
re-read discarded the PostgREST error, so a transient blip was
indistinguishable from an admin cancel — the self-re-enqueueing chain
died and the campaign wedged in `'sending'` until a manual
pause→resume. An errored re-read now logs and falls through to the
finalize/reschedule path; the tick entry re-checks status before doing
any work, so a genuinely cancelled campaign just gets one harmless
no-op tick.

### A3. Tree-wide migration duplicate-prefix CI guard (P2-15)

`scripts/check-resupply-migration-prefix-tree.sh`, wired into the CI
drift job for PRs **and pushes to main**. The existing diff-based check
cannot see two PRs racing main with the same fresh prefix (neither
PR's diff collides against its own base — how 0208/0248/0250/0253/
0254/0257 landed as duplicates); the tree-wide scan against a frozen
allowlist of the 20 historical duplicates catches the race on the
post-merge main run. The allowlist must never grow — fix new
collisions by renaming the just-merged file to the next free prefix.

### A4. RUN_DB_MIGRATIONS gate hardening (P2-16)

`lib/resupply-db/scripts/deploy-migrate.mjs` (classifier in
`run-db-migrations-gate.mjs`): truthy spellings (`true`/`1`/`yes`/`on`,
any case) run migrations; explicit falsy spellings skip; **anything
else fails the deploy loudly**. Previously `TRUE` or `1` silently
skipped migrations while the deploy proceeded — the schema-drift
incident class in the repo's own post-mortem.

### A5. Auth rate limiter fails closed (P2-18)

`lib/resupply-auth/src/rate-limit.ts`: a failed
`countRecentFailures` check now denies the attempt (429, reason
`check_failed`, Retry-After 30s) instead of silently disabling
brute-force protection. Availability cost is negligible — if the
rate-limit table is unreachable, the credential lookup on the same
repo would fail anyway.

### A6. requireAdmin granular-role lookup fails closed (P2-19)

`artifacts/resupply-api/src/middlewares/requireAdmin.ts`: a PostgREST
**error** (previously silently ignored — only thrown errors hit the
catch) or a thrown failure on the `admin_users` lookup now rejects the
request with 401 instead of falling back to the coarse role, which let
a deliberately downgraded staffer regain full admin during any
`admin_users` read hiccup. The legacy fallback for "lookup succeeded,
no row" (pre-Phase-A accounts) is preserved.

### A7. Worker survives a single job-registration failure (June-10 P3)

`worker/index.ts`: all ~60 job registrations now run through a
`safeRegister` guard — one throwing register call no longer aborts the
rest (the May 2026 DLQ-FK incident class kept the entire worker tier
down). Failures are logged per-job and re-thrown as ONE aggregate after
everything has been attempted, so healthy jobs come online immediately
while the boot backoff loop retries the failed ones. Re-registration
on retry is safe: createQueue/schedule are upserts and duplicate
`work()` subscriptions don't double-process.

### A8. Small P3 hygiene (June-10 audit)

- `routes/admin/shop-returns.ts`: `?limit=abc` no longer reaches
  PostgREST as `.limit(NaN)` (Math.max/min propagate NaN).
- `routes/shop/me.ts`: the profile-update failure path no longer
  echoes the raw PostgREST error message to the customer (schema/table
  names could leak); the detail is logged server-side and the client
  gets the stable `update_failed` code.

### B1. Dead-letter-queue monitor (new finding, this review)

Every queue routes exhausted jobs to a per-queue DLQ
(`worker/lib/queue-options.ts`), but nothing watched them — no job, no
admin surface, no notification (grep-verified). A permanently failed
reminder/autopay/claim job was silent until the business effect
surfaced. New `worker.dlq-monitor` job
(`worker/jobs/dlq-monitor.ts`, 06:55 UTC daily): enumerates `*.dlq`
queues via pg-boss's own API (no raw pg), emails one digest of the
non-empty ones to `RESUPPLY_ADMIN_EMAILS` through the shared SendGrid
client. Stateless — re-notifies daily until ops drains the DLQ.
Fail-soft when recipients/email are unconfigured. Counts and queue
names only; no payloads, no PHI.

## B. Recommended next (not in this PR)

In priority order; the P-numbers reference
[`app-review-2026-06-10.md`](./app-review-2026-06-10.md).

1. **P1-5 — trust proxy behind Cloudflare.** Needs a live check of the
   XFF chain on `pennpaps.com` vs `*.up.railway.app`, then trust both
   hops or derive the client from `CF-Connecting-IP` after validating
   the immediate peer. Until then every per-IP limiter keys on
   Cloudflare edge IPs for custom-domain traffic.
2. **Error tracking / metrics.** Logging is pino-to-stdout only — no
   exception aggregation, no APM. Given the "every log line is
   world-readable" PHI posture, prefer self-hosted Sentry/GlitchTip or
   aggressive `beforeSend` scrubbing reusing `lib/logger.ts`'s
   redaction list. Feed business counters into the existing
   `metrics-snapshot` / `metric-alerts-evaluator` substrate rather
   than a new system.
3. **Full-app-mount regression tests + money-path E2E.** P0-2/P0-3
   escaped because route tests mount routers without the real `app`
   middleware chain. Add one full-app-mount test per webhook/CSRF
   surface, plus Playwright journeys for cart → Stripe checkout,
   sign-up/sign-in, and one admin mutation (priority order already in
   `e2e/README.md`).
4. ~~Refactor the four monoliths~~ — **done in this PR**:
   `patient-detail.tsx` 2,755→864 (11 tab modules),
   `admin-documents.tsx` 2,183→524 (7 modules), `reports.ts` 2,514→65
   (per-report modules + a compile-enforced registry),
   `webhook-handler.ts` 1,878→979 (event-family modules; the families
   pinned by new-events.test.ts's source-text assertions stay inline).
   All existing tests pass unmodified.
5. **Resilience on outbound calls** — explicit timeouts on external
   HTTP and a consecutive-failure backoff on the pollers
   (`office-ally-inbound-poll`, therapy nightly sync).
6. **Frontend polish** — partially **done in this PR**: all 10
   remaining `window.confirm` sites migrated to `useConfirmDialog`;
   below-the-fold images get `loading="lazy"`/`decoding="async"`.
   Verified already fine (stale audit claims): skeletons are
   standardized on the shared component, and the admin console has a
   mobile hamburger/Sheet drawer. Still open: WebP/`srcset` (needs an
   image pipeline) and server-syncing the signed-in wishlist.

## C. Feature opportunities

**Correction (verified during implementation):** all four "new
feature ideas" originally drafted for this section turned out to be
already built — the codebase is ahead of its own audits:

1. ~~Eligibility-gated reminders~~ — implemented at the order-confirm
   step (`lib/messaging/order-flow.ts`, `consultCoverageEligibility`,
   flag `resupply.eligibility_enforcement`, fail-open, raises a CSR
   coverage alert). Gating the confirm rather than the reminder send
   is arguably the better control point: the patient still gets
   contacted ("update your insurance") while a non-billable shipment
   is held for a CSR.
2. ~~Channel escalation ladder~~ — implemented as
   `reminders.escalation-scan` (`worker/jobs/reminder-escalation.ts`):
   unresolved episodes escalate SMS → email after 3 days, then raise a
   CSR "call them" alert once every channel is exhausted. Flag
   `reminder_escalation.dispatcher`.
3. ~~Therapy-data-driven cadence~~ — substantially covered:
   `coaching-auto-enroll` puts at-risk patients on coaching plans,
   `therapy_fleet.auto_outreach` sends consented adherence nudges, and
   `resupply.usage_compliance_check` holds resupply confirmations for
   effectively-unused devices.
4. ~~Estimated out-of-pocket at cart~~ — the cart already routes
   insurance-holding customers to the $0 insurance flow, a different
   (and simpler) solve for the same problem. An inline estimate
   remains a possible enhancement, not a gap.

Still-open items endorsed from the June-07 research (ROI order):
real-time CSR alerting/paging on SLA breach (C1), sentiment/urgency
inference on inbound SMS (C4 — copy the voice agent's post-call
pattern), in-composer KB search reusing PennPilot's knowledge base
(C6), CMN/DWO/SWO PDF generation (B4), RT cohort tooling + unified
clinical comms timeline (R2/R3), and the strategic multi-location
decision (O1 — schema forward-compatible via migration 0132).
R4/R5 (HSAT, telehealth Rx renewal) stay partner-gated; R7 (ML
adherence model) stays data-gated; R8 (ResMed/Philips BAA) stays a
business/contract action.
