// Tests for components/account/SecuritySection.tsx
//
// The component's non-trivial logic is the client-side change-password
// validation, which lives in the exported pure `validatePasswordChange`
// so it can be driven directly (the surrounding form is a thin wrapper
// over authHooks.useChangePassword + UI state). We assert BEHAVIOR by
// calling the real function — no source reads.

import { describe, expect, it } from "vitest";

import { MIN_PASSWORD_LENGTH, validatePasswordChange } from "./SecuritySection";

describe("validatePasswordChange", () => {
  const ok = {
    currentPassword: "oldpassword1",
    newPassword: "newpassword1",
    confirmPassword: "newpassword1",
  };

  it("returns null for a valid change", () => {
    expect(validatePasswordChange(ok)).toBeNull();
  });

  it("requires every field", () => {
    expect(validatePasswordChange({ ...ok, currentPassword: "" })).toMatch(
      /fill in every field/i,
    );
    expect(validatePasswordChange({ ...ok, newPassword: "" })).toMatch(
      /fill in every field/i,
    );
  });

  it(`enforces the ${MIN_PASSWORD_LENGTH}-char minimum on the new password`, () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(
      validatePasswordChange({
        ...ok,
        newPassword: short,
        confirmPassword: short,
      }),
    ).toMatch(/at least/i);
  });

  it("accepts exactly the minimum length", () => {
    const min = "a".repeat(MIN_PASSWORD_LENGTH);
    expect(
      validatePasswordChange({
        currentPassword: "different-old",
        newPassword: min,
        confirmPassword: min,
      }),
    ).toBeNull();
  });

  it("requires the confirmation to match", () => {
    expect(
      validatePasswordChange({ ...ok, confirmPassword: "different1" }),
    ).toMatch(/don't match/i);
  });

  it("rejects reusing the current password", () => {
    expect(
      validatePasswordChange({
        currentPassword: "samepassword1",
        newPassword: "samepassword1",
        confirmPassword: "samepassword1",
      }),
    ).toMatch(/different from the current/i);
  });
});
