// POST /sms/inbound — Twilio inbound SMS webhook.
//
// Flow:
//   1. requireTwilioSignature middleware — reject unsigned/forged requests.
//   2. Parse body (form-urlencoded → zod) into InboundSmsParams.
//   3. Look up patient by direct phone_e164 equality.
//      - Unknown number → audit `messaging.inbound.received{outcome:'unknown_phone'}`,
//        respond with TwiML <Message> opt-out boilerplate.
//      - Multiple matches → audit `outcome:'ambiguous_phone'` and bail; we can't
//        safely route an inbound to one of N patients sharing the same number.
//   4. Find latest open SMS conversation for this patient (or create one
//      bound to the patient's most recent episode).
//   5. Persist inbound `messages` row.
//   6. Run keyword router on `Body`. On `unknown` → AI fallback (mocked
//      in tests via injectAiFallbackAdapter).
//   7. Dispatch the resolved intent:
//      - confirm → placeResupplyOrderForConversation, reply "Got it…"
//      - decline → mark conversation closed, reply "Okay, we won't ship…"
//      - edit_address → mark conversation awaiting_admin, reply "An
//        agent will follow up about your address."
//      - stop → pause patient + close conversation, reply STOP boilerplate.
//      - help → reply HELP boilerplate.
//      - unknown (after AI) → mark awaiting_admin, reply "We've passed
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
//   metadata. The body lives on `messages`; the From lives on
//   `patients.phone_e164`. The audit row carries structural fields
//   only: conversation_id, patient_id, intent, outcome,
//   twilio_message_sid.

import { Router, type IRouter } from "express";

import { normalizeE164 } from "@workspace/resupply-domain";
import {
  getSupabaseServiceRoleClient,
  tryUpsertPatientLatestMessageSb,
  type Json,
  type ResupplySupabaseClient,
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
import { createAiFallbackAdapter } from "../../lib/messaging/ai-fallback-impl";
import { ingestInboundMmsMedia } from "../../lib/messaging/ingest-mms";
import { rateLimit } from "../../middlewares/rate-limit";
import {
  readMessagingConfigOrNull,
  readSmsConfigOrNull,
} from "../../lib/messaging/messaging-config";
import {
  pausePatient,
  reactivatePatient,
  placeResupplyOrderForConversation,
} from "../../lib/messaging/order-flow";
import { findActiveClosure } from "../../lib/office-closure/active";
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
  // Prefers Claude Haiku when ANTHROPIC_API_KEY is set, otherwise
  // falls back to OpenAI's gpt-4o-mini, otherwise returns null and
  // the route routes to the human-handoff queue.
  try {
    return createAiFallbackAdapter();
  } catch {
    return null;
  }
}

// Per-phone rate limit: 20 inbound keyword messages per hour per sender.
// Prevents a single patient (or a spoofed number) from flooding the
// keyword router and triggering many resupply orders in a short window.
// The signature middleware runs first (guaranteeing the From number is
// authentic) so this key can't be forged by an outside caller.
//
// Key normalization: Twilio occasionally delivers the same logical
// number in different shapes (`+12155551212` vs `2155551212` vs
// `(215) 555-1212`). Without normalization, the same patient gets
// two separate buckets and the limit effectively doubles for them.
// We run the same E.164 normalizer the rest of the route uses so a
// single sender always hits the same bucket.
const smsPhoneLimiterRaw = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: "sms_inbound_per_phone",
  keyFn: (req) => {
    const from = req.body?.From;
    if (typeof from !== "string" || from.length === 0) return "unknown";
    return normalizeE164(from) ?? from;
  },
});

// Wrapping middleware that SKIPS the per-phone limit for carrier-
// compliance keywords (STOP, HELP, START, INFO, etc.). The CTIA
// short-code handbook and every major US carrier on 10DLC require
// these to be honored unconditionally — a STOP that's silently 429ed
// by our own limiter is both a carrier-suspension event and a HIPAA
// "patient asked us to stop and we kept contacting them" exposure.
// Twilio does not retry 429s, so once the bucket is full the STOP
// is permanently dropped. We MUST let the route handler run for
// compliance keywords regardless of bucket state.
const smsPhoneLimiter: import("express").RequestHandler = (req, res, next) => {
  const body = req.body?.Body;
  if (typeof body === "string") {
    const intent = parseSmsIntent(body).intent;
    if (intent === "stop" || intent === "help" || intent === "start") {
      next();
      return;
    }
  }
  smsPhoneLimiterRaw(req, res, next);
};

