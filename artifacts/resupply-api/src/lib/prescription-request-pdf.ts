// Prescription Request packet — physician-faxable, pre-populated
// prescription for CPAP / BiPAP / ASV equipment + accessories.
//
// What this is
// ------------
// Unlike the SWO (lib/swo-pdf.ts) — which is the supplier's
// internal record of an *already-prescribed* order — this is a
// FILLABLE form addressed TO the physician. The physician verifies
// the pre-filled equipment list + settings, signs, and faxes back.
// The CSR uploads the signed scan, and the matching prescriptions
// row is updated in place.
//
// Layout (one US Letter page; multi-page when the equipment table
// overflows):
//
//   ┌────────────────────────────────────────────────────────────┐
//   │ CONFIDENTIAL — HIPAA PROTECTED HEALTH INFORMATION          │
//   ├────────────────────────────────────────────────────────────┤
//   │ <Supplier letterhead>                                      │
//   │                                                            │
//   │ Date: <today>           RE: Prescription request           │
//   │                                                            │
//   │ Dear Dr. <provider lastname>,                              │
//   │ <opening paragraph w/ return-by instruction>               │
//   │                                                            │
//   │ ── Patient ────────────────────────────────────────────    │
//   │ Name: ...  DOB: ...  Address: ...                          │
//   │                                                            │
//   │ ── Diagnosis ──────────────────────────────────────────    │
//   │ G47.33 — Obstructive sleep apnea (adult)                   │
//   │                                                            │
//   │ ── Equipment ──────────────────────────────────────────    │
//   │  HCPCS  Description                       Qty  Cadence     │
//   │  E0601  CPAP device                        1   N/A         │
//   │  A7034  Nasal mask                         1   90 d        │
//   │  A7037  Tubing                             1   90 d        │
//   │  A7038  Disposable filter                  2   30 d        │
//   │                                                            │
//   │ ── Device settings ────────────────────────────────────    │
//   │  Mode: Auto-CPAP    Pressure: 6–16 cm H2O                  │
//   │  Ramp: 30 min from 4 cm    Humidifier: 3   Heated tube: Y  │
//   │                                                            │
//   │ ── Length of need ─────────────────────────────────────    │
//   │ 99 months (lifetime)                                       │
//   │                                                            │
//   │ ── Affirmation & signature ────────────────────────────    │
//   │ I certify the above prescription is medically necessary.   │
//   │                                                            │
//   │ Signature: _______________________  Date: __________       │
//   │ Printed name: <provider name>                              │
//   │ NPI: <npi>                                                 │
//   │                                                            │
//   │ ── Return instructions ────────────────────────────────    │
//   │ Please fax the signed copy to: <supplier fax>              │
//   │ Or scan-and-email: orders@pennpaps.com                     │
//   │                                                            │
//   ├────────────────────────────────────────────────────────────┤
//   │ HIPAA footer                                               │
//   └────────────────────────────────────────────────────────────┘
//
// Side-effect-free: the function takes data + a pdfkit doc and
// writes layout commands. No DB, no network, no logging. Render
// failures throw and the caller decides what to do.

import type PDFKit from "pdfkit";

import { drawSignatureTrackingStamp } from "./barcode/tracking-stamp";

const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

export type DeviceClass = "cpap" | "auto_cpap" | "bipap" | "bipap_st" | "asv";

export interface PrescriptionRequestHcpcsLine {
  hcpcs: string;
  description: string;
  quantity: number;
  /** "Every 30 days" — null when one-time (the device itself). */
  cadenceDays?: number | null;
  /** Billing modifiers, optional. */
  modifiers?: string[];
}

