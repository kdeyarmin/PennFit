// Static analysis tests for pages/forgot-password.tsx (storefront variant)
//
// PR changes:
//   * Switched from separate `onSuccess` + `onError` handlers to a single
//     `onSettled: () => setDone(true)`. The server returns 200 regardless
//     of whether the email matches an account — the client should always
//     show the "check your email" state after the form is submitted.
//   * Removed the 5xx special case and the `submitError` state/banner.
//   * Removed the `AuthError` import (was only needed for the 5xx branch).
//
// The component uses React hooks and cannot be rendered in the node vitest
// environment without jsdom. We read the source file as a string and assert
// the structural invariants that matter.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "forgot-password.tsx"), "utf8");

describe("forgot-password — onSettled always transitions to success state", () => {
  it("uses onSettled so any outcome (success or error) marks the form done", () => {
    expect(SRC).toContain("onSettled: () => setDone(true)");
  });

  it("does NOT split success and error into separate callbacks", () => {
    // The previous pattern had onSuccess + onError; the new one uses only
    // onSettled. This guards against accidentally re-adding the split.
    expect(SRC).not.toMatch(/onSuccess:\s*\(\)\s*=>\s*setDone/);
    expect(SRC).not.toContain("onError:");
  });
});

describe("forgot-password — AuthError removed (5xx special case gone)", () => {
  it("does NOT import AuthError", () => {
    expect(SRC).not.toContain("AuthError");
  });

  it("does NOT import from @workspace/resupply-auth-react", () => {
    expect(SRC).not.toContain("resupply-auth-react");
  });
});

describe("forgot-password — no submitError state or error banner", () => {
  it("does NOT declare a submitError state variable", () => {
    expect(SRC).not.toContain("submitError");
  });

  it("does NOT render an error alert below the submit button", () => {
    expect(SRC).not.toMatch(/role="alert"/);
  });
});

describe("forgot-password — core form behaviour intact", () => {
  it("calls forgot.mutate with the trimmed email address", () => {
    expect(SRC).toContain("forgot.mutate");
    expect(SRC).toContain("email.trim()");
  });

  it("tracks submission state with a 'done' boolean", () => {
    expect(SRC).toContain("setDone(true)");
  });

  it("links back to the shop sign-in page", () => {
    expect(SRC).toContain("/sign-in");
  });
});