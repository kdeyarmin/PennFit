// /resupply-api/platform/config — GLOBAL super-admin System Configuration.
//
//   GET    /platform/config            catalog + current state
//   PUT    /platform/config/:key        set / update one value
//   DELETE /platform/config/:key        clear one value (env fallback)
//   GET    /platform/config/activity    recent write events
//
// The global super-admin's counterpart of /admin/system/config. It owns
// the PLATFORM-scoped catalog keys (appConfigScopeOf === "platform"): the
// AI vendors and the platform's own Twilio/Telnyx/SendGrid/Stripe
// credentials — infra shared by every tenant. A tenant admin can neither
// see nor edit these; they live behind requirePlatformAdmin.
//
// Values are read from / written to the SEED org's app_config rows — the
// platform defaults the boot overlay (applyAppConfigOverlayToEnv) folds
// into process.env on the next deploy, and that getEffectiveEnv() reads
// live for the therapy-cloud adapters. Same plaintext-stored, masked-on-
// read secret posture as the tenant route (see lib/app-config/views.ts).

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getOrgScopedClient,
  resolveSeedOrgId,
  type OrgScopedClient,
} from "@workspace/resupply-db";

import {
  APP_CONFIG_CATALOG,
  appConfigScopeOf,
  getAppConfigSetting,
} from "../../lib/app-config/catalog";
import { invalidateAppConfigCache } from "../../lib/app-config/store";
import {
  buildSettingView,
  buildWebhookReference,
  loadDbState,
  type SettingView,
} from "../../lib/app-config/views";
import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

/** Only platform-scoped catalog keys are managed on the super-admin surface. */
function isPlatformKey(key: string): boolean {
  return appConfigScopeOf(key) === "platform";
}

/**
 * The platform config lives on the seed org's rows (the boot overlay reads
 * exactly these). Returns null when the seed org can't be resolved — the
 * caller 503s rather than silently writing to the wrong place.
 */
async function seedOrgClientOrNull(): Promise<OrgScopedClient | null> {
  const orgId = await resolveSeedOrgId();
  if (!orgId) return null;
  return getOrgScopedClient(orgId);
}

function overlayDisabled(): boolean {
  return (
    process.env.APP_CONFIG_OVERLAY_DISABLED === "1" ||
    process.env.APP_CONFIG_OVERLAY_DISABLED === "true"
  );
}

// ── GET /platform/config ────────────────────────────────────────────
router.get(
  "/platform/config",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res) => {
    const supabase = await seedOrgClientOrNull();
    if (!supabase) {
      res.status(503).json({ error: "seed_org_unresolved" });
      return;
    }
    const dbState = await loadDbState(supabase);

    const order: string[] = [];
    const byCategory = new Map<string, SettingView[]>();
    for (const setting of APP_CONFIG_CATALOG) {
      if (!isPlatformKey(setting.key)) continue;
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
      overlayDisabled: overlayDisabled(),
      webhookReference: buildWebhookReference(dbState),
    });
  },
);

const keyParamSchema = z.object({ key: z.string().min(1) });
const putBody = z
  .object({ value: z.string().trim().min(1).max(8192) })
  .strict();

// ── PUT /platform/config/:key ───────────────────────────────────────
router.put(
  "/platform/config/:key",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res) => {
    const keyParsed = keyParamSchema.safeParse(req.params);
    const setting = keyParsed.success
      ? getAppConfigSetting(keyParsed.data.key)
      : undefined;
    if (!setting || !isPlatformKey(setting.key)) {
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

    const supabase = await seedOrgClientOrNull();
    if (!supabase) {
      res.status(503).json({ error: "seed_org_unresolved" });
      return;
    }

    const { data: prior, error: priorErr } = await supabase
      .from("app_config")
      .select("key")
      .eq("key", key)
      .maybeSingle();
    if (priorErr) throw priorErr;
    const hadPrevious = !!prior;

    const nowIso = new Date().toISOString();
    const { data: updated, error: upErr } = await supabase
      .from("app_config")
      .upsert(
        {
          key,
          value: parsed.data.value,
          updated_by_user_id: req.platformAdminUserId ?? null,
          updated_by_email: req.platformAdminEmail ?? null,
          updated_at: nowIso,
        },
        { onConflict: "org_id,key" },
      )
      .select("key, value, updated_by_email, updated_at")
      .single();
    if (upErr) throw upErr;

    invalidateAppConfigCache();
    await writeConfigEvent(
      supabase,
      key,
      "set",
      hadPrevious,
      req.platformAdminEmail ?? null,
    );

    logger.info(
      {
        event: "platform_config_set",
        key,
        secret: setting.secret,
        operator: req.platformAdminEmail ?? null,
        hadPrevious,
      },
      "platform config value saved",
    );

    const row = updated as {
      value: string;
      updated_by_email: string | null;
      updated_at: string;
    };
    res.json({
      setting: buildSettingView(setting, {
        value: row.value,
        updatedByEmail: row.updated_by_email,
        updatedAt: row.updated_at,
      }),
    });
  },
);

// ── DELETE /platform/config/:key ────────────────────────────────────
router.delete(
  "/platform/config/:key",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res) => {
    const keyParsed = keyParamSchema.safeParse(req.params);
    const setting = keyParsed.success
      ? getAppConfigSetting(keyParsed.data.key)
      : undefined;
    if (!setting || !isPlatformKey(setting.key)) {
      res.status(404).json({ error: "unknown_key" });
      return;
    }
    const key = setting.key;

    const supabase = await seedOrgClientOrNull();
    if (!supabase) {
      res.status(503).json({ error: "seed_org_unresolved" });
      return;
    }
    const { data: deleted, error: delErr } = await supabase
      .from("app_config")
      .delete()
      .eq("key", key)
      .select("key");
    if (delErr) throw delErr;

    const removed = (deleted ?? []).length > 0;
    if (removed) {
      invalidateAppConfigCache();
      await writeConfigEvent(
        supabase,
        key,
        "clear",
        true,
        req.platformAdminEmail ?? null,
      );
      logger.info(
        {
          event: "platform_config_clear",
          key,
          operator: req.platformAdminEmail ?? null,
        },
        "platform config value cleared",
      );
    }

    res.json({ setting: buildSettingView(setting, undefined), removed });
  },
);

// ── GET /platform/config/activity ───────────────────────────────────
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
  "/platform/config/activity",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (req, res) => {
    const parsed = activityQuerySchema.safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : ACTIVITY_DEFAULT_LIMIT;

    const supabase = await seedOrgClientOrNull();
    if (!supabase) {
      res.status(503).json({ error: "seed_org_unresolved" });
      return;
    }
    const { data, error } = await supabase
      .from("app_config_events")
      .select("occurred_at, operator_email, key, action, had_previous")
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    type ActivityRow = {
      occurred_at: string;
      operator_email: string | null;
      key: string;
      action: string;
      had_previous: boolean;
    };
    const activity = ((data ?? []) as ActivityRow[])
      .filter((r) => isPlatformKey(r.key))
      .map((r) => {
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

async function writeConfigEvent(
  supabase: OrgScopedClient,
  key: string,
  action: "set" | "clear",
  hadPrevious: boolean,
  operatorEmail: string | null,
): Promise<void> {
  try {
    const { error } = await supabase.from("app_config_events").insert({
      key,
      action,
      had_previous: hadPrevious,
      operator_email: operatorEmail,
    });
    if (error) throw error;
  } catch (err) {
    logger.warn(
      { err, key, action },
      "app_config_events insert failed (platform activity panel will miss this write)",
    );
  }
}

export default router;
