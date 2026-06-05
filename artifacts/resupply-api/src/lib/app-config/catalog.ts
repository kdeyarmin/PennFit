// System Configuration catalog — the closed set of integration &
// platform settings a super-admin may view/enter from
// /admin/system/configuration.
//
// Why a code-level catalog (not DB-seeded rows like feature_flags):
//   the per-setting METADATA (label, category, secret-or-not, how a
//   saved value takes effect, help text) changes with the codebase —
//   a new integration adds a new key — so it belongs in version
//   control next to the code that reads it. The DB (resupply.app_config)
//   stores only the VALUE keyed by `key`. The route layer refuses to
//   read/write any key that isn't in this catalog, so the writable
//   surface is closed and auditable.
//
// KEY === ENV VAR NAME. Each `key` is the literal environment-variable
// name the runtime already reads (`OPENAI_API_KEY`, …). Keeping them
// identical means a stored value overlays `process.env[key]` directly —
// no name-mapping layer (see ./store.ts).
//
// SCOPE — optional / feature-gated vars ONLY. Every key here is a
// setting the service already degrades gracefully without (per the
// "Service boot contract" in CLAUDE.md). The bootstrap credentials the
// process needs just to start — DATABASE_URL, SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY, PORT, RESUPPLY_LINK_HMAC_KEY, the CORS
// allowlist, SUPABASE_STORAGE_BUCKET_PRIVATE — are deliberately ABSENT
// and must never be added: they're required before the DB overlay can
// even be read, and ./store.ts hard-excludes them as defense in depth.

/**
 * How a saved value reaches the running server.
 *   * "live"    — applied within seconds without a restart. Today this
 *                 is the therapy-cloud adapters: the integration
 *                 registry rebuilds per call from an env overlay
 *                 (./store.ts → getEffectiveEnv), so a rotated
 *                 credential takes effect on the next sync/refresh.
 *   * "restart" — applied on the next service boot/deploy. These vars
 *                 are read at boot or by a vendor client constructed at
 *                 boot; the boot-time overlay (applyAppConfigOverlayToEnv)
 *                 folds the saved value into process.env on startup.
 */
export type AppConfigApplyMode = "live" | "restart";

export interface AppConfigSetting {
  /** Literal env-var name; also the resupply.app_config primary key. */
  key: string;
  /** Human-facing label. */
  label: string;
  /** UI grouping (one card per category). */
  category: string;
  /**
   * Secret values are masked on read (a last-4 hint, never the
   * plaintext) and rendered with a password input. Non-secret config
   * (URLs, IDs, hostnames) is shown in full so an operator can verify
   * it.
   */
  secret: boolean;
  /** When a saved value takes effect — drives the "Live"/"On restart" badge. */
  applyMode: AppConfigApplyMode;
  /** One-line help shown under the field. */
  description: string;
  /** Optional format hint for the input. */
  placeholder?: string;
}

// Category labels — ordering here is the render order in the UI.
export const CATEGORY_AI = "AI vendors";
export const CATEGORY_TWILIO = "Voice & telephony (Twilio)";
export const CATEGORY_SENDGRID = "Email (SendGrid)";
export const CATEGORY_STRIPE = "Payments (Stripe)";
export const CATEGORY_AIRVIEW = "Therapy cloud — ResMed AirView";
export const CATEGORY_CARE = "Therapy cloud — Philips Care Orchestrator";
export const CATEGORY_REACT_HEALTH =
  "Therapy cloud — 3B Medical (React Health)";
export const CATEGORY_OFFICE_ALLY = "Clearinghouse (Office Ally)";
export const CATEGORY_PARACHUTE = "Inbound orders (Parachute)";

