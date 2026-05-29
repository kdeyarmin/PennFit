// CMS-1500 (HCFA-1500) paper claim PDF generator.
//
// The CMS-1500 02/12 form is the universal paper claim form for
// professional (Part B / commercial / Medicaid) services. We render
// it as a single-page Letter-sized PDF using pdfkit (already a
// runtime dependency for swo / compliance attestations).
//
// Layout
// ------
// The official form has a fixed 33-box layout. Box coordinates below
// reflect the public CMS sample on a 8.5"x11" page measured in
// points (1pt = 1/72"). Coordinates are approximate — they aim for
// "good enough to scan via OCR on the payer end", not pixel-perfect
// alignment with the pre-printed red-ink form (which the payer can
// inkjet-substitute).
//
// PHI posture: the PDF carries PHI in the rendered fields. The caller
// streams it back to the requesting admin and does NOT persist a copy.
// Add object-storage persistence in a later PR if the audit requirement
// firms up.

import type PDFKit from "pdfkit";
import PDFDocument from "pdfkit";

export interface Hcfa1500Input {
  /** Box 1 — payer type checkboxes. */
  insuranceType:
    | "medicare"
    | "medicaid"
    | "tricare"
    | "champva"
    | "group_health"
    | "feca"
    | "other";
  /** Box 1a — insured's id number. */
  insuredIdNumber: string;
  /** Box 2 — patient name. */
  patientLastName: string;
  patientFirstName: string;
  patientMiddleInitial?: string | null;
  /** Box 3 — patient DOB + sex. */
  patientDateOfBirth: string; // YYYY-MM-DD
  patientSex: "M" | "F" | "U";
  /** Box 4 — insured name (when different from patient). */
  insuredName: string;
  /** Box 5 — patient address. */
  patientAddress: PostalAddress;
  /** Box 6 — relationship to insured. */
  relationship: "self" | "spouse" | "child" | "other";
  /** Box 7 — insured's address. */
  insuredAddress: PostalAddress;
  /** Box 11 — insured's policy or group number. */
  policyOrGroupNumber: string;
  /** Box 11c — insurance plan name. */
  payerName: string;
  /** Phase 14 — payer's published claims_mailing_address from the
   *  payer profile. Rendered as a small "MAIL TO" block above the
   *  header so the operator can address the envelope without
   *  cross-referencing the payer manual. Null when unknown. */
  payerMailingAddress?: PostalAddress | null;
  /** Box 17 — referring / ordering / prescribing provider. */
  referringProviderName?: string | null;
  /** Box 17b — referring provider NPI. */
  referringProviderNpi?: string | null;
  /** Box 21 — diagnosis pointers (ICD-10). Up to 12. */
  diagnosisCodes: string[];
  /** Box 23 — prior auth number. */
  priorAuthNumber?: string | null;
  /** Box 24 — service line table (up to 6 lines per page). */
  serviceLines: Hcfa1500ServiceLine[];
  /** Box 25 — federal tax id (EIN). */
  taxId: string;
  /** Box 28 — total charges. */
  totalChargeCents: number;
  /** Box 31 — provider signature line text. */
  signatureOnFile: string;
  /** Box 33 — billing provider info. */
  billingProviderName: string;
  billingProviderAddress: PostalAddress;
  billingProviderNpi: string;
  billingProviderPhoneE164: string;
}

export interface PostalAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}

export interface Hcfa1500ServiceLine {
  /** Box 24A from / to dates of service (YYYY-MM-DD). */
  fromDate: string;
  toDate: string;
  /** Box 24B place of service. */
  placeOfService: string;
  /** Box 24D HCPCS + modifiers. */
  hcpcsCode: string;
  modifiers: string[];
  /** Box 24E diagnosis pointer (a..l). */
  diagnosisPointer: string;
  /** Box 24F charge (cents). */
  chargesCents: number;
  /** Box 24G days/units. */
  units: number;
}

/**
 * Render a CMS-1500 (HCFA) form as a PDF stream. Returns a thenable
 * Buffer; callers `await` and pipe the buffer into the HTTP response.
 */
