// Shared 271 → eligibility_checks mapping.
//
// Two code paths land a parsed 271 on an eligibility_checks row:
//   1. the async SFTP path — the inbound poll's dispatch271() matches a
//      271 file back to a previously-submitted check, and
//   2. the synchronous real-time path — verifyEligibility() gets the 271
//      inline and writes the row immediately.
//
// Both must produce IDENTICAL benefit columns and fire the IDENTICAL
// `eligibility.completed` webhook, so the mapping lives here once.

import { type Json } from "@workspace/resupply-db";
import type { Parsed271 } from "@workspace/resupply-integrations-office-ally";

/** The benefit columns derived from a parsed 271. Shared by the poller
 *  (UPDATE) and the verifier (INSERT) so neither drifts. */
export interface Parsed271Columns {
  is_active: boolean;
  in_network: boolean | null;
  deductible_cents: number | null;
  deductible_met_cents: number | null;
  oop_max_cents: number | null;
  oop_met_cents: number | null;
  copay_cents: number | null;
  coinsurance_pct: number | null;
  requires_prior_auth: boolean;
  parsed_response_json: Json;
}

export function parsed271ToCheckColumns(parsed: Parsed271): Parsed271Columns {
  return {
    is_active: parsed.isActive,
    in_network: parsed.inNetwork,
    deductible_cents: parsed.deductibleCents,
    deductible_met_cents: parsed.deductibleMetCents,
    oop_max_cents: parsed.oopMaxCents,
    oop_met_cents: parsed.oopMetCents,
    copay_cents: parsed.copayCents,
    coinsurance_pct: parsed.coinsurancePct,
    requires_prior_auth: parsed.requiresPriorAuth,
    parsed_response_json: parsed as unknown as Json,
  };
}

export interface EligibilityCompletedRef {
  eligibilityCheckId: string;
  patientId: string;
  insuranceCoverageId: string;
}

/** Build the `eligibility.completed` webhook input. IDs + flags only —
 *  no PHI (member id, deductible amounts) in the payload; subscribers
 *  fetch enrichment via the API. */
export function eligibilityCompletedEvent(
  ref: EligibilityCompletedRef,
  parsed: Parsed271,
): { eventType: string; payload: Record<string, unknown> } {
  return {
    eventType: "eligibility.completed",
    payload: {
      eligibility_check_id: ref.eligibilityCheckId,
      patient_id: ref.patientId,
      insurance_coverage_id: ref.insuranceCoverageId,
      is_active: parsed.isActive,
      requires_prior_auth: parsed.requiresPriorAuth,
    },
  };
}
