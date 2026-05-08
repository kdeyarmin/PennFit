# ADR 016 — Single SendGrid From address for all outbound email

## Context

Outbound email from the resupply stack covers a wide spectrum of
intents: order confirmations, reminder nudges, password-reset
links, signup verification, CSR replies, fax-failure alerts, and
ops notifications. Without a deliberate decision, each subsystem
would naturally pick its own From address — `orders@`, `reminders@`,
`noreply@`, `support@`, `ops-alerts@`, etc. That's the path of
least resistance: each module imports SendGrid, picks a sender,
ships its email.

That path has three problems:

1. **Deliverability fragmentation.** Each From address needs SPF
   alignment, a DKIM key, a DMARC policy, and a SendGrid-side
   verified-sender record. Per-address engineering overhead is real
   and the team tends to skip steps on the lower-volume ones,
   which is exactly when reputation hits matter most.
2. **Reply confusion.** Patients reply to whatever they got. If
   replies go to `noreply@`, support is invisible to the patient.
   If they go to `support@`, but the original was sent from
   `reminders@`, threads break in the recipient's mail client.
   Both failure modes appear in real ticket traffic.
3. **Vendor relationship drift.** Each From address is one more
   thing in the SendGrid dashboard for someone to break — pause,
   misconfigure, lose track of. We've watched it happen on other
   stacks.

CLAUDE.md captures this as a hard rule:

> **One From address.** Every outbound email funnels through
> `lib/resupply-email`'s `createSendgridClient()`;
> `SENDGRID_FROM_EMAIL` is `info@pennpaps.com`. Don't bypass the
> shared client.

This ADR records the decision behind that rule.

## Decision

All outbound email from the resupply stack uses **one From
address**: `info@pennpaps.com`.

- The address is set at the SendGrid client construction site —
  `lib/resupply-email/src/client.ts:117` reads
  `SENDGRID_FROM_EMAIL` and `SENDGRID_FROM_NAME` from env and
  bakes them into the returned `SendgridClient`. Senders cannot
  override on a per-call basis.
- The shared client is the only path. Auth (`lib/resupply-auth`),
  reminders (`lib/resupply-reminders`), order confirmations
  (`artifacts/resupply-api/src/lib/order-emails`), and CSR replies
  all go through `createSendgridClient()`. New senders MUST do
  the same; bypassing means re-doing SPF / DKIM / DMARC alignment
  on a per-feature basis.
- Replies are routed to the same inbox via SendGrid's reply
  routing or a mailbox alias on the address; details live with
  the operations team, not in code.

## Consequences

- One vendor record to maintain. One DKIM key, one DMARC policy,
  one SPF record. Reputation accrues to one identity.
- All replies land in one inbox the support team monitors. No
  thread-break for patients.
- Per-stream subject lines and `replyTo` overrides are still
  available (see the `replyTo` arg on
  `SendgridClient.sendEmail`) — when a CSR reply genuinely needs
  to land in an individual rep's inbox, the From stays the same
  but the `Reply-To` differentiates. Patients still see one
  consistent sender identity.
- A single point of failure: if `info@pennpaps.com` is suspended
  by SendGrid (reputation hit, billing issue), every outbound
  channel goes down at once. Mitigation: keep the SendGrid
  account in good standing, watch the SendGrid status page, and
  document the manual fallback in the operations runbook.

## Migration trigger

Split addresses when **all** of these become true:

- A specific outbound stream's volume + content profile creates a
  distinct deliverability identity (e.g. high-volume marketing
  vs. transactional confirmations) where pooled reputation is a
  liability.
- The team has bandwidth to maintain a second set of SPF / DKIM /
  DMARC records and a second SendGrid sender.
- A concrete deliverability problem on the shared identity is
  attributable to the lack of separation, not just suspected.

Until all three are true, splitting is premature optimization.

## Alternatives Considered

- **Per-subsystem From addresses** (`orders@`, `reminders@`,
  `noreply@`). Rejected for the reasons in Context — deliverability
  fragmentation, reply confusion, vendor drift.
- **Two addresses: transactional vs. marketing.** Reasonable
  industry pattern but premature for current volume; revisit at
  the migration trigger above.
- **No-reply for transactional, support for everything else.**
  Rejected because patients reply to transactional email far more
  than the industry average for our population, and `noreply` is a
  worse experience than letting a real reply land in support.

## Related

- `lib/resupply-email/src/client.ts` — `createSendgridClient`
  factory (the chokepoint).
- `lib/resupply-email/src/index.ts` — public surface.
- CLAUDE.md "Hard rules — do not break" — quotes this ADR's rule.
- `.env.example` — `SENDGRID_FROM_EMAIL` documented as required.
