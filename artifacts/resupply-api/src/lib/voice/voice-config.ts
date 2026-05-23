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
//   In dev we use the Replit dev domain (which IS https) but the
//   Twilio sandbox accepts http for local testing too. The signature
//   middleware will reject mismatched URLs regardless, so an http/https
//   typo fails CLOSED downstream.

export interface VoiceConfig {
  openaiApiKey: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  /**
   * E.164 number we dial OUT FROM. Required to place outbound calls.
   * If you only handle inbound (a future phase), this is optional —
   * but inbound is deferred per ADR 004 because the encrypted phone
   * column blocks reverse lookup.
   */
  twilioPhoneNumber?: string;
  /**
   * Public origin Twilio uses to call back into us. Trailing slash
   * stripped. e.g. "https://my-repl.replit.app". Falls back to
   * `https://${REPLIT_DEV_DOMAIN}` in dev.
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
}

/**
 * Returns the voice config when ALL four required values are set, else
 * null. The "either fully configured or fully off" gate is deliberate:
 * a partially-configured voice path is much worse than a clean 503,
 * because it lets you discover the missing secret at the worst possible
 * moment (mid-call to a real patient).
 */
export function readVoiceConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): VoiceConfig | null {
  const openaiApiKey = env.OPENAI_API_KEY;
  const twilioAccountSid = env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = env.TWILIO_AUTH_TOKEN;
  if (!openaiApiKey || !twilioAccountSid || !twilioAuthToken) return null;

  const publicBaseUrl = stripTrailingSlash(
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
      (env.REPLIT_DEV_DOMAIN ? `https://${env.REPLIT_DEV_DOMAIN}` : ""),
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
  };
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
        "RESUPPLY_VOICE_PUBLIC_BASE_URL (or REPLIT_DEV_DOMAIN in dev).",
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
