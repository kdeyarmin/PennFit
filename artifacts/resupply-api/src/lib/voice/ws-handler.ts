// WebSocket bridge — the join point between Twilio Media Streams and
// the OpenAI Realtime session for ONE outbound call.
//
// Lifecycle (happy path):
//   1. POST /voice/place-call registers a pending session, dials Twilio.
//   2. The patient picks up; Twilio POSTs /voice/twiml-connect.
//   3. The TwiML response tells Twilio to open a Media Stream WS to
//      /resupply-api/voice/stream?conversationId=<id>.
//   4. Twilio opens the WS. The HTTP server's `upgrade` handler
//      validates the path + claims the pending session, then hands the
//      socket here.
//   5. We open the OpenAI Realtime client, build the bridge, wire the
//      audio sink, and run until either side closes.
//   6. On close: persist final transcript turns (already streamed),
//      mark the conversation `closed`, audit `voice.call.completed`.
//
// What this module is NOT responsible for:
//   - Signature validation (the upgrade handler does it before we get
//     the socket; the WS itself is post-handshake).
//   - Pending-session lifetime (claim happens at upgrade time).
//   - HTTP routing (this is invoked from the upgrade handler in
//     `index.ts`).

import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { WebSocket } from "ws";

import { logAudit } from "@workspace/resupply-audit";
import {
  conversations,
  getDbPool,
  messages,
  tryUpsertPatientLatestMessage,
} from "@workspace/resupply-db";
import {
  buildSystemPrompt,
  OPENAI_TOOL_DESCRIPTORS,
  PROMPT_VERSION,
  RealtimeClient,
  TOOL_NAMES,
  VoiceBridge,
  type MediaStreamSink,
  type TranscriptTurn,
} from "@workspace/resupply-ai";
import {
  encodeClearFrame,
  encodeMediaFrame,
  parseTwilioFrame,
} from "@workspace/resupply-telecom";

import { logger } from "../logger";
import type { PendingSessionEntry } from "./pending-sessions";
import { createVoiceToolDispatcher } from "./tools-impl";
import { readVoiceConfigOrThrow } from "./voice-config";

/**
 * Wire one Twilio Media Stream WS to one OpenAI Realtime session.
 *
 * The caller has ALREADY claimed the pending-session entry — by the
 * time we're invoked, `pending.conversationId` and the bound
 * patient/episode IDs are guaranteed to be the right ones. We never
 * re-read the pending registry inside this function.
 *
 * Returned promise resolves once the bridge is fully closed (used by
 * the integration test; production callers can fire-and-forget).
 */