export interface PrescriptionRequestSettings {
  deviceClass: DeviceClass;
  /** Fixed-CPAP pressure. Null for auto / bipap modes. */
  pressureCmh2o?: number | null;
  pressureMinCmh2o?: number | null;
  pressureMaxCmh2o?: number | null;
  /** BiPAP IPAP / EPAP. */
  ipapCmh2o?: number | null;
  epapCmh2o?: number | null;
  rampMinutes?: number | null;
  rampStartCmh2o?: number | null;
  /** Integer 0–5 on most devices. */
  humidifierSetting?: number | null;
  heatedTube?: boolean;
  /** BiPAP-ST / ASV backup respiratory rate. */
  backupRateBpm?: number | null;
}

export interface PrescriptionRequestPatient {
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string;
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
  } | null;
  phoneE164: string | null;
}

export interface PrescriptionRequestProvider {
  legalName: string;
  npi: string;
  practiceName: string | null;
  faxE164: string | null;
}

export interface PrescriptionRequestSupplier {
  practiceName: string;
  /** Return fax we print in the cover instructions. */
  faxE164: string;
  /** Optional return email for practices that prefer encrypted email. */
  email: string | null;
}

export interface PrescriptionRequestCoverage {
  /** Payer / insurer name, e.g. "Medicare Part B (Noridian)". */
  payerName: string;
  /**
   * Member ID — for Medicare this is the Medicare Beneficiary
   * Identifier (MBI). Printing it lets the physician's office match
   * the patient to the right coverage and satisfies the
   * "beneficiary name OR MBI" identifier of the CMS Standard Written
   * Order (42 CFR 410.38(d)(1)(i)).
   */
  memberId: string;
  planName?: string | null;
  /** "primary" | "secondary" | "tertiary" — printed as a qualifier. */
  rank?: string | null;
  /** When true the member id is labeled "Medicare ID (MBI)". */
  isMedicare?: boolean;
}

export interface PrescriptionRequestInputs {
  patient: PrescriptionRequestPatient;
  provider: PrescriptionRequestProvider;
  supplier: PrescriptionRequestSupplier;
  /** Primary payer on file. Null when the patient has no coverage row. */
  coverage: PrescriptionRequestCoverage | null;
  hcpcsLines: PrescriptionRequestHcpcsLine[];
  icd10Codes: string[];
  settings: PrescriptionRequestSettings | null;
  /** 1–99 months. 99 = "lifetime" per CMS shorthand. */
  lengthOfNeedMonths: number;
  clinicalNotes: string | null;
  generatedOn: Date;
  /**
   * Signature-tracking code (migration 0253). When present it is printed
   * as a Code 128 barcode in the top-right corner so the signed copy
   * faxed back can be scanned and filed. Optional — a packet without a
   * tracking row still renders.
   */
  trackingCode?: string | null;
}

export type ValidationResult =
  | { ok: true; inputs: PrescriptionRequestInputs }
  | { ok: false; missing: string[] };

/**
 * Sanity-check inputs before render. Empty equipment list, missing
 * provider NPI, or missing return fax all produce 0 useful signed
 * returns — surface them upfront so the route can refuse to
 * dispatch.
 */
export function validatePrescriptionRequestInputs(
  inputs: Partial<PrescriptionRequestInputs>,
): ValidationResult {
  const missing: string[] = [];
  if (!inputs.patient?.legalFirstName) missing.push("patient.legalFirstName");
  if (!inputs.patient?.legalLastName) missing.push("patient.legalLastName");
  if (!inputs.patient?.dateOfBirth) missing.push("patient.dateOfBirth");
  if (!inputs.provider?.legalName) missing.push("provider.legalName");
  if (!inputs.provider?.npi || !/^\d{10}$/.test(inputs.provider.npi))
    missing.push("provider.npi");
  if (!inputs.supplier?.practiceName) missing.push("supplier.practiceName");
  if (!inputs.supplier?.faxE164) missing.push("supplier.faxE164");
  if (!inputs.hcpcsLines || inputs.hcpcsLines.length === 0)
    missing.push("hcpcsLines");
  if (!inputs.icd10Codes || inputs.icd10Codes.length === 0)
    missing.push("icd10Codes");
  if (
    !inputs.lengthOfNeedMonths ||
    inputs.lengthOfNeedMonths < 1 ||
    inputs.lengthOfNeedMonths > 99
  )
    missing.push("lengthOfNeedMonths");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, inputs: inputs as PrescriptionRequestInputs };
}

