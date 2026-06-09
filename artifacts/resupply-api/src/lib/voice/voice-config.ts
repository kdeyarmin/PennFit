// Voice config — single source of truth for "is the voice path
// turned on?".
//
// We deliberately do NOT throw when env vars are missing. This module
// is imported at boot regardless of feature-flag state, and we want
// the API to come up cleanly even when voice is disabled (most
// non-voice admins will deploy without these secrets). The "off"
// path is a clean 503 from the route handler, not a crash.
//
// Why one helper, not three env reads scattered across routes:
//   - The same predicate ("are all four required env vars set?") gates
//     /voice/place-call AND /voice/twiml-connect AND /voice/status-callback
//     AND the WS upgrade. Replicating the read in four places is
//     exactly the kind of drift that lets one route forget to check.
//   - We want a single line in the readiness output to say "voice is
//     configured". Centralising the read makes that one line trivially
//     correct.
//
// Why we don't enforce HTTPS on `publicBaseUrl` here:
//   In dev we may run against an https tunnel (Railway preview, ngrok,
//   etc.) but the Twilio sandbox accepts http for local testing too.
//   The signature middleware will reject mismatched URLs regardless,
//   so an http/https typo fails CLOSED downstream.

export interface VoiceConfig {
  openaiApiKey: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  /**
   * E.164 number we dial OUT FROM (the outbound caller-ID). Required
   * only for outbound `/voice/place-call`; inbound calls work without
   * it. Inbound IS implemented — `routes/voice/inbound-reorder.ts`
   * reverse-looks-up the caller against the plaintext
   * `patients.phone_e164` column (migration 0025 removed the phone
   * encryption that originally blocked this; see ADR 008's update note).
   */
  twilioPhoneNumber?: string;
  /**
   * Public origin Twilio uses to call back into us. Trailing slash
   * stripped. e.g. "https://pennfit.up.railway.app". Falls back to
   * `https://${RAILWAY_PUBLIC_DOMAIN}` when the explicit env var is unset.
   */
  publicBaseUrl: string;
  /**
   * Optional override for the practice name baked into the system
   * prompt. Defaults inside the route handler so a single env var
   * controls branding for every outbound call.
   */
  practiceName?: string;
  /**
   * Optional Deepgram API key. When set, the WS handler opens a
   * parallel Deepgram Nova-3 transcription session on the caller-
   * side audio and writes the resulting transcript to the audit log
   * after hangup. Higher accuracy than gpt-4o-mini-transcribe on
   * phone audio, especially for elderly speakers and medical
   * vocabulary. Independent of the conversational STT — when this
   * is set, the model still uses its built-in transcription for
   * turn-taking; Deepgram's transcript is used for the audit record
   * and the post-call summarizer.
   */
  deepgramApiKey?: string;
  /**
   * Optional ElevenLabs API key. When set, ElevenLabs becomes the
   * agent's voice: the Realtime session runs in text-output mode and
   * each agent turn is synthesised through ElevenLabs (µ-law @ 8kHz)
   * before being streamed to Twilio. When UNSET, the voice agent falls
   * back to OpenAI's built-in `cedar` voice (the historical default).
   *
   * PHI note: agent speech IS patient-facing PHI by definition.
   */
  elevenLabsApiKey?: string;
  /** Optional ElevenLabs voice id override (defaults to the client's). */
  elevenLabsVoiceId?: string;
  /** Optional ElevenLabs model id override (defaults to the client's). */
  elevenLabsModelId?: string;
  /**
   * Optional ElevenLabs stability override (0..1). Lower = more
   * expressive prosody variation; higher = more consistent/flat. When
   * unset, the bridge uses the tuned conversational default (0.45).
   * Clamped into range so a fat-fingered value can't push the voice into
   * an unstable register mid-call.
   */
  elevenLabsStability?: number;
  /**
   * Optional ElevenLabs speaking-rate override (0.7..1.2, 1.0 = natural).
   * Nudge to ~0.95 for an older patient base. When unset, the bridge uses
   * the tuned conversational default (1.0). Clamped into range.
   */
  elevenLabsSpeed?: number;
  /**
   * ElevenLabs TTS transport. `"ws"` (default) uses the stream-input
   * WebSocket — one connection per agent turn, text fed as the model
   * generates it, lowest latency + best cross-sentence prosody. `"http"`
   * uses the per-sentence streaming REST endpoint (the proven fallback).
   * Any value other than `"http"` resolves to `"ws"`.
   */
  elevenLabsTransport: "ws" | "http";
  /**
   * OpenAI Realtime session schema. `"beta"` (default, production) runs the
   * proven `realtime=v1` flat schema on gpt-realtime. `"ga"` is the
   * gpt-realtime-2 spike on OpenAI's GA nested session shape — setting it
   * also switches the model to gpt-realtime-2 and the input STT to
   * gpt-realtime-whisper unless overridden below. Validate on a preview
   * with a real test call before production
   * (docs/runbooks/realtime-ga-migration.md).
   */
  realtimeSchema: "beta" | "ga";
  /** Realtime model override (e.g. pin a snapshot). */
  realtimeModel?: string;
  /** Realtime reasoning effort, GA only (default "low" in the client). */
  realtimeReasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Realtime input-transcription model override. */
  realtimeTranscribeModel?: string;
  /** Realtime wire audio-format token override (GA µ-law correction). */
  realtimeAudioFormat?: string;
  /**
   * When true, the `/voice/realtime-diagnostic` route is live — a no-patient
   * "connection test" that opens the Realtime bridge so an operator can dial
   * in and validate the voice path (e.g. the gpt-realtime-2 GA spike)
   * without a patient record. OFF by default; a real Realtime session costs
   * money, so this faucet must be explicitly opened (and is intended for
   * previews, not production). Env: OPENAI_REALTIME_DIAGNOSTIC_ENABLED.
   */
  realtimeDiagnosticEnabled: boolean;
}

