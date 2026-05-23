// Tests for the patient (shop) forgot-password page.
//
// This PR simplified ForgotPasswordPage (non-admin variant) by:
//   1. Replacing the onSuccess/onError pair with a single onSettled so the
//      page always shows the "we sent a link" state on settlement.
//   2. Removing the 5xx-specific SERVER_UNAVAILABLE_MESSAGE and error state.
//   3. Removing the AuthError import.
//
// The no-enumeration contract is preserved: the user always sees the same
// success message regardless of whether the email exists or the server errors.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "forgot-password.tsx"), "utf8");

describe("patient ForgotPasswordPage — onSettled (not onSuccess/onError)", () => {
  it("uses onSettled to transition to the done state", () => {
    expect(SRC).toContain("onSettled");
    expect(SRC).toContain("setDone(true)");
  });

  it("passes onSettled inline on the mutate call", () => {
    expect(SRC).toContain("onSettled: () => setDone(true)");
  });
});

describe("patient ForgotPasswordPage — 5xx error handling removed", () => {
  it("does not import AuthError", () => {
    expect(SRC).not.toContain("AuthError");
  });

  it("does not have a submitError state variable", () => {
    expect(SRC).not.toContain("submitError");
    expect(SRC).not.toContain("setSubmitError");
  });

  it("does not contain server-unavailable messaging", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
    expect(SRC).not.toContain("credentials store");
  });

  it("does not render an error alert element", () => {
    expect(SRC).not.toContain('role="alert"');
  });
});

describe("patient ForgotPasswordPage — no-enumeration contract preserved", () => {
  it("shows success copy about sending a reset link", () => {
    expect(SRC).toContain("we've sent a link to reset");
  });

  it("links back to sign-in", () => {
    expect(SRC).toContain("/sign-in");
  });
});

describe("patient ForgotPasswordPage — core structure intact", () => {
  it("exports ForgotPasswordPage as a named export", () => {
    expect(SRC).toContain("export function ForgotPasswordPage");
  });

  it("uses authHooks.useForgotPassword()", () => {
    expect(SRC).toContain("authHooks.useForgotPassword()");
  });

  it("renders an email input field", () => {
    expect(SRC).toContain('type="email"');
  });

  it("renders the send reset link button", () => {
    expect(SRC).toContain("Send reset link");
  });

  it("renders with AuthLayout", () => {
    expect(SRC).toContain("AuthLayout");
  });
});