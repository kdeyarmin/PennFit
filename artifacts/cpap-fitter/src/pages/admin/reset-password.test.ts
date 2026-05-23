// Tests for admin/reset-password.tsx
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
    // The ternary `qs ? \`?${qs}\` : ""` ensures the URL ends cleanly.
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
    // The import statement should include useEffect.
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
    // Must guard SSR.
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
    // The useMemo reads on mount; the useEffect immediately strips from URL.
    // This is a static check that both patterns coexist.
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
  });

  it("strips token even when other query params are present (preserves them)", () => {
    // The code rebuilds qs from remaining params before calling replaceState.
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
// PR change: authErrorMessage helper and SERVER_UNAVAILABLE_MESSAGE removed
// ---------------------------------------------------------------------------
describe("admin/reset-password — authErrorMessage helper removed (PR change)", () => {
  it("does NOT define the authErrorMessage helper function", () => {
    // The function was removed; the inline ternary replaces it.
    expect(SRC).not.toContain("function authErrorMessage");
  });

  it("does NOT reference authErrorMessage anywhere", () => {
    expect(SRC).not.toContain("authErrorMessage");
  });

  it("does NOT declare SERVER_UNAVAILABLE_MESSAGE", () => {
    // The 5xx credentials-store copy is gone.
    expect(SRC).not.toContain("SERVER_UNAVAILABLE_MESSAGE");
  });

  it("does NOT contain the 'status.pennpaps.com' status-page URL", () => {
    expect(SRC).not.toContain("status.pennpaps.com");
  });

  it("uses the inline AuthError instanceof check in the onError handler", () => {
    // The pattern `err instanceof AuthError ? err.userMessage : "<fallback>"`
    // replaces the extracted helper.
    expect(SRC).toContain("err instanceof AuthError");
    expect(SRC).toContain("err.userMessage");
  });

  it("still imports AuthError (needed for the instanceof check)", () => {
    expect(SRC).toContain("AuthError");
  });
});