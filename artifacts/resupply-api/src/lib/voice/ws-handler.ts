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
  createElevenLabsClient,
  DEFAULT_CONVERSATIONAL_VOICE_SETTINGS,
  DEFAULT_REALTIME_GA_MODEL,
  DEFAULT_REALTIME_GA_TRANSCRIBE_MODEL,
  openElevenLabsStream,
  OPENAI_TOOL_DESCRIPTORS,
  PROMPT_VERSION,
  RealtimeClient,
  PATIENT_TOOL_NAMES,
  SHOP_TOOL_NAMES,
  VoiceBridge,
  type DeepgramLiveSession,
  type ElevenLabsClient,
  type ElevenLabsVoiceSettings,
  type MediaStreamSink,
  type ToolDispatcher,
  type ToolName,
  type TranscriptTurn,
  type TtsStreamer,
  type TtsSynthesizer,
} from "@workspace/resupply-ai";
import {
  encodeClearFrame,
  encodeMediaFrame,
  parseTwilioFrame,
} from "@workspace/resupply-telecom";

import { getAnthropicClient } from "../llm-provider";
import { logger } from "../logger";
import type { PendingSessionEntry } from "./pending-sessions";
import { routeVoiceHandoffToCsrQueue } from "./post-call-handoff";
import {
  summarizePostCall,
  type PostCallSummary,
  type TurnForSummary,
} from "./post-call-summary";
import { createVoiceToolDispatcher } from "./tools-impl";
import { readVoiceConfigOrThrow, type VoiceConfig } from "./voice-config";

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
  // Resolver for the promise this function returns. Called from
  // `finalizeAndClose` so the awaiter completes on EVERY close path
  // (clean session.closed OR a forced cleanup), not just session.closed.
  let resolveClosed: (() => void) | null = null;

  // Accumulate finalized transcript turns from the bridge so the
  // post-call summarizer can see the whole arc of the conversation
  // after hangup. This is in-memory only — it does NOT touch the DB
  // (those rows are persisted independently in persistTranscript).
  // Capped so a stuck call can't grow unbounded.
  const turnHistory: TurnForSummary[] = [];
  const MAX_RETAINED_TURNS = 200;

  // Hard ceiling on call duration — wired AFTER bridge is built (see
  // below). A patient resupply check-in has never historically run
  // beyond ~8 minutes; 15 minutes is well past the long tail. Without
  // this, a wedged bridge (Twilio dropped the hang-up frame, OpenAI
  // Realtime stalled mid-stream, the patient walked away with the
  // line open) burns Realtime + Deepgram + Twilio minutes
  // indefinitely. The cutoff fires a clean close — same path a normal
  // hangup takes — so the post-call summary, Deepgram audit transcript,
  // and conversation finalize all run.
  const MAX_CALL_DURATION_MS = 15 * 60 * 1000;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

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

  const callerKind = pending.callerKind ?? "patient";
  const dispatcher = createVoiceToolDispatcher({
    supabase,
    callerKind,
    conversationId: pending.conversationId,
    ...(pending.patientId ? { patientId: pending.patientId } : {}),
    ...(pending.episodeId ? { episodeId: pending.episodeId } : {}),
    ...(pending.shopCustomerId
      ? { shopCustomerId: pending.shopCustomerId }
      : {}),
  });

  // Optional ElevenLabs voice. When ELEVENLABS_API_KEY is set, ElevenLabs
  // becomes the agent's voice: the Realtime session runs in text-output
  // mode (generateAudio: false) and the bridge produces the audio. Two
  // transports: the streaming WS (default — one connection per turn, text
  // fed as it's generated, lowest latency + best prosody) or the
  // per-sentence HTTP path (the proven fallback). When the key is unset,
  // both stay null and the bridge forwards OpenAI's built-in `cedar`
  // audio (default).
  const ttsStreamer =
    config.elevenLabsApiKey && config.elevenLabsTransport === "ws"
      ? buildElevenLabsStreamer({
          apiKey: config.elevenLabsApiKey,
          voiceId: config.elevenLabsVoiceId,
          modelId: config.elevenLabsModelId,
          voiceSettings: resolveElevenLabsVoiceSettings(config),
        })
      : null;
  const ttsSynthesizer =
    config.elevenLabsApiKey && config.elevenLabsTransport !== "ws"
      ? buildElevenLabsSynthesizer({
          apiKey: config.elevenLabsApiKey,
          voiceId: config.elevenLabsVoiceId,
          modelId: config.elevenLabsModelId,
          voiceSettings: resolveElevenLabsVoiceSettings(config),
          conversationId: pending.conversationId,
        })
      : null;
  const externalVoice = ttsStreamer !== null || ttsSynthesizer !== null;
  if (externalVoice) {
    logger.info(
      {
        event: "voice_elevenlabs_enabled",
        transport: config.elevenLabsTransport,
        conversationId: pending.conversationId,
      },
      "voice: ElevenLabs TTS enabled (Realtime running in text-output mode)",
    );
  }

  // Realtime session schema. Default "beta" (production). When an operator
  // flips OPENAI_REALTIME_SCHEMA=ga on a preview, the resolver fills in
  // coherent GA defaults (gpt-realtime-2 + gpt-realtime-whisper); the µ-law
  // token (audio/pcmu) and reasoning effort ("low") default inside
  // RealtimeClient.
  const realtime = resolveRealtimeClientOptions(config);
  if (config.realtimeSchema === "ga") {
    logger.info(
      {
        event: "voice_realtime_ga_schema",
        model: realtime.model,
        transcribe: realtime.transcriptionModel,
        conversationId: pending.conversationId,
      },
      "voice: OpenAI Realtime GA schema enabled (gpt-realtime-2 spike)",
    );
  }

  const client = new RealtimeClient({
    apiKey: config.openaiApiKey,
    ...realtime,
    // When ElevenLabs owns the voice, the model emits text (not audio)
    // and the bridge synthesises it. Otherwise the model speaks (cedar).
    generateAudio: !externalVoice,
    instructions: buildSystemPrompt({
      practiceName: config.practiceName ?? "PennPaps",
      callerKind,
      // Inbound calls (the reorder IVR) set their own context + greeting
      // on the pending entry so the agent doesn't tell a caller who
      // dialed in that we're calling them. Outbound (place-call) leaves
      // both unset → the default check-in context + DEFAULT_GREETING.
      callContext:
        pending.callContext ??
        "Outbound CPAP resupply check-in. Verify identity by date of birth, " +
          "review supplies due, confirm shipping address, and place the order.",
      ...(pending.greeting ? { greeting: pending.greeting } : {}),
    }),
    tools: OPENAI_TOOL_DESCRIPTORS,
    allowedToolNames: new Set(
      callerKind === "shop_customer" ? SHOP_TOOL_NAMES : PATIENT_TOOL_NAMES,
    ),
  });

  const bridge = new VoiceBridge({
    client,
    sink,
    dispatcher,
    ...(ttsStreamer ? { ttsStreamer } : {}),
    ...(ttsSynthesizer ? { tts: ttsSynthesizer } : {}),
  });

  // Hoisted force-cleanup timer (assignment happens further down in
  // the ws.on("close")/("error") handlers via `scheduleForceCleanup`).
  // We declare it here so the `bridge.on("session.closed")` handler
  // can null it out without a forward-reference warning.
  let forceCleanupTimer: ReturnType<typeof setTimeout> | null = null;

  // Arm the max-duration timer now that `bridge` exists. See declaration
  // above for rationale.
  maxDurationTimer = setTimeout(() => {
    if (closed) return;
    logger.warn(
      {
        event: "voice_max_duration_exceeded",
        conversationId: pending.conversationId,
        max_duration_ms: MAX_CALL_DURATION_MS,
      },
      "voice ws: max call duration reached — closing bridge",
    );
    bridge.close("max-duration-exceeded");
    // Same hung-OpenAI-WS safety net: if `session.closed` doesn't
    // arrive within 5s of bridge.close(), force the FULL teardown via
    // the shared `finalizeAndClose` so the conversation is still
    // finalized and the Deepgram transcript + post-call summary run
    // even when the OpenAI socket is wedged. (`finalizeAndClose` is
    // declared below but only invoked here asynchronously, so the
    // forward reference is safe.)
    setTimeout(() => {
      if (closed) return;
      logger.warn(
        {
          event: "voice_force_cleanup",
          conversationId: pending.conversationId,
          reason: "max-duration-exceeded",
        },
        "voice ws: bridge.close did not produce session.closed in time after max-duration — forcing cleanup",
      );
      finalizeAndClose("max-duration-exceeded", { forced: true });
    }, 5_000).unref?.();
  }, MAX_CALL_DURATION_MS);
  // Don't keep the Node event loop alive for the timer; if the process
  // is shutting down for unrelated reasons we want it to exit cleanly.
  maxDurationTimer.unref?.();

  // Optional Deepgram parallel transcription. When DEEPGRAM_API_KEY
  // is set, we run Nova-3 on the caller-side audio in parallel with
  // the OpenAI Realtime model's built-in STT. The model continues to
  // drive the conversation; Deepgram's higher-accuracy transcript
  // gets aggregated and written to the audit log on hangup for the
  // medical record and the post-call summarizer.
  let deepgramSession: DeepgramLiveSession | null = null;
  const deepgramTurns: string[] = [];
  // Track Deepgram error count + whether we've already WARN'd this
  // call. The first error of the call is loud (we want to know about
  // a vendor outage); subsequent errors during the same call drop to
  // DEBUG so a sustained outage doesn't flood the log with thousands
  // of identical WARN lines. Total count is logged on session close
  // so a Deepgram dropout still leaves a single summary signal.
  let deepgramErrorCount = 0;
  let deepgramWarnEmitted = false;
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
        // Ring buffer: keep the most recent turns. The end of a long
        // call carries more handoff / clinical signal than the open,
        // so dropping oldest-first preserves what the summariser
        // cares about.
        if (deepgramTurns.length >= MAX_RETAINED_TURNS) {
          deepgramTurns.shift();
        }
        deepgramTurns.push(text);
      });
      deepgramSession.onError((err) => {
        deepgramErrorCount += 1;
        if (deepgramWarnEmitted) {
          // De-spam: subsequent errors in the same call are recorded
          // for the close-time summary but don't re-fire the WARN.
          logger.debug(
            {
              event: "voice_deepgram_error_subsequent",
              code: err.code,
              count: deepgramErrorCount,
              conversationId: pending.conversationId,
            },
            "voice deepgram subsequent error (suppressed from WARN)",
          );
          return;
        }
        deepgramWarnEmitted = true;
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

  // Idempotent end-of-call teardown. Runs the SAME side effects whether
  // the OpenAI Realtime WS closed cleanly (`session.closed`) or we had
  // to force a cleanup because that socket wedged at the TCP/TLS layer
  // (max-duration timer / Twilio WS close/error). Before this was
  // extracted, the two force-cleanup paths only closed Deepgram + the
  // Twilio WS and set `closed = true` — so on a hung OpenAI socket the
  // conversation was never finalized, the Deepgram audit transcript (a
  // PHI medical record) was silently lost, and the post-call summary +
  // `recommendsHandoff` CSR routing never ran (a distressed-patient
  // handoff would be dropped). The `closed` guard makes this run exactly
  // once regardless of how many paths fire.
  const finalizeAndClose = (
    reason: string,
    opts: { forced: boolean },
  ): void => {
    if (closed) return;
    closed = true;
    if (maxDurationTimer !== null) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = null;
    }
    if (forceCleanupTimer !== null) {
      clearTimeout(forceCleanupTimer);
      forceCleanupTimer = null;
    }
    logger.info(
      {
        event: "voice_session_closed",
        reason,
        forced: opts.forced,
        conversationId: pending.conversationId,
      },
      "voice session closed",
    );
    void finalizeConversation(
      supabase,
      pending.conversationId,
      twilioCallSid,
      reason,
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
    // Close Deepgram cleanly (sends a CloseStream frame; the accumulated
    // final transcripts in `deepgramTurns` are already captured).
    if (deepgramSession) {
      try {
        deepgramSession.close();
      } catch {
        // best-effort
      }
      if (deepgramErrorCount > 0) {
        logger.warn(
          {
            event: "voice_deepgram_errors_summary",
            count: deepgramErrorCount,
            conversationId: pending.conversationId,
          },
          "voice deepgram: parallel transcription error count for this call",
        );
      }
    }
    // Write the Deepgram-side transcript to the audit log as its own row
    // when we have one — a distinct clinician-review artifact.
    if (deepgramTurns.length > 0) {
      void writeDeepgramAuditTranscript(
        pending.conversationId,
        twilioCallSid,
        deepgramTurns,
      );
    }
    // Fire-and-forget post-call summarization (Claude Sonnet 4.6 when
    // ANTHROPIC_API_KEY is set; otherwise a no-op). A flaky model call
    // must NEVER delay hangup, so the promise is detached.
    void runPostCallSummary({
      conversationId: pending.conversationId,
      twilioCallSid,
      practiceName: config.practiceName ?? "PennPaps",
      endReason: reason,
      turns: turnHistory,
    });
    try {
      ws.close(
        opts.forced ? 1011 : 1000,
        opts.forced ? "force-cleanup" : "session-closed",
      );
    } catch {
      /* already closed */
    }
    if (resolveClosed) {
      const resolve = resolveClosed;
      resolveClosed = null;
      resolve();
    }
  };

  bridge.on("session.opened", () => {
    logger.info(
      { event: "voice_session_opened", conversationId: pending.conversationId },
      "voice session opened",
    );
  });

  bridge.on("transcript.turn", (turn) => {
    // Ring buffer: keep the most recent turns. The end of a long
    // call carries more handoff / clinical signal than the open,
    // so dropping oldest-first preserves what the summariser
    // cares about.
    if (turnHistory.length >= MAX_RETAINED_TURNS) {
      turnHistory.shift();
    }
    turnHistory.push({ source: turn.source, text: turn.text });
    void persistTranscript(supabase, pending.conversationId, turn).catch(
      (err) => {
        logger.error(
          {
            event: "voice_transcript_persist_failed",
            err: serializeErr(err),
            conversationId: pending.conversationId,
          },
          "voice transcript persist failed",
        );
      },
    );
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
    // Clean close from the OpenAI Realtime side. Run the shared,
    // idempotent teardown (finalize + Deepgram transcript + post-call
    // summary + Twilio WS close). `forced: false` ⇒ a normal 1000 close.
    finalizeAndClose(info.reason, { forced: false });
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

  // Force-cleanup safety net: bridge.close() asks the OpenAI WS to
  // close, but if that socket is hung at the TCP/TLS layer the
  // `session.closed` event never fires and the chain that clears
  // maxDurationTimer / closes Deepgram / runs finalize / kills the
  // Twilio WS would leak. Schedule a hard cleanup after
  // FORCE_CLEANUP_MS and let bridge.close() handlers race it — if
  // they win and emit `session.closed`, `closed` is set to true and
  // this fallback no-ops.
  const FORCE_CLEANUP_MS = 5_000;
  const scheduleForceCleanup = (reason: string): void => {
    if (forceCleanupTimer !== null || closed) return;
    forceCleanupTimer = setTimeout(() => {
      if (closed) return;
      logger.warn(
        {
          event: "voice_force_cleanup",
          conversationId: pending.conversationId,
          reason,
        },
        "voice ws: bridge.close did not produce session.closed in time — forcing cleanup",
      );
      // Run the FULL shared teardown (not just a socket close) so a
      // wedged OpenAI WS still finalizes the conversation and persists
      // the Deepgram transcript + post-call summary.
      finalizeAndClose(reason, { forced: true });
    }, FORCE_CLEANUP_MS);
    forceCleanupTimer.unref?.();
  };

  ws.on("close", () => {
    bridge.close("twilio-ws-closed");
    scheduleForceCleanup("twilio-ws-closed");
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
    scheduleForceCleanup("twilio-ws-error");
  });

  // Resolve once the call has fully torn down via ANY path —
  // `session.closed` OR a forced cleanup (`finalizeAndClose` invokes
  // `resolveClosed`). The previous version resolved only on
  // `bridge.once("session.closed")`, which never fires when the OpenAI
  // WS is wedged, so the returned promise leaked on every force-cleanup
  // path. The integration test awaits this; production callers ignore.
  await new Promise<void>((resolve) => {
    resolveClosed = resolve;
    // Defensive: if teardown somehow already completed before we wired
    // the resolver (handlers fire async after this point, so this is
    // not expected), resolve immediately to avoid hanging.
    if (closed) resolve();
  });
}

/**
 * Map the voice config's realtime knobs to RealtimeClient options, applying
 * coherent GA defaults (gpt-realtime-2 + gpt-realtime-whisper) when the
 * schema is "ga". Shared by the production and diagnostic handlers so a
 * diagnostic call exercises the exact Realtime config production runs.
 * Undefined fields fall through to RealtimeClient's own defaults.
 */
function resolveRealtimeClientOptions(config: VoiceConfig): {
  sessionSchema: "beta" | "ga";
  model: string | undefined;
  transcriptionModel: string | undefined;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | undefined;
  audioFormat: string | undefined;
} {
  const isGa = config.realtimeSchema === "ga";
  return {
    sessionSchema: config.realtimeSchema,
    model:
      config.realtimeModel ?? (isGa ? DEFAULT_REALTIME_GA_MODEL : undefined),
    transcriptionModel:
      config.realtimeTranscribeModel ??
      (isGa ? DEFAULT_REALTIME_GA_TRANSCRIBE_MODEL : undefined),
    reasoningEffort: config.realtimeReasoningEffort,
    audioFormat: config.realtimeAudioFormat,
  };
}

/**
 * Isolated diagnostic bridge — a no-patient "connection test" for the AI
 * voice path. Opens the SAME RealtimeClient + VoiceBridge production uses
 * (so it validates the live Realtime config, e.g. the gpt-realtime-2 GA
 * spike) but with NO patient, NO tools, and NO DB / Deepgram / summary
 * work. Reached only via the env-gated `/voice/realtime-diagnostic` route,
 * which flags the pending session `diagnostic: true`; the WS upgrade
 * handler routes those here instead of {@link handleVoiceWsConnection}.
 *
 * Kept deliberately separate from the production handler so a test
 * affordance can never regress the real PHI voice path.
 */
export async function handleVoiceDiagnosticWsConnection(
  ws: WebSocket,
  pending: PendingSessionEntry,
): Promise<void> {
  const config = readVoiceConfigOrThrow();
  let streamSid: string | null = null;
  let closed = false;
  let resolveClosed: (() => void) | null = null;
  // Diagnostic calls are short; cap hard so a wedged test can't burn
  // Realtime minutes.
  const MAX_DIAGNOSTIC_MS = 5 * 60 * 1000;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;

  const sink: MediaStreamSink = {
    writeAudioBase64(b64: string): void {
      if (closed || !streamSid) return;
      try {
        ws.send(encodeMediaFrame(streamSid, b64));
      } catch (err) {
        logger.warn(
          { event: "voice_diag_ws_send_failed", err: serializeErr(err) },
          "voice diagnostic: ws send failed",
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

  // Diagnostic mode exposes no tools, so the dispatcher is never invoked;
  // it exists only to satisfy the bridge contract.
  const dispatcher: ToolDispatcher = {
    dispatch: () =>
      Promise.reject(new Error("tools are disabled in diagnostic mode")),
  };

  const realtime = resolveRealtimeClientOptions(config);
  const client = new RealtimeClient({
    apiKey: config.openaiApiKey,
    ...realtime,
    // The model produces the audio (cedar / gpt-realtime-2) so the
    // diagnostic exercises µ-law OUTPUT, not just the input side.
    generateAudio: true,
    instructions: buildSystemPrompt({
      practiceName: config.practiceName ?? "PennPaps",
      callContext: pending.callContext ?? "Voice connection diagnostic.",
      ...(pending.greeting ? { greeting: pending.greeting } : {}),
      // Honor the caller kind so an admin test call can hear the
      // shop-customer persona as well as the patient one. Tools stay
      // disabled either way (diagnostic mode), so the agent exercises
      // tone / greeting / scope / handoff without touching real data.
      ...(pending.callerKind ? { callerKind: pending.callerKind } : {}),
    }),
    // No tools — the agent just converses to confirm two-way audio.
    tools: [],
    allowedToolNames: new Set<ToolName>(),
  });

  const bridge = new VoiceBridge({ client, sink, dispatcher });

  logger.info(
    {
      event: "voice_realtime_diagnostic_opened",
      schema: config.realtimeSchema,
      model: realtime.model,
      conversationId: pending.conversationId,
    },
    "voice diagnostic: Realtime bridge opening",
  );

  const cleanup = (reason: string): void => {
    if (closed) return;
    closed = true;
    if (maxTimer !== null) {
      clearTimeout(maxTimer);
      maxTimer = null;
    }
    logger.info(
      { event: "voice_realtime_diagnostic_closed", reason },
      "voice diagnostic: closed",
    );
    bridge.close(reason);
    try {
      ws.close(1000, "diagnostic-closed");
    } catch {
      // already closed
    }
    if (resolveClosed) {
      const resolve = resolveClosed;
      resolveClosed = null;
      resolve();
    }
  };

  bridge.on("session.opened", () =>
    logger.info(
      { event: "voice_session_opened", conversationId: pending.conversationId },
      "voice diagnostic: session opened",
    ),
  );
  // Surface OpenAI session rejections (bad audio format, unknown field) as
  // the SAME `voice_session_error` event the validator watches for.
  bridge.on("session.error", (err) =>
    logger.warn(
      {
        event: "voice_session_error",
        err,
        conversationId: pending.conversationId,
      },
      "voice diagnostic: session error",
    ),
  );
  bridge.on("session.closed", (info) =>
    cleanup(info.reason || "session-closed"),
  );

  maxTimer = setTimeout(
    () => cleanup("max-duration-exceeded"),
    MAX_DIAGNOSTIC_MS,
  );
  maxTimer.unref?.();

  ws.on("message", (raw) => {
    const frame = parseTwilioFrame(raw as Buffer | string);
    if (!frame) return;
    switch (frame.event) {
      case "start":
        streamSid = frame.start.streamSid;
        return;
      case "media":
        bridge.forwardCallerAudio(frame.media.payload);
        return;
      case "stop":
        cleanup("twilio-stop");
        return;
      default:
        return;
    }
  });
  ws.on("close", () => cleanup("twilio-ws-closed"));
  ws.on("error", (err) => {
    logger.warn(
      { event: "voice_diag_ws_error", err: serializeErr(err) },
      "voice diagnostic: ws error",
    );
    cleanup("twilio-ws-error");
  });

  await new Promise<void>((resolve) => {
    resolveClosed = resolve;
    if (closed) resolve();
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
 * Persist the Deepgram-side transcript so we keep an audit-grade
 * backup to the OpenAI Realtime per-turn messages.
 *
 * PHI handling: the raw transcript carries patient utterances —
 * name, DOB, address, complaints — exactly the high-PHI surface
 * the audit log isn't supposed to hold. So we split the write into
 * two pieces:
 *
 *   1. The raw transcript bytes go into the `messages` table (which
 *      is RLS-scoped + encrypted at rest), as a single row tagged
 *      sender_role='deepgram_transcript'. That row holds the PHI.
 *   2. The audit-log row carries only structural metadata: turn
 *      count, char count, and the message id. The HMAC-chained
 *      audit row stays world-readable safe; investigators can join
 *      back to messages by id under RLS.
 *
 * Always resolves — never throws. A failed write here is a degraded
 * audit trail, not a broken call.
 */
async function writeDeepgramAuditTranscript(
  conversationId: string,
  twilioCallSid: string | null,
  deepgramTurns: ReadonlyArray<string>,
): Promise<void> {
  const fullTranscript = deepgramTurns.join(" ");
  let transcriptMessageId: string | null = null;
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data: inserted, error } = await supabase
      .schema("resupply")
      .from("messages")
      .insert({
        conversation_id: conversationId,
        direction: "inbound",
        sender_role: "deepgram_transcript",
        body: fullTranscript,
        vendor_metadata: {
          twilio_call_sid: twilioCallSid ?? null,
          prompt_version: PROMPT_VERSION,
          turn_count: deepgramTurns.length,
        },
      })
      .select("id")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    transcriptMessageId = inserted?.id ?? null;
  } catch (err) {
    logger.warn(
      {
        event: "voice_deepgram_message_insert_failed",
        err: serializeErr(err),
        conversationId,
      },
      "voice: deepgram transcript message insert failed",
    );
  }
  try {
    await logAudit({
      action: "voice.call.deepgram_transcript",
      targetTable: "conversations",
      targetId: conversationId,
      metadata: {
        twilio_call_sid: twilioCallSid ?? null,
        prompt_version: PROMPT_VERSION,
        transcript_message_id: transcriptMessageId,
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

    // Route the conversation into the CSR escalated-queue when the
    // model flagged a handoff. The audit row above is the durable
    // record; this is the routing — without it the flag sits in
    // the audit log and no supervisor sees it in time.
    if (summary.recommendsHandoff) {
      await routeVoiceHandoffToCsrQueue({
        conversationId: input.conversationId,
        outcome: summary.outcome,
        sentiment: summary.sentiment,
      });
    }
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

// 20ms of µ-law @ 8kHz = 160 bytes — Twilio Media Streams' native frame
// size. ElevenLabs streams `ulaw_8000` in arbitrary chunk boundaries, so
// we re-frame to 160 bytes for clean playback pacing (Twilio buffers and
// plays out at 8kHz regardless, but uniform frames avoid edge-case
// stutter on some carriers).
const MULAW_FRAME_BYTES = 160;

/**
 * Adapt the ElevenLabs streaming-TTS client to the bridge's
 * `TtsSynthesizer` contract: stream `ulaw_8000` audio, re-frame the
 * bytes into 160-byte µ-law frames, and hand each to the bridge as
 * base64 (the format the Twilio sink forwards). Honors the bridge's
 * abort signal for barge-in. A vendor error throws so the bridge logs a
 * `tts` session error and drops that utterance's audio without ending
 * the call.
 *
 * PHI: the synthesised text IS patient-facing speech (PHI). We never log
 * the text or the audio bytes — only structural counts on failure.
 */
function buildElevenLabsSynthesizer(opts: {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  voiceSettings: ElevenLabsVoiceSettings;
  conversationId: string;
}): TtsSynthesizer {
  const { voiceSettings } = opts;
  let client: ElevenLabsClient;
  try {
    client = createElevenLabsClient({ apiKey: opts.apiKey });
  } catch (err) {
    // Should not happen (apiKey is non-empty here), but never let a
    // client-construction throw escape into the WS setup path.
    logger.warn(
      {
        event: "voice_elevenlabs_init_failed",
        err: serializeErr(err),
        conversationId: opts.conversationId,
      },
      "voice: ElevenLabs client init failed",
    );
    throw err;
  }

  return {
    async synthesize(text, onFrame, signal): Promise<void> {
      let carry = Buffer.alloc(0);
      const result = await client.streamTextToSpeech(
        {
          text,
          ...(opts.voiceId ? { voiceId: opts.voiceId } : {}),
          ...(opts.modelId ? { modelId: opts.modelId } : {}),
          voiceSettings,
          outputFormat: "ulaw_8000",
          signal,
        },
        (chunk) => {
          if (signal.aborted) return;
          carry =
            carry.length === 0
              ? Buffer.from(chunk)
              : Buffer.concat([carry, Buffer.from(chunk)]);
          let offset = 0;
          while (carry.length - offset >= MULAW_FRAME_BYTES) {
            onFrame(
              carry
                .subarray(offset, offset + MULAW_FRAME_BYTES)
                .toString("base64"),
            );
            offset += MULAW_FRAME_BYTES;
          }
          carry = carry.subarray(offset);
        },
      );
      // Flush any trailing partial frame (Twilio tolerates a short final
      // frame). Skip if we were barged-in mid-utterance.
      if (!signal.aborted && carry.length > 0) {
        onFrame(carry.toString("base64"));
      }
      if (!result.ok && !signal.aborted) {
        throw new Error(
          `elevenlabs ${result.errorCode}: ${result.errorMessage}`,
        );
      }
    },
  };
}

/**
 * Merge the tuned conversational voice settings with any operator env
 * overrides (stability / speed). Shared by both the streaming and
 * per-sentence ElevenLabs transports so they sound identical.
 */
function resolveElevenLabsVoiceSettings(
  config: VoiceConfig,
): ElevenLabsVoiceSettings {
  return {
    ...DEFAULT_CONVERSATIONAL_VOICE_SETTINGS,
    ...(config.elevenLabsStability !== undefined
      ? { stability: config.elevenLabsStability }
      : {}),
    ...(config.elevenLabsSpeed !== undefined
      ? { speed: config.elevenLabsSpeed }
      : {}),
  };
}

/**
 * Adapt the ElevenLabs stream-input WebSocket to the bridge's
 * `TtsStreamer` contract. One session per agent turn: the bridge feeds
 * text in as the model generates it and we stream `ulaw_8000` audio back,
 * re-framed into 160-byte µ-law frames (same as the HTTP path) so Twilio
 * plays it cleanly. A vendor/transport error surfaces via `onError` (the
 * bridge logs a `tts` session error and drops the turn's audio without
 * ending the call).
 *
 * PHI: the synthesised text IS patient-facing speech. We never log the
 * text or the audio bytes — only structural error info on failure.
 */
function buildElevenLabsStreamer(opts: {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  voiceSettings: ElevenLabsVoiceSettings;
}): TtsStreamer {
  return {
    openSession(handlers) {
      // Per-session re-framing buffer: ElevenLabs returns ulaw_8000 in
      // arbitrary chunk sizes; we hand Twilio uniform 160-byte frames.
      let carry = Buffer.alloc(0);
      const session = openElevenLabsStream(
        {
          apiKey: opts.apiKey,
          ...(opts.voiceId ? { voiceId: opts.voiceId } : {}),
          ...(opts.modelId ? { modelId: opts.modelId } : {}),
          voiceSettings: opts.voiceSettings,
          outputFormat: "ulaw_8000",
        },
        {
          onAudioBase64: (audioBase64) => {
            const bytes = Buffer.from(audioBase64, "base64");
            carry = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
            let offset = 0;
            while (carry.length - offset >= MULAW_FRAME_BYTES) {
              handlers.onFrame(
                carry
                  .subarray(offset, offset + MULAW_FRAME_BYTES)
                  .toString("base64"),
              );
              offset += MULAW_FRAME_BYTES;
            }
            carry = carry.subarray(offset);
          },
          onError: (err) =>
            handlers.onError(new Error(`${err.code}: ${err.message}`)),
          onClosed: () => {
            // Flush the trailing partial frame at end-of-turn (Twilio
            // tolerates a short final frame).
            if (carry.length > 0) {
              handlers.onFrame(carry.toString("base64"));
              carry = Buffer.alloc(0);
            }
            handlers.onDone?.();
          },
        },
      );
      return session;
    },
  };
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}
