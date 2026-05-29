// Eligibility verifier — round-trip 270 → upload → poll 271 →
// persist parsed result.
//
// The 271 doesn't arrive inline; Office Ally drops it in the
// outbound SFTP dir alongside 999/277CA/835. The inbound poller
// (worker/jobs/office-ally-inbound-poll.ts) needs a small extension
// to dispatch 271s — for now this module returns the queued state
// and the operator polls the eligibility_checks row to see when the
// 271 lands. The poller extension lands in a follow-up alongside
// the classifyEdiPayload("271") update.
//
// Flow:
//   1. Look up the insurance_coverage_id + payer_profile_id + patient.
//   2. Allocate control numbers (monotonic ISA13).
//   3. Build the 270 via build270().
//   4. Upload via the existing OA SFTP transport.
//   5. Insert an eligibility_checks row in status='submitted'.
//
// The poller fills in is_active / deductible / etc when the 271 arrives.

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  allocateControlNumbers,
  build270,
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

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface VerifyEligibilityInput {
  insuranceCoverageId: string;
  /**
   * Patient id from the route URL. The verifier asserts the coverage
   * belongs to this patient before touching the clearinghouse — this
   * is the authorization gate AND the audit-integrity guard (so a
   * mistyped or attacker-supplied URL can't bill 270 against the
   * wrong patient and write a misleading audit row).
   */
  patientId: string;
  /** Optional HCPCS scope; defaults to general health (STC 30). */
  hcpcsCode?: string | null;
  requestedByEmail: string;
}

export class CoverageNotForPatientError extends Error {
  constructor() {
    super("insurance_coverage does not belong to the given patient");
    this.name = "CoverageNotForPatientError";
  }
}

export interface VerifyEligibilityResult {
  eligibilityCheckId: string;
  isaControlNumber: string;
  traceReference: string;
  uploadOk: boolean;
  errorMessage: string | null;
}

export async function verifyEligibility(
  input: VerifyEligibilityInput,
): Promise<VerifyEligibilityResult> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: coverage, error: covErr } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select("id, patient_id, payer_name, member_id, policyholder_name, policyholder_relationship")
    .eq("id", input.insuranceCoverageId)
    .limit(1)
    .maybeSingle();
  if (covErr) throw covErr;
  if (!coverage) {
    throw new Error("insurance_coverage not found");
  }
  if (coverage.patient_id !== input.patientId) {
    throw new CoverageNotForPatientError();
  }
  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("legal_first_name, legal_last_name, date_of_birth")
    .eq("id", coverage.patient_id)
    .limit(1)
    .maybeSingle();
  if (!patient) {
    throw new Error("patient not found");
  }
  const { data: payerProfile } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select("id, payer_legal_name, office_ally_payer_id, paper_only")
    .ilike(
      "display_name",
      (coverage.payer_name ?? "").replace(/[\\%_]/g, (c: string) => `\\${c}`),
    )
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (!payerProfile?.office_ally_payer_id || payerProfile.paper_only) {
    throw new Error("payer does not accept electronic 270/271");
  }

  const identity = await resolveBillingIdentity({ supabase });
  const clearinghouse = await resolveClearinghouse({ supabase });

  // Allocate monotonic control numbers vs. the office_ally_submissions
  // ISA13 history. Eligibility and claim ISA13s share the same pool.
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

  const built = build270({
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
      memberId: coverage.member_id,
      dateOfBirth: patient.date_of_birth,
      gender: "U",
    },
    serviceTypeCode: input.hcpcsCode ? "12" : "30",
    hcpcsCode: input.hcpcsCode ?? undefined,
    control,
    usageIndicator: identity.usageIndicator,
  });

  const fileName = `PF-ELI-${built.interchangeControlNumber}.txt`;
  const transport: SubmissionTransport = clearinghouse.config
    ? createSftpTransport(clearinghouse.config)
    : createFileTransport({ outboxDir: resolveOutboxDir() });
  const upload = await transport.upload({ fileName, payload: built.payload });

  const row: Database["resupply"]["Tables"]["eligibility_checks"]["Insert"] = {
    insurance_coverage_id: coverage.id,
    patient_id: coverage.patient_id,
    payer_profile_id: payerProfile.id,
    service_hcpcs: input.hcpcsCode ?? null,
    isa_control_number: built.interchangeControlNumber,
    gs_control_number: built.groupControlNumber,
    outbound_file_name: fileName,
    status: upload.ok ? "submitted" : "transport_failed",
    error_message: upload.ok ? null : upload.message.slice(0, 2000),
    requested_by_email: input.requestedByEmail,
  };
  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("eligibility_checks")
    .insert(row)
    .select("id")
    .single();
  if (insertErr) throw insertErr;
  if (!upload.ok) {
    logger.warn(
      { kind: upload.kind, message: upload.message },
      "verifyEligibility: upload failed",
    );
  }
  return {
    eligibilityCheckId: inserted.id,
    isaControlNumber: built.interchangeControlNumber,
    traceReference: built.traceReference,
    uploadOk: upload.ok,
    errorMessage: upload.ok ? null : upload.message,
  };
}

/**
 * Look up the most recent successful eligibility check for a coverage
 * row, within a freshness window (default 24h). Returns null when no
 * suitable row exists — callers can then fire a fresh 270.
 */
export async function getCachedEligibility(
  insuranceCoverageId: string,
  freshnessMs = 24 * 3600 * 1000,
): Promise<Database["resupply"]["Tables"]["eligibility_checks"]["Row"] | null> {
  const supabase = getSupabaseServiceRoleClient();
  const cutoff = new Date(Date.now() - freshnessMs).toISOString();
  const { data } = await supabase
    .schema("resupply")
    .from("eligibility_checks")
    .select("*")
    .eq("insurance_coverage_id", insuranceCoverageId)
    .eq("status", "parsed")
    .gte("responded_at", cutoff)
    .order("responded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

// Suppress no-unused-vars for the SupabaseClient alias.
export type _SupabaseClient = SupabaseClient;
