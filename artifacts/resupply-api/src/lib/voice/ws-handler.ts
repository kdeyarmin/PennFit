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
//      audio sink, and (optionally) open a parallel Deepgram Nova-3
//      transcription session that sees the same caller-side audio.
//   6. On close:
//      a. persist final transcript turns (already streamed)
//      b. mark the conversation `closed`, audit `voice.call.completed`
//      c. write the Deepgram-side transcript as `voice.call.deepgram_transcript`
//         (when Deepgram was enabled)
//      d. fire-and-forget Claude post-call summary →
//         `voice.call.summary` audit row.
//      Steps (c) and (d) are detached from the WS close so a flaky
//      vendor call NEVER delays hangup.
//
// What this module is NOT responsible for:
//   - Signature validation (the upgrade handler does it before we get
//     the socket; the WS itself is post-handshake).
//   - Pending-session lifetime (claim happens at upgrade time).
//   - HTTP routing (this is invoked from the upgrade handler in
//     `index.ts`).

import type { WebSocket } from "ws";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  tryUpsertPatientLatestMessageSb,
  type ResupplySupabaseClient,
} from "@workspace/resupply-db";
import {
  buildSystemPrompt,
  createDeepgramClient,
  OPENAI_TOOL_DESCRIPTORS,
  PROMPT_VERSION,
  RealtimeClient,
  TOOL_NAMES,
  VoiceBridge,
  type DeepgramLiveSession,
  type MediaStreamSink,
  type TranscriptTurn,
} from "@workspace/resupply-ai";
import {
  encodeClearFrame,
  encodeMediaFrame,
  parseTwilioFrame,
} from "@workspace/resupply-telecom";

