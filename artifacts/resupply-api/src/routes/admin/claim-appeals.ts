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
import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import {
  createTelnyxFaxClient,
  TelnyxApiError,
} from "@workspace/resupply-telecom";

import { markAppealSent } from "../../lib/billing/appeal-transition";
import { renderAppealPdf } from "../../lib/billing/appeal-pdf";
import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { parsePayerAddressLines } from "../../lib/billing/payer-address";
import { signAppealFaxToken } from "../../lib/fax-document-token";
import { logger } from "../../lib/logger";
import { resolveTenantFaxFrom } from "../../lib/messaging/tenant-telecom";
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data } = await supabase
      .from("claim_appeal_letters")
      .select("*")
      .eq("claim_id", parsed.data.claimId)
      .order("created_at", { ascending: false })
      .limit(50);
    res.json({ appealLetters: data ?? [] });
  },
);

// GET .../denial-sketch — the latest denial analysis's appeal-letter sketch for
// this claim, so the appeals workbench can pre-fill the letter body instead of
// opening a blank textarea. The sketch lives in
// claim_denial_analyses.analysis_json.appealLetterSketch; the claim points at
// the newest analysis via insurance_claims.latest_denial_analysis_id.
router.get(
  "/admin/patients/:id/insurance-claims/:claimId/denial-sketch",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: claim } = await supabase
      .from("insurance_claims")
      .select("id, latest_denial_analysis_id")
      .eq("id", parsed.data.claimId)
      .eq("patient_id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    // Distinguish "claim doesn't exist for this patient" (404) from "claim
    // exists but has no denial analysis yet" (200 + null sketch) — otherwise an
    // invalid claim/patient path silently succeeds and hides caller bugs.
    if (!claim) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }
    if (!claim.latest_denial_analysis_id) {
      res.json({ denialAnalysisId: null, recommendation: null, sketch: null });
      return;
    }
    const { data: analysis } = await supabase
      .from("claim_denial_analyses")
      .select("id, recommendation, analysis_json")
      .eq("id", claim.latest_denial_analysis_id)
      .limit(1)
      .maybeSingle();
    const analysisJson = analysis?.analysis_json as {
      appealLetterSketch?: unknown;
    } | null;
    const sketch =
      typeof analysisJson?.appealLetterSketch === "string"
        ? analysisJson.appealLetterSketch
        : null;
    res.json({
      denialAnalysisId: analysis?.id ?? null,
      recommendation: analysis?.recommendation ?? null,
      sketch,
    });
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: claim } = await supabase
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
          .from("patients")
          .select("legal_first_name, legal_last_name")
          .eq("id", claim.patient_id)
          .limit(1)
          .maybeSingle(),
        claim.insurance_coverage_id
          ? supabase
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
    const identity = await resolveBillingIdentity({ orgId });
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
      orgId: req.orgId,
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    // The letter must exist AND belong to the claim + patient in the path.
    const { data: letter } = await supabase
      .from("claim_appeal_letters")
      .select("id, claim_id, denial_analysis_id")
      .eq("id", params.data.letterId)
      .limit(1)
      .maybeSingle();
    if (!letter || letter.claim_id !== params.data.claimId) {
      res.status(404).json({ error: "appeal_letter_not_found" });
      return;
    }

    const { data: claim } = await supabase
      .from("insurance_claims")
      .select("id, patient_id, status")
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
    const statusCallbackUrl = `${baseUrl}/resupply-api/fax/webhook`;
    // Prefer the tenant's own provisioned fax DID (migration 0368), else
    // the platform default (isFaxConfigured verified it is set).
    const tenantFrom = await resolveTenantFaxFrom(orgId);
    const fromNumber = tenantFrom ?? process.env.TELNYX_FAX_FROM_NUMBER!.trim();

    let faxId: string;
    try {
      const result = await createTelnyxFaxClient().sendFax({
        to: parsed.data.faxNumber,
        from: fromNumber,
        mediaUrl,
        statusCallbackUrl,
      });
      faxId = result.id;
    } catch (err) {
      const msg =
        err instanceof TelnyxApiError
          ? `Telnyx fax error: ${err.message}`
          : `Fax dispatch error: ${String(err)}`;
      logger.warn(
        { event: "appeal_fax_dispatch_failed", appeal_letter_id: letter.id },
        "claim_appeal.fax: Telnyx dispatch failed",
      );
      res.status(502).json({ error: "fax_dispatch_failed", message: msg });
      return;
    }

    // Telnyx accepted the fax → mark the delivery method. delivered_at is
    // stamped on Telnyx's terminal status-callback in a follow-up; for now
    // the accept timestamp records the hand-off.
    const nowIso = new Date().toISOString();
    const { error: stampErr } = await supabase
      .from("claim_appeal_letters")
      .update({ delivery_method: "fax", delivered_at: nowIso })
      .eq("id", letter.id);
    if (stampErr) {
      logger.warn(
        {
          event: "appeal_fax_db_stamp_failed",
          appeal_letter_id: letter.id,
          vendorRef: faxId,
          err: stampErr,
        },
        "claim_appeal.fax: fax accepted by Telnyx but DB stamp failed",
      );
    }

    // The appeal has now actually left for the payer (Telnyx accepted the
    // fax) — run the shared "appeal sent" transition: a currently-`denied`
    // claim moves to `appealed`, with the replayable event row + webhook + the
    // answering denial analysis resolved so it drops off the denials worklist.
    // Best-effort (the fax already succeeded).
    await markAppealSent({
      supabase,
      claim,
      letterDenialAnalysisId: letter.denial_analysis_id,
      actorEmail: req.adminEmail ?? null,
      note: "Appeal faxed to payer.",
      nowIso,
    });

    await logAudit({
      action: "claim_appeal.faxed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "claim_appeal_letters",
      targetId: letter.id,
      metadata: {
        claim_id: params.data.claimId,
        vendor_ref: faxId,
        vendor_name: "telnyx",
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "claim_appeal.faxed audit write failed");
    });

    res.json({ ok: true, vendorRef: faxId });
  },
);

