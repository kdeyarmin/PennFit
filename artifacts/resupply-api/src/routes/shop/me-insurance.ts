// /shop/me/insurance — patient self-update of insurance coverage.
//
//   GET  /shop/me/insurance   — return primary-rank coverage summary
//                                (payer + plan + verification state)
//   POST /shop/me/insurance   — submit / update primary coverage
//
// The patient cannot mark a coverage as verified — that's a clinical
// gate the verifications team owns. Every patient-submitted update
// clears `verified_at` so the CSR queue surfaces it for re-check.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

async function resolveSinglePatientByEmail(
  customerEmail: string,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escaped)
    .limit(2);
  if (error) throw error;
  if (!rows || rows.length !== 1) return null;
  return rows[0]!.id;
}

router.get("/shop/me/insurance", requireSignedIn, async (req, res) => {
  const email = req.shopCustomerEmail;
  if (!email) {
    res.json({ coverage: null, patientLinked: false });
    return;
  }
  const patientId = await resolveSinglePatientByEmail(email);
  if (!patientId) {
    res.json({ coverage: null, patientLinked: false });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select(
      "id, rank, payer_name, plan_name, member_id, group_number, effective_date, termination_date, verified_at, updated_at",
    )
    .eq("patient_id", patientId)
    .eq("rank", "primary")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  res.json({
    patientLinked: true,
    coverage: data
      ? {
          id: data.id,
          rank: data.rank,
          payerName: data.payer_name,
          planName: data.plan_name,
          // Member ID is the policy number printed on the card.
          // Patients own this — round-trip it to them.
          memberId: data.member_id,
          groupNumber: data.group_number,
          effectiveDate: data.effective_date,
          terminationDate: data.termination_date,
          verifiedAt: data.verified_at,
          updatedAt: data.updated_at,
        }
      : null,
  });
});

const updateBody = z
  .object({
    payerName: z.string().trim().min(1).max(120),
    planName: z.string().trim().max(120).nullable().optional(),
    memberId: z.string().trim().min(1).max(64),
    groupNumber: z.string().trim().max(64).nullable().optional(),
    effectiveDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .strict();

router.post("/shop/me/insurance", requireSignedIn, async (req, res) => {
  const email = req.shopCustomerEmail;
  if (!email) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = updateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const patientId = await resolveSinglePatientByEmail(email);
  if (!patientId) {
    res.status(404).json({ error: "patient_not_linked" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  // Upsert by (patient_id, rank=primary). Drop verified_at on every
  // patient-side mutation so the CSR queue sees it as unverified.
  const { data: existing, error: lookupErr } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select("id")
    .eq("patient_id", patientId)
    .eq("rank", "primary")
    .limit(1)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (existing) {
    const { error } = await supabase
      .schema("resupply")
      .from("insurance_coverages")
      .update({
        payer_name: parsed.data.payerName,
        plan_name: parsed.data.planName ?? null,
        member_id: parsed.data.memberId,
        group_number: parsed.data.groupNumber ?? null,
        effective_date: parsed.data.effectiveDate ?? null,
        verified_at: null,
        verified_by_user_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) throw error;
    res.json({ id: existing.id, created: false });
    return;
  }
  const { data, error } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .insert({
      patient_id: patientId,
      rank: "primary",
      payer_name: parsed.data.payerName,
      plan_name: parsed.data.planName ?? null,
      member_id: parsed.data.memberId,
      group_number: parsed.data.groupNumber ?? null,
      effective_date: parsed.data.effectiveDate ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  res.status(201).json({ id: data.id, created: true });
});

export default router;
