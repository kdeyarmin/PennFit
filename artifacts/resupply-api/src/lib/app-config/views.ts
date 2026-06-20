// Shared System-Configuration view helpers.
//
// The config catalog is split by scope across two routes:
//   * TENANT business settings  → /admin/system/config (tenant admin)
//   * PLATFORM infra settings   → /platform/config      (global super-admin)
// Both render a setting the same way (mask secrets, compute the effective
// value + source, soft format check), so that logic lives here once.
//
// SECRET POSTURE: the server reads plaintext to compute a hint, but a
// SettingView only ever carries a masked last-4 for secrets — the
// plaintext NEVER crosses the wire and is NEVER logged.

import { type Database, type OrgScopedClient } from "@workspace/resupply-db";

import { type AppConfigSetting } from "./catalog";
import { maskSecretHint } from "./store";
import { checkConfigFormat, configFormatHint } from "./validators";

type ConfigRow = Database["resupply"]["Tables"]["app_config"]["Row"];

export interface SettingView {
  key: string;
  label: string;
  description: string;
  category: string;
  secret: boolean;
  applyMode: AppConfigSetting["applyMode"];
  placeholder: string | null;
  configured: boolean;
  source: "db" | "env" | "unset";
  envProvided: boolean;
  hint: string | null;
  formatValid: boolean | null;
  formatHint: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
}

export interface DbState {
  value: string;
  updatedByEmail: string | null;
  updatedAt: string;
}

function nonEmptyEnv(key: string): string | undefined {
  const v = process.env[key];
  if (typeof v !== "string") return undefined;
  // A blank / whitespace-only env var counts as unset — matches how the
  // integration config readers treat empty strings.
  return v.trim().length > 0 ? v : undefined;
}

export function buildSettingView(
  setting: AppConfigSetting,
  dbState: DbState | undefined,
): SettingView {
  const envValue = nonEmptyEnv(setting.key);
  const envProvided = envValue !== undefined;

  // DB wins over env (the admin UI is authoritative for these).
  const effectiveValue = dbState?.value ?? envValue;
  const source: SettingView["source"] = dbState
    ? "db"
    : envProvided
      ? "env"
      : "unset";

  let hint: string | null = null;
  if (effectiveValue !== undefined) {
    hint = setting.secret ? maskSecretHint(effectiveValue) : effectiveValue;
  }

  return {
    key: setting.key,
    label: setting.label,
    description: setting.description,
    category: setting.category,
    secret: setting.secret,
    applyMode: setting.applyMode,
    placeholder: setting.placeholder ?? null,
    configured: source !== "unset",
    source,
    envProvided,
    hint,
    formatValid:
      effectiveValue !== undefined
        ? checkConfigFormat(setting.key, effectiveValue)
        : null,
    formatHint: configFormatHint(setting.key),
    updatedByEmail: dbState?.updatedByEmail ?? null,
    updatedAt: source === "db" ? (dbState?.updatedAt ?? null) : null,
  };
}

export async function loadDbState(
  supabase: OrgScopedClient,
): Promise<Map<string, DbState>> {
  const { data, error } = await supabase
    .from("app_config")
    .select("key, value, updated_by_email, updated_at");
  if (error) throw error;
  const map = new Map<string, DbState>();
  for (const r of (data ?? []) as ConfigRow[]) {
    map.set(r.key, {
      value: r.value,
      updatedByEmail: r.updated_by_email,
      updatedAt: r.updated_at,
    });
  }
  return map;
}

// ── Telephony webhook URL reference (platform-scoped) ───────────────
// The fixed webhook route paths each telephony vendor is pointed at —
// Twilio for voice/SMS, Telnyx for fax. Telephony credentials are
// platform infra, so this reference lives on the platform super-admin
// config surface. Keep this list in sync with the actual route defs.
export const WEBHOOK_ENDPOINTS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  path: string;
}> = [
  {
    id: "voice_inbound",
    label: "Voice — A call comes in",
    description:
      "Twilio Console → Phone Numbers → your number → Voice Configuration → “A call comes in” (Webhook, HTTP POST).",
    path: "/resupply-api/voice/inbound-reorder",
  },
  {
    id: "voice_status",
    label: "Voice — Call status changes",
    description:
      "Set automatically on outbound calls. Optionally also the number’s “Call status changes” callback.",
    path: "/resupply-api/voice/status-callback",
  },
  {
    id: "sms_inbound",
    label: "Messaging — A message comes in",
    description:
      "Twilio Console → your number (or Messaging Service) → Messaging → “A message comes in” (Webhook, HTTP POST).",
    path: "/resupply-api/sms/inbound",
  },
  {
    id: "sms_status",
    label: "Messaging — Delivery status callback",
    description:
      "Set automatically on outbound SMS. Optionally also the Messaging Service “Delivery Status Callback”.",
    path: "/resupply-api/sms/status-callback",
  },
  {
    id: "fax_webhook",
    label: "Fax — inbound + delivery status (unified)",
    description:
      "Telnyx portal → your Fax Application (connection) → Inbound Settings → Webhook URL (HTTP POST). One endpoint serves both inbound fax.received events and outbound delivery-status events; the app sets it automatically as the per-fax webhook_url on outbound faxes. (Legacy /fax/inbound and /fax/status-callback still resolve here.)",
    path: "/resupply-api/fax/webhook",
  },
];

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Resolve the public origin telephony webhooks are built from, mirroring
 * the runtime readers EXACTLY: the LIVE process.env value — an explicit
 * RESUPPLY_VOICE_PUBLIC_BASE_URL, else the Railway host. A saved-but-not-
 * yet-applied DB value is surfaced as `pendingRestart`.
 */
function resolveVoicePublicBaseUrl(dbState: Map<string, DbState>): {
  baseUrl: string | null;
  source: "env" | "railway" | "unset";
  pendingRestart: boolean;
} {
  const liveExplicit = nonEmptyEnv("RESUPPLY_VOICE_PUBLIC_BASE_URL")?.trim();
  const liveRailway = nonEmptyEnv("RAILWAY_PUBLIC_DOMAIN")?.trim();
  const baseUrl = liveExplicit
    ? stripTrailingSlash(liveExplicit)
    : liveRailway
      ? stripTrailingSlash(`https://${liveRailway}`)
      : null;
  const source: "env" | "railway" | "unset" = liveExplicit
    ? "env"
    : liveRailway
      ? "railway"
      : "unset";

  const saved = dbState.get("RESUPPLY_VOICE_PUBLIC_BASE_URL")?.value?.trim();
  const pendingRestart =
    !!saved && stripTrailingSlash(saved) !== (baseUrl ?? "");

  return { baseUrl, source, pendingRestart };
}

/**
 * The read-only telephony-webhook reference surfaced on the platform
 * config page so a super-admin can copy the exact callback URLs into each
 * vendor portal. Built from the LIVE base URL + the fixed route paths.
 */
export function buildWebhookReference(dbState: Map<string, DbState>) {
  const { baseUrl, source, pendingRestart } =
    resolveVoicePublicBaseUrl(dbState);
  return {
    baseUrl,
    baseUrlSource: source,
    baseUrlKey: "RESUPPLY_VOICE_PUBLIC_BASE_URL",
    pendingRestart,
    endpoints: baseUrl
      ? WEBHOOK_ENDPOINTS.map((e) => ({
          id: e.id,
          label: e.label,
          description: e.description,
          url: `${baseUrl}${e.path}`,
        }))
      : [],
  };
}
