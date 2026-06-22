// GET /fax/document/:token — serves the physician cover letter as a PDF.
//
// Telnyx fetches this URL immediately after the dispatch call so it can
// render and transmit the fax. The URL carries a short-lived HMAC-signed
// token (1 hour TTL) containing only the outreach row ID; no PHI in the
// URL itself.
//
// PHI posture:
//   * The signed token prevents enumeration of outreach IDs.
//   * Response is streamed directly; the cover letter text never hits
//     the application logger (pdfkit pipes to res, never to a buffer
//     that could be accidentally logged).
//   * No audit event here — the dispatch audit in the POST route is
//     sufficient; logging every Telnyx fetch would add noise without value.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import PDFDocument from "pdfkit";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { renderAppealPdfForLetterId } from "../../lib/billing/appeal-letter-render.js";
import { buildPaRequestPdf } from "../../lib/billing/pa-request-render.js";
import { getDocumentSupplierName } from "../../lib/company-info.js";
import { verifyFaxDocumentToken } from "../../lib/fax-document-token.js";
import { ObjectStorageService } from "../../lib/object-storage/objectStorage.js";
import { renderManualDocumentPacketForFax } from "../../lib/manual-documents/packet-service.js";
import { renderManualDocumentForFax } from "../../lib/manual-documents/render-for-fax.js";
import { renderAdherenceAttestationPdf } from "../../lib/referral-adherence/render.js";
import { resolveOrgIdForSignedRecord } from "../../lib/storefront/signed-link-org.js";

const router: IRouter = Router();

// The fax-document URL is signed (HMAC + 1h TTL) so an attacker
// can't enumerate outreach IDs, but the route still does a DB lookup
// + PDF render per request. Cap per IP so a flood of expired/invalid
// tokens cannot run that work in a tight loop.
const faxDocumentLimiter = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

// Left/right margins and usable width for a US Letter page at 72 dpi.
const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

