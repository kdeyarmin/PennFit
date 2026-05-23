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

// ---------------------------------------------------------------------------
// Removed: submitError state
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Removed: AuthError import
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Removed: 5xx-specific server-unavailable message
// ---------------------------------------------------------------------------

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
    expect(SRC).toContain('href={`${basePath}/sign-in`}');
  });

  it("success view tells the user to check their inbox", () => {
    expect(SRC).toContain("If an account exists for that email");
  });
});