// Medicare 90-day CPAP adherence attestation — window finder +
// PDF renderer.
//
// What Medicare requires
// ----------------------
// CMS LCD L33718 (CPAP/RAD) requires the supplier to document, by
// month 4 of therapy, that the beneficiary used the device:
//
//   * ≥ 4 hours per night
//   * on ≥ 70% of nights
//   * in any consecutive 30-day period within the first 90 days
//
// A patient who hits that threshold qualifies for ongoing rental
// coverage; one who doesn't gets the device pulled in month 4.
//
// What this module owns
// ---------------------
//   * `findBestAdherenceWindow` — given a chronological array of
//     nightly usage records and an anchor date (typically the
//     patient's first therapy night), returns the highest-adherence
//     30-day window within the first 90 days plus the boolean
//     "qualifies?" flag. PURE — no DB, no logging, no Date.now().
//   * `renderComplianceAttestation` — renders the PDF representing
//     the result of the window search. PURE with respect to pdfkit
//     side-effects.
//
// What the route layer owns (compliance-attestation.ts)
// ----------------------------------------------------
//   * Pulling therapy_nights from the DB.
//   * Dedupe by night when the same date arrived from multiple
//     sources (resmed_airview > philips_care > manual, same as
//     the patient-facing dashboard).
//   * Audit + streaming the PDF.

import type PDFKit from "pdfkit";

// The CMS adherence rule — constants, types, and the window finder — now
// lives in the pure domain layer (`@workspace/resupply-domain`) so the
// three other clinical callsites can share one source of truth instead of
// re-hardcoding 240 / 21 / 30 / 90. Imported here for the PDF renderer and
// re-exported so this module's existing importers (analytics, swo-pdf,
// routes) keep their import path.
import {
  COMPLIANT_MINUTES_PER_NIGHT,
  COMPLIANCE_NIGHT_RATIO,
  WINDOW_DAYS,
  ATTESTATION_HORIZON_DAYS,
  CMS_COMPLIANT_NIGHTS,
  findBestAdherenceWindow,
  type AdherenceNight,
  type AdherenceWindow,
  type AdherenceResult,
} from "@workspace/resupply-domain";

export {
  COMPLIANT_MINUTES_PER_NIGHT,
  COMPLIANCE_NIGHT_RATIO,
  WINDOW_DAYS,
  ATTESTATION_HORIZON_DAYS,
  CMS_COMPLIANT_NIGHTS,
  findBestAdherenceWindow,
};
export type { AdherenceNight, AdherenceWindow, AdherenceResult };

// Layout constants — same as swo-pdf.ts and fax/document.ts.
const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

// ── PDF render ────────────────────────────────────────────────────

export interface AttestationPatient {
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string;
}

export interface AttestationInputs {
  patient: AttestationPatient;
  anchorDate: string;
  result: AdherenceResult;
  generatedOn: Date;
  supplierName: string;
}

