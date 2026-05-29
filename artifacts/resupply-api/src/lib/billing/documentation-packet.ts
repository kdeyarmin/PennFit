// Documentation packet PDF generator.
//
// Combines multiple per-document summaries into a single
// fax-/mail-ready PDF the CSR sends with a PA submission or appeal.
//
// Today's contents (per `kind`):
//   prior_auth_support:
//     - Cover letter
//     - Patient summary (initials + DOB year + Rx HCPCS list)
//     - Sleep study summary (most recent with diagnosis)
//     - Compliance attestation summary (last 30-day window)
//     - Prescription summary (active Rx)
//     - DWO summary (most recent unexpired DWO if any)
//
//   appeal_support:
//     - Cover letter (appeal-flavor)
//     - Denial summary (CARC/RARC + denial reason)
//     - Everything from prior_auth_support
//
//   accreditation_audit:
//     - Cover letter
//     - Readiness-run summary
//     - Recent training records summary
//
//   medical_records_request:
//     - Cover letter
//     - Patient summary
//     - Recent encounters summary (sleep studies, prescriptions)
//
// We DO NOT attempt to embed the original PDF attachments here —
// pdfkit can't merge external PDFs without pdf-lib, and that's a
// bigger dep we don't want to take on for the MVP. The packet
// references each document by id + storage key so the CSR can
// fax/mail the originals alongside the cover packet.
//
// PHI posture: full patient name + DOB are required on PA cover
// letters by every payer we work with; the PDF carries them. Same
// stream-to-requester + storage retention as the other PDFs.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

export type PacketKind =
  | "prior_auth_support"
  | "appeal_support"
  | "accreditation_audit"
  | "medical_records_request";

export interface PacketInput {
  kind: PacketKind;
  dmeOrganization: {
    legalName: string;
    addressLine1: string;
    city: string;
    state: string;
    zip: string;
    phoneE164: string;
    billingEmail: string;
    npi: string;
  };
  /** Optional addressee block — payer name, address. */
  addressee?: {
    name: string;
    addressLines?: string[];
  };
  /** Patient identity for the packet header. PA + appeal packets
   *  require full PHI by payer convention. */
  patient: {
    firstName: string;
    lastName: string;
    dateOfBirth: string; // YYYY-MM-DD
    memberId?: string | null;
    payerName?: string | null;
  };
  /** Per-section content blocks; each is rendered as a labeled
   *  paragraph + bulleted detail list. Pass null/empty sections to
   *  omit them. */
  sections: PacketSection[];
  /** Optional CSR signer override. */
  signerName?: string | null;
  signerTitle?: string | null;
  /** Free-form cover-letter body. When unset we render a default
   *  per-kind template. */
  coverLetterBody?: string | null;
}

export interface PacketSection {
  title: string;
  /** One or more paragraphs (rendered with a blank line between). */
  paragraphs: string[];
  /** Optional bulleted detail list under the paragraphs. */
  bullets?: string[];
  /** Optional document references — formatted as
   *  "Attached: <name> (object key <key>)" so the fax recipient
   *  knows which original document is in the envelope. */
  attachments?: Array<{ name: string; objectKey?: string | null }>;
}

export interface PacketResult {
  pdf: Buffer;
  pageCount: number;
}

const KIND_TITLES: Record<PacketKind, string> = {
  prior_auth_support: "Prior Authorization Support Packet",
  appeal_support: "Claim Appeal Support Packet",
  accreditation_audit: "Accreditation Audit Documentation",
  medical_records_request: "Medical Records Request Response",
};

const DEFAULT_COVER_LETTER: Record<PacketKind, string> = {
  prior_auth_support:
    "Attached are the documents supporting the prior authorization request for the above-referenced patient. Please review and respond at your earliest convenience. If additional documentation is required, contact our billing team at the address above.",
  appeal_support:
    "Attached is documentation supporting our appeal of the referenced denied claim. We respectfully request reconsideration based on the records included with this packet.",
  accreditation_audit:
    "Attached is the documentation requested for the current accreditation audit. All artifacts referenced in our policy library are included or available on request.",
  medical_records_request:
    "Attached are the medical records responsive to the referenced request. All disclosures are consistent with HIPAA §164.502(a) and the patient's signed authorization on file.",
};

