// /admin/capped-rental-cycles — CRUD + worker trigger for the
// 13/36-month rental lifecycle. The worker advances cycles
// automatically; this surface is for CSR overrides (pause, cancel,
// manual ownership transfer).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { runCappedRentalAdvance } from "../../lib/billing/capped-rental-advancer";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requireAdminOnly,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["capped_rental_cycles"]["Row"];

const STATUS_VALUES = ["active", "paused", "transferred", "cancelled"] as const satisfies readonly Row["status"][];
const MAX_MONTHS_VALUES = [13, 15, 36] as const;

const createBody = z
  .object({
    patientId: z.string().uuid(),
    hcpcsCode: z.string().regex(/^[A-Z]\d{4}$/),
    payerProfileId: z.string().uuid().nullable().optional(),
    insuranceCoverageId: z.string().uuid().nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    maxMonths: z.number().int().refine((n) => (MAX_MONTHS_VALUES as readonly number[]).includes(n)),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
const patchBody = z
  .object({
    status: z.enum(STATUS_VALUES).optional(),
    ownershipTransferredOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const idParam = z.object({ id: z.string().uuid() });

router.get("/admin/capped-rental-cycles", requireAdmin, async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .schema("resupply")
    .from("capped_rental_cycles")
    .select("*")
    .order("start_date", { ascending: false })
    .limit(200);
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status && (STATUS_VALUES as readonly string[]).includes(status)) {
    query = query.eq("status", status as Row["status"]);
  }
  const { data } = await query;
  res.json({ cycles: data ?? [] });
});

router.post(
  "/admin/capped-rental-cycles",
  requireAdmin,
  adminRateLimit({ name: "capped_rental_cycles.create", preset: "mutation" }),
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
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("capped_rental_cycles")
      .insert({
        patient_id: b.patientId,
        hcpcs_code: b.hcpcsCode.toUpperCase(),
        payer_profile_id: b.payerProfileId ?? null,
        insurance_coverage_id: b.insuranceCoverageId ?? null,
        start_date: b.startDate,
        current_month: 1,
        max_months: b.maxMonths,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "capped_rental_cycle.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "capped_rental_cycles",
      targetId: data.id,
      metadata: { hcpcs: b.hcpcsCode, max_months: b.maxMonths },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "capped_rental_cycle.create audit write failed");
    });
    res.status(201).json({ id: data.id });
  },
);

router.patch(
  "/admin/capped-rental-cycles/:id",
  requireAdmin,
  adminRateLimit({ name: "capped_rental_cycles.update", preset: "mutation" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["capped_rental_cycles"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.status !== undefined) update.status = b.status;
    if (b.ownershipTransferredOn !== undefined)
      update.ownership_transferred_on = b.ownershipTransferredOn;
    if (b.notes !== undefined) update.notes = b.notes;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("capped_rental_cycles")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

router.post(
  "/admin/capped-rental-cycles/advance-now",
  requireAdminOnly,
  adminRateLimit({
    name: "capped_rental_cycles.advance_now",
    preset: "bulk",
  }),
  async (_req, res) => {
    const stats = await runCappedRentalAdvance();
    res.json({ ok: true, stats });
  },
);

export default router;
