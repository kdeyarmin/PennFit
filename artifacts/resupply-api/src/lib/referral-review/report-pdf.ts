// Referral Review Report — the one-page (or few-page) summary the reviewer
// generates from a 100+-page referral packet.
//
// It distils the AI extraction into the things a CSR needs to decide and act:
//   * a demographic information sheet,
//   * the diagnosis (ICD-10) codes,
//   * a sleep-study summary,
//   * the therapy ordered / recommended,
//   * a PAP-qualification verdict (does the study support coverage?), and
//   * a "what's missing / request from provider" checklist.
//
// `assembleReferralReport` is the pure model (qualification + completeness)
// shared by the PDF and the review API; `renderReferralReviewReport` draws it
// with the same PDFKit pattern as the billing/manual-document generators.
// PHI lives in the rendered bytes (it's a chart document) but is never logged.

import PDFDocument from "pdfkit";

import {
  assessReferralCompleteness,
  type ReferralCompleteness,
} from "./completeness";
import type { ReferralExtraction } from "./extract";
import { assessPapQualification, type PapQualification } from "./qualification";

export interface ReferralReportModel {
  qualification: PapQualification;
  completeness: ReferralCompleteness;
}

/**
 * Compute the qualification verdict + completeness checklist for an
 * extraction. Pure — used by both the report PDF and the review route's API
 * response so the screen and the printed report never disagree.
 */
export function assembleReferralReport(
  extraction: ReferralExtraction,
): ReferralReportModel {
  const qualification = assessPapQualification({
    ahi: extraction.sleepStudy?.ahi ?? null,
    rdi: extraction.sleepStudy?.rdi ?? null,
    comorbidities: extraction.comorbidities,
  });
  const completeness = assessReferralCompleteness({
    patient: {
      firstName: extraction.patient.firstName,
      lastName: extraction.patient.lastName,
      dob: extraction.patient.dob,
    },
    insurance: extraction.insurance,
    diagnoses: extraction.diagnoses,
    physician: extraction.physician,
    documents: extraction.documents,
    qualification,
  });
  return { qualification, completeness };
}

export interface ReferralReportInput {
  extraction: ReferralExtraction;
  supplierName: string;
  /** Passed in for deterministic tests. */
  generatedOn?: Date;
}

const INK = "#1f2933";
const MUTED = "#52606d";
const RULE = "#cbd2d9";
const OK = "#0b7a3b";
const WARN = "#9a6700";
const BAD = "#b42318";

const dash = (v: string | null | undefined): string => {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length > 0 ? s : "—";
};

const num = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? String(n) : "—";

