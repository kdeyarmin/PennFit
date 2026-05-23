// Shared core for the Office Ally batch-submit flow.
//
// Extracted from `routes/admin/billing-batch-submit.ts` (the original
// home of this code) so the new resubmit route at
// `POST /admin/office-ally-submissions/:id/resubmit` can reuse the
// exact same preflight + EDI build + transport + persistence sequence
// without the two paths drifting.
//
// The function returns a discriminated-union result so the calling
// route can map outcomes to HTTP status codes without leaking
// implementation details. PHI never leaves this module: only claim
// IDs, control numbers, and a coarse upload-result message ever
// appear in the return value.

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  allocateControlNumbers,
  build837P,
  createOfficeAllyAdapter,
  type ClaimDetail,
} from "@workspace/resupply-integrations-office-ally";

import { resolveBillingIdentity } from "./identity-resolver";
import { logger } from "../logger";
import { publishEvent } from "../webhooks/publisher";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type ClaimRow = Database["resupply"]["Tables"]["insurance_claims"]["Row"];

export interface BatchSubmitInput {
  claimIds: string[];
  usageIndicator?: "P" | "T";
  /** When provided, the new office_ally_submissions row records this
   *  as `parent_submission_id` so the dashboard can show the chain. */
  parentSubmissionId?: string | null;
  adminEmail: string | null;
  adminUserId: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type BatchSubmitResult =
  | {
      ok: true;
      submissionId: string;
      claimCount: number;
      isaControlNumber: string;
      gsControlNumber: string;
      fileSizeBytes: number;
      transport: string;
      uploadOk: boolean;
      uploadError: string | null;
    }
  | {
      ok: false;
      kind:
        | "no_claims_matched"
        | "some_claims_not_found"
        | "batch_payer_mismatch"
        | "non_draft_claims_in_batch"
        | "payer_not_electronic"
        | "claim_missing_required_data";
      detail: Record<string, unknown>;
    };

export async function executeOfficeAllyBatchSubmit(
  input: BatchSubmitInput,
): Promise<BatchSubmitResult> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: claims, error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("*")
    .in("id", input.claimIds);
  if (error) throw error;
  if (!claims || claims.length === 0) {
    return { ok: false, kind: "no_claims_matched", detail: {} };
  }
  if (claims.length !== input.claimIds.length) {
    const missing = input.claimIds.filter(
      (id) => !claims.some((c) => c.id === id),
    );
    return {
      ok: false,
      kind: "some_claims_not_found",
      detail: { missing },
    };
  }

  const payerProfileIds = [...new Set(claims.map((c) => c.payer_profile_id))];
  if (payerProfileIds.length !== 1 || !payerProfileIds[0]) {
    return {
      ok: false,
      kind: "batch_payer_mismatch",
      detail: {
        message: "all claims in a batch must reference the same payer_profile_id",
      },
    };
  }

  const draftIssues = claims.filter((c) => c.status !== "draft");
  if (draftIssues.length > 0) {
    return {
      ok: false,
      kind: "non_draft_claims_in_batch",
      detail: { claimIds: draftIssues.map((c) => c.id) },
    };
  }

  const { data: payer } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select(
      "id, payer_legal_name, office_ally_payer_id, paper_only, claim_format, is_active, edi_enrollment_status",
    )
    .eq("id", payerProfileIds[0])
    .limit(1)
    .maybeSingle();
  if (
    !payer ||
    !payer.is_active ||
    payer.paper_only ||
    !payer.office_ally_payer_id ||
    payer.edi_enrollment_status !== "enrolled"
  ) {
    return {
      ok: false,
      kind: "payer_not_electronic",
      detail: {
        message:
          "payer must be active + electronic + carry an office_ally_payer_id + edi_enrollment_status='enrolled'",
        ediEnrollmentStatus: payer?.edi_enrollment_status ?? null,
      },
    };
  }

  const detailEntries: ClaimDetail[] = [];
  for (const claim of claims) {
    const detail = await buildOneDetail(
      supabase,
      claim,
      payer.payer_legal_name,
      payer.office_ally_payer_id,
    );
    if (!detail) {
      return {
        ok: false,
        kind: "claim_missing_required_data",
        detail: { claimId: claim.id },
      };
    }
    detailEntries.push(detail);
  }

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

  const identity = await resolveBillingIdentity({ supabase });
  const adapter = createOfficeAllyAdapter({
    submitterOverride: identity.submitter,
    billingProviderOverride: identity.billingProvider,
    usageIndicatorOverride: identity.usageIndicator,
  });
  const fileName = `PF-BATCH-${control.interchangeControlNumber}.txt`;
  const submission = await adapter.submitClaims({
    control,
    fileName,
    usageIndicatorOverride: input.usageIndicator,
    claims: detailEntries,
  });