/**
 * Render the packet into the provided pdfkit document. Caller pipes
 * `doc` and calls `doc.end()`.
 */
export function renderPrescriptionRequest(
  doc: PDFKit.PDFDocument,
  inputs: PrescriptionRequestInputs,
): void {
  // Top-right signature-tracking barcode (absolute-positioned, drawn
  // before the flowing content so it sits in the top margin).
  drawSignatureTrackingStamp(doc, inputs.trackingCode);
  drawConfidentialBanner(doc);
  drawLetterhead(doc, inputs.supplier);
  drawDateAndSubject(doc, inputs.generatedOn);
  drawSalutationParagraph(doc, inputs);

  drawSectionHeader(doc, "Patient");
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
  if (inputs.patient.phoneE164) {
    drawLabeledField(doc, "Phone", inputs.patient.phoneE164);
  }
  doc.moveDown(0.5);
  drawRule(doc);
  doc.moveDown(0.6);

  if (inputs.coverage) {
    drawSectionHeader(doc, "Insurance");
    const payerLine = inputs.coverage.planName
      ? `${inputs.coverage.payerName} — ${inputs.coverage.planName}`
      : inputs.coverage.payerName;
    drawLabeledField(
      doc,
      inputs.coverage.rank ? `Payer (${inputs.coverage.rank})` : "Payer",
      payerLine,
    );
    drawLabeledField(
      doc,
      inputs.coverage.isMedicare ? "Medicare ID (MBI)" : "Member ID",
      inputs.coverage.memberId,
    );
    doc.moveDown(0.5);
    drawRule(doc);
    doc.moveDown(0.6);
  }

  drawSectionHeader(doc, "Diagnosis");
  doc.fontSize(10).font("Helvetica");
  for (const code of inputs.icd10Codes) {
    doc.text(
      `  • ${code}${describeIcd10(code) ? `  — ${describeIcd10(code)}` : ""}`,
      {
        width: USABLE_WIDTH,
      },
    );
  }
  doc.moveDown(0.5);
  drawRule(doc);
  doc.moveDown(0.6);

  drawSectionHeader(doc, "Equipment");
  drawEquipmentTable(doc, inputs.hcpcsLines);
  doc.moveDown(0.5);
  drawRule(doc);
  doc.moveDown(0.6);

  if (inputs.settings) {
    drawSectionHeader(doc, "Device settings");
    drawSettings(doc, inputs.settings);
    doc.moveDown(0.5);
    drawRule(doc);
    doc.moveDown(0.6);
  }

  drawSectionHeader(doc, "Length of need");
  doc
    .fontSize(10)
    .font("Helvetica")
    .text(
      inputs.lengthOfNeedMonths >= 99
        ? "99 months (lifetime / indefinite per CMS shorthand)"
        : `${inputs.lengthOfNeedMonths} months`,
      { width: USABLE_WIDTH },
    );
  doc.moveDown(0.5);
  drawRule(doc);
  doc.moveDown(0.6);

  if (inputs.clinicalNotes) {
    drawSectionHeader(doc, "Clinical notes from supplier");
    doc.fontSize(10).font("Helvetica").text(inputs.clinicalNotes, {
      width: USABLE_WIDTH,
      lineGap: 2,
    });
    doc.moveDown(0.5);
    drawRule(doc);
    doc.moveDown(0.6);
  }

  if (orderIncludesPapDevice(inputs.hcpcsLines, inputs.settings)) {
    drawPapSupportingDocsNote(doc);
  }

  drawAffirmationAndSignature(doc, inputs.provider);
  drawReturnInstructions(doc, inputs.supplier);
  drawHipaaFooter(doc);
}

