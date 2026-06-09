// POST /email/inbound-parse — SendGrid Inbound Parse webhook receiver.
//
// Patients reply to clinical reminder emails. SendGrid's Inbound Parse
// service catches replies sent to a configured MX domain (e.g.
// `replies.penn.example`) and POSTs them to this endpoint as
// multipart/form-data with the parsed message body, headers, and any
// attachments the patient included (insurance cards, prescription
// scans, equipment photos).
//
// What this handler does:
//   1. Authenticates the request via Basic Auth against
//      SENDGRID_INBOUND_PARSE_BASIC_AUTH (format "user:pass"). SendGrid
//      Inbound Parse does NOT sign payloads (unlike the Event Webhook),
//      so URL-embedded basic auth is the documented way to gate the
//      endpoint. Missing/wrong credentials → 401.
//   2. Parses the multipart form with busboy. Field values are buffered
//      in memory; attachment bodies are buffered up to MAX_BYTES then
//      cut off (so a malicious 1GB file can't OOM us).
//   3. Resolves the patient by lower-cased email match against the
//      `from` address. Unknown email → audit + 200 (SendGrid retries
//      5xx; we want exactly-once at-least delivery).
//   4. Finds (or opens) an email conversation bound to the patient's
//      most recent episode, persists the inbound message row, and runs
//      every parsed attachment through the shared
//      `persistInboundAttachment` helper — same allowlist + 5MB cap
//      + private-GCS ACL the MMS path uses.
//   5. Optionally lets the storefront chatbot draft and send a reply
//      (opt-in via the `email.auto_reply` feature flag — OFF by
//      default). When the flag is on AND an LLM provider is configured,
//      the same knowledge base that powers the `/api/chat` widget reads
//      the patient's message and either answers it by email
//      (conversation → `awaiting_patient`) or HANDS OFF anything
//      order/account/clinical-specific or low-confidence. When the flag
//      is off, or the bot hands off, the conversation is marked
//      `awaiting_admin` so a teammate sees it in the inbox — the
//      historical default. We still do NOT run the keyword router on
//      email: confirmation/decline decisions come from the
//      click-through link (ADR 013-messaging-sms-email-architecture.md
//      §"Why no inbound email parser"), not free-text parsing; the
//      chatbot reply is informational support, not an action dispatcher.
//
// Why we always return 200 on application errors:
//   SendGrid retries 5xx aggressively (up to 72h). A duplicated
//   webhook would create duplicate inbound message rows + double-
//   ingest the same attachments (they'd land twice — there is no
//   replay-protection SID on email media the way there is on MMS).
//   So we audit and 200 even on parse failures.

import { Router, type IRouter, type Request, type Response } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import busboy from "busboy";

