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

import {
  createTwilioFaxClient,
  TwilioApiError,
} from "@workspace/resupply-telecom";

import { renderAppealPdf } from "../../lib/billing/appeal-pdf";
import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { parsePayerAddressLines } from "../../lib/billing/payer-address";
import { signAppealFaxToken } from "../../lib/fax-document-token";
import { logger } from "../../lib/logger";
import { publishEvent } from "../../lib/webhooks/publisher";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { getFaxPublicBaseUrl, isFaxConfigured } from "./physician-fax-outreach";

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
  requirePermission("patients.read"),
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
  requirePermission("patients.update"),
  adminRateLimit({ name: "claim_appeals.create", preset: "sensitive" }),
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
        "id, patient_id, payer_name, payer_profile_id, claim_number, date_of_service, denial_reason, insurance_coverage_id",
      )
      .eq("id", idParsed.data.claimId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!claim) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }
    const [{ data: patient }, { data: coverage }, { data: payerProfile }] =
      await Promise.all([
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
        // Phase 14 — pull the payer's appeals_mailing_address so the
        // letter's "To:" block prints the actual destination instead
        // of relying on the operator to look it up.
        claim.payer_profile_id
          ? supabase
              .schema("resupply")
              .from("payer_profiles")
              .select("appeals_mailing_address")
              .eq("id", claim.payer_profile_id)
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
    const payerAddressLines = parsePayerAddressLines(
      payerProfile?.appeals_mailing_address,
    );
    const pdf = await renderAppealPdf({
      payerName: claim.payer_name,
      payerAddressLines: payerAddressLines ?? undefined,
      claimNumber: claim.claim_number,
      patientName: `${patient.legal_first_name} ${patient.legal_last_name}`,
      patientMemberId: coverage?.member_id ?? "(see attached EOB)",
      dateOfService: claim.date_of_service,
      denialReason: claim.denial_reason,
      letterBody: parsed.data.letterBody,
      signerName:
        identity.organization?.authorized_signer_name ?? "Billing Team",
      signerTitle:
        identity.organization?.authorized_signer_title ?? "Billing Department",
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

    const insertRow: Database["resupply"]["Tables"]["claim_appeal_letters"]["Insert"] =
      {
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

// POST .../appeal-letter/:letterId/fax — fax an EXISTING appeal letter to
// the payer's appeals fax number. Reuses the same signed fax-document URL
// + Twilio sender as physician outreach; the appeal PDF is rendered on
// demand when Twilio fetches the mediaUrl (no PHI in the URL). Marks the
// letter delivery_method='fax' on a successful hand-off. The biller
// supplies the destination fax number (payer appeal fax numbers aren't
// modelled). Stripe/EDI-style fail-soft: a missing fax config is a clear
// 503, not a 500.
const faxBody = z
  .object({
    faxNumber: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/),
  })
  .strict();
const faxParams = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
  letterId: z.string().uuid(),
});

router.post(
  "/admin/patients/:id/insurance-claims/:claimId/appeal-letter/:letterId/fax",
  requirePermission("patients.update"),
  adminRateLimit({ name: "claim_appeals.fax", preset: "sensitive" }),
  async (req, res) => {
    const params = faxParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = faxBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    // The letter must exist AND belong to the claim + patient in the path.
    const { data: letter } = await supabase
      .schema("resupply")
      .from("claim_appeal_letters")
      .select("id, claim_id")
      .eq("id", params.data.letterId)
      .limit(1)
      .maybeSingle();
    if (!letter || letter.claim_id !== params.data.claimId) {
      res.status(404).json({ error: "appeal_letter_not_found" });
      return;
    }

    const { data: claim } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id, patient_id")
      .eq("id", params.data.claimId)
      .limit(1)
      .maybeSingle();
    if (!claim || claim.patient_id !== params.data.id) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }

    if (!isFaxConfigured()) {
      res.status(503).json({ error: "fax_not_configured" });
      return;
    }
    const baseUrl = getFaxPublicBaseUrl()!;
    const token = signAppealFaxToken(letter.id);
    const mediaUrl = `${baseUrl}/resupply-api/fax/document/${token}`;
    const statusCallbackUrl = `${baseUrl}/resupply-api/fax/status-callback`;
    const fromNumber = process.env.TWILIO_FAX_FROM_NUMBER!.trim();

    let sid: string;
    try {
      const result = await createTwilioFaxClient().sendFax({
        to: parsed.data.faxNumber,
        from: fromNumber,
        mediaUrl,
        statusCallbackUrl,
      });
      sid = result.sid;
    } catch (err) {
      const msg =
        err instanceof TwilioApiError
          ? `Twilio fax error: ${err.message}`
          : `Fax dispatch error: ${String(err)}`;
      logger.warn(
        { event: "appeal_fax_dispatch_failed", appeal_letter_id: letter.id },
        "claim_appeal.fax: Twilio dispatch failed",
      );
      res.status(502).json({ error: "fax_dispatch_failed", message: msg });
      return;
    }

    // Twilio accepted the fax → mark the delivery method. delivered_at is
    // stamped on Twilio's terminal status-callback in a follow-up; for now
    // the accept timestamp records the hand-off.
    const nowIso = new Date().toISOString();
    const { error: stampErr } = await supabase
      .schema("resupply")
      .from("claim_appeal_letters")
      .update({ delivery_method: "fax", delivered_at: nowIso })
      .eq("id", letter.id);
    if (stampErr) {
      logger.warn(
        {
          event: "appeal_fax_db_stamp_failed",
          appeal_letter_id: letter.id,
          vendorRef: sid,
          err: stampErr,
        },
        "claim_appeal.fax: fax accepted by Twilio but DB stamp failed",
      );
    }

    await logAudit({
      action: "claim_appeal.faxed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "claim_appeal_letters",
      targetId: letter.id,
      metadata: {
        claim_id: params.data.claimId,
        vendor_ref: sid,
        vendor_name: "twilio",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "claim_appeal.faxed audit write failed");
    });

    res.json({ ok: true, vendorRef: sid });
  },
);

export default router;
