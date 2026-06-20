// Insurance discovery — search Office Ally's payer network from patient
// demographics to find ACTIVE coverage, with NO patient record required.
//
// The "I don't know what insurance this person has — or the coverage on
// file came back inactive — find me what's actually in force" tool. The
// operator types the person's name / DOB (and optionally SSN, a stale
// member id, or zip) and we ask Office Ally's insurance-discovery service
// to search across payers. It returns a list of discovered coverages; the
// operator can then add a found coverage to the patient's chart and verify
// it the usual way (eligibility-verifier.ts).
//
// Real-time ONLY, persists NOTHING. Like the patient-less quick check, the
// demographics go into the request and NOWHERE else — never logged, never
// persisted, never echoed into audit metadata. Log lines + audit rows carry
// timing + outcome counts only.
//
// Gating: this is a paid add-on. The ROUTE enforces the `insurance.discovery`
// feature flag (a tenant without the add-on can't reach the billable search);
// this lib focuses on the transport and metering so it stays reusable.

import { resolveSeedOrgId } from "@workspace/resupply-db";
import {
  createInsuranceDiscoveryTransport,
  type DiscoveredCoverage,
} from "@workspace/resupply-integrations-office-ally";

import { logger } from "../logger";
import { recordTenantUsage } from "../metering/usage";
import { resolveClearinghouse } from "./identity-resolver";

export interface InsuranceDiscoveryInput {
  subscriber: {
    firstName: string;
    lastName: string;
    /** YYYY-MM-DD */
    dateOfBirth: string;
    /** X12 administrative sex; defaults to U (unknown). */
    gender?: "M" | "F" | "U";
    /** Optional SSN (digits) — lifts the match rate; PHI in flight only. */
    ssn?: string | null;
    /** Optional stale member id hint. */
    memberId?: string | null;
    /** Optional postal code, narrows the search. */
    postalCode?: string | null;
  };
  /** As-of date for the coverage search (YYYY-MM-DD); defaults to today. */
  serviceDate?: string | null;
  /** Tenant context. Defaults to the seed org (single-tenant bridge). */
  orgId?: string;
}

export type { DiscoveredCoverage };

export type InsuranceDiscoveryCheckResult =
  | {
      /** The search ran and matched at least one coverage. */
      status: "found";
      coverages: DiscoveredCoverage[];
      activeCount: number;
      latencyMs: number;
    }
  | {
      /** The search ran cleanly but matched no coverage. */
      status: "none";
      latencyMs: number;
    }
  /** Discovery isn't configured for this tenant — the caller should
   *  configure the Office Ally discovery endpoint. */
  | { status: "unavailable"; message: string }
  /** The endpoint was reachable in principle but the search failed
   *  (connect/auth/reject). Message is PHI-free. */
  | { status: "failed"; message: string };

/**
 * Run a real-time insurance-discovery search from typed-in demographics,
 * without creating any patient / coverage rows.
 */
export async function runInsuranceDiscovery(
  input: InsuranceDiscoveryInput,
): Promise<InsuranceDiscoveryCheckResult> {
  const orgId = input.orgId ?? (await resolveSeedOrgId());
  if (!orgId) {
    throw new Error("tenant context missing");
  }

  const clearinghouse = await resolveClearinghouse({ orgId });
  const discoveryConfig = clearinghouse.discoveryConfig;
  if (!discoveryConfig) {
    return {
      status: "unavailable",
      message:
        "Insurance discovery isn't configured. Add the Office Ally discovery " +
        "endpoint under Billing → Clearinghouse to enable it.",
    };
  }

  const transport = createInsuranceDiscoveryTransport(discoveryConfig);
  const startedAt = Date.now();
  const outcome = await transport.discover({
    firstName: input.subscriber.firstName,
    lastName: input.subscriber.lastName,
    dateOfBirth: input.subscriber.dateOfBirth,
    gender: input.subscriber.gender ?? "U",
    ssn: input.subscriber.ssn ?? undefined,
    memberId: input.subscriber.memberId ?? undefined,
    postalCode: input.subscriber.postalCode ?? undefined,
    serviceDate: input.serviceDate ?? undefined,
  });
  const latencyMs = Date.now() - startedAt;

  if (!outcome.ok) {
    // Operational only — no PHI (timing + transport outcome). NOT metered:
    // a connect/auth/transport failure never reached Office Ally's billing
    // layer, so charging the tenant a billable transaction for it (and
    // counting it against their plan allowance) would over-bill on retries.
    logger.warn(
      { event: "insurance.discovery.failed", kind: outcome.kind, latencyMs },
      "runInsuranceDiscovery: search failed",
    );
    return { status: "failed", message: outcome.message };
  }

  // The search actually executed against the payer network (a billable
  // round-trip, whether or not it matched coverage) — meter one billing
  // transaction. Fire-and-forget.
  void recordTenantUsage({
    orgId,
    metricKey: "billingTransactionsPerMonth",
    source: "insurance.discovery",
  });

  if (outcome.coverages.length === 0) {
    logger.info(
      { event: "insurance.discovery.none", latencyMs },
      "runInsuranceDiscovery: no coverage matched",
    );
    return { status: "none", latencyMs };
  }

  const activeCount = outcome.coverages.filter((c) => c.isActive).length;
  logger.info(
    {
      event: "insurance.discovery.found",
      latencyMs,
      matched: outcome.coverages.length,
      active: activeCount,
    },
    "runInsuranceDiscovery: coverage matched",
  );
  return {
    status: "found",
    coverages: outcome.coverages,
    activeCount,
    latencyMs,
  };
}
