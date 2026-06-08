// DME / PAP Prior-Authorization Request Form PDF generator.
//
// Why this exists
// ---------------
// There is no single federally-mandated prior-authorization form for
// CPAP/BiPAP (E0601 / E0470 / E0471). CMS does not require PA for PAP
// devices at all — the Medicare path is documentation-driven (LCD
// L33718 / Policy Article A52467). The PA requirement comes from the
// COMMERCIAL, Medicare-Advantage, and Medicaid-MCO payers, and each
// publishes its own portal/fax intake form.
//
// Rather than chase ~50 payer-specific PDFs (which drift constantly),
// we render ONE universal, payer-addressed PA request form that
// carries every data element those payers ask for on a PAP auth:
//
//   * patient + insurance identifiers,
//   * ordering (referring) provider + servicing supplier (us),
//   * the requested HCPCS line(s) with length-of-need,
//   * the OSA diagnosis (ICD-10, typically G47.33),
//   * the clinical justification block payers actually adjudicate on —
//     the qualifying sleep study (type/date/AHI/RDI), the face-to-face
//     evaluation date, and the prescribed pressure,
//   * the documentation-attachment checklist.
//
// It is auto-populated from the patient/coverage/sleep-study/Rx/
// provider rows by the route layer and is designed to be faxed to the
// payer's `payer_profiles.prior_auth_fax_e164` (the "To:" block prints
// that number) or attached to a portal submission — the two intake
// methods every PA-requiring payer in the catalog accepts. Fields we
// cannot auto-fill render as a labelled blank line for the clinician to
// complete, exactly as a paper intake form would.
//
// Layout follows the same pdfkit conventions as hcfa-1500-pdf.ts /
// swo-pdf.ts (LETTER, point coordinates, Helvetica). Coordinates are
// approximate — the goal is a clean, legible, faxable single document,
// not pixel-parity with any one payer's pre-printed form.
//
// PHI posture: the rendered PDF carries PHI. Callers return it in the
// HTTP response and never persist or log the bytes.

import type PDFKit from "pdfkit";
import PDFDocument from "pdfkit";

export interface PaRequestPostalAddress {
  line1: string;
  line2?: string | null;
  line3?: string | null;
  city: string;
  state: string;
  zip: string;
}

export interface PaRequestLine {
  /** HCPCS / CPT code, e.g. E0601 (CPAP), E0470/E0471 (BiPAP). */
  hcpcsCode: string;
  /** Plain-language item description. */
  description: string;
  /** Modifiers the payer expects (KX, RR, NU, …). */
  modifiers?: string[];
  /** Units requested (machines = 1; supplies vary). */
  quantity: number;
  /** Length of need in months. 99 = lifetime, the PAP convention. */
  lengthOfNeedMonths?: number | null;
}

export interface PaRequestInput {
  /** When the form was generated (prints in the footer). */
  generatedOn: Date;

  // ── Payer (the "To:" block + intake routing) ──
  payerDisplayName: string;
  /** Prints "FAX TO" when present so the CSR can cover-sheet it. */
  payerPriorAuthFaxE164?: string | null;
  payerPriorAuthPhoneE164?: string | null;
  /** portal | fax | phone | electronic_278 | paper | none — surfaced as
   *  a one-line routing hint so the CSR knows how this payer wants it. */
  payerSubmissionMethod?: string | null;
  payerProviderPortalUrl?: string | null;
  /** Expected decision window, printed as an SLA reminder. */
  payerTurnaroundBusinessDays?: number | null;

  // ── Servicing supplier (us) ──
  supplierName: string;
  supplierNpi?: string | null;
  supplierTaxId?: string | null;
  supplierAddress?: PaRequestPostalAddress | null;
  supplierPhoneE164?: string | null;
  supplierFaxE164?: string | null;

  // ── Patient ──
  patientLastName: string;
  patientFirstName: string;
  patientDateOfBirth: string; // YYYY-MM-DD
  patientSex?: "M" | "F" | "U" | null;
  patientAddress?: PaRequestPostalAddress | null;
  patientPhoneE164?: string | null;

