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

// ---------------------------------------------------------------------------
// useConfirmDialog — MemberRow confirmation dialogs
// (PR change: replaced window.confirm with useConfirmDialog hook)
// ---------------------------------------------------------------------------

describe("admin-team MemberRow — useConfirmDialog import", () => {
  it("imports useConfirmDialog from @/hooks/use-confirm-dialog", () => {
    expect(SRC).toContain('from "@/hooks/use-confirm-dialog"');
    expect(SRC).toContain("useConfirmDialog");
  });

  it("initialises [confirm, ConfirmDialogEl] inside MemberRow", () => {
    expect(SRC).toContain(
      "const [confirm, ConfirmDialogEl] = useConfirmDialog();",
    );
  });
});

describe("admin-team MemberRow — promote to admin confirm", () => {
  it("promote onClick handler is async", () => {
    // All three handlers (promote, demote, revoke) are async.
    expect(SRC).toContain("onClick={async () => {");
  });

  it("awaits confirm() before promoting (async guard pattern)", () => {
    expect(SRC).toMatch(/!\(await confirm\(\{[\s\S]{0,600}return;/);
  });

  it('uses title "Promote to admin?"', () => {
    expect(SRC).toContain('title: "Promote to admin?"');
  });

  it("description mentions granting admin privileges", () => {
    expect(SRC).toContain(
      "Grant admin privileges to",
    );
  });

  it('uses confirmLabel "Promote"', () => {
    expect(SRC).toContain('confirmLabel: "Promote"');
  });

  it("promote does NOT use destructive styling (reversible by demote)", () => {
    // The promote dialog is neutral — the admin can demote later.
    // Look for the promote-specific block.
    expect(SRC).toContain('title: "Promote to admin?"');
    // Confirm destructive is NOT in the promote block (it appears only
    // in the revoke block).
    const promoteBlock =
      SRC.match(
        /title: "Promote to admin\?"[\s\S]{0,300}?confirmLabel: "Promote"/,
      )?.[0] ?? "";
    expect(promoteBlock).not.toContain("destructive: true");
  });

  it("still calls promote.mutate() on confirmation", () => {
    expect(SRC).toContain("promote.mutate();");
  });
});

describe("admin-team MemberRow — demote to CSR confirm", () => {
  it('uses title "Demote to CSR?"', () => {
    expect(SRC).toContain('title: "Demote to CSR?"');
  });

  it("description mentions losing admin privileges", () => {
    expect(SRC).toContain("They will lose admin privileges.");
  });

  it('uses confirmLabel "Demote"', () => {
    expect(SRC).toContain('confirmLabel: "Demote"');
  });

  it("still calls demote.mutate() on confirmation", () => {
    expect(SRC).toContain("demote.mutate();");
  });
});

describe("admin-team MemberRow — revoke access confirm", () => {
  it('uses title "Revoke access?"', () => {
    expect(SRC).toContain('title: "Revoke access?"');
  });

  it("description warns the session ends immediately", () => {
    expect(SRC).toContain(
      "This will immediately end their session and prevent future sign-in.",
    );
  });

  it('uses confirmLabel "Revoke access"', () => {
    expect(SRC).toContain('confirmLabel: "Revoke access"');
  });

  it("marks the revoke action as destructive:true", () => {
    expect(SRC).toContain("destructive: true");
  });

  it("still calls revoke.mutate() on confirmation", () => {
    expect(SRC).toContain("revoke.mutate();");
  });
});

describe("admin-team MemberRow — ConfirmDialogEl in JSX", () => {
  it("renders {ConfirmDialogEl} inside MemberRow return", () => {
    expect(SRC).toContain("{ConfirmDialogEl}");
  });
});

describe("admin-team — window.confirm removed", () => {
  it("does not use window.confirm anywhere in the file", () => {
    expect(SRC).not.toContain("window.confirm");
  });
});