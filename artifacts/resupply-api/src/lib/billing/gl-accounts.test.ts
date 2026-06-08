import { describe, it, expect } from "vitest";

import { GL_ACCOUNT_DEFAULTS, resolveGlAccounts } from "./gl-accounts";

describe("resolveGlAccounts", () => {
  it("returns the defaults when nothing is configured", () => {
    expect(resolveGlAccounts([])).toEqual(GL_ACCOUNT_DEFAULTS);
  });

  it("overlays configured keys onto the defaults", () => {
    const r = resolveGlAccounts([
      { mapping_key: "deposit", account_name: "Bank:Stripe" },
      { mapping_key: "patient_pay", account_name: "Income:Patient Pay" },
    ]);
    expect(r.deposit).toBe("Bank:Stripe");
    expect(r.patientPay).toBe("Income:Patient Pay");
    // Unconfigured keys stay default.
    expect(r.revenue).toBe(GL_ACCOUNT_DEFAULTS.revenue);
    expect(r.refund).toBe(GL_ACCOUNT_DEFAULTS.refund);
  });

  it("ignores blank account names and unknown keys", () => {
    const r = resolveGlAccounts([
      { mapping_key: "revenue", account_name: "   " },
      { mapping_key: "bogus", account_name: "X" },
    ]);
    expect(r.revenue).toBe(GL_ACCOUNT_DEFAULTS.revenue);
  });
});
