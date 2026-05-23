// POST /voice/status-callback — Twilio call lifecycle webhook.
//
// Twilio POSTs lifecycle transitions: `initiated`, `ringing`,
// `answered`, `completed`, plus the unhappy-path terminal states
// `failed`, `busy`, `no-answer`, `canceled`. We:
//   * 200 every signed request immediately (Twilio retries 5xx with
//     backoff; we want the lifecycle stream to flow even if our
//     downstream DB is briefly unhappy).
//   * Audit ONE row per terminal-state event so the dashboard timeline
//     can show "rang for 12s, no answer".
//   * Mark the conversation `closed` on terminal states. The WS-side
//     finaliser also closes; doing both is fine — `closed` is
//     idempotent and Twilio sometimes delivers `completed` BEFORE the
//     bridge's session.closed fires (or after; Twilio orders both
//     sides asynchronously).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { requireTwilioSignature } from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { readVoiceConfigOrNull } from "../../lib/voice/voice-config";

const router: IRouter = Router();

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "busy",
  "no-answer",
  "canceled",
]);

const signatureMiddleware = requireTwilioSignature({
  getAuthToken: () => readVoiceConfigOrNull()?.twilioAuthToken,
  buildPublicUrl: (req) => {
    const cfg = readVoiceConfigOrNull();
    const base = cfg?.publicBaseUrl ?? "";
    const originalUrl =
      (req as unknown as { originalUrl?: string }).originalUrl ?? "";
    return `${base}${originalUrl}`;
  },
});

router.post("/voice/status-callback", signatureMiddleware, async (req, res) => {
  // Twilio body fields: CallSid, CallStatus, From, To, Duration, etc.
  // We deliberately do NOT read From/To — those carry PHI (the
  // patient's phone number). The audit row records ONLY structural
  // metadata (status + sid + conversation id).
  const body = (req.body ?? {}) as Record<string, string>;
  const callStatus =
    typeof body.CallStatus === "string" ? body.CallStatus : null;
  const callSid = typeof body.CallSid === "string" ? body.CallSid : null;
  // Validate UUID shape on the URL param before using it as a row
  // lookup key. Twilio's signature middleware (registered above)
  // covers the URL query string + body, so a forged value can only
  // appear if the auth token leaked — but a malformed value would
  // still flow into our DB query as a no-op; matching SMS callback's
  // validation here keeps audit metadata consistently UUID-shaped.
  const conversationIdParse = z.string().uuid().safeParse(req.query.conversationId);
  const conversationId = conversationIdParse.success
    ? conversationIdParse.data
    : null;

  if (!callStatus || !callSid || !conversationId) {
    // ack so Twilio doesn't retry, but don't audit a malformed event
    res.status(200).type("text/xml").send("<Response/>");
    return;
  }

  if (TERMINAL_STATUSES.has(callStatus)) {
    let firstTerminalClose = false;
    try {
      const supabase = getSupabaseServiceRoleClient();
      // Twilio can re-deliver `completed/failed/busy/...` (retry on
      // 5xx, or duplicate after our 200 took >response timeout to
      // ack). The .eq("status","open") guard + .select("id") tells
      // us whether THIS call flipped the row; only the winner emits
      // the audit row, so the HMAC-chained audit log doesn't grow
      // a duplicate `voice.call.completed` entry on every retry.
      const { data: flipped, error } = await supabase
        .schema("resupply")
        .from("conversations")
        .update({ status: "closed", updated_at: new Date().toISOString() })
        .eq("id", conversationId)
        .neq("status", "closed")
        .select("id");
      if (error) throw error;
      firstTerminalClose = !!flipped && flipped.length > 0;
    } catch (err) {
      logger.warn(
        {
          event: "voice_status_close_failed",
          err: serializeErr(err),
          conversationId,
        },
        "status-callback: conversation close failed",
      );
    }

    if (firstTerminalClose) {
      try {
        await logAudit({
          action: "voice.call.completed",
          targetTable: "conversations",
          targetId: conversationId,
          metadata: {
            twilio_call_sid: callSid,
            twilio_status: callStatus,
            source: "status_callback",
          },
        });
      } catch (err) {
        logger.warn(
          {
            event: "voice_status_audit_failed",
            err: serializeErr(err),
            conversationId,
          },
          "status-callback: audit failed",
        );
      }
    }
  }

  res.status(200).type("text/xml").send("<Response/>");
});

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

export default router;
