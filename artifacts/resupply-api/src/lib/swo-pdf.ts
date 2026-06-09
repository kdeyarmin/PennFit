// Standard Written Order (SWO) generation — pure data projection
// + PDF render. The route in routes/admin/swo.ts orchestrates the
// data fetch and pipes the rendered PDF to the HTTP response.
//
// What an SWO is
// --------------
// Since the 2020 CMS "Standardization of Documentation Requirements"
// rule, ONE consolidated written order replaces the legacy DWO +
// CMN forms for most DMEPOS items, including CPAP. The standardized
// SWO must contain, per CMS:
//
//   1. Beneficiary name + DOB
//   2. Item description (narrative) + the relevant HCPCS code
//   3. Quantity, if applicable
//   4. Treating practitioner name + NPI
//   5. Date of the order
//   6. Practitioner signature (we leave a signature line — the
//      practitioner signs the printed copy or applies an e-signature
//      out-of-band)
//
// Diagnosis code (ICD-10) and supporting sleep-study findings are
// not required ON the SWO itself per the 2020 rule, but they ARE
// required to be in the supplier's record. We include the diagnosis
// (when present on the prescription) for completeness.
//
// What we deliberately omit
// -------------------------
//   * Medicare Beneficiary Identifier (MBI). Some suppliers print
//     it on the SWO; CMS does NOT require it on the form itself.
//     Until we store MBIs explicitly (separate from member_id),
//     leaving it off is the safer default.
//   * Length-of-need. CPAP is "indefinite" by industry convention
//     and CMS doesn't require LON on the SWO for CPAP.
//
// PHI posture
// -----------
// The PDF contains PHI; the route streams it directly to the
// authenticated admin's browser. Generation is audited (the route
// writes one `patient.swo.generated` row) but the PDF bytes never
// hit the application logger.

import type PDFKit from "pdfkit";

// Layout constants — same as fax/document.ts so the visual style
// matches across our outbound clinical documents.
const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

export interface SwoPatient {
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string;
  /** Address as stored on patients.address jsonb. */
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  } | null;
}

export interface SwoPrescription {
  itemSku: string;
  hcpcsCode: string | null;
  cadenceDays: number;
  validFrom: string;
  validUntil: string | null;
  /** Optional clinical narrative from prescriptions.details. */
  diagnosis: string | null;
  /** ICD-10 code if recorded on the most recent sleep study (or
   *  manually elsewhere; the route resolves this). */
  diagnosisIcd10: string | null;
}

export interface SwoProvider {
  legalName: string;
  npi: string;
  practiceName: string | null;
  practiceAddress: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  } | null;
  phoneE164: string | null;
  faxE164: string | null;
}

export interface SwoInputs {
  patient: SwoPatient;
  prescription: SwoPrescription;
  provider: SwoProvider;
  /** Date the SWO is being generated, formatted for the page header.
   *  Passed in (not derived inside) so tests are deterministic. */
  generatedOn: Date;
  /** Brand name on the supplier letterhead — pulled from
   *  RESUPPLY_PRACTICE_NAME at the route layer. */
  supplierName: string;
}

export interface SwoValidationError {
  field: string;
  message: string;
}

/**
 * Validate that the inputs carry the fields CMS requires on the
 * standardized SWO. Returns an array of missing-field errors;
 * empty array = the inputs can be rendered.
 *
 * The route turns a non-empty result into a 422 with the issue list,
 * so the CSR sees "fill in HCPCS code and link a provider" instead of
 * a confusing 500 from the PDF library.
 */
export function validateSwoInputs(inputs: SwoInputs): SwoValidationError[] {
  const errors: SwoValidationError[] = [];
  if (!inputs.patient.legalFirstName || !inputs.patient.legalLastName) {
    errors.push({
      field: "patient",
      message: "Patient legal name is required.",
    });
  }
  if (!inputs.patient.dateOfBirth) {
    errors.push({
      field: "patient.dateOfBirth",
      message: "Patient date of birth is required.",
    });
  }
  if (!inputs.prescription.hcpcsCode) {
    errors.push({
      field: "prescription.hcpcsCode",
      message:
        "HCPCS code is required on the prescription before an SWO can be generated.",
    });
  }
  if (!inputs.provider.npi || !/^\d{10}$/.test(inputs.provider.npi)) {
    errors.push({
      field: "provider.npi",
      message:
        "A provider with a 10-digit NPI must be linked to the prescription.",
    });
  }
  if (!inputs.provider.legalName) {
    errors.push({
      field: "provider.legalName",
      message: "Provider legal name is required.",
    });
  }
  return errors;
}

