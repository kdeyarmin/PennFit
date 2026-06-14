# Resupply reorder playbook — how the bots drive reordering

How PennFit's automated systems (chat, SMS, email, and phone) encourage
and make it easy for patients to place CPAP resupply orders, the evidence
behind the approach, and where each lever lives in the code.

This is the single reference for anyone tuning resupply-conversion copy.
Keep it in sync when the prompts/templates below change.

## Why this matters

Worn CPAP supplies are the quiet #1 reason therapy stops working — a
hardened cushion leaks, a clogged filter overworks the motor, old tubing
harbors bacteria. Industry data on managed resupply programs is
consistent:

- Patients enrolled in a resupply program cut first-year therapy
  termination roughly in half.
- Programs that combine automated, multi-channel outreach with
  one-tap/one-reply confirmation report materially higher order rates and
  recurring revenue than single-channel or manual outreach.
- The biggest single retention lever is **set-and-forget auto-ship**
  (Subscribe & Save): it removes the "did I remember to reorder?" failure
  mode entirely.

Sources reviewed (June 2026): WellSky "5 tips for a successful CPAP
resupply program", HME News "Resupply: Optimize patient engagement",
ResMed ReSupply overview, NikoHealth / ACU-Serve / Curasev DME-resupply
guidance.

## The strategy, distilled to five levers

1. **Make confirming effortless.** The lowest-friction path wins. SMS
   "reply YES", a one-tap email button that ships to the address on file
   with no login, and a phone agent that just asks "want me to send those
   out?" all beat any flow that makes the patient log in, fill a form, or
   re-enter an address.
2. **Lead with care, not the sale.** Frame every nudge around the
   patient's sleep and therapy quality ("fresh supplies keep the therapy
   working"), never around buying more. Warm, never pushy. If they
   decline, respect it cheerfully.
3. **Personalize and time it.** Anchor the nudge in the patient's own
   data where we have it (last order date, what's due, no active
   subscription) and to the replacement schedule. Generic blasts convert
   worse than "your cushion's about due."
4. **Handle the three real hesitations.** Almost every "no/not now" is one
   of: _"I still have some"_ (old supplies degrade even unused — line up
   the next set so there's no gap), _"is it covered / how much?"_ (most
   plans cover the replacement schedule; we verify the specific plan
   before shipping — never quote a dollar amount or promise approval), or
   _"it's a hassle every time"_ (that's exactly what Subscribe & Save
   solves).
5. **Promote auto-ship (Subscribe & Save).** For anyone who keeps
   forgetting or finds reordering a chore, set-and-forget is the real
   answer: ships automatically on the chosen cadence, pause/skip/cancel
   anytime, and 10% off the one-time price on the cash-pay program.

## Where each lever lives in the code

| Channel                         | File                                                                                                                                 | What it does                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storefront chat (public)**    | `artifacts/resupply-api/src/lib/storefront/chatbotKnowledge.ts` → `RESUPPLY_REORDER_SECTION` + enhanced `SUBSCRIBE_AND_SAVE_SECTION` | Teaches PennBot to treat any supply/reorder question as a green light: lead with benefit, give ONE concrete next step, handle hesitations, promote auto-ship. Public/unauthenticated — it never claims to see an account; it makes the self-service path obvious. |
| **Signed-in account chat**      | `artifacts/resupply-api/src/lib/storefront/customerChatKnowledge.ts` → `PROACTIVE_RESUPPLY_SECTION`                                  | Account-aware: uses the order/subscription context + tools (`get_my_recent_orders`, `get_my_subscriptions`) to time a gentle, data-anchored nudge and point to the one-tap "Buy this again" reorder or Subscribe & Save.                                          |
| **Email auto-reply**            | grounded in the SAME `buildChatSystemPrompt()` knowledge as chat, via `artifacts/resupply-api/src/lib/messaging/email-auto-reply.ts` | Inherits the reorder guidance automatically. Still hands off anything order/account-specific to a human per its confidence gate — the bot encourages and informs, it does not place orders.                                                                       |
| **Email reminder**              | `lib/resupply-messaging/src/email-templates.ts` → `renderResupplyReminder`                                                           | Benefit + coverage reassurance copy, a single primary "Yes, ship it" CTA that's one tap to the address on file (no login), plus the item cards on the click-landing page (the proven confirmation-rate lever).                                                    |
| **SMS reminder**                | `lib/resupply-reminders/src/send-sms.ts`                                                                                             | "Reply YES to ship to the address on file" — deliberately kept under the 160-char GSM-7 segment cap so it stays single-segment (cost) while preserving the lowest-friction confirm path.                                                                          |
| **SMS replies / fence-sitters** | `artifacts/resupply-api/src/lib/messaging/ai-fallback-impl.ts` → `SYSTEM_PROMPT`                                                     | When a reply isn't a clean YES/NO, classifies questions/hesitations as `help` and writes a warm, reassuring reply that addresses the concern and invites a YES — without promising a price or guaranteeing coverage.                                              |
| **Phone / voice agent**         | `lib/resupply-ai/src/prompts.ts` (patient flow, `PROMPT_VERSION` 2026-06-14.v10)                                                     | After reading back what's due, the agent gently moves toward placing the order, meets the three hesitations with care, and offers to hand off to set up auto-ship. Caring, never salesy.                                                                          |

## Hard boundaries (these still hold)

These conversion changes do **not** loosen any safety rule:

- The bots **never promise an out-of-pocket price or insurance approval.**
  We verify the specific plan before each shipment.
- The public/email bots **never claim to see a specific patient's
  account, order history, prescription, or eligibility date**, and never
  fabricate one. The account chat uses only the scoped, signed-in tools.
- No bot pressures a patient who declines. One soft nudge, then drop it.
- No PHI in logs, no image logging, no order request bodies in the
  application logger (see `CLAUDE.md` hard rules).
- The voice agent still verifies identity (DOB) before any
  patient-specific information, and only `place_resupply_order` via its
  tool — it cannot promise an action it can't complete with a tool.

## Tuning notes

- Editing `lib/resupply-ai/src/prompts.ts` requires bumping
  `PROMPT_VERSION` and recording the new hash in
  `prompts.version-pin.test.ts` (the drift detector explains how).
- The public chat prompt has a 110k-char cap and the signed-in prompt a
  40k-char cap (tests enforce both) — keep additions tight.
- SMS bodies must stay GSM-7 and under 160 chars or Twilio silently
  triples the per-message cost; benefit copy belongs in the email/voice
  channels, not the SMS reminder body.
- Measure what works: the SMS classifier emits a per-intent
  `ai_fallback_classified` log line, and email click-throughs flow
  through the signed-link `/email/click` route — both are the signals to
  watch when judging whether a copy change moved confirmation rate.