/**
 * Returns the voice config when ALL four required values are set, else
 * null. The "either fully configured or fully off" gate is deliberate:
 * a partially-configured voice path is much worse than a clean 503,
 * because it lets you discover the missing secret at the worst possible
 * moment (mid-call to a real patient).
 */
/**
 * Twilio webhook signature middleware needs the auth token but NOT
 * the full voice config — inbound TwiML, status callbacks, and
 * check-in webhooks should work even when OPENAI_API_KEY is unset
 * (e.g. an inbound-only deployment). Returning the auth token
 * independently avoids the foot-gun where every Twilio-signed
 * webhook 403s because OPENAI_API_KEY happens to be missing.
 */
export function readTwilioWebhookAuthTokenOrNull(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const v = env.TWILIO_AUTH_TOKEN;
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Public base URL used to reconstruct the URL Twilio signed when
 * verifying inbound webhook signatures. Returns null when neither
 * RESUPPLY_VOICE_PUBLIC_BASE_URL nor RAILWAY_PUBLIC_DOMAIN is set.
 *
 * Decoupled from `readVoiceConfigOrNull()` so signature verification
 * still works when OPENAI_API_KEY is missing — the URL Twilio
 * signed is independent of whether outbound voice is configured.
 */
export function readVoicePublicBaseUrlOrNull(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.RESUPPLY_VOICE_PUBLIC_BASE_URL?.trim();
  if (explicit) return stripTrailingSlash(explicit);
  const railway = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) return stripTrailingSlash(`https://${railway}`);
  return null;
}

