import { describe, it, expect } from "vitest";

import {
  deriveSecondaryCob,
  filterSecondaryEligible,
  type EligibleCandidate,
  type PrimaryClaimTotals,
} from "./secondary-cob";

const paidPrimary = (
  over: Partial<PrimaryClaimTotals> = {},
): PrimaryClaimTotals => ({
  status: "paid",
  payer_sequence: "primary",
  total_billed_cents: 20000,
  total_allowed_cents: 15000,
  total_paid_cents: 12000,
  patient_responsibility_cents: 3000,
  secondary_coverage_id: "cov-secondary",
  ...over,
});

describe("deriveSecondaryCob", () => {
  it("derives COB amounts for a paid primary with a patient balance", () => {
    const d = deriveSecondaryCob(paidPrimary());
    expect(d.eligible).toBe(true);
    if (d.eligible) {
      expect(d.cob).toEqual({
        primaryPaidCents: 12000,
        contractualCents: 5000, // billed 20000 - allowed 15000
        patientRespCents: 3000,
        billableToSecondaryCents: 3000,
      });
    }
  });

  it("rejects a non-primary sequence", () => {
    const d = deriveSecondaryCob(paidPrimary({ payer_sequence: "secondary" }));
    expect(d).toEqual({ eligible: false, reason: "not_primary" });
  });

  it("treats a null payer_sequence as primary", () => {
    expect(
      deriveSecondaryCob(paidPrimary({ payer_sequence: null })).eligible,
    ).toBe(true);
  });

  it("rejects when there is no secondary coverage", () => {
    const d = deriveSecondaryCob(paidPrimary({ secondary_coverage_id: null }));
    expect(d).toEqual({ eligible: false, reason: "no_secondary_coverage" });
  });

  it("rejects when the primary is not paid", () => {
    const d = deriveSecondaryCob(paidPrimary({ status: "submitted" }));
    expect(d).toEqual({ eligible: false, reason: "primary_not_paid" });
  });

  it("accepts a partially_paid primary with a patient balance", () => {
    const d = deriveSecondaryCob(paidPrimary({ status: "partially_paid" }));
    expect(d.eligible).toBe(true);
    if (d.eligible) {
      expect(d.cob.billableToSecondaryCents).toBe(3000);
    }
  });

  it("rejects when there is no patient-responsibility balance", () => {
    const d = deriveSecondaryCob(
      paidPrimary({ patient_responsibility_cents: 0 }),
    );
    expect(d).toEqual({ eligible: false, reason: "no_balance" });
  });

  it("clamps a negative contractual (allowed > billed) to zero", () => {
    const d = deriveSecondaryCob(
      paidPrimary({ total_billed_cents: 10000, total_allowed_cents: 15000 }),
    );
    expect(d.eligible).toBe(true);
    if (d.eligible) expect(d.cob.contractualCents).toBe(0);
  });

  it("clamps a negative patient responsibility to no_balance", () => {
    const d = deriveSecondaryCob(
      paidPrimary({ patient_responsibility_cents: -500 }),
    );
    expect(d).toEqual({ eligible: false, reason: "no_balance" });
  });
});

describe("filterSecondaryEligible", () => {
  const candidate = (over: Partial<EligibleCandidate>): EligibleCandidate => ({
    id: "claim-1",
    patient_id: "pat-1",
    payer_name: "Acme Health",
    total_billed_cents: 20000,
    total_paid_cents: 12000,
    patient_responsibility_cents: 3000,
    status: "paid",
    payer_sequence: "primary",
    secondary_coverage_id: "cov-2",
    total_allowed_cents: 15000,
    ...over,
  });

  it("keeps only eligible primaries, sorted biggest balance first", () => {
    const out = filterSecondaryEligible(
      [
        candidate({ id: "small", patient_responsibility_cents: 1000 }),
        candidate({ id: "big", patient_responsibility_cents: 9000 }),
        candidate({ id: "ineligible", status: "submitted" }),
      ],
      new Set(),
    );
    expect(out.map((o) => o.claimId)).toEqual(["big", "small"]);
    expect(out[0]!.patientResponsibilityCents).toBe(9000);
  });

  it("skips primaries that already spawned a secondary", () => {
    const out = filterSecondaryEligible(
      [candidate({ id: "has-secondary" }), candidate({ id: "fresh" })],
      new Set(["has-secondary"]),
    );
    expect(out.map((o) => o.claimId)).toEqual(["fresh"]);
  });

  it("projects only money + ids (no patient detail leak)", () => {
    const out = filterSecondaryEligible([candidate({})], new Set());
    expect(out[0]).toEqual({
      claimId: "claim-1",
      patientId: "pat-1",
      primaryPayerName: "Acme Health",
      billedCents: 20000,
      primaryPaidCents: 12000,
      patientResponsibilityCents: 3000,
    });
  });
});
