// Tests for admin/reset-password.tsx.
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
describe("admin/reset-password — stripTokenFromUrl function", () => {
  it("defines the stripTokenFromUrl function", () => {
    expect(SRC).toContain("function stripTokenFromUrl()");
  });

  it("guards against SSR by checking typeof window === 'undefined'", () => {
    expect(SRC).toContain(`typeof window === "undefined"`);
  });

  it("uses URLSearchParams to read the current query string", () => {
    expect(SRC).toContain("new URLSearchParams(window.location.search)");
  });

  it("checks for 'token' before deleting it (no-op when already absent)", () => {
    expect(SRC).toContain(`params.has("token")`);
  });

  it("deletes the token parameter from the query string", () => {
    expect(SRC).toContain(`params.delete("token")`);
  });

  it("calls history.replaceState to rewrite the address bar without reload", () => {
    expect(SRC).toContain("window.history.replaceState");
  });

  it("preserves the pathname when stripping the token", () => {
    expect(SRC).toContain("window.location.pathname");
  });

  it("preserves the fragment (hash) after stripping the token", () => {
    expect(SRC).toContain("window.location.hash");
  });

  it("omits the '?' separator when no other query params remain", () => {
    expect(SRC).toMatch(/qs \? `\?\$\{qs\}` : ""/);
  });

  it("wraps history.replaceState in a try/catch for environments that block it", () => {
    expect(SRC).toContain("try {");
    expect(SRC).toContain("// History API not available: no-op.");
  });
});

// ---------------------------------------------------------------------------
// useEffect wiring
// ---------------------------------------------------------------------------
describe("admin/reset-password — useEffect wires stripTokenFromUrl", () => {
  it("calls useEffect with stripTokenFromUrl as the effect", () => {
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
  });

  it("imports useEffect from react", () => {
    expect(SRC).toContain("useEffect");
    expect(SRC).toMatch(/import\s*\{[^}]*useEffect[^}]*\}/);
  });
});

// ---------------------------------------------------------------------------
// Double-submit guard
// ---------------------------------------------------------------------------
describe("admin/reset-password — double-submit guard", () => {
  it("guards against double-submit at the top of onSubmit", () => {
    expect(SRC).toContain("if (reset.isPending) return;");
  });

  it("places the isPending guard before setSubmitError(null) to exit early", () => {
    const pendingIdx = SRC.indexOf("if (reset.isPending) return;");
    const clearErrorIdx = SRC.indexOf("setSubmitError(null)");
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(clearErrorIdx).toBeGreaterThan(pendingIdx);
  });

  it("also disables the submit button while isPending for UI feedback", () => {
    expect(SRC).toContain("reset.isPending");
    expect(SRC).toContain("disabled={reset.isPending");
  });
});

// ---------------------------------------------------------------------------
// Token reading
// ---------------------------------------------------------------------------
describe("admin/reset-password — token reading", () => {
  it("reads the token via useMemo to avoid re-reading on re-renders", () => {
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
  });

  it("defines readTokenFromUrl that returns empty string when window is undefined (SSR)", () => {
    expect(SRC).toContain("function readTokenFromUrl()");
    expect(SRC).toMatch(/readTokenFromUrl[\s\S]{0,200}typeof window === "undefined"/);
  });

  it("reads the 'token' query param from URLSearchParams", () => {
    expect(SRC).toContain(`params.get("token")`);
  });

  it("returns empty string when token param is absent (via ?? '')", () => {
    expect(SRC).toContain(`?? ""`);
  });
});

// ---------------------------------------------------------------------------
// Security: token not persisted in URL after page load
// ---------------------------------------------------------------------------
describe("admin/reset-password — security: token cleared from address bar", () => {
  it("does NOT re-read window.location after mount (token captured only once)", () => {
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
  });

  it("strips token even when other query params are present (preserves them)", () => {
    expect(SRC).toContain("params.toString()");
    expect(SRC).toContain("window.history.replaceState");
  });
});

// ---------------------------------------------------------------------------
// Regression: pre-existing form behaviour not removed
// ---------------------------------------------------------------------------
describe("admin/reset-password — regression: core form logic intact", () => {
  it("still validates that password and confirm match", () => {
    expect(SRC).toContain(`password !== confirm`);
  });

  it("still calls reset.mutate with token and password", () => {
    expect(SRC).toContain("reset.mutate(");
    expect(SRC).toContain("{ token, password }");
  });

  it("redirects to /admin/sign-in on success", () => {
    expect(SRC).toContain("/admin/sign-in");
  });
});

// ---------------------------------------------------------------------------
// Auth error handling delegated to the shared helper
// ---------------------------------------------------------------------------
describe("admin/reset-password — uses shared authErrorMessage helper", () => {
  it("imports authErrorMessage from @workspace/resupply-auth-react", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*authErrorMessage[^}]*\}\s*from\s*"@workspace\/resupply-auth-react"/,
    );
  });

  it("calls authErrorMessage with action/subject/fallback options", () => {
    expect(SRC).toContain('action: "reset your password"');
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
