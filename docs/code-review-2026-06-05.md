# Codebase review — 2026-06-05

Branch: `claude/sharp-babbage-q9MU1`
Scope: workspace-wide — `artifacts/resupply-api` (routes, worker, lib),
`artifacts/cpap-fitter` (SPA), every `lib/*` package (auth, db, ai,
telecom, messaging, email, domain, reminders, secrets, templates),
the partner-integrations layer, and the DB migrations/migrator. CI,
deploy config, and operator scripts were reviewed for process gaps.

## Method

A "Cursor-reviewer" style pass hunting for correctness bugs, security
issues, races, resource leaks, performance problems, and process gaps —
not style. Six parallel deep-review agents each owned a subsystem; their
findings were re-verified against the source before any change. The
automated gates (`typecheck`, `lint:resupply`, `pnpm test`,
`pnpm audit`, the architecture/route-gate/migration-prefix checks) all
pass on `main`, so the issues below are genuine logic/edge-case bugs the
gates can't catch.

**Headline:** this is an unusually disciplined codebase. The patterns
that normally generate bugs (Zod at every boundary, ownership-scoped
queries, webhook idempotency + signature verification, PHI-safe logging,
decoupled boot, integer-cents money, atomic single-row claims) are
applied consistently. No external authZ/IDOR/injection bypass was found.
The findings are marginal-but-real.

---

## Fixed in this PR

### Critical

**C1 — `void`-wrapped async route handler can crash the whole process.**
`artifacts/resupply-api/src/routes/shop/my-subscriptions.ts` (pause +
resume). The handlers were mounted as `(req, res) => { void
handlePauseOrResume(...) }`. `handlePauseOrResume` awaits
`findOwnedSubscription`, which `throw`s on any Supabase error _before_ a
response is sent. Because the promise was `void`-ed (not returned),
Express 5 never sees the rejection → it becomes an `unhandledRejection`
→ the boot trap (`src/index.ts:207`) calls `process.exit(1)`, taking
the entire site down (static storefront, public catalog, every route)
for one signed-in customer's DB hiccup — exactly what the decoupled-boot
contract forbids, and a trivial DoS. **Fix:** return the promise so
Express 5 awaits it and routes the rejection to the error handler
(matches every other route in the file).

**C2 — Cross-endpoint rate-limit contamination via the per-IP login
bucket.** `lib/resupply-auth` + the forgot/reset/verify/MFA handlers.
The per-IP sign-in bucket (`checkLoginRateLimit`'s second
`countRecentFailures` call) counts **every** `success=false` row for an
IP regardless of `email_lower`. But `forgot-password`, `reset-password`,
`verify-email`, and `verify-sign-in-mfa` recorded their per-endpoint
sentinel failures (`__forgot:<ip>`, …) with a **real IP**. Result: those
endpoints inflate the per-IP **sign-in** lockout (30/15min) and
vice-versa — a user fat-fingering MFA or clicking an expired reset link
can lock out all sign-ins from their NAT, and the unauthenticated
forgot-password endpoint can exhaust a NAT's sign-in budget. **Fix:**
record the sentinel failures with `ip: null`. The IP is preserved for
audit (embedded in the sentinel for forgot/reset/verify; in the adjacent
`deps.audit` row for MFA). Regression tests added.

### High

