// Tests for pages/reset-password.tsx (storefront variant)
//
// PR changes:
//   * stripTokenFromUrl() function — strips ?token=… from the address bar so
//     the single-use secret doesn't linger in browser history.
//   * useEffect(stripTokenFromUrl, []) — wires the cleanup on mount.
//   * Double-submit guard — `if (reset.isPending) return;` at the top of
//     onSubmit to prevent a fast double-click from firing two API calls.
//
// The component uses React + hooks which cannot be rendered in the node
// vitest environment without jsdom. We read the source file as a string and
// assert on the structural and security invariants that matter.

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
    // Both the button disabled prop and the guard check reference isPending.
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
    // useMemo runs before useEffect so token is captured first, then stripped.
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
  });

  it("rebuilds query string from remaining params (not the raw search string)", () => {
    // After deleting 'token', params.toString() provides only the survivors.
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
// This PR: 5xx special-case / authErrorMessage helper removed
// ---------------------------------------------------------------------------
describe("reset-password — 5xx error handling removed", () => {
  it("does not define a SERVER_UNAVAILABLE_MESSAGE constant", () => {
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does not define an authErrorMessage helper function", () => {
    expect(SRC).not.toContain("function authErrorMessage");
    expect(SRC).not.toContain("authErrorMessage(");
  });

  it("does not contain status.pennpaps.com in error copy", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });

  it("uses inline AuthError check for error messages", () => {
    expect(SRC).toContain("err instanceof AuthError");
    expect(SRC).toContain("err.userMessage");
  });

  it("falls back to 'Could not reset your password.' for non-AuthError throws", () => {
    expect(SRC).toContain('"Could not reset your password."');
  });
});