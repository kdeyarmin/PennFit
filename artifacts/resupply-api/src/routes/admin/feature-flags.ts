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

// ─────────────────────────────────────────────────────────────────
// GET /admin/feature-flags/activity — recent toggle events.
//
// Read-only feed of the last `limit` (default 20, max 100) audit
// rows where action='feature_flag.toggle'. Drives the "Recent
// toggle activity" panel on the Control Center.
//
// Permission: reports.read (same as the list endpoint above). The
// underlying audit_log table is broader; this endpoint filters to
// just feature-flag actions so it stays usable from the Control
// Center without granting `audit.read` more widely.
//
// PHI posture: feature-flag toggle metadata never contains PHI
// (the keys are static constants), so the response is safe to
// surface in the admin UI as-is.
// ─────────────────────────────────────────────────────────────────

const ACTIVITY_DEFAULT_LIMIT = 20;
const ACTIVITY_MAX_LIMIT = 100;

interface ToggleActivityRow {
  occurredAt: string;
  operatorEmail: string | null;
  key: string;
  from: boolean;
  to: boolean;
}

router.get(
  "/admin/feature-flags/activity",
  requirePermission("reports.read"),
  async (req, res) => {
    const limitRaw = Number.parseInt(
      typeof req.query.limit === "string" ? req.query.limit : "",
      10,
    );
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(limitRaw, ACTIVITY_MAX_LIMIT)
        : ACTIVITY_DEFAULT_LIMIT;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("audit_log")
      .select("occurred_at, operator_email, metadata")
      .eq("action", "feature_flag.toggle")
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    const activity: ToggleActivityRow[] = [];
    for (const r of data ?? []) {
      // Audit metadata is JSON; the toggle handler above writes
      // { key, from, to }. Anything that doesn't parse to that
      // shape is a corrupt row — log and skip rather than crashing
      // the feed.
      const m = r.metadata as Record<string, unknown> | null;
      if (!m || typeof m !== "object") continue;
      const key = typeof m.key === "string" ? m.key : null;
      const fromVal = typeof m.from === "boolean" ? m.from : null;
      const toVal = typeof m.to === "boolean" ? m.to : null;
      if (key === null || fromVal === null || toVal === null) {
        logger.warn(
          {
            event: "feature_flag_activity_malformed_audit_row",
            occurred_at: r.occurred_at,
          },
          "feature_flag.toggle audit row has unexpected metadata shape",
        );
        continue;
      }
      activity.push({
        occurredAt: r.occurred_at,
        operatorEmail: r.operator_email ?? null,
        key,
        from: fromVal,
        to: toVal,
      });
    }
    res.json({ activity });
  },
);

export default router;
