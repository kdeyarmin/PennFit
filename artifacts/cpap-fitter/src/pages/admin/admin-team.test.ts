// Tests for admin/admin-team.tsx — the full-featured InviteCard.
//
// A feature branch once tried to simplify InviteCard (drop the
// "Set their password for them" mode, the success message, and the
// password-length submit guard); that change was reverted on main, so
// the canonical InviteCard retains all of it:
//   * "Set their password for them" checkbox (setPasswordMode)
//   * initialPassword field + password-too-short validation
//   * setSuccess / success message state (incl. the signInReady branch)
//   * Submit button toggles between "Create account" and "Send invitation"
//   * submitDisabled blocks while pending, with no email, or on a too-short
//     admin-set password
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
describe("admin-team InviteCard — set-password mode present", () => {
  it("contains setPasswordMode state", () => {
    expect(SRC).toContain("setPasswordMode");
  });

  it("contains setInitialPassword state", () => {
    expect(SRC).toContain("setInitialPassword");
  });

  it("renders the set-password checkbox toggle", () => {
    expect(SRC).toContain("team-invite-set-password-toggle");
  });

  it("renders the initial-password input field", () => {
    expect(SRC).toContain("team-invite-initial-password");
  });

  it("contains initialPasswordTooShort validation", () => {
    expect(SRC).toContain("initialPasswordTooShort");
  });

  it("contains the 'Set their password for them' label copy", () => {
    expect(SRC).toContain("Set their password for them");
  });

  it("passes initialPassword to inviteMember", () => {
    expect(SRC).toContain("initialPassword");
  });
});

// ---------------------------------------------------------------------------
// Removed: success message
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — success message present", () => {
  it("contains setSuccess state", () => {
    expect(SRC).toContain("setSuccess");
  });

  it("renders team-invite-success testid", () => {
    expect(SRC).toContain("team-invite-success");
  });

  it("contains signInReady branch in onSuccess handler", () => {
    expect(SRC).toContain("signInReady");
  });
});

// ---------------------------------------------------------------------------
// Submit button text — always "Send invitation"
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — submit button text", () => {
  it("shows 'Send invitation' as the default (email-invite) button label", () => {
    expect(SRC).toContain('"Send invitation"');
  });

  it("shows 'Create account' as the label when set-password mode is on", () => {
    expect(SRC).toContain('"Create account"');
  });
});

// ---------------------------------------------------------------------------
// Simplified disabled logic
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — submitDisabled logic", () => {
  it("gates the submit button on the submitDisabled flag", () => {
    expect(SRC).toContain("disabled={submitDisabled}");
  });

  it("disables submit while pending or when email is empty", () => {
    // submitDisabled = invite.isPending || !email || (...)
    expect(SRC).toContain("invite.isPending ||");
    expect(SRC).toContain("!email");
  });

  it("blocks submit when an admin-set password is too short", () => {
    // submitDisabled also folds in (setPasswordMode && initialPassword.length < 12)
    expect(SRC).toContain("initialPassword.length < 12");
  });
});

// ---------------------------------------------------------------------------
// onSuccess handler — simplified
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — simplified onSuccess handler", () => {
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

  it("shows a success message confirming the invitation email was sent", () => {
    expect(SRC).toContain("Invitation email sent to");
  });
});

// ---------------------------------------------------------------------------
// Description copy updated
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — description copy", () => {
  it("mentions the email sign-up link in the header description", () => {
    expect(SRC).toContain("get a sign-up link by email");
  });

  it("offers the 'or set a password yourself' alternative in the description", () => {
    expect(SRC).toContain("or set a password yourself");
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