export async function handleVoiceWsConnection(
  ws: WebSocket,
  pending: PendingSessionEntry,
): Promise<void> {
  const config = readVoiceConfigOrThrow();
  const pool = getDbPool();
  const db: NodePgDatabase = drizzle(pool);

  let streamSid: string | null = null;
  let twilioCallSid: string | null = pending.twilioCallSid ?? null;
  let closed = false;

  // Sink Twilio side. We only know `streamSid` after the `start`
  // frame, so audio deltas before that are silently dropped (the
  // model can't realistically produce audio before we've sent it the
  // session.update + initial response.create — the OpenAI side hasn't
  // even spoken yet by the time `start` arrives).
  const sink: MediaStreamSink = {
    writeAudioBase64(b64: string): void {
      if (closed || !streamSid) return;
      try {
        ws.send(encodeMediaFrame(streamSid, b64));
      } catch (err) {
        logger.warn(
          {
            event: "voice_ws_send_failed",
            err: serializeErr(err),
            conversationId: pending.conversationId,
          },
          "voice ws send failed",
        );
      }
    },
    clearQueuedAudio(): void {
      if (closed || !streamSid) return;
      try {
        ws.send(encodeClearFrame(streamSid));
      } catch {
        // best-effort; barge-in clears are not load-bearing
      }
    },
  };

  const dispatcher = createVoiceToolDispatcher({
    db,
    patientId: pending.patientId,
    conversationId: pending.conversationId,
    episodeId: pending.episodeId,
  });

  const client = new RealtimeClient({
    apiKey: config.openaiApiKey,
    instructions: buildSystemPrompt({
      practiceName: config.practiceName ?? "PennPaps",
      callContext:
        "Outbound CPAP resupply check-in. Verify identity by date of birth, " +
        "review supplies due, confirm shipping address, and place the order.",
    }),
    tools: OPENAI_TOOL_DESCRIPTORS,
    allowedToolNames: new Set(TOOL_NAMES),
  });

  const bridge = new VoiceBridge({ client, sink, dispatcher });

  bridge.on("session.opened", () => {
    logger.info(
      { event: "voice_session_opened", conversationId: pending.conversationId },
      "voice session opened",
    );
  });

  bridge.on("transcript.turn", (turn) => {
    void persistTranscript(db, pending.conversationId, turn).catch((err) => {
      logger.error(
        {
          event: "voice_transcript_persist_failed",
          err: serializeErr(err),
          conversationId: pending.conversationId,
        },
        "voice transcript persist failed",
      );
    });
  });

  bridge.on("tool.invoked", (invocation) => {
    void logAudit({
      action: "voice.tool.invoked",
      targetTable: "conversations",
      targetId: pending.conversationId,
      metadata: {
        ...invocation.auditArgs,
        status: invocation.status,
        prompt_version: PROMPT_VERSION,
        twilio_call_sid: twilioCallSid ?? null,
      },
    }).catch((err) => {
      logger.error(
        {
          event: "voice_tool_audit_failed",
          err: serializeErr(err),
          conversationId: pending.conversationId,
        },
        "voice.tool.invoked audit failed",
      );
    });
  });

  bridge.on("session.error", (err) => {
    logger.warn(
      {
        event: "voice_session_error",
        err,
        conversationId: pending.conversationId,
      },
      "voice session error",
    );
  });

  bridge.on("session.closed", (info) => {
    if (closed) return;
    closed = true;
    logger.info(
      {
        event: "voice_session_closed",
        info,
        conversationId: pending.conversationId,
      },
      "voice session closed",
    );
    void finalizeConversation(
      db,
      pending.conversationId,
      twilioCallSid,
      info.reason,
    ).catch((err) => {
      logger.error(
        {
          event: "voice_finalize_failed",
          err: serializeErr(err),
          conversationId: pending.conversationId,
        },
        "voice conversation finalise failed",
      );
    });
    try {
      ws.close(1000, "session-closed");
    } catch {
      /* already closed */
    }
  });

  // RealtimeClient connects in its constructor; no explicit connect() call.

  ws.on("message", (raw) => {
    const buf = raw as Buffer | string;
    const frame = parseTwilioFrame(buf);
    if (!frame) return;
    switch (frame.event) {
      case "connected":
        return;
      case "start":
        streamSid = frame.start.streamSid;
        twilioCallSid = frame.start.callSid;
        return;
      case "media":
        bridge.forwardCallerAudio(frame.media.payload);
        return;
      case "stop":
        bridge.close("twilio-stop");
        return;
      case "mark":
        return;
    }
  });

  ws.on("close", () => {
    bridge.close("twilio-ws-closed");
  });

  ws.on("error", (err) => {
    logger.warn(
      {
        event: "voice_ws_error",
        err: serializeErr(err),
        conversationId: pending.conversationId,
      },
      "voice ws error",
    );
    bridge.close("twilio-ws-error");
  });

  // Resolve once the bridge has actually emitted `session.closed`. The
  // integration test awaits this; production callers ignore.
  await new Promise<void>((resolve) => {
    bridge.once("session.closed", () => resolve());
  });
}

async function persistTranscript(
  db: NodePgDatabase,
  conversationId: string,
  turn: TranscriptTurn,
): Promise<void> {
  const direction = turn.source === "input" ? "inbound" : "outbound";
  const sentAt = new Date();
  await db.insert(messages).values({
    conversationId,
    direction,
    senderRole: turn.source === "input" ? "patient" : "agent",
    body: turn.text,
    sentAt,
  });

  // Refresh latest-message projection (best-effort). Voice transcripts
  // can be long — `tryUpsert` truncates internally, so we don't need
  // to pre-truncate here.
  await tryUpsertPatientLatestMessage(db, {
    conversationId,
    body: turn.text,
    direction,
    messageAt: sentAt,
  });
}

async function finalizeConversation(
  db: NodePgDatabase,
  conversationId: string,
  twilioCallSid: string | null,
  reason: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ status: "closed", updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));

  await logAudit({
    action: "voice.call.completed",
    targetTable: "conversations",
    targetId: conversationId,
    metadata: {
      reason,
      twilio_call_sid: twilioCallSid ?? null,
      prompt_version: PROMPT_VERSION,
    },
  });
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}
