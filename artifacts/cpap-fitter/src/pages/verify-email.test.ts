// Tests for pages/verify-email.tsx (storefront variant)
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
describe("verify-email — stripTokenFromUrl function", () => {
  it("defines the stripTokenFromUrl function", () => {
    expect(SRC).toContain("function stripTokenFromUrl()");
  });

  it("is SSR-safe: returns early when window is not defined", () => {
    expect(SRC).toContain(`typeof window === "undefined"`);
  });

  it("reads window.location.search via URLSearchParams", () => {
    expect(SRC).toContain("new URLSearchParams(window.location.search)");
  });

  it("performs an early-exit check for 'token' presence before deleting", () => {
    expect(SRC).toContain(`params.has("token")`);
  });

  it("removes the token parameter", () => {
    expect(SRC).toContain(`params.delete("token")`);
  });

  it("rewrites the address bar via history.replaceState (no page reload)", () => {
    expect(SRC).toContain("window.history.replaceState");
  });

  it("carries the pathname through to the rewritten URL", () => {
    expect(SRC).toContain("window.location.pathname");
  });

  it("carries the hash through to the rewritten URL", () => {
    expect(SRC).toContain("window.location.hash");
  });

  it("omits '?' when no query params survive the strip", () => {
    expect(SRC).toMatch(/qs \? `\?\$\{qs\}` : ""/);
  });

  it("swallows History API exceptions silently", () => {
    expect(SRC).toContain("try {");
    expect(SRC).toContain("// History API not available: no-op.");
  });
});

// ---------------------------------------------------------------------------
// useEffect wiring
// ---------------------------------------------------------------------------
describe("verify-email — useEffect mounts stripTokenFromUrl once", () => {
  it("passes stripTokenFromUrl as the effect with an empty dependency array", () => {
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
  });

  it("imports useEffect from react", () => {
    expect(SRC).toMatch(/import\s*\{[^}]*useEffect[^}]*\}/);
  });
});

// ---------------------------------------------------------------------------
// Token reading
// ---------------------------------------------------------------------------
describe("verify-email — token reading (storefront)", () => {
  it("memoises the initial token via useMemo so it isn't re-read on re-renders", () => {
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
  });

  it("defines readTokenFromUrl as an SSR-safe helper", () => {
    expect(SRC).toContain("function readTokenFromUrl()");
  });

  it("returns empty string when no token param is present", () => {
    expect(SRC).toContain(`?? ""`);
  });
});

// ---------------------------------------------------------------------------
// Security: token not retained in URL after component mounts
// ---------------------------------------------------------------------------
describe("verify-email — security: single-use token removed from address bar", () => {
  it("token is captured (useMemo) then immediately stripped (useEffect) on mount", () => {
    expect(SRC).toContain("useMemo(readTokenFromUrl, [])");
    expect(SRC).toContain("useEffect(stripTokenFromUrl, [])");
  });
});

// ---------------------------------------------------------------------------
// Regression: core verification logic still present
// ---------------------------------------------------------------------------
describe("verify-email — regression: verification flow intact", () => {
  it("starts in 'verifying' state when a token is present", () => {
    expect(SRC).toContain(`"verifying"`);
  });

  it("starts in 'error' state when no token is present", () => {
    expect(SRC).toContain(`"error"`);
  });

  it("uses a fired ref to prevent double-firing the verify mutation", () => {
    expect(SRC).toContain("fired.current");
  });

  it("calls the verify mutation with the captured token on mount", () => {
    expect(SRC).toContain("verifyRef.current.mutate(");
    expect(SRC).toContain("{ token }");
  });

  it("includes a link back to sign-in on error", () => {
    expect(SRC).toContain("/sign-in");
  });
});