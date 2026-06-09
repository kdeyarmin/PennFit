import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLAIM_PAPERWORK,
  outstandingLabels,
  pickFaxMatch,
  shouldHold,
  type PaperworkRequirementRow,
} from "./bill-hold";

function row(
  over: Partial<PaperworkRequirementRow> = {},
): PaperworkRequirementRow {
  return {
    id: over.id ?? "r1",
    claim_id: over.claim_id ?? "c1",
    patient_id: "p1",
    requirement_type: over.requirement_type ?? "prescription",
    label: over.label ?? "Signed prescription",
    status: over.status ?? "outstanding",
    required: over.required ?? true,
    sent_at: null,
    sent_via: null,
    expected_return_fax_e164: over.expected_return_fax_e164 ?? null,
    reminder_count: 0,
    last_reminded_at: null,
    satisfied_at: null,
    satisfied_via: null,
    satisfied_by_email: null,
    satisfied_inbound_fax_id: null,
    satisfied_document_id: null,
    source_manual_document_id: null,
    source_packet_id: null,
    waived_reason: null,
    notes: null,
    created_by_email: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
  };
}

describe("shouldHold", () => {
  it("holds when a required requirement is outstanding", () => {
    expect(shouldHold([{ status: "outstanding", required: true }])).toBe(true);
  });

  it("does not hold when the only outstanding row is not required", () => {
    expect(shouldHold([{ status: "outstanding", required: false }])).toBe(
      false,
    );
  });

  it("does not hold when every required row is satisfied / waived / voided", () => {
    expect(
      shouldHold([
        { status: "satisfied", required: true },
        { status: "waived", required: true },
        { status: "voided", required: true },
      ]),
    ).toBe(false);
  });

  it("does not hold an empty ledger (a claim with nothing tracked)", () => {
    expect(shouldHold([])).toBe(false);
  });

  it("holds when ANY required row is still outstanding", () => {
    expect(
      shouldHold([
        { status: "satisfied", required: true },
        { status: "outstanding", required: true },
      ]),
    ).toBe(true);
  });
});

describe("outstandingLabels", () => {
  it("returns only the required+outstanding labels", () => {
    expect(
      outstandingLabels([
        { status: "outstanding", required: true, label: "Rx" },
        { status: "outstanding", required: false, label: "Nice-to-have" },
        { status: "satisfied", required: true, label: "AOB" },
      ]),
    ).toEqual(["Rx"]);
  });
});

describe("pickFaxMatch", () => {
  it("auto-satisfies when exactly one outstanding requirement matches", () => {
    const r = row({ id: "only" });
    const result = pickFaxMatch([r]);
    expect(result.matched?.id).toBe("only");
    expect(result.ambiguous).toBe(false);
  });

  it("refuses to guess when several requirements match the same number", () => {
    const result = pickFaxMatch([row({ id: "a" }), row({ id: "b" })]);
    expect(result.matched).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it("no match on an empty candidate set, not flagged ambiguous", () => {
    const result = pickFaxMatch([]);
    expect(result.matched).toBeNull();
    expect(result.ambiguous).toBe(false);
  });
});

describe("DEFAULT_CLAIM_PAPERWORK", () => {
  it("seeds the three core DME documents, all required", () => {
    expect(DEFAULT_CLAIM_PAPERWORK.map((d) => d.requirementType)).toEqual([
      "prescription",
      "proof_of_delivery",
      "aob",
    ]);
    expect(DEFAULT_CLAIM_PAPERWORK.every((d) => d.required)).toBe(true);
  });
});
