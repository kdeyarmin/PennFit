// GET /admin/patients/:id/compliance-attestation
//
// Renders the 90-day Medicare LCD L33718 adherence attestation as a
// PDF and streams it to the admin's browser. The window finder +
// renderer live in lib/compliance-attestation.ts; this route handles
// data fetch, source-priority dedupe, and audit.
//
// Optional query parameter `anchor=YYYY-MM-DD` overrides the
// computed anchor date (first therapy night). Useful when the
// initial nights came from a manual SD-card import that the CSR
// knows to be later than the device-reported start. Default is the
// earliest patient_therapy_nights.night_date.

import { Router, type IRouter } from "express";
import PDFDocument from "pdfkit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  findBestAdherenceWindow,
  renderComplianceAttestation,
  type AdherenceNight,
  type AttestationInputs,
} from "../../lib/compliance-attestation";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({
  anchor: z.string().regex(ISO_DATE).optional(),
});

/** Source priority when the same night exists from multiple feeds.
 *  Mirrors the patient-facing dashboard at /shop/me/therapy-summary
 *  so the attestation and the customer's portal view never disagree. */
const SOURCE_PRIORITY: Record<string, number> = {
  resmed_airview: 0,
  philips_care: 1,
  health_connect: 2,
  manual: 3,
};

router.get(
  "/admin/patients/:id/compliance-attestation",
  requireAdmin,
  async (req, res) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const query = querySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }

    const patientId = params.data.id;
    const supabase = getSupabaseServiceRoleClient();

    const { data: patientRow, error: pErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, legal_first_name, legal_last_name, date_of_birth")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!patientRow) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Pull every therapy_night for this patient. The 90-day attestation
    // is bounded by anchor + 90 days, but we sort + filter in JS to
    // keep the SQL simple. CPAP patients typically have hundreds to
    // low-thousands of nights — fine to fetch in one query.
    const { data: nightRows, error: nErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("night_date, source, usage_minutes")
      .eq("patient_id", patientId)
      .order("night_date", { ascending: true });
    if (nErr) throw nErr;

    if (!nightRows || nightRows.length === 0) {
      res.status(422).json({
        error: "no_therapy_data",
        message:
          "No therapy-night data on file for this patient. Verify the device modem or schedule an SD card download before attesting.",
      });
      return;
    }

    // Dedupe by night, source-priority winner.
    const byDate = new Map<string, (typeof nightRows)[number]>();
    for (const row of nightRows) {
      const existing = byDate.get(row.night_date);
      if (!existing) {
        byDate.set(row.night_date, row);
        continue;
      }
      const newRank = SOURCE_PRIORITY[row.source] ?? 99;
      const oldRank = SOURCE_PRIORITY[existing.source] ?? 99;
      if (newRank < oldRank) byDate.set(row.night_date, row);
    }

    const nights: AdherenceNight[] = Array.from(byDate.values())
      .map((r) => ({ date: r.night_date, usageMinutes: r.usage_minutes }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const anchorDate = query.data.anchor ?? nights[0]!.date;
    const asOfDate = new Date().toISOString().slice(0, 10);

    const result = findBestAdherenceWindow(nights, anchorDate, asOfDate);

    const supplierName =
      process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";
    const inputs: AttestationInputs = {
      patient: {
        legalFirstName: patientRow.legal_first_name,
        legalLastName: patientRow.legal_last_name,
        dateOfBirth: patientRow.date_of_birth,
      },
      anchorDate,
      result,
      generatedOn: new Date(),
      supplierName,
    };

    // Stream the PDF.
    const doc = new PDFDocument({ margin: 72, size: "LETTER" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="adherence-${patientId.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    doc.pipe(res);
    renderComplianceAttestation(doc, inputs);
    doc.end();

    await logAudit({
      action: "patient.compliance_attestation.generated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patients",
      targetId: patientId,
      metadata: {
        anchor_date: anchorDate,
        // qualifies + ratio are clinically derived numbers, not raw
        // PHI. Safe to record so the audit log can answer "when did
        // this patient first qualify?"
        qualifies: result.qualifies,
        compliant_nights: result.window?.compliantNights ?? null,
        window_ratio: result.window?.ratio ?? null,
        horizon_complete: result.horizonComplete,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.compliance_attestation.generated audit write failed",
      );
    });
  },
);

export default router;