**H1 — Unbounded payer response body read (OOM).**
`lib/resupply-integrations-davinci-pas/src/client.ts`. `submitPasBundle`
did `await res.text()` with no size cap; a compromised/misbehaving payer
endpoint (only has to pass the route's SSRF host check) could return a
multi-GB body and OOM the in-process API/worker. **Fix:** streamed,
byte-capped read (4 MB) mirroring the ehr-fhir JWKS guard. Also mapped
the verbatim transport-error string (persisted + returned in the HTTP
body) to a fixed caller-safe reason (H1b, was Low I6). Tests added.

**H2 — `placeCall` silently ignored its `record` parameter.**
`lib/resupply-telecom/src/client.ts`. `PlaceCallInput.record` existed
(doc'd "if true, Twilio will record") but the impl hardcoded
`record: false`. Per the PHI hard rule (recordings always off), the
field was **removed** so the always-off invariant is explicit at the
type level — no caller can think it's toggleable. No caller passed it.

**H3 — Admin tab data race overwrites newer patient's data.**
`artifacts/cpap-fitter/src/pages/admin/patient-detail.tsx`
(`FaxOutreachTab`). The effect's hand-rolled fetch had no cancellation
guard; switching patients while a request was in flight let a slow
earlier response clobber the newer patient's rows. **Fix:** the app's
standard `let cancelled = false` teardown guard.

### Medium

**M1 — Reminder dedup key not released on a _thrown_ send failure.**
`artifacts/resupply-api/src/worker/jobs/reminders.ts` (SMS + email). The
22h dedup key is claimed before the send; it was released only on
_returned_ non-ok outcomes. If `sendReminderSms/Email` _threw_, the
release was skipped, pg-boss retried, the retry found the key held →
the reminder was silently dropped for 22h. **Fix:** release the claim in
a catch before re-throwing.

**M2 — Voice inbound-reorder bound shared-phone callers to an arbitrary
patient.** `artifacts/resupply-api/src/routes/voice/inbound-reorder.ts`.
`identifyCaller` did `.limit(1).maybeSingle()` with no ambiguity guard
(unlike the SMS handler). A household/shared number was bound to an
arbitrary patient's episode and connected to the patient-scoped AI agent
_before_ any verification. **Fix:** `.limit(2)`; on >1 match, treat as
unidentified → route to a human (mirrors the SMS `ambiguous_phone`
guard). Tests added.

**M3 — Therapy nightly-sync dropped a whole patient's snapshot on one
malformed night.** `artifacts/resupply-api/src/worker/jobs/therapy-integrations-nightly-sync.ts`.
`integrationSnapshotSchema.safeParse` was all-or-nothing: one vendor
night with an ISO timestamp, a fractional minute count, or a negative
leak reading discarded the entire snapshot (valid settings + compliance

- all other nights) — silently (counter only). **Fix:** a per-night
  normalizer (ISO→`YYYY-MM-DD`, round/clamp numerics, drop only the
  unsalvageable night) + log the parse failure (path+code only, no PHI).
  Tests added.

**M4 — `slideExpiry` could return an expiry past the absolute cap.**
`lib/resupply-auth/src/session.ts`. The final `Math.max(next,
expiresAt)` returned an uncapped `expiresAt` when it already sat past the
ceiling (prior longer `absoluteMaxDays`, clock skew), defeating the
"stolen cookie expires within a known window" guarantee. **Fix:** clamp
to `ceiling` (a no-op in normal operation). Test added.

**M5 — Silent statement-placeholder insert failure.**
`artifacts/resupply-api/src/lib/billing/auto-workflow-engine.ts`. A
failed `patient_billing_statements` placeholder insert `continue`d
without `stats.errors += 1` or logging, so a systemic failure looked
like "no statements due." **Fix:** count + log it (matches the file's
existing error pattern).

**M6 — `summarizeToolArgsForAudit` could return `undefined`.**
`lib/resupply-ai/src/tools.ts`. The exhaustive `ToolName` switch had no
`default`; an unvalidated tool name would fall through to `undefined`,
violating the return type and writing `undefined` into an audit record.
**Fix:** safe `default` arm (name only, never raw args).

### Low

**L1 — Stray control bytes made a route file "binary."**
`artifacts/resupply-api/src/routes/shop/my-returns.ts:72` contained raw
`0x00`/`0x1f`/`0x7f` bytes embedded in a regex literal instead of the
escape sequences `\x00-\x1f\x7f`. `file(1)` reported it as `data`, and
**ripgrep skipped it as binary** — so the repo's own ripgrep-based
architecture/security checks silently stopped scanning this route's
content past the NUL. **Fix:** replaced the literal bytes with escape
sequences (functionally identical regex; file is now valid UTF-8 and
fully scannable). _Severity raised from cosmetic because it defeated the
static guardrails for a mutation route._

**L2 — Wrong `initiatorEmail` in the checkout-session audit trail.**
`artifacts/resupply-api/src/routes/storefront/me-payments.ts:251` passed
the customer UUID where the PaymentIntent path correctly passes
`link.customerEmail`; the value is stamped into Stripe
`metadata.initiator_email`. **Fix:** pass `link.customerEmail`.

**L3 — 277CA parser dropped dependent-patient claim acks.**
`lib/resupply-integrations-office-ally/src/edi/parse-277ca.ts` only
opened a claim block for HL level `22`/`PT`, never `23` (dependent =
patient distinct from subscriber). **Fix:** treat `23` as an opener,
with a `traceNumber`-guarded flush so the empty subscriber parent block
isn't emitted as a spurious claim. Test added.

**L4 — Misleading control-number lifetime comment.**
`lib/resupply-integrations-office-ally/src/edi/control-numbers.ts`. The
ISA13 base crosses 1e9 (wraps) around **2028-03**, not "past 2050" as
the comment claimed. Monotonicity is still guaranteed by the
`previousHighest` DB guard, so this is a comment-accuracy fix (a scheme
change would alter ISA13 values and risk monotonicity vs. submitted
batches — deliberately not done). **Fix:** corrected comment.

**L5 — Stripe webhook best-effort call not wrapped for parity.**
`artifacts/resupply-api/src/lib/stripe/webhook-handler.ts`.
`tryAutoEnrollReminderFromOrder` was the lone un-try/catch'd side effect
in `checkout.session.completed`; a future refactor removing its internal
guard would 500 the webhook and re-fire all side effects. **Fix:**
wrapped for parity with its siblings.

---

## Deferred — recommend follow-up (risk or product decision)

These are real but were **not** changed here because the fix carries
deploy risk that needs dedicated testing/review, or is a product call.

**D1 (Critical, latent) — Migrator sort orders journaled migrations
before disk-only ones.** `lib/resupply-db/scripts/migrate.mjs`. The
comparator puts all journaled migrations first (by `when`), so the stray
journal entry `0157_backfill` sorts into apply-position ~52, ahead of
`0049`+. Harmless **today** only because that file is self-contained.
The recommended fix (sort uniformly by numeric prefix, ignoring
`hasJournalEntry` for ordering; keep `when` only for the `created_at`
value) changes fresh-DB apply order and **must** be validated by the CI
"Migration replay (Postgres)" job before merge — do it in an isolated PR
gated on that job. Also: the journal is actually **53** entries, not 52
as `CLAUDE.md`/comments state.

**D2 (High) — `CREATE INDEX CONCURRENTLY` can leave an INVALID index
that `IF NOT EXISTS` then skips forever.** `0208_*`. A concurrent index
build that fails partway leaves an invalid index; the no-tx migration
re-runs but `IF NOT EXISTS` treats the invalid index as present.
**Editing an already-applied migration changes its content hash and
makes the migrator re-run it**, so the fix (a `DROP INDEX IF EXISTS`
before each concurrent create) belongs in a _new_ migration + a
documented pattern for future no-tx index builds, not an edit to 0208.

**D3 (High) — Twilio signature verifier drops repeated/array params.**
`lib/resupply-telecom/src/signature.ts`. It only includes
string-valued params in the canonical string; a legitimately repeated
key would mismatch. The failure mode is **fail-closed** (403 on a valid
request), and Twilio's standard webhooks don't repeat keys, so the
practical risk is low — but "fixing" the canonical-string construction
risks breaking _all_ Twilio verification, so it needs a careful,
well-tested change (faithful to Twilio's repeated-key concatenation)
rather than a quick patch.

**D4 (Medium) — Non-idempotent `ADD CONSTRAINT` migrations.** ~14 files
add named constraints with no drop-first / `duplicate_object` guard;
they're safe only while the hash ledger is undisturbed. Same constraint
as D2 (don't edit applied migrations) — adopt the idempotent pattern for
**new** constraint migrations and document it.

**D5 (Medium) — Payment apply-balance is two non-transactional steps.**
`patient-payment.ts` (`markPaymentStatus` → `applySucceededPayment`) and
the documented claim-balance TOCTOU. A crash between the status flip and
the per-claim decrement leaves the balance overstated; two concurrent
"Pay" clicks can over-apply. Both are acknowledged in code comments. The
correct fix needs an idempotent per-claim application ledger (a unique
`(payment_id, claim_id)` row) and/or an advisory lock — i.e. a schema
change, so it belongs in its own reviewed PR.

**D6 (Low, SPA) — assorted lifecycle nits.** `useDraftAutosave` key-
switch write race (`use-draft-autosave.ts`), `useUrlState` popstate stale
closure (`use-url-state.ts`), a handful of un-cleared "just copied/added"
`setTimeout`s (harmless on React 18+), `chat_opened` telemetry
re-firing on navigation while the panel is open (inflates the funnel
count), and `formatMoneyCents` hard-coding `en-US` while accepting a
currency arg (latent if a non-USD price ever lands). Low impact; batch
into a SPA-hygiene PR with a lint rule for the timer pattern.

---

## Process / CI observations (no change needed)

- CI (`.github/workflows/ci.yml`) is comprehensive and well-documented
  (lint+typecheck, drift/architecture/route-gate self-tests, unit +
  Postgres migration-replay + PostgREST integration + a11y + smoke +
  dev-server e2e). `pnpm audit` is clean.
- `.coderabbit.yaml` has `auto_review: enabled: false` (deliberate).
- `attached_assets/` carries ~14 MB of binary images in git; excluded
  from the Docker build via `.dockerignore`, so it's repo-bloat only.
- The node engine is `24.x`; local tooling here ran under Node 22 via
  corepack pnpm 11.5.0 (engine mismatch is a warning, not a failure).
