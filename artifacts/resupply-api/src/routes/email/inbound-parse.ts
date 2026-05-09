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
//   5. Marks the conversation `awaiting_admin` so a team member sees
//      the new evidence in the inbox. We deliberately do NOT run the
//      keyword router or AI fallback on free-text email replies —
//      the ADR (013-messaging-sms-email-architecture.md §"Why no
//      inbound email parser") explains that confirmation/decline
//      decisions on email come from the click-through link, not the
//      patient's free-text reply.
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
import { drizzle } from "drizzle-orm/node-postgres";

import {
  getDbPool,
  getSupabaseServiceRoleClient,
  tryUpsertPatientLatestMessage,
  type Json,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
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

  // 8. Refresh latest-message projection (best-effort) + flip the
  // conversation to awaiting_admin so a teammate sees the reply in
  // the inbox. The projection helper still takes a Drizzle handle —
  // shared infrastructure used by every messaging entry-point — so
  // we keep that one Drizzle call until the projection is migrated.
  const projectionDb = drizzle(getDbPool());
  await tryUpsertPatientLatestMessage(
    projectionDb,
    {
      conversationId,
      body,
      direction: "inbound",
      messageAt: inboundAt,
    },
    req.log,
  );
  const { error: awaitingErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .update({ status: "awaiting_admin", updated_at: inboundIso })
    .eq("id", conversationId);
  if (awaitingErr) throw awaitingErr;

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
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });

  res.status(200).json({ ok: true });
});

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
