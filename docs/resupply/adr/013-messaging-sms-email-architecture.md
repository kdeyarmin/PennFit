# ADR 013 — Messaging (SMS + Email) Architecture for CPAP Resupply

**Status**: Accepted
**Date**: 2026-04-28
**Supersedes**: none
**Related**: ADR 004 (Twilio for telecom), ADR 006 (Claude for AI), ADR 007
(Encryption: pgcrypto-not-KMS), ADR 008 (Voice conversation architecture).

## Context

The voice subsystem (ADR 008) handles real-time phone calls with patients.
Voice covers a small fraction of the actual reminder workflow: most patients
prefer text or email, and most reminders should never need a human voice
call. We need an interactive, two-way messaging subsystem for:

1. Outbound resupply reminders ("Time to refill your CPAP supplies — reply
   YES to confirm, NO to decline").
2. Inbound replies from patients (SMS texts back, email link clicks).
3. PHI-safe handling end to end (HIPAA constraints).
4. Integration with the existing single-writer audit trail
   (`lib/resupply-audit`) and encrypted-at-rest message store.

## Decision

We are building a hybrid scripted-keyword + AI-fallback messaging layer with
the following structural pieces. Each was chosen to mirror the patterns
already established by the voice subsystem, so the codebase has ONE shape
for "comms with patient", not two divergent ones.

### 1. Channels — SMS via Twilio Programmable Messaging, Email via SendGrid

- SMS reuses the existing `lib/resupply-telecom` Twilio adapter (the same
  vendor we already use for voice — ADR 004). We extended the adapter with
  `sendSms()` and a zod parser for the inbound webhook params; we did NOT
  add a second telecom vendor.
- Email is a new dependency: SendGrid via `@sendgrid/mail`. It lives in a
  brand-new `lib/resupply-email/` package, structurally symmetric with
  `lib/resupply-telecom/` (Rule 12 — see below). SendGrid was chosen over
  AWS SES / Mailgun because SendGrid is HIPAA-eligible on Pro+ plans, has a
  signed Event Webhook (we can verify delivery / bounce events), and has
  the lowest engineering surface for transactional templated email.
- Inbound email PARSING (SendGrid Inbound Parse, parsing free-text
  replies) is **explicitly out of scope**. Email is one-way outbound +
  link-click inbound only. Free-text email replies that arrive at the
  configured From address are NOT processed in v1; we'll revisit if
  the admin backlog says we need it.

### 2. Phone → patient lookup via a separate `phone_lookup` table

> **Section status: Superseded by migration 0025.** When pgcrypto
> column-level PHI encryption was stripped, the patients table's
> `phone_e164` became a queryable plaintext column and the
> `phone_lookup` table + its `RESUPPLY_PHONE_HMAC_KEY` secret were
> dropped. Inbound-SMS routing now indexes `phone_e164` directly. The
> original rationale below is preserved for context.

The patients table used to store the phone number encrypted with
pgcrypto (ADR 007, also superseded). Encrypted ciphertext is _not_
indexable for equality lookup, so we couldn't answer "what patient
does +12155551234 belong to?" directly from the patients table.

We added `phone_lookup(patient_id PK→patients.id, hmac_phone bytea
unique not null, created_at timestamptz)`. `hmac_phone` was
HMAC-SHA256(normalized E.164) keyed on a NEW secret
`RESUPPLY_PHONE_HMAC_KEY` — distinct from `RESUPPLY_DATA_KEY` so a
leaked phone-lookup key couldn't decrypt anything else. The HMAC was
deterministic (no salt) so the unique-index lookup worked in a single
SQL query; this was an acceptable trade-off because the ciphertext was
already protected by the secret key, and an attacker with read access
to the table but NOT the key could only do a small offline rainbow-table
attack against E.164 phone numbers (~10^10 keyspace) — slow at
HMAC-SHA256 cost per guess and only useful if they ALSO had the
encrypted patient row (which didn't include the patient's phone in
plaintext anywhere).

The patients-table phone column was NOT changed by this ADR; the new
table was purely additive. If a patient's phone changed, we inserted
a new `phone_lookup` row on the next outbound send and left the old
one in place (so old inbound replies still routed correctly).

### 3. Hybrid scripted-keyword + AI-fallback router

Inbound SMS replies go through a two-stage parser:

1. **Scripted keyword router** (`lib/resupply-messaging/keyword-router.ts`)
   — pure, vendor-free, exhaustively unit-tested. Matches case-insensitive
   trimmed body against a fixed table: `Y/YES/YEAH/OK → confirm`,
   `N/NO/NOPE → decline`, `EDIT/CHANGE/ADDRESS → edit_address`,
   `STOP/UNSUBSCRIBE/QUIT → stop`, `HELP/INFO → help`. Returns
   `{intent: 'unknown', body}` when nothing matches.
2. **AI fallback** (only on `unknown`) — the API process calls a small
   OpenAI Chat Completions classifier with the inbound text + recent
   thread context, constrained to return JSON with one of the same
   intent enum values + an optional free-text patient-facing reply.
   Adapter interface lives in `lib/resupply-messaging/ai-fallback.ts`
   so the SDK stays out of the pure semantic layer (Rule 11).

This split exists because >95% of replies are happy-path keywords (cheap

- fast + auditable), and the rest deserve a real classifier rather than
  "sorry I didn't understand". The keyword router is the load-bearing
  path; the AI is the safety net. STOP and HELP are honored
  unconditionally (US carrier rule), regardless of conversation state or
  AI verdict.

### 4. Email interactivity via HMAC-signed short-TTL link tokens

Email is a one-way channel + clicks. Each outbound reminder embeds three
links: Confirm, Edit address, Stop reminders. Each link carries a
URL-safe base64 token of `{conversationId, action, expiresAt}` signed
with HMAC-SHA256 keyed on a NEW secret `RESUPPLY_LINK_HMAC_KEY`
(separate from data + phone keys). Default TTL: 7 days. Verification is
constant-time and does not touch the DB before the signature passes.

This avoids a second free-text channel (no inbound email parsing
needed) while still giving patients a real interactive choice. Tokens
are bound to a conversationId, so a leaked token can only act on the
one episode, not on the patient's entire account.

### 5. Reminder scheduling — pg-boss recurring scan

`reminders.scan` runs hourly via pg-boss cron. It selects patients with
prescriptions overdue per `cadenceDays` since the last `fulfillments`
row, skips `paused`/`closed` patients, and skips any patient who already
got a conversation opened in the last 48 hours (quiet period — prevents
the same patient from being pinged twice in a single overdue window).
Per-patient send jobs (`reminders.send-sms` / `reminders.send-email`)
fan out from the scan and call into a SHARED helper
(`lib/resupply-reminders/`) that the admin-facing API routes use
too — so worker-triggered and admin-triggered sends go down the
exact same code path with the exact same audit trail.

### 6. Channel selection (v1 default)

For v1, channel preference is implicit:

- Phone present → SMS preferred (higher engagement, lower latency).
- Phone absent OR SMS send fails → email fallback (best-effort).
- Both phone AND email present → SMS only on the first attempt; email
  is reserved for the next scan cycle if the SMS conversation does not
  reach `confirmed` / `closed` within the quiet period.

This avoids double-pinging the same patient on the same overdue
episode. We did NOT add a `patients.preferred_channel` column for v1
because every conversation we've had with the practice in the last
sprint has been "send SMS first" — adding a preference column without
a UI to manage it would be cargo-cult schema. The column is on the v2
roadmap once the dashboard has a patient-edit form.

### 7. Single audit writer (Rule 8) — new event types

Per Rule 8, `lib/resupply-audit.logAudit()` remains the only function
that writes to `audit_log`. We added the following event types — all
PHI-safe (structural metadata only, never bodies / phone numbers /
email addresses):

- `messaging.reminder.sent` — outbound SMS or email sent.
- `messaging.inbound.received` — inbound SMS arrived (no body in meta).
- `messaging.intent.parsed` — keyword router OR AI fallback verdict.
- `messaging.order.confirmed` — patient confirmed a resupply order.
- `messaging.handoff.escalated` — admin queue assignment.
- `messaging.delivery.failed` — Twilio status callback says
  `failed`/`undelivered`.
- `email.delivery.bounced` — SendGrid Event Webhook bounce.
- `email.link.clicked` — patient clicked a signed link (action audited).

### 8. Architecture rules 11, 12, 13 — package boundaries

- **Rule 11**: `lib/resupply-messaging/` is a PURE semantic layer. May
  not import `pg`, `@workspace/resupply-db`, `twilio`, `@sendgrid/mail`,
  `openai`, `@anthropic-ai/sdk`, or `ws`. Its job is keyword parsing,
  link-token signing, email template string assembly, intent enums.
  Mirrors the same separation that keeps `lib/resupply-domain` pure.
- **Rule 12**: `lib/resupply-email/` is the SendGrid adapter. May
  import `@sendgrid/mail` (its only purpose) but may not reach into
  the DB layer or any other vendor SDK. Symmetric with Rule 10
  (`lib/resupply-telecom` owns Twilio).
- **Rule 13**: `lib/resupply-reminders/` is the SHARED outbound code
  path called by both API routes and worker jobs. It IS allowed to
  import `pg` (the helpers receive a Pool and need the type), the DB
  layer, telecom, email, messaging, and audit — that is its entire
  job, composing them. It is NOT allowed to import vendor SDKs
  directly; Twilio goes through `resupply-telecom`, SendGrid goes
  through `resupply-email`. Inlining a vendor SDK here would re-create
  the split-import problem the wrapper libs were built to prevent.

All three rules have positive AND negative self-tests in
`scripts/check-resupply-architecture.sh.test`.

## Consequences

### Positive

- Inbound SMS routes by phone in O(1) without ever decrypting the
  patients table.
- Hybrid router is cheap on the happy path and graceful on the long tail.
- Outbound email never needs an inbound parser because clicks suffice.
- Admin-triggered + worker-triggered sends share one code path,
  one audit shape, one set of tests.
- Each new package boundary is enforced by an architecture self-test
  so a future contributor cannot silently bypass it.
- All new secrets are namespaced and rotatable independently
  (`RESUPPLY_LINK_HMAC_KEY`; the `RESUPPLY_PHONE_HMAC_KEY` was
  retired alongside `phone_lookup` in migration 0025).

### Negative / Trade-offs

- (Historical, no longer applies after migration 0025.) The
  `phone_lookup` HMAC was deterministic (required for unique-index
  equality lookup), so an attacker with both DB read access AND the
  HMAC key could enumerate the E.164 keyspace offline. Mitigation at
  the time: the key was a separate secret from `RESUPPLY_DATA_KEY`,
  the keyspace was bounded, and the attack only linked phone →
  opaque patient_id with no PHI attached. Both the table and the key
  are gone now.
- AI fallback is best-effort. If OpenAI is down or slow, we degrade
  to "admin queue, no auto-action" — the conversation is parked
  and the patient gets a "we'll get back to you" reply rather than
  the system guessing.
- Channel selection is hard-coded SMS-first for v1. Adding patient
  preference is a v2 schema + dashboard change.
- Free-text inbound email is unsupported. If a patient replies in
  prose to an outbound reminder, we'll see a delivery on the From
  inbox but not act on it; this is logged as a known gap.

## Alternatives considered

- **Plain phone column with deterministic encryption** — rejected;
  pgcrypto `pgp_sym_encrypt` is non-deterministic by design (random
  salt) and "deterministic encryption" packages are a larger
  cryptographic surface than HMAC.
- **AWS SNS for SMS, Mailgun for email** — rejected; we already have
  Twilio for voice (ADR 004) and adding a third vendor doubles the
  webhook signature / config surface for no net benefit.
- **Pure scripted router, no AI fallback** — rejected; ~5% of replies
  would dead-end at "sorry I didn't understand" and end up in the
  admin queue, defeating the automation goal.
- **Pure AI router** — rejected; cost, latency, auditability, and
  carrier-required STOP/HELP handling all argue for a deterministic
  first stage.
- **Inbound Email Parse via SendGrid** — deferred to v2; doubles the
  webhook surface for a small expected volume.

## References

- ADR 004 — Twilio for telecom
- ADR 007 — Encryption: pgcrypto, not KMS
- ADR 008 — Voice conversation architecture
- `scripts/check-resupply-architecture.sh` (Rules 11, 12, 13)
- `lib/resupply-messaging/`, `lib/resupply-email/`, `lib/resupply-reminders/`
- `artifacts/resupply-api/src/routes/{sms,email}/`
- `artifacts/resupply-worker/src/jobs/reminders.ts`