export async function renderHcfa1500Pdf(input: Hcfa1500Input): Promise<Buffer> {
  // pdfkit's typings use the older constructor signature; we use the
  // value side directly here. The cast is unavoidable in TS strict
  // until pdfkit publishes its modern .d.ts.
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 36, bottom: 36, left: 36, right: 36 },
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawHcfa(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawHcfa(doc: PDFKit.PDFDocument, input: Hcfa1500Input): void {
  // ── Header ──
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("HEALTH INSURANCE CLAIM FORM", 36, 36)
    .font("Helvetica")
    .fontSize(8)
    .text("APPROVED OMB-0938-1197  FORM 1500 (02-12)", 36, 50);

  // ── Phase 14 — operator MAIL TO block (top right) ──
  // The HCFA-1500 form proper doesn't have a payer-address box; this
  // is a margin annotation for the CSR who'll envelope this page,
  // populated from the payer profile's claims_mailing_address.
  if (input.payerMailingAddress) {
    doc.font("Helvetica-Bold").fontSize(8).text("MAIL TO:", 440, 36);
    doc.font("Helvetica").fontSize(8);
    drawAddress(doc, 440, 48, input.payerMailingAddress);
  }

  // ── Box 1: insurance type ──
  drawLabel(doc, 36, 70, "1. INSURANCE");
  doc
    .fontSize(9)
    .text(input.insuranceType.replace(/_/g, " ").toUpperCase(), 110, 70);

  // ── Box 1a: insured's id ──
  drawLabel(doc, 360, 70, "1a. INSURED'S I.D. NUMBER");
  doc.fontSize(10).text(input.insuredIdNumber, 360, 84);

  // ── Box 2: patient name ──
  drawLabel(doc, 36, 100, "2. PATIENT'S NAME (Last, First, MI)");
  const patientName = [
    input.patientLastName,
    input.patientFirstName,
    input.patientMiddleInitial,
  ]
    .filter(Boolean)
    .join(", ");
  doc.fontSize(10).text(patientName, 36, 114);

  // ── Box 3: DOB + sex ──
  drawLabel(doc, 260, 100, "3. PATIENT'S BIRTH DATE / SEX");
  doc
    .fontSize(10)
    .text(
      `${formatHcfaDate(input.patientDateOfBirth)}   ${input.patientSex}`,
      260,
      114,
    );

  // ── Box 4: insured's name ──
  drawLabel(doc, 360, 100, "4. INSURED'S NAME");
  doc.fontSize(10).text(input.insuredName, 360, 114);

  // ── Box 5: patient address ──
  drawLabel(doc, 36, 140, "5. PATIENT'S ADDRESS");
  drawAddress(doc, 36, 154, input.patientAddress);

  // ── Box 6: relationship ──
  drawLabel(doc, 260, 140, "6. PATIENT RELATIONSHIP TO INSURED");
  doc.fontSize(10).text(input.relationship.toUpperCase(), 260, 154);

  // ── Box 7: insured's address ──
  drawLabel(doc, 360, 140, "7. INSURED'S ADDRESS");
  drawAddress(doc, 360, 154, input.insuredAddress);

  // ── Box 11: policy / group number + plan name ──
  drawLabel(doc, 36, 220, "11. INSURED'S POLICY/GROUP NUMBER");
  doc.fontSize(10).text(input.policyOrGroupNumber, 36, 234);
  drawLabel(doc, 260, 220, "11c. INSURANCE PLAN NAME");
  doc.fontSize(10).text(input.payerName, 260, 234);

  // ── Box 17 / 17b: referring provider ──
  if (input.referringProviderName) {
    drawLabel(doc, 36, 268, "17. NAME OF REFERRING PROVIDER");
    doc.fontSize(10).text(input.referringProviderName, 36, 282);
  }
  if (input.referringProviderNpi) {
    drawLabel(doc, 360, 268, "17b. NPI");
    doc.fontSize(10).text(input.referringProviderNpi, 360, 282);
  }

  // ── Box 21: diagnosis codes ──
  drawLabel(doc, 36, 312, "21. DIAGNOSIS OR NATURE OF ILLNESS (ICD-10)");
  const dxStartY = 326;
  input.diagnosisCodes.slice(0, 12).forEach((dx, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    doc
      .fontSize(9)
      .text(
        `${String.fromCharCode(65 + i)}. ${dx}`,
        36 + col * 130,
        dxStartY + row * 14,
      );
  });

  // ── Box 23: prior auth ──
  if (input.priorAuthNumber) {
    drawLabel(doc, 36, 380, "23. PRIOR AUTHORIZATION NUMBER");
    doc.fontSize(10).text(input.priorAuthNumber, 36, 394);
  }

  // ── Box 24: service lines table ──
  drawLabel(doc, 36, 420, "24. SERVICE LINES");
  const tableTop = 436;
  doc.fontSize(7).font("Helvetica-Bold");
  doc.text("DATE(S) OF SERVICE", 36, tableTop);
  doc.text("POS", 180, tableTop);
  doc.text("CPT/HCPCS", 210, tableTop);
  doc.text("MOD", 280, tableTop);
  doc.text("DX PTR", 330, tableTop);
  doc.text("CHARGES", 380, tableTop);
  doc.text("UNITS", 460, tableTop);
  doc.font("Helvetica");
  const rowHeight = 18;
  input.serviceLines.slice(0, 6).forEach((line, i) => {
    const y = tableTop + 12 + i * rowHeight;
    doc
      .fontSize(9)
      .text(
        `${formatHcfaDate(line.fromDate)}-${formatHcfaDate(line.toDate)}`,
        36,
        y,
      );
    doc.text(line.placeOfService, 180, y);
    doc.text(line.hcpcsCode, 210, y);
    doc.text(line.modifiers.join(",") || "-", 280, y);
    doc.text(line.diagnosisPointer || "A", 330, y);
    doc.text(centsToDollars(line.chargesCents), 380, y);
    doc.text(String(line.units), 460, y);
  });

  // ── Box 25: tax id ──
  drawLabel(doc, 36, 580, "25. FEDERAL TAX I.D.");
  doc.fontSize(10).text(input.taxId, 36, 594);

  // ── Box 28: total charges ──
  drawLabel(doc, 260, 580, "28. TOTAL CHARGE");
  doc.fontSize(10).text(`$${centsToDollars(input.totalChargeCents)}`, 260, 594);

  // ── Box 31: provider signature ──
  drawLabel(doc, 36, 630, "31. SIGNATURE OF PHYSICIAN OR SUPPLIER");
  doc.fontSize(10).text(input.signatureOnFile, 36, 644);

  // ── Box 33: billing provider ──
  drawLabel(doc, 36, 680, "33. BILLING PROVIDER INFO & PH#");
  doc.fontSize(10).text(input.billingProviderName, 36, 694);
  drawAddress(doc, 36, 708, input.billingProviderAddress);
  doc.fontSize(9).text(`PH: ${input.billingProviderPhoneE164}`, 36, 752);
  doc.fontSize(9).text(`NPI: ${input.billingProviderNpi}`, 200, 752);
}

function drawLabel(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  text: string,
): void {
  doc.font("Helvetica-Bold").fontSize(7).text(text, x, y).font("Helvetica");
}

function drawAddress(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  a: PostalAddress,
): void {
  doc.fontSize(9).text(a.line1, x, y);
  if (a.line2) doc.text(a.line2, x, y + 12);
  doc.text(`${a.city}, ${a.state} ${a.zip}`, x, y + (a.line2 ? 24 : 12));
}

function formatHcfaDate(iso: string): string {
  // MM/DD/YYYY — matches the printed form's date fields.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function centsToDollars(cents: number): string {
  // No `$` prefix here — HCFA-1500 box format is bare numeric.
  // Still need sign-correct handling for adjustments / take-backs
  // (otherwise -150 cents prints as "-2.-50" inside the box).
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const d = Math.floor(abs / 100);
  const c = abs % 100;
  return `${sign}${d}.${c.toString().padStart(2, "0")}`;
}
