// Quick eligibility check — a 270/271 round-trip with NO patient record.
//
// The front-desk "is this person covered?" tool: the operator types the
// subscriber's name / DOB / member id and picks a payer, and we fire the
// same X12 270 the patient-attached verifier builds — but nothing is
// persisted. No patients row, no insurance_coverages row, no
// eligibility_checks row: the parsed 271 goes back to the caller and is
// gone when they close the page. To keep a record, add the patient and
// verify from the chart (eligibility-verifier.ts).
//
// Real-time ONLY. The SFTP submit-and-poll path needs a persisted
// eligibility_checks row for the inbound poll to reconcile the 271
// against — with nothing persisted there is nowhere for a deferred
// answer to land. When real-time isn't configured the check reports
// `unavailable` instead of falling back.
//
// PHI posture: the subscriber fields are PHI in flight. They go into the
// 270 payload and NOWHERE else — never logged, never persisted, never
// echoed into audit metadata. Log lines carry timing + outcome only.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  allocateControlNumbers,
  build270,
  createRealtimeEligibilityTransport,
  parse271,
} from "@workspace/resupply-integrations-office-ally";

import { logger } from "../logger";
import {
  resolveBillingIdentity,
  resolveClearinghouse,
} from "./identity-resolver";

export interface QuickEligibilityCheckInput {
  /** payer_profiles.id — the payer to query. Must accept electronic
   *  270/271 (office_ally_payer_id set, not paper_only). */
  payerProfileId: string;
  subscriber: {
    firstName: string;
    lastName: string;
    memberId: string;
    /** YYYY-MM-DD */
    dateOfBirth: string;
    /** X12 DMG03 administrative sex; defaults to U (unknown). */
    gender?: "M" | "F" | "U";
  };
  /** Optional HCPCS scope; defaults to general health (STC 30). */
  hcpcsCode?: string | null;
}

/** Parsed-271 benefit fields surfaced to the caller. Mirrors
 *  Parsed271 minus the trace (surfaced separately). */
export interface QuickEligibilityBenefits {
  isActive: boolean;
  inNetwork: boolean | null;
  deductibleCents: number | null;
  deductibleMetCents: number | null;
  deductibleRemainingCents: number | null;
  oopMaxCents: number | null;
  oopMetCents: number | null;
  oopRemainingCents: number | null;
  copayCents: number | null;
  coinsurancePct: number | null;
  requiresPriorAuth: boolean;
  messages: string[];
}

export type QuickEligibilityCheckResult =
  | {
      status: "parsed";
      payerName: string;
      traceReference: string;
      latencyMs: number;
      benefits: QuickEligibilityBenefits;
    }
  /** Real-time eligibility isn't configured — quick checks have no
   *  deferred path, so the caller should use the patient-attached
   *  verifier (or configure real-time). */
  | { status: "unavailable"; message: string }
  /** The real-time endpoint was reachable in principle but the
   *  round-trip failed (connect/auth/reject). Message is PHI-free. */
  | { status: "failed"; message: string };

export class PayerProfileNotFoundError extends Error {
  constructor() {
    super("payer profile not found");
    this.name = "PayerProfileNotFoundError";
  }
}

/**
 * Run an ad-hoc real-time eligibility check (X12 270/271) from typed-in
 * subscriber details, without creating any patient / coverage /
 * eligibility_checks rows.
 *
 * @throws PayerProfileNotFoundError when the payer profile id is unknown
 *   or inactive
 * @throws Error("payer does not accept electronic 270/271") when the
 *   payer is paper-only or lacks an Office Ally payer id
 */
export async function quickCheckEligibility(
  input: QuickEligibilityCheckInput,
): Promise<QuickEligibilityCheckResult> {
  const supabase = getSupabaseServiceRoleClient();

  const { data: payerProfile, error: payerErr } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select(
      "id, display_name, payer_legal_name, office_ally_payer_id, paper_only",
    )
    .eq("id", input.payerProfileId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (payerErr) throw payerErr;
  if (!payerProfile) {
    throw new PayerProfileNotFoundError();
  }
  if (!payerProfile.office_ally_payer_id || payerProfile.paper_only) {
    throw new Error("payer does not accept electronic 270/271");
  }

  const identity = await resolveBillingIdentity({ supabase });
  const clearinghouse = await resolveClearinghouse({ supabase });

  const realtimeConfig = clearinghouse.realtimeConfig;
  if (!realtimeConfig) {
    return {
      status: "unavailable",
      message:
        "Real-time eligibility is not configured — quick checks need the " +
        "real-time connection (there is no patient record for a deferred " +
        "271 to attach to). Verify from the patient chart instead.",
    };
  }

  // Same monotonic ISA13 pool as the patient-attached verifier; the
  // trace nonce inside build270 disambiguates bursts.
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
    receiver: { interchangeId: "OFFALLY", organizationName: "OFFICE ALLY" },
    payer: {
      organizationName: payerProfile.payer_legal_name,
      payerId: payerProfile.office_ally_payer_id,
    },
    subscriber: {
      firstName: input.subscriber.firstName,
      lastName: input.subscriber.lastName,
      memberId: input.subscriber.memberId,
      dateOfBirth: input.subscriber.dateOfBirth,
      gender: input.subscriber.gender ?? "U",
    },
    serviceTypeCode: input.hcpcsCode ? "12" : "30",
    hcpcsCode: input.hcpcsCode ?? undefined,
    control,
    usageIndicator: identity.usageIndicator,
  });

  const realtime = createRealtimeEligibilityTransport(realtimeConfig);
  const startedAt = Date.now();
  const res = await realtime.requestEligibility({ payload: built.payload });
  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    // Operational only — no PHI (timing + transport outcome).
    logger.warn(
      { event: "eligibility.quick_check.failed", kind: res.kind, latencyMs },
      "quickCheckEligibility: real-time round-trip failed",
    );
    return { status: "failed", message: res.message };
  }

  const parsed = parse271(res.payload271);
  logger.info(
    { event: "eligibility.quick_check.resolved", latencyMs },
    "quickCheckEligibility: real-time 271 resolved",
  );
  return {
    status: "parsed",
    payerName: payerProfile.display_name,
    traceReference: built.traceReference,
    latencyMs,
    benefits: {
      isActive: parsed.isActive,
      inNetwork: parsed.inNetwork,
      deductibleCents: parsed.deductibleCents,
      deductibleMetCents: parsed.deductibleMetCents,
      deductibleRemainingCents: parsed.deductibleRemainingCents,
      oopMaxCents: parsed.oopMaxCents,
      oopMetCents: parsed.oopMetCents,
      oopRemainingCents: parsed.oopRemainingCents,
      copayCents: parsed.copayCents,
      coinsurancePct: parsed.coinsurancePct,
      requiresPriorAuth: parsed.requiresPriorAuth,
      messages: parsed.messages,
    },
  };
}
