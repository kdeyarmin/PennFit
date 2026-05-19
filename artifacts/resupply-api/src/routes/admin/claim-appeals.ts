// /admin/patients/:id/insurance-claims/:claimId/appeal-letter
//
//   POST — render + persist + return an appeal letter PDF. Body
//          carries the letter_body (typically copied from the
//          denial analysis appeal_letter_sketch) and an optional
//          denial_analysis_id link.
//
//   GET — list prior appeal letters for the claim.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { renderAppealPdf } from "../../lib/billing/appeal-pdf";
import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";
import { publishEvent } from "../../lib/webhooks/publisher";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});

const body = z
  .object({
    letterBody: z.string().trim().min(20).max(8000),
    denialAnalysisId: z.string().uuid().nullable().optional(),
    deliveryMethod: z
      .enum(["fax", "mail", "portal_upload", "email"])
      .optional(),
  })
  .strict();

router.get(
  "/admin/patients/:id/insurance-claims/:claimId/appeal-letter",
  requireAdmin,
  async (req, res) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("claim_appeal_letters")
      .select("*")
      .eq("claim_id", parsed.data.claimId)
      .order("created_at", { ascending: false })
      .limit(50);
    res.json({ appealLetters: data ?? [] });
  },
);

router.post(
  "/admin/patients/:id/insurance-claims/:claimId/appeal-letter",
  requireAdmin,
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: claim } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, claim_number, date_of_service, denial_reason, insurance_coverage_id",
      )
      .eq("id", idParsed.data.claimId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!claim) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }
    const [
      { data: patient },
      { data: coverage },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select("legal_first_name, legal_last_name")
        .eq("id", claim.patient_id)
        .limit(1)
        .maybeSingle(),
      claim.insurance_coverage_id
        ? supabase
            .schema("resupply")
            .from("insurance_coverages")
            .select("member_id")
            .eq("id", claim.insurance_coverage_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const identity = await resolveBillingIdentity({ supabase });
    if (identity.source === "stub") {
      res.status(409).json({ error: "no_dme_organization" });
      return;
    }
    const pdf = await renderAppealPdf({
      payerName: claim.payer_name,
      claimNumber: claim.claim_number,
      patientName: `${patient.legal_first_name} ${patient.legal_last_name}`,
      patientMemberId: coverage?.member_id ?? "(see attached EOB)",
      dateOfService: claim.date_of_service,
      denialReason: claim.denial_reason,
      letterBody: parsed.data.letterBody,
      signerName:
        identity.organization?.authorized_signer_name ?? "Billing Team",
      signerTitle:
        identity.organization?.authorized_signer_title ??
        "Billing Department",
      dmeOrganization: {
        legalName:
          identity.organization?.legal_name ??
          identity.billingProvider.organizationName,
        addressLine1: identity.billingProvider.address.line1,
        city: identity.billingProvider.address.city,
        state: identity.billingProvider.address.state,
        zip: identity.billingProvider.address.zip,
        phoneE164: identity.organization?.phone_e164 ?? "+10000000000",
        billingEmail:
          identity.organization?.billing_email ?? "billing@example.com",
      },
    });

    const insertRow: Database["resupply"]["Tables"]["claim_appeal_letters"]["Insert"] = {
      claim_id: claim.id,
      denial_analysis_id: parsed.data.denialAnalysisId ?? null,
      letter_body: parsed.data.letterBody,
      delivery_method: parsed.data.deliveryMethod ?? null,
      generated_by_email: req.adminEmail ?? "unknown",
    };
    const { data: row, error: insertErr } = await supabase
      .schema("resupply")
      .from("claim_appeal_letters")
      .insert(insertRow)
      .select("id")
      .single();
    if (insertErr) throw insertErr;

    await logAudit({
      action: "claim_appeal.generate",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "claim_appeal_letters",
      targetId: row.id,
      metadata: {
        claim_id: claim.id,
        patient_id: claim.patient_id,
        delivery_method: parsed.data.deliveryMethod ?? null,
        letter_body_length: parsed.data.letterBody.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "claim_appeal.generate audit write failed");
    });
    void publishEvent({
      eventType: "claim_appeal.generated",
      payload: {
        appeal_letter_id: row.id,
        claim_id: claim.id,
        patient_id: claim.patient_id,
      },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="appeal-${row.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("X-Appeal-Id", row.id);
    res.status(201).end(pdf);
  },
);

export default router;
