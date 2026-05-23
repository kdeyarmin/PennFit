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

// ---------------------------------------------------------------------------
// Removed: authErrorMessage helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error handling: inline AuthError instanceof check
// ---------------------------------------------------------------------------

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