/** Render the Referral Review Report to a PDF buffer. */
export async function renderReferralReviewReport(
  input: ReferralReportInput,
): Promise<Buffer> {
  const { extraction } = input;
  const generatedOn = input.generatedOn ?? new Date();
  const { qualification, completeness } = assembleReferralReport(extraction);

  const doc = new PDFDocument({ size: "LETTER", margin: 54 });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawReport(doc, {
        extraction,
        supplierName: input.supplierName,
        generatedOn,
        qualification,
        completeness,
      });
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function drawReport(
  doc: PDFKit.PDFDocument,
  m: {
    extraction: ReferralExtraction;
    supplierName: string;
    generatedOn: Date;
    qualification: PapQualification;
    completeness: ReferralCompleteness;
  },
): void {
  const { extraction: ex, qualification, completeness } = m;
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;

  // ── Header ─────────────────────────────────────────────────────────
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor(INK)
    .text("Referral Review Report", left, doc.y);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(MUTED)
    .text(
      `${m.supplierName}  ·  Generated ${m.generatedOn.toISOString().slice(0, 10)}`,
    );
  doc
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      "AI-assisted summary of the inbound referral. Verify against the source documents before dispensing.",
    );
  doc.moveDown(0.6);

  // ── Qualification verdict (the headline) ───────────────────────────
  const verdictColor =
    qualification.verdict === "qualifies" ||
    qualification.verdict === "qualifies_with_comorbidity"
      ? OK
      : qualification.verdict === "not_qualifying"
        ? BAD
        : WARN;
  sectionHeading(doc, "PAP qualification", left, width);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(verdictColor)
    .text(qualification.summary, { width });
  doc.font("Helvetica").fontSize(9).fillColor(MUTED);
  for (const d of qualification.details) {
    doc.text(`•  ${d}`, { width, indent: 4 });
  }
  doc.moveDown(0.5);

  // ── Demographics sheet ─────────────────────────────────────────────
  sectionHeading(doc, "Patient (demographics sheet)", left, width);
  const addr = ex.patient.address;
  const addrLine = addr
    ? [
        addr.line1,
        addr.line2,
        [addr.city, [addr.state, addr.postalCode].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(", "),
      ]
        .filter((p) => p && p.trim())
        .join(", ")
    : "";
  kv(doc, left, width, [
    [
      "Name",
      dash(`${ex.patient.firstName ?? ""} ${ex.patient.lastName ?? ""}`.trim()),
    ],
    ["Date of birth", dash(ex.patient.dob)],
    ["Phone", dash(ex.patient.phone)],
    ["Email", dash(ex.patient.email)],
    ["Address", dash(addrLine)],
  ]);
  kv(doc, left, width, [
    [
      "Insurance",
      ex.insurance
        ? `${dash(ex.insurance.payerName)} · member ${dash(ex.insurance.memberId)}`
        : "—",
    ],
    ["Referring physician", dash(ex.physician?.name)],
    ["Physician NPI", dash(ex.physician?.npi)],
  ]);
  doc.moveDown(0.4);

  // ── Diagnosis codes ────────────────────────────────────────────────
  sectionHeading(doc, "Diagnosis codes", left, width);
  if (ex.diagnoses.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text("None on the referral.", { width });
  } else {
    doc.font("Helvetica").fontSize(9).fillColor(INK);
    for (const d of ex.diagnoses) {
      doc.text(
        `•  ${dash(d.icd10)}${d.description ? ` — ${d.description}` : ""}`,
        {
          width,
          indent: 4,
        },
      );
    }
  }
  doc.moveDown(0.4);

  // ── Sleep study summary ────────────────────────────────────────────
  sectionHeading(doc, "Sleep study", left, width);
  const ss = ex.sleepStudy;
  if (!ss) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text("No sleep study found in the packet.", { width });
  } else {
    kv(doc, left, width, [
      ["Study date", dash(ss.studyDate)],
      ["Study type", dash(ss.studyType)],
      ["AHI", num(ss.ahi)],
      ["RDI", num(ss.rdi)],
      ["ODI", num(ss.odi)],
      ["Total sleep (min)", num(ss.totalSleepMinutes)],
      ["Interpreting physician", dash(ss.interpretingPhysician)],
    ]);
  }
  doc.moveDown(0.4);

  // ── Therapy ordered / recommended ──────────────────────────────────
  sectionHeading(doc, "Therapy ordered / recommended", left, width);
  doc.font("Helvetica").fontSize(9).fillColor(INK);
  doc.text(`Recommended therapy: ${dash(ex.recommendedTherapy)}`, { width });
  if (ex.order.length === 0) {
    doc.fillColor(MUTED).text("No ordered items identified.", { width });
  } else {
    for (const o of ex.order) {
      doc
        .fillColor(INK)
        .text(`•  ${o.description}${o.hcpcs ? ` (${o.hcpcs})` : ""}`, {
          width,
          indent: 4,
        });
    }
  }
  doc.moveDown(0.4);

  // ── Missing / request-from-provider checklist ──────────────────────
  sectionHeading(
    doc,
    completeness.complete
      ? "Completeness — ready to process"
      : `Completeness — ${completeness.outstandingCount} item(s) need attention`,
    left,
    width,
  );
  for (const item of completeness.items) {
    const mark =
      item.status === "present" ? "✓" : item.status === "attention" ? "!" : "✗";
    const color =
      item.status === "present" ? OK : item.status === "attention" ? WARN : BAD;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(color)
      .text(`${mark}  ${item.label}`, {
        width,
        continued: false,
      });
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(`     ${item.detail}`, { width });
    if (item.request) {
      doc.fillColor(WARN).text(`     → Request: ${item.request}`, { width });
    }
  }

  if (ex.summary) {
    doc.moveDown(0.4);
    sectionHeading(doc, "Notes", left, width);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text(ex.summary, { width });
  }
}

function sectionHeading(
  doc: PDFKit.PDFDocument,
  title: string,
  left: number,
  width: number,
): void {
  doc.moveDown(0.3);
  const y = doc.y;
  doc
    .font("Helvetica-Bold")
    .fontSize(10.5)
    .fillColor(INK)
    .text(title, left, y, { width });
  doc
    .moveTo(left, doc.y + 1)
    .lineTo(left + width, doc.y + 1)
    .lineWidth(0.5)
    .strokeColor(RULE)
    .stroke();
  doc.moveDown(0.3);
}

function kv(
  doc: PDFKit.PDFDocument,
  left: number,
  width: number,
  rows: Array<[string, string]>,
): void {
  const labelW = 150;
  for (const [label, value] of rows) {
    const y = doc.y;
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(label, left, y, {
      width: labelW,
    });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(INK)
      .text(value, left + labelW, y, { width: width - labelW });
  }
}
