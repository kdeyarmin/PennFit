// Static analysis tests for pages/admin/forgot-password.tsx
//
// PR changes:
//   * Switched from separate `onSuccess` + `onError` handlers to a single
//     `onSettled: () => setDone(true)` — the server's "always 200, no
//     enumeration" contract means we never need to distinguish success from
//     failure at the client level. Any outcome (success, error, or network
//     problem) transitions to the "check your email" state.
//   * Removed the 5xx special case: previously a credentials-store error
//     would show a `submitError` banner pointing the user at status.pennpaps.com.
//     That copy and the `AuthError` import are both gone.
//   * Removed the `submitError` state and its associated error banner.
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

describe("admin/forgot-password — onSettled instead of onSuccess/onError", () => {
  it("uses onSettled to transition to the success state on any outcome", () => {
    expect(SRC).toContain("onSettled: () => setDone(true)");
  });

  it("does NOT use a separate onSuccess callback for the forgot mutation", () => {
    // Separate onSuccess would mean network errors leave the form stuck.
    // onSettled covers both success and error paths.
    expect(SRC).not.toMatch(/onSuccess:\s*\(\)\s*=>\s*setDone/);
  });

  it("does NOT use a separate onError callback for 5xx handling", () => {
    // The 5xx status-page redirect copy was removed — we fold everything
    // into onSettled to preserve the no-enumeration contract.
    expect(SRC).not.toContain("onError:");
  });
});

describe("admin/forgot-password — AuthError import removed", () => {
  it("does NOT import AuthError", () => {
    // AuthError was only needed for the 5xx branch; that branch is gone.
    expect(SRC).not.toContain("AuthError");
  });

  it("does NOT import from @workspace/resupply-auth-react", () => {
    expect(SRC).not.toContain("resupply-auth-react");
  });
});

describe("admin/forgot-password — submitError state removed", () => {
  it("does NOT declare a submitError state variable", () => {
    // submitError was used to surface the 5xx credentials-store-unreachable
    // banner. Since we no longer special-case 5xx, the state is unnecessary.
    expect(SRC).not.toContain("submitError");
  });

  it("does NOT render an error alert for the submit action", () => {
    // The only alert-like element is the success message, not an error banner.
    expect(SRC).not.toMatch(/role="alert"/);
  });
});

describe("admin/forgot-password — no-enumeration contract preserved", () => {
  it("still renders the success state (done=true) after form submission", () => {
    expect(SRC).toContain("setDone(true)");
    expect(SRC).toContain("done");
  });

  it("still calls forgot.mutate with the trimmed email", () => {
    expect(SRC).toContain("forgot.mutate");
    expect(SRC).toContain("email.trim()");
  });
});

describe("admin/forgot-password — link back to sign-in still present", () => {
  it("links back to /admin/sign-in", () => {
    expect(SRC).toContain("/admin/sign-in");
  });
});