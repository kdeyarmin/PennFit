// Render the 90-day adherence attestation PDF to a Buffer for the
// referral-adherence-report feature (Referral CRM Phase 3).
//
// This re-uses the SAME window finder + renderer the admin-facing
// compliance-attestation route streams (lib/compliance-attestation.ts) —
// so the document a referring provider receives is byte-for-byte the same
// attestation a CSR would generate by hand. The only difference is the
// delivery: the admin route streams to res; here we buffer to a Buffer so
// the worker can (a) attach it to a tenant-sender email or (b) the signed
// fax-document route can serve it to Telnyx.
//
// PHI posture: the returned Buffer is a permitted treatment/care-
// coordination disclosure to the treating/referring provider. Callers must
// NEVER log the PDF bytes, the patient's name, or the therapy text — counts
// and ids only.

import PDFDocument from "pdfkit";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { getDocumentSupplierName } from "../company-info.js";
import {
  findBestAdherenceWindow,
  renderComplianceAttestation,
  type AdherenceNight,
  type AdherenceResult,
  type AttestationInputs,
} from "../compliance-attestation.js";

/** Source priority when the same night exists from multiple feeds.
 *  Mirrors routes/admin/compliance-attestation.ts so the worker-rendered
 *  attestation and the CSR's download never disagree. */
const SOURCE_PRIORITY: Record<string, number> = {
  resmed_airview: 0,
  philips_care: 1,
  manual: 2,
};

export type AdherenceRenderResult =
  | {
      ok: true;
      pdf: Buffer;
      anchorDate: string;
      result: AdherenceResult;
    }
  | { ok: false; reason: "patient_not_found" | "no_therapy_data" };

/**
 * Load a patient's therapy nights, compute the best 30-day adherence
 * window in the first 90 days, and render the attestation PDF to a
 * Buffer. Org-scoped: reads ONLY through the org-scoped client so the
 * patient must belong to `orgId`.
 *
 * @param orgId      owning tenant (fail-closed: caller resolves it).
 * @param patientId  the patient to attest for.
 * @param anchorOverride  optional YYYY-MM-DD anchor; defaults to the
 *   earliest therapy night (same default as the admin route).
 */
export async function renderAdherenceAttestationPdf(
  orgId: string,
  patientId: string,
  anchorOverride?: string,
): Promise<AdherenceRenderResult> {
  const db = getOrgScopedClient(orgId);

  const { data: patientRow, error: pErr } = await db
    .from("patients")
    .select("id, legal_first_name, legal_last_name, date_of_birth")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!patientRow) return { ok: false, reason: "patient_not_found" };

  const { data: nightRowsRaw, error: nErr } = await db
    .from("patient_therapy_nights")
    .select("night_date, source, usage_minutes")
    .eq("patient_id", patientId)
    .order("night_date", { ascending: true });
  if (nErr) throw nErr;

  const nightRows = (nightRowsRaw ?? []) as Array<{
    night_date: string;
    source: string;
    usage_minutes: number | null;
  }>;
  if (nightRows.length === 0) return { ok: false, reason: "no_therapy_data" };

  // Dedupe by night, source-priority winner (matches the admin route).
  const byDate = new Map<string, (typeof nightRows)[number]>();
  for (const row of nightRows) {
    const existing = byDate.get(row.night_date);
    if (!existing) {
      byDate.set(row.night_date, row);
      continue;
    }
    const newRank = SOURCE_PRIORITY[row.source] ?? 99;
    const oldRank = SOURCE_PRIORITY[existing.source] ?? 99;
    if (newRank < oldRank) byDate.set(row.night_date, row);
  }

  const nights: AdherenceNight[] = Array.from(byDate.values())
    .map((r) => ({ date: r.night_date, usageMinutes: r.usage_minutes }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const anchorDate = anchorOverride ?? nights[0]!.date;
  const asOfDate = new Date().toISOString().slice(0, 10);
  const result = findBestAdherenceWindow(nights, anchorDate, asOfDate);

  const supplierName = await getDocumentSupplierName(orgId);
  const inputs: AttestationInputs = {
    patient: {
      legalFirstName: patientRow.legal_first_name,
      legalLastName: patientRow.legal_last_name,
      dateOfBirth: patientRow.date_of_birth,
    },
    anchorDate,
    result,
    generatedOn: new Date(),
    supplierName,
  };

  const pdf = await bufferAttestationPdf(inputs);
  return { ok: true, pdf, anchorDate, result };
}

/** Render the attestation into a Buffer (the admin route streams to res;
 *  the worker / fax path need the bytes in hand). */
function bufferAttestationPdf(inputs: AttestationInputs): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 72, size: "LETTER" });
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      renderComplianceAttestation(doc, inputs);
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
