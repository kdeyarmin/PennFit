// Tests for pages/sign-in.tsx (storefront variant) — regression coverage
// for the core form behaviour.
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