  // ── Insurance ──
  memberId: string;
  groupNumber?: string | null;
  planName?: string | null;
  /** When already known (renewal / pended), prints in the auth box. */
  existingAuthNumber?: string | null;

  // ── Ordering / referring provider ──
  orderingProviderName?: string | null;
  orderingProviderNpi?: string | null;
  orderingProviderPhoneE164?: string | null;
  orderingProviderFaxE164?: string | null;

  // ── Requested items ──
  requestedLines: PaRequestLine[];

  // ── Clinical justification (PAP medical-necessity block) ──
  diagnosisIcd10?: string | null; // typically G47.33
  /** Initial in-person clinical evaluation date (pre-sleep-test). */
  faceToFaceDate?: string | null;
  sleepStudy?: {
    type?: "psg" | "hsat" | "split_night" | "re_titration" | null;
    date?: string | null; // YYYY-MM-DD
    ahi?: string | number | null;
    rdi?: string | number | null;
    facilityName?: string | null;
  } | null;
  /** Prescribed PAP pressure, e.g. "10 cmH2O" or "EPAP 8 / IPAP 14". */
  prescribedPressure?: string | null;
  /** Free-text clinical narrative / medical-necessity statement. */
  clinicalNotes?: string | null;
}

/** Human labels for the sleep-study type enum. */
const STUDY_TYPE_LABEL: Record<string, string> = {
  psg: "In-lab polysomnography (PSG)",
  hsat: "Home sleep apnea test (HSAT)",
  split_night: "Split-night PSG",
  re_titration: "Re-titration study",
};

/**
 * Render the universal PAP/DME prior-authorization request form as a
 * single-document PDF. Returns a Buffer; callers `await` and write it
 * into the HTTP response.
 */
