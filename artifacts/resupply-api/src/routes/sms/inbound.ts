// POST /sms/inbound — Twilio inbound SMS webhook.
//
// Flow:
//   1. requireTwilioSignature middleware — reject unsigned/forged requests.
//   2. Parse body (form-urlencoded → zod) into InboundSmsParams.
//   3. Hash `From`. Look up patient via phone_lookup.
//      - Unknown number → audit `messaging.inbound.received{outcome:'unknown_phone'}`,
//        respond with TwiML <Message> opt-out boilerplate.
//   4. Find latest open SMS conversation for this patient (or create one
//      bound to the patient's most recent episode).
//   5. Persist inbound `messages` row (encrypted body).
//   6. Run keyword router on `Body`. On `unknown` → AI fallback (mocked
//      in tests via injectAiFallbackAdapter).
//   7. Dispatch the resolved intent:
//      - confirm → placeResupplyOrderForConversation, reply "Got it…"
//      - decline → mark conversation closed, reply "Okay, we won't ship…"
//      - edit_address → mark conversation awaiting_operator, reply "An
//        agent will follow up about your address."
//      - stop → pause patient + close conversation, reply STOP boilerplate.
//      - help → reply HELP boilerplate.
//      - unknown (after AI) → mark awaiting_operator, reply "We've passed
//        this to a team member."
//   8. Audit `messaging.intent.parsed` + dispatch-specific events.
//   9. Respond 200 TwiML <Response><Message>...</Message></Response>.
//
// Why STOP/HELP are honored unconditionally:
//   US carrier rules (CTIA short-code handbook, also enforced for long
//   codes by every major US carrier) require STOP, HELP, START to work
//   regardless of conversation state. The keyword router already
//   matches them anywhere in the body; the dispatcher honors the
//   resulting intent without checking conversation status, patient
//   status, or any opt-in state. Failure to honor STOP can land us a
//   carrier suspension AND HIPAA "patient asked to stop and we kept
//   contacting them" liability.
//
// PHI in the audit row:
//   We NEVER log the inbound body or the From number to the audit
//   metadata. The body lives encrypted on `messages`; the From lives
//   only as its HMAC on `phone_lookup`. The audit row carries
//   structural fields only: conversation_id, patient_id, intent,
//   outcome, twilio_message_sid.

import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  conversations,
  decrypt,
  encrypt,
  episodes,
  getDbPool,
  hmacPhone,
  messages,
  normalizeE164,
  phoneLookup,
} from "@workspace/resupply-db";
import {
  parseInboundSmsParams,
  requireTwilioSignature,
} from "@workspace/resupply-telecom";
import {
  parseSmsIntent,
  type AiFallbackAdapter,
  type Intent,
} from "@workspace/resupply-messaging";

import { logger } from "../../lib/logger";
import { createOpenAiFallbackAdapter } from "../../lib/messaging/ai-fallback-impl";
import {
  readMessagingConfigOrNull,
  readSmsConfigOrNull,
} from "../../lib/messaging/messaging-config";
import {
  pausePatient,
  placeResupplyOrderForConversation,
} from "../../lib/messaging/order-flow";
import { safeAudit } from "../../lib/messaging/safe-audit";

const router: IRouter = Router();

// Test seam — route tests inject a deterministic adapter so they don't
// have to mock out global fetch.
let _aiAdapterOverride: AiFallbackAdapter | null = null;
export function __setAiFallbackAdapterForTests(
  adapter: AiFallbackAdapter | null,
): void {
  _aiAdapterOverride = adapter;
}

function getAiAdapter(): AiFallbackAdapter | null {
  if (_aiAdapterOverride) return _aiAdapterOverride;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    return createOpenAiFallbackAdapter({ apiKey });
  } catch {
    return null;
  }
}

