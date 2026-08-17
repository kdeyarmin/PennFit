/**
 * Clinical fit report → PDF.
 *
 * Portrait Letter with the same 72pt margins and Helvetica scale as the
 * rest of the repo's clinical documents (`swo-pdf.ts`, the billing PDFs),
 * so a fit report filed alongside a Standard Written Order looks like it
 * belongs in the same chart.
 *
 * Narrative rather than tabular: the point of this document is that a
 * respiratory therapist can read WHY, not just what.
 *
 * PHI posture: the rendered bytes are PHI. They are streamed to an
 * authenticated caller and never written to disk or to the logger.
 */

import PDFDocument from "pdfkit";
import type PDFKit from "pdfkit";

import { measurementLabel, type FitReport } from "./fit-report.js";

const MARGIN = 72;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;

const OUTCOME_LABEL: Record<string, string> = {
  high_confidence: "High confidence — proceed through the normal workflow",
  moderate_confidence: "Moderate confidence — clinician review recommended",
  low_confidence: "Low confidence — new scan or manual fitting required",
  contraindicated: "Contraindicated — product automatically excluded",
  outside_validated_range:
    "Outside the validated range — no automated recommendation",
};

export function renderFitReportPdf(report: FitReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: MARGIN });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      draw(doc, report);
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function draw(doc: PDFKit.PDFDocument, r: FitReport): void {
  // ── Header ──
  doc
    .fontSize(8)
    .font("Helvetica-Bold")
    .fillColor("#666666")
    .text("CONFIDENTIAL — HIPAA PROTECTED HEALTH INFORMATION", MARGIN, MARGIN, {
      width: USABLE_WIDTH,
      align: "center",
    });
  doc.fillColor("#000000").moveDown(0.6);
  rule(doc);
  doc.moveDown(0.6);

  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .text("Mask Fit Report", { width: USABLE_WIDTH });
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#444444")
    .text(r.header.practiceName, { width: USABLE_WIDTH });
  if (r.header.locationName) {
    doc.text(r.header.locationName, { width: USABLE_WIDTH });
  }
  doc
    .fontSize(8)
    .text(`Report ${r.header.reportId} · generated ${r.header.generatedAt}`, {
      width: USABLE_WIDTH,
    });
  doc.fillColor("#000000").moveDown(0.8);

  // ── Outcome banner. Deliberately the first thing after the title:
  //    "we are not confident about this" must not be buried. ──
  if (r.session.outcome) {
    const withheld =
      r.session.outcome !== "high_confidence" &&
      r.session.outcome !== "moderate_confidence";
    box(
      doc,
      OUTCOME_LABEL[r.session.outcome] ?? r.session.outcome,
      withheld ? "#8a1c1c" : "#1c5c8a",
    );
    if (r.session.guidance) {
      doc
        .fontSize(9)
        .font("Helvetica-Oblique")
        .text(r.session.guidance, { width: USABLE_WIDTH });
      doc.font("Helvetica").moveDown(0.5);
    }
  }

  if (r.provenance.degraded) {
    box(
      doc,
      "Generated in degraded mode — the provider catalog was unavailable and a built-in fallback was used.",
      "#8a6b1c",
    );
  }

  // ── Patient + session ──
  section(doc, "Patient and session");
  field(doc, "Patient", r.patient.name ?? "Not attached to a chart");
  if (r.patient.dateOfBirth) field(doc, "Date of birth", r.patient.dateOfBirth);
  if (r.patient.patientRef)
    field(doc, "Patient reference", r.patient.patientRef);
  field(doc, "Scan date and time", r.capture.scanDateTime);
  field(
    doc,
    "Service line",
    `${r.session.population} · ${r.session.serviceLine}`,
  );
  field(
    doc,
    "How the fitting was started",
    r.session.entryPoint.replace(/_/g, " "),
  );
  if (r.session.confidence !== null) {
    field(
      doc,
      "Recommendation confidence",
      `${Math.round(r.session.confidence * 100)}%`,
    );
  }

  // ── Scan quality ──
  section(doc, "Scan quality");
  field(doc, "Frames captured", String(r.capture.frameCount));
  field(doc, "Calibration", r.capture.calibrationMethod ?? "Iris reference");
  field(
    doc,
    "Measurement confidence",
    r.capture.measurementConfidence === null
      ? "Not recorded"
      : `${Math.round(r.capture.measurementConfidence * 100)}% (${r.capture.band ?? "unknown"})`,
  );
  field(doc, "Overall grade", r.capture.grade ?? "Not recorded");
  const qualityEntries = Object.entries(r.capture.quality);
  if (qualityEntries.length > 0) {
    field(
      doc,
      "Per-check scores",
      qualityEntries
        .map(([k, v]) => `${k} ${Math.round(Number(v) * 100)}%`)
        .join(" · "),
    );
  }
  const agreementEntries = Object.entries(r.capture.agreement);
  if (agreementEntries.length > 0) {
    field(
      doc,
      "Cross-frame agreement",
      agreementEntries
        .map(
          ([k, v]) => `${measurementLabel(k)} ${Math.round(Number(v) * 100)}%`,
        )
        .join(" · "),
    );
  }

  // ── Measurements ──
  section(doc, "Facial measurements");
  for (const [key, value] of Object.entries(r.measurements)) {
    if (typeof value !== "number") continue;
    field(doc, measurementLabel(key), `${value.toFixed(1)} mm`);
  }

  // ── Questionnaire ──
  if (r.profile.length > 0) {
    section(doc, "Patient fit profile");
    for (const qa of r.profile) {
      field(doc, qa.question, qa.answer);
    }
  }

  // ── Safety screening ──
  section(doc, "Safety screening");
  if (r.safety.screenVersion) {
    field(doc, "Question set version", r.safety.screenVersion);
  }
  if (r.safety.responses.length === 0) {
    doc
      .fontSize(10)
      .font("Helvetica-Oblique")
      .text("No safety screening was recorded for this session.", {
        width: USABLE_WIDTH,
      });
    doc.font("Helvetica");
  } else {
    for (const resp of r.safety.responses) {
      field(
        doc,
        `${resp.subject === "household" ? "[Household] " : ""}${resp.prompt}`,
        resp.answer.toUpperCase(),
      );
    }
  }
  if (r.safety.flags.length > 0) {
    field(doc, "Risk flags raised", r.safety.flags.join(", "));
  }
  if (r.safety.attestedAt) {
    field(doc, "Attested at", r.safety.attestedAt);
    if (r.safety.attestationCopy) {
      doc
        .fontSize(8)
        .font("Helvetica-Oblique")
        .fillColor("#444444")
        .text(r.safety.attestationCopy, { width: USABLE_WIDTH });
      doc.fillColor("#000000").font("Helvetica").fontSize(10);
    }
  }

  // ── Primary recommendation ──
  section(doc, "Primary recommendation");
  if (!r.primary) {
    doc
      .fontSize(10)
      .font("Helvetica-Oblique")
      .text(
        "No automated recommendation was issued for this session. See the outcome above.",
        { width: USABLE_WIDTH },
      );
    doc.font("Helvetica");
  } else {
    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .text(`${r.primary.manufacturer} ${r.primary.name}`, {
        width: USABLE_WIDTH,
      });
    doc.fontSize(10).font("Helvetica");
    field(doc, "Category", r.primary.interfaceType.replace(/_/g, " "));
    if (r.primary.cushion) {
      field(
        doc,
        "Cushion size",
        `${r.primary.cushion.sizeLabel} (${r.primary.cushion.fitDataSource} sizing data${r.primary.cushion.needsClinicalReview ? ", pending clinical review" : ""})`,
      );
      field(doc, "Sizing rationale", r.primary.cushion.rationale);
      if (r.primary.cushion.measurementsUsed.length > 0) {
        field(
          doc,
          "Measurements that drove the size",
          r.primary.cushion.measurementsUsed.map(measurementLabel).join(", "),
        );
      }
    }
    if (r.primary.frame) {
      field(doc, "Frame size", r.primary.frame.sizeLabel);
    }
    field(doc, "Clinical match", `${Math.round(r.primary.confidence * 100)}%`);
    if (r.primary.reasons.length > 0) {
      bullets(doc, "Why this mask", r.primary.reasons);
    }
    if (r.primary.cautions.length > 0) {
      bullets(doc, "Things to watch", r.primary.cautions);
    }
    if (r.primary.outsideFormulary) {
      box(
        doc,
        `Clinically indicated but outside the provider formulary. ${r.primary.outsideFormularyReason ?? ""}`.trim(),
        "#8a6b1c",
      );
    }
  }

  // ── Alternatives ──
  if (r.alternatives.length > 0) {
    section(doc, "Alternatives");
    for (const alt of r.alternatives) {
      doc
        .fontSize(11)
        .font("Helvetica-Bold")
        .text(
          `${alt.manufacturer} ${alt.name}${alt.cushion ? ` · ${alt.cushion.sizeLabel}` : ""}`,
          { width: USABLE_WIDTH },
        );
      doc.fontSize(9).font("Helvetica").fillColor("#444444");
      doc.text(
        `${alt.interfaceType.replace(/_/g, " ")} · clinical match ${Math.round(alt.confidence * 100)}%`,
        { width: USABLE_WIDTH },
      );
      if (alt.rankedBelowBecause) {
        doc.text(`Ranked below the primary: ${alt.rankedBelowBecause}`, {
          width: USABLE_WIDTH,
        });
      }
      doc.fillColor("#000000").fontSize(10).moveDown(0.4);
    }
  }

  // ── What was ruled out. The defensibility section. ──
  if (r.excluded.length > 0) {
    section(doc, "Ruled out");
    doc
      .fontSize(9)
      .font("Helvetica-Oblique")
      .fillColor("#444444")
      .text(
        "Products removed from consideration before ranking, with the reason. Safety and therapy-compatibility exclusions cannot be overridden by formulary or stock preference.",
        { width: USABLE_WIDTH },
      );
    doc.fillColor("#000000").font("Helvetica").fontSize(9).moveDown(0.3);
    for (const ex of r.excluded) {
      doc.font("Helvetica-Bold").text(`${ex.maskName} — tier ${ex.tier}`, {
        width: USABLE_WIDTH,
        continued: false,
      });
      doc.font("Helvetica").text(ex.clinicianReason, { width: USABLE_WIDTH });
      doc.moveDown(0.25);
    }
    doc.fontSize(10);
  }

  // ── Clinician disposition ──
  section(doc, "Clinical review");
  field(doc, "Status", r.review.status.replace(/_/g, " "));
  if (r.review.reviewerEmail) field(doc, "Reviewed by", r.review.reviewerEmail);
  if (r.review.reviewedAt) field(doc, "Reviewed at", r.review.reviewedAt);
  if (r.review.decision) field(doc, "Decision", r.review.decision);
  if (r.review.overrideTo) {
    field(
      doc,
      "Override",
      `${r.review.overrideFrom ?? "recommended mask"} → ${r.review.overrideTo}`,
    );
  }
  if (r.review.overrideReason) {
    field(doc, "Override reason", r.review.overrideReason);
  }

  // ── Dispensing outcome ──
  section(doc, "Order and dispensing");
  field(doc, "Ordered", r.dispensing.orderedMask ?? "Not yet ordered");
  if (r.dispensing.orderedSize) field(doc, "Size", r.dispensing.orderedSize);
  if (r.dispensing.orderId) field(doc, "Order", r.dispensing.orderId);
  field(doc, "Dispensed", r.dispensing.dispensedAt ?? "Not yet dispensed");

  // ── Provenance ──
  section(doc, "Provenance");
  field(doc, "Rules engine version", r.provenance.rulesEngineVersion);
  field(
    doc,
    "Formulary",
    r.provenance.formularyName
      ? `${r.provenance.formularyName} v${r.provenance.formularyVersion ?? "?"}`
      : "None configured (unrestricted)",
  );
  field(
    doc,
    "Catalog snapshot",
    r.provenance.catalogSnapshotVersion === null
      ? "Not recorded"
      : `v${r.provenance.catalogSnapshotVersion}`,
  );

  // ── Audit history ──
  if (r.auditTrail.length > 0) {
    section(doc, "Session history");
    doc.fontSize(9).font("Helvetica");
    for (const ev of r.auditTrail) {
      doc.text(
        `${ev.occurredAt}  ${ev.eventType}  (${ev.actorKind}${ev.actorEmail ? ` · ${ev.actorEmail}` : ""})`,
        { width: USABLE_WIDTH },
      );
    }
    doc.fontSize(10);
  }

  // ── Footer ──
  doc.moveDown(1);
  rule(doc);
  doc.moveDown(0.4);
  doc
    .fontSize(8)
    .font("Helvetica-Oblique")
    .fillColor("#555555")
    .text(r.disclaimer, { width: USABLE_WIDTH });
  doc.fillColor("#000000");
}