// POST .../appeal-letter/:letterId/mark-delivered — record an out-of-band
// appeal delivery (mail / email / portal upload) that didn't go through the
// fax path. Stamps delivery_method + delivered_at and runs the SAME shared
// "appeal sent" transition as the fax route (denied -> appealed + resolve the
// denial analysis), closing the gap where mail/email appeals never transitioned
// and silently stayed "denied".
const markDeliveredBody = z
  .object({
    deliveryMethod: z.enum(["mail", "email", "portal_upload"]),
  })
  .strict();

router.post(
  "/admin/patients/:id/insurance-claims/:claimId/appeal-letter/:letterId/mark-delivered",
  requirePermission("patients.update"),
  adminRateLimit({ name: "claim_appeals.mark_delivered", preset: "mutation" }),
  async (req, res) => {
    const params = faxParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = markDeliveredBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: letter } = await supabase
      .from("claim_appeal_letters")
      .select("id, claim_id, denial_analysis_id, delivered_at")
      .eq("id", params.data.letterId)
      .limit(1)
      .maybeSingle();
    if (!letter || letter.claim_id !== params.data.claimId) {
      res.status(404).json({ error: "appeal_letter_not_found" });
      return;
    }
    const { data: claim } = await supabase
      .from("insurance_claims")
      .select("id, patient_id, status")
      .eq("id", params.data.claimId)
      .limit(1)
      .maybeSingle();
    if (!claim || claim.patient_id !== params.data.id) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }

    const nowIso = new Date().toISOString();
    // Idempotent: don't overwrite an earlier delivery timestamp on a re-click.
    const { error: stampErr } = await supabase
      .from("claim_appeal_letters")
      .update({
        delivery_method: parsed.data.deliveryMethod,
        delivered_at: letter.delivered_at ?? nowIso,
      })
      .eq("id", letter.id);
    if (stampErr) throw stampErr;

    await markAppealSent({
      supabase,
      claim,
      letterDenialAnalysisId: letter.denial_analysis_id,
      actorEmail: req.adminEmail ?? null,
      note: `Appeal ${parsed.data.deliveryMethod === "mail" ? "mailed" : "sent"} to payer.`,
      nowIso,
    });

    await logAudit({
      action: "claim_appeal.marked_delivered",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "claim_appeal_letters",
      targetId: letter.id,
      metadata: {
        claim_id: params.data.claimId,
        delivery_method: parsed.data.deliveryMethod,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "claim_appeal.marked_delivered audit write failed");
    });

    res.json({ ok: true });
  },
);

// POST .../appeal-letter/:letterId/outcome — record the payer's response to an
// appeal so win-rate + response aging can be measured. Records outcome +
// responded_at on the letter; it deliberately does NOT change the claim status
// (an overturned appeal is reprocessed by the payer and posts via the next 835;
// an upheld/withdrawn appeal is closed by the biller through the normal path).
const outcomeBody = z
  .object({
    outcome: z.enum(["overturned", "upheld", "partial", "withdrawn"]),
    respondedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/)
      .optional(),
  })
  .strict();

router.post(
  "/admin/patients/:id/insurance-claims/:claimId/appeal-letter/:letterId/outcome",
  requirePermission("patients.update"),
  adminRateLimit({ name: "claim_appeals.outcome", preset: "mutation" }),
  async (req, res) => {
    const params = faxParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = outcomeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    // The letter must exist AND belong to the claim + patient in the path.
    const { data: letter } = await supabase
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
      .from("insurance_claims")
      .select("id, patient_id")
      .eq("id", params.data.claimId)
      .limit(1)
      .maybeSingle();
    if (!claim || claim.patient_id !== params.data.id) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }

    const respondedAt = parsed.data.respondedAt
      ? new Date(parsed.data.respondedAt).toISOString()
      : new Date().toISOString();
    const { error: updErr } = await supabase
      .from("claim_appeal_letters")
      .update({ outcome: parsed.data.outcome, responded_at: respondedAt })
      .eq("id", letter.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "claim_appeal.outcome_recorded",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "claim_appeal_letters",
      targetId: letter.id,
      metadata: {
        claim_id: params.data.claimId,
        outcome: parsed.data.outcome,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "claim_appeal.outcome_recorded audit write failed");
    });

    res.json({ ok: true, outcome: parsed.data.outcome, respondedAt });
  },
);

export default router;
