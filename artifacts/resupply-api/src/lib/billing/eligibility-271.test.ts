// Tests for the shared 271 → eligibility_checks mapping used by both the
// inbound poller (async SFTP path) and the real-time verifier.

import { describe, expect, it } from "vitest";

import type { Parsed271 } from "@workspace/resupply-integrations-office-ally";

import {
  eligibilityCompletedEvent,
  parsed271ToCheckColumns,
} from "./eligibility-271";

const PARSED: Parsed271 = {
  traceReference: "ETIN-000000001-0001-abcd",
  isActive: true,
  inNetwork: true,
  deductibleCents: 50000,
  deductibleMetCents: 12000,
  deductibleRemainingCents: 38000,
  oopMaxCents: 300000,
  oopMetCents: 100000,
  oopRemainingCents: 200000,
  copayCents: 2500,
  coinsurancePct: 20,
  requiresPriorAuth: true,
  messages: ["PRIOR AUTH REQUIRED"],
};

describe("parsed271ToCheckColumns", () => {
  it("maps benefit fields to the eligibility_checks columns", () => {
    const cols = parsed271ToCheckColumns(PARSED);
    expect(cols).toMatchObject({
      is_active: true,
      in_network: true,
      deductible_cents: 50000,
      deductible_met_cents: 12000,
      oop_max_cents: 300000,
      oop_met_cents: 100000,
      copay_cents: 2500,
      coinsurance_pct: 20,
      requires_prior_auth: true,
    });
  });

  it("stores the full parsed object in parsed_response_json", () => {
    const cols = parsed271ToCheckColumns(PARSED);
    expect(cols.parsed_response_json).toEqual(PARSED);
  });

  it("passes through nulls for unknown benefits", () => {
    const cols = parsed271ToCheckColumns({
      ...PARSED,
      isActive: false,
      inNetwork: null,
      deductibleCents: null,
      copayCents: null,
    });
    expect(cols.is_active).toBe(false);
    expect(cols.in_network).toBeNull();
    expect(cols.deductible_cents).toBeNull();
    expect(cols.copay_cents).toBeNull();
  });
});

describe("eligibilityCompletedEvent", () => {
  const ref = {
    eligibilityCheckId: "chk-1",
    patientId: "pat-1",
    insuranceCoverageId: "cov-1",
  };

  it("builds the eligibility.completed event with ids + flags", () => {
    const evt = eligibilityCompletedEvent(ref, PARSED);
    expect(evt.eventType).toBe("eligibility.completed");
    expect(evt.payload).toEqual({
      eligibility_check_id: "chk-1",
      patient_id: "pat-1",
      insurance_coverage_id: "cov-1",
      is_active: true,
      requires_prior_auth: true,
    });
  });

  it("does not leak PHI (no member id, amounts, or messages) in the payload", () => {
    const evt = eligibilityCompletedEvent(ref, PARSED);
    const keys = Object.keys(evt.payload);
    expect(keys).not.toContain("deductible_cents");
    expect(keys).not.toContain("copay_cents");
    expect(keys).not.toContain("messages");
  });
});
