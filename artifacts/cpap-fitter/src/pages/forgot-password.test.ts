// Tests for pages/forgot-password.tsx (storefront variant) — the
// onSettled simplification in this PR.
//
// PR changes:
//   * Uses `onSettled` instead of separate `onSuccess` / `onError` branches
//   * Removed `submitError` state (no 5xx-specific error copy)
//   * Removed `AuthError` import
//   * Removed error UI element

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "forgot-password.tsx"), "utf8");

// ---------------------------------------------------------------------------
// onSettled — new always-render-success contract
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Removed: submitError state
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Removed: AuthError import
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Removed: 5xx-specific message
// ---------------------------------------------------------------------------

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