// Tests for admin-team.tsx — the InviteCard component specifically.
//
// This PR removed the "Set their password for them" toggle from the
// InviteCard. The removed code included:
//   - initialPassword and setPasswordMode state variables
//   - The "Set their password for them" checkbox UI
//   - The initial-password input field
//   - The submitDisabled computed variable (simplified to a direct check)
//   - The success message for the signInReady path
//   - Button label conditional ("Create account" vs "Send invitation")
//
// Tests inspect the source to verify the removal and that the
// simplified invite flow is in place.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "admin-team.tsx"), "utf8");

describe("InviteCard — set-password mode removed", () => {
  it("does not have setPasswordMode state", () => {
    expect(SRC).not.toContain("setPasswordMode");
    expect(SRC).not.toContain("setSetPasswordMode");
  });

  it("does not have initialPassword state", () => {
    expect(SRC).not.toContain("initialPassword");
    expect(SRC).not.toContain("setInitialPassword");
  });

  it("does not render the set-password checkbox toggle", () => {
    expect(SRC).not.toContain("team-invite-set-password-toggle");
    expect(SRC).not.toContain("Set their password for them");
  });

  it("does not render the initial-password input field", () => {
    expect(SRC).not.toContain("team-invite-initial-password");
    expect(SRC).not.toContain("Initial password");
  });

  it("does not have the initialPasswordTooShort variable", () => {
    expect(SRC).not.toContain("initialPasswordTooShort");
  });

  it("does not have the submitDisabled variable", () => {
    expect(SRC).not.toContain("submitDisabled");
  });
});

describe("InviteCard — signInReady handling removed", () => {
  it("does not reference signInReady in success handling", () => {
    expect(SRC).not.toContain("signInReady");
  });

  it("does not have a success state for the signInReady path", () => {
    expect(SRC).not.toContain("team-invite-success");
    expect(SRC).not.toContain("setSuccess");
  });
});

describe("InviteCard — simplified invite flow", () => {
  it("button is disabled when email is empty or mutation is pending", () => {
    // The simplified disable condition
    expect(SRC).toContain("invite.isPending || !email");
  });

  it("button always shows 'Send invitation' (no 'Create account' branch)", () => {
    expect(SRC).toContain('"Send invitation"');
    expect(SRC).not.toContain('"Create account"');
  });

  it("inviteMember call does not pass initialPassword", () => {
    // Check that the mutate call doesn't forward initialPassword
    expect(SRC).not.toContain("initialPassword:");
  });

  it("still shows warning when emailSent is false", () => {
    // The emailSent warning path must remain
    expect(SRC).toContain("emailSent");
    expect(SRC).toContain("sign-up link with this person directly");
  });
});

describe("InviteCard — core invite fields still present", () => {
  it("still has email state and input", () => {
    expect(SRC).toContain("setEmail");
    expect(SRC).toContain('type="email"');
  });

  it("still has role selector", () => {
    expect(SRC).toContain("setRole");
  });

  it("still has displayName and notes fields", () => {
    expect(SRC).toContain("displayName");
    expect(SRC).toContain("notes");
  });

  it("passes description 'They'll get a sign-up link by email.'", () => {
    expect(SRC).toContain("They");
    expect(SRC).toContain("sign-up link by email");
  });
});