export async function renderDocumentationPacket(
  input: PacketInput,
): Promise<PacketResult> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 72, bottom: 54, left: 54, right: 54 },
  });
  // Track page count via the pageAdded event. The constructor adds
  // the first page synchronously before our listener fires, so we
  // start the count at 1 to compensate.
  let pageCount = 1;
  doc.on("pageAdded", () => {
    pageCount += 1;
    drawConfidentialBanner(doc);
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => {
      resolve({
        pdf: Buffer.concat(chunks),
        pageCount,
      });
    });
    doc.on("error", reject);
    try {
      drawConfidentialBanner(doc);
      drawPacket(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawConfidentialBanner(doc: PDFKit.PDFDocument): void {
  const saved = { x: doc.x, y: doc.y };
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#7c2d12")
    .text(
      "CONFIDENTIAL — PROTECTED HEALTH INFORMATION — Disclosure restricted under 45 CFR 164.502",
      54,
      36,
      { align: "center", width: 504 },
    );
  doc.fillColor("black").font("Helvetica").fontSize(10);
  doc.x = saved.x;
  doc.y = saved.y === 36 ? 72 : saved.y;
}

function drawPacket(doc: PDFKit.PDFDocument, input: PacketInput): void {
  // ── Cover page ──
  doc.font("Helvetica-Bold").fontSize(16).text(KIND_TITLES[input.kind]);
  doc.font("Helvetica").fontSize(10).moveDown(0.5);
  doc.text(`Generated: ${new Date().toISOString().slice(0, 10)}`);
  doc.moveDown(1);

  // Issuer block
  doc.font("Helvetica-Bold").fontSize(11).text("From");
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(input.dmeOrganization.legalName)
    .text(input.dmeOrganization.addressLine1)
    .text(
      `${input.dmeOrganization.city}, ${input.dmeOrganization.state} ${input.dmeOrganization.zip}`,
    )
    .text(`NPI: ${input.dmeOrganization.npi}`)
    .text(`Phone: ${input.dmeOrganization.phoneE164}`)
    .text(`Email: ${input.dmeOrganization.billingEmail}`);
  doc.moveDown(1);

  // Addressee
  if (input.addressee) {
    doc.font("Helvetica-Bold").fontSize(11).text("To");
    doc.font("Helvetica").fontSize(10).text(input.addressee.name);
    for (const line of input.addressee.addressLines ?? []) doc.text(line);
    doc.moveDown(1);
  }

  // Patient block
  doc.font("Helvetica-Bold").fontSize(11).text("Patient");
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(`${input.patient.firstName} ${input.patient.lastName}`)
    .text(`Date of Birth: ${input.patient.dateOfBirth}`);
  if (input.patient.memberId) doc.text(`Member ID: ${input.patient.memberId}`);
  if (input.patient.payerName) doc.text(`Payer: ${input.patient.payerName}`);
  doc.moveDown(1);

  // Cover letter body
  doc
    .font("Helvetica")
    .fontSize(11)
    .text(input.coverLetterBody ?? DEFAULT_COVER_LETTER[input.kind], {
      align: "left",
      lineGap: 2,
    });
  doc.moveDown(2);

  // Signer
  doc.text("Sincerely,");
  doc.moveDown(2);
  doc.text(input.signerName ?? "Billing Team");
  doc.text(input.signerTitle ?? "Billing Department");
  doc.text(input.dmeOrganization.legalName);

  // ── Sections ── one fresh page per section so the recipient can
  // detach + file independently.
  for (const section of input.sections) {
    doc.addPage();
    doc.font("Helvetica-Bold").fontSize(13).text(section.title);
    doc.moveDown(0.5);
    for (const p of section.paragraphs) {
      doc.font("Helvetica").fontSize(10).text(p, { lineGap: 2 });
      doc.moveDown(0.5);
    }
    if (section.bullets && section.bullets.length > 0) {
      doc.moveDown(0.3);
      for (const b of section.bullets) {
        doc.fontSize(10).text(`• ${b}`, { indent: 12, lineGap: 2 });
      }
    }
    if (section.attachments && section.attachments.length > 0) {
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(10).text("Attached documents:");
      doc.font("Helvetica");
      for (const att of section.attachments) {
        doc
          .fontSize(10)
          .text(
            `  • ${att.name}${att.objectKey ? `  [object: ${att.objectKey.slice(0, 64)}]` : ""}`,
          );
      }
    }
  }
}
