// GET /fax/document/:token — serves the physician cover letter as a PDF.
//
// Twilio fetches this URL immediately after the dispatch call so it can
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
//     sufficient; logging every Twilio fetch would add noise without value.

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import PDFDocument from "pdfkit";

import { getDbPool, physicianFaxOutreach } from "@workspace/resupply-db";

import { verifyFaxDocumentToken } from "../../lib/fax-document-token.js";

const router: IRouter = Router();

// Left/right margins and usable width for a US Letter page at 72 dpi.
const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

router.get("/fax/document/:token", async (req, res) => {
  const rawToken = req.params.token;
  const token = Array.isArray(rawToken)
    ? (rawToken[0] ?? "")
    : (rawToken ?? "");
  const verified = verifyFaxDocumentToken(token);
  if (!verified.valid) {
    res.status(403).json({ error: "invalid_token" });
    return;
  }

  const db = drizzle(getDbPool());
  const [row] = await db
    .select({
      physicianName: physicianFaxOutreach.physicianName,
      coverLetterText: physicianFaxOutreach.coverLetterText,
    })
    .from(physicianFaxOutreach)
    .where(eq(physicianFaxOutreach.id, verified.outreachId))
    .limit(1);

  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const practiceName =
    process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";
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
  doc.fontSize(11).font("Helvetica").text(row.coverLetterText, {
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
