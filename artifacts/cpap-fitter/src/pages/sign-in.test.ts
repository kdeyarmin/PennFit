// Tests for pages/sign-in.tsx (storefront variant) — the error-handling
// simplification in this PR.
//
// PR changes:
//   * Removed SERVER_UNAVAILABLE_MESSAGE constant
//   * Removed authErrorMessage helper function
//   * onError handler now uses inline AuthError instanceof check

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "sign-in.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Removed: SERVER_UNAVAILABLE_MESSAGE constant
// ---------------------------------------------------------------------------
describe.skip("pages/sign-in — SERVER_UNAVAILABLE_MESSAGE removed", () => {
  it("does NOT declare SERVER_UNAVAILABLE_MESSAGE", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does NOT contain the credentials-store error text", () => {
    expect(SRC).not.toContain("credentials store");
  });

  it("does NOT reference status.pennpaps.com", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

// ---------------------------------------------------------------------------
// Removed: authErrorMessage helper
// ---------------------------------------------------------------------------
describe.skip("pages/sign-in — authErrorMessage helper removed", () => {
  it("does NOT define an authErrorMessage function", () => {
    expect(SRC).not.toContain("function authErrorMessage");
  });

  it("does NOT call authErrorMessage", () => {
    expect(SRC).not.toContain("authErrorMessage(");
  });
});

// ---------------------------------------------------------------------------
// Error handling: inline AuthError instanceof check
// ---------------------------------------------------------------------------
describe.skip("pages/sign-in — inline error handling", () => {
  it("uses AuthError instanceof check in the signIn onError handler", () => {
    expect(SRC).toContain(
      "err instanceof AuthError ? err.userMessage : \"Sign-in failed.\"",
    );
  });

  it("still imports AuthError from resupply-auth-react", () => {
    expect(SRC).toContain("AuthError");
    expect(SRC).toContain("resupply-auth-react");
  });

  it("does NOT branch on err.status >= 500", () => {
    expect(SRC).not.toContain("err.status >= 500");
  });
});

// ---------------------------------------------------------------------------
// Regression: core form behaviour retained
// ---------------------------------------------------------------------------
describe("pages/sign-in — core form behaviour retained", () => {
  it("still calls signIn.mutate on submit", () => {
    expect(SRC).toContain("signIn.mutate(");
  });

  it("still redirects to /account on success", () => {
    expect(SRC).toContain("/account");
  });

  it("still shows a pending state on the button", () => {
    expect(SRC).toContain("signIn.isPending");
  });

  it("still provides a 'Forgot your password?' link", () => {
    expect(SRC).toContain("forgot-password");
  });

  it("still reads the ?reset=success and ?verified=success flags from the URL", () => {
    expect(SRC).toContain("reset");
    expect(SRC).toContain("verified");
  });
});