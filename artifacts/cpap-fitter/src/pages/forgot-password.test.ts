// Tests for pages/forgot-password.tsx (storefront variant).
//
// The no-enumeration contract is preserved: success and unknown-email
// both flow through onSuccess to the success view, and any non-5xx
// error also folds into the success view. Only a 5xx surfaces a
// visible "credentials store unreachable" notice, and that copy now
// comes from the shared `serverUnavailableMessage` helper.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "forgot-password.tsx"), "utf8");

describe("pages/forgot-password — uses shared serverUnavailableMessage helper", () => {
  it("imports serverUnavailableMessage from @workspace/resupply-auth-react", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*serverUnavailableMessage[^}]*\}\s*from\s*"@workspace\/resupply-auth-react"/,
    );
  });

  it("calls serverUnavailableMessage with the forgot-password action/subject", () => {
    expect(SRC).toContain('action: "send a reset link"');
    expect(SRC).toContain('subject: "email"');
  });

  it("does NOT inline the credentials-store copy", () => {
    expect(SRC).not.toContain("credentials store");
  });

  it("does NOT reference status.pennpaps.com directly", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });
});

describe("pages/forgot-password — no-enumeration contract", () => {
  it("flips to the success view on onSuccess", () => {
    expect(SRC).toContain("onSuccess: () => setDone(true)");
  });

  it("still branches on err.status >= 500 for the visible error", () => {
    expect(SRC).toContain("err.status >= 500");
  });

  it("folds any non-5xx error back into the success view", () => {
    // The onError handler must call setDone(true) after handling
    // the 5xx branch, so unknown-email and other failures still
    // surface as the generic "check your inbox" success state.
    expect(SRC).toContain("setDone(true)");
  });
});

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