/**
 * Plain-text item description that goes alongside the HCPCS code on
 * the SWO. The SKU is what we order against in Pacware; the
 * narrative is what the practitioner reads. Best-effort: we don't
 * have a SKU→description catalog in PennFit, so we derive a
 * reasonable description from the HCPCS code (a small static map)
 * and fall back to the raw SKU when we don't recognize the code.
 *
 * Exported for the test suite + for future re-use by the
 * compliance-attestation surface.
 */
export function describeHcpcs(hcpcs: string | null, sku: string): string {
  if (!hcpcs) return sku;
  const description = describeHcpcsPlain(hcpcs);
  return description ? `${description} — SKU ${sku}` : `${hcpcs} — SKU ${sku}`;
}

/**
 * Bare plain-English narrative for a HCPCS code, with NO SKU suffix —
 * or `null` when the code isn't in our small static catalog.
 *
 * `describeHcpcs()` (above) appends `— SKU <sku>` because a printed
 * SWO benefits from carrying the order-against identifier next to the
 * narrative. Conversational surfaces (the voice agent, the chatbot)
 * want the opposite: a phrase that reads naturally aloud, so they call
 * this and fall back to the raw SKU themselves when it returns null.
 */
export function describeHcpcsPlain(hcpcs: string | null): string | null {
  if (!hcpcs) return null;
  const trimmed = hcpcs.toUpperCase().split("-")[0]!; // strip modifiers
  return HCPCS_DESCRIPTIONS[trimmed] ?? null;
}

// Common HCPCS Level II codes for CPAP/RAD therapy. Used to build
// the human-readable item description on the SWO. The list is
// intentionally small and covers the codes the seed migration
// (0070_seed_medicare_cadences.sql) names; everything else falls
// back to the raw code.
const HCPCS_DESCRIPTIONS: Record<string, string> = {
  E0601: "CPAP device, single-level continuous airway pressure",
  E0470: "BiPAP device, two-level positive airway pressure",
  E0471: "BiPAP device, two-level with backup rate",
  E0561: "Humidifier, non-heated, used with positive airway pressure",
  E0562: "Humidifier, heated, used with positive airway pressure",
  A4604: "Heated tubing for use with positive airway pressure",
  A7027: "Combination oral/nasal mask, used with CPAP",
  A7028: "Oral cushion for combination mask",
  A7029: "Nasal pillows for combination mask",
  A7030: "Full face mask, used with positive airway pressure",
  A7031: "Replacement cushion for full face mask",
  A7032: "Replacement cushion for nasal mask",
  A7033: "Replacement nasal pillows",
  A7034: "Nasal mask interface, used with positive airway pressure",
  A7035: "Headgear, used with positive airway pressure",
  A7036: "Chinstrap, used with positive airway pressure",
  A7037: "Tubing, used with positive airway pressure",
  A7038: "Disposable filter, used with positive airway pressure",
  A7039: "Reusable filter, used with positive airway pressure",
  A7046: "Replacement water chamber for humidifier",
};

/**
 * Render the SWO into the provided pdfkit document. The caller is
 * responsible for piping the document somewhere (HTTP response,
 * GCS upload buffer, etc.) and for calling `doc.end()`.
 *
 * Side-effect-free with respect to anything outside `doc`: no
 * network, no DB, no logging.
 */
