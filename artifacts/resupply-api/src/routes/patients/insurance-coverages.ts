// /patients/:id/insurance-coverages — verified payer coverage records.
//
//   GET    /patients/:id/insurance-coverages          — list, ordered by rank
//   POST   /patients/:id/insurance-coverages          — create / re-rank
//   PATCH  /patients/:id/insurance-coverages/:covId   — partial update
//
// Capture-only in this Tier-2a sprint. The schema is shaped so the
// future Tier-2b automation (Availity / Change Healthcare / Waystar
// 270/271 wire) can stamp `verified_at` and the benefits-investigation
// fields without needing further schema changes.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

type InsuranceCoverageUpdate =
  Database["resupply"]["Tables"]["insurance_coverages"]["Update"];

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const idParam = z.object({ id: z.string().uuid() });
const idAndCovParam = z.object({
  id: z.string().uuid(),
  covId: z.string().uuid(),
});

const RANK_VALUES = ["primary", "secondary", "tertiary"] as const;
const RELATIONSHIP_VALUES = ["self", "spouse", "child", "other"] as const;
const RENTAL_VALUES = [
  "rental_month_1_to_3",
  "rental_month_4_to_13",
  "purchased",
  "not_applicable",
] as const;

const baseBody = z.object({
  rank: z.enum(RANK_VALUES).default("primary"),
  payerName: z.string().trim().min(1).max(120),
  planName: z.string().trim().max(120).nullable().optional(),
  memberId: z.string().trim().min(1).max(64),
  groupNumber: z.string().trim().max(64).nullable().optional(),
  policyholderName: z.string().trim().max(160).nullable().optional(),
  policyholderRelationship: z.enum(RELATIONSHIP_VALUES).nullable().optional(),
  effectiveDate: z
    .string()
    .regex(ISO_DATE, "must be YYYY-MM-DD")
    .nullable()
    .optional(),
  terminationDate: z
    .string()
    .regex(ISO_DATE, "must be YYYY-MM-DD")
    .nullable()
    .optional(),
  inNetwork: z.boolean().nullable().optional(),
  deductibleCents: z.number().int().min(0).nullable().optional(),
  deductibleMetCents: z.number().int().min(0).nullable().optional(),
  oopMaxCents: z.number().int().min(0).nullable().optional(),
  copayCents: z.number().int().min(0).nullable().optional(),
  cappedRentalStatus: z.enum(RENTAL_VALUES).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const createBody = baseBody.strict();
const patchBody = baseBody.partial().strict();

router.get(
  "/patients/:id/insurance-coverages",
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("insurance_coverages")
      .select(
        "id, rank, payer_name, plan_name, member_id, group_number, policyholder_name, policyholder_relationship, effective_date, termination_date, in_network, deductible_cents, deductible_met_cents, oop_max_cents, copay_cents, capped_rental_status, verified_at, notes, created_at, updated_at",
      )
      .eq("patient_id", idParsed.data.id)
      .order("rank", { ascending: true });
    if (error) throw error;

    res.json({
      coverages: (data ?? []).map((r) => ({
        id: r.id,
        rank: r.rank,
        payerName: r.payer_name,
        planName: r.plan_name,
        memberId: r.member_id,
        groupNumber: r.group_number,
        policyholderName: r.policyholder_name,
        policyholderRelationship: r.policyholder_relationship,
        effectiveDate: r.effective_date,
        terminationDate: r.termination_date,
        inNetwork: r.in_network,
        deductibleCents: r.deductible_cents,
        deductibleMetCents: r.deductible_met_cents,
        oopMaxCents: r.oop_max_cents,
        copayCents: r.copay_cents,
        cappedRentalStatus: r.capped_rental_status,
        verifiedAt: r.verified_at,
        notes: r.notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  },
);

router.post(
  "/patients/:id/insurance-coverages",
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
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
    const supabase = getSupabaseServiceRoleClient();

    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("insurance_coverages")
      .insert({
        patient_id: idParsed.data.id,
        rank: b.rank,
        payer_name: b.payerName,
        plan_name: b.planName ?? null,
        member_id: b.memberId,
        group_number: b.groupNumber ?? null,
        policyholder_name: b.policyholderName ?? null,
        policyholder_relationship: b.policyholderRelationship ?? null,
        effective_date: b.effectiveDate ?? null,
        termination_date: b.terminationDate ?? null,
        in_network: b.inNetwork ?? null,
        deductible_cents: b.deductibleCents ?? null,
        deductible_met_cents: b.deductibleMetCents ?? null,
        oop_max_cents: b.oopMaxCents ?? null,
        copay_cents: b.copayCents ?? null,
        capped_rental_status: b.cappedRentalStatus ?? null,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) {
      // Map the unique-rank conflict to a clear 409 so the SPA can
      // show "patient already has a primary coverage" instead of a
      // generic 500.
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        res.status(409).json({
          error: "rank_already_taken",
          message:
            "Patient already has a coverage at this rank. Re-rank the existing row first or PATCH it directly.",
        });
        return;
      }
      throw error;
    }

    await logAudit({
      action: "patient.insurance.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_coverages",
      targetId: row.id,
      metadata: {
        patient_id: idParsed.data.id,
        rank: b.rank,
        payer_name: b.payerName,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.insurance.create audit write failed");
    });

    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/patients/:id/insurance-coverages/:covId",
  requireAdmin,
  async (req, res) => {
    const idParsed = idAndCovParam.safeParse(req.params);
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
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      res.status(200).json({ changed: false });
      return;
    }

    const updates: InsuranceCoverageUpdate = {};
    if (fields.rank !== undefined) updates.rank = fields.rank;
    if (fields.payerName !== undefined) updates.payer_name = fields.payerName;
    if (fields.planName !== undefined) updates.plan_name = fields.planName;
    if (fields.memberId !== undefined) updates.member_id = fields.memberId;
    if (fields.groupNumber !== undefined)
      updates.group_number = fields.groupNumber;
    if (fields.policyholderName !== undefined)
      updates.policyholder_name = fields.policyholderName;
    if (fields.policyholderRelationship !== undefined)
      updates.policyholder_relationship = fields.policyholderRelationship;
    if (fields.effectiveDate !== undefined)
      updates.effective_date = fields.effectiveDate;
    if (fields.terminationDate !== undefined)
      updates.termination_date = fields.terminationDate;
    if (fields.inNetwork !== undefined) updates.in_network = fields.inNetwork;
    if (fields.deductibleCents !== undefined)
      updates.deductible_cents = fields.deductibleCents;
    if (fields.deductibleMetCents !== undefined)
      updates.deductible_met_cents = fields.deductibleMetCents;
    if (fields.oopMaxCents !== undefined)
      updates.oop_max_cents = fields.oopMaxCents;
    if (fields.copayCents !== undefined)
      updates.copay_cents = fields.copayCents;
    if (fields.cappedRentalStatus !== undefined)
      updates.capped_rental_status = fields.cappedRentalStatus;
    if (fields.notes !== undefined) updates.notes = fields.notes;

    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("insurance_coverages")
      .update(updates)
      .eq("id", idParsed.data.covId)
      .eq("patient_id", idParsed.data.id)
      .select("id");
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        res.status(409).json({
          error: "rank_already_taken",
          message: "Another coverage already occupies this rank.",
        });
        return;
      }
      throw error;
    }
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await logAudit({
      action: "patient.insurance.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_coverages",
      targetId: idParsed.data.covId,
      metadata: {
        patient_id: idParsed.data.id,
        updated_fields: Object.keys(fields),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.insurance.update audit write failed");
    });

    res.status(200).json({ id: idParsed.data.covId, changed: true });
  },
);

export default router;
