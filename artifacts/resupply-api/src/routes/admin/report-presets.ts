// /admin/reports/presets — saved report shortcuts.
//
//   GET    /admin/reports/presets         list current user's presets
//   POST   /admin/reports/presets         create a new preset
//   DELETE /admin/reports/presets/:id     delete one (owner only)
//
// Scoped per-user. The owning admin is the only one who can see or
// delete a row; there is no shared / org-wide preset story today.
//
// PHI / PII posture
// -----------------
// No PHI. `name` is admin-supplied free text; `recipient` is an
// admin-supplied email address for the Email-this-report pre-fill.
// The Reports backend itself is the source of truth for which
// (slug, format) combinations exist — we don't re-validate the
// catalog here so adding a new report doesn't require a parallel
// edit in this file.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["report_presets"]["Row"];

// Mirror the four-format catalog in admin-reports.tsx. zod will
// reject unknown formats with a 400 invalid_body before we touch
// the DB.
const FORMAT_VALUES = ["csv", "pdf", "iif", "qbo.csv"] as const;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const baseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(60),
  format: z.enum(FORMAT_VALUES),
  recipient: z.string().email().nullable().optional(),
});

const createBody = z.discriminatedUnion("rangeKind", [
  baseSchema.extend({
    rangeKind: z.literal("absolute"),
    rangeFrom: z.string().regex(ISO_DATE_RE),
    rangeTo: z.string().regex(ISO_DATE_RE),
    rangePreset: z.undefined().optional(),
  }),
  baseSchema.extend({
    rangeKind: z.literal("preset"),
    rangePreset: z.string().trim().min(1).max(60),
    rangeFrom: z.undefined().optional(),
    rangeTo: z.undefined().optional(),
  }),
]);

const idParam = z.object({ id: z.string().uuid() });

function rowToApi(r: Row) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    format: r.format,
    rangeKind: r.range_kind,
    rangePreset: r.range_preset,
    rangeFrom: r.range_from,
    rangeTo: r.range_to,
    recipient: r.recipient,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/reports/presets",
  requirePermission("reports.read"),
  async (req, res) => {
    const userId = req.adminUserId;
    if (!userId) {
      // Defensive: requirePermission populates this; a missing
      // value is a bug in the auth middleware, not user input.
      res.status(500).json({ error: "missing_admin_user_id" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("report_presets")
      .select(
        "id, user_id, name, slug, format, range_kind, range_preset, range_from, range_to, recipient, created_at, updated_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({
      presets: (data ?? []).map((r) => rowToApi(r as Row)),
    });
  },
);

router.post(
  "/admin/reports/presets",
  requirePermission("reports.read"),
  adminRateLimit({ name: "reports.presets.create", preset: "mutation" }),
  async (req, res) => {
    const userId = req.adminUserId;
    if (!userId) {
      res.status(500).json({ error: "missing_admin_user_id" });
      return;
    }
    const parsed = createBody.safeParse(req.body);
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
    const b = parsed.data;

    // Cross-field sanity for absolute ranges: from must be ≤ to.
    // The DB constraint enforces shape (both set + preset null);
    // ordering is a soft business rule worth a clean 400 here so
    // the operator sees a useful error instead of a 23514 from pg.
    if (
      b.rangeKind === "absolute" &&
      b.rangeFrom &&
      b.rangeTo &&
      b.rangeFrom > b.rangeTo
    ) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "rangeFrom",
            message: "rangeFrom must be on or before rangeTo",
          },
        ],
      });
      return;
    }

    const insert: Database["resupply"]["Tables"]["report_presets"]["Insert"] =
      {
        user_id: userId,
        name: b.name,
        slug: b.slug,
        format: b.format,
        range_kind: b.rangeKind,
        range_preset: b.rangeKind === "preset" ? b.rangePreset : null,
        range_from: b.rangeKind === "absolute" ? b.rangeFrom : null,
        range_to: b.rangeKind === "absolute" ? b.rangeTo : null,
        recipient: b.recipient ?? null,
      };

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("report_presets")
      .insert(insert)
      .select(
        "id, user_id, name, slug, format, range_kind, range_preset, range_from, range_to, recipient, created_at, updated_at",
      )
      .single();
    if (error) throw error;

    res.status(201).json({ preset: rowToApi(data as Row) });
  },
);

router.delete(
  "/admin/reports/presets/:id",
  requirePermission("reports.read"),
  adminRateLimit({ name: "reports.presets.delete", preset: "destroy" }),
  async (req, res) => {
    const userId = req.adminUserId;
    if (!userId) {
      res.status(500).json({ error: "missing_admin_user_id" });
      return;
    }
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    // Owner-scope: every delete carries .eq("user_id", userId) so
    // admin A cannot delete admin B's presets via direct id guess.
    // We return 204 on success and 404 when nothing matched —
    // covers both "doesn't exist" and "not yours" without leaking
    // which.
    const { data, error } = await supabase
      .schema("resupply")
      .from("report_presets")
      .delete()
      .eq("id", parsed.data.id)
      .eq("user_id", userId)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(204).end();
  },
);

// Suppress the unused-import warning when there are no logger calls.
void logger;

export default router;
