// Tests for admin/sign-in.tsx.
//
// Auth error handling is delegated to the shared `authErrorMessage`
// helper from @workspace/resupply-auth-react. The MFA challenge-
// expiry branch is still handled separately because it changes UI
// state (resets to the password step), not just the message.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "sign-in.tsx"), "utf8");

describe("admin/sign-in — uses shared authErrorMessage helper", () => {
  it("imports authErrorMessage from @workspace/resupply-auth-react", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*authErrorMessage[^}]*\}\s*from\s*"@workspace\/resupply-auth-react"/,
    );
  });

  it("uses the helper in the password-step onError", () => {
    expect(SRC).toContain('action: "sign you in"');
    expect(SRC).toContain('subject: "password"');
    expect(SRC).toContain('fallback: "Sign-in failed."');
  });

  it("uses the helper in the MFA-step onError", () => {
    expect(SRC).toContain('action: "verify it\'s you"');
    expect(SRC).toContain('subject: "code"');
    expect(SRC).toContain('fallback: "Verification failed."');
  });

  it("does NOT declare its own SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does NOT define a local authErrorMessage helper function", () => {
    expect(SRC).not.toMatch(/function\s+authErrorMessage/);
  });

  it("does NOT inline the credentials-store copy", () => {
    expect(SRC).not.toContain("credentials store");
  });

  it("does NOT reference status.pennpaps.com directly", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });

  it("does NOT branch on err.status >= 500 itself", () => {
    expect(SRC).not.toContain("err.status >= 500");
  });
});

describe("admin/sign-in — MFA challenge expired still handled separately", () => {
  it("checks for mfa_challenge_expired code to reset to password step", () => {
    expect(SRC).toContain("mfa_challenge_expired");
  });

  it("checks for mfa_challenge_invalid code too", () => {
    expect(SRC).toContain("mfa_challenge_invalid");
  });

  it("still imports AuthError (for the MFA expiry instanceof check)", () => {
    expect(SRC).toContain("AuthError");
  });
});

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
