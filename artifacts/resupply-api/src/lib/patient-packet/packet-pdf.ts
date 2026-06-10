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
  PROOF_OF_DELIVERY_KEY,
  type CompanyProfile,
  type DeliveryDetails,
  type PacketDocumentSection,
} from "./templates";

export interface PacketPdfDocument {
  documentKey: string;
  title: string;
  requiresSignature: boolean;
  contentVersion?: string | null;
  /**
   * Pre-resolved sections (send-time snapshot with merge tokens already
   * substituted — see content.ts). When null/absent the renderer builds
   * from the code template by key (legacy rows).
   */
  sections?: PacketDocumentSection[] | null;
}

export interface PacketPdfSignature {
  signerName: string;
  signerRelationship: string;
  signatureImage: string | null; // PNG data URL
  consentEsign: boolean;
  signedAt: string | null;
  signerIp: string | null;
  signerUserAgent: string | null;
  signerReason: string | null;
  dateReceived: string | null;
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
  deliveryDetails?: DeliveryDetails | null;
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
  const buildCtx = { deliveryDetails: input.deliveryDetails ?? null };
  for (const d of input.documents) {
    const template = getPacketTemplate(d.documentKey);
    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a").text(d.title);
    if (d.contentVersion) {
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#94a3b8")
        .text(`Document version ${d.contentVersion}`);
    }
    doc.moveDown(0.5);
    if (d.sections && d.sections.length > 0) {
      drawSections(doc, d.sections);
    } else if (template) {
      drawSections(doc, template.build(company, buildCtx));
    } else {
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#1f2937")
        .text("Document content is unavailable.");
    }
    // Each signature-required document is individually executed and
    // dated on its own page so it stands alone for an audit.
    if (d.requiresSignature && input.signature) {
      drawExecutionBlock(doc, input.signature, d.documentKey);
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
  ];
  if (sig.signerRelationship !== "self" && sig.signerReason) {
    rows.push(["Reason beneficiary did not sign", sig.signerReason]);
  }
  rows.push(["ESIGN consent given", sig.consentEsign ? "Yes" : "No"]);
  rows.push(["Signed at", sig.signedAt ? formatDateTime(sig.signedAt) : "—"]);
  if (sig.dateReceived) {
    rows.push(["Date equipment received", sig.dateReceived]);
  }
  rows.push(["IP address", sig.signerIp ?? "—"]);
  rows.push(["Device", truncate(sig.signerUserAgent ?? "—", 90)]);
  rows.push(["Verification ID", input.packetId]);
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

  // Documents covered by this signature, with their content version.
  doc.moveDown(0.8);
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("#334155")
    .text("Documents executed under this signature");
  doc.moveDown(0.2);
  for (const d of input.documents) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#1f2937")
      .text(
        `• ${d.title}${d.contentVersion ? ` (v${d.contentVersion})` : ""} — ${
          d.requiresSignature ? "reviewed & signed" : "reviewed & acknowledged"
        }`,
        { width: PAGE_WIDTH },
      );
  }

  doc.moveDown(0.8);
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#475569")
    .text(
      "This certificate evidences an electronic signature executed under the federal ESIGN Act (15 U.S.C. §7001) and applicable state UETA. The signer affirmatively consented to do business electronically and adopted the signature shown above. The captured name, date, IP address, and device, together with the per-document execution pages, satisfy the legible, dated signature and proof-of-delivery requirements applied by Medicare and commercial payers to supplier documentation.",
      { width: PAGE_WIDTH, lineGap: 1.5 },
    );

  doc.moveDown(0.8);
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

// Per-document execution block printed at the foot of each signature-
// required document so the document stands alone as executed + dated.
function drawExecutionBlock(
  doc: PDFKit.PDFDocument,
  sig: PacketPdfSignature,
  documentKey: string,
): void {
  doc.moveDown(1.2);
  doc
    .moveTo(doc.x, doc.y)
    .lineTo(doc.x + PAGE_WIDTH, doc.y)
    .strokeColor("#e2e8f0")
    .stroke();
  doc.moveDown(0.5);
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#334155")
    .text("Executed electronically");
  doc.moveDown(0.2);
  const embedded = embedSignatureImage(doc, sig.signatureImage);
  if (!embedded) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(11)
      .fillColor("#0f172a")
      .text(sig.signerName);
  }
  const rel =
    sig.signerRelationship === "self"
      ? ""
      : ` (${humanizeRelationship(sig.signerRelationship)})`;
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#1f2937")
    .text(
      `Signed by ${sig.signerName}${rel} on ${
        sig.signedAt ? formatDateTime(sig.signedAt) : "—"
      }`,
    );
  if (sig.signerRelationship !== "self" && sig.signerReason) {
    doc.text(`Reason beneficiary did not sign: ${sig.signerReason}`);
  }
  if (documentKey === PROOF_OF_DELIVERY_KEY && sig.dateReceived) {
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#334155")
      .text(`Date equipment received: ${sig.dateReceived}`);
  }
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
