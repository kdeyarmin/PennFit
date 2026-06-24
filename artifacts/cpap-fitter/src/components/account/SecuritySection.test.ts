// Tests for components/account/SecuritySection.tsx
//
// The component uses React hooks (authHooks.useChangePassword) and isn't
// rendered in the node vitest environment. We use the same two strategies
// as ProfileSection.test.ts:
//   1. Static source analysis — assert the wiring is present (data-testids,
//      the change-password hook, password input types/autocomplete, cleared
//      fields on success).
//   2. Direct unit tests of the real exported validation logic
//      (validatePasswordChange) — imported, not re-implemented, so any
//      drift fails the test.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MIN_PASSWORD_LENGTH, validatePasswordChange } from "./SecuritySection";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "SecuritySection.tsx"), "utf8");

describe("SecuritySection — structure / wiring", () => {
  it("renders under the account-security-section testid", () => {
    expect(SRC).toContain('data-testid="account-security-section"');
  });

  it("wires the three password fields with testids", () => {
    expect(SRC).toContain('data-testid="account-current-password"');
    expect(SRC).toContain('data-testid="account-new-password"');
    expect(SRC).toContain('data-testid="account-confirm-password"');
  });

  it("submits through the change-password hook (not a raw fetch)", () => {
    expect(SRC).toContain("authHooks.useChangePassword()");
    expect(SRC).toContain(
      "changePassword.mutateAsync({ currentPassword, newPassword })",
    );
  });

  it("uses password inputs with the right autocomplete hints", () => {
    expect(SRC).toContain('autoComplete="current-password"');
    expect(SRC).toContain('autoComplete="new-password"');
    // Every credential field is type=password (no plaintext input).
    expect(SRC).not.toContain('type="text"');
  });

  it("clears the password fields after a successful change", () => {
    expect(SRC).toContain('setCurrentPassword("")');
    expect(SRC).toContain('setNewPassword("")');
    expect(SRC).toContain('setConfirmPassword("")');
  });

  it("maps server failures through the shared authErrorMessage helper", () => {
    expect(SRC).toContain("authErrorMessage(");
  });
});

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
