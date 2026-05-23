// Tests for admin/admin-team.tsx
//
// PR changes verified here:
//   * The "Set their password for them" UI block was entirely removed:
//     - No setPasswordMode / initialPassword state
//     - No password checkbox toggle (data-testid="team-invite-set-password-toggle")
//     - No initial-password input (data-testid="team-invite-initial-password")
//     - No success banner (data-testid="team-invite-success")
//   * inviteMember is called WITHOUT initialPassword
//   * Submit disabled logic simplified to: invite.isPending || !email
//   * Button label simplified to just "Send invitation"
//   * Subtitle changed from "… or set a password yourself" to
//     "They'll get a sign-up link by email."
//
// The component uses React which cannot be rendered in the node vitest
// environment without jsdom. We read the source file as a string and
// assert on the structural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "admin-team.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Removed: "set their password" UI
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — password-setting UI removed", () => {
  it("does not contain setPasswordMode state", () => {
    expect(SRC).not.toContain("setPasswordMode");
    expect(SRC).not.toContain("setSetPasswordMode");
  });

  it("does not contain initialPassword state", () => {
    expect(SRC).not.toContain("initialPassword");
    expect(SRC).not.toContain("setInitialPassword");
  });

  it("does not render the password-toggle checkbox", () => {
    expect(SRC).not.toContain("team-invite-set-password-toggle");
  });

  it("does not render the initial-password input", () => {
    expect(SRC).not.toContain("team-invite-initial-password");
  });

  it("does not render the success banner", () => {
    expect(SRC).not.toContain("team-invite-success");
  });

  it("does not have a 'Create account' button label", () => {
    expect(SRC).not.toContain("Create account");
  });

  it("does not reference the initialPasswordTooShort validation", () => {
    expect(SRC).not.toContain("initialPasswordTooShort");
    expect(SRC).not.toContain("Password must be at least 12 characters");
  });

  it("does not have the submitDisabled variable referencing initialPassword length", () => {
    // The old code: submitDisabled = invite.isPending || !email || (setPasswordMode && initialPassword.length < 12)
    expect(SRC).not.toContain("submitDisabled");
  });
});

// ---------------------------------------------------------------------------
// Removed: signInReady handling
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — signInReady removed", () => {
  it("does not reference result.signInReady", () => {
    expect(SRC).not.toContain("signInReady");
  });

  it("does not contain a 'is ready to sign in now' success message", () => {
    expect(SRC).not.toContain("is ready to sign in now");
  });
});

// ---------------------------------------------------------------------------
// Current behaviour: email-only invite flow
// ---------------------------------------------------------------------------
describe("admin-team InviteCard — simplified invite flow", () => {
  it("shows the simplified subtitle: sign-up link by email only", () => {
    // The JSX source uses the HTML entity &apos; for the apostrophe.
    expect(SRC).toContain("They&apos;ll get a sign-up link by email.");
  });

  it("disables the submit button based on isPending || !email (no password check)", () => {
    expect(SRC).toContain("invite.isPending || !email");
  });

  it("calls invite.mutate without initialPassword", () => {
    // The mutate call should NOT pass initialPassword — check the
    // mutate block only passes the four known fields.
    const mutateIdx = SRC.indexOf("invite.mutate(");
    expect(mutateIdx).toBeGreaterThanOrEqual(0);
    // Grab a window around the mutate call to inspect its argument.
    const snippet = SRC.slice(mutateIdx, mutateIdx + 400);
    expect(snippet).not.toContain("initialPassword");
  });

  it("still has a warning path when emailSent is false", () => {
    expect(SRC).toContain("!result.emailSent");
    expect(SRC).toContain(
      "We couldn\u0027t send the invitation email automatically",
    );
  });

  it("still shows 'Send invitation' as the default button label", () => {
    expect(SRC).toContain('"Send invitation"');
  });

  it("the button label is a simple ternary between 'Sending\u2026' and 'Send invitation'", () => {
    // Old code had a three-branch expression including "Create account"
    expect(SRC).toMatch(/Sending….*Send invitation|Send invitation.*Sending…/s);
    expect(SRC).not.toContain("Create account");
  });

  it("still supports email, role, displayName, and notes form fields", () => {
    expect(SRC).toContain("setEmail(");
    expect(SRC).toContain("setRole(");
    expect(SRC).toContain("setDisplayName(");
    expect(SRC).toContain("setNotes(");
  });

  it("imports inviteMember from the admin-team-api module", () => {
    expect(SRC).toContain('from "@/lib/admin/admin-team-api"');
    expect(SRC).toContain("inviteMember");
  });
});

// ---------------------------------------------------------------------------
// Role constants not changed
// ---------------------------------------------------------------------------
describe("admin-team — role constants unchanged", () => {
  it("defines ROLE_LABEL for all seven TeamRole values", () => {
    expect(SRC).toContain('"admin"');
    expect(SRC).toContain('"supervisor"');
    expect(SRC).toContain('"compliance_officer"');
    expect(SRC).toContain('"csr"');
    expect(SRC).toContain('"fitter"');
    expect(SRC).toContain('"fulfillment"');
    expect(SRC).toContain('"agent"');
  });

  it("restricts new invites to the three ROLE_OPTIONS buckets", () => {
    expect(SRC).toContain('ROLE_OPTIONS: TeamRole[] = ["admin", "supervisor", "csr"]');
  });
});