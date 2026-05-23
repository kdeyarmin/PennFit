// Tests for pages/forgot-password.tsx (customer shop forgot-password page)
//
// PR changes verified here:
//   * submitError state removed — no error banner is ever shown.
//   * AuthError import removed — no error-type inspection.
//   * The 5xx-specific "credentials store right now" copy removed.
//   * Complex onSuccess + onError replaced by a single
//     `onSettled: () => setDone(true)`.
//   * No-enumeration contract preserved: always renders success on settlement.
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
describe("pages/forgot-password — submitError state removed", () => {
  it("does not declare a submitError state variable", () => {
    expect(SRC).not.toContain("submitError");
    expect(SRC).not.toContain("setSubmitError");
  });

  it("does not render an error banner", () => {
    // Old code rendered a <p role="alert"> with the error message
    expect(SRC).not.toContain('role="alert"');
  });
});

// ---------------------------------------------------------------------------
// Removed: AuthError import and 5xx-specific handling
// ---------------------------------------------------------------------------
describe("pages/forgot-password — AuthError special-casing removed", () => {
  it("does not import AuthError", () => {
    expect(SRC).not.toContain("AuthError");
  });

  it("does not contain credentials-store unavailability copy", () => {
    expect(SRC).not.toContain("credentials store right now");
  });

  it("does not reference status.pennpaps.com", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });

  it("does not contain a 5xx branch (err.status >= 500)", () => {
    expect(SRC).not.toContain("err.status >= 500");
    expect(SRC).not.toContain(">= 500");
  });
});

// ---------------------------------------------------------------------------
// Removed: separate onSuccess / onError handlers
// ---------------------------------------------------------------------------
describe("pages/forgot-password — separate onSuccess/onError removed", () => {
  it("does not use separate onSuccess and onError callbacks", () => {
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
describe("pages/forgot-password — onSettled always shows success", () => {
  it("uses onSettled to set the done flag", () => {
    expect(SRC).toContain("onSettled: () => setDone(true)");
  });

  it("passes the trimmed email to forgot.mutate", () => {
    expect(SRC).toContain("email: email.trim()");
  });

  it("declares the done state flag", () => {
    expect(SRC).toContain("const [done, setDone] = useState(false)");
  });
});

// ---------------------------------------------------------------------------
// Regression: core no-enumeration UX intact
// ---------------------------------------------------------------------------
describe("pages/forgot-password — no-enumeration UX intact", () => {
  it("still renders the success message when done is true", () => {
    expect(SRC).toContain(
      "If an account exists for that email, we\u0027ve sent a link",
    );
  });

  it("links back to the sign-in page", () => {
    expect(SRC).toContain("sign-in");
  });

  it("disables the submit button while the mutation is pending", () => {
    expect(SRC).toContain("disabled={forgot.isPending}");
  });

  it("imports authHooks from the shop auth-hooks module", () => {
    expect(SRC).toContain('from "@/lib/auth-hooks"');
  });

  it("uses AuthLayout with customer variant", () => {
    expect(SRC).toContain('variant="customer"');
  });
});