// /admin/system/config — Super-admin System Configuration store.
//
//   GET    /admin/system/config            catalog + current state
//   PUT    /admin/system/config/:key       set / update one value
//   DELETE /admin/system/config/:key       clear one value (env fallback)
//   GET    /admin/system/config/activity   recent write events
//
// This is the backing API for /admin/system/configuration, where a
// super-admin enters integration credentials and platform secrets that
// historically lived only as Railway env vars (migration 0211).
//
// Gating: every route requires `system.config.manage`, which only the
// super_admin role holds (see lib/resupply-auth/src/rbac.ts). CSRs and
// plain admins get a 403.
//
// SECRET POSTURE — read the whole thing before touching this file:
//   * Values are stored PLAINTEXT in resupply.app_config (no column
//     encryption — repo hard rule). The protections are: service-role-
//     only table access, super_admin-only routes, and masking on read.
//   * The GET handler reads plaintext on the SERVER to compute a hint,
//     but the response only ever contains a masked last-4 for secrets
//     (`maskSecretHint`). The plaintext NEVER crosses the wire and is
//     NEVER logged. Non-secret config (URLs, IDs) is returned in full
//     so an operator can verify it.
//   * The audit table records the key + action + operator, never the
//     value (so the activity feed can't leak a secret).

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  APP_CONFIG_CATALOG,
  type AppConfigSetting,
  getAppConfigSetting,
} from "../../lib/app-config/catalog";
import {
  invalidateAppConfigCache,
  maskSecretHint,
} from "../../lib/app-config/store";
import {
  checkConfigFormat,
  configFormatHint,
} from "../../lib/app-config/validators";
import { logger } from "../../lib/logger";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type ConfigRow = Database["resupply"]["Tables"]["app_config"]["Row"];

// ── Value-state view ────────────────────────────────────────────────

interface SettingView {
  key: string;
  label: string;
  description: string;
  category: string;
  secret: boolean;
  applyMode: AppConfigSetting["applyMode"];
  /** Optional input format hint from the catalog. */
  placeholder: string | null;
  /** Whether an effective value exists (from DB or the environment). */
  configured: boolean;
  /** Where the effective value comes from — DB wins over env. */
  source: "db" | "env" | "unset";
  /** True when the matching env var is also set (may be shadowed by db). */
  envProvided: boolean;
  /**
   * Display hint. For secrets: masked last-4 of the effective value
   * (never the plaintext). For non-secret config: the actual effective
   * value. Null when unset.
   */
  hint: string | null;
  /**
   * Soft format check of the effective value: true = matches the
   * expected shape, false = looks unexpected (UI shows a non-blocking
   * warning), null = no rule for this key or nothing set.
   */
  formatValid: boolean | null;
  /** Expected-shape hint when a rule exists (e.g. "starts with sk-"). */
  formatHint: string | null;
  /** Who last saved a DB value (only when source === "db"). */
  updatedByEmail: string | null;
  /** When the DB value was last saved (only when source === "db"). */
  updatedAt: string | null;
}

