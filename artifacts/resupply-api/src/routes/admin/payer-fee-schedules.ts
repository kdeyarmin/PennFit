// /admin/payer-fee-schedules — payer + HCPCS → expected allowed cents.
//
//   GET    /admin/payer-fee-schedules?payerProfileId=&hcpcs=
//   POST   /admin/payer-fee-schedules            admin-only
//   PATCH  /admin/payer-fee-schedules/:id        admin-only
//   GET    /admin/payer-fee-schedules/lookup?payerProfileId=&hcpcs=&modifier=&onDate=
//          — returns the best-matching row for the supplied date.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type FeeRow = Database["resupply"]["Tables"]["payer_fee_schedules"]["Row"];

const SOURCE_VALUES = ["manual", "cms_published", "payer_published", "observed"] as const satisfies readonly FeeRow["source"][];

const HCPCS_RE = /^[A-Z]\d{4}$/;
const MODIFIER_RE = /^[A-Z0-9]{2}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const upsertBody = z
  .object({
    payerProfileId: z.string().uuid(),
    hcpcsCode: z
      .string()
      .trim()
      .max(12)
      .transform((s) => s.toUpperCase())
      .refine((s) => HCPCS_RE.test(s), "must be a HCPCS code like E0601"),
    modifier: z
      .string()
      .trim()
      .max(8)
      .nullable()
      .optional()
      .transform((s) => (s ? s.toUpperCase() : s))
      .refine(
        (s) => s == null || s === "" || MODIFIER_RE.test(s),
        "must be a 2-char alphanumeric modifier",
      ),
    allowedCents: z.number().int().min(0),
    effectiveFrom: z.string().regex(ISO_DATE_RE, "must be YYYY-MM-DD"),
    effectiveThrough: z
      .string()
      .regex(ISO_DATE_RE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    source: z.enum(SOURCE_VALUES).default("manual"),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const patchBody = upsertBody.partial();

const idParam = z.object({ id: z.string().uuid() });

function rowToApi(r: FeeRow) {
  return {
    id: r.id,
    payerProfileId: r.payer_profile_id,
    hcpcsCode: r.hcpcs_code,
    modifier: r.modifier,
    allowedCents: r.allowed_cents,
    effectiveFrom: r.effective_from,
    effectiveThrough: r.effective_through,
    source: r.source,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/payer-fee-schedules",
  requirePermission("reports.read"),
  async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("payer_fee_schedules")
    .select(
      "id, payer_profile_id, hcpcs_code, modifier, allowed_cents, effective_from, effective_through, source, notes, created_at, updated_at",
    )
    .order("effective_from", { ascending: false })
    .limit(500);
  const payerProfileId =
    typeof req.query.payerProfileId === "string" ? req.query.payerProfileId : undefined;
  if (payerProfileId) query = query.eq("payer_profile_id", payerProfileId);
  const hcpcs = typeof req.query.hcpcs === "string" ? req.query.hcpcs.toUpperCase() : undefined;
  if (hcpcs) query = query.eq("hcpcs_code", hcpcs);
  const { data, error } = await query;
  if (error) throw error;
  res.json({ feeSchedules: (data ?? []).map(rowToApi) });
});

/**
 * Best-match lookup: returns the most-specific row whose effective
 * window contains `onDate` (default today). Modifier-aware rows beat
 * modifier-NULL rows; ties broken by effective_from desc.
 */
router.get(
  "/admin/payer-fee-schedules/lookup",
  requirePermission("reports.read"),
  async (req, res) => {
    const payerProfileId =
      typeof req.query.payerProfileId === "string" ? req.query.payerProfileId : "";
    const hcpcs =
      typeof req.query.hcpcs === "string" ? req.query.hcpcs.toUpperCase() : "";
    if (!payerProfileId || !hcpcs) {
      res.status(400).json({ error: "missing_payerProfileId_or_hcpcs" });
      return;
    }
    if (!HCPCS_RE.test(hcpcs)) {
      res.status(400).json({ error: "invalid_hcpcs" });
      return;
    }
    const modifier =
      typeof req.query.modifier === "string" ? req.query.modifier.toUpperCase() : null;
    const onDate =
      typeof req.query.onDate === "string" && ISO_DATE_RE.test(req.query.onDate)
        ? req.query.onDate
        : new Date().toISOString().slice(0, 10);

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("payer_fee_schedules")
      .select(
        "id, payer_profile_id, hcpcs_code, modifier, allowed_cents, effective_from, effective_through, source, notes, created_at, updated_at",
      )
      .eq("payer_profile_id", payerProfileId)
      .eq("hcpcs_code", hcpcs)
      .lte("effective_from", onDate)
      .or(`effective_through.is.null,effective_through.gte.${onDate}`)
      .order("effective_from", { ascending: false });
    if (error) throw error;
    const candidates = data ?? [];
    if (candidates.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const exactMod = modifier
      ? candidates.find((r) => (r.modifier ?? "").toUpperCase() === modifier)
      : undefined;
    const wildcard = candidates.find((r) => r.modifier === null);
    const pick = exactMod ?? wildcard ?? candidates[0];
    res.json({ feeSchedule: pick ? rowToApi(pick) : null });
  },
);

router.post(
  "/admin/payer-fee-schedules",
  requireAdminOnly,
  adminRateLimit({ name: "payer_fee_schedules.create", preset: "sensitive" }),
  async (req, res) => {
    const parsed = upsertBody.safeParse(req.body);
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
    if (b.effectiveThrough && b.effectiveThrough < b.effectiveFrom) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "effectiveThrough",
            message: "must be >= effectiveFrom",
          },
        ],
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("payer_fee_schedules")
      .insert({
        payer_profile_id: b.payerProfileId,
        hcpcs_code: b.hcpcsCode,
        modifier: b.modifier ?? null,
        allowed_cents: b.allowedCents,
        effective_from: b.effectiveFrom,
        effective_through: b.effectiveThrough ?? null,
        source: b.source,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "payer_fee_schedule.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "payer_fee_schedules",
      targetId: data.id,
      metadata: {
        payer_profile_id: b.payerProfileId,
        hcpcs_code: b.hcpcsCode,
        allowed_cents: b.allowedCents,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "payer_fee_schedule.create audit write failed");
    });
    res.status(201).json({ id: data.id });
  },
);

router.patch(
  "/admin/payer-fee-schedules/:id",
  requireAdminOnly,
  adminRateLimit({ name: "payer_fee_schedules.update", preset: "sensitive" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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
    const update: Database["resupply"]["Tables"]["payer_fee_schedules"]["Update"] =
      { updated_at: new Date().toISOString() };
    if (b.payerProfileId !== undefined) update.payer_profile_id = b.payerProfileId;
    if (b.hcpcsCode !== undefined) update.hcpcs_code = b.hcpcsCode;
    if (b.modifier !== undefined) update.modifier = b.modifier;
    if (b.allowedCents !== undefined) update.allowed_cents = b.allowedCents;
    if (b.effectiveFrom !== undefined) update.effective_from = b.effectiveFrom;
    if (b.effectiveThrough !== undefined) update.effective_through = b.effectiveThrough;
    if (b.source !== undefined) update.source = b.source;
    if (b.notes !== undefined) update.notes = b.notes;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("payer_fee_schedules")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    await logAudit({
      action: "payer_fee_schedule.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "payer_fee_schedules",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "payer_fee_schedule.update audit write failed");
    });
    res.json({ ok: true });
  },
);

export default router;
