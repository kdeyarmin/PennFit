// Tests for pages/sign-in.tsx (customer shop sign-in page)
//
// PR changes verified here:
//   * SERVER_UNAVAILABLE_MESSAGE constant removed — no credentials-store
//     unavailability copy in the shop sign-in page.
//   * authErrorMessage() helper function removed.
//   * Error handling now uses:
//       err instanceof AuthError ? err.userMessage : "Sign-in failed."
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
describe("pages/sign-in — SERVER_UNAVAILABLE_MESSAGE removed", () => {
  it("does not define SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does not contain credentials-store unavailability copy", () => {
    expect(SRC).not.toContain("credentials store right now");
  });

  it("does not reference status.pennpaps.com in an error message", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

// ---------------------------------------------------------------------------
// Removed: authErrorMessage helper function
// ---------------------------------------------------------------------------
describe("pages/sign-in — authErrorMessage function removed", () => {
  it("does not define an authErrorMessage function", () => {
    expect(SRC).not.toContain("function authErrorMessage");
    expect(SRC).not.toContain("authErrorMessage(");
  });

  it("does not contain a 5xx branch (err.status >= 500)", () => {
    expect(SRC).not.toContain("err.status >= 500");
    expect(SRC).not.toContain(">= 500");
  });
});

// ---------------------------------------------------------------------------
// Current: inline AuthError-aware error message
// ---------------------------------------------------------------------------
describe("pages/sign-in — inline AuthError error handling", () => {
  it("uses AuthError instanceof check in onError", () => {
    expect(SRC).toContain(
      'err instanceof AuthError ? err.userMessage : "Sign-in failed."',
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
describe("pages/sign-in — core form logic intact", () => {
  it("calls signIn.mutate with email and password", () => {
    expect(SRC).toContain("signIn.mutate(");
    expect(SRC).toContain("email: email.trim()");
  });

  it("redirects to /account on success", () => {
    expect(SRC).toContain('"/account"');
  });

  it("shows success banner for ?reset=success redirect", () => {
    expect(SRC).toContain("reset");
    expect(SRC).toContain("Your password has been updated");
  });

  it("shows success banner for ?verified=success redirect", () => {
    expect(SRC).toContain("verified");
    expect(SRC).toContain("Your email is verified");
  });

  it("links to the forgot-password page", () => {
    expect(SRC).toContain("forgot-password");
  });

  it("imports authHooks from the shop auth-hooks module", () => {
    expect(SRC).toContain('from "@/lib/auth-hooks"');
  });
});