export function readVoiceConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): VoiceConfig | null {
  const openaiApiKey = env.OPENAI_API_KEY;
  const twilioAccountSid = env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = env.TWILIO_AUTH_TOKEN;
  if (!openaiApiKey || !twilioAccountSid || !twilioAuthToken) return null;

  const publicBaseUrl = stripTrailingSlash(
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
      (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : ""),
  );
  if (!publicBaseUrl) return null;

  return {
    openaiApiKey,
    twilioAccountSid,
    twilioAuthToken,
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER,
    publicBaseUrl,
    practiceName: env.RESUPPLY_PRACTICE_NAME,
    deepgramApiKey: env.DEEPGRAM_API_KEY,
    elevenLabsApiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID?.trim() || undefined,
    elevenLabsModelId: env.ELEVENLABS_MODEL_ID?.trim() || undefined,
    elevenLabsStability: readBoundedFloatEnv(env.ELEVENLABS_STABILITY, 0, 1),
    elevenLabsSpeed: readBoundedFloatEnv(env.ELEVENLABS_SPEED, 0.7, 1.2),
    // Default to the streaming WS path; opt back to HTTP only on explicit
    // `http`. Case/space-insensitive so "HTTP" / " http " still match.
    elevenLabsTransport:
      env.ELEVENLABS_TTS_TRANSPORT?.trim().toLowerCase() === "http"
        ? "http"
        : "ws",
    // Realtime stays on the proven beta schema unless explicitly set to
    // `ga` (the gpt-realtime-2 spike). The ws-handler fills in coherent GA
    // model/STT defaults when the schema is `ga`.
    realtimeSchema:
      env.OPENAI_REALTIME_SCHEMA?.trim().toLowerCase() === "ga" ? "ga" : "beta",
    realtimeModel: env.OPENAI_REALTIME_MODEL?.trim() || undefined,
    realtimeReasoningEffort: parseReasoningEffort(
      env.OPENAI_REALTIME_REASONING_EFFORT,
    ),
    realtimeTranscribeModel:
      env.OPENAI_REALTIME_TRANSCRIBE_MODEL?.trim() || undefined,
    realtimeAudioFormat: env.OPENAI_REALTIME_AUDIO_FORMAT?.trim() || undefined,
    realtimeDiagnosticEnabled: isTruthyEnv(
      env.OPENAI_REALTIME_DIAGNOSTIC_ENABLED,
    ),
  };
}

/** True for "1", "true", "yes", "on" (case/space-insensitive); else false. */
function isTruthyEnv(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Parse the optional realtime reasoning-effort env var. Returns undefined
 * (client default applies) when unset or not one of the allowed values, so
 * a typo degrades to the default rather than sending an invalid value.
 */
function parseReasoningEffort(
  raw: string | undefined,
): "minimal" | "low" | "medium" | "high" | undefined {
  const v = raw?.trim().toLowerCase();
  return v === "minimal" || v === "low" || v === "medium" || v === "high"
    ? v
    : undefined;
}

/**
 * Parse a bounded float env var. Returns undefined when unset, blank, or
 * unparseable (the caller falls back to the tuned default), and clamps a
 * valid number into [min, max] so an out-of-range value degrades to the
 * nearest sane bound instead of handing ElevenLabs something it rejects
 * mid-call.
 */
function readBoundedFloatEnv(
  raw: string | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * Same as `readVoiceConfigOrNull` but throws — for code paths (the WS
 * upgrade) that have already passed the readiness gate.
 */
export function readVoiceConfigOrThrow(
  env: NodeJS.ProcessEnv = process.env,
): VoiceConfig {
  const cfg = readVoiceConfigOrNull(env);
  if (!cfg) {
    throw new Error(
      "Voice configuration is incomplete. Required env vars: " +
        "OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and " +
        "RESUPPLY_VOICE_PUBLIC_BASE_URL (or RAILWAY_PUBLIC_DOMAIN as a " +
        "fallback when running on Railway).",
    );
  }
  return cfg;
}

/**
 * Translate the public base URL into the wss:// origin Twilio uses for
 * the Media Stream WebSocket. Idempotent. Throws on a non-http(s)
 * scheme so we can't accidentally hand Twilio a `gopher://` URL.
 */
export function publicWsOriginFromBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else {
    throw new Error(`Unsupported scheme for voice base URL: ${url.protocol}`);
  }
  // URL leaves the trailing slash on origin-only URLs; strip it so
  // callers can do `${origin}/path` without doubling.
  return stripTrailingSlash(url.toString());
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
