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
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";
import { requireTwilioSignature } from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import { recordTenantUsage } from "../../lib/metering/usage";
import {
  parseCallDuration,
  recordVoiceCallEvent,
} from "../../lib/voice/voice-call-record";
import {
  readTwilioWebhookAuthTokenOrNull,
  readVoicePublicBaseUrlOrNull,
} from "../../lib/voice/voice-config";

const router: IRouter = Router();

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "busy",
  "no-answer",
  "canceled",
]);

const signatureMiddleware = requireTwilioSignature({
  // Use token-only reader so status callbacks authenticate even when
  // OPENAI_API_KEY is unset (status callbacks fire after a real
  // outbound call too, but ALSO for missed inbound — must not fail).
  getAuthToken: () => readTwilioWebhookAuthTokenOrNull() ?? undefined,
  buildPublicUrl: (req) => {
    // Decoupled from full voice config so the URL Twilio signed can
    // be reconstructed even without OPENAI_API_KEY.
    const base = readVoicePublicBaseUrlOrNull() ?? "";
    const originalUrl = req.originalUrl ?? "";
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
  const conversationIdParse = z
    .string()
    .uuid()
    .safeParse(req.query.conversationId);
  const conversationId = conversationIdParse.success
    ? conversationIdParse.data
    : null;

  if (!callStatus || !callSid || !conversationId) {
    // ack so Twilio doesn't retry, but don't audit a malformed event.
    // Log enough context to investigate — a status-callback that
    // can't bind to a conversation means the bridge's WS-side
    // finaliser is the only thing that will ever close that
    // conversation row. If THAT also fails, the row would stay
    // open indefinitely and the dashboard'd never show a "call
    // ended" tick — surface the breakage so ops can see it.
    logger.warn(
      {
        event: "voice_status_callback_malformed",
        hasCallStatus: callStatus != null,
        hasCallSid: callSid != null,
        hasConversationId: conversationId != null,
        conversationIdParseError: conversationIdParse.success
          ? null
          : "invalid_uuid",
      },
      "voice/status-callback: required field missing or malformed",
    );
    res.status(200).type("text/xml").send("<Response/>");
    return;
  }

  // Webhook: no req.orgId. Resolve the seed tenant; on miss, ACK 200 so
  // Twilio stops retrying (same degrade posture as the per-helper catch
  // blocks below — a tenant-context gap must not retry-storm Twilio).
  const orgId = await resolveSeedOrgId();
  if (!orgId) {
    res.status(200).type("text/xml").send("<Response/>");
    return;
  }
  const supabase = getOrgScopedClient(orgId);

  // The call's TRUE tenant, read off the conversation row. Resolved here
  // (not only inside the terminal branch) because the telemetry write at
  // the bottom needs it on EVERY lifecycle event: `voice_calls.org_id` is
  // what /admin/voice/metrics and the channel-engagement analytics filter
  // on, and a row written without it is invisible to both.
  let callOrgId: string | null = null;
  try {
    // raw-org-scope-exempt: keyed on the globally-unique conversation
    // uuid from a tenant-agnostic Twilio webhook. Scoping this to the
    // seed org is precisely the bug — it would resolve every non-seed
    // tenant's call to null and then attribute it to the seed.
    const { data: convRow } = await supabase
      .raw()
      .schema("resupply")
      .from("conversations")
      .select("org_id")
      .eq("id", conversationId)
      .limit(1)
      .maybeSingle();
    const rowOrgId = (convRow as { org_id?: unknown } | null)?.org_id;
    if (typeof rowOrgId === "string" && rowOrgId.trim()) {
      callOrgId = rowOrgId.trim();
    }
  } catch (err) {
    logger.warn(
      {
        event: "voice_status_org_lookup_failed",
        err: serializeErr(err),
        conversationId,
      },
      "status-callback: could not resolve the call's tenant",
    );
  }

  if (TERMINAL_STATUSES.has(callStatus)) {
    let firstTerminalClose = false;
    try {
      // Twilio can re-deliver `completed/failed/busy/...` (retry on
      // 5xx, or duplicate after our 200 took >response timeout to
      // ack). The .eq("status","open") guard + .select("id") tells
      // us whether THIS call flipped the row; only the winner emits
      // the audit row, so the HMAC-chained audit log doesn't grow
      // a duplicate `voice.call.completed` entry on every retry.
      // Tenant-agnostic webhook: the conversation id is a globally-unique
      // uuid, so match across tenants via `.raw()` — the org-scoped client
      // would filter by the seed org_id and never close a non-seed tenant's
      // call (the rest of this handler already uses `supabase.raw()`).
      const { data: flipped, error } = await supabase
        .raw()
        .schema("resupply")
        .from("conversations")
        .update({ status: "closed", updated_at: new Date().toISOString() })
        .eq("id", conversationId)
        .neq("status", "closed")
        .select("id, org_id");
      if (error) throw error;
      firstTerminalClose = !!flipped && flipped.length > 0;
      // Prefer the org read off the row we actually flipped; it is the
      // same value as the lookup above, and confirms it against the write.
      const flippedOrgId = flipped?.[0]?.org_id;
      if (typeof flippedOrgId === "string" && flippedOrgId.trim()) {
        callOrgId = flippedOrgId.trim();
      }
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

      // One completed voice call — metered by whichever path FIRST closes
      // the conversation (this status-callback or ws-handler's
      // finalizeConversation). The firstTerminalClose guard makes that
      // exactly-once across both paths (G12 aiVoiceEvents). Fire-and-forget
      // + fail-soft.
      //
      // NEVER falls back to the seed org. This used to read
      // `callOrgId ?? orgId`, which billed an un-attributed call to the
      // seed tenant — a tenant that did not place it, on a metered
      // metric. An unknown tenant means we cannot bill anyone: log it and
      // skip, so the gap is visible rather than charged to a stranger.
      if (callOrgId) {
        void recordTenantUsage({
          orgId: callOrgId,
          metricKey: "aiVoiceEvents",
          source: "voice.call.completed",
        });
      } else {
        logger.warn(
          { event: "voice_call_unmetered_no_tenant", conversationId },
          "status-callback: completed call has no resolvable tenant — not metered",
        );
      }
    }
  }

  // Best-effort timing telemetry for /admin/voice/metrics. Runs for
  // EVERY lifecycle event (not just terminal) so we capture
  // initiated/answered/ended. Never affects the 200 ack — a telemetry
  // failure must not make Twilio retry the lifecycle.
  try {
    await recordVoiceCallEvent(
      supabase.raw(),
      {
        callSid,
        conversationId,
        callStatus,
        // Direction is structural (inbound vs outbound), not PHI.
        direction: typeof body.Direction === "string" ? body.Direction : null,
        durationSeconds: parseCallDuration(body.CallDuration),
        // AMD verdict (human / machine_* / fax / unknown) — structural, not PHI.
        // Lets the escalation distinguish a live answer from voicemail.
        answeredBy:
          typeof body.AnsweredBy === "string" ? body.AnsweredBy : null,
        nowIso: new Date().toISOString(),
      },
      callOrgId,
    );
  } catch (err) {
    logger.warn(
      {
        event: "voice_call_record_failed",
        err: serializeErr(err),
        conversationId,
      },
      "status-callback: voice-call timing record failed",
    );
  }

  res.status(200).type("text/xml").send("<Response/>");
});

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

export default router;