export function renderComplianceAttestation(
  doc: PDFKit.PDFDocument,
  inputs: AttestationInputs,
): void {
  const { patient, anchorDate, result, generatedOn, supplierName } = inputs;
  const today = generatedOn.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

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

  // ── Title ───────────────────────────────────────────────────────────
  doc.fontSize(18).font("Helvetica-Bold").text("CPAP Adherence Attestation", {
    align: "center",
    width: USABLE_WIDTH,
  });
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#555555")
    .text(`${supplierName} · Medicare LCD L33718 90-day adherence trial`, {
      align: "center",
      width: USABLE_WIDTH,
    })
    .fillColor("#000000");

  doc.moveDown(1.2);

  drawLabel(doc, "Generated", today);
  drawLabel(
    doc,
    "Patient",
    `${patient.legalLastName}, ${patient.legalFirstName}`,
  );
  drawLabel(doc, "Date of birth", formatIsoDate(patient.dateOfBirth));
  drawLabel(doc, "Therapy start (anchor)", formatIsoDate(anchorDate));

  doc.moveDown(0.6);
  rule(doc);
  doc.moveDown(0.8);

  // ── Headline result ────────────────────────────────────────────────
  doc.fontSize(12).font("Helvetica-Bold").text("Adherence determination", {
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.4);

  if (result.qualifies && result.window) {
    doc
      .fontSize(11)
      .font("Helvetica-Bold")
      .fillColor("#1f7a3a")
      .text("QUALIFIES — meets Medicare LCD L33718", {
        width: USABLE_WIDTH,
      })
      .fillColor("#000000");
    doc.moveDown(0.4);
    doc
      .fontSize(10)
      .font("Helvetica")
      .text(
        `The patient used the device ≥ ${COMPLIANT_MINUTES_PER_NIGHT / 60} hours on ` +
          `${result.window.compliantNights} of ${WINDOW_DAYS} consecutive nights ` +
          `(${Math.round(result.window.ratio * 100)}%) from ` +
          `${formatIsoDate(result.window.startDate)} through ` +
          `${formatIsoDate(result.window.endDate)}.`,
        { width: USABLE_WIDTH, lineGap: 3 },
      );
  } else if (result.window) {
    doc
      .fontSize(11)
      .font("Helvetica-Bold")
      .fillColor("#aa6500")
      .text(
        result.horizonComplete
          ? "DOES NOT QUALIFY — 90-day horizon complete"
          : "INTERIM — does not yet qualify",
        { width: USABLE_WIDTH },
      )
      .fillColor("#000000");
    doc.moveDown(0.4);
    doc
      .fontSize(10)
      .font("Helvetica")
      .text(
        `Best 30-day window observed: ` +
          `${result.window.compliantNights} of ${WINDOW_DAYS} compliant nights ` +
          `(${Math.round(result.window.ratio * 100)}%) from ` +
          `${formatIsoDate(result.window.startDate)} through ` +
          `${formatIsoDate(result.window.endDate)}. ` +
          `Threshold is ${Math.round(COMPLIANCE_NIGHT_RATIO * 100)}% of nights ` +
          `at ≥ ${COMPLIANT_MINUTES_PER_NIGHT / 60} hours.`,
        { width: USABLE_WIDTH, lineGap: 3 },
      );
  } else {
    doc
      .fontSize(11)
      .font("Helvetica-Bold")
      .fillColor("#aa0000")
      .text("INSUFFICIENT DATA", { width: USABLE_WIDTH })
      .fillColor("#000000");
    doc.moveDown(0.4);
    doc
      .fontSize(10)
      .font("Helvetica")
      .text(
        "No therapy-night data is available within the 90-day window. " +
          "Verify the patient's modem connection or schedule an SD card download.",
        { width: USABLE_WIDTH, lineGap: 3 },
      );
  }

  if (result.window?.averageUsageHoursOnUsedNights != null) {
    doc.moveDown(0.4);
    doc
      .fontSize(10)
      .font("Helvetica")
      .text(
        `Average nightly usage on nights with reported data: ` +
          `${result.window.averageUsageHoursOnUsedNights.toFixed(1)} hours.`,
        { width: USABLE_WIDTH },
      );
  }

  doc.moveDown(1);
  rule(doc);
  doc.moveDown(0.8);

  // ── Methodology ─────────────────────────────────────────────────────
  doc.fontSize(11).font("Helvetica-Bold").text("Methodology", {
    width: USABLE_WIDTH,
  });
  doc.moveDown(0.3);
  doc
    .fontSize(9)
    .font("Helvetica")
    .text(
      "Nightly therapy data from the prescribed device is ingested via the " +
        "therapy-cloud integration (ResMed AirView / Philips Care / Health " +
        "Connect / manual). The 90-day adherence window starts on the first " +
        "recorded night of therapy and probes every consecutive 30-day window " +
        "within that horizon. A night counts as compliant when device usage " +
        `was at least ${COMPLIANT_MINUTES_PER_NIGHT / 60} hours. A window ` +
        `qualifies under Medicare LCD L33718 when at least ` +
        `${Math.round(COMPLIANCE_NIGHT_RATIO * 100)}% of the 30 calendar days ` +
        "are compliant. The earliest qualifying window is reported here as " +
        "the canonical determination.",
      { width: USABLE_WIDTH, lineGap: 2.5 },
    );

  doc.moveDown(1.6);

  // ── Signature block ────────────────────────────────────────────────
  doc.fontSize(10).font("Helvetica");
  doc.text("Attesting representative: ____________________________________", {
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
      "Maintain in the supplier record per CMS DMEPOS documentation " +
        "requirements. This attestation reflects therapy data available at " +
        "the time of generation.",
      MARGIN,
      footerY + 6,
      { width: USABLE_WIDTH, align: "center" },
    )
    .fillColor("#000000");
}

// ── small helpers ─────────────────────────────────────────────────

function drawLabel(
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

function rule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor("#aaaaaa")
    .stroke()
    .strokeColor("#000000");
}

function parseIsoDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  // Use UTC so date math is timezone-free; we only care about
  // calendar-day boundaries here.
  return new Date(Date.UTC(y, m - 1, d));
}

function formatIsoDate(iso: string): string {
  const d = parseIsoDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
