# ADR 008 — Multi-channel conversation state

## Context

A single patient conversation may span SMS, voice, and email. A patient
might receive an SMS nudge, ignore it, get a voicemail two days later,
respond by replying YES to the original SMS, and then ask a follow-up
question by email. The AI agent and any operator who picks up the thread
must see the full timeline regardless of channel.

We also have to deal with shared phone numbers — caregivers texting on
behalf of a patient — and with patients who have multiple phone numbers or
emails over time.

## Context (continued — domain model)

- A `Conversation` is an ordered sequence of `Message` rows, all linked to
  the same `patient_id`.
- A `MessageChannel` is sms / voice (transcribed) / email.
- A `ContactPoint` (phone or email) maps to zero-or-more patients via a
  `ConversationContact` join table that records which patient consented for
  which channel from which contact point.

When an inbound message arrives:

1. Look up the contact point. If unknown, store as
   `unrecognized_contact` and queue for operator review.
2. If known, identify the patient(s) the contact point is associated with.
   If exactly one, route to that patient's open conversation.
3. If multiple (e.g. caregiver shared phone), the message goes to a
   disambiguation queue for the operator until consent is established.
4. Append the message to the conversation timeline as a normalized
   `Message` row with `channel`, `direction`, `body`, `vendor_message_id`,
   `received_at`.

## Decision

- Conversations are patient-scoped, not contact-point-scoped. A patient
  has at most one open conversation at a time per topic (resupply,
  fit-issue, billing).
- Each `Message` row records both the channel and the original vendor id
  so we can reconcile with Twilio/SendGrid status callbacks later.
- AI agent context is built from the last N messages on the conversation,
  not from a per-channel window — the whole point is cross-channel
  continuity.
- Voice messages are stored both as recordings (S3 once we have a
  bucket; Postgres bytea blob in dev) and as transcripts. Only the
  transcript is fed to the AI by default; the recording is an audit
  artifact.

## Consequences

- The conversation log is the source of truth for "what did we tell the
  patient and when". Audit and compliance both read from it.
- The disambiguation queue (multi-patient contact points) is a real
  operator workflow that has to be designed in Phase 8. Defer the UI but
  reserve the schema columns now.
- Cross-channel context means the AI prompt can grow large; we cap at
  the last 20 messages or the last 14 days, whichever is shorter, with
  a one-paragraph rolling summary for older context.

## Alternatives Considered

- **Per-channel conversation threads** — simpler schema but breaks the
  product. Patients do not think in channels; they think in topics.
- **Always require a per-patient SMS shortcode reply marker** — too
  brittle; patients copy/paste, forward, or reply from a different
  number.

## TODO

- [BUSINESS REVIEW] Define what "topic" means for conversation routing
  (resupply / fit-issue / billing only? more granular?).
