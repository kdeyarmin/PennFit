// Static analysis tests for pages/sign-in.tsx (storefront variant)
//
// PR changes:
//   * Removed the `authErrorMessage()` helper function and the
//     `SERVER_UNAVAILABLE_MESSAGE` constant. The sign-in onError now
//     uses the inline pattern:
//       `err instanceof AuthError ? err.userMessage : "Sign-in failed."`
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

describe("sign-in — authErrorMessage helper removed", () => {
  it("does NOT define the authErrorMessage helper function", () => {
    expect(SRC).not.toContain("function authErrorMessage");
  });

  it("does NOT call authErrorMessage anywhere", () => {
    expect(SRC).not.toContain("authErrorMessage");
  });
});

describe("sign-in — SERVER_UNAVAILABLE_MESSAGE constant removed", () => {
  it("does NOT declare SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does NOT contain the 'status.pennpaps.com' status-page reference", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

describe("sign-in — inline error handling pattern", () => {
  it("uses an inline AuthError instanceof check in the onError handler", () => {
    expect(SRC).toContain(
      "err instanceof AuthError ? err.userMessage : \"Sign-in failed.\"",
    );
  });

  it("still imports AuthError for the instanceof check", () => {
    expect(SRC).toContain("AuthError");
  });
});

describe("sign-in — core form behaviour unchanged", () => {
  it("still calls signIn.mutate with email and password", () => {
    expect(SRC).toContain("signIn.mutate");
    expect(SRC).toContain("email.trim()");
  });

  it("still redirects to /account on success", () => {
    expect(SRC).toContain("/account");
  });

  it("still exports SignInPage as a named export", () => {
    expect(SRC).toContain("export function SignInPage");
  });

  it("still supports the ?reset=success success banner", () => {
    expect(SRC).toContain("reset");
    expect(SRC).toContain("signin-reset-success");
  });

  it("still supports the ?verified=success success banner", () => {
    expect(SRC).toContain("verified");
    expect(SRC).toContain("signin-verified-success");
  });
});