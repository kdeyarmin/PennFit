// POST /shop/me/sleep-study — patient records the structured findings
// from their sleep study (AHI, study date, type) for CSR review.
//
// Patients can attach the actual report PDF via the existing
// /shop/me/documents flow with documentType='sleep_study'; this
// endpoint captures the numeric findings so the verifications team
// doesn't have to re-key them from the PDF before LCD-compliance
// gating works.
//
// Source = `csr_entry` with a clear "self-reported" note — we don't
// add a new enum value just for this path so the schema stays
// stable; CSRs see the note and treat the row as needing
// verification.

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

const body = z
  .object({
    studyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
    studyType: z.enum(["psg", "hsat", "split_night", "re_titration"]),
    ahi: z.number().min(0).max(150),
    rdi: z.number().min(0).max(150).nullable().optional(),
    lowestSpo2Pct: z.number().int().min(0).max(100).nullable().optional(),
    facilityName: z.string().trim().max(200).nullable().optional(),
    documentId: z.string().uuid().nullable().optional(),
  })
  .strict();

router.post("/shop/me/sleep-study", requireSignedIn, async (req, res) => {
  const email = req.shopCustomerEmail;
  if (!email) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = body.safeParse(req.body);
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
  const { data, error } = await supabase
    .schema("resupply")
    .from("sleep_studies")
    .insert({
      patient_id: patientId,
      study_date: parsed.data.studyDate,
      study_type: parsed.data.studyType,
      ahi: String(parsed.data.ahi),
      rdi: parsed.data.rdi == null ? null : String(parsed.data.rdi),
      lowest_spo2_pct: parsed.data.lowestSpo2Pct ?? null,
      facility_name: parsed.data.facilityName ?? null,
      document_id: parsed.data.documentId ?? null,
      source: "csr_entry",
      notes: "self-reported by patient via portal; pending CSR verification",
    })
    .select("id")
    .single();
  if (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === "23505") {
      res.status(409).json({
        error: "duplicate_study",
        message: "A study for that date is already on file.",
      });
      return;
    }
    throw error;
  }
  res.status(201).json({ id: data.id });
});

export default router;
