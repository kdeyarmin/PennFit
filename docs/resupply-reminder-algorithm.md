# Resupply reorder reminder algorithm (SMS → email → voice → human)

_How CareMetric Breathe reminds a patient that their CPAP supplies are due,
across SMS, email, and an automated phone call, and how each touch is worded
to actually close the reorder._

This is the product/ops reference for the multi-channel reminder ladder. The
code that implements it is mapped in the **Where this lives** section at the
end.

---

## 1. Goals

1. **Reach every due patient** on the channel they're most likely to act on,
   without nagging.
2. **Escalate, don't repeat** — if one channel is ignored, try the _next_
   channel rather than re-sending the same thing.
3. **Make the reorder a one-tap (or one-word) action** — every touch ends with
   an explicit, low-friction way to confirm: `YES` by text, a button in email,
   or "yes, go ahead" on the phone.
4. **Stop the instant the patient responds** (confirm, decline, or opt out),
   and never contact outside the patient's local business hours.
5. **Hand a human the patients automation couldn't reach**, with the context of
   what was already tried.

---

## 2. When is a patient "due"?

A patient becomes eligible for a reminder when an **episode** (one resupply
cycle for one prescription) is past due:

```
due  ⟺  daysSince( lastShipped ?? prescriptionCreated )  ≥  cadenceDays
        AND patient.status = 'active'
        AND prescription.status = 'active'
        AND episode.status ∈ { outreach_pending, awaiting_response }
```

`cadenceDays` is resolved per patient, highest priority first:

1. **Per-patient override** — `patients.cadence_override_days`.
2. **First matching frequency rule** — `frequency_rules` matched by SKU prefix /
   payer / tenure window (priority asc).
3. **Prescription default** — `prescriptions.cadence_days`.

The same resolver picks the **first-touch channel** (`patients.channel_preference`
→ rule `default_channel` → SMS if a phone is on file, else email).

---

## 3. The ladder

A single due episode walks **one ladder**, advancing only when the previous
touch goes unanswered. The moment the patient confirms / declines / opts out,
or the order ships, the episode leaves the ladder and is never touched again.

| Step | Day\* | Channel                                | Who runs it                                          | What it does                                                            |
| ---- | ----- | -------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| 0    | 0     | **SMS or email** (first-touch channel) | `reminders.scan` (hourly)                            | First reminder on the resolved channel.                                 |
| 1    | ~3    | **The other text channel**             | `reminders.escalation-scan` (daily)                  | Try email if step 0 was SMS, or vice-versa.                             |
| 2    | ~6    | **Automated phone call** _(opt-in)_    | `reminders.escalation-scan` → `reminders.place-call` | AI agent calls the patient. Retried (up to a cap) if it isn't answered. |
| 3    | ~9    | **Human CSR alert**                    | `reminders.escalation-scan`                          | Raise a `no_response` alert: "recommend a personal call."               |
| —    | 21    | **Stop**                               | `reminders.escalation-scan`                          | Past the max-age cap, stop nagging entirely.                            |

\* Days are approximate. Two timers govern spacing (both **admin-tunable** per
tenant from System Configuration → Resupply reminders, falling back to the defaults):

- **Minimum spacing (`RESUPPLY_ESCALATION_DELAY_DAYS`, default 3)** — measured
  from the **most recent** touch. A patient texted on day 0 and emailed on day 3
  isn't called until ~day 6 and isn't handed to a CSR until ~day 9, instead of
  the whole ladder firing on back-to-back days. Clamped to 1–30.
- **Max age (`RESUPPLY_ESCALATION_MAX_DAYS`, default 21)** — measured from the
  **first** touch. After this many days the episode stops escalating no matter
  where it is in the ladder. Clamped to (spacing)–120.

**The voice tier retries.** Unlike the one-shot text channels, a call that goes
**unanswered / busy / to voicemail** is retried up to `MAX_VOICE_ATTEMPTS` (2),
spaced by the step delay. A call that **reaches a live person** ends the voice
tier immediately (the agent handled it). Voicemail vs live answer is told apart
by Twilio Answering Machine Detection (`AnsweredBy`); if detection never
resolves, a completed call defaults to "reached someone" so detection failing
never blocks the ladder.