const signatureMiddleware = requireTwilioSignature({
  getAuthToken: () => readSmsConfigOrNull()?.twilioAuthToken,
  buildPublicUrl: (req) => {
    const base = readSmsConfigOrNull()?.publicBaseUrl ?? "";
    const originalUrl =
      (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

router.post("/sms/inbound", signatureMiddleware, async (req, res) => {
  const cfg = readMessagingConfigOrNull();
  if (!cfg) {
    // Vendor-only path; respond 503 in TwiML so Twilio surfaces a
    // sane error in their dashboard.
    res
      .status(503)
      .type("text/xml")
      .send(
        "<Response><Message>Service temporarily unavailable. Please try again later.</Message></Response>",
      );
    return;
  }

  let parsed;
  try {
    parsed = parseInboundSmsParams(req.body);
  } catch (err) {
    logger.warn(
      { event: "sms_inbound_invalid_body", err: serializeErr(err) },
      "sms.inbound: invalid body",
    );
    // Twilio doesn't retry 200s. Don't audit malformed events.
    res.status(200).type("text/xml").send("<Response/>");
    return;
  }

  // CARRIER COMPLIANCE — STOP and HELP keywords MUST be honored
  // BEFORE any identity resolution. The CTIA short-code handbook
  // (also enforced by every major US carrier on long codes / 10DLC)
  // requires STOP, START, HELP, INFO to elicit the canonical reply
  // regardless of opt-in state, regardless of whether the sender is
  // recognized. A STOP that we silently drop because we can't map
  // the number to a patient is a carrier-suspension event AND a
  // HIPAA "patient asked to stop and we kept contacting them"
  // exposure.
  //
  // Twilio's Advanced Opt-Out feature handles the carrier-side
  // suppression for us — once a number sends STOP, Twilio refuses
  // to deliver further messages from this sender to that number,
  // EVEN IF our application enqueues them. So we don't need to
  // persist our own suppression list keyed on the unknown number;
  // Twilio is the source of truth. Our job here is to (a) emit the
  // canonical reply text so the patient gets confirmation, and (b)
  // audit so investigators can prove the keyword was honored.
  //
  // We parse the keyword router output ONCE here, and reuse the
  // result downstream when we have a patientId so we don't double-
  // route the body.
  const earlyRouted = parseSmsIntent(parsed.Body);

  // Hash From and look up patient. normalizeE164 returns null (not
  // throws) for unparseable input.
  const normalizedFrom = normalizeE164(parsed.From);
  if (!normalizedFrom) {
    logger.warn(
      { event: "sms_inbound_unnormalizable_from" },
      "sms.inbound: From not normalizable",
    );
    // Even with an unparseable From we still honor STOP/HELP — the
    // canonical reply doesn't require us to know who the sender is.
    // Twilio's Advanced Opt-Out handles per-number suppression on
    // its side regardless of our normalization.
    if (earlyRouted.intent === "stop" || earlyRouted.intent === "help") {
      await safeAudit({
        action: "messaging.inbound.received",
        operatorEmail: null,
        operatorClerkId: null,
        targetTable: null,
        targetId: null,
        metadata: {
          channel: "sms",
          outcome:
            earlyRouted.intent === "stop"
              ? "unparseable_from_stop"
              : "unparseable_from_help",
          twilio_message_sid: parsed.MessageSid,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      });
      res
        .status(200)
        .type("text/xml")
        .send(
          earlyRouted.intent === "stop"
            ? "<Response><Message>You've been unsubscribed and won't get further messages from us. Reply START to resume.</Message></Response>"
            : `<Response><Message>${escapeXml(cfg.practiceName)} — automated CPAP refill reminders. Reply YES to confirm, NO to decline, EDIT to change your address, STOP to opt out. Standard message + data rates may apply.</Message></Response>`,
        );
      return;
    }
    await safeAudit({
      action: "messaging.inbound.received",
      operatorEmail: null,
      operatorClerkId: null,
      targetTable: null,
      targetId: null,
      metadata: {
        channel: "sms",
        outcome: "unparseable_from",
        twilio_message_sid: parsed.MessageSid,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res
      .status(200)
      .type("text/xml")
      .send("<Response/>");
    return;
  }
  const fromHmac = hmacPhone(normalizedFrom);

  const pool = getDbPool();
  const db = drizzle(pool);

  const lookupRows = await db
    .select({ patientId: phoneLookup.patientId })
    .from(phoneLookup)
    .where(eq(phoneLookup.hmacPhone, fromHmac))
    .limit(1);
  const patientId = lookupRows[0]?.patientId;

  if (!patientId) {
    // Unknown phone — but if the body is STOP or HELP we still honor
    // the keyword unconditionally per CTIA carrier rules (see comment
    // above). We can't pause a patient row (we don't have one), but
    // Twilio's Advanced Opt-Out suppresses subsequent sends from this
    // sender to this number on its side, so the canonical reply is
    // sufficient.
    if (earlyRouted.intent === "stop" || earlyRouted.intent === "help") {
      await safeAudit({
        action: "messaging.inbound.received",
        operatorEmail: null,
        operatorClerkId: null,
        targetTable: null,
        targetId: null,
        metadata: {
          channel: "sms",
          outcome:
            earlyRouted.intent === "stop"
              ? "unknown_phone_stop"
              : "unknown_phone_help",
          twilio_message_sid: parsed.MessageSid,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      });
      res
        .status(200)
        .type("text/xml")
        .send(
          earlyRouted.intent === "stop"
            ? "<Response><Message>You've been unsubscribed and won't get further messages from us. Reply START to resume.</Message></Response>"
            : `<Response><Message>${escapeXml(cfg.practiceName)} — automated CPAP refill reminders. Reply YES to confirm, NO to decline, EDIT to change your address, STOP to opt out. Standard message + data rates may apply.</Message></Response>`,
        );
      return;
    }
    await safeAudit({
      action: "messaging.inbound.received",
      operatorEmail: null,
      operatorClerkId: null,
      targetTable: null,
      targetId: null,
      metadata: {
        channel: "sms",
        outcome: "unknown_phone",
        twilio_message_sid: parsed.MessageSid,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res
      .status(200)
      .type("text/xml")
      .send(
        '<Response><Message>This number isn\'t set up to receive replies. ' +
          "If you meant to contact your CPAP supplier, please call your provider directly. " +
          "Reply STOP to opt out.</Message></Response>",
      );
    return;
  }

  // Find or create the conversation. We prefer the most recent OPEN
  // sms conversation for this patient — same thread, same context.
  // If none is open, we open a new one bound to the most recent
  // episode. (Inbound SMS without an episode is rare but possible —
  // a patient texts back days after the operator already closed the
  // conversation.)
  // `conversationId` is assigned in EVERY branch below before the
  // first read at line ~273 (the if-then sets it from openConv, the
  // else-then sets it from the new `conversations` insert). Declared
  // without an initial value so eslint's `no-useless-assignment` does
  // not flag a dead `= null`; TS narrowing keeps the read-time check
  // honest because the type still includes `string | null`.
  let conversationId: string | null;
  const openConv = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.patientId, patientId),
        eq(conversations.channel, "sms"),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  if (openConv[0] && openConv[0].id) {
    conversationId = openConv[0].id;
  } else {
    const recentEp = await db
      .select({ id: episodes.id })
      .from(episodes)
      .where(eq(episodes.patientId, patientId))
      .orderBy(desc(episodes.dueAt))
      .limit(1);
    const episodeId = recentEp[0]?.id;
    if (!episodeId) {
      // No episode at all — patient is in our system but has nothing
      // to confirm. Audit + reply with help boilerplate.
      await safeAudit({
        action: "messaging.inbound.received",
        operatorEmail: null,
        operatorClerkId: null,
        targetTable: null,
        targetId: null,
        metadata: {
          channel: "sms",
          patient_id: patientId,
          outcome: "no_episode_for_patient",
          twilio_message_sid: parsed.MessageSid,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      });
      res
        .status(200)
        .type("text/xml")
        .send(
          "<Response><Message>Thanks — there's nothing scheduled for you right now. " +
            "A team member will follow up if needed. Reply STOP to opt out.</Message></Response>",
        );
      return;
    }
    const inserted = await db
      .insert(conversations)
      .values({
        patientId,
        episodeId,
        channel: "sms",
        status: "open",
        lastMessageAt: new Date(),
      })
      .returning({ id: conversations.id });
    conversationId = inserted[0]?.id ?? null;
  }
  if (!conversationId) {
    res.status(200).type("text/xml").send("<Response/>");
    return;
  }

  // Persist inbound message row before any decision logic — we want
  // the transcript even if dispatch crashes.
  await db.insert(messages).values({
    conversationId,
    direction: "inbound",
    senderRole: "patient",
    body: sql`${encrypt(parsed.Body)}`,
    deliveryStatus: "received",
    vendorMetadata: { twilio_message_sid: parsed.MessageSid },
    sentAt: new Date(),
  });
  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  await safeAudit({
    action: "messaging.inbound.received",
    operatorEmail: null,
    operatorClerkId: null,
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      channel: "sms",
      patient_id: patientId,
      conversation_id: conversationId,
      outcome: "matched_patient",
      twilio_message_sid: parsed.MessageSid,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });

  // Run keyword router. We already evaluated this once at the top
  // of the request to honor STOP/HELP unconditionally before patient
  // lookup; reuse that result so we don't double-parse the body.
  // AI fallback only fires on `unknown` — and only when an adapter
  // is configured.
  let intent: Intent = earlyRouted.intent;
  let agentReply: string | null = null;
  let resolvedBy: "keyword" | "ai" | "none" = "keyword";
  if (intent === "unknown") {
    const adapter = getAiAdapter();
    if (adapter) {
      // Pull the last 6 messages as context. Bodies are decrypted at
      // the SQL site; we never write decrypted text back to disk.
      const recent = await db
        .select({
          direction: messages.direction,
          senderRole: messages.senderRole,
          body: decrypt(messages.body),
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(6);
      const thread = recent
        .reverse()
        .filter((m) => m.body !== null)
        .map((m) => ({
          role:
            m.direction === "inbound"
              ? ("patient" as const)
              : ("agent" as const),
          body: m.body ?? "",
        }));
      const result = await adapter.classify({ body: parsed.Body, thread });
      intent = result.intent;
      agentReply = result.reply ?? null;
      resolvedBy = "ai";
    } else {
      resolvedBy = "none";
    }
  }

  await safeAudit({
    action: "messaging.intent.parsed",
    operatorEmail: null,
    operatorClerkId: null,
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      channel: "sms",
      conversation_id: conversationId,
      patient_id: patientId,
      intent,
      resolved_by: resolvedBy,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });

  // Dispatch.
  let twimlBody: string;
  try {
    twimlBody = await dispatchIntent({
      intent,
      conversationId,
      patientId,
      practiceName: cfg.practiceName,
      aiReply: agentReply,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
  } catch (err) {
    logger.error(
      {
        event: "sms_dispatch_crashed",
        err: serializeErr(err),
        conversation_id: conversationId,
        intent,
      },
      "sms.inbound: dispatch crashed",
    );
    twimlBody =
      "Thanks — we've passed your message to a team member who will follow up.";
  }

  // Persist the outbound reply we're about to send.
  await db.insert(messages).values({
    conversationId,
    direction: "outbound",
    senderRole: "agent",
    body: sql`${encrypt(twimlBody)}`,
    deliveryStatus: "queued",
    vendorMetadata: { twiml_inline: true },
    sentAt: new Date(),
  });

  res
    .status(200)
    .type("text/xml")
    .send(`<Response><Message>${escapeXml(twimlBody)}</Message></Response>`);
});

interface DispatchInput {
  intent: Intent;
  conversationId: string;
  patientId: string;
  practiceName: string;
  aiReply: string | null;
  ip: string | null;
  userAgent: string | null;
}

async function dispatchIntent(input: DispatchInput): Promise<string> {
  const pool = getDbPool();
  const db = drizzle(pool);
  switch (input.intent) {
    case "confirm": {
      const result = await placeResupplyOrderForConversation({
        conversationId: input.conversationId,
      });
      if (result.status === "ok") {
        await db
          .update(conversations)
          .set({ status: "closed", updatedAt: new Date() })
          .where(eq(conversations.id, input.conversationId));
        await safeAudit({
          action: "messaging.order.confirmed",
          operatorEmail: null,
          operatorClerkId: null,
          targetTable: "episodes",
          targetId: result.episodeId,
          metadata: {
            channel: "sms",
            conversation_id: input.conversationId,
            patient_id: input.patientId,
            episode_id: result.episodeId,
            fulfillment_count: result.fulfillmentIds.length,
            via: "keyword_or_ai",
          },
          ip: input.ip,
          userAgent: input.userAgent,
        });
        return (
          input.aiReply ??
          `Got it — your refill is on its way. Thanks from ${input.practiceName}.`
        );
      }
      if (result.status === "already_confirmed") {
        return "Got it — that order is already confirmed and on its way.";
      }
      return "Thanks — we'll review and follow up shortly.";
    }
    case "decline": {
      await db
        .update(conversations)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(conversations.id, input.conversationId));
      return (
        input.aiReply ??
        "No problem — we won't ship anything right now. Reply HELP if you need us."
      );
    }
    case "edit_address": {
      await db
        .update(conversations)
        .set({ status: "awaiting_operator", updatedAt: new Date() })
        .where(eq(conversations.id, input.conversationId));
      await safeAudit({
        action: "messaging.handoff.escalated",
        operatorEmail: null,
        operatorClerkId: null,
        targetTable: "conversations",
        targetId: input.conversationId,
        metadata: {
          channel: "sms",
          conversation_id: input.conversationId,
          patient_id: input.patientId,
          reason: "edit_address",
        },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return (
        input.aiReply ??
        "Thanks — a team member will follow up about your address change."
      );
    }
    case "stop": {
      // Carrier-mandated. No conditions, no exceptions.
      await pausePatient(input.patientId);
      await db
        .update(conversations)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(conversations.id, input.conversationId));
      await safeAudit({
        action: "messaging.handoff.escalated",
        operatorEmail: null,
        operatorClerkId: null,
        targetTable: "patients",
        targetId: input.patientId,
        metadata: {
          channel: "sms",
          conversation_id: input.conversationId,
          patient_id: input.patientId,
          reason: "stop_keyword",
          patient_status: "paused",
        },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return "You've been unsubscribed and won't get further messages from us. Reply START to resume.";
    }
    case "help": {
      return (
        `${input.practiceName} — automated CPAP refill reminders. ` +
        "Reply YES to confirm, NO to decline, EDIT to change your address, " +
        "STOP to opt out. Standard message + data rates may apply."
      );
    }
    case "unknown": {
      await db
        .update(conversations)
        .set({ status: "awaiting_operator", updatedAt: new Date() })
        .where(eq(conversations.id, input.conversationId));
      await safeAudit({
        action: "messaging.handoff.escalated",
        operatorEmail: null,
        operatorClerkId: null,
        targetTable: "conversations",
        targetId: input.conversationId,
        metadata: {
          channel: "sms",
          conversation_id: input.conversationId,
          patient_id: input.patientId,
          reason: "unknown_intent",
        },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return (
        input.aiReply ??
        "Thanks — we've passed your message to a team member who will follow up."
      );
    }
    default: {
      const _exhaustive: never = input.intent;
      void _exhaustive;
      return "Thanks — we've passed your message to a team member.";
    }
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

export default router;
