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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { logAudit } from "@workspace/resupply-audit";
import { conversations, getDbPool } from "@workspace/resupply-db";
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
  const callStatus = typeof body.CallStatus === "string" ? body.CallStatus : null;
  const callSid = typeof body.CallSid === "string" ? body.CallSid : null;
  const conversationId =
    typeof req.query.conversationId === "string"
      ? req.query.conversationId
      : null;

  if (!callStatus || !callSid || !conversationId) {
    // ack so Twilio doesn't retry, but don't audit a malformed event
    res.status(200).type("text/xml").send("<Response/>");
    return;
  }

  if (TERMINAL_STATUSES.has(callStatus)) {
    const pool = getDbPool();
    const db = drizzle(pool);
    try {
      await db
        .update(conversations)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
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

  res.status(200).type("text/xml").send("<Response/>");
});

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

export default router;