export function renderSwo(doc: PDFKit.PDFDocument, inputs: SwoInputs): void {
  // ── HIPAA banner ────────────────────────────────────────────────────
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

  // ── Title / supplier letterhead ────────────────────────────────────
  doc.fontSize(18).font("Helvetica-Bold").text("Standard Written Order", {
    align: "center",
    width: USABLE_WIDTH,
  });
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#555555")
    .text(`${inputs.supplierName} · CMS-standardized DMEPOS order form`, {
      align: "center",
      width: USABLE_WIDTH,
    })
    .fillColor("#000000");

  doc.moveDown(1.2);

  const orderDate = formatDate(inputs.generatedOn);
  drawLabeledField(doc, "Order date", orderDate);

  doc.moveDown(0.5);
  drawHorizontalRule(doc);
  doc.moveDown(0.8);

  // ── Beneficiary block ──────────────────────────────────────────────
  drawSectionHeader(doc, "Beneficiary");
  drawLabeledField(
    doc,
    "Name",
    `${inputs.patient.legalLastName}, ${inputs.patient.legalFirstName}`,
  );
  drawLabeledField(
    doc,
    "Date of birth",
    formatIsoDate(inputs.patient.dateOfBirth),
  );
  if (inputs.patient.address) {
    drawLabeledField(doc, "Address", formatAddress(inputs.patient.address));
  }

  doc.moveDown(0.6);
  drawHorizontalRule(doc);
  doc.moveDown(0.8);

  // ── Item block ─────────────────────────────────────────────────────
  drawSectionHeader(doc, "Item ordered");
  drawLabeledField(
    doc,
    "HCPCS code",
    inputs.prescription.hcpcsCode ?? "(missing)",
  );
  drawLabeledField(
    doc,
    "Description",
    describeHcpcs(inputs.prescription.hcpcsCode, inputs.prescription.itemSku),
  );
  drawLabeledField(
    doc,
    "Replacement cadence",
    `Every ${inputs.prescription.cadenceDays} days`,
  );
  drawLabeledField(
    doc,
    "Valid from",
    formatIsoDate(inputs.prescription.validFrom),
  );
  if (inputs.prescription.validUntil) {
    drawLabeledField(
      doc,
      "Valid until",
      formatIsoDate(inputs.prescription.validUntil),
    );
  }
  if (inputs.prescription.diagnosisIcd10) {
    drawLabeledField(
      doc,
      "Diagnosis (ICD-10)",
      inputs.prescription.diagnosisIcd10,
    );
  }
  if (inputs.prescription.diagnosis) {
    drawLabeledField(doc, "Clinical notes", inputs.prescription.diagnosis);
  }

  doc.moveDown(0.6);
  drawHorizontalRule(doc);
  doc.moveDown(0.8);

  // ── Treating practitioner ──────────────────────────────────────────
  drawSectionHeader(doc, "Treating practitioner");
  drawLabeledField(doc, "Name", inputs.provider.legalName);
  drawLabeledField(doc, "NPI", inputs.provider.npi);
  if (inputs.provider.practiceName) {
    drawLabeledField(doc, "Practice", inputs.provider.practiceName);
  }
  if (inputs.provider.practiceAddress) {
    drawLabeledField(
      doc,
      "Practice address",
      formatAddress(inputs.provider.practiceAddress),
    );
  }
  if (inputs.provider.phoneE164) {
    drawLabeledField(doc, "Phone", inputs.provider.phoneE164);
  }
  if (inputs.provider.faxE164) {
    drawLabeledField(doc, "Fax", inputs.provider.faxE164);
  }

  doc.moveDown(1.6);

  // ── Signature block ────────────────────────────────────────────────
  doc.fontSize(10).font("Helvetica");
  doc.text("Practitioner signature: ____________________________________", {
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.4);
  doc.text("Date: __________________", { width: USABLE_WIDTH });

  // ── Footer ─────────────────────────────────────────────────────────
  const footerY = 720;
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
      "This document contains protected health information governed by HIPAA. " +
        "Maintain in the supplier record per CMS DMEPOS documentation requirements.",
      MARGIN,
      footerY + 6,
      { width: USABLE_WIDTH, align: "center" },
    )
    .fillColor("#000000");
}

// ── small layout helpers ─────────────────────────────────────────────

function drawSectionHeader(doc: PDFKit.PDFDocument, label: string): void {
  doc.fontSize(11).font("Helvetica-Bold").text(label, {
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.3);
}

function drawLabeledField(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
): void {
  doc.fontSize(10).font("Helvetica-Bold").text(`${label}: `, {
    continued: true,
    width: USABLE_WIDTH,
  });
  doc.font("Helvetica").text(value, { width: USABLE_WIDTH });
  doc.moveDown(0.2);
}

function drawHorizontalRule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Format a YYYY-MM-DD string without re-introducing TZ shift. */
function formatIsoDate(iso: string): string {
  // Parse explicitly as a date-only value (no timezone) so 2026-05-11
  // doesn't get displayed as May 10 in negative-offset zones.
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatAddress(a: {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}): string {
  const parts: string[] = [];
  if (a.line1) parts.push(a.line1);
  if (a.line2) parts.push(a.line2);
  const cityState = [a.city, a.state].filter(Boolean).join(", ");
  const tail = [cityState, a.postalCode].filter(Boolean).join(" ");
  if (tail) parts.push(tail);
  return parts.join("\n");
}