interface DbState {
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

function buildSettingView(
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

// ── Telephony webhook URL reference ─────────────────────────────────
// The fixed webhook route paths each telephony vendor is pointed at —
// Twilio for voice/SMS, Telnyx for fax. Every telephony router is mounted
// under /resupply-api with no extra sub-prefix (see app.ts →
// app.use("/resupply-api", router); voice/index.ts etc.), so the full URL
// an operator pastes into the vendor portal is just `${publicBaseUrl}${path}`.
// Status-callback paths are set on outbound calls/messages/faxes
// automatically (voice/SMS append ?conversationId=…; fax sets the per-fax
// webhook_url); the bare path is shown for completeness + the portal
// fields that accept one. Keep this list in sync with the actual route
// definitions.
const WEBHOOK_ENDPOINTS: ReadonlyArray<{
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
 * the runtime readers EXACTLY (readVoicePublicBaseUrlOrNull /
 * readSmsConfigOrNull): the LIVE process.env value — an explicit
 * RESUPPLY_VOICE_PUBLIC_BASE_URL, else the Railway host.
 *
 * We deliberately do NOT prefer a just-saved DB value here. This is a
 * "restart" setting: the running process keeps verifying inbound webhook
 * signatures and building outbound callbacks from process.env until the
 * boot overlay folds a saved value in on the next deploy. Showing the
 * not-yet-live value would have an operator point a vendor at URLs the
 * current process can't verify (signature failures / mismatched
 * callbacks). The saved-but-pending value is surfaced separately as
 * `pendingRestart` so the UI can flag that window instead.
 */
function resolveVoicePublicBaseUrl(dbState: Map<string, DbState>): {
  baseUrl: string | null;
  source: "env" | "railway" | "unset";
  /** A saved DB value differs from the live origin — applies on next deploy. */
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

  // The boot overlay sets process.env[key] = <db value> on restart, so a
  // saved value that still differs from the live origin means the deploy
  // that applies it hasn't happened yet.
  const saved = dbState.get("RESUPPLY_VOICE_PUBLIC_BASE_URL")?.value?.trim();
  const pendingRestart =
    !!saved && stripTrailingSlash(saved) !== (baseUrl ?? "");

  return { baseUrl, source, pendingRestart };
}

/**
 * The read-only telephony-webhook reference surfaced on the config page so
 * a super-admin can copy the exact callback URLs into each vendor portal
 * (Twilio Console for voice/SMS, Telnyx portal for fax). Built from the
 * LIVE base URL the running process actually uses (see
 * resolveVoicePublicBaseUrl) + the fixed route paths; no secret.
 */
function buildWebhookReference(dbState: Map<string, DbState>) {
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

async function loadDbState(): Promise<Map<string, DbState>> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
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

// ── GET /admin/system/config ────────────────────────────────────────
// Returns the catalog grouped by category with each setting's current
// state. Secrets are masked. Read-limited + super-admin-gated.
router.get(
  "/admin/system/config",
  adminReadRateLimiter,
  requirePermission("system.config.manage"),
  async (_req, res) => {
    const dbState = await loadDbState();

    // Group by category, preserving the catalog's declaration order for
    // both categories and settings within them.
    const order: string[] = [];
    const byCategory = new Map<string, SettingView[]>();
    for (const setting of APP_CONFIG_CATALOG) {
      const view = buildSettingView(setting, dbState.get(setting.key));
      if (!byCategory.has(setting.category)) {
        byCategory.set(setting.category, []);
        order.push(setting.category);
      }
      byCategory.get(setting.category)!.push(view);
    }

    res.json({
      categories: order.map((category) => ({
        category,
        settings: byCategory.get(category)!,
      })),
      overlayDisabled:
        process.env.APP_CONFIG_OVERLAY_DISABLED === "1" ||
        process.env.APP_CONFIG_OVERLAY_DISABLED === "true",
      // Read-only: the full telephony webhook URLs to paste into each
      // vendor portal (Twilio Console for voice/SMS, Telnyx for fax),
      // derived from the (editable) public base URL above.
      webhookReference: buildWebhookReference(dbState),
    });
  },
);

// Route param: the setting key. Express 5 types req.params values as
// string | string[]; parse to narrow (a malformed shape 404s as an
// unknown key, same as a key that isn't in the catalog).
const keyParamSchema = z.object({ key: z.string().min(1) });

// ── PUT /admin/system/config/:key ───────────────────────────────────
// Set / update one value. Body: { value: string }.
const putBody = z
  .object({
    // Trim (copy-pasted keys often carry a trailing newline) but keep a
    // generous max — base64 secrets and long URLs are legitimate.
    value: z.string().trim().min(1).max(8192),
  })
  .strict();

router.put(
  "/admin/system/config/:key",
  requirePermission("system.config.manage"),
  adminRateLimit({ name: "system_config.set", preset: "sensitive" }),
  async (req, res) => {
    const keyParsed = keyParamSchema.safeParse(req.params);
    const setting = keyParsed.success
      ? getAppConfigSetting(keyParsed.data.key)
      : undefined;
    if (!setting) {
      res.status(404).json({ error: "unknown_key" });
      return;
    }
    const key = setting.key;
    const parsed = putBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();

    // Was there already a value? Drives the "set" vs "updated" wording
    // in the activity feed (no value stored either way).
    const { data: prior, error: priorErr } = await supabase
      .schema("resupply")
      .from("app_config")
      .select("key")
      .eq("key", key)
      .maybeSingle();
    if (priorErr) throw priorErr;
    const hadPrevious = !!prior;

    const nowIso = new Date().toISOString();
    const { data: updated, error: upErr } = await supabase
      .schema("resupply")
      .from("app_config")
      .upsert(
        {
          key,
          value: parsed.data.value,
          updated_by_user_id: req.adminUserId ?? null,
          updated_by_email: req.adminEmail ?? null,
          updated_at: nowIso,
        },
        { onConflict: "key" },
      )
      .select("key, value, updated_by_email, updated_at")
      .single();
    if (upErr) throw upErr;

    invalidateAppConfigCache();
    await writeConfigEvent(key, "set", hadPrevious, req.adminEmail ?? null);

    // NB: deliberately NO value in the log line — just the key.
    logger.info(
      {
        event: "app_config_set",
        key,
        secret: setting.secret,
        operator: req.adminEmail ?? null,
        hadPrevious,
      },
      "system config value saved",
    );

    const row = updated as ConfigRow;
    res.json({
      setting: buildSettingView(setting, {
        value: row.value,
        updatedByEmail: row.updated_by_email,
        updatedAt: row.updated_at,
      }),
    });
  },
);

// ── DELETE /admin/system/config/:key ────────────────────────────────
// Clear a saved value so the environment variable (if any) takes over.
router.delete(
  "/admin/system/config/:key",
  requirePermission("system.config.manage"),
  adminRateLimit({ name: "system_config.clear", preset: "sensitive" }),
  async (req, res) => {
    const keyParsed = keyParamSchema.safeParse(req.params);
    const setting = keyParsed.success
      ? getAppConfigSetting(keyParsed.data.key)
      : undefined;
    if (!setting) {
      res.status(404).json({ error: "unknown_key" });
      return;
    }
    const key = setting.key;

    const supabase = getSupabaseServiceRoleClient();
    const { data: deleted, error: delErr } = await supabase
      .schema("resupply")
      .from("app_config")
      .delete()
      .eq("key", key)
      .select("key");
    if (delErr) throw delErr;

    const removed = (deleted ?? []).length > 0;
    if (removed) {
      invalidateAppConfigCache();
      await writeConfigEvent(key, "clear", true, req.adminEmail ?? null);
      logger.info(
        { event: "app_config_clear", key, operator: req.adminEmail ?? null },
        "system config value cleared",
      );
    }

    // Re-read nothing — after a clear there is no DB row, so the view
    // reflects the env (or unset).
    res.json({ setting: buildSettingView(setting, undefined), removed });
  },
);

// ── GET /admin/system/config/activity ───────────────────────────────
const ACTIVITY_DEFAULT_LIMIT = 20;
const ACTIVITY_MAX_LIMIT = 100;

const activityQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return ACTIVITY_DEFAULT_LIMIT;
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) return ACTIVITY_DEFAULT_LIMIT;
      return Math.min(n, ACTIVITY_MAX_LIMIT);
    }),
});

