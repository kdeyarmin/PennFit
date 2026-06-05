# ADR 004 — Twilio for SMS, Voice, and Email

## Context

Outreach requires three channels: SMS, voice, and email. We need a single
vendor relationship to minimize BAA paperwork, and we need the BAA to cover
all three.

## Decision

Use Twilio for SMS and Voice, and SendGrid (Twilio-owned) for transactional
email. Twilio's BAA explicitly covers all three product lines on the
Enterprise plan.

- SMS: Twilio Programmable Messaging via a 10DLC-registered Messaging
  Service SID. STOP / HELP / UNSUBSCRIBE are handled by Twilio's Advanced
  Opt-Out + locally enforced suppression (see ADR 006).
- Voice: Twilio Programmable Voice. Outbound caller-id is verified and
  SHAKEN-attested. Inbound calls are routed to a TwiML webhook that
  decides AI vs admin queue.
- Email: SendGrid via Twilio's API. Domain authentication (SPF / DKIM /
  DMARC) is required before any production send.

All three are accessed through typed adapter interfaces in
`lib/resupply-telecom` so test code can swap in mocks and so a future
vendor switch (Bandwidth, Vonage, Postmark) does not touch business code.

## Consequences

- One vendor BAA covers all three channels.
- Twilio webhooks (status callbacks, inbound SMS, inbound voice) are
  signature-verified on the api server — the verification middleware lives
  in `artifacts/resupply-api/src/middlewares/`.
- Idempotency keys on every send (Redis-style key-value with 7-day TTL,
  but stored in Postgres via pg-boss instead of Redis — see ADR 002).

## Alternatives Considered

- **Bandwidth** — competitive on voice but a second vendor relationship
  for email (SendGrid, Postmark, Mailgun) defeats the BAA-consolidation
  goal.
- **Vonage / MessageBird** — same issue.
- **Postmark for email** — better deliverability reputation than SendGrid
  for transactional, but adds a separate BAA. Revisit if SendGrid
  deliverability fails our metrics.

## TODO

- [DONE] Twilio BAA is executed (covers SMS, Voice, and SendGrid email).
- [BUSINESS REVIEW] 10DLC brand and campaign registration is a 2–4 week
  process; start in parallel with code work.