// PAP (CPAP / BiPAP / RAD) device base codes. When the order includes
// one of these — or carries a device-settings block — Medicare's PAP
// LCD applies, so we print a short reminder of the supporting
// documentation the treating practitioner must have on file before the
// device can be dispensed.
const PAP_DEVICE_HCPCS: ReadonlySet<string> = new Set([
  "E0601", // CPAP
  "E0470", // BiPAP / RAD without backup
  "E0471", // BiPAP S/T / RAD with backup
  "E0472", // RAD with backup (other)
]);

function orderIncludesPapDevice(
  lines: PrescriptionRequestHcpcsLine[],
  settings: PrescriptionRequestSettings | null,
): boolean {
  if (settings) return true;
  return lines.some((l) => PAP_DEVICE_HCPCS.has(l.hcpcs.trim().toUpperCase()));
}

function drawPapSupportingDocsNote(doc: PDFKit.PDFDocument): void {
  drawSectionHeader(doc, "Supporting documentation (Medicare PAP coverage)");
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#333333")
    .text(
      "Per the Medicare PAP LCD (L33718), the following must be on file before a PAP device is dispensed: " +
        "(1) a face-to-face evaluation by the treating practitioner within the 6 months preceding the order date " +
        "documenting symptoms of obstructive sleep apnea, and (2) a qualifying sleep test (attended in-lab " +
        "polysomnography or a Medicare-approved home sleep apnea test) interpreted by a qualified practitioner. " +
        "For items on the Required List, this signed order must be received by the supplier prior to delivery " +
        "(written order prior to delivery).",
      { width: USABLE_WIDTH, lineGap: 2 },
    )
    .fillColor("#000000");
  doc.moveDown(0.5);
  drawRule(doc);
  doc.moveDown(0.6);
}

// ── Section helpers ────────────────────────────────────────────────

function drawConfidentialBanner(doc: PDFKit.PDFDocument): void {
  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor("#cc0000")
    .text("CONFIDENTIAL — HIPAA PROTECTED HEALTH INFORMATION", MARGIN, MARGIN, {
      width: USABLE_WIDTH,
      align: "center",
    })
    .fillColor("#000000");
  doc.moveDown(0.4);
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .stroke();
  doc.moveDown(0.8);
}

function drawLetterhead(
  doc: PDFKit.PDFDocument,
  supplier: PrescriptionRequestSupplier,
): void {
  doc.fontSize(16).font("Helvetica-Bold").text(supplier.practiceName, {
    align: "left",
    width: USABLE_WIDTH,
  });
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#555555")
    .text("Home Medical Equipment & CPAP Supply Services", {
      align: "left",
      width: USABLE_WIDTH,
    })
    .fillColor("#000000");
  doc.moveDown(1);
}

