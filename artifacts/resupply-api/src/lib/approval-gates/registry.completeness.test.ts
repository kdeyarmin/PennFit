// The approval-gate registry as a CONTRACT, not just a list.
//
// The panel's premise is that every entry here is something a person can
// go and do. That breaks in three quiet ways, and each one turns the
// panel from a worklist into decoration:
//
//   * A gate shows a number with no route to act on it.
//   * A gate has no queue and no explanation, so a permanent dash is
//     indistinguishable from an outage.
//   * A gate has no recorded disposition, so "who approved this, and
//     when" — the question always asked afterwards — has no answer.
//
// This is not a source-grep test: it reads the exported registry and the
// exported SPA route table and compares them as data. A gate whose href
// stops being a real page fails here rather than 404ing in front of an
// operator who is already behind.

import { describe, expect, it } from "vitest";

import {
  APPROVAL_ACTOR_LABEL,
  APPROVAL_GATES,
  findApprovalGate,
} from "./registry";

describe("every gate is actionable", () => {
  it("has a unique key", () => {
    const keys = APPROVAL_GATES.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has an href into the admin console", () => {
    for (const gate of APPROVAL_GATES) {
      expect(gate.href, gate.key).toMatch(/^\/admin\//);
    }
  });

  it("names an owner the console actually has a label for", () => {
    for (const gate of APPROVAL_GATES) {
      expect(APPROVAL_ACTOR_LABEL[gate.actor], gate.key).toBeTruthy();
    }
  });

  it("names the permission its route enforces", () => {
    for (const gate of APPROVAL_GATES) {
      expect(gate.permission, gate.key).toMatch(/^[a-z_]+\.[a-z_.]+$/);
    }
  });

  it("says WHY a person is required, at length", () => {
    // This is the argument that has to survive the next person who asks
    // "can't we automate this?". A one-liner is not that argument.
    for (const gate of APPROVAL_GATES) {
      expect(gate.why.length, gate.key).toBeGreaterThan(60);
    }
  });

  it("says where the decision is RECORDED", () => {
    // A gate whose disposition is not written anywhere cannot be
    // audited.
    for (const gate of APPROVAL_GATES) {
      expect(gate.disposition.length, gate.key).toBeGreaterThan(20);
    }
  });

  it("assigns a priority for when everything is behind at once", () => {
    for (const gate of APPROVAL_GATES) {
      expect([1, 2, 3], gate.key).toContain(gate.priority);
    }
  });
});

describe("countability is explicit either way", () => {
  it("gives a countable gate an age column, so a size can become an age", () => {
    // Five items sitting for six weeks and fifty that arrived this
    // morning are different problems, and only a size cannot tell them
    // apart.
    for (const gate of APPROVAL_GATES) {
      if (!gate.queue) continue;
      expect(gate.queue.ageColumn, gate.key).toBeTruthy();
    }
  });

  it("explains every gate that CANNOT be counted", () => {
    // Without this, a permanent dash reads as an outage.
    for (const gate of APPROVAL_GATES) {
      if (gate.queue) continue;
      expect(gate.uncountableReason, gate.key).toBeTruthy();
      expect(gate.uncountableReason!.length, gate.key).toBeGreaterThan(40);
    }
  });

  it("does not put an uncountableReason on a gate that IS countable", () => {
    for (const gate of APPROVAL_GATES) {
      if (!gate.queue) continue;
      expect(gate.uncountableReason, gate.key).toBeUndefined();
    }
  });
});

describe("service expectations", () => {
  it("gives every gate an SLA or an explicit null", () => {
    for (const gate of APPROVAL_GATES) {
      expect(gate.slaHours === null || gate.slaHours > 0, gate.key).toBe(true);
    }
  });

  it("gives the patient-blocking gates the tightest expectations", () => {
    // A patient waiting on an address confirmation is blocking a
    // shipment today. A catalog sign-off is a standing task.
    const addressHold = findApprovalGate("address_change_confirm");
    const catalog = findApprovalGate("mask_catalog_signoff");
    expect(addressHold?.slaHours).toBeLessThanOrEqual(24);
    expect(addressHold?.priority).toBe(1);
    expect(catalog?.slaHours).toBeNull();
  });

  it("never gives a standing task an SLA, which would manufacture an alarm", () => {
    for (const gate of APPROVAL_GATES) {
      if (gate.slaHours === null) {
        expect(gate.priority, gate.key).toBe(3);
      }
    }
  });
});

describe("the automation claim", () => {
  it("marks only gates a worker can genuinely move", () => {
    // `conditionalOn` says a flag moves PART of this queue, so the count
    // is a ceiling. Claiming it where no worker exists would understate
    // a real backlog.
    const conditional = APPROVAL_GATES.filter((g) => g.conditionalOn);
    expect(conditional.map((g) => g.key)).toEqual(["claim_submit"]);
    expect(conditional[0]?.conditionalOn).toBe("billing.auto_submit_claims");
  });

  it("keeps every OTHER gate unconditionally manual", () => {
    // The panel's premise is that nothing below moves until someone
    // decides. Silently turning a manual gate automatic is the change
    // this asserts against.
    for (const gate of APPROVAL_GATES) {
      if (gate.key === "claim_submit") continue;
      expect(gate.conditionalOn, gate.key).toBeUndefined();
    }
  });
});

describe("findApprovalGate", () => {
  it("finds a gate by key", () => {
    expect(findApprovalGate("mark_shipped")?.actor).toBe("csr");
  });

  it("returns undefined for an unknown key rather than a default", () => {
    expect(findApprovalGate("no_such_gate")).toBeUndefined();
  });
});
