import { describe, expect, it } from "vitest";

import { accountRefMatches } from "./stripe";

// The predicate that decides whether a stored, account-scoped Stripe ID may
// be reused against the account platform billing is syncing against now.
describe("accountRefMatches", () => {
  const PATIENT = "acct_patient";
  const PLATFORM = "acct_platform";

  it("matches when the stored ref equals the current account id", () => {
    expect(accountRefMatches(PLATFORM, PLATFORM, "dedicated")).toBe(true);
  });

  it("does NOT match when the stored ref is a different account id", () => {
    // The dangerous case: an ID synced on the patient account, now syncing
    // against the dedicated platform account.
    expect(accountRefMatches(PATIENT, PLATFORM, "dedicated")).toBe(false);
  });

  it("treats a NULL ref as the shared account (legacy rows)", () => {
    // NULL predates the column → synced on the shared account. Matches only
    // in shared mode.
    expect(accountRefMatches(null, PATIENT, "shared")).toBe(true);
    expect(accountRefMatches(undefined, PATIENT, "shared")).toBe(true);
    // In dedicated mode a legacy NULL ref is a foreign (shared) account.
    expect(accountRefMatches(null, PLATFORM, "dedicated")).toBe(false);
  });

  it("treats a blank ref the same as NULL", () => {
    expect(accountRefMatches("", PATIENT, "shared")).toBe(true);
    expect(accountRefMatches("", PLATFORM, "dedicated")).toBe(false);
  });
});
