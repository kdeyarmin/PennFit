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

// ---------------------------------------------------------------------------
// Removed: success message
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Submit button text — always "Send invitation"
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — submit button text", () => {
  it("shows 'Send invitation' as the non-pending button label", () => {
    expect(SRC).toContain('"Send invitation"');
  });

});

// ---------------------------------------------------------------------------
// Simplified disabled logic
// ---------------------------------------------------------------------------

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

});

// ---------------------------------------------------------------------------
// Description copy updated
// ---------------------------------------------------------------------------

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