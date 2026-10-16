import { describe, expect, it } from "vitest";

import { classifySetup, type SetupSignals } from "./blocker";

const PATIENT = "11111111-1111-4111-8111-111111111111";

function signals(patch: Partial<SetupSignals> = {}): SetupSignals {
  return {
    hasCoverage: true,
    eligibility: "active",
    medicare: false,
    sameOrSimilar: "missing",
    missingForms: [],
    hasMaskChoice: true,
    openFitRequest: false,
    order: "none",
    priorAuth: "not_required",
    checklistComplete: false,
    ...patch,
  };
}

describe("classifySetup", () => {
  it("asks for insurance before anything else", () => {
    const out = classifySetup(signals({ hasCoverage: false }), PATIENT);
    expect(out.stage).toBe("coverage");
    expect(out.blocker).toBe("Verify insurance");
    expect(out.href).toContain("tab=insurance");
  });

  it("treats in-flight eligibility as a coverage blocker", () => {
    const out = classifySetup(signals({ eligibility: "pending" }), PATIENT);
    expect(out.blocker).toBe("Eligibility is in flight");
  });

  it("blocks a Medicare setup on an active same-or-similar hit", () => {
    const out = classifySetup(
      signals({ medicare: true, sameOrSimilar: "active", order: "queued" }),
      PATIENT,
    );
    expect(out.stage).toBe("docs");
    expect(out.blocker).toMatch(/active/);
    expect(out.href).toContain("tab=setup");
  });

  it("stops asking for same-or-similar once the machine has shipped", () => {
    const out = classifySetup(
      signals({
        medicare: true,
        sameOrSimilar: "missing",
        order: "shipped",
        priorAuth: "approved",
        checklistComplete: false,
      }),
      PATIENT,
    );
    expect(out.stage).toBe("setup");
  });

  it("names the paperwork that is still open", () => {
    const out = classifySetup(
      signals({ missingForms: ["aob", "supplier_standards"] }),
      PATIENT,
    );
    expect(out.stage).toBe("docs");
    expect(out.blocker).toContain("Assignment of benefits");
    expect(out.href).toContain("tab=packets");
  });

  it("sends an open fit with no mask back to the fit-request queue", () => {
    const out = classifySetup(
      signals({ hasMaskChoice: false, openFitRequest: true, order: "none" }),
      PATIENT,
    );
    expect(out.stage).toBe("fit");
    expect(out.href).toBe("/admin/fitter-requests");
  });

  it("points a chosen mask with no order at the new-CPAP kit", () => {
    const out = classifySetup(signals({ order: "none" }), PATIENT);
    expect(out.stage).toBe("order");
    expect(out.href).toContain("kit=new-cpap");
  });

  it("keeps a signed order that did not queue a fulfillment on the board", () => {
    const out = classifySetup(
      signals({ order: "signed_needs_followup" }),
      PATIENT,
    );
    expect(out.blocker).toMatch(/no fulfillment queued/);
  });

  it("holds a required prior auth that is only a draft", () => {
    const out = classifySetup(
      signals({ order: "queued", priorAuth: "draft" }),
      PATIENT,
    );
    expect(out.stage).toBe("auth");
    expect(out.blocker).toMatch(/draft/);
  });

  it("says a submitted prior auth is with the payer", () => {
    const out = classifySetup(
      signals({ order: "queued", priorAuth: "submitted" }),
      PATIENT,
    );
    expect(out.blocker).toBe("E0601 prior auth is with the payer");
  });

  it("sends a queued fulfillment to PacWare", () => {
    const out = classifySetup(signals({ order: "queued" }), PATIENT);
    expect(out.stage).toBe("release");
    expect(out.href).toBe("/admin/pacware");
  });

  it("is ready only after shipment and the first-night checklist", () => {
    const waiting = classifySetup(
      signals({ order: "shipped", checklistComplete: false }),
      PATIENT,
    );
    expect(waiting.stage).toBe("setup");
    expect(waiting.blocker).toMatch(/first-night/);

    const done = classifySetup(
      signals({ order: "shipped", checklistComplete: true }),
      PATIENT,
    );
    expect(done.stage).toBe("ready");
    expect(done.blocker).toBeNull();
  });
});
