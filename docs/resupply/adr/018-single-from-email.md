# ADR 018 — One outbound From address (info@pennpaps.com)

## Context

Earlier iterations of the codebase had several SendGrid call sites
that constructed their own clients with their own From addresses
("noreply@…", "orders@…", "system@…"). The result was a fleet of
addresses with inconsistent reply handling, mismatched DMARC
posture, and an unclear "where does the patient's reply go?" answer
for support staff.

CLAUDE.md's hard rule, restated:

> Every outbound email funnels through `lib/resupply-email`'s
> `createSendgridClient()`; `SENDGRID_FROM_EMAIL` is
> `info@pennpaps.com`. Don't bypass the shared client.

This ADR pins the rationale.

## Decision

All outbound email is sent via `createSendgridClient()` from
`@workspace/resupply-email`. The From address is configured by
`SENDGRID_FROM_EMAIL` and is `info@pennpaps.com` in every
environment. The display name is configured by
`SENDGRID_FROM_NAME` so a future contributor can change "Penn Home
Medical Supply" without re-issuing DMARC records.

Concretely:

- `auth.password_reset` — sent from info@pennpaps.com.
- Order confirmations + shipping notifications — same.
- Resupply outreach (reminders, smart-triggers, Rx renewals) — same.
- Insurance-lead patient confirmations — same.
- Back-in-stock notifications — same.
- Cart abandonment nudges — same.
- Admin invites — same.

Reply-To CAN be overridden per send (`replyTo` option on
`SendEmailInput`) — useful when an email should bounce-route to a
specific support inbox rather than the noreply From address. But
the From itself stays one value.

## Why one address

1. **Single DMARC / DKIM posture.** Shared identity means we own
   one DKIM signing path, one SPF record, and one DMARC policy.
   With multiple Froms each one needs its own infrastructure
   ceremony to keep deliverability above the spam folder.
2. **Patient-facing trust.** Reply-from-anywhere creates a "is
   this real?" signal in the patient's inbox. One canonical
   sender — info@pennpaps.com — matches the public web domain.
3. **Support routing.** Patients reply. With one From, replies
   funnel to one inbox. Without, replies scatter across
   `orders@`, `noreply@`, `system@` — half of which nobody
   actually monitors.
4. **Compliance footprint.** A BAA-bound domain (PHI in the
   reminder bodies) is one identity to audit, not five.

## What `createSendgridClient` enforces

- Required env: `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`,
  `SENDGRID_FROM_NAME`. Missing any throws `EmailConfigError` at
  construction.
- Single From wired into every `sendEmail` call. Callers cannot
  override `from`; the option is intentionally absent from
  `SendEmailInput`.
- Sandbox mode opt-in (`mailSettings.sandbox.enable`) for
  preview/staging environments — emails are accepted by SendGrid
  but never actually delivered. Useful so QA flows don't email
  real patients.
- Categorized error class (`EmailApiError`) carries the SendGrid
  status code, so `withRetry` predicates at call sites can
  retry-on-5xx-only without parsing strings.

## Verifying the rule still holds

`lib/resupply-email/src/client.ts` is the single place that reads
`SENDGRID_FROM_EMAIL`. Any other `process.env.SENDGRID_FROM_EMAIL`
read in the resupply tree is a hard violation of this ADR — see
`scripts/check-resupply-architecture.sh` for the broader
chokepoint enforcement (today the script doesn't catch this
specific ENV-read leak; a future enhancement would add it).

Manual check:

```bash
grep -rn "SENDGRID_FROM_EMAIL" lib/ artifacts/ \
  | grep -v lib/resupply-email
```

The expected output is an empty result — no other module reads
the env directly. As of this writing the only matches are in
test fixtures that set the env so a downstream
`createSendgridClient()` call works under vitest.

## When this rule loosens

The decision should be reopened — not silently violated — if:

- The product surfaces multiple distinct sender identities to the
  patient (e.g. a CSR sending from their own work email). That
  sender flow already uses Reply-To not From; if a true-From
  switch is needed, the DMARC plan has to land first.
- A multi-tenant deployment requires per-tenant From identity.
- A jurisdiction-specific compliance regime requires a dedicated
  noreply sender.

## Related

- CLAUDE.md hard rule "One From address."
- `lib/resupply-email/src/client.ts` — the chokepoint.
- `scripts/check-resupply-architecture.sh` — the broader
  cross-package enforcement pattern.
