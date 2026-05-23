// Tests for admin/sign-in.tsx — the error-handling simplification in this PR.
//
// PR changes:
//   * Removed SERVER_UNAVAILABLE_MESSAGE constant
//   * Removed authErrorMessage helper function
//   * Both onError handlers now use inline AuthError instanceof check

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
  it("does NOT declare SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does NOT contain the credentials-store-unavailable message text", () => {
    expect(SRC).not.toContain("credentials store");
  });

  it("does NOT reference status.pennpaps.com", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

// ---------------------------------------------------------------------------
// Removed: authErrorMessage helper
// ---------------------------------------------------------------------------
describe("admin/sign-in — authErrorMessage helper function removed", () => {
  it("does NOT define an authErrorMessage function", () => {
    expect(SRC).not.toContain("function authErrorMessage");
  });

  it("does NOT call authErrorMessage", () => {
    expect(SRC).not.toContain("authErrorMessage(");
  });
});

// ---------------------------------------------------------------------------
// Error handling: inline AuthError instanceof checks
// ---------------------------------------------------------------------------
describe("admin/sign-in — inline error handling", () => {
  it("uses AuthError instanceof check in password-step onError", () => {
    expect(SRC).toContain(
      "err instanceof AuthError ? err.userMessage : \"Sign-in failed.\"",
    );
  });

  it("uses AuthError instanceof check in MFA-step onError", () => {
    expect(SRC).toContain(
      "err instanceof AuthError ? err.userMessage : \"Verification failed.\"",
    );
  });

  it("still imports AuthError from resupply-auth-react", () => {
    expect(SRC).toContain("AuthError");
    expect(SRC).toContain("resupply-auth-react");
  });

  it("does NOT check err.status >= 500 in onError handlers", () => {
    // The old code had `if (err instanceof AuthError && err.status >= 500)`
    expect(SRC).not.toContain("err.status >= 500");
  });
});

// ---------------------------------------------------------------------------
// MFA challenge expiry — still handles mfa_challenge_expired
// ---------------------------------------------------------------------------
describe("admin/sign-in — MFA challenge expired still handled separately", () => {
  it("checks for mfa_challenge_expired code to reset to password step", () => {
    expect(SRC).toContain("mfa_challenge_expired");
  });

  it("checks for mfa_challenge_invalid code too", () => {
    expect(SRC).toContain("mfa_challenge_invalid");
  });
});

// ---------------------------------------------------------------------------
// Regression: core form behaviour retained
// ---------------------------------------------------------------------------
describe("admin/sign-in — core form behaviour retained", () => {
  it("still calls signIn.mutate on password-step submit", () => {
    expect(SRC).toContain("signIn.mutate(");
  });

  it("still calls verifyMfa.mutate on MFA-step submit", () => {
    expect(SRC).toContain("verifyMfa.mutate(");
  });

  it("still redirects to /admin on successful sign-in", () => {
    expect(SRC).toContain('"/admin"');
  });

  it("still resets to password step on MFA challenge expiry", () => {
    expect(SRC).toContain(`setStep({ kind: "password" })`);
  });

  it("still provides a 'Forgot your password?' link", () => {
    expect(SRC).toContain("forgot-password");
  });
});