export async function renderPaRequestPdf(
  input: PaRequestInput,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    // Slim bottom margin: the single-page form fills the page and the
    // confidentiality footer sits low; a 40pt bottom margin would push
    // that footer past the auto-pagination threshold onto a blank page.
    margins: { top: 40, bottom: 22, left: 40, right: 40 },
  });
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawForm(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

const LEFT = 40;
const RIGHT = 572; // 612 (Letter width) − 40 right margin
const MIDX = 310; // column split

function drawForm(doc: PDFKit.PDFDocument, input: PaRequestInput): void {
  // ── Title ──
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .text("PRIOR AUTHORIZATION REQUEST", LEFT, 38)
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#374151")
    .text(
      "Durable Medical Equipment — Positive Airway Pressure (PAP) Therapy",
      LEFT,
      55,
    )
    .fillColor("black");
  hr(doc, 67);

  // ── To / From header (two fixed-height columns, then a one-line
  //    routing hint spanning the full width) ──
  let y = 75;
  const colW = MIDX - LEFT - 10;

  // To: payer (left)
  drawLabel(doc, LEFT, y, "TO (PAYER)");
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(input.payerDisplayName, LEFT, y + 10, {
      width: colW,
      ellipsis: true,
      lineBreak: false,
    });
  const toContact = [
    input.payerPriorAuthFaxE164
      ? `FAX TO: ${formatPhone(input.payerPriorAuthFaxE164)}`
      : null,
    input.payerPriorAuthPhoneE164
      ? `PA line: ${formatPhone(input.payerPriorAuthPhoneE164)}`
      : null,
  ]
    .filter(Boolean)
    .join("     ");
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .text(toContact || " ", LEFT, y + 25, {
      width: colW,
      ellipsis: true,
      lineBreak: false,
    });

  // From: supplier (right)
  drawLabel(doc, MIDX, y, "FROM (SERVICING DME SUPPLIER)");
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(input.supplierName, MIDX, y + 10, {
      width: RIGHT - MIDX,
      ellipsis: true,
      lineBreak: false,
    });
  doc.font("Helvetica").fontSize(8.5);
  const supplierAddrLine = input.supplierAddress
    ? formatAddressInline(input.supplierAddress)
    : "";
  doc.text(supplierAddrLine || " ", MIDX, y + 24, {
    width: RIGHT - MIDX,
    ellipsis: true,
    lineBreak: false,
  });
  const supplierMeta = [
    input.supplierNpi ? `NPI ${input.supplierNpi}` : null,
    input.supplierTaxId ? `TIN ${input.supplierTaxId}` : null,
    input.supplierPhoneE164
      ? `Ph ${formatPhone(input.supplierPhoneE164)}`
      : null,
  ]
    .filter(Boolean)
    .join("    ");
  doc.text(supplierMeta || " ", MIDX, y + 35, {
    width: RIGHT - MIDX,
    ellipsis: true,
    lineBreak: false,
  });

  y += 48;
  const routing = submissionRoutingLine(input);
  if (routing) {
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#475569")
      .text(routing, LEFT, y, {
        width: RIGHT - LEFT,
        ellipsis: true,
        lineBreak: false,
      })
      .fillColor("black");
    y += 12;
  }
  hr(doc, y);
  y += 7;

  // ── Section 1: Patient ──
  y = sectionHeader(doc, y, "1.  PATIENT");
  const patientName = `${input.patientLastName}, ${input.patientFirstName}`;
  field(doc, LEFT, y, "Name (Last, First)", patientName);
  field(doc, MIDX, y, "Date of birth", formatDate(input.patientDateOfBirth));
  field(doc, RIGHT - 70, y, "Sex", input.patientSex ?? "", 70);
  y += 24;
  field(
    doc,
    LEFT,
    y,
    "Address",
    input.patientAddress ? formatAddressInline(input.patientAddress) : "",
    MIDX - LEFT - 10,
  );
  field(
    doc,
    MIDX,
    y,
    "Phone",
    input.patientPhoneE164 ? formatPhone(input.patientPhoneE164) : "",
  );
  y += 26;

  // ── Section 2: Insurance ──
  y = sectionHeader(doc, y, "2.  INSURANCE");
  field(doc, LEFT, y, "Member / subscriber ID", input.memberId);
  field(doc, MIDX, y, "Group #", input.groupNumber ?? "");
  field(doc, RIGHT - 150, y, "Existing auth #", input.existingAuthNumber ?? "");
  y += 24;
  field(doc, LEFT, y, "Plan name", input.planName ?? "", MIDX - LEFT - 10);
  y += 26;

  // ── Section 3: Ordering provider ──
  y = sectionHeader(doc, y, "3.  ORDERING / REFERRING PROVIDER");
  field(
    doc,
    LEFT,
    y,
    "Name",
    input.orderingProviderName ?? "",
    MIDX - LEFT - 10,
  );
  field(doc, MIDX, y, "NPI", input.orderingProviderNpi ?? "");
  y += 24;
  field(
    doc,
    LEFT,
    y,
    "Phone",
    input.orderingProviderPhoneE164
      ? formatPhone(input.orderingProviderPhoneE164)
      : "",
  );
  field(
    doc,
    MIDX,
    y,
    "Fax",
    input.orderingProviderFaxE164
      ? formatPhone(input.orderingProviderFaxE164)
      : "",
  );
  y += 26;

  // ── Section 4: Requested items ──
  y = sectionHeader(doc, y, "4.  ITEM(S) REQUESTED");
  y = drawLineTable(doc, y, input.requestedLines);
  y += 6;

  // ── Section 5: Clinical justification ──
  y = sectionHeader(doc, y, "5.  CLINICAL JUSTIFICATION (MEDICAL NECESSITY)");
  field(doc, LEFT, y, "Primary diagnosis (ICD-10)", input.diagnosisIcd10 ?? "");
  field(
    doc,
    MIDX,
    y,
    "Face-to-face eval date",
    input.faceToFaceDate ? formatDate(input.faceToFaceDate) : "",
  );
  y += 24;

  const study = input.sleepStudy ?? null;
  const studyType = study?.type
    ? (STUDY_TYPE_LABEL[study.type] ?? study.type)
    : "";
  field(doc, LEFT, y, "Qualifying sleep study", studyType, MIDX - LEFT - 10);
  field(doc, MIDX, y, "Study date", study?.date ? formatDate(study.date) : "");
  y += 24;
  field(
    doc,
    LEFT,
    y,
    "AHI (events/hr)",
    study?.ahi != null ? String(study.ahi) : "",
    120,
  );
  field(
    doc,
    MIDX - 60,
    y,
    "RDI (events/hr)",
    study?.rdi != null ? String(study.rdi) : "",
    120,
  );
  field(
    doc,
    MIDX + 90,
    y,
    "Prescribed pressure",
    input.prescribedPressure ?? "",
    150,
  );
  y += 24;

  // Qualifying-criteria reminder (the rule payers adjudicate on).
  doc
    .font("Helvetica-Oblique")
    .fontSize(7)
    .fillColor("#555")
    .text(
      "Qualifying criteria (per Medicare LCD L33718, commonly mirrored by commercial/MA/Medicaid payers): " +
        "AHI or RDI of at least 15 events/hr; OR 5–14 events/hr with documented excessive daytime sleepiness, " +
        "impaired cognition, mood disorder, insomnia, hypertension, ischemic heart disease, or history of stroke. " +
        "Sleep study must be within 12 months preceding the initial PAP order; an in-person evaluation must precede the test.",
      LEFT,
      y,
      { width: RIGHT - LEFT },
    )
    .fillColor("black");
  y += 30;

  // Clinical notes / narrative box.
  drawLabel(doc, LEFT, y, "ADDITIONAL CLINICAL NOTES");
  y += 10;
  box(doc, LEFT, y, RIGHT - LEFT, 30);
  if (input.clinicalNotes) {
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .text(input.clinicalNotes, LEFT + 4, y + 4, {
        width: RIGHT - LEFT - 8,
        height: 24,
        ellipsis: true,
      });
  }
  y += 38;

  // ── Section 6: Documentation checklist ──
  y = sectionHeader(doc, y, "6.  DOCUMENTATION ATTACHED");
  const checklist = [
    "Detailed written order / prescription (signed & dated)",
    "Sleep study report (full interpretation)",
    "Office / face-to-face clinical evaluation note",
    "Proof of supplier patient education on device use & care",
  ];
  checklist.forEach((item, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = LEFT + col * (MIDX - LEFT + 10);
    const cy = y + row * 14;
    checkbox(doc, cx, cy);
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .text(item, cx + 14, cy - 1, {
        width: MIDX - LEFT - 10,
        lineBreak: false,
        ellipsis: true,
      });
  });
  y += 2 * 14 + 8;

  // ── Signature ──
  hr(doc, y);
  y += 9;
  drawLabel(doc, LEFT, y, "REQUESTING SUPPLIER / CLINICIAN SIGNATURE");
  drawLabel(doc, MIDX + 120, y, "DATE");
  doc
    .moveTo(LEFT, y + 22)
    .lineTo(MIDX + 90, y + 22)
    .stroke();
  doc
    .moveTo(MIDX + 120, y + 22)
    .lineTo(RIGHT, y + 22)
    .stroke();

  // ── Footer ──
  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#666")
    .text(
      `Generated ${input.generatedOn.toISOString().slice(0, 10)} by ${input.supplierName}. ` +
        "Confidential — contains protected health information. Auto-generated; verify all fields before submission.",
      LEFT,
      744,
      { width: RIGHT - LEFT, align: "center" },
    )
    .fillColor("black");
}

// ── primitives ─────────────────────────────────────────────────────

function submissionRoutingLine(input: PaRequestInput): string | null {
  const parts: string[] = [];
  if (input.payerSubmissionMethod) {
    parts.push(
      `Preferred intake: ${input.payerSubmissionMethod.replace(/_/g, " ")}`,
    );
  }
  if (input.payerTurnaroundBusinessDays != null) {
    parts.push(
      `expected decision ${input.payerTurnaroundBusinessDays} business day(s)`,
    );
  }
  if (
    input.payerSubmissionMethod === "portal" &&
    input.payerProviderPortalUrl
  ) {
    parts.push(`portal: ${input.payerProviderPortalUrl}`);
  }
  return parts.length ? parts.join(" • ") : null;
}

function sectionHeader(
  doc: PDFKit.PDFDocument,
  y: number,
  label: string,
): number {
  doc
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .fillColor("#1f2937")
    .text(label, LEFT, y)
    .fillColor("black");
  doc
    .moveTo(LEFT, y + 13)
    .lineTo(RIGHT, y + 13)
    .lineWidth(0.5)
    .strokeColor("#cbd5e1")
    .stroke()
    .strokeColor("black")
    .lineWidth(1);
  return y + 15;
}

/** A labelled value with an underline, like a paper form field. */
function field(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  label: string,
  value: string,
  width = 150,
): void {
  doc
    .font("Helvetica")
    .fontSize(6.5)
    .fillColor("#6b7280")
    .text(label.toUpperCase(), x, y);
  doc
    .fillColor("black")
    .font("Helvetica")
    .fontSize(9.5)
    .text(value || " ", x, y + 9, {
      width,
      ellipsis: true,
      lineBreak: false,
    });
  doc
    .moveTo(x, y + 21)
    .lineTo(x + width, y + 21)
    .lineWidth(0.5)
    .strokeColor("#9ca3af")
    .stroke()
    .strokeColor("black")
    .lineWidth(1);
}

function drawLineTable(
  doc: PDFKit.PDFDocument,
  y: number,
  lines: PaRequestLine[],
): number {
  const cols = {
    code: LEFT,
    desc: LEFT + 70,
    mod: LEFT + 300,
    qty: LEFT + 390,
    lon: LEFT + 440,
  };
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#374151");
  doc.text("HCPCS", cols.code, y);
  doc.text("DESCRIPTION", cols.desc, y);
  doc.text("MODIFIERS", cols.mod, y);
  doc.text("QTY", cols.qty, y);
  doc.text("LON (mo)", cols.lon, y);
  doc.fillColor("black").font("Helvetica");
  let ry = y + 12;
  const rows = lines.length > 0 ? lines : [];
  for (const line of rows.slice(0, 8)) {
    doc.fontSize(9);
    doc.text(line.hcpcsCode, cols.code, ry, { width: 66, ellipsis: true });
    doc.text(line.description, cols.desc, ry, { width: 226, ellipsis: true });
    doc.text((line.modifiers ?? []).join(", ") || "—", cols.mod, ry, {
      width: 86,
    });
    doc.text(String(line.quantity), cols.qty, ry, { width: 44 });
    doc.text(
      line.lengthOfNeedMonths != null ? String(line.lengthOfNeedMonths) : "—",
      cols.lon,
      ry,
    );
    ry += 15;
  }
  // Always draw at least two empty ruled rows when the list is short so
  // the CSR can hand-add items.
  const minRows = Math.max(rows.length, 2);
  for (let i = rows.length; i < minRows; i++) {
    doc
      .moveTo(LEFT, ry + 10)
      .lineTo(RIGHT, ry + 10)
      .lineWidth(0.5)
      .strokeColor("#e5e7eb")
      .stroke()
      .strokeColor("black")
      .lineWidth(1);
    ry += 15;
  }
  return ry + 2;
}

function drawLabel(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  text: string,
): void {
  doc
    .font("Helvetica-Bold")
    .fontSize(7)
    .fillColor("#374151")
    .text(text, x, y)
    .fillColor("black")
    .font("Helvetica");
}

function formatAddressInline(a: PaRequestPostalAddress): string {
  const l = [a.line1, a.line2, a.line3].filter(Boolean).join(", ");
  return `${l}, ${a.city}, ${a.state} ${a.zip}`;
}

function box(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  doc
    .rect(x, y, w, h)
    .lineWidth(0.5)
    .strokeColor("#9ca3af")
    .stroke()
    .strokeColor("black")
    .lineWidth(1);
}

function checkbox(doc: PDFKit.PDFDocument, x: number, y: number): void {
  doc
    .rect(x, y, 9, 9)
    .lineWidth(0.75)
    .strokeColor("#374151")
    .stroke()
    .strokeColor("black")
    .lineWidth(1);
}

function hr(doc: PDFKit.PDFDocument, y: number): void {
  doc
    .moveTo(LEFT, y)
    .lineTo(RIGHT, y)
    .lineWidth(1)
    .strokeColor("#111827")
    .stroke()
    .strokeColor("black");
}

function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/** Render an E.164 number as (NNN) NNN-NNNN when it's a US 11-digit
 *  +1 number; otherwise return it verbatim. */
function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
}