function drawDateAndSubject(doc: PDFKit.PDFDocument, when: Date): void {
  const today = when.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  doc.fontSize(11).font("Helvetica").text(`Order date: ${today}`, {
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.3);
  doc
    .fontSize(11)
    .font("Helvetica-Bold")
    .text("RE: Prescription request — please verify, sign, and return", {
      width: USABLE_WIDTH,
    })
    .font("Helvetica");
  doc.moveDown(0.6);
  drawRule(doc);
  doc.moveDown(0.8);
}

function drawSalutationParagraph(
  doc: PDFKit.PDFDocument,
  inputs: PrescriptionRequestInputs,
): void {
  doc
    .fontSize(11)
    .font("Helvetica")
    .text(`Dear Dr. ${inputs.provider.legalName},`, { width: USABLE_WIDTH });
  doc.moveDown(0.4);
  doc
    .fontSize(10)
    .font("Helvetica")
    .text(
      `We have prepared the prescription below for your patient and are requesting your signature ` +
        `so we can dispense the equipment and bill the payer on file. Please review for accuracy, ` +
        `sign in the signature block at the bottom, and fax the signed copy to ${inputs.supplier.faxE164}.`,
      { width: USABLE_WIDTH, lineGap: 2 },
    );
  doc.moveDown(0.6);
  drawRule(doc);
  doc.moveDown(0.6);
}

function drawEquipmentTable(
  doc: PDFKit.PDFDocument,
  lines: PrescriptionRequestHcpcsLine[],
): void {
  const colHcpcs = MARGIN;
  const colDesc = MARGIN + 70;
  const colQty = MARGIN + 330;
  const colCadence = MARGIN + 380;

  doc.fontSize(10).font("Helvetica-Bold");
  const headerY = doc.y;
  doc.text("HCPCS", colHcpcs, headerY);
  doc.text("Description", colDesc, headerY);
  doc.text("Qty", colQty, headerY);
  doc.text("Cadence", colCadence, headerY);
  doc.moveDown(0.3);
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#cccccc")
    .stroke()
    .strokeColor("#000000");
  doc.moveDown(0.3);

  doc.font("Helvetica");
  for (const line of lines) {
    const rowY = doc.y;
    const hcpcs =
      line.modifiers && line.modifiers.length > 0
        ? `${line.hcpcs} ${line.modifiers.join("/")}`
        : line.hcpcs;
    const cadence =
      typeof line.cadenceDays === "number" && line.cadenceDays > 0
        ? `Every ${line.cadenceDays} d`
        : "—";
    doc.text(hcpcs, colHcpcs, rowY, { width: 65 });
    doc.text(line.description, colDesc, rowY, { width: 250 });
    doc.text(String(line.quantity), colQty, rowY, { width: 40 });
    doc.text(cadence, colCadence, rowY, { width: 100 });
    doc.moveDown(0.4);
  }

  // The cells above were positioned with absolute X coordinates, which
  // leaves pdfkit's text cursor parked under the last column. Reset it
  // to the left margin so every following section (device settings,
  // length of need, the signature block, return instructions, footer)
  // flows full-width instead of being clipped into a narrow right-hand
  // column.
  doc.x = MARGIN;
}

function drawSettings(
  doc: PDFKit.PDFDocument,
  s: PrescriptionRequestSettings,
): void {
  drawLabeledField(doc, "Therapy mode", describeDeviceClass(s.deviceClass));

  // Pressure block — varies by device class.
  if (s.deviceClass === "cpap" && typeof s.pressureCmh2o === "number") {
    drawLabeledField(doc, "Pressure", `${s.pressureCmh2o} cm H2O (fixed)`);
  } else if (
    (s.deviceClass === "auto_cpap" || s.deviceClass === "bipap") &&
    typeof s.pressureMinCmh2o === "number" &&
    typeof s.pressureMaxCmh2o === "number"
  ) {
    drawLabeledField(
      doc,
      "Pressure range",
      `${s.pressureMinCmh2o}–${s.pressureMaxCmh2o} cm H2O`,
    );
  }
  if (typeof s.ipapCmh2o === "number" && typeof s.epapCmh2o === "number") {
    drawLabeledField(
      doc,
      "IPAP / EPAP",
      `${s.ipapCmh2o} / ${s.epapCmh2o} cm H2O`,
    );
  }
  if (typeof s.backupRateBpm === "number") {
    drawLabeledField(doc, "Backup rate", `${s.backupRateBpm} BPM`);
  }
  if (typeof s.rampMinutes === "number" && s.rampMinutes > 0) {
    const from =
      typeof s.rampStartCmh2o === "number"
        ? ` from ${s.rampStartCmh2o} cm H2O`
        : "";
    drawLabeledField(doc, "Ramp", `${s.rampMinutes} minutes${from}`);
  }
  if (typeof s.humidifierSetting === "number") {
    drawLabeledField(doc, "Humidifier", String(s.humidifierSetting));
  }
  if (typeof s.heatedTube === "boolean") {
    drawLabeledField(doc, "Heated tubing", s.heatedTube ? "Yes" : "No");
  }
}

function drawAffirmationAndSignature(
  doc: PDFKit.PDFDocument,
  provider: PrescriptionRequestProvider,
): void {
  drawSectionHeader(doc, "Affirmation & signature");
  doc
    .fontSize(9)
    .font("Helvetica-Oblique")
    .text(
      "By signing below I certify the above prescription is medically necessary for the named patient.",
      { width: USABLE_WIDTH },
    );
  doc.moveDown(0.6);

  doc.fontSize(10).font("Helvetica");
  doc.text("Signature: ____________________________________   ", {
    continued: true,
    width: USABLE_WIDTH,
  });
  doc.text("Date: __________________", { width: USABLE_WIDTH });
  doc.moveDown(0.5);
  drawLabeledField(doc, "Printed name", provider.legalName);
  drawLabeledField(doc, "NPI", provider.npi);
  if (provider.practiceName) {
    drawLabeledField(doc, "Practice", provider.practiceName);
  }
  doc.moveDown(0.5);
  drawRule(doc);
  doc.moveDown(0.6);
}

function drawReturnInstructions(
  doc: PDFKit.PDFDocument,
  supplier: PrescriptionRequestSupplier,
): void {
  drawSectionHeader(doc, "Return instructions");
  doc.fontSize(10).font("Helvetica");
  doc.text(`Please fax the signed copy to: ${supplier.faxE164}`, {
    width: USABLE_WIDTH,
  });
  if (supplier.email) {
    doc.text(`Or scan + email to: ${supplier.email}`, {
      width: USABLE_WIDTH,
    });
  }
  doc.text(
    "Questions? Call our clinical operations team — contact details in the cover letter.",
    { width: USABLE_WIDTH },
  );
}

function drawHipaaFooter(doc: PDFKit.PDFDocument): void {
  const footerY = 720;
  if (doc.y > footerY - 30) doc.addPage();
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
      "This facsimile contains protected health information governed by HIPAA. " +
        "It is intended only for the named recipient. If received in error, " +
        "destroy immediately and notify the sender.",
      MARGIN,
      footerY + 6,
      { width: USABLE_WIDTH, align: "center" },
    )
    .fillColor("#000000");
}

