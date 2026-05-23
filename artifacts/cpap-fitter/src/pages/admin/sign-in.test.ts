// Static analysis tests for pages/admin/sign-in.tsx
//
// PR changes:
//   * Removed the `authErrorMessage()` helper function and the
//     `SERVER_UNAVAILABLE_MESSAGE` constant — the 5xx credentials-store
//     special-case is gone. Both the password step and the MFA step now
//     use the same inline pattern:
//       `err instanceof AuthError ? err.userMessage : "<fallback>"`
//   * The two `setSubmitError(authErrorMessage(...))` call sites were
//     inlined accordingly.
//
// The component uses React hooks and cannot be rendered in the node vitest
// environment without jsdom. We read the source file as a string and assert
// the structural invariants that matter.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "sign-in.tsx"), "utf8");

describe("admin/sign-in — authErrorMessage helper removed", () => {
  it("does NOT define the authErrorMessage helper function", () => {
    expect(SRC).not.toContain("function authErrorMessage");
  });

  it("does NOT reference authErrorMessage anywhere", () => {
    expect(SRC).not.toContain("authErrorMessage");
  });
});

describe("admin/sign-in — SERVER_UNAVAILABLE_MESSAGE constant removed", () => {
  it("does NOT declare SERVER_UNAVAILABLE_MESSAGE", () => {
    // The 5xx credentials-store copy ("We can't reach the credentials store…")
    // has been removed; the inline AuthError.userMessage handles all error cases.
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does NOT contain the 'status.pennpaps.com' status page reference", () => {
    // The status-page link was part of the now-removed 5xx copy.
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

describe("admin/sign-in — inline error handling pattern", () => {
  it("uses the direct AuthError instanceof check for the password step", () => {
    // Both sign-in steps now use the inline ternary instead of the helper.
    expect(SRC).toContain(
      "err instanceof AuthError ? err.userMessage : \"Sign-in failed.\"",
    );
  });

  it("uses the direct AuthError instanceof check for the MFA step", () => {
    expect(SRC).toContain(
      "err instanceof AuthError ? err.userMessage : \"Verification failed.\"",
    );
  });

  it("still imports AuthError (needed for the inline instanceof checks and MFA challenge routing)", () => {
    expect(SRC).toContain("AuthError");
    expect(SRC).toContain("resupply-auth-react");
  });
});

describe("admin/sign-in — core sign-in behaviour unchanged", () => {
  it("still calls signIn.mutate with email and password", () => {
    expect(SRC).toContain("signIn.mutate");
    expect(SRC).toContain("email.trim()");
    expect(SRC).toContain("password");
  });

  it("still redirects to /admin on success", () => {
    expect(SRC).toContain('"/admin"');
  });

  it("still exports SignInPage as a named export", () => {
    expect(SRC).toContain("export function SignInPage");
  });

  it("still has the MFA step (two-step flow preserved)", () => {
    expect(SRC).toContain("challengeToken");
    expect(SRC).toContain("verifyMfa");
  });

  it("still routes expired/invalid MFA challenges back to the password step", () => {
    expect(SRC).toContain("mfa_challenge_expired");
    expect(SRC).toContain("mfa_challenge_invalid");
  });
});