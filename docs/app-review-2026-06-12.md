# Whole-app review — 2026-06-12

Whole-app review at `main` = `ae590e84`, covering all three artifacts,
all 22 `lib/resupply-*` packages, the worker tier (~60 pg-boss jobs),
the migration corpus, docs/runbooks, and CI. Findings were
cross-checked against the prior reviews
([`app-review-2026-06-10.md`](./app-review-2026-06-10.md),
[`feature-functionality-review-2026-06-11.md`](./feature-functionality-review-2026-06-11.md),
[`feature-review-and-gap-research-2026-06-07.md`](./feature-review-and-gap-research-2026-06-07.md))
so nothing already fixed or already roadmapped is re-reported as new.

**Shipped in this PR (Wave 1):** P2-1, P2-15, P2-16, P2-18, P2-19 from
the June-10 audit, plus the new DLQ monitor (B1 below) — each with
regression tests. P1-5 (trust proxy) remains deliberately deferred:
the correct fix needs live confirmation of Railway's XFF behavior
behind Cloudflare, which a code-only change can't provide.

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

### A2. Tree-wide migration duplicate-prefix CI guard (P2-15)

`scripts/check-resupply-migration-prefix-tree.sh`, wired into the CI
drift job for PRs **and pushes to main**. The existing diff-based check
cannot see two PRs racing main with the same fresh prefix (neither
PR's diff collides against its own base — how 0208/0248/0250/0253/
0254/0257 landed as duplicates); the tree-wide scan against a frozen
allowlist of the 20 historical duplicates catches the race on the
post-merge main run. The allowlist must never grow — fix new
collisions by renaming the just-merged file to the next free prefix.

### A3. RUN_DB_MIGRATIONS gate hardening (P2-16)

`lib/resupply-db/scripts/deploy-migrate.mjs` (classifier in
`run-db-migrations-gate.mjs`): truthy spellings (`true`/`1`/`yes`/`on`,
any case) run migrations; explicit falsy spellings skip; **anything
else fails the deploy loudly**. Previously `TRUE` or `1` silently
skipped migrations while the deploy proceeded — the schema-drift
incident class in the repo's own post-mortem.

### A4. Auth rate limiter fails closed (P2-18)

`lib/resupply-auth/src/rate-limit.ts`: a failed
`countRecentFailures` check now denies the attempt (429, reason
`check_failed`, Retry-After 30s) instead of silently disabling
brute-force protection. Availability cost is negligible — if the
rate-limit table is unreachable, the credential lookup on the same
repo would fail anyway.

### A5. requireAdmin granular-role lookup fails closed (P2-19)

`artifacts/resupply-api/src/middlewares/requireAdmin.ts`: a PostgREST
**error** (previously silently ignored — only thrown errors hit the
catch) or a thrown failure on the `admin_users` lookup now rejects the
request with 401 instead of falling back to the coarse role, which let
a deliberately downgraded staffer regain full admin during any
`admin_users` read hiccup. The legacy fallback for "lookup succeeded,
no row" (pre-Phase-A accounts) is preserved.

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
2. **Money/wedge P2 cluster** — P2-3 (payment-plan query truncates at
   ~1000 rows; plans past the cap never autocharge), P2-2
   (bulk-campaign wedges in `'sending'` on a transient read error),
   P2-6 (partially-reconciled 835 permanently stuck; `reconcileEra`
   not idempotent), P2-5 (ISA13 control-number collisions).
3. **Error tracking / metrics.** Logging is pino-to-stdout only — no
   exception aggregation, no APM. Given the "every log line is
   world-readable" PHI posture, prefer self-hosted Sentry/GlitchTip or
   aggressive `beforeSend` scrubbing reusing `lib/logger.ts`'s
   redaction list. Feed business counters into the existing
   `metrics-snapshot` / `metric-alerts-evaluator` substrate rather
   than a new system.
4. **Full-app-mount regression tests + money-path E2E.** P0-2/P0-3
   escaped because route tests mount routers without the real `app`
   middleware chain. Add one full-app-mount test per webhook/CSRF
   surface, plus Playwright journeys for cart → Stripe checkout,
   sign-up/sign-in, and one admin mutation (priority order already in
   `e2e/README.md`).
5. **Customer-visible UX P2s** — P2-7 (`?demo=1` persistently flips
   prod into fake-data mode, no banner/exit), P2-8 (back-button trap
   at `/measure`), P2-20 (camera "degraded" dead end), P2-9 (cart
   qty-0 silent delete), P2-11 (admin inbox never live-refreshes),
   P2-12/13 (bulk send no-confirm / silent failure).
6. **Refactor the four monoliths** before they cost a real bug:
   `pages/admin/patient-detail.tsx` (2754 LOC),
   `pages/admin/admin-documents.tsx` (2183),
   `routes/admin/reports.ts` (2514 — split per report type),
   `lib/stripe/webhook-handler.ts` (1878 — event-handler registry).
7. **Resilience on outbound calls** — explicit timeouts on external
   HTTP and a consecutive-failure backoff on the pollers
   (`office-ally-inbound-poll`, therapy nightly sync).
8. **Frontend polish** — standardize loading skeletons + a single
   toast queue; WebP/`srcset` for product images on `/shop`; a mobile
   pass on the desktop-first admin console; server-sync the
   signed-in wishlist (currently localStorage-only).

## C. Feature opportunities

New ideas from this review — each closes a loop between systems that
already exist:

1. **Eligibility-gated reminders.** The 270 verifier, 271
   auto-processing, and `eligibility-reverify-batch` all exist, but
   the reminder scan never consults eligibility. An
   "eligibility stale/terminated" predicate in the outreach plan stops
   texting patients whose coverage lapsed — saves CSR time and
   prevents un-billable orders.
2. **Channel escalation ladder.** SendGrid delivery events are
   persisted (and flow again post-P0-2); use bounces/non-delivery to
   escalate SMS → email → voice-callback task instead of the current
   pick-one channel.
3. **Therapy-data-driven cadence.** Therapy snapshots and adherence
   predictions exist as read surfaces; feeding usage signals into the
   `outreach-plan` rules (low-usage patients get a coaching touch, not
   a resupply push) closes the loop the therapy-cloud adapters were
   built for.
4. **Estimated out-of-pocket at cart.** The insurance-estimate engine
   exists standalone; surface it during checkout for insurance-linked
   customers.

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
