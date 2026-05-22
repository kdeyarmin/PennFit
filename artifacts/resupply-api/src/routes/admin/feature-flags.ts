// /admin/feature-flags — Control Center backing API.
//
//   GET   /admin/feature-flags         list every flag + current state
//   PATCH /admin/feature-flags/:key    toggle one flag (super_admin only)
//
// The list endpoint is reports.read-gated so anyone who can see the
// Control Center can read the current state without elevation.
// Toggling is admin.tools.manage-gated (collapses to super_admin in
// the current 3-role catalog) — the same posture as macros, message
// templates, and other admin-only knobs.
//
// Audit
// -----
// Every PATCH writes a `feature_flag.toggle` row to resupply.audit_log
// with the key, the old + new values, and the operator's email. No PHI
// — flag keys are static constants.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  invalidateFeatureFlagCache,
} from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["feature_flags"]["Row"];

const keyParam = z.object({
  key: z.enum(FEATURE_FLAG_KEYS),
});

const patchBody = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

function rowToApi(r: Row) {
  return {
    key: r.key,
    enabled: r.enabled,
    description: r.description,
    category: r.category,
    updatedByEmail: r.updated_by_email,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/feature-flags",
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("feature_flags")
      .select(
        "key, enabled, description, category, updated_by_email, updated_at",
      )
      .order("category", { ascending: true })
      .order("key", { ascending: true });
    if (error) throw error;
    res.json({
      flags: (data ?? []).map((r) => rowToApi(r as Row)),
    });
  },
);

router.patch(
  "/admin/feature-flags/:key",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "feature_flags.toggle", preset: "mutation" }),
  async (req, res) => {
    const paramParsed = keyParam.safeParse(req.params);
    if (!paramParsed.success) {
      res.status(404).json({ error: "unknown_flag" });
      return;
    }
    const bodyParsed = patchBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const key = paramParsed.data.key as FeatureFlagKey;
    const supabase = getSupabaseServiceRoleClient();

    // Read the prior state so the audit row carries before/after.
    const { data: priorRow, error: priorErr } = await supabase
      .schema("resupply")
      .from("feature_flags")
      .select("enabled")
      .eq("key", key)
      .maybeSingle();
    if (priorErr) throw priorErr;
    if (!priorRow) {
      // The migration seeds every key; a missing row means the
      // seed didn't run on this environment. Refuse rather than
      // upsert blindly so we don't paper over a deploy bug.
      res.status(404).json({ error: "flag_not_seeded", key });
      return;
    }

    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("feature_flags")
      .update({
        enabled: bodyParsed.data.enabled,
        updated_by_user_id: req.adminUserId ?? null,
        updated_by_email: req.adminEmail ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("key", key)
      .select(
        "key, enabled, description, category, updated_by_email, updated_at",
      )
      .single();
    if (updateErr) throw updateErr;

    invalidateFeatureFlagCache(key);

    await logAudit({
      action: "feature_flag.toggle",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "feature_flags",
      targetId: key,
      metadata: {
        key,
        from: priorRow.enabled,
        to: bodyParsed.data.enabled,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "feature_flag.toggle audit write failed");
    });

    res.json({ flag: rowToApi(updated as Row) });
  },
);

export default router;