router.get("/fax/document/:token", faxDocumentLimiter, async (req, res) => {
  const rawToken = req.params.token;
  const token = Array.isArray(rawToken)
    ? (rawToken[0] ?? "")
    : (rawToken ?? "");
  const verified = verifyFaxDocumentToken(token);
  if (!verified.valid) {
    res.status(403).json({ error: "invalid_token" });
    return;
  }

  // Public signed-link route: there is no req.orgId. Each kind resolves
  // its OWN tenant FROM the record the token references (the one sanctioned
  // cross-tenant read), so a tenant-B fax document renders under tenant B —
  // not the seed org. Degrades to 404 when it can't resolve; never 500s a
  // signed-link fetch.

  // Appeal-letter faxes render the stored appeal PDF (claim_appeal_letters
  // row) instead of the physician cover letter. Same signed-URL posture;
  // no PHI in the URL, and the PDF bytes are never logged.
  if (verified.kind === "appeal_letter") {
    const orgId = await resolveOrgIdForSignedRecord(
      "claim_appeal_letters",
      verified.outreachId,
    );
    if (!orgId) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const result = await renderAppealPdfForLetterId(orgId, verified.outreachId);
    if (!result.ok) {
      const status = result.reason === "no_dme_organization" ? 409 : 404;
      res.status(status).json({ error: result.reason });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="appeal-letter.pdf"',
    );
    res.setHeader("Cache-Control", "no-store");
    res.end(result.pdf);
    return;
  }

  // Manual-document faxes render the staff-authored document (see
  // routes/admin/manual-documents.ts). Same signed-URL posture; no PHI
  // in the URL, and the PDF bytes are never logged.
  if (verified.kind === "manual_document") {
    const orgId = await resolveOrgIdForSignedRecord(
      "manual_documents",
      verified.outreachId,
    );
    if (!orgId) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const pdf = await renderManualDocumentForFax(
      getOrgScopedClient(orgId),
      verified.outreachId,
    );
    if (!pdf) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="document.pdf"');
    res.setHeader("Cache-Control", "no-store");
    res.end(pdf);
    return;
  }

  // Manual-document-packet faxes render the combined packet PDF (cover
  // sheet + each member document). Same signed-URL posture; no PHI in
  // the URL, and the PDF bytes are never logged.
  if (verified.kind === "manual_document_packet") {
    const orgId = await resolveOrgIdForSignedRecord(
      "manual_document_packets",
      verified.outreachId,
    );
    if (!orgId) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const pdf = await renderManualDocumentPacketForFax(
      getOrgScopedClient(orgId),
      verified.outreachId,
    );
    if (!pdf) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="packet.pdf"');
    res.setHeader("Cache-Control", "no-store");
    res.end(pdf);
    return;
  }

  // PA-request-form faxes re-render the form on demand from the composite
  // `${patientId}:${paId}` id. Deterministic projection of the PA record,
  // so re-rendering matches the CSR's download byte-for-byte.
  if (verified.kind === "pa_request") {
    const sep = verified.outreachId.indexOf(":");
    if (sep <= 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = verified.outreachId.slice(0, sep);
    const paId = verified.outreachId.slice(sep + 1);
    const orgId = await resolveOrgIdForSignedRecord(
      "prior_authorizations",
      paId,
    );
    if (!orgId) {
      res.status(404).json({ error: "prior_auth_not_found" });
      return;
    }
    // buildPaRequestPdf builds its own org-scoped client; pass the tenant
    // resolved from the prior_authorizations record the token references.
    const result = await buildPaRequestPdf(orgId, patientId, paId);
    if (!result) {
      res.status(404).json({ error: "prior_auth_not_found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="pa-request.pdf"');
    res.setHeader("Cache-Control", "no-store");
    res.end(result.pdf);
    return;
  }

  // Adherence-attestation faxes (Referral CRM Phase 3) re-render the 90-day
  // Medicare LCD L33718 attestation on demand from the composite
  // `${patientId}:${anchorDate}` id. The anchor in the token pins the same
  // 90-day therapy horizon start the worker computed (the compliant 30-day
  // window is derived from it), so the faxed PDF matches what was disclosed.
  // Same signed-URL posture; the PDF bytes are never logged.
  if (verified.kind === "adherence_attestation") {
    const sep = verified.outreachId.indexOf(":");
    if (sep <= 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = verified.outreachId.slice(0, sep);
    const anchorDate = verified.outreachId.slice(sep + 1);
    const attOrgId = await resolveOrgIdForSignedRecord("patients", patientId);
    if (!attOrgId) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const rendered = await renderAdherenceAttestationPdf(
      attOrgId,
      patientId,
      anchorDate,
    );
    if (!rendered.ok) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="adherence-attestation.pdf"',
    );
    res.setHeader("Cache-Control", "no-store");
    res.end(rendered.pdf);
    return;
  }

  // Audit-packet faxes stream the persisted packet PDF (audit_packets row's
  // object_key) to the contractor. Same signed-URL posture; bytes never logged.
  if (verified.kind === "audit_packet") {
    const orgId = await resolveOrgIdForSignedRecord(
      "audit_packets",
      verified.outreachId,
    );
    if (!orgId) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: row } = await supabase
      .from("audit_packets")
      .select("object_key")
      .eq("id", verified.outreachId)
      .limit(1)
      .maybeSingle();
    if (!row || !row.object_key) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      const storage = new ObjectStorageService();
      const file = await storage.getObjectEntityFile(row.object_key);
      const resp = await storage.downloadObject(file, 0);
      if (!resp.ok || !resp.body) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'inline; filename="audit-packet.pdf"',
      );
      res.setHeader("Cache-Control", "no-store");
      res.end(buf);
    } catch {
      res.status(404).json({ error: "not_found" });
    }
    return;
  }

  // Default: the physician cover letter, keyed by the outreach row id.
  const orgId = await resolveOrgIdForSignedRecord(
    "physician_fax_outreach",
    verified.outreachId,
  );
  if (!orgId) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const { data: row, error } = await supabase
    .from("physician_fax_outreach")
    .select("physician_name, cover_letter_text")
    .eq("id", verified.outreachId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const practiceName = await getDocumentSupplierName();
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const doc = new PDFDocument({ margin: MARGIN, size: "LETTER" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="cover-letter.pdf"');
  res.setHeader("Cache-Control", "no-store");
  doc.pipe(res);

  // ── CONFIDENTIAL banner ─────────────────────────────────────────────
  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor("#cc0000")
    .text("CONFIDENTIAL — HIPAA PROTECTED HEALTH INFORMATION", MARGIN, MARGIN, {
      width: USABLE_WIDTH,
      align: "center",
    })
    .fillColor("#000000");

  doc.moveDown(0.5);
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .stroke();
  doc.moveDown(0.8);

  // ── Practice letterhead ─────────────────────────────────────────────
  doc.fontSize(16).font("Helvetica-Bold").text(practiceName, {
    align: "left",
    width: USABLE_WIDTH,
  });
  doc
    .fontSize(10)
    .font("Helvetica")
    .text("Home Medical Equipment & CPAP Supply Services", {
      align: "left",
      width: USABLE_WIDTH,
    });

  doc.moveDown(1.2);

  // ── Date & RE line ──────────────────────────────────────────────────
  doc.fontSize(11).font("Helvetica").text(`Date: ${today}`, {
    align: "left",
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.5);
  doc
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(`RE: Prescription Renewal Request`, {
      align: "left",
      width: USABLE_WIDTH,
    })
    .font("Helvetica");

  doc.moveDown(0.5);
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");

  doc.moveDown(1);

  // ── Cover letter body ───────────────────────────────────────────────
  doc.fontSize(11).font("Helvetica").text(row.cover_letter_text, {
    align: "left",
    width: USABLE_WIDTH,
    lineGap: 4,
  });

  // ── HIPAA footer ────────────────────────────────────────────────────
  const footerY = 720; // ~1 inch from bottom of US Letter
  doc
    .moveTo(MARGIN, footerY)
    .lineTo(PAGE_WIDTH - MARGIN, footerY)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");

  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#555555")
    .text(
      "This facsimile contains confidential information protected under HIPAA. " +
        "It is intended only for the named recipient. If you received this fax in error, " +
        "please destroy it immediately and notify the sender.",
      MARGIN,
      footerY + 6,
      { width: USABLE_WIDTH, align: "center" },
    )
    .fillColor("#000000");

  doc.end();
});

export default router;
