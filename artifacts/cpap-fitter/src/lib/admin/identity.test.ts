// Tests for lib/admin/identity.ts — focuses on the PR change:
//
//   Replacing the hardcoded queryKey: ["auth", "me"] in invalidateQueries
//   with the imported SESSION_QUERY_KEY constant from ./auth-hooks.
//
//   This ensures the admin identity shim invalidates the correct
//   (namespaced) cache entry rather than the shared default key,
//   which would collide with the storefront surface.
//
// Source-level assertions are used here to guard against regression
// without requiring React or a running QueryClient.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "identity.ts"), "utf8");

describe("admin/identity.ts — SESSION_QUERY_KEY import (PR: namespaced cache key)", () => {
  it("imports SESSION_QUERY_KEY from ./auth-hooks", () => {
    // The PR introduced a namespaced SESSION_QUERY_KEY per auth surface.
    // The admin identity shim must import it from ./auth-hooks (not from
    // the storefront's lib/auth-hooks) to invalidate the correct admin
    // cache entry.
    expect(SRC).toMatch(
      /import\s*\{[^}]*SESSION_QUERY_KEY[^}]*\}\s*from\s*["']\.\/auth-hooks["']/,
    );
  });

  it('uses SESSION_QUERY_KEY in invalidateQueries, not a hardcoded ["auth","me"]', () => {
    // Regression guard: the key must come from the import.
    // A hardcoded ["auth","me"] would invalidate the default key,
    // colliding with the storefront surface.
    expect(SRC).toContain("queryKey: SESSION_QUERY_KEY");
    // Must NOT contain the old hardcoded 2-element key literal.
    expect(SRC).not.toMatch(/queryKey:\s*\["auth",\s*"me"\]/);
  });

  it("also invalidates /resupply-api/me after sign-out", () => {
    // The admin shim invalidates both the session cache key AND the
    // /resupply-api/me React Query probe so AppShell re-fetches the
    // role-based nav immediately after sign-out.
    expect(SRC).toContain('queryKey: ["/resupply-api/me"]');
  });

  it("calls authClient.signOut() on sign-out", () => {
    // The shim bypasses the React Query mutation to stay callable from
    // non-component contexts (e.g. error boundaries), but must still
    // call the underlying authClient.
    expect(SRC).toContain("authClient.signOut()");
  });

  it("does NOT swallow the sign-out error (must await authClient.signOut)", () => {
    // A failed /sign-out leaves the server-side session cookie valid.
    // The shim must propagate the error so the UI can surface a retry.
    // Verify the call is awaited (not fire-and-forget).
    expect(SRC).toContain("await authClient.signOut()");
  });

  it("exports useDashboardIdentity", () => {
    expect(SRC).toContain("export function useDashboardIdentity");
  });
});

describe("admin/identity.ts — authHooks import", () => {
  it("imports authHooks from ./auth-hooks", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*authHooks[^}]*\}\s*from\s*["']\.\/auth-hooks["']/,
    );
  });

  it("imports authClient from ./auth-hooks", () => {
    expect(SRC).toMatch(
      /import\s*\{[^}]*authClient[^}]*\}\s*from\s*["']\.\/auth-hooks["']/,
    );
  });
});
