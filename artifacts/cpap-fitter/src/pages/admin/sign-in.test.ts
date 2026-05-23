// Tests for admin/sign-in.tsx
//
// PR changes verified here:
//   * SERVER_UNAVAILABLE_MESSAGE constant removed — the file must not
//     contain the credentials-store unavailability copy.
//   * authErrorMessage() helper function removed.
//   * Error handling for password step now uses:
//       err instanceof AuthError ? err.userMessage : "Sign-in failed."
//   * Error handling for MFA step now uses:
//       err instanceof AuthError ? err.userMessage : "Verification failed."
//
// The component uses React which cannot be rendered in the node vitest
// environment without jsdom. We read the source file as a string and
// assert on the structural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "sign-in.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Removed: SERVER_UNAVAILABLE_MESSAGE constant
// ---------------------------------------------------------------------------
describe("admin/sign-in — SERVER_UNAVAILABLE_MESSAGE removed", () => {
  it("does not define SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does not contain the credentials-store unavailability copy", () => {
    expect(SRC).not.toContain("credentials store right now");
  });

  it("does not reference status.pennpaps.com in an error message", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

// ---------------------------------------------------------------------------
// Removed: authErrorMessage helper function
// ---------------------------------------------------------------------------
describe("admin/sign-in — authErrorMessage function removed", () => {
  it("does not define an authErrorMessage function", () => {
    expect(SRC).not.toContain("function authErrorMessage");
    expect(SRC).not.toContain("authErrorMessage(");
  });
});

// ---------------------------------------------------------------------------
// Current: inline AuthError-aware error messages
// ---------------------------------------------------------------------------
describe("admin/sign-in — inline AuthError error handling", () => {
  it("uses AuthError instanceof check directly in onError for password step", () => {
    expect(SRC).toContain(
      'err instanceof AuthError ? err.userMessage : "Sign-in failed."',
    );
  });

  it("uses AuthError instanceof check directly in onError for MFA step", () => {
    expect(SRC).toContain(
      'err instanceof AuthError ? err.userMessage : "Verification failed."',
    );
  });

  it("still imports AuthError from @workspace/resupply-auth-react", () => {
    expect(SRC).toContain("AuthError");
    expect(SRC).toMatch(
      /import\s*\{[^}]*AuthError[^}]*\}\s*from\s*["']@workspace\/resupply-auth-react["']/,
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: core form logic intact after refactor
// ---------------------------------------------------------------------------
describe("admin/sign-in — core form logic intact", () => {
  it("still calls signIn.mutate with email and password", () => {
    expect(SRC).toContain("signIn.mutate(");
    expect(SRC).toContain("email: email.trim()");
    expect(SRC).toContain("password");
  });

  it("still redirects to /admin on successful sign-in", () => {
    expect(SRC).toContain('"/admin"');
  });

  it("still advances to MFA step when mfaRequired is true", () => {
    expect(SRC).toContain("result.mfaRequired");
    expect(SRC).toContain('kind: "mfa"');
  });

  it("still calls verifyMfa.mutate in the MFA step", () => {
    expect(SRC).toContain("verifyMfa.mutate(");
  });

  it("links to /admin/forgot-password", () => {
    expect(SRC).toContain("/admin/forgot-password");
  });

  it("handles mfa_challenge_expired by resetting to the password step", () => {
    expect(SRC).toContain("mfa_challenge_expired");
    expect(SRC).toContain('kind: "password"');
  });
});