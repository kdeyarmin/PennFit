// Tests for admin/forgot-password.tsx
//
// PR changes verified here:
//   * submitError state removed — no error banner is ever shown.
//   * AuthError import removed — the file no longer inspects error codes.
//   * The 5xx-specific "credentials store right now" copy removed.
//   * onSuccess + onError handlers replaced by a single onSettled
//     callback: `onSettled: () => setDone(true)`.
//   * No-enumeration contract preserved: success state renders
//     regardless of server outcome.
//
// The component uses React which cannot be rendered in the node vitest
// environment without jsdom. We read the source file as a string and
// assert on the structural invariants.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "forgot-password.tsx"), "utf8");

// ---------------------------------------------------------------------------
// Removed: submitError state and error banner
// ---------------------------------------------------------------------------
describe("admin/forgot-password — submitError state removed", () => {
  it("does not declare a submitError state variable", () => {
    expect(SRC).not.toContain("submitError");
    expect(SRC).not.toContain("setSubmitError");
  });

  it("does not render an error banner", () => {
    // Old code rendered a <p role="alert"> with submitError content
    expect(SRC).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// Removed: AuthError import and 5xx-specific handling
// ---------------------------------------------------------------------------
describe("admin/forgot-password — AuthError special-casing removed", () => {
  it("does not import AuthError", () => {
    expect(SRC).not.toContain("AuthError");
  });

  it("does not contain credentials-store unavailability copy", () => {
    expect(SRC).not.toContain("credentials store right now");
  });

  it("does not contain status.pennpaps.com reference", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

// ---------------------------------------------------------------------------
// Removed: separate onSuccess / onError handlers
// ---------------------------------------------------------------------------
describe("admin/forgot-password — separate onSuccess/onError removed", () => {
  it("does not use onSuccess callback on the mutation", () => {
    // onSettled replaces the onSuccess + onError pair
    // (onSettled is present, so onSuccess must not appear in this context)
    const mutateIdx = SRC.indexOf("forgot.mutate(");
    expect(mutateIdx).toBeGreaterThanOrEqual(0);
    const snippet = SRC.slice(mutateIdx, mutateIdx + 300);
    expect(snippet).not.toContain("onSuccess");
    expect(snippet).not.toContain("onError");
  });
});

// ---------------------------------------------------------------------------
// Current: onSettled always renders success state
// ---------------------------------------------------------------------------
describe("admin/forgot-password — onSettled always shows success", () => {
  it("uses onSettled to set the done flag", () => {
    expect(SRC).toContain("onSettled: () => setDone(true)");
  });

  it("calls forgot.mutate with the trimmed email and the onSettled option", () => {
    expect(SRC).toContain("email: email.trim()");
    expect(SRC).toContain("onSettled");
  });

  it("declares the done state flag", () => {
    expect(SRC).toContain("const [done, setDone] = useState(false)");
  });
});

// ---------------------------------------------------------------------------
// Regression: core no-enumeration UX intact
// ---------------------------------------------------------------------------
describe("admin/forgot-password — no-enumeration UX intact", () => {
  it("still renders the success message when done is true", () => {
    expect(SRC).toContain(
      "If an account exists for that email, we\u0027ve sent a link",
    );
  });

  it("links back to /admin/sign-in", () => {
    expect(SRC).toContain("/admin/sign-in");
  });

  it("disables the submit button while the mutation is pending", () => {
    expect(SRC).toContain("disabled={forgot.isPending}");
  });

  it("imports authHooks from the admin auth-hooks module", () => {
    expect(SRC).toContain('from "@/lib/admin/auth-hooks"');
  });
});