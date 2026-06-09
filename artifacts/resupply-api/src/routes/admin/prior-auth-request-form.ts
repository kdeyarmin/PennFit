// GET /admin/patients/:id/prior-authorizations/:paId/request-form
//
// Renders the universal DME/PAP Prior-Authorization Request Form as a
// PDF and serves it to the calling admin. Auto-populated from the
// prior_authorizations row + the linked patient / coverage / payer
// profile / ordering provider / most-recent sleep study, this is the
// faxable (or portal-attachable) artifact a CSR sends to the payer's
// `prior_auth_fax_e164` to open an auth — the realistic "quicker
// turnaround" path for the ~50 PA-requiring payers in the catalog that
// have NOT stood up a Da Vinci PAS FHIR endpoint yet.
//
// The renderer + data contract live in lib/billing/pa-request-pdf.ts;
// this route is the data-fetch + orchestration layer (mirrors swo.ts).
//
// Why GET: the form is a deterministic projection of the PA + patient
// record, so it's safe to refresh/reprint. `Cache-Control: no-store`
// keeps the PHI bytes out of the browser disk cache.
//
// PHI posture: the PDF carries PHI; we send it in the response and never persist or
// log the bytes. One `prior_auth.request_form.generated` audit row per
// call (counts/ids only, no PHI) records the access.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  createTelnyxFaxClient,
  TelnyxApiError,
} from "@workspace/resupply-telecom";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { buildPaRequestPdf } from "../../lib/billing/pa-request-render";
import { signPaRequestFaxToken } from "../../lib/fax-document-token";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";
import { getFaxPublicBaseUrl, isFaxConfigured } from "./physician-fax-outreach";

const router: IRouter = Router();

const paramsSchema = z.object({
  id: z.string().uuid(),
  paId: z.string().uuid(),
});

router.get(
  "/admin/patients/:id/prior-authorizations/:paId/request-form",
  // Read-only per-patient projection — every role with patients.read
  // (i.e. every current admin role) can pull it, same as the SWO.
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { id: patientId, paId } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const result = await buildPaRequestPdf(supabase, patientId, paId);
    if (!result) {
      res.status(404).json({ error: "prior_auth_not_found" });
      return;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="pa-request-${patientId.slice(0, 8)}-${paId.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(result.pdf);

    await logAudit({
      action: "prior_auth.request_form.generated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prior_authorizations",
      targetId: paId,
      metadata: {
        patient_id: patientId,
        hcpcs_code: result.hcpcsCode,
        payer_slug: result.payerSlug,
        has_sleep_study: result.hasSleepStudy,
        has_provider: result.hasProvider,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "prior_auth.request_form.generated audit write failed",
      );
    });
  },
);

// POST .../prior-authorizations/:paId/fax — fax the PA request form to the
// payer's prior-auth fax number. Mirrors the appeal-letter fax path: the
// PDF is rendered on demand when Telnyx fetches the signed mediaUrl (no PHI
// in the URL). The destination defaults to the payer's published
// prior_auth_fax_e164; the biller may override with an explicit faxNumber.
// Fail-soft: a missing fax config is a clear 503, not a 500.
const faxBody = z
  .object({
    faxNumber: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/)
      .optional(),
  })
  .strict();

router.post(
  "/admin/patients/:id/prior-authorizations/:paId/fax",
  requirePermission("patients.update"),
  async (req, res) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = faxBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const { id: patientId, paId } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    // Render once now so we (a) confirm the PA exists/belongs to the
    // patient and (b) resolve the payer's default fax number. The bytes
    // are discarded — Telnyx re-fetches via the signed URL — but rendering
    // here is the cheapest way to validate + resolve the destination.
    const result = await buildPaRequestPdf(supabase, patientId, paId);
    if (!result) {
      res.status(404).json({ error: "prior_auth_not_found" });
      return;
    }

    const destination =
      bodyParsed.data.faxNumber ?? result.payerPriorAuthFaxE164;
    if (!destination) {
      // No explicit number and the payer profile has no published PA fax.
      res.status(409).json({ error: "no_fax_destination" });
      return;
    }

    if (!isFaxConfigured()) {
      res.status(503).json({ error: "fax_not_configured" });
      return;
    }
    const baseUrl = getFaxPublicBaseUrl()!;
    const token = signPaRequestFaxToken(patientId, paId);
    const mediaUrl = `${baseUrl}/resupply-api/fax/document/${token}`;
    const statusCallbackUrl = `${baseUrl}/resupply-api/fax/webhook`;
    const fromNumber = process.env.TELNYX_FAX_FROM_NUMBER!.trim();

    let faxId: string;
    try {
      const sent = await createTelnyxFaxClient().sendFax({
        to: destination,
        from: fromNumber,
        mediaUrl,
        statusCallbackUrl,
      });
      faxId = sent.id;
    } catch (err) {
      const msg =
        err instanceof TelnyxApiError
          ? `Telnyx fax error: ${err.message}`
          : `Fax dispatch error: ${String(err)}`;
      logger.warn(
        { event: "pa_request_fax_dispatch_failed", pa_id: paId },
        "prior_auth.request_form.fax: Telnyx dispatch failed",
      );
      res.status(502).json({ error: "fax_dispatch_failed", message: msg });
      return;
    }

    await logAudit({
      action: "prior_auth.request_form.faxed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prior_authorizations",
      targetId: paId,
      metadata: {
        patient_id: patientId,
        payer_slug: result.payerSlug,
        vendor_ref: faxId,
        vendor_name: "telnyx",
        // Destination digits only as a metadata count, not the PHI body.
        used_payer_default: bodyParsed.data.faxNumber === undefined,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "prior_auth.request_form.faxed audit write failed");
    });

    res.json({ ok: true, vendorRef: faxId });
  },
);

export default router;
