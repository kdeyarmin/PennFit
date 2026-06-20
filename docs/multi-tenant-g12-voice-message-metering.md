# G12 metering — remaining wire-ups (outbound messages + voice)

**Date:** 2026-06-16
**Status:** Implementation spec for the two G12 usage metrics that were
**not** wired with the others, because each requires touching the
concurrent telecom/messaging workstream's code and resolving a
counting-correctness problem. Do these **with** that workstream to avoid
double-counting and merge conflicts.

**Done already** (for context): the emitter `recordTenantUsage(...)`
(`artifacts/resupply-api/src/lib/metering/usage.ts`, fire-and-forget +
fail-soft, writes the monthly rollup via the `increment_tenant_usage_rollup`
RPC) and three metrics are live —
`aiTextInteractionsPerMonth` (chat surfaces),
`billingTransactionsPerMonth` (eligibility + claim chokepoints), and
`faxEvents` (`dispatchFax`). The two below remain.

---

## `aiVoiceEvents` — one per completed voice call

**Why it's not trivial.** A call's `conversations` row is flipped to
`closed` by **two** independent paths, and they race:

- `lib/voice/ws-handler.ts` → `finalizeConversation()` (media WebSocket
  close). Today it updates `status='closed'` **unconditionally** and emits
  the `voice.call.completed` audit — no dedup guard.
- `routes/voice/status-callback.ts` (Twilio call-status webhook). It flips
  `status='closed'` **guarded** by `.neq("status","closed").select("id")`
  → `firstTerminalClose`, and only the winner emits the audit (handles
  Twilio re-delivery).

Emitting metering in only one path **under-counts** (if the other path won
the close race) or **double-counts** (if both emit).

**Correct design — meter wherever the row is FIRST closed:**

1. Thread `orgId` into `finalizeConversation()` (it currently takes the
   `OrgScopedClient` but not the id; the caller in `ws-handler` has it).
2. Give `finalizeConversation()` the same close-winner guard the
   status-callback uses: `.update({status:'closed'}).neq("status","closed")
.select("id")`; treat a non-empty result as "I closed it".
3. In **both** paths, `void recordTenantUsage({ orgId, metricKey:
"aiVoiceEvents", source: "voice.call.completed" })` **only when that
   path won the close** (`firstTerminalClose` / the new guard). Exactly one
   path wins per call ⇒ exactly one event.

Alternative (simpler, slightly less precise): meter at a single call-START
point — but there's no single start chokepoint either (`routes/voice/
place-call.ts`, `inbound-reorder.ts`, `alert-twiml.ts`, `checkin-twiml.ts`,
`twiml-connect.ts`, …), so the completion-dedup approach above is preferred.

**Lane:** `ws-handler.ts` is owned by the telecom/voice workstream — make
the `finalizeConversation` change there in coordination with them.

---

## `outboundMessagesPerMonth` — one per outbound SMS/email sent

**Why it's not trivial.** There is **no single send chokepoint**. Outbound
sends fan out across many callers, several of them crons:
`lib/smart-triggers/dispatcher.ts`, `lib/clinical/clinical-outreach.ts`,
`lib/checkin-dispatcher.ts`, `lib/patient-packet/send.ts`,
`lib/csr-order/order.ts`, `lib/messaging/in-app-conversation.ts`,
`lib/voice/ws-handler.ts` (SMS fallbacks), the reminders senders, etc. —
each calls a per-tenant Twilio/SendGrid client directly.

**Correct design — instrument the persist layer, once:**

- Find/introduce the single point where an **outbound** `messages` row is
  persisted (today some callers `.from("messages").insert({direction:
"outbound", …})` directly; `in-app-conversation.ts` is one). The clean
  fix is a shared `recordOutboundMessage(orgId, …)` helper that every
  sender funnels through, and emit `recordTenantUsage({ orgId, metricKey:
"outboundMessagesPerMonth" })` there.
- If a shared persist helper isn't feasible short-term, instrument the
  per-tenant messaging client's `sendSms`/`sendEmail` wrapper — but it must
  receive `orgId` (it's constructed per tenant under G7, so the orgId is
  known at construction) and must NOT double-count retries.

**Avoid:** instrumenting only one or a few senders — that ships a
misleading near-zero metric. Either do the shared chokepoint or none.

**Lane:** these senders + the per-tenant messaging client are the
telecom/messaging workstream's (G7) area — coordinate the chokepoint with
them so the instrumentation lands in one place rather than N scattered
edits that conflict.

---

## Acceptance

- A completed voice call increments `aiVoiceEvents` exactly once
  (verified by a two-org integration test that drives both close paths).
- An outbound SMS/email increments `outboundMessagesPerMonth` exactly once
  per send, across every sender (request + cron), with no double-count on
  retry.
- The platform billing console (`routes/platform/billing.ts` →
  `currentUsage`) then reflects real per-tenant usage for all event-based
  metrics.
