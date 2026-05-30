// /admin/office-closures — CSR-managed closure windows.
//
//   GET    /admin/office-closures              — list (active +
//                                                 upcoming + recent)
//   GET    /admin/office-closures/active       — the row in effect
//                                                 right now, or null
//   POST   /admin/office-closures              — create
//   PATCH  /admin/office-closures/:id          — narrow updates
//   POST   /admin/office-closures/:id/end-now  — early-close (sets
//                                                 ends_at = now())
//
// requireAdmin gates everything — closures touch how inbound SMS
// looks to every patient, so we keep the gate consistent with the
// other CSR-day-to-day surfaces (returns, backorders).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { findActiveClosure } from "../../lib/office-closure/active";
import { buildClosuresIcal } from "../../lib/office-closure/build-ical";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type ClosureUpdate =
  Database["resupply"]["Tables"]["office_closures"]["Update"];

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const createBody = z
  .object({
    label: z.string().trim().min(1).max(200),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    autoReplyMessage: z.string().trim().min(1).max(320),
  })
  .strict()
  .refine((b) => new Date(b.endsAt) > new Date(b.startsAt), {
    message: "endsAt must be later than startsAt",
  });

const patchBody = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    autoReplyMessage: z.string().trim().min(1).max(320).optional(),
  })
  .strict();

router.get(
  "/admin/office-closures/active",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const active = await findActiveClosure(supabase);
    res.json({ active });
  },
);

router.get(
  "/admin/office-closures",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    // 30 days of past closures + everything future. CSRs want to
    // confirm "is the Christmas closure still on the calendar?"
    // without paging.
    const horizon = new Date();
    horizon.setUTCDate(horizon.getUTCDate() - 30);
    const { data, error } = await supabase
      .schema("resupply")
      .from("office_closures")
      .select(
        "id, label, starts_at, ends_at, auto_reply_message, created_by_user_id, created_at, updated_at",
      )
      .gte("ends_at", horizon.toISOString())
      .order("starts_at", { ascending: true })
      .limit(200);
    if (error) throw error;
    res.json({
      closures: (data ?? []).map((r) => ({
        id: r.id,
        label: r.label,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        autoReplyMessage: r.auto_reply_message,
        createdByUserId: r.created_by_user_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  },
);

router.post(
  "/admin/office-closures",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "office_closures.create", preset: "mutation" }),
  async (req, res) => {
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
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("office_closures")
      .insert({
        label: parsed.data.label,
        starts_at: parsed.data.startsAt,
        ends_at: parsed.data.endsAt,
        auto_reply_message: parsed.data.autoReplyMessage,
        created_by_user_id: req.adminUserId ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "office_closure.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "office_closures",
      targetId: row.id,
      metadata: {
        label: parsed.data.label,
        starts_at: parsed.data.startsAt,
        ends_at: parsed.data.endsAt,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "office_closure.created audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/office-closures/:id",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "office_closures.update", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const update: ClosureUpdate = {
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.label != null) update.label = parsed.data.label;
    if (parsed.data.startsAt != null) update.starts_at = parsed.data.startsAt;
    if (parsed.data.endsAt != null) update.ends_at = parsed.data.endsAt;
    if (parsed.data.autoReplyMessage != null)
      update.auto_reply_message = parsed.data.autoReplyMessage;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("office_closures")
      .update(update)
      .eq("id", params.data.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

router.post(
  "/admin/office-closures/:id/end-now",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "office_closures.end_now", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .schema("resupply")
      .from("office_closures")
      .update({ ends_at: nowIso, updated_at: nowIso })
      .eq("id", params.data.id);
    if (error) throw error;
    await logAudit({
      action: "office_closure.ended_early",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "office_closures",
      targetId: params.data.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "office_closure.ended_early audit failed");
    });
    res.json({ ok: true });
  },
);

// GET /admin/office-closures.ics — iCalendar feed for staff who
// want their personal calendar app to show "office is closed."
// Includes all closures whose end is in the future + 30 days
// past (recent past closures stay visible briefly).
router.get(
  "/admin/office-closures.ics",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const horizon = new Date();
    horizon.setUTCDate(horizon.getUTCDate() - 30);
    const { data, error } = await supabase
      .schema("resupply")
      .from("office_closures")
      .select("id, label, starts_at, ends_at, auto_reply_message")
      .gte("ends_at", horizon.toISOString())
      .order("starts_at", { ascending: true })
      .limit(500);
    if (error) throw error;
    const ics = buildClosuresIcal({
      practiceName: process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps",
      closures: (data ?? []).map((r) => ({
        id: r.id,
        label: r.label,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        autoReplyMessage: r.auto_reply_message,
      })),
    });
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="pennpaps-closures.ics"',
    );
    res.send(ics);
  },
);

// ── Recurring (weekly) closures ──────────────────────────────────

const TIME_HHMMSS = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

const recurringCreateBody = z
  .object({
    label: z.string().trim().min(1).max(200),
    dayOfWeek: z.number().int().min(0).max(6),
    startTimeUtc: z.string().regex(TIME_HHMMSS),
    endTimeUtc: z.string().regex(TIME_HHMMSS),
    autoReplyMessage: z.string().trim().min(1).max(320),
  })
  .strict()
  .refine((b) => b.endTimeUtc > b.startTimeUtc, {
    message: "endTimeUtc must be later than startTimeUtc",
  });

router.get(
  "/admin/office-closures/recurring",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("office_recurring_closures")
      .select(
        "id, label, day_of_week, start_time_utc, end_time_utc, auto_reply_message, active, created_by_user_id, created_at, updated_at",
      )
      .order("day_of_week", { ascending: true })
      .limit(200);
    if (error) throw error;
    res.json({
      rules: (data ?? []).map((r) => ({
        id: r.id,
        label: r.label,
        dayOfWeek: r.day_of_week,
        startTimeUtc: r.start_time_utc,
        endTimeUtc: r.end_time_utc,
        autoReplyMessage: r.auto_reply_message,
        active: r.active === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  },
);

router.post(
  "/admin/office-closures/recurring",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "office_closures_recurring.create",
    preset: "mutation",
  }),
  async (req, res) => {
    const parsed = recurringCreateBody.safeParse(req.body);
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
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("office_recurring_closures")
      .insert({
        label: parsed.data.label,
        day_of_week: parsed.data.dayOfWeek,
        start_time_utc: parsed.data.startTimeUtc,
        end_time_utc: parsed.data.endTimeUtc,
        auto_reply_message: parsed.data.autoReplyMessage,
        created_by_user_id: req.adminUserId ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "office_closure.recurring.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "office_recurring_closures",
      targetId: row.id,
      metadata: {
        day_of_week: parsed.data.dayOfWeek,
        start_time_utc: parsed.data.startTimeUtc,
        end_time_utc: parsed.data.endTimeUtc,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "office_closure.recurring.created audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/office-closures/recurring/:id",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "office_closures_recurring.update",
    preset: "mutation",
  }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = z
      .object({
        active: z.boolean().optional(),
        autoReplyMessage: z.string().trim().min(1).max(320).optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const update: {
      active?: number;
      auto_reply_message?: string;
      updated_at: string;
    } = { updated_at: new Date().toISOString() };
    if (parsed.data.active != null) update.active = parsed.data.active ? 1 : 0;
    if (parsed.data.autoReplyMessage != null)
      update.auto_reply_message = parsed.data.autoReplyMessage;
    const { error } = await supabase
      .schema("resupply")
      .from("office_recurring_closures")
      .update(update)
      .eq("id", params.data.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

export default router;
