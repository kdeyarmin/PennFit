// HIPAA §164.528 accounting-of-disclosures PDF generator.
//
// A patient who exercises their §164.528 right gets a written record
// of every PHI disclosure made for non-TPO purposes within the
// requested date window (default 6 years per §164.528(a)(2)).
//
// This module:
//   * shapes the entries into per-disclosure rows the PDF renders,
//   * paginates when the entry count overflows a single page,
//   * stamps the cover sheet with the patient identity + window +
//     authoring DME organization (mirroring appeal-pdf's letterhead
//     posture).
//
// The actual row fetch lives in lib/compliance/disclosure-logger.ts —
// this module is a pure renderer.
//
// PHI posture: the rendered PDF carries PHI by design (this is the
// patient's own record being delivered to them). Caller streams it
// back over an authenticated channel + records an audit row.

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

import type { DisclosurePurpose } from "@workspace/resupply-db";

export interface DisclosureAccountingEntry {
  id: string;
  recipientName: string;
  recipientAddress: string | null;
  purpose: DisclosurePurpose;
  description: string;
  legalAuthority: string | null;
  /** ISO timestamp. */
  disclosedAt: string;
}

export interface DisclosureAccountingInput {
  patientName: string;
  patientDateOfBirth: string | null;
  /** Inclusive window start (YYYY-MM-DD). Null when the full 6-year
   *  window is being delivered. */
  windowStart: string | null;
  /** Inclusive window end (YYYY-MM-DD). */
  windowEnd: string;
  entries: readonly DisclosureAccountingEntry[];
  dmeOrganization: {
    legalName: string;
    addressLine1: string;
    city: string;
    state: string;
    zip: string;
    phoneE164: string;
    billingEmail: string;
  };
  /** Compliance officer / privacy contact who authored the response. */
  signerName: string;
  signerTitle: string;
}

const PURPOSE_LABELS: Record<DisclosurePurpose, string> = {
  public_health: "Public health activities",
  health_oversight: "Health oversight activities",
  judicial_administrative: "Judicial or administrative proceeding",
  law_enforcement: "Law enforcement purposes",
  decedents: "Decedents (coroner / funeral director)",
  cadaveric_organ_eye_tissue: "Cadaveric organ, eye, or tissue donation",
  research: "Research (per §164.512(i))",
  serious_threat: "Serious threat to health or safety",
  specialized_government: "Specialized government functions",
  workers_compensation: "Workers' compensation",
  reporting_abuse_or_neglect: "Reporting abuse, neglect, or domestic violence",
  fda_product_safety: "FDA-regulated product safety",
  other: "Other",
};

export function purposeLabel(p: DisclosurePurpose): string {
  return PURPOSE_LABELS[p];
}

export async function renderDisclosureAccountingPdf(
  input: DisclosureAccountingInput,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawAccounting(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawAccounting(
  doc: PDFKit.PDFDocument,
  input: DisclosureAccountingInput,
): void {
  // ── Letterhead ──
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .text(input.dmeOrganization.legalName);
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(input.dmeOrganization.addressLine1)
    .text(
      `${input.dmeOrganization.city}, ${input.dmeOrganization.state} ${input.dmeOrganization.zip}`,
    )
    .text(input.dmeOrganization.phoneE164)
    .text(input.dmeOrganization.billingEmail);
  doc.moveDown(1.5);

  // ── Title ──
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .text("HIPAA Accounting of Disclosures");
  doc
    .font("Helvetica")
    .fontSize(9)
    .text(
      "Prepared pursuant to 45 CFR §164.528. Disclosures of protected " +
        "health information made for purposes other than treatment, " +
        "payment, or healthcare operations.",
      { align: "left" },
    );
  doc.moveDown(1);

  // ── Patient + window block ──
  doc.font("Helvetica-Bold").fontSize(10).text("Patient:");
  doc.font("Helvetica").fontSize(10).text(`  ${input.patientName}`);
  if (input.patientDateOfBirth) {
    doc.font("Helvetica-Bold").text("Date of Birth:");
    doc.font("Helvetica").text(`  ${input.patientDateOfBirth}`);
  }
  doc.font("Helvetica-Bold").text("Window:");
  doc
    .font("Helvetica")
    .text(
      `  ${input.windowStart ?? "(earliest on record)"} through ${input.windowEnd}`,
    );
  doc.font("Helvetica-Bold").text("Report Generated:");
  doc.font("Helvetica").text(`  ${new Date().toISOString().slice(0, 10)}`);
  doc.moveDown(1);

  // ── Entries ──
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(`Disclosures (${input.entries.length}):`);
  doc.moveDown(0.5);

  if (input.entries.length === 0) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(10)
      .text(
        "No accountable disclosures of protected health information were " +
          "made during this window.",
      );
  } else {
    for (let i = 0; i < input.entries.length; i++) {
      drawEntry(doc, i + 1, input.entries[i]!);
    }
  }
  doc.moveDown(2);

  // ── Closing + signer ──
  doc
    .font("Helvetica")
    .fontSize(10)
    .text(
      "If you believe a disclosure listed here was made in error, or wish " +
        "to discuss any item, please contact our Privacy Officer using the " +
        "contact information above.",
      { align: "left" },
    );
  doc.moveDown(2);
  doc.text("Sincerely,");
  doc.moveDown(2);
  doc.text(input.signerName);
  doc.text(input.signerTitle);
  doc.text(input.dmeOrganization.legalName);
}

function drawEntry(
  doc: PDFKit.PDFDocument,
  n: number,
  entry: DisclosureAccountingEntry,
): void {
  // Page-break guard: each entry is ~5-7 lines; ask the doc to wrap
  // if we're too close to the bottom margin.
  const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
  if (remaining < 110) doc.addPage();

  doc.font("Helvetica-Bold").fontSize(10).text(`${n}.  ${formatDate(entry.disclosedAt)}`);
  doc.font("Helvetica").fontSize(10);
  doc.text(`    Recipient:   ${entry.recipientName}`);
  if (entry.recipientAddress) {
    doc.text(`    Address:     ${entry.recipientAddress}`);
  }
  doc.text(`    Purpose:     ${purposeLabel(entry.purpose)}`);
  doc.text(`    Description: ${entry.description}`);
  if (entry.legalAuthority) {
    doc.text(`    Authority:   ${entry.legalAuthority}`);
  }
  doc.moveDown(0.5);
}

function formatDate(iso: string): string {
  // MM/DD/YYYY — readable for patients regardless of region.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}
