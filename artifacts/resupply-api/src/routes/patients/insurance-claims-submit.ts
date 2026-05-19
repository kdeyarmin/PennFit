// /admin/patients/:id/insurance-claims/:claimId/submit-office-ally
//
// Build the 837P EDI for a single draft claim, upload it to Office
// Ally (or write to the file-drop outbox in stub mode), and persist a
// `resupply.office_ally_submissions` row pointing at the claim.
//
// Side-effects on success:
//   1. office_ally_submissions row created with the X12 control
//      numbers + upload status,
//   2. insurance_claims row patched: status=submitted, submitted_at=now,
//      office_ally_submission_id=<new row>,
//   3. insurance_claim_events row inserted for the 'submitted' event,
//   4. audit_log row HMAC-chained for the action.
//
// Preconditions enforced before any I/O:
//   * claim must be in `draft` status (state machine guard),
//   * claim must reference a non-null payer_profile_id whose
//     office_ally_payer_id is set (paper-only payers are rejected
//     with a clear error so the UI can route to a print path),
//   * claim must have >= 1 line item,
//   * patient + insurance_coverage rows must be readable (for
//     subscriber demographics on the 837P).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  allocateControlNumbers,
  createOfficeAllyAdapter,
} from "@workspace/resupply-integrations-office-ally";

import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});

