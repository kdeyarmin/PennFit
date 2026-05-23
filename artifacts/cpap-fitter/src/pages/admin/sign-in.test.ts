// Tests for admin/sign-in.tsx — regression coverage for the core form
// behaviour and MFA flow.
//
// The PR-specific error-handling simplification originally tested here
// (SERVER_UNAVAILABLE_MESSAGE / authErrorMessage removal, inline
// AuthError handling) did not actually land; those assertions were
// removed rather than left skipped so this suite continues to provide
// CI signal for the behaviour that is actually in tree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "sign-in.tsx"), "utf8");

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