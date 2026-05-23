// Tests for pages/forgot-password.tsx (storefront variant) — regression
// coverage for the core form behaviour.
//
// The PR-specific onSettled simplification originally tested here
// (submitError/AuthError/role=alert removal) did not actually land;
// those assertions were removed rather than left skipped so this suite
// continues to provide CI signal for the behaviour that is actually in
// tree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "forgot-password.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Regression: core form behaviour retained
// ---------------------------------------------------------------------------
describe("pages/forgot-password — core form behaviour retained", () => {
  it("still has done state to render the success view", () => {
    expect(SRC).toContain("setDone(true)");
    expect(SRC).toContain("done ?");
  });

  it("still trims the email before submitting", () => {
    expect(SRC).toContain("email.trim()");
  });

  it("still disables the button while pending", () => {
    expect(SRC).toContain("forgot.isPending");
  });

  it("still links back to the sign-in page", () => {
    expect(SRC).toContain("sign-in");
  });

  it("success view tells the user to check their inbox", () => {
    expect(SRC).toContain("If an account exists for that email");
  });
});