const submitBody = z
  .object({
    /** Override the test-mode flag. Defaults to whatever
     *  OFFICE_ALLY_USAGE_INDICATOR is configured to. */
    usageIndicator: z.enum(["P", "T"]).optional(),
    /** Optional CSR note attached to the resulting
     *  insurance_claim_events row. */
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .optional();

const FILE_NAME_PREFIX = "PF";

router.post(
  "/patients/:id/insurance-claims/:claimId/submit-office-ally",
  // claims.submit isn't in the Phase A permission set; gate behind the
  // generic CSR coverage path used for the rest of the claim writes.
  requirePermission("conversations.manage"),
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = submitBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();

    // ── Load the claim + ensure it's in the right state ────────────
    const { data: claim, error: claimErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, claim_number, date_of_service, status, total_billed_cents, insurance_coverage_id, payer_profile_id, office_ally_submission_id, notes, rendering_provider_id, referring_provider_id, secondary_coverage_id",
      )
      .eq("id", idParsed.data.claimId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claim) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (claim.status !== "draft") {
      res.status(409).json({
        error: "invalid_state",
        message: `claim is in status '${claim.status}', only draft claims can be submitted`,
      });
      return;
    }
    if (claim.office_ally_submission_id) {
      res.status(409).json({
        error: "already_submitted",
        message: "claim already linked to an Office Ally submission",
      });
      return;
    }
    if (!claim.payer_profile_id) {
      res.status(400).json({
        error: "missing_payer_profile",
        message:
          "claim has no payer_profile_id; pick a payer from the catalog before submitting",
      });
      return;
    }

    // ── Load the payer profile + verify it's electronically billable ─
    const { data: payer, error: payerErr } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(
        "id, display_name, payer_legal_name, office_ally_payer_id, paper_only, is_active, claim_format",
      )
      .eq("id", claim.payer_profile_id)
      .limit(1)
      .maybeSingle();
    if (payerErr) throw payerErr;
    if (!payer) {
      res.status(409).json({ error: "payer_profile_missing" });
      return;
    }
    if (!payer.is_active) {
      res.status(409).json({
        error: "payer_inactive",
        message: "this payer is marked inactive in the catalog",
      });
      return;
    }
    if (payer.paper_only || !payer.office_ally_payer_id) {
      res.status(409).json({
        error: "payer_not_electronic",
        message:
          "this payer does not accept electronic 837P submissions; generate a paper HCFA-1500 instead",
      });
      return;
    }
    if (payer.claim_format !== "837p") {
      res.status(409).json({
        error: "unsupported_claim_format",
        message: `office ally adapter currently emits 837p; payer expects ${payer.claim_format}`,
      });
      return;
    }

    // ── Load line items ────────────────────────────────────────────
    const { data: lines, error: linesErr } = await supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select(
        "id, hcpcs_code, modifier, billed_cents, quantity",
      )
      .eq("claim_id", claim.id)
      .order("created_at", { ascending: true });
    if (linesErr) throw linesErr;
    if (!lines || lines.length === 0) {
      res.status(400).json({
        error: "no_line_items",
        message: "claim has no HCPCS line items to bill",
      });
      return;
    }

    // ── Load coverage + patient (subscriber demographics) ──────────
    let coverage: Database["resupply"]["Tables"]["insurance_coverages"]["Row"] | null = null;
    if (claim.insurance_coverage_id) {
      const { data: cov } = await supabase
        .schema("resupply")
        .from("insurance_coverages")
        .select("*")
        .eq("id", claim.insurance_coverage_id)
        .limit(1)
        .maybeSingle();
      coverage = cov ?? null;
    }
    if (!coverage) {
      res.status(400).json({
        error: "missing_coverage",
        message: "claim has no insurance_coverage_id; cannot resolve subscriber",
      });
      return;
    }

    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, legal_first_name, legal_last_name, date_of_birth, address",
      )
      .eq("id", claim.patient_id)
      .limit(1)
      .maybeSingle();
    if (patientErr) throw patientErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const subscriberAddress = pickSubscriberAddress(patient.address);
    if (!subscriberAddress) {
      res.status(400).json({
        error: "missing_subscriber_address",
        message:
          "subscriber address is required by 5010 — update the patient record before submitting",
      });
      return;
    }

    // Diagnosis pointer — for now we attach the line items to the
    // first diagnosis. Multi-pointer support lands when the API model
    // grows per-line diagnosis fields.
    // Placeholder ICD-10 G47.33 (OSA) — the real code lives on the
    // most-recent sleep_study row. We look it up, fall back to G47.33
    // for opt-out cases.
    let primaryDx = "G47.33";
    {
      const { data: sleep } = await supabase
        .schema("resupply")
        .from("sleep_studies")
        .select("diagnosis_icd10")
        .eq("patient_id", claim.patient_id)
        .not("diagnosis_icd10", "is", null)
        .order("study_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (sleep?.diagnosis_icd10) primaryDx = sleep.diagnosis_icd10;
    }

    // ── Load rendering / referring providers + secondary coverage ──
    const [
      { data: renderingProvider },
      { data: referringProvider },
      { data: secondaryCoverage },
    ] = await Promise.all([
      claim.rendering_provider_id
        ? supabase
            .schema("resupply")
            .from("providers")
            .select("legal_name, npi")
            .eq("id", claim.rendering_provider_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      claim.referring_provider_id
        ? supabase
            .schema("resupply")
            .from("providers")
            .select("legal_name, npi")
            .eq("id", claim.referring_provider_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      claim.secondary_coverage_id
        ? supabase
            .schema("resupply")
            .from("insurance_coverages")
            .select("*")
            .eq("id", claim.secondary_coverage_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    // ── Allocate control numbers monotonically vs prior submissions ─
    const { data: priorHigh } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select("isa_control_number")
      .order("isa_control_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const control = allocateControlNumbers({
      submittedAt: Date.now(),
      sequence: 1,
      previousHighest: priorHigh?.isa_control_number ?? undefined,
    });

    // ── Build + upload via the adapter ─────────────────────────────
    const adapter = createOfficeAllyAdapter();
    const submission = await adapter.submitClaims({
      control,
      fileName: buildFileName(control),
      usageIndicatorOverride: bodyParsed.data?.usageIndicator,
      claims: [
        {
          internalClaimId: claim.id.slice(0, 38),
          totalBilledCents: claim.total_billed_cents,
          placeOfServiceCode: "12",
          diagnosisCodes: [primaryDx],
          priorAuthNumber: null,
          subscriber: {
            firstName: patient.legal_first_name,
            lastName: patient.legal_last_name,
            dateOfBirth: patient.date_of_birth,
            gender: "U",
            memberId: coverage.member_id,
            address: subscriberAddress,
            relationshipCode:
              coverage.policyholder_relationship === "self"
                ? "18"
                : coverage.policyholder_relationship === "spouse"
                  ? "01"
                  : coverage.policyholder_relationship === "child"
                    ? "19"
                    : "G8",
          },
          payer: {
            organizationName: payer.payer_legal_name,
            payerId: payer.office_ally_payer_id,
          },
          serviceLines: lines.map((l) => ({
            hcpcsCode: l.hcpcs_code,
            modifiers: (l.modifier ?? "")
              .split(",")
              .map((m) => m.trim().toUpperCase())
              .filter((m) => m.length === 2),
            billedCents: l.billed_cents,
            units: l.quantity,
            serviceDate: claim.date_of_service,
            diagnosisPointers: [1],
          })),
          renderingProvider: renderingProvider
            ? toProviderRef(renderingProvider)
            : null,
          referringProvider: referringProvider
            ? toProviderRef(referringProvider)
            : null,
          otherSubscriber:
            secondaryCoverage && secondaryAddress(patient.address)
              ? {
                  payerResponsibility: "S",
                  priorPayerPaidCents: null,
                  subscriber: {
                    firstName: patient.legal_first_name,
                    lastName: patient.legal_last_name,
                    dateOfBirth: patient.date_of_birth,
                    gender: "U",
                    memberId: secondaryCoverage.member_id,
                    address: secondaryAddress(patient.address)!,
                    relationshipCode:
                      secondaryCoverage.policyholder_relationship === "self"
                        ? "18"
                        : secondaryCoverage.policyholder_relationship === "spouse"
                          ? "01"
                          : secondaryCoverage.policyholder_relationship === "child"
                            ? "19"
                            : "G8",
                  },
                  payer: {
                    organizationName: secondaryCoverage.payer_name,
                    payerId: secondaryCoverage.payer_name.slice(0, 20),
                  },
                }
              : null,
        },
      ],
    });

    // ── Persist office_ally_submissions row ────────────────────────
    const adapterAvailability = adapter.availability();
    const initialStatus =
      submission.upload.ok
        ? adapterAvailability.status === "configured"
          ? "uploaded"
          : "queued"
        : "transport_failed";

    const { data: subRow, error: subErr } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .insert({
        file_name: buildFileName(control),
        isa_control_number: submission.interchangeControlNumber,
        gs_control_number: submission.groupControlNumber,
        status: initialStatus,
        file_size_bytes: submission.fileSizeBytes,
        claim_count: submission.claimCount,
        office_ally_session_id: submission.upload.ok
          ? (submission.upload.sessionId ?? null)
          : null,
        rejection_reason: submission.upload.ok
          ? null
          : submission.upload.message.slice(0, 2000),
        submitted_by_email: req.adminEmail ?? "unknown",
      })
      .select("id")
      .single();
    if (subErr) {
      // Persisting failed — surface; we never silently swallow because
      // a CSR needs to know whether to retry or chase OA support.
      throw subErr;
    }

    // ── If upload succeeded, advance the claim to 'submitted'. On
    //    transport failure we keep the claim in draft so the CSR can
    //    fix the upstream config and retry without a state rollback.
    if (submission.upload.ok) {
      const nowIso = new Date().toISOString();
      const { error: updErr } = await supabase
        .schema("resupply")
        .from("insurance_claims")
        .update({
          status: "submitted",
          submitted_at: nowIso,
          claim_number: submission.interchangeControlNumber, // placeholder until OA assigns one
          office_ally_submission_id: subRow.id,
          updated_at: nowIso,
        })
        .eq("id", claim.id);
      if (updErr) throw updErr;

      await supabase
        .schema("resupply")
        .from("insurance_claim_events")
        .insert({
          claim_id: claim.id,
          event_type: "submitted",
          payer_ref: submission.interchangeControlNumber,
          note:
            bodyParsed.data?.note ??
            `Submitted to Office Ally (${submission.transport}, ${submission.fileSizeBytes} bytes)`,
          actor_email: req.adminEmail ?? "unknown",
        });
    }

    await logAudit({
      action: submission.upload.ok
        ? "insurance_claim.submit_office_ally"
        : "insurance_claim.submit_office_ally_failed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: claim.id,
      metadata: {
        patient_id: claim.patient_id,
        payer_profile_id: payer.id,
        payer_slug: payer.display_name,
        office_ally_submission_id: subRow.id,
        isa_control_number: submission.interchangeControlNumber,
        transport: submission.transport,
        upload_ok: submission.upload.ok,
        ...(submission.upload.ok
          ? {}
          : { failure_kind: submission.upload.kind }),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "insurance_claim.submit_office_ally audit write failed",
      );
    });

    if (!submission.upload.ok) {
      res.status(502).json({
        ok: false,
        error: "upload_failed",
        kind: submission.upload.kind,
        message: submission.upload.message,
        submissionId: subRow.id,
        isaControlNumber: submission.interchangeControlNumber,
      });
      return;
    }
    res.status(201).json({
      ok: true,
      submissionId: subRow.id,
      isaControlNumber: submission.interchangeControlNumber,
      gsControlNumber: submission.groupControlNumber,
      claimCount: submission.claimCount,
      fileSizeBytes: submission.fileSizeBytes,
      transport: submission.transport,
      adapterStatus: adapterAvailability.status,
    });
  },
);

function buildFileName(control: { interchangeControlNumber: string }): string {
  // Office Ally requires a unique name per upload window; ISA13 is
  // monotonic by construction so collision is structural-only.
  return `${FILE_NAME_PREFIX}-${control.interchangeControlNumber}.txt`;
}

function toProviderRef(p: {
  legal_name: string;
  npi: string;
}): {
  npi: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
} {
  // `providers.legal_name` is stored as a single string. Split into
  // last/first for the NM1 segment so the 837P passes name-component
  // validators on the payer side. The split is best-effort — if a
  // name doesn't conform to "First Last" / "Last, First" we send the
  // whole string in NM103 and leave NM104 empty.
  const raw = p.legal_name.trim();
  if (raw.includes(",")) {
    const [last = "", rest = ""] = raw.split(",", 2);
    const firstParts = rest.trim().split(/\s+/);
    return {
      npi: p.npi,
      lastName: last.trim(),
      firstName: firstParts[0] ?? "",
      middleName: firstParts.length > 1 ? firstParts.slice(1).join(" ") : null,
    };
  }
  const parts = raw.split(/\s+/);
  if (parts.length >= 2) {
    return {
      npi: p.npi,
      firstName: parts[0]!,
      lastName: parts[parts.length - 1]!,
      middleName: parts.length > 2 ? parts.slice(1, -1).join(" ") : null,
    };
  }
  return { npi: p.npi, firstName: "", lastName: raw, middleName: null };
}

function secondaryAddress(
  raw: unknown,
): { line1: string; city: string; state: string; zip: string } | null {
  // Secondary subscriber address mirrors the primary patient address —
  // we don't model a separate address per coverage. Return the patient
  // address when populated; null when the patient row lacks one.
  return pickSubscriberAddress(raw);
}

type PatientAddress = {
  line1?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
};

function pickSubscriberAddress(
  raw: unknown,
): { line1: string; city: string; state: string; zip: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as PatientAddress;
  const line1 = typeof a.line1 === "string" ? a.line1 : "";
  const city = typeof a.city === "string" ? a.city : "";
  const state = typeof a.state === "string" ? a.state : "";
  const zip = typeof a.zip === "string" ? a.zip : "";
  if (!line1 || !city || !state || !zip) return null;
  return { line1, city, state, zip };
}

export default router;