  const status = submission.upload.ok
    ? identity.source === "stub"
      ? "queued"
      : "uploaded"
    : "transport_failed";
  const { data: subRow, error: subErr } = await supabase
    .schema("resupply")
    .from("office_ally_submissions")
    .insert({
      file_name: fileName,
      isa_control_number: submission.interchangeControlNumber,
      gs_control_number: submission.groupControlNumber,
      status,
      file_size_bytes: submission.fileSizeBytes,
      claim_count: submission.claimCount,
      rejection_reason: submission.upload.ok
        ? null
        : submission.upload.message.slice(0, 2000),
      submitted_by_email: input.adminEmail ?? "unknown",
      attempted_claim_ids: claims.map((c) => c.id),
      parent_submission_id: input.parentSubmissionId ?? null,
    })
    .select("id")
    .single();
  if (subErr) throw subErr;

  if (submission.upload.ok) {
    const nowIso = new Date().toISOString();
    for (const claim of claims) {
      await supabase
        .schema("resupply")
        .from("insurance_claims")
        .update({
          status: "submitted",
          submitted_at: nowIso,
          claim_number: submission.interchangeControlNumber,
          office_ally_submission_id: subRow.id,
          updated_at: nowIso,
        })
        .eq("id", claim.id);
      await supabase
        .schema("resupply")
        .from("insurance_claim_events")
        .insert({
          claim_id: claim.id,
          event_type: "submitted",
          payer_ref: submission.interchangeControlNumber,
          note:
            input.parentSubmissionId != null
              ? `Resubmitted (parent ${input.parentSubmissionId}) in batch of ${claims.length} (${submission.transport}).`
              : `Submitted in batch of ${claims.length} (${submission.transport}).`,
          actor_email: input.adminEmail ?? "unknown",
        });
      void publishEvent({
        eventType: "claim.submitted",
        payload: {
          claim_id: claim.id,
          patient_id: claim.patient_id,
          payer_profile_id: payer.id,
          office_ally_submission_id: subRow.id,
          parent_submission_id: input.parentSubmissionId ?? null,
          batch_size: claims.length,
          transport: submission.transport,
        },
      });
    }
  }

  await logAudit({
    action:
      input.parentSubmissionId != null
        ? "insurance_claim.batch_resubmit_office_ally"
        : submission.upload.ok
          ? "insurance_claim.batch_submit_office_ally"
          : "insurance_claim.batch_submit_office_ally_failed",
    adminEmail: input.adminEmail ?? null,
    adminUserId: input.adminUserId ?? null,
    targetTable: "office_ally_submissions",
    targetId: subRow.id,
    metadata: {
      claim_count: claims.length,
      payer_profile_id: payer.id,
      transport: submission.transport,
      upload_ok: submission.upload.ok,
      parent_submission_id: input.parentSubmissionId ?? null,
    },
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  }).catch((err) => {
    logger.warn(
      { err },
      "insurance_claim.batch_submit audit write failed",
    );
  });

  return {
    ok: true,
    submissionId: subRow.id,
    claimCount: claims.length,
    isaControlNumber: submission.interchangeControlNumber,
    gsControlNumber: submission.groupControlNumber,
    fileSizeBytes: submission.fileSizeBytes,
    transport: submission.transport,
    uploadOk: submission.upload.ok,
    uploadError: submission.upload.ok ? null : submission.upload.message,
  };
}

// Regenerate the 837P EDI payload for an existing submission row.
//
// Used by the "View raw 837P" download in the OA Operations admin
// page. Returns null when the submission row is missing, has no
// attempted_claim_ids, or any linked claim no longer satisfies
// buildOneDetail (rare — happens if a CSR deleted a claim after
// submit). The caller surfaces null as 404.
//
// Uses the *original* ISA/GS control numbers from the submission row
// so the regenerated text matches what was actually uploaded — the
// download is for audit + support tickets, not a new transmission.
export async function buildEdiPayloadForSubmission(
  submissionId: string,
): Promise<{ payload: string; usageIndicator: "P" | "T" } | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: sub } = await supabase
    .schema("resupply")
    .from("office_ally_submissions")
    .select(
      "id, isa_control_number, gs_control_number, attempted_claim_ids",
    )
    .eq("id", submissionId)
    .limit(1)
    .maybeSingle();
  if (!sub) return null;
  const claimIds = sub.attempted_claim_ids ?? [];
  if (claimIds.length === 0) return null;

  const { data: claims } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("*")
    .in("id", claimIds);
  if (!claims || claims.length === 0) return null;

  const payerProfileIds = [...new Set(claims.map((c) => c.payer_profile_id))];
  if (payerProfileIds.length !== 1 || !payerProfileIds[0]) return null;
  const { data: payer } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select("payer_legal_name, office_ally_payer_id")
    .eq("id", payerProfileIds[0])
    .limit(1)
    .maybeSingle();
  if (!payer || !payer.office_ally_payer_id) return null;

  const details: ClaimDetail[] = [];
  for (const claim of claims) {
    const d = await buildOneDetail(
      supabase,
      claim,
      payer.payer_legal_name,
      payer.office_ally_payer_id,
    );
    if (!d) return null;
    details.push(d);
  }

  const identity = await resolveBillingIdentity({ supabase });
  const built = build837P({
    submitter: identity.submitter,
    receiver: { interchangeId: "OFFCLY", organizationName: "OFFICE ALLY" },
    billingProvider: identity.billingProvider,
    claims: details,
    control: {
      interchangeControlNumber: sub.isa_control_number,
      groupControlNumber: sub.gs_control_number,
      transactionSetControlNumber: "0001",
      builtAt: Date.now(),
    },
    usageIndicator: identity.usageIndicator,
  });
  return { payload: built.payload, usageIndicator: identity.usageIndicator };
}

