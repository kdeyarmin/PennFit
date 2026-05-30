// Build a MedWatch-style summary for a patient_grievances row of
// kind=adverse_event. The output is structured + an HTML preview
// the CSR can paste into the FDA's online voluntary-reporting
// form at https://www.accessdata.fda.gov/scripts/medwatch.
//
// We deliberately do NOT generate the FDA Form 3500 PDF —
// the form is vendor-supplied and the FDA prefers the online
// submission path. This summary is a clipboard-friendly aid;
// the regulatory submission still happens on the FDA's side.
//
// Pure (no DB, no Date.now): test-friendly.

export interface MedWatchInput {
  /** patient_grievances row */
  grievance: {
    id: string;
    summary: string;
    description: string | null;
    severity: "low" | "moderate" | "high";
    receivedAt: string; // YYYY-MM-DD
    fdaReportReference: string | null;
    kind: "complaint" | "grievance" | "adverse_event";
  };
  /** patients row */
  patient: {
    id: string;
    legalFirstName: string;
    legalLastName: string;
    dateOfBirth: string | null;
    sex: string | null;
  };
  /** equipment_assets row (optional — adverse events may not
   *  involve a specific device, e.g. medication side-effect). */
  asset: {
    manufacturer: string;
    model: string;
    serialNumber: string;
    dispensedAt: string | null;
  } | null;
  /** Practice info for the reporter block. */
  practiceName: string;
}

export interface MedWatchSummary {
  /** Structured copy-paste fields. The FDA form has these exact
   *  labels; we keep them consistent so the CSR can match field
   *  names by eye. */
  fields: {
    patientInitials: string;
    patientAge: string; // computed from DOB at print time
    patientSex: string;
    eventDate: string;
    eventDescription: string;
    productName: string;
    productCode: string;
    lotSerial: string;
    productDispensedDate: string;
    reporterName: string;
    reportReference: string;
  };
  /** Print-friendly HTML the CSR can save as PDF in their browser. */
  html: string;
}

function computeAgeYears(dateOfBirth: string | null, asOf: Date): string {
  if (!dateOfBirth) return "—";
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return "—";
  const years = asOf.getUTCFullYear() - dob.getUTCFullYear();
  // Approximate; the FDA form accepts year-only age.
  const beforeBirthday =
    asOf.getUTCMonth() < dob.getUTCMonth() ||
    (asOf.getUTCMonth() === dob.getUTCMonth() &&
      asOf.getUTCDate() < dob.getUTCDate());
  return String(beforeBirthday ? years - 1 : years);
}

export function buildMedWatchSummary(
  input: MedWatchInput,
  asOf: Date = new Date(),
): MedWatchSummary {
  const { grievance, patient, asset, practiceName } = input;
  const patientInitials = `${patient.legalFirstName.slice(0, 1).toUpperCase()}${patient.legalLastName.slice(0, 1).toUpperCase()}`;
  const patientAge = computeAgeYears(patient.dateOfBirth, asOf);
  const patientSex = patient.sex ? patient.sex.slice(0, 1).toUpperCase() : "—";
  const eventDescription = [grievance.summary, grievance.description ?? ""]
    .filter((s) => s.length > 0)
    .join("\n\n");
  const productName = asset ? `${asset.manufacturer} ${asset.model}` : "—";
  const lotSerial = asset?.serialNumber ?? "—";
  const productDispensedDate = asset?.dispensedAt ?? "—";
  const productCode = "—"; // FDA product code requires manual lookup
  const reportReference =
    grievance.fdaReportReference ?? `PennFit-${grievance.id.slice(0, 8)}`;

  const fields: MedWatchSummary["fields"] = {
    patientInitials,
    patientAge,
    patientSex,
    eventDate: grievance.receivedAt,
    eventDescription,
    productName,
    productCode,
    lotSerial,
    productDispensedDate,
    reporterName: practiceName,
    reportReference,
  };

  const html = renderHtml(fields, grievance.severity);
  return { fields, html };
}

function renderHtml(
  fields: MedWatchSummary["fields"],
  severity: "low" | "moderate" | "high",
): string {
  const row = (label: string, value: string): string =>
    `<tr><td style="font-weight:600;padding:6px 10px;background:#f4f4f4;border:1px solid #ddd;width:200px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 10px;border:1px solid #ddd;white-space:pre-wrap;">${escapeHtml(value)}</td></tr>`;
  return [
    `<!doctype html><html><head><meta charset="utf-8"><title>MedWatch summary — ${escapeHtml(fields.reportReference)}</title>`,
    `<style>body{font-family:system-ui,sans-serif;max-width:780px;margin:24px auto;padding:0 16px;}h1{font-size:20px;margin-bottom:4px;}.severity{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;}.sev-low{background:#dbeafe;color:#1e3a8a;}.sev-moderate{background:#fef3c7;color:#92400e;}.sev-high{background:#fee2e2;color:#991b1b;}table{border-collapse:collapse;width:100%;margin:16px 0;}.banner{background:#fff7ed;border:1px solid #fb923c;padding:10px;font-size:13px;margin:12px 0;border-radius:4px;color:#9a3412;}</style></head><body>`,
    `<h1>MedWatch voluntary report summary</h1>`,
    `<div><span class="severity sev-${severity}">${severity}</span> · reference <code>${escapeHtml(fields.reportReference)}</code></div>`,
    `<div class="banner">Paste these field values into the FDA Voluntary Reporting form at <strong>accessdata.fda.gov/scripts/medwatch</strong>. This document is a clipboard aid; the regulatory submission happens on the FDA's site.</div>`,
    `<table>`,
    row("Patient initials", fields.patientInitials),
    row("Patient age (years)", fields.patientAge),
    row("Patient sex", fields.patientSex),
    row("Event date", fields.eventDate),
    row("Event description", fields.eventDescription),
    row("Product name", fields.productName),
    row("Product code", fields.productCode),
    row("Lot / serial #", fields.lotSerial),
    row("Date product dispensed", fields.productDispensedDate),
    row("Reporter (practice)", fields.reporterName),
    `</table>`,
    `<p style="color:#666;font-size:12px;">Generated by PennFit. Do not redistribute. PHI inside.</p>`,
    `</body></html>`,
  ].join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
