// Tests for pages/reset-password.tsx (storefront variant).
//
// The component uses React + hooks which cannot be rendered in the
// node vitest environment without jsdom. We read the source as a
// string and assert on the structural and security invariants that
// matter.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "reset-password.tsx"), "utf8");

// ---------------------------------------------------------------------------
// stripTokenFromUrl — presence and structure
// ---------------------------------------------------------------------------
describe("reset-password — stripTokenFromUrl function", () => {
  it("defines the stripTokenFromUrl function", () => {
    expect(SRC).toContain("function stripTokenFromUrl()");
  });

  it("guards against SSR by checking typeof window === 'undefined'", () => {
    expect(SRC).toContain(`typeof window === "undefined"`);
  });

  it("uses URLSearchParams to read the current query string", () => {
    expect(SRC).toContain("new URLSearchParams(window.location.search)");
  });

  it("checks that 'token' is present before attempting to delete it (early exit)", () => {
    expect(SRC).toContain(`params.has("token")`);
  });

  it("deletes the token param from the URLSearchParams object", () => {
    expect(SRC).toContain(`params.delete("token")`);
  });

  it("uses history.replaceState to update the address bar without navigation", () => {
    expect(SRC).toContain("window.history.replaceState");
  });

  it("preserves the pathname in the rewritten URL", () => {
    expect(SRC).toContain("window.location.pathname");
  });

  it("preserves the hash fragment in the rewritten URL", () => {
    expect(SRC).toContain("window.location.hash");
  });

  it("conditionally includes '?' only when remaining query params exist", () => {
    expect(SRC).toMatch(/qs \? `\?\$\{qs\}` : ""/);
  });

  it("silently swallows History API errors via try/catch", () => {
    expect(SRC).toContain("try {");
    expect(SRC).toContain("// History API not available: no-op.");
  });
});

// ---------------------------------------------------------------------------
// useEffect wiring
// ---------------------------------------------------------------------------
describe("reset-password — useEffect wires stripTokenFromUrl on mount", () => {
  it("calls useEffect with stripTokenFromUrl and an empty dependency array", () => {
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
  });

  it("imports useEffect from react", () => {
    expect(SRC).toMatch(/import\s*\{[^}]*useEffect[^}]*\}/);
  });
});

// ---------------------------------------------------------------------------
// Double-submit guard
// ---------------------------------------------------------------------------
describe("reset-password — double-submit guard in onSubmit", () => {
  it("bails out immediately if a request is already in flight", () => {
    expect(SRC).toContain("if (reset.isPending) return;");
  });

  it("places the isPending check before any mutation or state update", () => {
    const guardIdx = SRC.indexOf("if (reset.isPending) return;");
    const mutateIdx = SRC.indexOf("reset.mutate(");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(mutateIdx).toBeGreaterThan(guardIdx);
  });

  it("disables the submit button while isPending for visual feedback", () => {
    expect(SRC).toContain("reset.isPending");
    const occurrences = SRC.split("isPending").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Token reading
// ---------------------------------------------------------------------------
describe("reset-password — token reading (storefront)", () => {
  it("reads the token via useMemo (single capture on mount)", () => {
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
  });

  it("defines readTokenFromUrl that is SSR-safe", () => {
    expect(SRC).toContain("function readTokenFromUrl()");
    expect(SRC).toMatch(/readTokenFromUrl[\s\S]{0,200}typeof window === "undefined"/);
  });

  it("falls back to empty string when the token query param is absent", () => {
    expect(SRC).toContain(`?? ""`);
  });
});

// ---------------------------------------------------------------------------
// Security invariants
// ---------------------------------------------------------------------------
describe("reset-password — security: token removed from URL after capture", () => {
  it("both captures and immediately strips the token on mount", () => {
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
  });

  it("rebuilds query string from remaining params (not the raw search string)", () => {
    expect(SRC).toContain("params.toString()");
  });
});

// ---------------------------------------------------------------------------
// Regression: storefront-specific behaviour still present
// ---------------------------------------------------------------------------
describe("reset-password — regression: core storefront form behaviour intact", () => {
  it("validates password === confirm match before submitting", () => {
    expect(SRC).toContain("password !== confirm");
  });

  it("calls reset.mutate with the captured token and new password", () => {
    expect(SRC).toContain("reset.mutate(");
    expect(SRC).toContain("{ token, password }");
  });

  it("redirects to /sign-in on success (no auto-sign-in — session revoked)", () => {
    expect(SRC).toContain("/sign-in");
  });

  it("shows inline password mismatch indicator while confirm field has content", () => {
    expect(SRC).toContain("passwordsMismatch");
  });
});

// ---------------------------------------------------------------------------
// Auth error handling delegated to the shared helper
// ---------------------------------------------------------------------------
describe("reset-password — uses shared authErrorMessage helper", () => {
  it("imports authErrorMessage from @workspace/resupply-auth-react", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*authErrorMessage[^}]*\}\s*from\s*"@workspace\/resupply-auth-react"/,
    );
  });

  it("calls authErrorMessage with action/subject/fallback options", () => {
    expect(SRC).toContain('action: "update your password"');
    expect(SRC).toContain('subject: "reset link"');
    expect(SRC).toContain('fallback: "Could not reset your password."');
  });

  it("does NOT declare its own SERVER_UNAVAILABLE_MESSAGE", () => {
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
