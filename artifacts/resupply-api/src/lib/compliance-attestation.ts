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

// Layout constants — same as swo-pdf.ts and fax/document.ts.
const MARGIN = 72;
const PAGE_WIDTH = 612;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Adherence threshold: ≥ 4 hours of use per night. */
export const COMPLIANT_MINUTES_PER_NIGHT = 240;
/** Required share of compliant nights inside the 30-day window. */
export const COMPLIANCE_NIGHT_RATIO = 0.7;
/** Number of consecutive days in the qualifying window. */
export const WINDOW_DAYS = 30;
/** First-90-days probe horizon. */
export const ATTESTATION_HORIZON_DAYS = 90;

export interface AdherenceNight {
  /** YYYY-MM-DD. The single source-priority-deduped night value. */
  date: string;
  /** Null when the night reported metadata but no usage minutes
   *  (e.g. seal/leak only). Treated as 0 for adherence math. */
  usageMinutes: number | null;
}

export interface AdherenceWindow {
  /** Inclusive start date (YYYY-MM-DD). */
  startDate: string;
  /** Inclusive end date (YYYY-MM-DD), exactly 29 days after start. */
  endDate: string;
  /** Number of calendar days in the window that hit
   *  COMPLIANT_MINUTES_PER_NIGHT. Always relative to 30 days, NOT
   *  to "days that reported data" — Medicare's denominator is
   *  calendar days. */
  compliantNights: number;
  /** compliantNights / WINDOW_DAYS, rounded to 4 decimals. */
  ratio: number;
  /** True iff ratio >= COMPLIANCE_NIGHT_RATIO. */
  qualifies: boolean;
  /** Mean nightly hours across nights WITH usage data (so a
   *  patient who slept-with-CPAP 25 of 30 nights and reported 7
   *  hours each gets 7.0 hours, not 7.0 * 25/30). For display. */
  averageUsageHoursOnUsedNights: number | null;
}

export interface AdherenceResult {
  /** True iff at least one window in the 90-day probe qualifies. */
  qualifies: boolean;
  /** The window we elect to attest to. When qualifies=true this is
   *  the FIRST window (chronologically) that hit the threshold —
   *  matching how an auditor reads "the patient qualified on date X".
   *  When qualifies=false this is the BEST window (highest ratio)
   *  inside the probe, useful for the "patient is at 65% — keep
   *  coaching" admin view. Null when the patient has no usage data
   *  inside the 90-day horizon at all. */
  window: AdherenceWindow | null;
  /** True iff the 90-day probe horizon is fully behind us — set on
   *  the call site by comparing today against (anchorDate + 90).
   *  We compute it here so the renderer can mark the attestation
   *  "final" vs "interim". */
  horizonComplete: boolean;
}

/**
 * Find the best 30-day adherence window in the first 90 days
 * starting at `anchorDate`. Nights outside the horizon are ignored.
 *
 * @param nights nightly usage rows, ANY order — we sort + index by
 *   date internally. Same date appearing twice is undefined behavior;
 *   callers must dedupe before passing in.
 * @param anchorDate YYYY-MM-DD — day 1 of the 90-day probe (typically
 *   the patient's earliest therapy_night date).
 * @param asOfDate today's YYYY-MM-DD. Used only to compute
 *   `horizonComplete`; not used in the window search itself.
 */
export function findBestAdherenceWindow(
  nights: AdherenceNight[],
  anchorDate: string,
  asOfDate: string,
): AdherenceResult {
  const anchor = parseIsoDate(anchorDate);
  const asOf = parseIsoDate(asOfDate);
  if (!anchor || !asOf) {
    return { qualifies: false, window: null, horizonComplete: false };
  }

  const horizonEnd = addDays(anchor, ATTESTATION_HORIZON_DAYS - 1);
  const horizonComplete = asOf.getTime() >= horizonEnd.getTime();

  // Build a date -> usageMinutes map for O(1) per-day lookup inside
  // the sliding window.
  const usageByDate = new Map<string, number>();
  for (const n of nights) {
    if (!n.date) continue;
    const minutes = n.usageMinutes ?? 0;
    usageByDate.set(n.date, minutes);
  }

  if (usageByDate.size === 0) {
    return { qualifies: false, window: null, horizonComplete };
  }

  // The last window we can probe must end on or before the horizon
  // end AND on or before today (you can't attest based on dates
  // that haven't happened yet).
  const latestWindowStart = minDate(
    addDays(horizonEnd, -(WINDOW_DAYS - 1)),
    addDays(asOf, -(WINDOW_DAYS - 1)),
  );

  if (latestWindowStart.getTime() < anchor.getTime()) {
    // Not enough elapsed time for a full 30-day window yet.
    return { qualifies: false, window: null, horizonComplete };
  }

  let firstQualifying: AdherenceWindow | null = null;
  let bestNonQualifying: AdherenceWindow | null = null;

  for (
    let start = new Date(anchor);
    start.getTime() <= latestWindowStart.getTime();
    start = addDays(start, 1)
  ) {
    const window = scoreWindow(start, usageByDate);
    if (window.qualifies && !firstQualifying) {
      firstQualifying = window;
      break; // Earliest qualifying window is the canonical answer.
    }
    if (!bestNonQualifying || window.ratio > bestNonQualifying.ratio) {
      bestNonQualifying = window;
    }
  }

  if (firstQualifying) {
    return { qualifies: true, window: firstQualifying, horizonComplete };
  }
  return {
    qualifies: false,
    window: bestNonQualifying,
    horizonComplete,
  };
}

function scoreWindow(
  start: Date,
  usageByDate: Map<string, number>,
): AdherenceWindow {
  let compliantNights = 0;
  let usedNightMinutes = 0;
  let usedNightCount = 0;

  for (let i = 0; i < WINDOW_DAYS; i++) {
    const day = addDays(start, i);
    const key = isoDate(day);
    const minutes = usageByDate.get(key);
    if (minutes != null) {
      if (minutes > 0) {
        usedNightMinutes += minutes;
        usedNightCount += 1;
      }
      if (minutes >= COMPLIANT_MINUTES_PER_NIGHT) {
        compliantNights += 1;
      }
    }
    // Missing dates: counted as zero usage for adherence ratio —
    // matches CMS's "calendar days" denominator. Not added to
    // usedNightMinutes (which only averages nights with reported
    // usage so the display stays honest).
  }

  const ratio = compliantNights / WINDOW_DAYS;
  const qualifies = ratio >= COMPLIANCE_NIGHT_RATIO;
  const endDate = addDays(start, WINDOW_DAYS - 1);

  return {
    startDate: isoDate(start),
    endDate: isoDate(endDate),
    compliantNights,
    ratio: Math.round(ratio * 10_000) / 10_000,
    qualifies,
    averageUsageHoursOnUsedNights:
      usedNightCount === 0
        ? null
        : Math.round((usedNightMinutes / usedNightCount / 60) * 100) / 100,
  };
}

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

function addDays(d: Date, days: number): Date {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
