import { describe, expect, it } from "vitest";

import { parse271 } from "./parse-271";

describe("parse271 — coverage status (EB01)", () => {
  it("reports active coverage for EB01=1", () => {
    const x = ["TRN*2*TRACE-001~", "EB*1~"].join("");
    expect(parse271(x).isActive).toBe(true);
  });

  it("reports inactive coverage for EB01=6", () => {
    const x = ["TRN*2*TRACE-002~", "EB*6~"].join("");
    expect(parse271(x).isActive).toBe(false);
  });

  it("keeps active coverage when a later non-covered (EB01=I) service-type line follows EB01=1", () => {
    // A real 271 routinely carries plan-level active coverage plus
    // per-service-type non-covered lines. The non-covered service must
    // NOT flip the plan-level active flag to inactive.
    const x = ["TRN*2*TRACE-003~", "EB*1~", "EB*I~"].join("");
    expect(parse271(x).isActive).toBe(true);
  });

  it("is order-independent: EB01=I before EB01=1 still resolves active", () => {
    const x = ["TRN*2*TRACE-004~", "EB*I~", "EB*1~"].join("");
    expect(parse271(x).isActive).toBe(true);
  });

  it("treats mix of EB01=6 (inactive) and EB01=1 (active) as active when EB01=1 is present — EB01=6 first", () => {
    const x = ["TRN*2*TRACE-MIX-001~", "EB*6~", "EB*1~"].join("");
    expect(parse271(x).isActive).toBe(true);
  });

  it("treats mix of EB01=6 (inactive) and EB01=1 (active) as active when EB01=1 is present — EB01=1 first", () => {
    const x = ["TRN*2*TRACE-MIX-002~", "EB*1~", "EB*6~"].join("");
    expect(parse271(x).isActive).toBe(true);
  });

  it("defaults to not-active when no coverage-status EB segment is present", () => {
    const x = ["TRN*2*TRACE-005~", "EB*I~"].join("");
    expect(parse271(x).isActive).toBe(false);
  });

  it("echoes the trace reference from TRN02", () => {
    const x = ["TRN*2*TRACE-006~", "EB*1~"].join("");
    expect(parse271(x).traceReference).toBe("TRACE-006");
  });
});
