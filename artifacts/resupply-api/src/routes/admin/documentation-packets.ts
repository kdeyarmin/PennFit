// /admin/patients/:id/documentation-packets
//
//   POST — render a packet for a given kind. Body specifies which
//          source documents to include; the route assembles the
//          section content (sleep study summary, Rx summary, etc.)
//          + the cover letter, renders the PDF, persists a row.
//   GET  — list patient's prior packets.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  renderDocumentationPacket,
  type PacketSection,
} from "../../lib/billing/documentation-packet";
import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const body = z
  .object({
    kind: z.enum([
      "prior_auth_support",
      "appeal_support",
      "accreditation_audit",
      "medical_records_request",
    ]),
    includeSleepStudyIds: z.array(z.string().uuid()).max(20).default([]),
    includePrescriptionIds: z.array(z.string().uuid()).max(20).default([]),
    includeDwoDocumentIds: z.array(z.string().uuid()).max(20).default([]),
    includeComplianceWindowDays: z.number().int().min(0).max(120).default(30),
    coverLetterBody: z.string().trim().max(8000).nullable().optional(),
    addresseeName: z.string().trim().max(160).nullable().optional(),
    addresseeAddressLines: z
      .array(z.string().trim().min(1).max(160))
      .max(6)
      .nullable()
      .optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.get(
  "/admin/patients/:id/documentation-packets",
  requireAdmin,
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("documentation_packets")
      .select("*")
      .eq("patient_id", parsed.data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    res.json({ packets: data ?? [] });
  },
);

router.post(
  "/admin/patients/:id/documentation-packets",
  requireAdmin,
  adminRateLimit({
    name: "documentation_packets.create",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("legal_first_name, legal_last_name, date_of_birth, insurance_payer")
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const identity = await resolveBillingIdentity({ supabase });
    if (identity.source === "stub") {
      res.status(409).json({ error: "no_dme_organization" });
      return;
    }

    const sections: PacketSection[] = [];

    // Sleep studies summary.
    if (b.includeSleepStudyIds.length > 0) {
      const { data: studies } = await supabase
        .schema("resupply")
        .from("sleep_studies")
        .select(
          "id, study_date, study_type, ahi, rdi, lowest_spo2_pct, diagnosis_icd10, facility_name",
        )
        .in("id", b.includeSleepStudyIds)
        .eq("patient_id", idParsed.data.id);
      sections.push({
        title: "Sleep Study Records",
        paragraphs: [
          `The following sleep studies are included with this packet (${studies?.length ?? 0} record${
            (studies?.length ?? 0) === 1 ? "" : "s"
          }).`,
        ],
        bullets: (studies ?? []).map(
          (s) =>
            `${s.study_date} — ${s.study_type.toUpperCase()} ${s.facility_name ?? ""}: AHI ${s.ahi}${s.rdi ? `, RDI ${s.rdi}` : ""}${s.lowest_spo2_pct ? `, low SpO2 ${s.lowest_spo2_pct}%` : ""} (${s.diagnosis_icd10 ?? "no dx"})`,
        ),
        attachments: (studies ?? []).map((s) => ({
          name: `Sleep study ${s.study_date}`,
          objectKey: null,
        })),
      });
    }

    // Prescription summary.
    if (b.includePrescriptionIds.length > 0) {
      const { data: rxs } = await supabase
        .schema("resupply")
        .from("prescriptions")
        .select(
          "id, hcpcs_code, item_sku, valid_from, valid_until, status, provider_id",
        )
        .in("id", b.includePrescriptionIds)
        .eq("patient_id", idParsed.data.id);
      sections.push({
        title: "Prescriptions",
        paragraphs: [
          `Active prescriptions on file (${rxs?.length ?? 0}).`,
        ],
        bullets: (rxs ?? []).map(
          (r) =>
            `${r.hcpcs_code ?? r.item_sku} — valid ${r.valid_from}${r.valid_until ? ` – ${r.valid_until}` : ""} (${r.status})`,
        ),
      });
    }

    // Compliance attestation summary.
    if (b.includeComplianceWindowDays > 0) {
      const since = new Date(
        Date.now() - b.includeComplianceWindowDays * 24 * 3600 * 1000,
      )
        .toISOString()
        .slice(0, 10);
      const { data: nights } = await supabase
        .schema("resupply")
        .from("patient_therapy_nights")
        .select("usage_minutes, night_date")
        .eq("patient_id", idParsed.data.id)
        .gte("night_date", since)
        .limit(180);
      const withData = (nights ?? []).filter((n) => n.usage_minutes !== null);
      const compliantNights = withData.filter(
        (n) => (n.usage_minutes ?? 0) >= 240,
      ).length;
      const avgMin = withData.length
        ? Math.round(
            withData.reduce((s, n) => s + (n.usage_minutes ?? 0), 0) /
              withData.length,
          )
        : 0;
      sections.push({
        title: "Therapy Compliance Attestation",
        paragraphs: [
          `Window: last ${b.includeComplianceWindowDays} days.`,
          `Nights with usage data: ${withData.length}. Nights meeting 4+ hour threshold: ${compliantNights}. CMS LCD L33718 requires 21 compliant nights in any rolling 30-day window during the first 90 days.`,
        ],
        bullets: [
          `Average usage on nights with data: ${avgMin} minutes.`,
          `Compliant nights / 21 target: ${compliantNights} / 21.`,
          compliantNights >= 21
            ? "Patient meets CMS compliance standard for this window."
            : "Patient does NOT meet CMS compliance for this window.",
        ],
      });
    }

    // DWO summary.
    if (b.includeDwoDocumentIds.length > 0) {
      const { data: dwos } = await supabase
        .schema("resupply")
        .from("dwo_documents")
        .select("id, hcpcs_family, form_type, signed_on, expires_on")
        .in("id", b.includeDwoDocumentIds)
        .eq("patient_id", idParsed.data.id);
      sections.push({
        title: "DWO / CMN Documents",
        paragraphs: [
          `DWO / CMN documents on file (${dwos?.length ?? 0}).`,
        ],
        bullets: (dwos ?? []).map(
          (d) =>
            `${d.form_type.toUpperCase()} for ${d.hcpcs_family} — signed ${d.signed_on}, expires ${d.expires_on}`,
        ),
      });
    }

    const packet = await renderDocumentationPacket({
      kind: b.kind,
      dmeOrganization: {
        legalName:
          identity.organization?.legal_name ??
          identity.billingProvider.organizationName,
        addressLine1: identity.billingProvider.address.line1,
        city: identity.billingProvider.address.city,
        state: identity.billingProvider.address.state,
        zip: identity.billingProvider.address.zip,
        phoneE164: identity.organization?.phone_e164 ?? "+10000000000",
        billingEmail:
          identity.organization?.billing_email ?? "billing@example.com",
        npi: identity.billingProvider.npi,
      },
      addressee: b.addresseeName
        ? {
            name: b.addresseeName,
            addressLines: b.addresseeAddressLines ?? undefined,
          }
        : undefined,
      patient: {
        firstName: patient.legal_first_name,
        lastName: patient.legal_last_name,
        dateOfBirth: patient.date_of_birth,
        payerName: patient.insurance_payer ?? null,
      },
      sections,
      coverLetterBody: b.coverLetterBody ?? null,
      signerName: identity.organization?.authorized_signer_name ?? null,
      signerTitle: identity.organization?.authorized_signer_title ?? null,
    });

    const insertRow: Database["resupply"]["Tables"]["documentation_packets"]["Insert"] = {
      patient_id: idParsed.data.id,
      kind: b.kind,
      included_docs_json: {
        sleep_study_ids: b.includeSleepStudyIds,
        prescription_ids: b.includePrescriptionIds,
        dwo_document_ids: b.includeDwoDocumentIds,
        compliance_window_days: b.includeComplianceWindowDays,
      } as unknown as Json,
      page_count: packet.pageCount,
      notes: b.notes ?? null,
      generated_by_email: req.adminEmail ?? "unknown",
    };
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("documentation_packets")
      .insert(insertRow)
      .select("id")
      .single();
    if (error) throw error;

    await logAudit({
      action: "documentation_packet.generate",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "documentation_packets",
      targetId: row.id,
      metadata: {
        patient_id: idParsed.data.id,
        kind: b.kind,
        page_count: packet.pageCount,
        section_count: sections.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "documentation_packet.generate audit write failed");
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="packet-${row.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("X-Packet-Id", row.id);
    res.setHeader("X-Packet-Page-Count", String(packet.pageCount));
    res.status(201).end(packet.pdf);
  },
);

export default router;
