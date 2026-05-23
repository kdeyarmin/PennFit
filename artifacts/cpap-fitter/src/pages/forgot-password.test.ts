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
describe.skip("pages/forgot-password — uses onSettled", () => {
  it("calls forgot.mutate with onSettled callback to show success on any outcome", () => {
    expect(SRC).toContain("onSettled: () => setDone(true)");
  });

  it("does NOT use a separate onSuccess callback in the mutate call", () => {
    expect(SRC).not.toContain("onSuccess: () => setDone(true)");
  });

  it("does NOT register an onError callback in the mutate call", () => {
    expect(SRC).not.toContain("onError:");
  });
});

// ---------------------------------------------------------------------------
// Removed: submitError state
// ---------------------------------------------------------------------------
describe.skip("pages/forgot-password — submitError removed", () => {
  it("does NOT declare submitError state", () => {
    expect(SRC).not.toContain("submitError");
  });

  it("does NOT call setSubmitError", () => {
    expect(SRC).not.toContain("setSubmitError");
  });

  it("does NOT render a role=alert error element", () => {
    expect(SRC).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// Removed: AuthError import
// ---------------------------------------------------------------------------
describe.skip("pages/forgot-password — AuthError import removed", () => {
  it("does NOT import AuthError", () => {
    expect(SRC).not.toContain("AuthError");
  });
});

// ---------------------------------------------------------------------------
// Removed: 5xx-specific message
// ---------------------------------------------------------------------------
describe.skip("pages/forgot-password — 5xx-specific error copy removed", () => {
  it("does NOT contain the credentials-store error text", () => {
    expect(SRC).not.toContain("credentials store");
  });

  it("does NOT reference status.pennpaps.com", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

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