import {
  getSupabaseServiceRoleClient,
  tryUpsertPatientLatestMessageSb,
  type Json,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { selectLlmProvider } from "../../lib/llm-provider";
import { generateEmailReply } from "../../lib/messaging/email-auto-reply";
import {
  MAX_BYTES,
  persistInboundAttachment,
} from "../../lib/messaging/ingest-mms";
import { readEmailConfigOrNull } from "../../lib/messaging/messaging-config";
import { safeAudit } from "../../lib/messaging/safe-audit";

const router: IRouter = Router();

// Although the route is gated by basic auth, an attacker who knows
// the shared secret (or anyone hitting it before the auth check)
// could still pile multipart parses against the process. Cap the
// volume per IP so the upstream busboy parse cannot be used to burn
// CPU. SendGrid's webhook source IPs are stable, so a generous limit
// won't impede legitimate delivery.
const inboundParseLimiter = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

// SendGrid documents 30MB as the per-payload cap on Inbound Parse —
// total of headers+body+all attachments. 35MB gives us headroom; we
// also enforce per-attachment MAX_BYTES inside the parser.
const TOTAL_PAYLOAD_BYTES = 35 * 1024 * 1024;
// Cap distinct attachments per email; SendGrid would have already
// rejected anything over its own per-payload limit but we mirror the
// MMS path's defense-in-depth.
const MAX_ATTACHMENTS_PER_EMAIL = 10;

// Header used for the basic-auth shared secret. SendGrid's webhook
// configuration accepts URL-embedded basic auth which arrives as a
// standard `Authorization: Basic <base64>` header.
const BASIC_AUTH_ENV = "SENDGRID_INBOUND_PARSE_BASIC_AUTH";

router.post("/email/inbound-parse", inboundParseLimiter, async (req, res) => {
  // 1. Vendor-feature gate. The shared SendGrid email config governs
  // outbound; if it's missing the inbound endpoint can't sensibly
  // route replies (no patients are receiving emails to reply to)
  // either, so 503 with the same error code the rest of the email
  // routes use.
  if (!readEmailConfigOrNull()) {
    res.status(503).json({ error: "messaging_not_configured" });
    return;
  }

  // 2. Auth.
  const expected = process.env[BASIC_AUTH_ENV];
  if (!expected) {
    // Fail closed — the route is registered but not configured yet.
    // 503 not 401 so admins notice the missing env var rather than
    // assuming SendGrid has bad credentials.
    res.status(503).json({ error: "inbound_parse_not_configured" });
    return;
  }
  if (!checkBasicAuth(req.get("authorization") ?? null, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // 3. Parse multipart payload.
  let parsed: ParsedInboundEmail;
  try {
    parsed = await parseMultipart(req);
  } catch (err) {
    logger.warn(
      { event: "email_inbound_parse_failed", err: serializeErr(err) },
      "email.inbound-parse: multipart parse failed",
    );
    // 200 — SendGrid would otherwise retry the same malformed body.
    res.status(200).json({ ok: true });
    return;
  }

  // 3.5. Auto-reply / bounce loop guard. Skip messages from common
  // automated senders OR carrying RFC 3834 / Microsoft headers that
  // mark them as auto-generated. Without this, a vacation responder
  // on a patient mailbox opens a conversation, marks it
  // `awaiting_admin`, and after the first CSR reply will ping-pong
  // indefinitely — and bounces from mailer-daemon@ would create a
  // conversation under the bounce sender, leaving real-patient
  // routing impossible. We acknowledge with 200 + audit so SendGrid
  // doesn't retry.
  const rawHeaders = parsed.fields.headers ?? "";
  const fromForLoopCheck = (parsed.fields.from ?? "").toLowerCase();
  const isAutoGenerated =
    /^auto-submitted:\s*(?!no\b)/im.test(rawHeaders) ||
    /^x-auto-response-suppress:/im.test(rawHeaders) ||
    /^precedence:\s*(bulk|junk|list|auto_reply)/im.test(rawHeaders) ||
    /\b(mailer-daemon|postmaster|noreply|no-reply|do-not-reply|donotreply)@/i.test(
      fromForLoopCheck,
    );
  if (isAutoGenerated) {
    await safeAudit({
      action: "messaging.inbound.received",
      adminEmail: null,
      adminUserId: null,
      targetTable: null,
      targetId: null,
      metadata: {
        channel: "email",
        outcome: "auto_reply_suppressed",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ ok: true });
    return;
  }

  // 4. Resolve sender → patient.
  const fromEmail = extractEmailAddress(parsed.fields.from);
  if (!fromEmail) {
    await safeAudit({
      action: "messaging.inbound.received",
      adminEmail: null,
      adminUserId: null,
      targetTable: null,
      targetId: null,
      metadata: {
        channel: "email",
        outcome: "unparseable_from",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ ok: true });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();

  // Case-insensitive email match. Patients' emails aren't normalized
  // at insert time, so compare via .ilike() with LIKE-metachar
  // escapes (`_` could legitimately appear in a local part). Pull up
  // to 2 rows so we can detect ambiguous matches (one address shared
  // between accounts) and bail rather than mis-routing PHI.
  const escapedEmail = fromEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: lookupRows, error: lookupErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(2);
  if (lookupErr) throw lookupErr;
  if ((lookupRows ?? []).length > 1) {
    await safeAudit({
      action: "messaging.inbound.received",
      adminEmail: null,
      adminUserId: null,
      targetTable: null,
      targetId: null,
      metadata: {
        channel: "email",
        outcome: "ambiguous_email",
        match_count: (lookupRows ?? []).length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ ok: true });
    return;
  }
  const patientId = lookupRows?.[0]?.id;
  if (!patientId) {
    await safeAudit({
      action: "messaging.inbound.received",
      adminEmail: null,
      adminUserId: null,
      targetTable: null,
      targetId: null,
      metadata: {
        channel: "email",
        outcome: "unknown_email",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ ok: true });
    return;
  }

  // 5. Find or create the open email conversation. Same shape as the
  // SMS path — prefer the most recent OPEN email thread; if none, open
  // a new one bound to the patient's most recent episode.
  let conversationId: string | null;
  const { data: openConv, error: openConvErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("id")
    .eq("patient_id", patientId)
    .eq("channel", "email")
    .eq("status", "open")
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
      await safeAudit({
        action: "messaging.inbound.received",
        adminEmail: null,
        adminUserId: null,
        targetTable: null,
        targetId: null,
        metadata: {
          channel: "email",
          patient_id: patientId,
          outcome: "no_episode_for_patient",
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      });
      res.status(200).json({ ok: true });
      return;
    }
    const { data: inserted, error: insertConvErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .insert({
        patient_id: patientId,
        episode_id: episodeId,
        channel: "email",
        status: "open",
        last_message_at: new Date().toISOString(),
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (insertConvErr) throw insertConvErr;
    conversationId = inserted?.id ?? null;
  }
  if (!conversationId) {
    res.status(200).json({ ok: true });
    return;
  }

  // 6. Persist inbound message row. Body is the plaintext part — we
  // never store the HTML version (it would duplicate PHI and the
  // dashboard renders text-only anyway). Subject + sg-supplied
  // message-id sit in vendor_metadata for triage.
  const inboundAt = new Date();
  const body = (parsed.fields.text ?? "").trim() || "(no text body)";
  const subject = parsed.fields.subject ?? null;
  const sendgridMessageId = extractMessageIdHeader(parsed.fields.headers);

  const inboundIso = inboundAt.toISOString();
  const { data: insertedMsg, error: insertMsgErr } = await supabase
    .schema("resupply")
    .from("messages")
    .insert({
      conversation_id: conversationId,
      direction: "inbound",
      sender_role: "patient",
      body,
      delivery_status: "received",
      vendor_metadata: {
        sendgrid_inbound: true,
        subject,
        sendgrid_message_id: sendgridMessageId,
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

  // 7. Ingest attachments through the shared validate→upload→insert
  // helper (same allowlist + 5MB cap + private-GCS ACL as MMS).
  const counts = { attempted: 0, succeeded: 0, rejected: 0, errored: 0 };
  if (inboundMessageId && parsed.attachments.length > 0) {
    const attachments = parsed.attachments.slice(0, MAX_ATTACHMENTS_PER_EMAIL);
    counts.attempted = attachments.length;
    for (const att of attachments) {
      // Files that exceeded MAX_BYTES during streaming arrive with the
      // truncated flag set; persistInboundAttachment will additionally
      // reject by the documented size cap so the audit is consistent.
      try {
        const outcome = await persistInboundAttachment(
          {
            messageId: inboundMessageId,
            bytes: att.bytes,
            contentType: att.contentType,
            filename: att.filename,
            twilioMediaSid: null,
            source: "email",
          },
          req.log,
        );
        counts[outcome] += 1;
      } catch (err) {
        // persistInboundAttachment is documented as never-throws, but
        // belt-and-braces: a programming error here cannot be allowed
        // to abort the rest of the batch.
        logger.error(
          {
            event: "email_inbound_attachment_crashed",
            err: serializeErr(err),
            conversation_id: conversationId,
          },
          "email.inbound-parse: attachment persist crashed",
        );
        counts.errored += 1;
      }
    }
    await safeAudit({
      action: "messaging.inbound.media_ingested",
      adminEmail: null,
      adminUserId: null,
      targetTable: "messages",
      targetId: inboundMessageId,
      metadata: {
        channel: "email",
        attempted: counts.attempted,
        succeeded: counts.succeeded,
        rejected: counts.rejected,
        errored: counts.errored,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
  }

  // 8. Refresh latest-message projection (best-effort).
  await tryUpsertPatientLatestMessageSb(
    supabase,
    {
      conversationId,
      body,
      direction: "inbound",
      messageAt: inboundAt,
    },
    req.log,
  );

  // 8b. Chatbot email auto-reply (opt-in via the `email.auto_reply`
  // feature flag). When enabled AND an LLM provider is configured, the
  // storefront chatbot brain drafts a reply to the patient's message and
  // we send it back by email — turning "the reply landed in the inbox"
  // into an answered conversation. The model HANDS OFF (and we fall
  // through to the awaiting_admin path) for anything order/account/
  // clinical specific, or when it isn't confident — see
  // `lib/messaging/email-auto-reply.ts`. A failure here NEVER breaks the
  // webhook: worst case the thread simply waits for a human, exactly as
  // it did before this feature existed. The cheap provider check runs
  // first so dev/preview environments with no LLM key skip the flag read
  // and thread fetch entirely.
  let autoReplied = false;
  if (selectLlmProvider().provider !== "offline") {
    try {
      if (await isFeatureEnabled("email.auto_reply")) {
        autoReplied = await attemptEmailAutoReply({
          supabase,
          conversationId,
          patientId,
          toEmail: fromEmail,
          inboundSubject: subject,
          inboundBody: body,
          inboundMessageId,
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        });
      }
    } catch (err) {
      // Belt-and-braces: attemptEmailAutoReply is written to swallow its
      // own failures, but a programming error must not 5xx the webhook
      // (SendGrid would retry → duplicate inbound rows). Degrade to the
      // human-handoff path.
      logger.error(
        {
          event: "email_auto_reply_crashed",
          err: serializeErr(err),
          conversation_id: conversationId,
        },
        "email.inbound-parse: auto-reply crashed (falling back to human handoff)",
      );
      autoReplied = false;
    }
  }

  // 9. Set the conversation status. If the bot answered, the ball is back
  // in the patient's court (awaiting_patient) — the auto-reply already
  // persisted its own outbound message + audit row. Otherwise flip to
  // awaiting_admin so a teammate sees the reply in the inbox.
  const nextStatus = autoReplied ? "awaiting_patient" : "awaiting_admin";
  const { error: statusErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .update({ status: nextStatus, updated_at: inboundIso })
    .eq("id", conversationId);
  if (statusErr) throw statusErr;

  await safeAudit({
    action: "messaging.inbound.received",
    adminEmail: null,
    adminUserId: null,
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      channel: "email",
      patient_id: patientId,
      conversation_id: conversationId,
      outcome: "matched_patient",
      sendgrid_message_id: sendgridMessageId,
      attachment_count: counts.attempted,
      auto_replied: autoReplied,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });

  res.status(200).json({ ok: true });
});

// ---------------------------------------------------------------------------
// Email auto-reply
// ---------------------------------------------------------------------------

interface AttemptEmailAutoReplyInput {
  supabase: ResupplySupabaseClient;
  conversationId: string;
  patientId: string;
  /** Patient's email address (the inbound `From`) — where the reply goes. */
  toEmail: string;
  inboundSubject: string | null;
  inboundBody: string;
  /** Id of the inbound row we just inserted, so it's excluded from context. */
  inboundMessageId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Draft a reply with the chatbot brain and, if it's confident enough to
 * answer, send it back by email and persist the outbound message. Returns
 * `true` only when a reply was actually sent to the patient.
 *
 * Expected failure modes (model hand-off, missing SendGrid config, vendor
 * API error) return `false` so the caller leaves the thread for a human.
 * Unexpected errors (a DB read failure, a non-vendor exception) are
 * allowed to throw; the caller wraps this in try/catch and degrades to the
 * same `false` (awaiting_admin) path, so the webhook never 5xxs either way.
 */
async function attemptEmailAutoReply(
  input: AttemptEmailAutoReplyInput,
): Promise<boolean> {
  const {
    supabase,
    conversationId,
    patientId,
    toEmail,
    inboundSubject,
    inboundBody,
    inboundMessageId,
  } = input;

  // Pull a short window of prior turns for context, excluding the inbound
  // row we just inserted (its body is passed separately as the message to
  // reply to). Oldest-first after the reverse.
  const { data: recent, error: recentErr } = await supabase
    .schema("resupply")
    .from("messages")
    .select("id, direction, body, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(7);
  if (recentErr) throw recentErr;
  const thread = (recent ?? [])
    .slice()
    .reverse()
    .filter((m) => m.id !== inboundMessageId && m.body !== null)
    .map((m) => ({
      role:
        m.direction === "inbound" ? ("patient" as const) : ("agent" as const),
      body: (m.body as string) ?? "",
    }));

  const drafted = await generateEmailReply({
    body: inboundBody,
    subject: inboundSubject,
    thread,
  });
  if (drafted.kind !== "reply") return false;

  const cfg = readEmailConfigOrNull();
  if (!cfg) return false;

  let sg;
  try {
    sg = createSendgridClient({
      apiKey: cfg.sendgridApiKey,
      fromEmail: cfg.sendgridFromEmail,
      fromName: cfg.sendgridFromName,
    });
  } catch (err) {
    if (err instanceof EmailConfigError) {
      logger.warn(
        {
          event: "email_auto_reply_config_error",
          conversation_id: conversationId,
        },
        "email.inbound-parse: SendGrid not configured — handing off",
      );
      return false;
    }
    throw err;
  }

  const subjectLine = buildReplySubject(inboundSubject);
  let vendorRef: string;
  try {
    const r = await sg.sendEmail({
      to: toEmail,
      subject: subjectLine,
      text: drafted.reply,
      html: renderAutoReplyHtml(drafted.reply),
      customArgs: {
        conversation_id: conversationId,
        patient_id: patientId,
        kind: "email_auto_reply",
      },
    });
    vendorRef = r.messageId;
  } catch (err) {
    if (err instanceof EmailApiError || err instanceof EmailConfigError) {
      logger.warn(
        {
          event: "email_auto_reply_send_failed",
          conversation_id: conversationId,
          status: err instanceof EmailApiError ? (err.status ?? null) : null,
        },
        "email.inbound-parse: SendGrid send failed — handing off",
      );
      return false;
    }
    throw err;
  }

  // Persist the outbound reply (best-effort). The email is already out;
  // a DB hiccup here must NOT make us report failure (which would leave
  // the thread awaiting_admin AND have sent a reply — confusing). Log
  // loud so ops can reconcile the missing row by vendorRef.
  const sentAt = new Date();
  const sentIso = sentAt.toISOString();
  let outboundMessageId: string | null = null;
  const { data: outMsg, error: outErr } = await supabase
    .schema("resupply")
    .from("messages")
    .insert({
      conversation_id: conversationId,
      direction: "outbound",
      sender_role: "agent",
      body: drafted.reply,
      delivery_status: "queued",
      vendor_metadata: {
        sendgrid_message_id: vendorRef,
        auto_reply: true,
      } as unknown as Json,
      sent_at: sentIso,
    })
    .select("id")
    .limit(1)
    .maybeSingle();
  if (outErr) {
    logger.error(
      {
        event: "email_auto_reply_persist_failed",
        err: serializeErr(outErr),
        conversation_id: conversationId,
        vendor_ref: vendorRef,
      },
      "email.inbound-parse: auto-reply sent but messages row not written — manual reconciliation required",
    );
  } else {
    outboundMessageId = outMsg?.id ?? null;
  }

  // Refresh the latest-message projection for the outbound (best-effort).
  await tryUpsertPatientLatestMessageSb(supabase, {
    conversationId,
    body: drafted.reply,
    direction: "outbound",
    messageAt: sentAt,
  });

  await safeAudit({
    action: "messaging.reply.sent",
    adminEmail: null,
    adminUserId: null,
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      channel: "email",
      conversation_id: conversationId,
      patient_id: patientId,
      message_id: outboundMessageId,
      status: "ok",
      auto_reply: true,
      body_length: drafted.reply.length,
      vendor_ref: vendorRef,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return true;
}

/**
 * Build the reply subject. Re-uses the inbound subject with a single
 * `Re:` prefix (so the patient's mail client threads it) and strips
 * CR/LF — the SendGrid client rejects header newlines, but failing here
 * would lose the reply rather than just losing the prefix.
 */
function buildReplySubject(subject: string | null): string {
  const base = (subject ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 200);
  if (!base) return "Re: Your message to PennPaps";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/** Render the plain-text reply as a minimally-styled HTML body. */
function renderAutoReplyHtml(reply: string): string {
  return `<div style="white-space: pre-wrap; font-family: -apple-system, system-ui, sans-serif; line-height: 1.5; color: #1f2937">${escapeHtml(
    reply,
  )}</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedAttachment {
  filename: string | null;
  contentType: string;
  bytes: Uint8Array;
  /** True when the attachment exceeded MAX_BYTES and was truncated. */
  truncated: boolean;
}

interface ParsedInboundEmail {
  fields: Record<string, string>;
  attachments: ParsedAttachment[];
}

/**
 * Stream the multipart/form-data body via busboy into in-memory
 * fields + attachment buffers. Field values use a small per-field
 * cap; attachment bytes use the shared MAX_BYTES cap (5MB) — files
 * larger than that are truncated and flagged so the persist helper
 * can reject them by size in the audited path.
 */
function parseMultipart(req: Request): Promise<ParsedInboundEmail> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({
        headers: req.headers,
        limits: {
          fieldNameSize: 200,
          fieldSize: 64 * 1024,
          fields: 50,
          fileSize: MAX_BYTES + 1, // +1 so the truncated flag fires at exactly MAX_BYTES
          files: MAX_ATTACHMENTS_PER_EMAIL,
        },
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const fields: Record<string, string> = {};
    const attachments: ParsedAttachment[] = [];
    let totalBytes = 0;
    let aborted = false;

    function abort(err: Error) {
      if (aborted) return;
      aborted = true;
      req.unpipe(bb);
      reject(err);
    }

    bb.on("field", (name: string, value: string) => {
      // Last-write-wins on duplicate keys — SendGrid never duplicates
      // top-level fields, but defensive.
      fields[name] = value;
    });

    bb.on(
      "file",
      (
        _fieldName: string,
        stream: NodeJS.ReadableStream,
        info: { filename?: string; mimeType?: string; encoding?: string },
      ) => {
        const chunks: Buffer[] = [];
        let truncated = false;
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > TOTAL_PAYLOAD_BYTES) {
            abort(new Error("inbound email exceeded total payload cap"));
            return;
          }
          if (size + chunk.length > MAX_BYTES) {
            // Keep just enough to make the size-check downstream
            // unambiguously oversize, then drop the rest.
            const remaining = Math.max(0, MAX_BYTES + 1 - size);
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            size = Math.min(MAX_BYTES + 1, size + chunk.length);
            truncated = true;
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on("limit", () => {
          truncated = true;
        });
        stream.on("end", () => {
          attachments.push({
            filename: info.filename ? info.filename : null,
            contentType: info.mimeType ?? "application/octet-stream",
            bytes: Buffer.concat(chunks),
            truncated,
          });
        });
        stream.on("error", (err) => abort(err));
      },
    );

    bb.on("error", (err: Error) => abort(err));
    bb.on("finish", () => {
      if (!aborted) resolve({ fields, attachments });
    });

    req.pipe(bb);
  });
}

/**
 * Extract the bare email address from a "From" header value. Handles
 * the two common shapes:
 *   - "Patient Name <patient@example.com>" → "patient@example.com"
 *   - "patient@example.com"                → "patient@example.com"
 *
 * Returns the lower-cased address, or null if no address is present.
 * Anything fancier (group addresses, encoded local parts) is rejected
 * — those don't come up in the SendGrid Inbound Parse stream in
 * practice and a strict parse is safer than a permissive one.
 */
function extractEmailAddress(raw: string | undefined): string | null {
  if (!raw) return null;
  // Require at least one dot in the domain portion so obviously malformed
  // addresses like "user@localdomain" or "@domain.com" are rejected.
  const angled = raw.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/);
  if (angled?.[1]) return angled[1].trim().toLowerCase();
  const bare = raw.trim().match(/^([^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+)$/);
  if (bare?.[1]) return bare[1].toLowerCase();
  return null;
}

/**
 * Pull the "Message-ID:" header value out of the raw `headers` field
 * SendGrid forwards. Used purely for triage / replay correlation in
 * audit metadata — never required.
 */
function extractMessageIdHeader(headers: string | undefined): string | null {
  if (!headers) return null;
  const m = headers.match(/^Message-ID:\s*<([^>]+)>/im);
  return m?.[1] ?? null;
}

/**
 * Constant-time-ish comparison of the basic-auth header against the
 * expected `user:pass` env value. We don't need true constant-time
 * here because the secret is a configuration value (not user
 * input that could be probed online) but it costs nothing.
 */
function checkBasicAuth(authHeader: string | null, expected: string): boolean {
  if (!authHeader || !authHeader.toLowerCase().startsWith("basic ")) {
    return false;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString(
      "utf8",
    );
  } catch {
    return false;
  }
  if (decoded.length !== expected.length) return false;
  let acc = 0;
  for (let i = 0; i < decoded.length; i++) {
    acc |= decoded.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return acc === 0;
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

// Re-export for tests so they don't have to load the full router.
export { extractEmailAddress, extractMessageIdHeader, checkBasicAuth };

// Suppress an unused param lint on Response since the handler always
// uses res but the type import is required for the helper signature.
export type { Response as _Response };

export default router;