// ── Small layout primitives ─────────────────────────────────────────

function drawSectionHeader(doc: PDFKit.PDFDocument, label: string): void {
  doc.fontSize(11).font("Helvetica-Bold").text(label, { width: USABLE_WIDTH });
  doc.moveDown(0.25);
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
  doc.moveDown(0.15);
}

function drawRule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#cccccc")
    .stroke()
    .strokeColor("#000000");
}

function formatIsoDate(iso: string): string {
  const parts = iso.split("-").map(Number);
  const [y, m, d] = parts;
  if (
    !y ||
    !m ||
    !d ||
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d)
  ) {
    return iso;
  }
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
  const cityLine = [a.city, a.state].filter(Boolean).join(", ");
  return [a.line1, a.line2, [cityLine, a.postalCode].filter(Boolean).join(" ")]
    .filter((s): s is string => Boolean(s && s.length > 0))
    .join(" · ");
}

function describeDeviceClass(c: DeviceClass): string {
  switch (c) {
    case "cpap":
      return "CPAP (fixed pressure)";
    case "auto_cpap":
      return "Auto-CPAP";
    case "bipap":
      return "BiPAP";
    case "bipap_st":
      return "BiPAP ST (with backup rate)";
    case "asv":
      return "Adaptive Servo-Ventilation (ASV)";
  }
}

const ICD10_LABELS: Record<string, string> = {
  "G47.33": "Obstructive sleep apnea, adult",
  "G47.30": "Sleep apnea, unspecified",
  "G47.31": "Primary central sleep apnea",
  "G47.34": "Idiopathic sleep-related non-obstructive alveolar hypoventilation",
  "G47.35": "Congenital central alveolar hypoventilation syndrome",
  "G47.36": "Sleep-related hypoventilation in conditions classified elsewhere",
  "G47.37": "Central sleep apnea in conditions classified elsewhere",
  "G47.39": "Other sleep apnea",
};

function describeIcd10(code: string): string | null {
  return ICD10_LABELS[code.toUpperCase()] ?? null;
}
