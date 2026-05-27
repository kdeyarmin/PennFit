// Tests for pages/sign-in.tsx (storefront variant).
//
// Auth error handling is now centralized in
// @workspace/resupply-auth-react's `authErrorMessage` helper. Each
// page just supplies its own action/subject/fallback strings.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "sign-in.tsx"), "utf8");

describe("pages/sign-in — uses shared authErrorMessage helper", () => {
  it("imports authErrorMessage from @workspace/resupply-auth-react", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*authErrorMessage[^}]*\}\s*from\s*"@workspace\/resupply-auth-react"/,
    );
  });

  it("calls authErrorMessage with action/subject/fallback options", () => {
    expect(SRC).toContain('action: "sign you in"');
    expect(SRC).toContain('subject: "password"');
    expect(SRC).toContain('fallback: "Sign-in failed."');
  });

  it("does NOT declare its own SERVER_UNAVAILABLE_MESSAGE constant", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does NOT define a local authErrorMessage helper function", () => {
    expect(SRC).not.toMatch(/function\s+authErrorMessage/);
  });

  it("does NOT inline the credentials-store copy", () => {
    expect(SRC).not.toContain("credentials store");
  });

  it("does NOT reference status.pennpaps.com directly", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });

  it("does NOT branch on err.status >= 500 itself", () => {
    expect(SRC).not.toContain("err.status >= 500");
  });
});

describe("pages/sign-in — core form behaviour retained", () => {
  it("still calls signIn.mutate on submit", () => {
    expect(SRC).toContain("signIn.mutate(");
  });

  it("still redirects to /account on success", () => {
    expect(SRC).toContain("/account");
  });

  it("still shows a pending state on the button", () => {
    expect(SRC).toContain("signIn.isPending");
  });

  it("still provides a 'Forgot your password?' link", () => {
    expect(SRC).toContain("forgot-password");
  });

  it("still reads the ?reset=success and ?verified=success flags from the URL", () => {
    expect(SRC).toContain("reset");
    expect(SRC).toContain("verified");
  });
});