The voice tier (step 2) is **opt-in and additive**: it is inserted into a
tenant's ladder only when the `reminder_escalation.voice` feature flag is ON
**and** the voice path is configured. Otherwise the ladder is exactly
SMS → email → CSR alert (the historical behavior) — a single-tenant deploy
that never flips the flag is unchanged.

### Decision tree (per episode, per daily escalation tick)

```
episode still outreach_pending / awaiting_response?
│  no  → leave the ladder (patient responded or order shipped). DONE.
│  yes
├─ firstTouchAge > max-age?           → stop nagging. DONE.
├─ sinceLastTouch < step-delay?       → too soon, wait. DONE for today.
└─ pick next UNSATISFIED channel in ladder (skip ones the patient can't receive):
   ├─ sms   not sent → enqueue SMS reminder
   ├─ email not sent → enqueue email reminder
   ├─ voice not satisfied → place a call            (only if voice tier active)
   │     • satisfied once a call REACHES a live person, OR after MAX_VOICE_ATTEMPTS
   │       unanswered/busy/voicemail calls — an unanswered call is retried
   └─ all satisfied → raise CSR "no_response" alert
```

---

## 4. The map — what each touch says

Copy is intentionally warm, short, and ends with one clear action. PHI never
appears in an email **subject** (subjects aren't encrypted at the provider).

**Each touch escalates its wording** so a follow-up never reads identically to
the first reminder. The text channels (SMS + email) pick one of three copy
**variants**:

- **`initial`** — the first touch (gentle "you're due").
- **`followup`** — a later touch with **more** outreach still to come ("just
  circling back").
- **`final`** — the **last** automated touch before a human is asked to call
  ("last call").

The variant is chosen by ladder position: the first touch is always `initial`;
an escalation touch is `final` when it's the last automated channel left, else
`followup`. So with the voice tier **off** the ladder reads `initial → final`
(SMS then a stronger email/SMS), and with voice **on** it reads
`initial → followup → call`.

### 4a. SMS

- **`initial`:**
  > **Hi {firstName}, it's {practiceName}. You're due for a CPAP refill. Reply
  > YES to ship to the address on file, EDIT to change it, or STOP to opt out.**
- **`followup`:**
  > **Hi {firstName}, just checking back from {practiceName} - your CPAP refill
  > is ready when you are. Reply YES to ship, EDIT to change address, or STOP to
  > opt out.**
- **`final`:**
  > **Last reminder, {firstName} - we don't want you to run out of CPAP
  > supplies. Reply YES and {practiceName} ships today, or STOP to opt out.**

All three are kept under one GSM-7 segment (160 chars, no em-dashes / curly
quotes / ellipsis) so they don't silently bill as multiple segments.

### 4b. Email

The body (items list, "keeping these fresh" reassurance, and the
Confirm / Change-address / Stop buttons) is shared; the **subject** and
**opening line** change per variant:

| Variant    | Subject                                 | Opening line                                                                                          |
| ---------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `initial`  | Time to refill your CPAP supplies       | "quick note from {practiceName} — you're due for a CPAP refill…"                                      |
| `followup` | Still time to refill your CPAP supplies | "just circling back from {practiceName} — your CPAP refill is ready whenever you are…"                |
| `final`    | Last call: your CPAP refill is ready    | "we don't want you to run low — your CPAP refill from {practiceName} is ready and we can ship today…" |

- **Body (shared):**
  > Hi {firstName} — {opening line, per variant above}
  >
  > _{itemized list of supplies due}_
  >
  > Keeping these fresh matters — a worn cushion leaks and an old filter makes
  > your machine work harder, so an on-time refill keeps your therapy doing its
  > job. Most plans cover the replacement and we verify yours before anything
  > ships, so there are no surprise bills.
- **Buttons (signed, 7-day links):**
  - **Confirm my order** → "Here's what's due. Tap the button below to confirm
    and we'll ship your supplies right away."
  - **Change my address** → "Click the button below and a member of our team
    will reach out about your shipping address."
  - **Stop these reminders** → unsubscribe.
- **Confirmation screen after a click:** "You're all set — your refill is on
  the way. We'll text or email tracking the moment it ships."

### 4c. Automated phone call (step 2)

The call uses the same AI voice agent an admin reaches with the patient
**Call** button. Twilio dials the patient; when they answer "Hello?", the agent
runs this grounding context:

> Outbound CPAP resupply check-in. Verify identity by date of birth, review
> supplies due, confirm shipping address, and place the order.

The agent: greets and names the practice, confirms identity by date of birth,
states what's due, confirms (or updates) the shipping address, and **places the
order in-call** on a yes. If the patient is busy, hesitant, or asks for a human,
it offers to follow up and hands off. A post-call summary (outcome, sentiment,
any clinical concern, recommended hand-off) is written for the review queue.

### 4d. Human CSR alert (step 3)

No patient-facing copy. A `csr_compliance_alerts` row (`alert_type =
'no_response'`) is raised for a person to make a personal call:

> Unresponsive after SMS, email, and an automated call refill reminders —
> recommend a personal call.

(The list of channels named adapts to what was actually tried.)

---

## 5. How the patient completes the reorder

Every channel routes back into the same order-placement path.

| Patient does                              | We do                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Texts **YES** / "yeah" / "ok" / "confirm" | Place the resupply order to the address on file; reply "Got it — shipping now."                              |
| Texts **EDIT** / "change" / "address"     | Set the thread `awaiting_admin`; reply "An agent will follow up about your address."                         |
| Texts **NO** / "skip"                     | Close the episode (declined); reply "No problem."                                                            |
| Texts **STOP** / "unsubscribe"            | Pause the patient + close the thread (carrier-compliant opt-out).                                            |
| Texts **HELP**                            | Reply with help text.                                                                                        |
| Texts **START** / "unstop"                | Re-subscribe the patient.                                                                                    |
| Texts anything else                       | AI intent classifier; low-confidence or order/account/clinical messages route to a human (`awaiting_admin`). |
| Clicks the email **Confirm** button       | Place the order; show the confirmation screen.                                                               |
| Says **yes** on the call                  | The agent places the order in-call.                                                                          |

Inbound SMS is matched to the patient by their phone number; email actions ride
signed, expiring links — so a reply or a click always lands on the right
episode.

---

## 6. Guardrails

- **Quiet hours (TCPA):** automated SMS, email, and calls only go out
  **9am–8pm in the patient's local timezone** (`patients.timezone`, default ET).
  The escalation sweep runs at 18:00 UTC (inside that window for the continental
  US); the send/dial jobs re-check per recipient as a backstop for HI/AK.
- **48-hour quiet period:** the hourly scan won't ping an episode that already
  had a conversation in the last 48h, so a manual touch or a prior scan can't
  double-fire.
- **Per-day idempotency:** each (patient, episode, channel, local-day) send is
  dedup-claimed, so a worker retry after a vendor hiccup can't double-send or
  double-dial.
- **Channel-capability aware:** the escalation only steps to channels the
  patient can actually receive — SMS and voice need a phone, email needs an
  address. An email-only patient skips the SMS/voice tiers and reaches the CSR
  hand-off directly, instead of the ladder stalling forever on an
  un-deliverable step.
- **Opt-out is sticky:** a STOP pauses the patient; the escalation sweep
  escalates only `active` patients, so a paused patient leaves every ladder
  (no further sends, no wasted re-enqueues) until they re-subscribe.
- **Fail soft:** if a channel isn't configured (no Twilio / SendGrid / voice
  keys) the corresponding step logs and exits cleanly — it never breaks the
  deploy or the rest of the ladder.
- **No PHI in logs or audit metadata** — only structural identifiers, never
  message bodies, phone numbers, or call audio/transcripts.

---

## 7. Configuration

| Control                          | Type                                                   | Default         | Effect                                                                      |
| -------------------------------- | ------------------------------------------------------ | --------------- | --------------------------------------------------------------------------- |
| `sms.reminders`                  | feature flag                                           | on              | First-touch + escalation SMS.                                               |
| `email.reminders`                | feature flag                                           | on              | First-touch + escalation email.                                             |
| `reminder_escalation.dispatcher` | feature flag                                           | (per migration) | Master switch for the daily escalation sweep.                               |
| `reminder_escalation.voice`      | feature flag                                           | **off**         | Adds the automated-call tier to the ladder. Opt-in per tenant.              |
| `patients.cadence_override_days` | column                                                 | null            | Per-patient cadence.                                                        |
| `patients.channel_preference`    | column                                                 | null            | Per-patient first-touch channel.                                            |
| `frequency_rules`                | table                                                  | —               | SKU/payer/tenure-scoped cadence + channel.                                  |
| `RESUPPLY_ESCALATION_DELAY_DAYS` | app_config (System Configuration → Resupply reminders) | 3               | Min days between ladder steps (clamped 1–30).                               |
| `RESUPPLY_ESCALATION_MAX_DAYS`   | app_config (System Configuration → Resupply reminders) | 21              | Stop-nagging age from first touch (clamped (delay)–120).                    |
| `MAX_VOICE_ATTEMPTS`             | constant                                               | 2               | Voice dial cap before the CSR hand-off (unanswered calls retry up to this). |

The voice tier additionally requires the voice path to be configured:
`OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_PHONE_NUMBER`, and `RESUPPLY_VOICE_PUBLIC_BASE_URL` (or
`RAILWAY_PUBLIC_DOMAIN`). Each tenant can send from its own SMS / voice
number (`organizations.sms_from_number` / `voice_from_number`).

Per-tenant metering: each SMS/email counts as `outboundMessagesPerMonth`; each
automated call counts as `aiVoiceEvents`.

---

## 8. Where this lives

| Concern                                            | File                                                                                                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-touch scan + per-channel SMS/email send      | `artifacts/resupply-api/src/worker/jobs/reminders.ts`                                                                                                                                             |
| Eligibility / cadence + channel resolver           | `lib/resupply-domain/src/outreach-plan.ts`                                                                                                                                                        |
| Escalation ladder (spacing, voice tier, CSR alert) | `artifacts/resupply-api/src/worker/jobs/reminder-escalation.ts`                                                                                                                                   |
| Automated-call send job                            | `artifacts/resupply-api/src/worker/jobs/reminder-voice.ts`                                                                                                                                        |
| Shared outbound-call placement (route + worker)    | `artifacts/resupply-api/src/lib/voice/place-outbound-call.ts`                                                                                                                                     |
| Admin "Call" button route                          | `artifacts/resupply-api/src/routes/voice/place-call.ts`                                                                                                                                           |
| SMS reminder copy                                  | `lib/resupply-reminders/src/send-sms.ts`                                                                                                                                                          |
| Email reminder copy + signed CTAs                  | `lib/resupply-messaging/src/email-templates.ts`                                                                                                                                                   |
| Inbound SMS keyword routing                        | `lib/resupply-messaging/src/keyword-router.ts`, `artifacts/resupply-api/src/routes/sms/inbound.ts`                                                                                                |
| Voice agent grounding context                      | `artifacts/resupply-api/src/lib/voice/ws-handler.ts`                                                                                                                                              |
| Voice tier opt-in flag (seed)                      | `lib/resupply-db/drizzle/0395_reminder_escalation_voice_flag.sql`                                                                                                                                 |
| Voice-call disposition (AMD) column                | `lib/resupply-db/drizzle/0400_voice_calls_answered_by.sql`                                                                                                                                        |
| Tunable cadence (Control Center settings)          | `artifacts/resupply-api/src/lib/app-config/catalog.ts` (`RESUPPLY_ESCALATION_*`)                                                                                                                  |
| Reorder funnel view (admin page + API)             | `artifacts/cpap-fitter/src/pages/admin/admin-reorder-reminders.tsx`, `artifacts/resupply-api/src/routes/admin/reorder-reminders.ts`, `artifacts/resupply-api/src/lib/analytics/reorder-funnel.ts` |
