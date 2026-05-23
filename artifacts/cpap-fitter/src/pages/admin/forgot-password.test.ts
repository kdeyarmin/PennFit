// Tests for admin/forgot-password.tsx — the onSettled simplification in this PR.
//
// PR changes:
//   * Uses `onSettled` instead of separate `onSuccess` / `onError` branches
//   * Removed `submitError` state (no more 5xx-specific error copy)
//   * Removed `AuthError` import (no longer needed)
//   * No error UI element rendered
//   * Always shows the success state after the mutation settles

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "forgot-password.tsx"), "utf8");

// ---------------------------------------------------------------------------
// onSettled — new submission contract
// ---------------------------------------------------------------------------
describe("admin/forgot-password — uses onSettled for always-render-success contract", () => {
  it("calls forgot.mutate with onSettled callback", () => {
    expect(SRC).toContain("onSettled: () => setDone(true)");
  });

  it("does NOT use a separate onSuccess callback", () => {
    // The only callback should be onSettled — no standalone onSuccess.
    expect(SRC).not.toContain("onSuccess: () => setDone(true)");
  });

  it("does NOT use a separate onError callback in the forgot.mutate call", () => {
    expect(SRC).not.toContain("onError: (err)");
  });
});

// ---------------------------------------------------------------------------
// Removed: submitError state
// ---------------------------------------------------------------------------
describe("admin/forgot-password — submitError state removed", () => {
  it("does NOT declare submitError state", () => {
    expect(SRC).not.toContain("submitError");
  });

  it("does NOT call setSubmitError", () => {
    expect(SRC).not.toContain("setSubmitError");
  });

  it("does NOT render a role=alert error element", () => {
    // The old code rendered <p role="alert"> for 5xx errors.
    expect(SRC).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// Removed: AuthError import
// ---------------------------------------------------------------------------
describe("admin/forgot-password — AuthError import removed", () => {
  it("does NOT import AuthError", () => {
    expect(SRC).not.toContain("AuthError");
  });

  it("does NOT reference resupply-auth-react for error types", () => {
    // AuthError was the only import from resupply-auth-react in this file.
    expect(SRC).not.toContain("resupply-auth-react");
  });
});

// ---------------------------------------------------------------------------
// Removed: 5xx-specific server-unavailable message
// ---------------------------------------------------------------------------
describe("admin/forgot-password — 5xx server-unavailable copy removed", () => {
  it("does NOT contain the credentials-store-unavailable error message", () => {
    expect(SRC).not.toContain("credentials store");
  });

  it("does NOT reference status.pennpaps.com", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

// ---------------------------------------------------------------------------
// Regression: core form behaviour retained
// ---------------------------------------------------------------------------
describe("admin/forgot-password — core form behaviour retained", () => {
  it("still has done state to switch to the success view", () => {
    expect(SRC).toContain("setDone(true)");
    expect(SRC).toContain("done ?");
  });

  it("still trims the email before submitting", () => {
    expect(SRC).toContain("email.trim()");
  });

  it("still shows a pending state on the submit button", () => {
    expect(SRC).toContain("forgot.isPending");
  });

  it("still links back to the sign-in page", () => {
    expect(SRC).toContain("/admin/sign-in");
  });

  it("success view tells the user to check their inbox", () => {
    expect(SRC).toContain("If an account exists for that email");
  });
});