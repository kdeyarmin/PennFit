// Eligibility verifier — build a 270 and resolve the 271 via one of two
// transports:
//
//   * Real-time (preferred when OFFICE_ALLY_REALTIME_* is configured):
//     POST the 270 to Office Ally's HTTPS service and parse the 271
//     INLINE — the row is written status='parsed' with benefits in one
//     request (seconds). See lib/.../transport/realtime.ts.
//   * SFTP submit-and-poll (fallback / default): upload the 270 over
//     SFTP and write the row status='submitted'. The 271 arrives later
//     in the outbound dir and the inbound poll's dispatch271()
//     (worker/jobs/office-ally-inbound-poll.ts) fills in is_active /
//     deductible / etc and flips the row to 'parsed' (minutes).
//
// The 271 → row mapping and the eligibility.completed webhook are shared
// with the poller via ./eligibility-271 so both paths write identical
// rows. A real-time failure falls through to the SFTP path, so a flaky
// endpoint never blocks the check.
//
// Flow:
//   1. Look up the insurance_coverage_id + payer_profile_id + patient.
//   2. Allocate control numbers (monotonic ISA13).
//   3. Build the 270 via build270().
//   4. Real-time: request 271 inline → insert status='parsed'. On failure
//      OR when real-time is unconfigured, fall to (5).
//   5. SFTP/file: upload the 270 and insert status='submitted'.

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  allocateControlNumbers,
  build270,
  createFileTransport,
  createRealtimeEligibilityTransport,
  createSftpTransport,
  parse271,
  readOfficeAllyRealtimeConfigOrNull,
  resolveOutboxDir,
  type SubmissionTransport,
} from "@workspace/resupply-integrations-office-ally";

import { logger } from "../logger";
import { publishEvent } from "../webhooks/publisher";
import {
  eligibilityCompletedEvent,
  parsed271ToCheckColumns,
} from "./eligibility-271";
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
  /** True when the 271 was obtained inline via the real-time service
   *  (row is already status='parsed'); false for the SFTP submit path. */
  realtime: boolean;
  /** Terminal status written to the row. */
  status: "parsed" | "submitted" | "transport_failed";
}

/**
 * Performs a round-trip electronic eligibility (HIPAA 270) submission for a patient's insurance coverage.
 *
 * Validates the coverage belongs to the patient and that the payer accepts electronic 270/271, builds the 270 transaction,
 * uploads it to the configured clearinghouse (or outbox), and records an `eligibility_checks` row summarizing the submission.
 *
 * @param input - Parameters required to run the eligibility check (see `VerifyEligibilityInput`)
 * @returns An object describing the recorded eligibility check and upload outcome
 * @returns eligibilityCheckId - The `id` of the inserted `eligibility_checks` row
 * @returns isaControlNumber - The allocated ISA interchange control number used for this submission
 * @returns traceReference - The trace reference extracted from the built 270 payload
 * @returns uploadOk - `true` if the transport upload succeeded, `false` otherwise
 * @returns errorMessage - `null` when `uploadOk` is `true`; otherwise the transport error message
 *
 * @throws CoverageNotForPatientError when the specified coverage does not belong to the given patient
 * @throws Error with message `"insurance_coverage not found"`, `"patient not found"`, or `"payer does not accept electronic 270/271"` for the corresponding validation failures
 * @throws Error for other database or transport failures surfaced from the underlying services
 */
export async function verifyEligibility(
  input: VerifyEligibilityInput,
): Promise<VerifyEligibilityResult> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: coverage, error: covErr } = await supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select(
      "id, patient_id, payer_name, member_id, policyholder_name, policyholder_relationship",
    )
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

  // Real-time path: when Office Ally real-time eligibility is configured,
  // POST the 270 and parse the 271 inline so the check resolves in one
  // request. Any real-time failure falls through to the SFTP submit path
  // below, so a flaky endpoint never blocks the check.
  const realtimeConfig = readOfficeAllyRealtimeConfigOrNull();
  if (realtimeConfig) {
    const realtime = createRealtimeEligibilityTransport(realtimeConfig);
    const res = await realtime.requestEligibility({ payload: built.payload });
    if (res.ok) {
      const parsed = parse271(res.payload271);
      const realtimeRow: Database["resupply"]["Tables"]["eligibility_checks"]["Insert"] =
        {
          insurance_coverage_id: coverage.id,
          patient_id: coverage.patient_id,
          payer_profile_id: payerProfile.id,
          service_hcpcs: input.hcpcsCode ?? null,
          isa_control_number: built.interchangeControlNumber,
          gs_control_number: built.groupControlNumber,
          outbound_file_name: fileName,
          status: "parsed",
          requested_by_email: input.requestedByEmail,
          responded_at: new Date().toISOString(),
          ...parsed271ToCheckColumns(parsed),
        };
      const { data: rtInserted, error: rtErr } = await supabase
        .schema("resupply")
        .from("eligibility_checks")
        .insert(realtimeRow)
        .select("id")
        .single();
      if (rtErr) throw rtErr;
      void publishEvent(
        eligibilityCompletedEvent(
          {
            eligibilityCheckId: rtInserted.id,
            patientId: coverage.patient_id,
            insuranceCoverageId: coverage.id,
          },
          parsed,
        ),
      );
      return {
        eligibilityCheckId: rtInserted.id,
        isaControlNumber: built.interchangeControlNumber,
        traceReference: built.traceReference,
        uploadOk: true,
        errorMessage: null,
        realtime: true,
        status: "parsed",
      };
    }
    logger.warn(
      { kind: res.kind, message: res.message },
      "verifyEligibility: real-time path failed; falling back to SFTP submit",
    );
  }

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
    realtime: false,
    status: upload.ok ? "submitted" : "transport_failed",
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
