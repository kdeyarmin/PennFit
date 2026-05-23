// Tests for the admin sign-in page.
//
// This PR removed the SERVER_UNAVAILABLE_MESSAGE constant and the
// authErrorMessage() helper function. Error handling is now inlined:
//   err instanceof AuthError ? err.userMessage : "Sign-in failed."
//
// The helper was shared between sign-in and MFA step — both paths now
// use the inline pattern.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "sign-in.tsx"), "utf8");

describe("admin SignInPage — authErrorMessage helper removed", () => {
  it("does not define an authErrorMessage helper function", () => {
    expect(SRC).not.toContain("function authErrorMessage");
    expect(SRC).not.toContain("authErrorMessage(");
  });

  it("does not define a SERVER_UNAVAILABLE_MESSAGE constant", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does not include the credentials-store-unavailable user message", () => {
    expect(SRC).not.toContain("credentials store");
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

describe("admin SignInPage — inline error handling", () => {
  it("uses inline instanceof AuthError check for password step errors", () => {
    expect(SRC).toContain("err instanceof AuthError ? err.userMessage");
  });

  it("falls back to a static string when err is not an AuthError", () => {
    // Password step fallback
    expect(SRC).toContain('"Sign-in failed."');
  });

  it("still imports AuthError (needed for MFA error classification)", () => {
    expect(SRC).toContain("AuthError");
    expect(SRC).toContain("import");
  });
});

describe("admin SignInPage — core structure intact", () => {
  it("exports SignInPage as a named export", () => {
    expect(SRC).toContain("export function SignInPage");
  });

  it("still supports two-step MFA flow", () => {
    expect(SRC).toContain("mfa");
    expect(SRC).toContain("challengeToken");
  });

  it("still calls authHooks.useSignIn()", () => {
    expect(SRC).toContain("authHooks.useSignIn()");
  });

  it("password step: calls signIn.mutate with email and password", () => {
    expect(SRC).toContain("signIn.mutate(");
  });

  it("MFA step: calls verifyMfa.mutate", () => {
    expect(SRC).toContain("verifyMfa.mutate");
  });
});