function section(doc: PDFKit.PDFDocument, label: string): void {
  // Start a new page rather than orphan a heading at the foot of one.
  if (doc.y > PAGE_HEIGHT - MARGIN - 90) doc.addPage();
  doc.moveDown(0.7);
  doc
    .fontSize(11)
    .font("Helvetica-Bold")
    .fillColor("#1c3d5c")
    .text(label.toUpperCase(), { width: USABLE_WIDTH });
  doc.fillColor("#000000");
  rule(doc);
  doc.moveDown(0.35);
  doc.fontSize(10).font("Helvetica");
}

function field(doc: PDFKit.PDFDocument, label: string, value: string): void {
  if (doc.y > PAGE_HEIGHT - MARGIN - 40) doc.addPage();
  doc.fontSize(10).font("Helvetica-Bold").text(`${label}: `, {
    width: USABLE_WIDTH,
    continued: true,
  });
  doc.font("Helvetica").text(value, { width: USABLE_WIDTH });
}

function bullets(
  doc: PDFKit.PDFDocument,
  label: string,
  items: string[],
): void {
  doc.moveDown(0.3);
  doc.fontSize(10).font("Helvetica-Bold").text(label, { width: USABLE_WIDTH });
  doc.font("Helvetica").fontSize(9);
  for (const item of items) {
    if (doc.y > PAGE_HEIGHT - MARGIN - 40) doc.addPage();
    doc.text(`•  ${item}`, {
      width: USABLE_WIDTH - 12,
      indent: 8,
    });
  }
  doc.fontSize(10).moveDown(0.2);
}

function box(doc: PDFKit.PDFDocument, text: string, color: string): void {
  doc.moveDown(0.3);
  const top = doc.y;
  doc.fontSize(10).font("Helvetica-Bold").fillColor(color);
  doc.text(text, MARGIN + 10, top + 6, { width: USABLE_WIDTH - 20 });
  const bottom = doc.y + 6;
  doc
    .lineWidth(2)
    .strokeColor(color)
    .moveTo(MARGIN + 2, top + 2)
    .lineTo(MARGIN + 2, bottom)
    .stroke();
  doc.fillColor("#000000").strokeColor("#000000").font("Helvetica");
  doc.y = bottom;
  doc.x = MARGIN;
  doc.moveDown(0.5);
}

function rule(doc: PDFKit.PDFDocument): void {
  doc
    .lineWidth(0.5)
    .strokeColor("#cccccc")
    .moveTo(MARGIN, doc.y)
    .lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .stroke()
    .strokeColor("#000000");
}