export const APP_CONFIG_CATALOG: readonly AppConfigSetting[] = [
  // ── AI vendors ────────────────────────────────────────────────────
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI API key",
    category: CATEGORY_AI,
    secret: true,
    applyMode: "restart",
    description:
      "Powers the voice agent (Realtime), call transcription, and the GPT fallback for chat / sleep coach / SMS classification.",
    placeholder: "sk-…",
  },
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    category: CATEGORY_AI,
    secret: true,
    applyMode: "restart",
    description:
      "Primary brain for the storefront chatbot, sleep coach, and SMS intent classifier (Claude). Takes priority over OpenAI for text LLM calls when set.",
    placeholder: "sk-ant-…",
  },
  {
    key: "DEEPGRAM_API_KEY",
    label: "Deepgram API key",
    category: CATEGORY_AI,
    secret: true,
    applyMode: "restart",
    description:
      "Optional. Opens a parallel Nova-3 session on voice calls for an audit-grade backup transcript.",
  },
  {
    key: "ELEVENLABS_API_KEY",
    label: "ElevenLabs API key",
    category: CATEGORY_AI,
    secret: true,
    applyMode: "restart",
    description:
      "Optional. When set, ElevenLabs becomes the voice agent's TTS voice. Patient-facing speech is covered by the executed ElevenLabs BAA.",
  },

  // ── Twilio ────────────────────────────────────────────────────────
  {
    key: "TWILIO_ACCOUNT_SID",
    label: "Account SID",
    category: CATEGORY_TWILIO,
    secret: false,
    applyMode: "restart",
    description: "Twilio account identifier (starts with AC…).",
    placeholder: "AC…",
  },
  {
    key: "TWILIO_AUTH_TOKEN",
    label: "Auth token",
    category: CATEGORY_TWILIO,
    secret: true,
    applyMode: "restart",
    description: "Authorizes outbound SMS, voice, and fax API calls.",
  },
  {
    key: "TWILIO_PHONE_NUMBER",
    label: "Sender number",
    category: CATEGORY_TWILIO,
    secret: false,
    applyMode: "restart",
    description: "Default SMS + voice caller-ID number, E.164 format.",
    placeholder: "+1…",
  },
  {
    key: "TWILIO_MESSAGING_SERVICE_SID",
    label: "Messaging Service SID",
    category: CATEGORY_TWILIO,
    secret: false,
    applyMode: "restart",
    description:
      "Optional. Send through a Twilio Messaging Service instead of a single number.",
    placeholder: "MG…",
  },
  {
    key: "TWILIO_FAX_FROM_NUMBER",
    label: "Fax sender number",
    category: CATEGORY_TWILIO,
    secret: false,
    applyMode: "restart",
    description: "Optional. Outbound fax sender number, E.164 format.",
    placeholder: "+1…",
  },
  {
    // KEY === ENV VAR NAME. This is the single public origin every Twilio
    // webhook callback is built from (voice/SMS/fax inbound + delivery
    // status), read by readVoicePublicBaseUrlOrNull / readSmsConfigOrNull.
    // It is also reused for email click-through links. When unset the
    // runtime falls back to https://${RAILWAY_PUBLIC_DOMAIN}. The exact
    // full URLs to paste into the Twilio Console are surfaced read-only
    // on /admin/system/configuration (see the route's twilioWebhooks).
    key: "RESUPPLY_VOICE_PUBLIC_BASE_URL",
    label: "Public webhook base URL",
    category: CATEGORY_TWILIO,
    secret: false,
    applyMode: "restart",
    description:
      "Public HTTPS origin Twilio calls back into for inbound voice, SMS, and fax webhooks and delivery callbacks (also reused for email links). Leave unset to use the Railway domain. The full webhook URLs to enter in the Twilio Console are listed below.",
    placeholder: "https://pennfit.up.railway.app",
  },

  // ── SendGrid ──────────────────────────────────────────────────────
  {
    key: "SENDGRID_API_KEY",
    label: "SendGrid API key",
    category: CATEGORY_SENDGRID,
    secret: true,
    applyMode: "restart",
    description:
      "All transactional and bulk email funnels through the shared client. The From address is fixed to info@pennpaps.com and is not editable here.",
    placeholder: "SG.…",
  },
  {
    key: "SENDGRID_FROM_NAME",
    label: "From display name",
    category: CATEGORY_SENDGRID,
    secret: false,
    applyMode: "restart",
    description:
      "Display name shown on outbound email (the address stays info@pennpaps.com).",
  },

  // ── Stripe ────────────────────────────────────────────────────────
  {
    key: "STRIPE_SECRET_KEY",
    label: "Secret key",
    category: CATEGORY_STRIPE,
    secret: true,
    applyMode: "restart",
    description:
      "Server-side key for charge creation and refunds. Use sk_live_… in production.",
    placeholder: "sk_live_…",
  },
  {
    // Canonical key the webhook handler actually reads
    // (readStripeConfigOrNull → env.STRIPE_WEBHOOK_SIGNING_SECRET).
    // NOT the STRIPE_WEBHOOK_SECRET legacy alias, which only the
    // system-info readout checks — overlaying that would leave Stripe
    // webhook verification unconfigured. See PR #488 review.
    key: "STRIPE_WEBHOOK_SIGNING_SECRET",
    label: "Webhook signing secret",
    category: CATEGORY_STRIPE,
    secret: true,
    applyMode: "restart",
    description: "Verifies the signature on inbound Stripe webhook events.",
    placeholder: "whsec_…",
  },
  {
    key: "STRIPE_PUBLISHABLE_KEY",
    label: "Publishable key",
    category: CATEGORY_STRIPE,
    secret: false,
    applyMode: "restart",
    description:
      "Browser-exposed key for Stripe.js / Checkout. Safe to reveal (pk_live_… / pk_test_…).",
    placeholder: "pk_live_…",
  },

  // ── ResMed AirView (therapy cloud — live) ─────────────────────────
  {
    key: "AIRVIEW_API_BASE_URL",
    label: "API base URL",
    category: CATEGORY_AIRVIEW,
    secret: false,
    applyMode: "live",
    description: "ResMed AirView API base URL.",
    placeholder: "https://…",
  },
  {
    key: "AIRVIEW_OAUTH_TOKEN_URL",
    label: "OAuth token URL",
    category: CATEGORY_AIRVIEW,
    secret: false,
    applyMode: "live",
    description: "AirView OAuth2 client_credentials token endpoint.",
    placeholder: "https://…",
  },
  {
    key: "AIRVIEW_CLIENT_ID",
    label: "OAuth client ID",
    category: CATEGORY_AIRVIEW,
    secret: false,
    applyMode: "live",
    description: "AirView OAuth client ID.",
  },
  {
    key: "AIRVIEW_CLIENT_SECRET",
    label: "OAuth client secret",
    category: CATEGORY_AIRVIEW,
    secret: true,
    applyMode: "live",
    description: "AirView OAuth client secret.",
  },
  {
    key: "AIRVIEW_DME_ID",
    label: "DME / partner ID",
    category: CATEGORY_AIRVIEW,
    secret: false,
    applyMode: "live",
    description: "Your ResMed-assigned DME/partner identifier.",
  },

  // ── Philips Care Orchestrator (therapy cloud — live) ──────────────
  {
    key: "CARE_ORCHESTRATOR_API_BASE_URL",
    label: "API base URL",
    category: CATEGORY_CARE,
    secret: false,
    applyMode: "live",
    description: "Philips Care Orchestrator API base URL.",
    placeholder: "https://…",
  },
  {
    key: "CARE_ORCHESTRATOR_OAUTH_TOKEN_URL",
    label: "OAuth token URL",
    category: CATEGORY_CARE,
    secret: false,
    applyMode: "live",
    description: "Care Orchestrator OAuth2 client_credentials token endpoint.",
    placeholder: "https://…",
  },
  {
    key: "CARE_ORCHESTRATOR_CLIENT_ID",
    label: "OAuth client ID",
    category: CATEGORY_CARE,
    secret: false,
    applyMode: "live",
    description: "Care Orchestrator OAuth client ID.",
  },
  {
    key: "CARE_ORCHESTRATOR_CLIENT_SECRET",
    label: "OAuth client secret",
    category: CATEGORY_CARE,
    secret: true,
    applyMode: "live",
    description: "Care Orchestrator OAuth client secret.",
  },
  {
    key: "CARE_ORCHESTRATOR_PARTNER_ID",
    label: "Partner ID",
    category: CATEGORY_CARE,
    secret: false,
    applyMode: "live",
    description: "Your Philips-assigned partner identifier.",
  },

  // ── 3B Medical / React Health (therapy cloud — live) ──────────────
  {
    key: "REACT_HEALTH_API_BASE_URL",
    label: "API base URL",
    category: CATEGORY_REACT_HEALTH,
    secret: false,
    applyMode: "live",
    description: "3B Medical (React Health / iCode) API base URL.",
    placeholder: "https://…",
  },
  {
    key: "REACT_HEALTH_OAUTH_TOKEN_URL",
    label: "OAuth token URL",
    category: CATEGORY_REACT_HEALTH,
    secret: false,
    applyMode: "live",
    description: "React Health OAuth2 client_credentials token endpoint.",
    placeholder: "https://…",
  },
  {
    key: "REACT_HEALTH_CLIENT_ID",
    label: "OAuth client ID",
    category: CATEGORY_REACT_HEALTH,
    secret: false,
    applyMode: "live",
    description: "React Health OAuth client ID.",
  },
  {
    key: "REACT_HEALTH_CLIENT_SECRET",
    label: "OAuth client secret",
    category: CATEGORY_REACT_HEALTH,
    secret: true,
    applyMode: "live",
    description: "React Health OAuth client secret.",
  },
  {
    key: "REACT_HEALTH_ACCOUNT_ID",
    label: "Account ID",
    category: CATEGORY_REACT_HEALTH,
    secret: false,
    applyMode: "live",
    description: "Your 3B Medical-assigned account identifier.",
  },

  // ── Office Ally clearinghouse ─────────────────────────────────────
  {
    key: "OFFICE_ALLY_HOST",
    label: "SFTP host",
    category: CATEGORY_OFFICE_ALLY,
    secret: false,
    applyMode: "restart",
    description: "Office Ally SFTP host (default sftp10.officeally.com).",
    placeholder: "sftp10.officeally.com",
  },
  {
    key: "OFFICE_ALLY_PORT",
    label: "SFTP port",
    category: CATEGORY_OFFICE_ALLY,
    secret: false,
    applyMode: "restart",
    description: "Office Ally SFTP port (default 22).",
    placeholder: "22",
  },
  {
    key: "OFFICE_ALLY_USERNAME",
    label: "SFTP username",
    category: CATEGORY_OFFICE_ALLY,
    secret: false,
    applyMode: "restart",
    description: "Office Ally SFTP username.",
  },
  {
    key: "OFFICE_ALLY_ETIN",
    label: "Submitter ETIN",
    category: CATEGORY_OFFICE_ALLY,
    secret: false,
    applyMode: "restart",
    description: "Submitter ETIN assigned by Office Ally.",
  },
  {
    key: "OFFICE_ALLY_USAGE_INDICATOR",
    label: "Usage indicator",
    category: CATEGORY_OFFICE_ALLY,
    secret: false,
    applyMode: "restart",
    description: "P = production, T = test (default T).",
    placeholder: "T",
  },

  // ── Parachute inbound orders ──────────────────────────────────────
  {
    key: "PARACHUTE_SIGNING_SECRET",
    label: "Webhook signing secret",
    category: CATEGORY_PARACHUTE,
    secret: true,
    applyMode: "restart",
    description: "HMAC secret that verifies inbound Parachute order webhooks.",
  },
  {
    key: "PARACHUTE_API_BASE_URL",
    label: "API base URL",
    category: CATEGORY_PARACHUTE,
    secret: false,
    applyMode: "restart",
    description: "Parachute Health API base URL (for outbound calls).",
    placeholder: "https://…",
  },
  {
    key: "PARACHUTE_CLIENT_ID",
    label: "OAuth client ID",
    category: CATEGORY_PARACHUTE,
    secret: false,
    applyMode: "restart",
    description: "Parachute OAuth client ID (outbound).",
  },
  {
    key: "PARACHUTE_CLIENT_SECRET",
    label: "OAuth client secret",
    category: CATEGORY_PARACHUTE,
    secret: true,
    applyMode: "restart",
    description: "Parachute OAuth client secret (outbound).",
  },
];

/** Fast membership set of every writable key. */
const CATALOG_BY_KEY: ReadonlyMap<string, AppConfigSetting> = new Map(
  APP_CONFIG_CATALOG.map((s) => [s.key, s]),
);

/** Every key the catalog declares (env-var names). */
export const APP_CONFIG_KEYS: readonly string[] = APP_CONFIG_CATALOG.map(
  (s) => s.key,
);

/** Lookup a setting's metadata, or undefined if the key isn't writable. */
export function getAppConfigSetting(key: string): AppConfigSetting | undefined {
  return CATALOG_BY_KEY.get(key);
}

/** True iff `key` is a writable catalog setting. */
export function isAppConfigKey(key: string): boolean {
  return CATALOG_BY_KEY.has(key);
}

// Module-load guard: keys must be unique (a duplicate would make the
// "last write wins" overlay ambiguous and the UI render two rows for
// one env var). Fail loud at import rather than at runtime.
{
  const seen = new Set<string>();
  for (const s of APP_CONFIG_CATALOG) {
    if (seen.has(s.key)) {
      throw new Error(
        `APP_CONFIG_CATALOG has a duplicate key "${s.key}" — keys must be unique.`,
      );
    }
    seen.add(s.key);
  }
}
