// Claim-status checker — round-trip 276 → upload → (poller) 277 →
// persist (biller #B3). Mirrors the eligibility verifier (270/271):
// build the 276 via the pure builder, upload via the SAME Office Ally
// SFTP transport (or the file outbox in stub mode), and insert a
// claim_status_checks row in status='submitted'. The inbound poller
// (case "277" → dispatch277) fills in the parsed status when Office
// Ally drops the 277 response in the outbound dir.
//
// Like the 270 path, this rides the existing clearinghouse transport —
// no new vendor surface. When clearinghouse creds are unset it writes
// the 276 to the file outbox (stub mode), so dev/preview never block.

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  allocateControlNumbers,
  build276,
  createFileTransport,
  createSftpTransport,
  resolveOutboxDir,
  type SubmissionTransport,
} from "@workspace/resupply-integrations-office-ally";

import { logger } from "../logger";
import {
  resolveBillingIdentity,
  resolveClearinghouse,
} from "./identity-resolver";

export interface SubmitClaimStatusCheckInput {
  claimId: string;
  /** Patient id from the route — asserts the claim belongs to them. */
  patientId: string;
  requestedByEmail: string;
}

export class ClaimNotForPatientError extends Error {
  constructor() {
    super("insurance_claim does not belong to the given patient");
    this.name = "ClaimNotForPatientError";
  }
}

export interface SubmitClaimStatusCheckResult {
  claimStatusCheckId: string;
  isaControlNumber: string;
  traceReference: string;
  uploadOk: boolean;
  errorMessage: string | null;
}

/**
 * Build + transmit a 276 claim-status inquiry for one claim and record a
 * claim_status_checks row. Throws for the not-found / wrong-patient /
 * paper-only-payer validation failures so the route maps each to a
 * clear status.
 */
export async function submitClaimStatusCheck(
  input: SubmitClaimStatusCheckInput,
): Promise<SubmitClaimStatusCheckResult> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: claim, error: claimErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, patient_id, payer_name, payer_profile_id, claim_number, date_of_service, total_billed_cents, insurance_coverage_id",
    )
    .eq("id", input.claimId)
    .limit(1)
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claim) throw new Error("insurance_claim not found");
  if (claim.patient_id !== input.patientId) {
    throw new ClaimNotForPatientError();
  }

  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("legal_first_name, legal_last_name")
    .eq("id", claim.patient_id)
    .limit(1)
    .maybeSingle();
  if (!patient) throw new Error("patient not found");

  // Resolve the payer profile by FK when the claim carries one, else by
  // display-name match (same fallback as the eligibility verifier).
  const payerProfile = await resolvePayerProfile(
    supabase,
    claim.payer_profile_id,
    claim.payer_name,
  );
  if (!payerProfile?.office_ally_payer_id || payerProfile.paper_only) {
    throw new Error("payer does not accept electronic 276/277");
  }

  const memberId = claim.insurance_coverage_id
    ? ((
        await supabase
          .schema("resupply")
          .from("insurance_coverages")
          .select("member_id")
          .eq("id", claim.insurance_coverage_id)
          .limit(1)
          .maybeSingle()
      ).data?.member_id ?? "")
    : "";

  const identity = await resolveBillingIdentity({ supabase });
  const clearinghouse = await resolveClearinghouse({ supabase });

  // Eligibility + claim ISA13s share the office_ally_submissions pool.
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

  const built = build276({
    submitter: {
      etin: identity.submitter.etin,
      organizationName: identity.submitter.organizationName,
      npi: identity.billingProvider.npi,
    },
    receiver: { interchangeId: "OFFCLY", organizationName: "OFFICE ALLY" },
    payer: {
      organizationName: payerProfile.payer_legal_name,
      payerId: payerProfile.office_ally_payer_id,
    },
    subscriber: {
      firstName: patient.legal_first_name,
      lastName: patient.legal_last_name,
      memberId,
    },
    claim: {
      claimControlNumber: claim.claim_number ?? claim.id,
      totalBilledCents: claim.total_billed_cents ?? 0,
      serviceDateFrom: claim.date_of_service,
    },
    control,
    usageIndicator: identity.usageIndicator,
  });

  const fileName = `PF-CSI-${built.interchangeControlNumber}.txt`;
  const transport: SubmissionTransport = clearinghouse.config
    ? createSftpTransport(clearinghouse.config)
    : createFileTransport({ outboxDir: resolveOutboxDir() });
  const upload = await transport.upload({ fileName, payload: built.payload });

  const row: Database["resupply"]["Tables"]["claim_status_checks"]["Insert"] = {
    claim_id: claim.id,
    payer_profile_id: payerProfile.id,
    isa_control_number: built.interchangeControlNumber,
    gs_control_number: built.groupControlNumber,
    trace_reference: built.traceReference,
    outbound_file_name: fileName,
    status: upload.ok ? "submitted" : "transport_failed",
    error_message: upload.ok ? null : upload.message.slice(0, 2000),
    requested_by_email: input.requestedByEmail,
  };
  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("claim_status_checks")
    .insert(row)
    .select("id")
    .single();
  if (insertErr) throw insertErr;
  if (!upload.ok) {
    logger.warn(
      { kind: upload.kind, message: upload.message },
      "submitClaimStatusCheck: upload failed",
    );
  }
  return {
    claimStatusCheckId: inserted.id,
    isaControlNumber: built.interchangeControlNumber,
    traceReference: built.traceReference,
    uploadOk: upload.ok,
    errorMessage: upload.ok ? null : upload.message,
  };
}

async function resolvePayerProfile(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  payerProfileId: string | null,
  payerName: string | null,
): Promise<{
  id: string;
  payer_legal_name: string;
  office_ally_payer_id: string | null;
  paper_only: boolean | null;
} | null> {
  if (payerProfileId) {
    const { data } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select("id, payer_legal_name, office_ally_payer_id, paper_only")
      .eq("id", payerProfileId)
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  const { data } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select("id, payer_legal_name, office_ally_payer_id, paper_only")
    .ilike(
      "display_name",
      (payerName ?? "").replace(/[\\%_]/g, (c: string) => `\\${c}`),
    )
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  return data ?? null;
}
