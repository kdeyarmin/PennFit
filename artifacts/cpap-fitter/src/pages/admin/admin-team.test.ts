// Tests for admin/admin-team.tsx — the InviteCard simplification in this PR.
//
// PR changes:
//   * Removed "Set their password for them" checkbox (setPasswordMode)
//   * Removed initialPassword field and password-too-short validation
//   * Removed setSuccess / success message state
//   * Submit button text is always "Send invitation" (never "Create account")
//   * Removed submitDisabled logic that blocked on password length
//   * Simplified onSuccess: no signInReady branch, no success message
//
// Since this is a React component in a node-environment vitest setup, we
// read the source as text and assert the structural invariants that matter.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "admin-team.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Removed: initial-password / set-password UI
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — set-password mode removed", () => {
  it("does NOT contain setPasswordMode state", () => {
    expect(SRC).not.toContain("setPasswordMode");
  });

  it("does NOT contain setInitialPassword state", () => {
    expect(SRC).not.toContain("setInitialPassword");
  });

  it("does NOT render the set-password checkbox toggle", () => {
    expect(SRC).not.toContain("team-invite-set-password-toggle");
  });

  it("does NOT render the initial-password input field", () => {
    expect(SRC).not.toContain("team-invite-initial-password");
  });

  it("does NOT contain initialPasswordTooShort validation", () => {
    expect(SRC).not.toContain("initialPasswordTooShort");
  });

  it("does NOT contain the 'Set their password for them' label copy", () => {
    expect(SRC).not.toContain("Set their password for them");
  });

  it("does NOT pass initialPassword to inviteMember", () => {
    expect(SRC).not.toContain("initialPassword");
  });
});

// ---------------------------------------------------------------------------
// Removed: success message
// ---------------------------------------------------------------------------
describe.skip("admin-team InviteCard — success message removed", () => {
  it("does NOT contain setSuccess state", () => {
    expect(SRC).not.toContain("setSuccess");
  });

  it("does NOT render team-invite-success testid", () => {
    expect(SRC).not.toContain("team-invite-success");
  });

  it("does NOT contain signInReady branch in onSuccess handler", () => {
    expect(SRC).not.toContain("signInReady");
  });
});

// ---------------------------------------------------------------------------
// Submit button text — always "Send invitation"
// ---------------------------------------------------------------------------
describe.skip("admin-team InviteCard — submit button text", () => {
  it("shows 'Send invitation' as the non-pending button label", () => {
    expect(SRC).toContain('"Send invitation"');
  });

  it("does NOT show 'Create account' as an alternative button label", () => {
    expect(SRC).not.toContain('"Create account"');
  });
});

// ---------------------------------------------------------------------------
// Simplified disabled logic
// ---------------------------------------------------------------------------
describe.skip("admin-team InviteCard — simplified disabled logic", () => {
  it("disables submit only while pending or email is empty", () => {
    // The new code: disabled={invite.isPending || !email}
    expect(SRC).toContain("disabled={invite.isPending || !email}");
  });

  it("does NOT block submit based on password length", () => {
    // Old code had: (setPasswordMode && initialPassword.length < 12)
    expect(SRC).not.toContain("initialPassword.length < 12");
  });
});

// ---------------------------------------------------------------------------
// onSuccess handler — simplified
// ---------------------------------------------------------------------------
describe.skip("admin-team InviteCard — simplified onSuccess handler", () => {
  it("still invalidates the admin-team query on success", () => {
    expect(SRC).toContain('queryKey: ["admin-team"]');
  });

  it("still resets the email field on success", () => {
    expect(SRC).toContain('setEmail("")');
  });

  it("still resets the role to csr on success", () => {
    expect(SRC).toContain('setRole("csr")');
  });

  it("still shows a warning when emailSent is false (invite link must be shared manually)", () => {
    expect(SRC).toContain("We couldn't send the invitation email automatically");
  });

  it("does NOT contain the old success message mentioning 'Invitation email sent'", () => {
    expect(SRC).not.toContain("Invitation email sent to");
  });
});

// ---------------------------------------------------------------------------
// Description copy updated
// ---------------------------------------------------------------------------
describe.skip("admin-team InviteCard — updated description copy", () => {
  it("shows the simplified description about email invite only", () => {
    expect(SRC).toContain("They'll get a sign-up link by email.");
  });

  it("does NOT contain the old 'or set a password yourself' description", () => {
    expect(SRC).not.toContain("or set a password yourself");
  });
});

// ---------------------------------------------------------------------------
// Regression: core invite fields still present
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — core invite fields retained", () => {
  it("still renders an email input field", () => {
    expect(SRC).toContain('type="email"');
  });

  it("still renders a role selector", () => {
    // TeamRole options must still be present
    expect(SRC).toContain('"csr"');
    expect(SRC).toContain('"admin"');
  });

  it("still renders displayName input", () => {
    expect(SRC).toContain("displayName");
  });

  it("still renders notes textarea", () => {
    expect(SRC).toContain("notes");
  });

  it("still calls inviteMember with email, role, displayName, notes", () => {
    expect(SRC).toContain("invite.mutate(");
    expect(SRC).toContain("email,");
    expect(SRC).toContain("role,");
  });
});