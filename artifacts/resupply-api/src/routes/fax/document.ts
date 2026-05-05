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

router.get("/fax/document/:token", async (req, res) => {
  const token = req.params.token ?? "";
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

  const doc = new PDFDocument({ margin: 72, size: "LETTER" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="cover-letter.pdf"');
  doc.pipe(res);

  const practiceName =
    process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";

  doc
    .fontSize(13)
    .font("Helvetica-Bold")
    .text(`${practiceName}`, { align: "left" });
  doc.moveDown(0.3);
  doc
    .fontSize(11)
    .font("Helvetica")
    .text(`RE: Prescription Renewal Request — ${row.physicianName}`, {
      align: "left",
    });
  doc.moveDown(1);
  doc.moveTo(72, doc.y).lineTo(540, doc.y).stroke();
  doc.moveDown(1);
  doc.fontSize(11).font("Helvetica").text(row.coverLetterText, {
    align: "left",
    lineGap: 4,
  });

  doc.end();
});

export default router;
