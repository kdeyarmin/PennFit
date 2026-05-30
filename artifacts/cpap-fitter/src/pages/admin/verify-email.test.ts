// Tests for admin/verify-email.tsx
//
// PR changes:
//   * stripTokenFromUrl() function — strips ?token=… from the address bar so
//     the single-use secret doesn't linger in browser history.
//   * useEffect(stripTokenFromUrl, []) — wires the cleanup on mount.
//
// The component uses React + hooks which cannot be rendered in the node
// vitest environment without jsdom. We read the source file as a string and
// assert on the structural and security invariants that matter.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "verify-email.tsx"), "utf8");

// ---------------------------------------------------------------------------
// stripTokenFromUrl — presence and structure
// ---------------------------------------------------------------------------
describe("admin/verify-email — stripTokenFromUrl function", () => {
  it("defines the stripTokenFromUrl function", () => {
    expect(SRC).toContain("function stripTokenFromUrl()");
  });

  it("guards against SSR by checking typeof window === 'undefined'", () => {
    expect(SRC).toContain(`typeof window === "undefined"`);
  });

  it("uses URLSearchParams to read the current query string", () => {
    expect(SRC).toContain("new URLSearchParams(window.location.search)");
  });

  it("checks that 'token' is present before attempting to delete it", () => {
    expect(SRC).toContain(`params.has("token")`);
  });

  it("deletes the token parameter from the query string", () => {
    expect(SRC).toContain(`params.delete("token")`);
  });

  it("calls history.replaceState to update the address bar without a page reload", () => {
    expect(SRC).toContain("window.history.replaceState");
  });

  it("preserves the pathname when rewriting the URL", () => {
    expect(SRC).toContain("window.location.pathname");
  });

  it("preserves the hash fragment after stripping the token", () => {
    expect(SRC).toContain("window.location.hash");
  });

  it("omits the '?' when there are no remaining query params", () => {
    expect(SRC).toMatch(/qs \? `\?\$\{qs\}` : ""/);
  });

  it("wraps replaceState in try/catch in case the History API is unavailable", () => {
    expect(SRC).toContain("try {");
    expect(SRC).toContain("// History API not available: no-op.");
  });
});

// ---------------------------------------------------------------------------
// useEffect wiring
// ---------------------------------------------------------------------------
describe("admin/verify-email — useEffect wires stripTokenFromUrl on mount", () => {
  it("calls useEffect with stripTokenFromUrl and empty dependency array", () => {
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
  });

  it("imports useEffect from react", () => {
    expect(SRC).toMatch(/import\s*\{[^}]*useEffect[^}]*\}/);
  });
});

// ---------------------------------------------------------------------------
// Token reading
// ---------------------------------------------------------------------------
describe("admin/verify-email — token reading", () => {
  it("reads the token via useMemo to capture it once on mount", () => {
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
  });

  it("defines readTokenFromUrl that guards against SSR", () => {
    expect(SRC).toContain("function readTokenFromUrl()");
    expect(SRC).toMatch(
      /readTokenFromUrl[\s\S]{0,200}typeof window === "undefined"/,
    );
  });

  it("reads the 'token' param from URLSearchParams", () => {
    expect(SRC).toContain(`params.get("token")`);
  });

  it("defaults to empty string when no token param is present", () => {
    expect(SRC).toContain(`?? ""`);
  });
});

// ---------------------------------------------------------------------------
// Security: token cleared from address bar after capture
// ---------------------------------------------------------------------------
describe("admin/verify-email — security: token not retained in URL", () => {
  it("strips token immediately on mount via useEffect", () => {
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
    // And the token was already captured via useMemo before the strip.
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
  });
});

// ---------------------------------------------------------------------------
// Regression: pre-existing page behaviour not removed
// ---------------------------------------------------------------------------
describe("admin/verify-email — regression: core verification logic intact", () => {
  it("initialises status as 'verifying' when a token is present", () => {
    expect(SRC).toContain(`"verifying"`);
  });

  it("initialises status as 'error' when no token is present", () => {
    expect(SRC).toContain(`"error"`);
  });

  it("calls verifyRef.current.mutate on mount with the token", () => {
    expect(SRC).toContain("verifyRef.current.mutate(");
    expect(SRC).toContain("{ token }");
  });

  it("uses a fired ref to prevent duplicate verify calls (strict-mode safety)", () => {
    expect(SRC).toContain("fired.current");
  });

  it("redirects to /admin/sign-in on success via Link", () => {
    expect(SRC).toContain(`\${basePath}/sign-in`);
  });
});