import { getAnthropicClient } from "../llm-provider";
import { logger } from "../logger";
import type { PendingSessionEntry } from "./pending-sessions";
import {
  summarizePostCall,
  type PostCallSummary,
  type TurnForSummary,
} from "./post-call-summary";
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
  const supabase = getSupabaseServiceRoleClient();

  let streamSid: string | null = null;
  let twilioCallSid: string | null = pending.twilioCallSid ?? null;
  let closed = false;

  // Accumulate finalized transcript turns from the bridge so the
  // post-call summarizer can see the whole arc of the conversation
  // after hangup. This is in-memory only — it does NOT touch the DB
  // (those rows are persisted independently in persistTranscript).
  // Capped so a stuck call can't grow unbounded.
  const turnHistory: TurnForSummary[] = [];
  const MAX_RETAINED_TURNS = 200;

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
    supabase,
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

  // Optional Deepgram parallel transcription. When DEEPGRAM_API_KEY
  // is set, we run Nova-3 on the caller-side audio in parallel with
  // the OpenAI Realtime model's built-in STT. The model continues to
  // drive the conversation; Deepgram's higher-accuracy transcript
  // gets aggregated and written to the audit log on hangup for the
  // medical record and the post-call summarizer.
  let deepgramSession: DeepgramLiveSession | null = null;
  const deepgramTurns: string[] = [];
  if (config.deepgramApiKey) {
    try {
      const dg = createDeepgramClient({ apiKey: config.deepgramApiKey });
      deepgramSession = dg.createLiveSession({
        // µ-law @ 8kHz mono is what Twilio Media Streams natively
        // emits, so we send the audio bytes straight through with no
        // transcoding.
        encoding: "mulaw",
        sampleRate: 8000,
        channels: 1,
        interimResults: false,
        smartFormat: true,
        punctuate: true,
        // Generous endpointing window — phones leave a beat of silence
        // when a caller pauses to think; we don't want to split that
        // utterance.
        endpointing: 1200,
      });
      deepgramSession.onTranscript((ev) => {
        if (!ev.isFinal) return;
        const text = ev.transcript.trim();
        if (text.length === 0) return;
        if (deepgramTurns.length < MAX_RETAINED_TURNS) {
          deepgramTurns.push(text);
        }
      });
      deepgramSession.onError((err) => {
        logger.warn(
          {
            event: "voice_deepgram_error",
            code: err.code,
            message: err.message,
            conversationId: pending.conversationId,
          },
          "voice deepgram error (parallel transcription degraded)",
        );
      });
      logger.info(
        {
          event: "voice_deepgram_session_opened",
          conversationId: pending.conversationId,
        },
        "voice: deepgram parallel transcription enabled",
      );
    } catch (err) {
      logger.warn(
        {
          event: "voice_deepgram_init_failed",
          err: serializeErr(err),
          conversationId: pending.conversationId,
        },
        "voice deepgram init failed (call continues without parallel transcription)",
      );
      deepgramSession = null;
    }
  }

  bridge.on("session.opened", () => {
    logger.info(
      { event: "voice_session_opened", conversationId: pending.conversationId },
      "voice session opened",
    );
  });

  bridge.on("transcript.turn", (turn) => {
    if (turnHistory.length < MAX_RETAINED_TURNS) {
      turnHistory.push({ source: turn.source, text: turn.text });
    }
    void persistTranscript(supabase, pending.conversationId, turn).catch((err) => {
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
      supabase,
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
    // Close Deepgram cleanly (sends a CloseStream frame; the
    // accumulated final transcripts in `deepgramTurns` are already
    // captured). Failures here are non-fatal — the session would
    // close anyway when the parent WS closes.
    if (deepgramSession) {
      try {
        deepgramSession.close();
      } catch {
        // best-effort
      }
    }
    // Write the Deepgram transcript to the audit log as its own row
    // when we have one. The post-call summary uses the SAME turn
    // history below, but the raw Deepgram-side transcript is a
    // distinct artifact worth keeping for clinician review.
    if (deepgramTurns.length > 0) {
      void writeDeepgramAuditTranscript(
        pending.conversationId,
        twilioCallSid,
        deepgramTurns,
      );
    }
    // Fire-and-forget post-call summarization. Runs against Claude
    // Sonnet 4.6 when ANTHROPIC_API_KEY is set; otherwise no-op (the
    // helper returns null). A flaky model call must NEVER delay
    // hangup, so the promise is detached and errors only land in the
    // log. Result is persisted to the audit log via a
    // `voice.call.summary` action.
    void runPostCallSummary({
      conversationId: pending.conversationId,
      twilioCallSid,
      practiceName: config.practiceName ?? "PennPaps",
      endReason: info.reason,
      turns: turnHistory,
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
        // Tee the same caller audio into Deepgram when configured.
        // Both consumers see the identical byte stream; the model side
        // still drives the conversation. Decoding here is the cheap
        // base64 → bytes step — no audio transcoding.
        if (deepgramSession) {
          try {
            const audioBytes = Buffer.from(frame.media.payload, "base64");
            deepgramSession.sendAudio(audioBytes);
          } catch {
            // best-effort; a parallel transcription drop must not
            // affect the call itself
          }
        }
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
  supabase: ResupplySupabaseClient,
  conversationId: string,
  turn: TranscriptTurn,
): Promise<void> {
  const direction = turn.source === "input" ? "inbound" : "outbound";
  const sentAt = new Date();
  const sentIso = sentAt.toISOString();
  const { error } = await supabase
    .schema("resupply")
    .from("messages")
    .insert({
      conversation_id: conversationId,
      direction,
      sender_role: turn.source === "input" ? "patient" : "agent",
      body: turn.text,
      sent_at: sentIso,
    });
  if (error) throw error;

  // Refresh latest-message projection (best-effort). Voice transcripts
  // can be long — `tryUpsert` truncates internally, so we don't need
  // to pre-truncate here.
  await tryUpsertPatientLatestMessageSb(supabase, {
    conversationId,
    body: turn.text,
    direction,
    messageAt: sentAt,
  });
}

async function finalizeConversation(
  supabase: ResupplySupabaseClient,
  conversationId: string,
  twilioCallSid: string | null,
  reason: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .schema("resupply")
    .from("conversations")
    .update({ status: "closed", updated_at: nowIso })
    .eq("id", conversationId);
  if (error) throw error;

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

/**
 * Persist the Deepgram-side transcript to the audit log as a single
 * `voice.call.deepgram_transcript` row. We log the FULL transcript
 * (the @workspace/resupply-audit metadata sanitizer enforces size
 * caps; if a long call overflows, the sanitizer truncates rather
 * than rejecting). One row per call is the right granularity — the
 * model's per-turn `messages` rows already give us turn-level detail
 * via the OpenAI transcripts; Deepgram is the audit-grade backup.
 *
 * Always resolves — never throws. A failed audit write here would be
 * a degraded audit trail, not a broken call.
 */
async function writeDeepgramAuditTranscript(
  conversationId: string,
  twilioCallSid: string | null,
  deepgramTurns: ReadonlyArray<string>,
): Promise<void> {
  try {
    const fullTranscript = deepgramTurns.join(" ");
    await logAudit({
      action: "voice.call.deepgram_transcript",
      targetTable: "conversations",
      targetId: conversationId,
      metadata: {
        twilio_call_sid: twilioCallSid ?? null,
        prompt_version: PROMPT_VERSION,
        transcript: fullTranscript,
        turn_count: deepgramTurns.length,
        char_count: fullTranscript.length,
      },
    });
  } catch (err) {
    logger.warn(
      {
        event: "voice_deepgram_audit_failed",
        err: serializeErr(err),
        conversationId,
      },
      "voice: deepgram transcript audit failed",
    );
  }
}

interface RunPostCallSummaryInput {
  conversationId: string;
  twilioCallSid: string | null;
  practiceName: string;
  endReason: string;
  turns: ReadonlyArray<TurnForSummary>;
}

/**
 * Detached post-call summarization. Always resolves — never throws —
 * because it runs after the WS is already closed and there's no
 * caller to surface errors to. Errors land in the application log;
 * a missing summary is preferable to delaying call cleanup.
 *
 * Audit posture: writes ONE row (`voice.call.summary`) per call. The
 * row's metadata carries the parsed JSON. The audit metadata
 * sanitizer (PHI denylist + size cap + depth cap in
 * @workspace/resupply-audit) is the last line of defense against
 * model-volunteered PHI making it into the audit log; we rely on it
 * here instead of duplicating the same redaction in this file.
 */
async function runPostCallSummary(
  input: RunPostCallSummaryInput,
): Promise<void> {
  const client = getAnthropicClient();
  if (!client) {
    // Nothing to do — summary is opt-in on ANTHROPIC_API_KEY.
    return;
  }
  try {
    const summary: PostCallSummary | null = await summarizePostCall({
      client,
      turns: input.turns,
      practiceName: input.practiceName,
      endReason: input.endReason,
      conversationId: input.conversationId,
    });
    if (!summary) return;
    await logAudit({
      action: "voice.call.summary",
      targetTable: "conversations",
      targetId: input.conversationId,
      metadata: {
        twilio_call_sid: input.twilioCallSid ?? null,
        prompt_version: PROMPT_VERSION,
        outcome: summary.outcome,
        sentiment: summary.sentiment,
        concerns_count: summary.concerns.length,
        concerns: summary.concerns,
        follow_ups_count: summary.followUps.length,
        follow_ups: summary.followUps,
        recommends_handoff: summary.recommendsHandoff,
        complete: summary.complete,
      },
    });
    logger.info(
      {
        event: "voice_call_summary_ok",
        conversationId: input.conversationId,
        sentiment: summary.sentiment,
        recommendsHandoff: summary.recommendsHandoff,
      },
      "voice: post-call summary written",
    );
  } catch (err) {
    logger.warn(
      {
        event: "voice_call_summary_failed",
        err: serializeErr(err),
        conversationId: input.conversationId,
      },
      "voice: post-call summary failed",
    );
  }
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}
