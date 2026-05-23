// Tests for the admin forgot-password page.
//
// This PR simplified the ForgotPasswordPage by:
//   1. Replacing onSuccess/onError handlers with a single onSettled callback
//      so the page transitions to "done" state regardless of server outcome.
//   2. Removing the 5xx-specific error handling and submitError state.
//   3. Removing the AuthError import (no longer needed for error classification).
//
// All changes preserve the no-enumeration contract: the user always sees the
// same success message, whether the email exists or not, or even if the
// server returns an error.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "forgot-password.tsx"), "utf8");

describe("admin ForgotPasswordPage — onSettled (not onSuccess/onError)", () => {
  it("uses onSettled to set done=true", () => {
    expect(SRC).toContain("onSettled");
    expect(SRC).toContain("setDone(true)");
  });

  it("does not use separate onSuccess callback for this mutation", () => {
    // The simplified form uses a single onSettled.
    // We check that the old dual-callback pattern is gone.
    // Note: onSuccess may appear elsewhere in the file (other hooks), so we
    // check specifically that the forgot.mutate call block uses onSettled.
    expect(SRC).toContain("onSettled: () => setDone(true)");
  });
});

describe("admin ForgotPasswordPage — no 5xx special-case error handling", () => {
  it("does not import AuthError", () => {
    // AuthError was only imported for the 5xx-classification guard; removing
    // that guard means AuthError is no longer needed here.
    expect(SRC).not.toContain('import { AuthError }');
    expect(SRC).not.toContain("AuthError");
  });

  it("does not have a submitError state variable", () => {
    expect(SRC).not.toContain("submitError");
    expect(SRC).not.toContain("setSubmitError");
  });

  it("does not render an error alert element", () => {
    expect(SRC).not.toContain('role="alert"');
  });
});

describe("admin ForgotPasswordPage — no-enumeration contract preserved", () => {
  it("renders a success message after submission (done state)", () => {
    // The success state copy must still be present.
    expect(SRC).toContain("we've sent a link to reset");
  });

  it("links back to /admin/sign-in", () => {
    expect(SRC).toContain("/admin/sign-in");
  });
});

describe("admin ForgotPasswordPage — core structure intact", () => {
  it("exports ForgotPasswordPage as a named export", () => {
    expect(SRC).toContain("export function ForgotPasswordPage");
  });

  it("uses authHooks.useForgotPassword()", () => {
    expect(SRC).toContain("authHooks.useForgotPassword()");
  });

  it("still shows form with email input when not done", () => {
    expect(SRC).toContain('type="email"');
    expect(SRC).toContain("Send reset link");
  });
});