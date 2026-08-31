// The registry is a DESCRIPTION of the system, so these tests guard the
// things that make a description useful: it stays complete, it stays
// honest, and it cannot drift into claiming a gate that does not exist.

import { describe, expect, it } from "vitest";

import {
  APPROVAL_ACTOR_LABEL,
  APPROVAL_GATES,
  findApprovalGate,
} from "./registry";

describe("approval gate registry", () => {
  it("has a unique key per gate", () => {
    const keys = APPROVAL_GATES.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every gate a reason a person is required", () => {
    // If the argument cannot be written down, the gate probably should
    // not exist — and a panel that shows a gate with no reason invites
    // exactly the "can't we automate this?" conversation it exists to
    // answer.
    for (const gate of APPROVAL_GATES) {
      expect(gate.why.trim().length, gate.key).toBeGreaterThan(30);
      // A reason, not a restatement of the label.
      expect(gate.why.toLowerCase()).not.toBe(gate.label.toLowerCase());
    }
  });

  it("points every gate at a real admin route", () => {
    for (const gate of APPROVAL_GATES) {
      expect(gate.href, gate.key).toMatch(/^\/admin\//);
    }
  });

  it("labels every actor", () => {
    for (const gate of APPROVAL_GATES) {
      expect(APPROVAL_ACTOR_LABEL[gate.actor], gate.key).toBeTruthy();
    }
  });

  it("gives every countable gate at least one filter", () => {
    // An unfiltered count would return the whole table and report a
    // backlog of thousands, which reads as a broken product.
    for (const gate of APPROVAL_GATES) {
      if (!gate.queue) continue;
      const filters =
        Object.keys(gate.queue.match).length +
        (gate.queue.anyOf ? 1 : 0) +
        (gate.queue.isNull ? 1 : 0);
      expect(filters, gate.key).toBeGreaterThan(0);
    }
  });

  it("covers the transitions the code comments call out as human", () => {
    // These three are named in source comments as deliberate human steps
    // (auto-workflow-engine "we never auto-SUBMIT",
    // billing-action-queue "a deliberate human click"). If one is ever
    // automated, this test failing is the prompt to update the copy too.
    for (const key of [
      "claim_submit",
      "secondary_cob_submit",
      "appeal_send",
      "claim_from_fulfillment",
    ]) {
      expect(findApprovalGate(key), key).toBeDefined();
    }
  });

  it("spans clinical, support and billing", () => {
    const actors = new Set(APPROVAL_GATES.map((g) => g.actor));
    expect(actors.has("clinician")).toBe(true);
    expect(actors.has("csr")).toBe(true);
    expect(actors.has("biller")).toBe(true);
  });

  it("returns undefined for an unknown key", () => {
    expect(findApprovalGate("not_a_gate")).toBeUndefined();
  });
});