export async function buildOneDetail(
  supabase: SupabaseClient,
  claim: ClaimRow,
  payerLegalName: string,
  payerId: string,
): Promise<ClaimDetail | null> {
  if (!claim.insurance_coverage_id) return null;
  const [
    { data: coverage },
    { data: patient },
    { data: lines },
    { data: sleep },
    { data: renderingProvider },
    { data: referringProvider },
    { data: secondaryCoverage },
  ] = await Promise.all([
    supabase
      .schema("resupply")
      .from("insurance_coverages")
      .select("member_id, policyholder_relationship")
      .eq("id", claim.insurance_coverage_id)
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("resupply")
      .from("patients")
      .select("legal_first_name, legal_last_name, date_of_birth, address")
      .eq("id", claim.patient_id)
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select("hcpcs_code, modifier, billed_cents, quantity")
      .eq("claim_id", claim.id)
      .order("created_at", { ascending: true }),
    supabase
      .schema("resupply")
      .from("sleep_studies")
      .select("diagnosis_icd10")
      .eq("patient_id", claim.patient_id)
      .not("diagnosis_icd10", "is", null)
      .order("study_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
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
          .select("member_id, payer_name, policyholder_relationship")
          .eq("id", claim.secondary_coverage_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (!coverage || !patient || !lines || lines.length === 0) return null;
  const addr = patient.address as
    | { line1?: string; city?: string; state?: string; zip?: string }
    | null;
  if (!addr?.line1 || !addr.city || !addr.state || !addr.zip) return null;
  const primaryDx = sleep?.diagnosis_icd10 ?? "G47.33";
  const subscriberAddress = {
    line1: addr.line1,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
  };
  return {
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
      relationshipCode: relationshipFor(coverage.policyholder_relationship),
    },
    payer: {
      organizationName: payerLegalName,
      payerId,
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
      ? {
          npi: renderingProvider.npi,
          firstName: splitFirstName(renderingProvider.legal_name),
          lastName: splitLastName(renderingProvider.legal_name),
        }
      : null,
    referringProvider: referringProvider
      ? {
          npi: referringProvider.npi,
          firstName: splitFirstName(referringProvider.legal_name),
          lastName: splitLastName(referringProvider.legal_name),
        }
      : null,
    // Loop 2320/2330 — secondary-payer coordination of benefits. We
    // attach the secondary when one is linked; prior-payer paid is
    // null because we don't compute pre-adjudication amounts at
    // submit time.
    otherSubscriber: secondaryCoverage
      ? {
          payerResponsibility: "S",
          priorPayerPaidCents: null,
          subscriber: {
            firstName: patient.legal_first_name,
            lastName: patient.legal_last_name,
            dateOfBirth: patient.date_of_birth,
            gender: "U",
            memberId: secondaryCoverage.member_id,
            address: subscriberAddress,
            relationshipCode: relationshipFor(
              secondaryCoverage.policyholder_relationship,
            ),
          },
          payer: {
            organizationName: secondaryCoverage.payer_name,
            payerId: secondaryCoverage.payer_name.slice(0, 20),
          },
        }
      : null,
  };
}

function relationshipFor(r: string | null | undefined): "18" | "01" | "19" | "G8" {
  return r === "self"
    ? "18"
    : r === "spouse"
      ? "01"
      : r === "child"
        ? "19"
        : "G8";
}

function splitFirstName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes(",")) {
    const [, rest = ""] = trimmed.split(",", 2);
    return rest.trim().split(/\s+/)[0] ?? "";
  }
  return trimmed.split(/\s+/)[0] ?? "";
}
function splitLastName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes(",")) return trimmed.split(",", 2)[0]!.trim();
  const parts = trimmed.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1]! : trimmed;
}
