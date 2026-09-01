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

  it("ages a queue from when the item ENTERED it, not from row creation", () => {
    // `denial_work` is the case that made this a rule. A claim is
    // created, submitted, adjudicated and only then denied — often two
    // months after `created_at`. Aged from creation, every denial landed
    // in the queue already past its 10-day SLA, so the gate was
    // permanently breached however fast a biller worked it: it measured
    // the payer's turnaround, not ours.
    const denial = findApprovalGate("denial_work");
    expect(denial?.queue?.ageColumn).toBe("decision_at");
    expect(denial?.queue?.ageColumn).not.toBe("created_at");
  });

  it("only ages from `created_at` where the row is CREATED into the queue", () => {
    // Every other queue's rows are written when the work appears — a
    // pending fit review, an outstanding paperwork requirement, a queued
    // fulfillment. For those, `created_at` IS the moment it started
    // waiting. This pins the reasoning rather than the list, so a new
    // gate over a long-lived row has to make the same decision
    // deliberately.
    const createdAtGates = APPROVAL_GATES.filter(
      (g) => g.queue?.ageColumn === "created_at",
    ).map((g) => g.key);
    expect(createdAtGates).not.toContain("denial_work");
    expect(createdAtGates.length).toBeGreaterThan(0);
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
