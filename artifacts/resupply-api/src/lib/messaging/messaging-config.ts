// Messaging config — single source of truth for "is the SMS+Email path
// turned on?". Mirrors voice-config.ts: env reads happen at call time
// (not module load), and the route handler returns a clean 503 with a
// stable error code when any required value is missing.
//
// Why "all-or-nothing":
//   The two channels share the same set of pre-conditions in this v1
//   (HMAC keys for phone hashing + link signing). A partially configured
//   path is operationally worse than a clean off — it lets a half-broken
//   deploy answer real Twilio webhooks with confusing 5xx noise. We turn
//   the whole feature off at the route layer until every required env
//   var is present, and surface a single readiness line ("messaging
//   configured") downstream.
//
// SMS-only and email-only sub-feature flags:
//   We expose `readSmsConfigOrNull()` and `readEmailConfigOrNull()`
//   separately so an admin can ship SMS without SendGrid (or vice
//   versa). The aggregate `readMessagingConfigOrNull()` is true only
//   when both are configured AND the two cross-cutting HMAC keys
//   (phone, link) are set.

import {
  hasLinkHmacKey,
  hasPhoneHmacKey,
} from "@workspace/resupply-secrets";

export interface SmsConfig {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber?: string;
  twilioMessagingServiceSid?: string;
  /**
   * Public origin Twilio uses to call back into us. Mirrors voice
   * config — we reuse the voice base URL when set, falling back to
   * REPLIT_DEV_DOMAIN in dev.
   */
  publicBaseUrl: string;
}

export interface EmailConfig {
  sendgridApiKey: string;
  sendgridFromEmail: string;
  sendgridFromName: string;
  /** Required for inbound SendGrid event webhook signature validation. */
  sendgridEventWebhookPublicKey: string;
  /**
   * Public origin used to build click-through links. Reuses the same
   * value as the SMS public base URL — there is only one Replit
   * deployment surface.
   */
  publicBaseUrl: string;
}

export interface MessagingConfig {
  sms: SmsConfig;
  email: EmailConfig;
  /**
   * Whether the phone-number-lookup HMAC key is sourceable (either
   * the legacy `RESUPPLY_PHONE_HMAC_KEY` env var or a derivation from
   * `RESUPPLY_MASTER_KEY` is available). Informational only; the hash
   * routine in `@workspace/resupply-db` re-reads at call time so
   * secret rotation doesn't require a process restart.
   */
  hasPhoneHmacKey: boolean;
  hasLinkHmacKey: boolean;
  /**
   * Practice name baked into outbound SMS + email templates. Falls
   * back to "PennPaps" when unset so dev surfaces something
   * presentable; production should always set this.
   */
  practiceName: string;
}

const DEFAULT_PRACTICE_NAME = "PennPaps";

export function readSmsConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): SmsConfig | null {
  const twilioAccountSid = env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = env.TWILIO_AUTH_TOKEN;
  if (!twilioAccountSid || !twilioAuthToken) return null;

  const twilioPhoneNumber = env.TWILIO_PHONE_NUMBER;
  const twilioMessagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID;
  // Twilio Messaging API requires at least one routing identity.
  if (!twilioPhoneNumber && !twilioMessagingServiceSid) return null;

  const publicBaseUrl = stripTrailingSlash(
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
      (env.REPLIT_DEV_DOMAIN ? `https://${env.REPLIT_DEV_DOMAIN}` : ""),
  );
  if (!publicBaseUrl) return null;

  return {
    twilioAccountSid,
    twilioAuthToken,
    twilioPhoneNumber,
    twilioMessagingServiceSid,
    publicBaseUrl,
  };
}

export function readEmailConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): EmailConfig | null {
  const sendgridApiKey = env.SENDGRID_API_KEY;
  const sendgridFromEmail = env.SENDGRID_FROM_EMAIL;
  const sendgridFromName = env.SENDGRID_FROM_NAME;
  const sendgridEventWebhookPublicKey = env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  if (
    !sendgridApiKey ||
    !sendgridFromEmail ||
    !sendgridFromName ||
    !sendgridEventWebhookPublicKey
  ) {
    return null;
  }

  const publicBaseUrl = stripTrailingSlash(
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
      (env.REPLIT_DEV_DOMAIN ? `https://${env.REPLIT_DEV_DOMAIN}` : ""),
  );
  if (!publicBaseUrl) return null;

  return {
    sendgridApiKey,
    sendgridFromEmail,
    sendgridFromName,
    sendgridEventWebhookPublicKey,
    publicBaseUrl,
  };
}

export function readMessagingConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): MessagingConfig | null {
  const sms = readSmsConfigOrNull(env);
  const email = readEmailConfigOrNull(env);
  if (!sms || !email) return null;
  if (!hasPhoneHmacKey(env)) return null;
  if (!hasLinkHmacKey(env)) return null;
  return {
    sms,
    email,
    hasPhoneHmacKey: true,
    hasLinkHmacKey: true,
    practiceName: env.RESUPPLY_PRACTICE_NAME ?? DEFAULT_PRACTICE_NAME,
  };
}

export function readPracticeName(env: NodeJS.ProcessEnv = process.env): string {
  return env.RESUPPLY_PRACTICE_NAME ?? DEFAULT_PRACTICE_NAME;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