const signatureMiddleware = requireTwilioSignature({
  getAuthToken: () => readSmsConfigOrNull()?.twilioAuthToken,
  buildPublicUrl: (req) => {
    const base = readSmsConfigOrNull()?.publicBaseUrl ?? "";
    const originalUrl =
      (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

router.post(
  "/sms/inbound",
  signatureMiddleware,
  smsPhoneLimiter,
  async (req, res) => {
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
          adminEmail: null,
          adminUserId: null,
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
              ? "<Response><Message>You've been unsubscribed and won't get further texts from us. Reply START to resume.</Message></Response>"
              : `<Response><Message>${escapeXml(cfg.practiceName)} — automated CPAP refill reminders. Reply YES to confirm, NO to decline, EDIT to change your address, STOP to opt out. Standard message + data rates may apply.</Message></Response>`,
          );
        return;
      }
      await safeAudit({
        action: "messaging.inbound.received",
        adminEmail: null,
        adminUserId: null,
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
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    // Direct phone lookup. We pull up to 2 rows so we can detect
    // ambiguous matches — multiple patients sharing one phone (a
    // family plan) can't be safely auto-routed; we audit and bail.
    const { data: lookupRows, error: lookupErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("phone_e164", normalizedFrom)
      .limit(2);
    if (lookupErr) throw lookupErr;
    const lookupMatches = lookupRows ?? [];
    if (lookupMatches.length > 1) {
      await safeAudit({
        action: "messaging.inbound.received",
        adminEmail: null,
        adminUserId: null,
        targetTable: null,
        targetId: null,
        metadata: {
          channel: "sms",
          outcome: "ambiguous_phone",
          twilio_message_sid: parsed.MessageSid,
          match_count: lookupMatches.length,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      });
      res
        .status(200)
        .type("text/xml")
        .send(
          "<Response><Message>This number is on multiple accounts. " +
            "Please contact your provider directly so we can route your message correctly. " +
            "Reply STOP to opt out.</Message></Response>",
        );
      return;
    }
    const patientId = lookupMatches[0]?.id;

    // Office closure auto-reply — STOP/HELP are already handled above
    // and never reach here. START (carrier opt-in) also bypasses the
    // closure so a re-subscribe is honored immediately. Any other inbound
    // during an active closure gets the configured auto-reply and
    // short-circuits the normal dispatch (no conversation row created, no
    // patient-side reply beyond the closure message). Surveyors and
    // operations folks both expect a "we're closed today" voice on
    // inbound messages.
    if (
      earlyRouted.intent !== "stop" &&
      earlyRouted.intent !== "help" &&
      earlyRouted.intent !== "start"
    ) {
      try {
        const activeClosure = await findActiveClosure(supabase);
        if (activeClosure) {
          await safeAudit({
            action: "messaging.inbound.received",
            adminEmail: null,
            adminUserId: null,
            targetTable: "office_closures",
            targetId: activeClosure.id,
            metadata: {
              channel: "sms",
              outcome: "closure_auto_reply",
              twilio_message_sid: parsed.MessageSid,
            },
            ip: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
          });
          res
            .status(200)
            .type("text/xml")
            .send(
              `<Response><Message>${escapeXml(activeClosure.autoReplyMessage)}</Message></Response>`,
            );
          return;
        }
      } catch (err) {
        // Closure lookup failed — log and continue with normal
        // dispatch. We'd rather drop the auto-reply than block the
        // patient's message.
        logger.warn(
          {
            event: "sms_inbound_closure_lookup_failed",
            err: serializeErr(err),
          },
          "sms.inbound: closure lookup failed; continuing with normal dispatch",
        );
      }
    }

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
          adminEmail: null,
          adminUserId: null,
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
              ? "<Response><Message>You've been unsubscribed and won't get further texts from us. Reply START to resume.</Message></Response>"
              : `<Response><Message>${escapeXml(cfg.practiceName)} — automated CPAP refill reminders. Reply YES to confirm, NO to decline, EDIT to change your address, STOP to opt out. Standard message + data rates may apply.</Message></Response>`,
          );
        return;
      }
      await safeAudit({
        action: "messaging.inbound.received",
        adminEmail: null,
        adminUserId: null,
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
          "<Response><Message>This number isn't set up to receive replies. " +
            "If you meant to contact your CPAP supplier, please call your provider directly. " +
            "Reply STOP to opt out.</Message></Response>",
        );
      return;
    }

    // Replay protection: reject any webhook whose MessageSid has already
    // been stored. A Twilio signature is a static HMAC over the request
    // body — a captured (payload + header) pair can be replayed verbatim
    // and will pass signature validation. Checking the MessageSid (a
    // globally unique Twilio identifier) before processing prevents a
    // replayed request from inserting a second inbound message row and
    // triggering a second dispatch (which could confirm a newer order
    // the patient never approved).
    //
    // The companion DB migration (0018_messages_twilio_sid_unique.sql)
    // adds a unique partial index on
    //   (vendor_metadata->>'twilio_message_sid') WHERE direction = 'inbound'
    // so the uniqueness is enforced at the storage layer too, but this
    // pre-check lets us return a clean 200 (no error) to Twilio rather
    // than a 500 on a duplicate-key violation.
    const { data: existingSid, error: sidErr } = await supabase
      .schema("resupply")
      .from("messages")
      .select("id")
      .eq("direction", "inbound")
      .filter("vendor_metadata->>twilio_message_sid", "eq", parsed.MessageSid)
      .limit(1)
      .maybeSingle();
    if (sidErr) throw sidErr;
    if (existingSid) {
      logger.info(
        {
          event: "sms_inbound_duplicate_sid",
          twilio_message_sid: parsed.MessageSid,
        },
        "sms.inbound: duplicate MessageSid — replayed webhook discarded",
      );
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }

    // Find or create the conversation. Reuse any LIVE conversation
    // ('open', 'awaiting_admin', or 'awaiting_patient') for this
    // patient so a multi-turn exchange stays one thread. Previously
    // we only matched status='open', so after `dispatchIntent` flipped
    // to 'awaiting_admin' (EDIT/unknown intent) or an admin reply
    // flipped to 'awaiting_patient', every subsequent patient SMS
    // spawned a brand-new conversation row — shattering the dashboard
    // queue, breaking SLA tracking, and stranding admin context.
    // Replay protection is owned by the MessageSid idempotency check
    // upstream of this block, so widening the status filter here is
    // safe.
    let conversationId: string | null;
    const { data: openConv, error: openConvErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .select("id")
      .eq("patient_id", patientId)
      .eq("channel", "sms")
      .in("status", ["open", "awaiting_admin", "awaiting_patient"])
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (openConvErr) throw openConvErr;
    if (openConv?.id) {
      conversationId = openConv.id;
    } else {
      const { data: recentEp, error: epErr } = await supabase
        .schema("resupply")
        .from("episodes")
        .select("id")
        .eq("patient_id", patientId)
        .order("due_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (epErr) throw epErr;
      const episodeId = recentEp?.id;
      if (!episodeId) {
        // No episode at all — patient is in our system but has nothing
        // to confirm. Audit + reply with help boilerplate.
        await safeAudit({
          action: "messaging.inbound.received",
          adminEmail: null,
          adminUserId: null,
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
      const inboundIso = new Date().toISOString();
      const { data: insertedConv, error: insertConvErr } = await supabase
        .schema("resupply")
        .from("conversations")
        .insert({
          patient_id: patientId,
          episode_id: episodeId,
          channel: "sms",
          status: "open",
          last_message_at: inboundIso,
        })
        .select("id")
        .limit(1)
        .maybeSingle();
      if (insertConvErr) throw insertConvErr;
      conversationId = insertedConv?.id ?? null;
    }
    if (!conversationId) {
      res.status(200).type("text/xml").send("<Response/>");
      return;
    }

    // Persist inbound message row before any decision logic — we want
    // the transcript even if dispatch crashes.
    const inboundAt = new Date();
    const inboundIso = inboundAt.toISOString();
    const { data: insertedMsg, error: insertMsgErr } = await supabase
      .schema("resupply")
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "inbound",
        sender_role: "patient",
        body: parsed.Body,
        delivery_status: "received",
        vendor_metadata: {
          twilio_message_sid: parsed.MessageSid,
        } as unknown as Json,
        sent_at: inboundIso,
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertMsgErr) throw insertMsgErr;
    const inboundMessageId = insertedMsg?.id ?? null;
    const { error: stampConvErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({ last_message_at: inboundIso, updated_at: inboundIso })
      .eq("id", conversationId);
    if (stampConvErr) throw stampConvErr;

    // MMS media ingestion — Twilio sets NumMedia to a string ("0".."10").
    // We fan out to our private GCS so the dashboard can render
    // attachments without exposing Twilio creds and so PHI bytes don't
    // vanish when Twilio's 365-day retention expires. Best-effort: any
    // partial failure is logged and audited but does not 5xx the
    // webhook (Twilio would retry, creating duplicate inbound rows
    // shielded only by the partial unique index). The whole call is
    // wrapped in catch so even an unexpected throw can't bring the
    // webhook down.
    const numMedia = Number.parseInt(parsed.NumMedia ?? "0", 10);
    if (
      inboundMessageId &&
      Number.isFinite(numMedia) &&
      numMedia > 0 &&
      cfg.sms.twilioAccountSid &&
      cfg.sms.twilioAuthToken
    ) {
      try {
        const ingestResult = await ingestInboundMmsMedia(
          {
            messageId: inboundMessageId,
            rawWebhookBody: req.body as Record<string, unknown>,
            numMedia,
            twilioAccountSid: cfg.sms.twilioAccountSid,
            twilioAuthToken: cfg.sms.twilioAuthToken,
          },
          req.log,
        );
        // Counts-only audit — no PHI, no Twilio identifiers, no
        // conversation/patient ids in the metadata payload. The
        // (targetTable, targetId) tuple already pins the audit row
        // to the message; investigators can join through `messages`
        // to recover conversation_id / patient_id when needed,
        // without us mirroring the linkage into every audit row.
        await safeAudit({
          action: "messaging.inbound.media_ingested",
          adminEmail: null,
          adminUserId: null,
          targetTable: "messages",
          targetId: inboundMessageId,
          metadata: {
            channel: "sms",
            attempted: ingestResult.attempted,
            succeeded: ingestResult.succeeded,
            rejected: ingestResult.rejected,
            errored: ingestResult.errored,
          },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        });
      } catch (err) {
        // The ingest module already swallows individual failures; an
        // exception here would mean a programming error (bad import,
        // missing env, etc). Log and continue so the webhook still
        // returns 200 to Twilio.
        logger.error(
          { err: serializeErr(err), conversation_id: conversationId },
          "sms.inbound: mms ingestion crashed",
        );
      }
    }

    // Refresh latest-message projection (best-effort).
    await tryUpsertPatientLatestMessageSb(
      supabase,
      {
        conversationId,
        body: parsed.Body,
        direction: "inbound",
        messageAt: inboundAt,
      },
      req.log,
    );

    await safeAudit({
      action: "messaging.inbound.received",
      adminEmail: null,
      adminUserId: null,
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
    let lowConfidenceOverride = false;
    if (intent === "unknown") {
      const adapter = getAiAdapter();
      if (adapter) {
        // Pull the last 6 messages as context.
        const { data: recent, error: recentErr } = await supabase
          .schema("resupply")
          .from("messages")
          .select("direction, sender_role, body, created_at")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: false })
          .limit(6);
        if (recentErr) throw recentErr;
        const thread = (recent ?? [])
          .slice()
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

        // Confidence gate. The action-taking intents (confirm, decline,
        // edit_address) trigger irreversible real-world side effects:
        // confirm ships a CPAP order, decline closes the episode for the
        // cycle, edit_address takes the patient out of auto-fulfillment.
        // A low-confidence classification ("sure I guess", a one-word
        // reply that could mean two things) must never auto-dispatch
        // those — route to a human instead. The reporting / pass-through
        // intents (stop, help, unknown) are safe at any confidence.
        // Threshold is intentionally conservative: a precision drop here
        // is invisible (patient gets a polite "we'll follow up" instead
        // of the action), but a precision miss on `confirm` ships an
        // unwanted order. Adapters that don't report a confidence at all
        // (older fine-tunes, malformed output) are treated as "no signal"
        // and also gated.
        const MIN_AI_DISPATCH_CONFIDENCE = 0.7;
        const confidence =
          typeof result.confidence === "number" &&
          Number.isFinite(result.confidence)
            ? result.confidence
            : undefined;
        const isActionIntent =
          intent === "confirm" ||
          intent === "decline" ||
          intent === "edit_address";
        if (
          isActionIntent &&
          (confidence === undefined || confidence < MIN_AI_DISPATCH_CONFIDENCE)
        ) {
          logger.info(
            {
              event: "ai_fallback_dispatch_gated_low_confidence",
              conversation_id: conversationId,
              patient_id: patientId,
              proposed_intent: intent,
              confidence: confidence ?? null,
              threshold: MIN_AI_DISPATCH_CONFIDENCE,
            },
            "sms.inbound: gating low-confidence AI classification — routing to human",
          );
          intent = "unknown";
          // Drop the AI's reply too — its text was crafted for the
          // confident action; the route's `unknown` handler will render
          // a neutral "passing to a teammate" line.
          agentReply = null;
          lowConfidenceOverride = true;
        }
      } else {
        resolvedBy = "none";
      }
    }

    await safeAudit({
      action: "messaging.intent.parsed",
      adminEmail: null,
      adminUserId: null,
      targetTable: "conversations",
      targetId: conversationId,
      metadata: {
        channel: "sms",
        conversation_id: conversationId,
        patient_id: patientId,
        intent,
        resolved_by: resolvedBy,
        low_confidence_override: lowConfidenceOverride || undefined,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    // Dispatch.
    let twimlBody: string;
    try {
      twimlBody = await dispatchIntent({
        supabase,
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

    // Persist the outbound reply we're about to send. The persist
    // itself is best-effort: if the insert errors, we MUST still send
    // the TwiML — otherwise Twilio retries the webhook, our MessageSid
    // idempotency check upstream short-circuits to an empty response,
    // and the patient never sees the CONFIRM/STOP/HELP reply even
    // though the side effect (placing the order, marking the opt-out)
    // already ran. Log loud so ops can reconcile the missing audit
    // row by hand.
    const replyAt = new Date();
    const replyIso = replyAt.toISOString();
    const { error: replyInsertErr } = await supabase
      .schema("resupply")
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_role: "agent",
        body: twimlBody,
        delivery_status: "queued",
        vendor_metadata: { twiml_inline: true } as unknown as Json,
        sent_at: replyIso,
      });
    if (replyInsertErr) {
      // Capture PostgREST `code` so ops can discriminate the failure
      // mode without re-running the request. serializeErr alone returns
      // `{ name: "unknown" }` for non-Error supabase-js error shapes.
      // Deliberately NOT logging `details`/`hint` — those echo row
      // values and risk PHI.
      logger.error(
        {
          event: "sms_outbound_reply_persist_failed",
          err: serializeErr(replyInsertErr),
          errCode:
            typeof (replyInsertErr as { code?: unknown }).code === "string"
              ? (replyInsertErr as { code: string }).code
              : null,
          errMessage:
            typeof (replyInsertErr as { message?: unknown }).message ===
            "string"
              ? (replyInsertErr as { message: string }).message
              : null,
          conversation_id: conversationId,
          intent,
        },
        "sms.inbound: outbound reply insert failed — sending TwiML anyway to avoid Twilio retry storm",
      );
    }

    // Refresh latest-message projection (best-effort).
    await tryUpsertPatientLatestMessageSb(
      supabase,
      {
        conversationId,
        body: twimlBody,
        direction: "outbound",
        messageAt: replyAt,
      },
      req.log,
    );

    res
      .status(200)
      .type("text/xml")
      .send(`<Response><Message>${escapeXml(twimlBody)}</Message></Response>`);
  },
);

interface DispatchInput {
  supabase: ResupplySupabaseClient;
  intent: Intent;
  conversationId: string;
  patientId: string;
  practiceName: string;
  aiReply: string | null;
  ip: string | null;
  userAgent: string | null;
}

async function dispatchIntent(input: DispatchInput): Promise<string> {
  const { supabase } = input;
  const nowIso = new Date().toISOString();
  switch (input.intent) {
    case "confirm": {
      const result = await placeResupplyOrderForConversation({
        conversationId: input.conversationId,
      });
      if (result.status === "ok") {
        const { error: closeErr } = await supabase
          .schema("resupply")
          .from("conversations")
          .update({ status: "closed", updated_at: nowIso })
          .eq("id", input.conversationId);
        if (closeErr) throw closeErr;
        await safeAudit({
          action: "messaging.order.confirmed",
          adminEmail: null,
          adminUserId: null,
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
      if (result.status === "not_eligible") {
        // Entitlement guard blocked the reship (too soon / over the
        // per-period cap). Do NOT reuse input.aiReply here — for a
        // confirm intent it says "on its way", which would be wrong.
        // The block already raised a CSR alert in order-flow.
        await safeAudit({
          action: "messaging.order.blocked_not_eligible",
          adminEmail: null,
          adminUserId: null,
          targetTable: "episodes",
          targetId: result.episodeId,
          metadata: {
            channel: "sms",
            conversation_id: input.conversationId,
            patient_id: input.patientId,
            episode_id: result.episodeId,
            entitlement_status: result.entitlement.status,
            hcpcs_code: result.entitlement.hcpcsCode,
            days_until_eligible: result.entitlement.daysUntilEligible,
          },
          ip: input.ip,
          userAgent: input.userAgent,
        });
        return "Thanks! It looks like it's a little early to reship this one under your plan, so a team member will review and follow up before anything ships.";
      }
      return "Thanks — we'll review and follow up shortly.";
    }
    case "decline": {
      const { error: declineErr } = await supabase
        .schema("resupply")
        .from("conversations")
        .update({ status: "closed", updated_at: nowIso })
        .eq("id", input.conversationId);
      if (declineErr) throw declineErr;
      return (
        input.aiReply ??
        "No problem — we won't ship anything right now. Reply HELP if you need us."
      );
    }
    case "edit_address": {
      const { error: editErr } = await supabase
        .schema("resupply")
        .from("conversations")
        .update({ status: "awaiting_admin", updated_at: nowIso })
        .eq("id", input.conversationId);
      if (editErr) throw editErr;
      await safeAudit({
        action: "messaging.handoff.escalated",
        adminEmail: null,
        adminUserId: null,
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
      const { error: stopErr } = await supabase
        .schema("resupply")
        .from("conversations")
        .update({ status: "closed", updated_at: nowIso })
        .eq("id", input.conversationId);
      if (stopErr) throw stopErr;
      await safeAudit({
        action: "messaging.handoff.escalated",
        adminEmail: null,
        adminUserId: null,
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
      return "You've been unsubscribed and won't get further texts from us. Reply START to resume.";
    }
    case "start": {
      // Carrier-mandated opt-in. Reverse a STOP-induced pause so the
      // patient resumes receiving reminders, then close the
      // conversation (a keyword reply, not a dialog turn).
      await reactivatePatient(input.patientId);
      const { error: startErr } = await supabase
        .schema("resupply")
        .from("conversations")
        .update({ status: "closed", updated_at: nowIso })
        .eq("id", input.conversationId);
      if (startErr) throw startErr;
      await safeAudit({
        action: "messaging.handoff.escalated",
        adminEmail: null,
        adminUserId: null,
        targetTable: "patients",
        targetId: input.patientId,
        metadata: {
          channel: "sms",
          conversation_id: input.conversationId,
          patient_id: input.patientId,
          reason: "start_keyword",
          patient_status: "active",
        },
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return `You're resubscribed and will start receiving messages from ${input.practiceName} again. Reply STOP to opt out at any time.`;
    }
    case "help": {
      return (
        `${input.practiceName} — automated CPAP refill reminders. ` +
        "Reply YES to confirm, NO to decline, EDIT to change your address, " +
        "STOP to opt out. Standard message + data rates may apply."
      );
    }
    case "unknown": {
      const { error: unkErr } = await supabase
        .schema("resupply")
        .from("conversations")
        .update({ status: "awaiting_admin", updated_at: nowIso })
        .eq("id", input.conversationId);
      if (unkErr) throw unkErr;
      await safeAudit({
        action: "messaging.handoff.escalated",
        adminEmail: null,
        adminUserId: null,
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
