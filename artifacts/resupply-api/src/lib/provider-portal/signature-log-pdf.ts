// Provider signature-log / e-signature-certificate PDF renderer.
//
// Produces the printable, sendable document an employee gives to a
// payer / Medicare auditor to attest that a provider's typed e-signature
// IS their legal signature. Two scopes share one renderer:
//
//   * "certificate" — one signed document, with its full event chain.
//   * "log"         — every signed document for a provider, each with a
//     chain-integrity verdict.
//
// The document states the ESIGN/CMS attestation, the captured signer
// identity (typed name + NPI + consent), the signing timestamp + IP,
// and the tamper-evidence verdict from the hash-chained event log
// (lib/provider-portal/signature-events.ts). Bytes are streamed, never
// logged.
//
// Same PDFKit pattern as lib/manual-documents/pdf.ts.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

const MARGIN = 60;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

export interface SignatureLogEvent {
  seq: number;
  eventType: string;
  actorKind: string;
  actorEmail: string | null;
  occurredAt: string;
  eventHash: string;
}

export interface SignatureLogItem {
  title: string;
  subjectLabel: string;
  patientName: string | null;
  status: string;
  signedAt: string | null;
  signerName: string | null;
  signerTitle: string | null;
  signerNpi: string | null;
  signatureStatement: string | null;
  signerIp: string | null;
  consentEsign: boolean;
  events: SignatureLogEvent[];
  /** Result of verifySignatureChain over `events`. */
  chainOk: boolean;
}

export interface SignatureLogInput {
  scope: "certificate" | "log";
  practiceName: string;
  provider: {
    legalName: string;
    npi: string | null;
    practiceName: string | null;
  };
  generatedOn: Date;
  generatedByEmail: string | null;
  items: SignatureLogItem[];
}

export async function renderSignatureLogPdf(
  input: SignatureLogInput,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawSignatureLog(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawSignatureLog(
  doc: PDFKit.PDFDocument,
  input: SignatureLogInput,
): void {
  doc.y = MARGIN;
  // ── Letterhead ──────────────────────────────────────────────────
  doc
    .fontSize(15)
    .font("Helvetica-Bold")
    .text(input.practiceName, { width: USABLE_WIDTH });
  doc
    .fontSize(16)
    .font("Helvetica-Bold")
    .text(
      input.scope === "certificate"
        ? "Electronic Signature Certificate"
        : "Provider Electronic Signature Log",
      { width: USABLE_WIDTH },
    );
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#555555")
    .text(
      `Generated ${formatDateTime(input.generatedOn)}` +
        (input.generatedByEmail ? ` by ${input.generatedByEmail}` : ""),
      { width: USABLE_WIDTH },
    )
    .fillColor("#000000");
  doc.moveDown(0.6);
  rule(doc);
  doc.moveDown(0.6);

  // ── Provider block ──────────────────────────────────────────────
  header(doc, "Provider");
  field(doc, "Name", input.provider.legalName);
  if (input.provider.npi) field(doc, "NPI", input.provider.npi);
  if (input.provider.practiceName) {
    field(doc, "Practice", input.provider.practiceName);
  }
  doc.moveDown(0.5);

  // ── Compliance attestation ──────────────────────────────────────
  header(doc, "Attestation");
  doc
    .fontSize(9.5)
    .font("Helvetica")
    .text(
      "The provider named above holds a credentialed account in this " +
        "supplier's secure provider portal, protected by a unique password " +
        "and mandatory multi-factor authentication. Each signature below was " +
        "applied by that authenticated provider by typing their legal name " +
        "and affirmatively consenting that the typed name constitutes their " +
        "legal electronic signature — the legal equivalent of a handwritten " +
        "signature under the federal ESIGN Act (15 U.S.C. ch. 96) and CMS / " +
        "Medicare electronic-signature requirements. Every signature event is " +
        "recorded in a tamper-evident, hash-chained audit log; the integrity " +
        "verdict for each document is shown below.",
      { width: USABLE_WIDTH, lineGap: 2 },
    );
  doc.moveDown(0.6);
  rule(doc);
  doc.moveDown(0.6);

  // ── Items ───────────────────────────────────────────────────────
  if (input.items.length === 0) {
    doc
      .fontSize(10)
      .font("Helvetica-Oblique")
      .text("No signed documents for this provider.", { width: USABLE_WIDTH });
    return;
  }

  input.items.forEach((item, idx) => {
    if (idx > 0) {
      doc.moveDown(0.5);
      rule(doc);
      doc.moveDown(0.5);
    }
    maybePageBreak(doc, 160);
    doc
      .fontSize(11)
      .font("Helvetica-Bold")
      .text(`${idx + 1}. ${item.title}`, { width: USABLE_WIDTH });
    doc.moveDown(0.2);
    field(doc, "Document type", item.subjectLabel);
    if (item.patientName) field(doc, "Patient", item.patientName);
    field(doc, "Status", item.status);
    if (item.signedAt) field(doc, "Signed", formatDateTime(item.signedAt));
    if (item.signerName) {
      field(
        doc,
        "Signed by",
        item.signerName + (item.signerTitle ? `, ${item.signerTitle}` : ""),
      );
    }
    if (item.signerNpi) field(doc, "Signer NPI", item.signerNpi);
    field(doc, "ESIGN consent", item.consentEsign ? "Yes" : "No");
    if (item.signerIp) field(doc, "Signed from IP", item.signerIp);
    field(
      doc,
      "Audit-chain integrity",
      item.chainOk ? "VERIFIED — unbroken" : "FAILED — chain broken",
    );

    if (item.signatureStatement) {
      doc.moveDown(0.2);
      doc
        .fontSize(8.5)
        .font("Helvetica-Oblique")
        .fillColor("#333333")
        .text(`"${item.signatureStatement}"`, {
          width: USABLE_WIDTH,
          lineGap: 1,
        })
        .fillColor("#000000");
    }

    // Event chain table (compact).
    if (item.events.length > 0) {
      doc.moveDown(0.3);
      doc
        .fontSize(8.5)
        .font("Helvetica-Bold")
        .text("Audit trail", { width: USABLE_WIDTH });
      for (const ev of item.events) {
        maybePageBreak(doc, 24);
        doc
          .fontSize(8)
          .font("Helvetica")
          .text(
            `#${ev.seq}  ${formatDateTime(ev.occurredAt)}  ${ev.eventType}` +
              ` (${ev.actorKind}${ev.actorEmail ? ` · ${ev.actorEmail}` : ""})` +
              `  sha256:${ev.eventHash.slice(0, 16)}…`,
            { width: USABLE_WIDTH },
          );
      }
    }
  });
}

function maybePageBreak(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > 740) doc.addPage();
}

function header(doc: PDFKit.PDFDocument, label: string): void {
  doc
    .fontSize(11)
    .font("Helvetica-Bold")
    .fillColor("#1a2a4a")
    .text(label, { width: USABLE_WIDTH })
    .fillColor("#000000");
  doc.moveDown(0.2);
}

function field(doc: PDFKit.PDFDocument, label: string, value: string): void {
  doc
    .fontSize(9.5)
    .font("Helvetica-Bold")
    .text(`${label}: `, { continued: true, width: USABLE_WIDTH });
  doc.font("Helvetica").text(value, { width: USABLE_WIDTH });
  doc.moveDown(0.1);
}

function rule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");
}

function formatDateTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
