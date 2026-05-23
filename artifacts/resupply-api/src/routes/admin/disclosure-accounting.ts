// /admin/compliance/patients/:patientId/disclosure-accounting.pdf
//
// Render + stream the HIPAA §164.528 accounting-of-disclosures PDF
// for one patient over a date window. Optionally driven by an open
// patient_rights_requests row of kind `accounting_of_disclosures`
// (`?fromRequestId=<uuid>`), which both narrows the date range and
// — on success — updates the request row with the rendered PDF
// size + a `decided` decision marker if it's still in flight.
//
// PHI posture: the PDF is the patient's own record, intentionally
// rendered with PHI. Audit row captures byte count + entry count
// only, never the rendered body.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { getDisclosureAccounting } from "../../lib/compliance/disclosure-logger";
import { renderDisclosureAccountingPdf } from "../../lib/compliance/disclosure-accounting-pdf";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const params = z.object({ patientId: z.string().uuid() });

const query = z
  .object({
    from: z.string().regex(ISO_DATE).optional(),
    to: z.string().regex(ISO_DATE).optional(),
    fromRequestId: z.string().uuid().optional(),
  })
  .strict();

router.get(
  "/admin/compliance/patients/:patientId/disclosure-accounting.pdf",
  requirePermission("compliance.resolve"),
  async (req, res) => {
    const paramParsed = params.safeParse(req.params);
    if (!paramParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const queryParsed = query.safeParse(req.query);
    if (!queryParsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    // Patient identity for the cover.
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("legal_first_name, legal_last_name, date_of_birth")
      .eq("id", paramParsed.data.patientId)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    // DME identity (letterhead + signer fallback).
    const identity = await resolveBillingIdentity({ supabase });
    if (identity.source === "stub") {
      res.status(409).json({ error: "no_dme_organization" });
      return;
    }

    // Window — request overrides query overrides defaults.
    let fromDate: string | undefined = queryParsed.data.from;
    let toDate: string | undefined = queryParsed.data.to;
    let requestRow:
      | Database["resupply"]["Tables"]["patient_rights_requests"]["Row"]
      | null = null;
    if (queryParsed.data.fromRequestId) {
      const { data: r } = await supabase
        .schema("resupply")
        .from("patient_rights_requests")
        .select("*")
        .eq("id", queryParsed.data.fromRequestId)
        .eq("patient_id", paramParsed.data.patientId)
        .limit(1)
        .maybeSingle();
      if (!r) {
        res.status(404).json({ error: "rights_request_not_found" });
        return;
      }
      requestRow = r;
      // §164.528 accounting requests carry an optional date range in
      // request_details_json; fall back to the patient-portal default
      // (full 6-year window).
      const det = (r.request_details_json ?? {}) as Record<string, unknown>;
      if (
        !fromDate &&
        typeof det.from_date === "string" &&
        ISO_DATE.test(det.from_date)
      ) {
        fromDate = det.from_date;
      }
      if (
        !toDate &&
        typeof det.to_date === "string" &&
        ISO_DATE.test(det.to_date)
      ) {
        toDate = det.to_date;
      }
    }
    const effectiveTo = toDate ?? new Date().toISOString().slice(0, 10);

    const rows = await getDisclosureAccounting({
      patientId: paramParsed.data.patientId,
      fromDate: fromDate ? `${fromDate}T00:00:00.000Z` : undefined,
      toDate: toDate ? `${toDate}T23:59:59.999Z` : undefined,
    });

    const pdf = await renderDisclosureAccountingPdf({
      patientName: `${patient.legal_last_name}, ${patient.legal_first_name}`,
      patientDateOfBirth: patient.date_of_birth,
      windowStart: fromDate ?? null,
      windowEnd: effectiveTo,
      entries: rows.map((r) => ({
        id: r.id,
        recipientName: r.recipient_name,
        recipientAddress: r.recipient_address,
        purpose: r.disclosure_purpose,
        description: r.description,
        legalAuthority: r.legal_authority,
        disclosedAt: r.disclosed_at,
      })),
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
          identity.organization?.billing_email ?? "privacy@example.com",
      },
      signerName:
        identity.organization?.authorized_signer_name ?? "Privacy Officer",
      signerTitle:
        identity.organization?.authorized_signer_title ?? "Privacy Officer",
    });

    // When the render was launched from an open rights request and the
    // request hasn't been decided yet, stamp the row so the operator
    // doesn't accidentally re-deliver. We DON'T persist the PDF itself
    // here — object-storage retention lives in a separate sweep.
    if (
      requestRow &&
      (requestRow.status === "received" ||
        requestRow.status === "in_review" ||
        requestRow.status === "extended")
    ) {
      const nowIso = new Date().toISOString();
      await supabase
        .schema("resupply")
        .from("patient_rights_requests")
        .update({
          status: "granted",
          decision: "granted",
          decision_rationale:
            "Accounting of disclosures generated and delivered.",
          decided_at: nowIso,
          decided_by_email: req.adminEmail ?? "unknown",
          delivered_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", requestRow.id);
    }

    await logAudit({
      action: "compliance.disclosure_accounting.render_pdf",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_disclosure_log",
      targetId: paramParsed.data.patientId,
      metadata: {
        patient_id: paramParsed.data.patientId,
        from: fromDate ?? null,
        to: effectiveTo,
        entry_count: rows.length,
        pdf_bytes: pdf.length,
        from_request_id: requestRow?.id ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "compliance.disclosure_accounting.render_pdf audit write failed",
      );
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="disclosure-accounting-${paramParsed.data.patientId}.pdf"`,
    );
    res.send(pdf);
  },
);

export default router;
