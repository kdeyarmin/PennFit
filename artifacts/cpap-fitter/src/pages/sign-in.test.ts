// Tests for the patient (shop) sign-in page.
//
// This PR removed the SERVER_UNAVAILABLE_MESSAGE constant and the
// authErrorMessage() helper function that classified 5xx errors.
// Error handling is now inlined:
//   err instanceof AuthError ? err.userMessage : "Sign-in failed."
//
// Tests verify the removal and that the inline pattern is in place.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "sign-in.tsx"), "utf8");

describe("patient SignInPage — authErrorMessage helper removed", () => {
  it("does not define an authErrorMessage helper function", () => {
    expect(SRC).not.toContain("function authErrorMessage");
    expect(SRC).not.toContain("authErrorMessage(");
  });

  it("does not define a SERVER_UNAVAILABLE_MESSAGE constant", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does not include credentials-store-unavailable messaging", () => {
    expect(SRC).not.toContain("credentials store");
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

describe("patient SignInPage — inline error handling", () => {
  it("uses inline instanceof AuthError check for error messages", () => {
    expect(SRC).toContain("err instanceof AuthError ? err.userMessage");
  });

  it("falls back to 'Sign-in failed.' for non-AuthError throws", () => {
    expect(SRC).toContain('"Sign-in failed."');
  });

  it("still imports AuthError for the inline check", () => {
    expect(SRC).toContain("AuthError");
    expect(SRC).toContain("import");
  });
});

describe("patient SignInPage — core structure intact", () => {
  it("exports SignInPage as a named export", () => {
    expect(SRC).toContain("export function SignInPage");
  });

  it("calls authHooks.useSignIn()", () => {
    expect(SRC).toContain("authHooks.useSignIn()");
  });

  it("redirects to /account on success", () => {
    expect(SRC).toContain("/account");
  });

  it("reads the post-redirect success flag from URL", () => {
    expect(SRC).toContain("readSuccessFlag");
  });
});