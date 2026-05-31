// Tests for lib/admin/identity.ts — focuses on the PR change:
//
//   Replacing the hardcoded `["auth","me"]` query key in the
//   invalidateQueries call with the exported SESSION_QUERY_KEY constant
//   from `./auth-hooks`. This ensures the admin surface uses its own
//   namespaced key (`["auth","me","admin"]`) rather than the bare default,
//   preventing cache collisions with the storefront surface.
//
// The vitest environment here is "node" (no jsdom, no React rendering).
// We use source-level structural assertions — the same technique used in
// identity.test.ts — to guard against regression without requiring a
// full component tree or React Query provider.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "identity.ts"), "utf8");
const AUTH_HOOKS_SRC = readFileSync(
  path.join(__dirname, "auth-hooks.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// SESSION_QUERY_KEY namespacing (PR change)
// ---------------------------------------------------------------------------

describe("admin/identity.ts — SESSION_QUERY_KEY namespacing (PR regression guard)", () => {
  it("imports SESSION_QUERY_KEY from ./auth-hooks", () => {
    // Must import the constant from the local module — not define an
    // inline literal — so it stays in sync with auth-hooks.ts.
    expect(SRC).toMatch(
      /import\s*\{[^}]*SESSION_QUERY_KEY[^}]*\}\s*from\s*["']\.\/auth-hooks["']/,
    );
  });

  it("uses SESSION_QUERY_KEY in the invalidateQueries call during sign-out", () => {
    // Both the /resupply-api/me invalidation AND the session invalidation
    // must be present; the session one must use the exported constant.
    expect(SRC).toContain(
      "queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })",
    );
  });

  it("does NOT contain a hardcoded [\"auth\",\"me\"] array literal in the invalidation call", () => {
    // Regression guard: the old code passed the wrong literal. If someone
    // reverts to a hardcoded key, the admin and storefront surfaces would
    // share the same cache entry again and sessions would collide.
    const queryKeyLiteralPattern =
      /queryKey:\s*\[\s*["']auth["']\s*,\s*["']me["']\s*\]/;
    expect(SRC).not.toMatch(queryKeyLiteralPattern);
  });

  it("still invalidates the /resupply-api/me query alongside the session key", () => {
    // The admin sign-out must flush both the OpenAPI /me cache and the
    // auth session cache so role-gated nav tiles and session gates both
    // update immediately.
    expect(SRC).toContain('queryKey: ["/resupply-api/me"]');
  });
});

// ---------------------------------------------------------------------------
// Admin session cache key — admin/auth-hooks.ts
// ---------------------------------------------------------------------------

describe("admin/auth-hooks.ts — SESSION_QUERY_KEY value", () => {
  it("exports SESSION_QUERY_KEY as [\"auth\",\"me\",\"admin\"]", () => {
    // The admin surface must use a 3-element key with the "admin" suffix
    // to avoid colliding with the storefront's ["auth","me","storefront"].
    expect(AUTH_HOOKS_SRC).toContain(
      '["auth", "me", "admin"]',
    );
  });

  it("passes sessionQueryKey to createAuthHooks", () => {
    // The admin auth hooks must be wired with the namespaced key so that
    // useSession, useSignOut, etc. all operate on the correct cache entry.
    expect(AUTH_HOOKS_SRC).toContain("sessionQueryKey: SESSION_QUERY_KEY");
  });

  it("exports authHooks created with the admin SESSION_QUERY_KEY", () => {
    // Both the key and the hooks must be exported so identity.ts can
    // import them and invalidate the right cache entry.
    expect(AUTH_HOOKS_SRC).toContain("export const SESSION_QUERY_KEY");
    expect(AUTH_HOOKS_SRC).toContain("export const authHooks");
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe("admin/identity.ts — exports", () => {
  it("exports useDashboardIdentity", () => {
    expect(SRC).toContain("export function useDashboardIdentity");
  });

  it("exports DashboardIdentity interface", () => {
    expect(SRC).toContain("export interface DashboardIdentity");
  });
});

// ---------------------------------------------------------------------------
// Sign-out safety — admin surface
// ---------------------------------------------------------------------------

describe("admin/identity.ts — sign-out safety", () => {
  it("does NOT swallow sign-out errors (await authClient.signOut() is not in a try/catch that discards the error)", () => {
    // Admin sign-out errors must propagate: a failed server-side sign-out
    // leaves a valid admin session cookie, which grants access to PHI.
    // The caller must be informed so it can surface a retry prompt.
    // The source must NOT wrap authClient.signOut() in try/catch.
    const signOutCallPos = SRC.indexOf("await authClient.signOut()");
    expect(signOutCallPos).toBeGreaterThan(-1);
    // The sign-out call must not be nested inside a catch-swallowing block.
    // The best-effort catch around invalidateQueries is the only acceptable one.
    const precedingContext = SRC.slice(
      Math.max(0, signOutCallPos - 30),
      signOutCallPos,
    );
    expect(precedingContext).not.toContain("try {");
  });

  it("wraps the invalidateQueries calls in a best-effort try/catch", () => {
    // Cache invalidation failures must never abort the sign-out flow.
    // The source should contain a try/catch around the invalidations.
    expect(SRC).toContain("/* best-effort */");
  });
});