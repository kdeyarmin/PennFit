// /admin/system/config — TENANT System Configuration store.
//
//   GET    /admin/system/config            catalog + current state
//   PUT    /admin/system/config/:key       set / update one value
//   DELETE /admin/system/config/:key       clear one value (env fallback)
//   GET    /admin/system/config/activity   recent write events
//
// This is the backing API for the tenant admin's System Configuration
// page. It exposes ONLY tenant-scoped settings (appConfigScopeOf ===
// "tenant"): the tenant's branding/assistant names and its OWN business
// integrations (its ResMed/Philips/3B therapy-cloud accounts and its
// Office Ally clearinghouse login). Platform infra credentials (AI
// vendors, the platform's Twilio/Telnyx/SendGrid/Stripe) are PLATFORM-
// scoped and live only on the global super-admin surface
// (/platform/config, gated by requirePlatformAdmin) — a tenant admin can
// neither see nor edit them here.
//
// Gating: every route requires `system.config.manage`, which only the
// tenant's Admin/Owner role holds (see lib/resupply-auth/src/rbac.ts).
// CSRs and clinicians get a 403.
//
// SECRET POSTURE — values are stored PLAINTEXT in resupply.app_config
// (no column encryption — repo hard rule). The protections are service-
// role-only table access, role-gated routes, and masking on read
// (see lib/app-config/views.ts). The plaintext NEVER crosses the wire.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  getOrgScopedClient,
  type OrgScopedClient,
} from "@workspace/resupply-db";

import {
  APP_CONFIG_CATALOG,
  appConfigScopeOf,
  getAppConfigSetting,
} from "../../lib/app-config/catalog";
import {
  invalidateAppConfigCache,
  invalidateTenantConfigCache,
} from "../../lib/app-config/store";
import { normalizeConfigValueForSave } from "../../lib/app-config/validators";
import {
  buildSettingView,
  loadDbState,
  type SettingView,
} from "../../lib/app-config/views";
import { logger } from "../../lib/logger";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/** A tenant admin may only see/edit tenant-scoped catalog keys. */
function isTenantKey(key: string): boolean {
  return appConfigScopeOf(key) === "tenant";
}

// ── GET /admin/system/config ────────────────────────────────────────
// Returns the TENANT-scoped catalog grouped by category with each
// setting's current state. Secrets are masked. Read-limited + gated.
router.get(
  "/admin/system/config",
  adminReadRateLimiter,
  requirePermission("system.config.manage"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const dbState = await loadDbState(supabase);

    const order: string[] = [];
    const byCategory = new Map<string, SettingView[]>();
    for (const setting of APP_CONFIG_CATALOG) {
      if (!isTenantKey(setting.key)) continue;
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
      // The overlay kill-switch (APP_CONFIG_OVERLAY_DISABLED) suppresses the
      // tenant overlay too (getEffectiveEnvForOrg / getTenantConfigValue),
      // so the tenant page surfaces the same "saved values aren't applied"
      // warning. Telephony webhooks ARE platform-level and stay off the
      // tenant surface.
      overlayDisabled:
        process.env.APP_CONFIG_OVERLAY_DISABLED === "1" ||
        process.env.APP_CONFIG_OVERLAY_DISABLED === "true",
      webhookReference: null,
      twilioWebhooks: null,
    });
  },
);

const keyParamSchema = z.object({ key: z.string().min(1) });

// ── PUT /admin/system/config/:key ───────────────────────────────────
const putBody = z
  .object({
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
    // A platform-scoped key is not editable here — 404 like an unknown key
    // so the tenant surface never reveals that platform settings exist.
    if (!setting || !isTenantKey(setting.key)) {
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

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

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
          value: normalizeConfigValueForSave(key, parsed.data.value),
          updated_by_user_id: req.adminUserId ?? null,
          updated_by_email: req.adminEmail ?? null,
          updated_at: nowIso,
        },
        { onConflict: "org_id,key" },
      )
      .select("key, value, updated_by_email, updated_at")
      .single();
    if (upErr) throw upErr;

    invalidateAppConfigCache();
    invalidateTenantConfigCache();
    await writeConfigEvent(
      supabase,
      key,
      "set",
      hadPrevious,
      req.adminEmail ?? null,
    );

    logger.info(
      {
        event: "app_config_set",
        key,
        secret: setting.secret,
        operator: req.adminEmail ?? null,
        hadPrevious,
      },
      "tenant config value saved",
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

// ── DELETE /admin/system/config/:key ────────────────────────────────
router.delete(
  "/admin/system/config/:key",
  requirePermission("system.config.manage"),
  adminRateLimit({ name: "system_config.clear", preset: "sensitive" }),
  async (req, res) => {
    const keyParsed = keyParamSchema.safeParse(req.params);
    const setting = keyParsed.success
      ? getAppConfigSetting(keyParsed.data.key)
      : undefined;
    if (!setting || !isTenantKey(setting.key)) {
      res.status(404).json({ error: "unknown_key" });
      return;
    }
    const key = setting.key;

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: deleted, error: delErr } = await supabase
      .from("app_config")
      .delete()
      .eq("key", key)
      .select("key");
    if (delErr) throw delErr;

    const removed = (deleted ?? []).length > 0;
    if (removed) {
      invalidateAppConfigCache();
      invalidateTenantConfigCache();
      await writeConfigEvent(
        supabase,
        key,
        "clear",
        true,
        req.adminEmail ?? null,
      );
      logger.info(
        { event: "app_config_clear", key, operator: req.adminEmail ?? null },
        "tenant config value cleared",
      );
    }

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
    const parsed = activityQuerySchema.safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : ACTIVITY_DEFAULT_LIMIT;

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
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
      // Only surface tenant-scoped keys here; platform-key history lives on
      // the super-admin surface.
      .filter((r) => isTenantKey(r.key))
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

/**
 * Append an app_config_events row. Fire-and-forget on failure — a config
 * write that already succeeded must NOT 5xx because its history row
 * couldn't be written. Never includes the value.
 */
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
      "app_config_events insert failed (activity panel will miss this write)",
    );
  }
}

export default router;