router.get(
  "/admin/system/config/activity",
  adminReadRateLimiter,
  requirePermission("system.config.manage"),
  async (req, res) => {
    // safeParse (not parse): a repeated ?limit param makes req.query.limit
    // an array, which would throw → 500. Degrade to the default instead.
    const parsed = activityQuerySchema.safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : ACTIVITY_DEFAULT_LIMIT;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("app_config_events")
      .select("occurred_at, operator_email, key, action, had_previous")
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    const activity = (data ?? []).map((r) => {
      const setting = getAppConfigSetting(r.key);
      return {
        occurredAt: r.occurred_at,
        operatorEmail: r.operator_email ?? null,
        key: r.key,
        label: setting?.label ?? r.key,
        category: setting?.category ?? "Retired",
        action: r.action,
        hadPrevious: r.had_previous,
      };
    });
    res.json({ activity });
  },
);

/**
 * Append an app_config_events row. Fire-and-forget on failure — a
 * config write that already succeeded must NOT 5xx because its history
 * row couldn't be written. Never includes the value.
 */
async function writeConfigEvent(
  key: string,
  action: "set" | "clear",
  hadPrevious: boolean,
  operatorEmail: string | null,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("app_config_events")
      .insert({
        key,
        action,
        had_previous: hadPrevious,
        operator_email: operatorEmail,
      });
    if (error) throw error;
  } catch (err) {
    logger.warn(
      { err, key, action },
      "app_config_events insert failed (activity panel will miss this write)",
    );
  }
}

export default router;
