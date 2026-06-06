// Signed patient-packet PDF generator.
//
// Renders every document in a completed packet into a single PDF with
// a cover page, each document's structured content, and a signature
// certificate page that records the ESIGN/UETA audit trail (typed
// name, drawn signature image, consent, IP, user-agent, timestamps).
// Streamed to the admin on demand; nothing about the signature image
// is ever written to the application logger.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

import {
  getPacketTemplate,
  type CompanyProfile,
  type PacketDocumentSection,
} from "./templates";

export interface PacketPdfDocument {
  documentKey: string;
  title: string;
  requiresSignature: boolean;
}

export interface PacketPdfSignature {
  signerName: string;
  signerRelationship: string;
  signatureImage: string | null; // PNG data URL
  consentEsign: boolean;
  signedAt: string | null;
  signerIp: string | null;
  signerUserAgent: string | null;
}

export interface PacketPdfInput {
  packetId: string;
  title: string;
  company: CompanyProfile;
  patient: {
    name: string;
    dateOfBirth?: string | null;
  };
  status: string;
  sentAt: string | null;
  completedAt: string | null;
  documents: PacketPdfDocument[];
  signature: PacketPdfSignature | null;
}

export interface PacketPdfResult {
  pdf: Buffer;
  pageCount: number;
}

const PAGE_WIDTH = 504; // LETTER (612) minus 54pt margins each side

export async function renderPatientPacketPdf(
  input: PacketPdfInput,
): Promise<PacketPdfResult> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 64, bottom: 56, left: 54, right: 54 },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => {
      resolve({
        pdf: Buffer.concat(chunks),
        pageCount: doc.bufferedPageRange().count,
      });
    });
    doc.on("error", reject);
    try {
      drawPacket(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawHeading(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a").text(text);
  doc.moveDown(0.3);
  doc.fillColor("#000000");
}

function drawSections(
  doc: PDFKit.PDFDocument,
  sections: PacketDocumentSection[],
): void {
  for (const section of sections) {
    if (section.heading) drawHeading(doc, section.heading);
    for (const p of section.paragraphs ?? []) {
      doc.font("Helvetica").fontSize(10).fillColor("#1f2937").text(p, {
        align: "left",
        lineGap: 2,
        width: PAGE_WIDTH,
      });
      doc.moveDown(0.5);
    }
    if (section.bullets && section.bullets.length > 0) {
      for (const b of section.bullets) {
        doc
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#1f2937")
          .text(`•  ${b}`, { indent: 10, lineGap: 2, width: PAGE_WIDTH });
        doc.moveDown(0.2);
      }
      doc.moveDown(0.3);
    }
  }
  doc.fillColor("#000000");
}

function drawPacket(doc: PDFKit.PDFDocument, input: PacketPdfInput): void {
  const { company } = input;

  // ── Cover page ──
  doc
    .font("Helvetica-Bold")
    .fontSize(18)
    .fillColor("#0f172a")
    .text(company.legalName);
  doc.font("Helvetica").fontSize(9).fillColor("#475569");
  if (company.addressLine1) doc.text(company.addressLine1);
  if (company.cityStateZip) doc.text(company.cityStateZip);
  doc.text(`${company.phone}  •  ${company.email}`);
  if (company.npi) doc.text(`NPI: ${company.npi}`);

  doc.moveDown(1.5);
  doc
    .font("Helvetica-Bold")
    .fontSize(15)
    .fillColor("#0f172a")
    .text(input.title);
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(10).fillColor("#1f2937");
  doc.text(`Patient: ${input.patient.name}`);
  if (input.patient.dateOfBirth)
    doc.text(`Date of birth: ${input.patient.dateOfBirth}`);
  doc.text(`Packet ID: ${input.packetId}`);
  doc.text(`Status: ${input.status}`);
  if (input.sentAt) doc.text(`Sent: ${formatDate(input.sentAt)}`);
  if (input.completedAt)
    doc.text(`Completed: ${formatDate(input.completedAt)}`);

  doc.moveDown(1);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#0f172a")
    .text("Documents in this packet");
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10).fillColor("#1f2937");
  input.documents.forEach((d, i) => {
    doc.text(
      `${i + 1}.  ${d.title}${d.requiresSignature ? "" : "  (informational)"}`,
    );
  });

  // ── One page per document ──
  for (const d of input.documents) {
    const template = getPacketTemplate(d.documentKey);
    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a").text(d.title);
    doc.moveDown(0.5);
    if (template) {
      drawSections(doc, template.build(company));
    } else {
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#1f2937")
        .text("Document content is unavailable.");
    }
  }

  // ── Signature certificate page ──
  doc.addPage();
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor("#0f172a")
    .text("Electronic Signature Certificate");
  doc.moveDown(0.5);
  const sig = input.signature;
  if (!sig) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#b45309")
      .text("This packet has not been signed.");
    return;
  }

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#1f2937")
    .text(
      `The following individual reviewed each document in this packet and affirmatively consented to sign electronically under the federal ESIGN Act and applicable state UETA. Their electronic signature has the same legal effect as a handwritten signature.`,
      { width: PAGE_WIDTH, lineGap: 2 },
    );
  doc.moveDown(0.8);

  const rows: Array<[string, string]> = [
    ["Signed by", sig.signerName],
    ["Relationship to patient", humanizeRelationship(sig.signerRelationship)],
    ["ESIGN consent given", sig.consentEsign ? "Yes" : "No"],
    ["Signed at", sig.signedAt ? formatDateTime(sig.signedAt) : "—"],
    ["IP address", sig.signerIp ?? "—"],
    ["Device", truncate(sig.signerUserAgent ?? "—", 90)],
  ];
  for (const [label, value] of rows) {
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#334155")
      .text(`${label}: `, {
        continued: true,
      });
    doc.font("Helvetica").fillColor("#1f2937").text(value);
  }

  doc.moveDown(1);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#334155")
    .text("Signature");
  doc.moveDown(0.3);
  const embedded = embedSignatureImage(doc, sig.signatureImage);
  if (!embedded) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(12)
      .fillColor("#0f172a")
      .text(sig.signerName);
  }
  doc
    .moveTo(doc.x, doc.y + 6)
    .lineTo(doc.x + 240, doc.y + 6)
    .strokeColor("#94a3b8")
    .stroke();
}

function embedSignatureImage(
  doc: PDFKit.PDFDocument,
  dataUrl: string | null,
): boolean {
  if (!dataUrl) return false;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/u.exec(
    dataUrl.trim(),
  );
  if (!match) return false;
  try {
    const buf = Buffer.from(match[1], "base64");
    // Defensive cap — a legitimate signature is well under this.
    if (buf.length === 0 || buf.length > 2_000_000) return false;
    doc.image(buf, { fit: [240, 80] });
    return true;
  } catch {
    return false;
  }
}

function humanizeRelationship(r: string): string {
  return r
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
