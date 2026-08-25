// Tests for lib/identity.tsx — focuses on the changes introduced in this PR:
//
//   Replacing the raw `window.localStorage.removeItem("pennpaps_cart_v1")`
//   with `cartStore.clear()` so that the shared in-memory store is also
//   cleared on sign-out.  A raw removeItem leaves the module-level `state`
//   array untouched; any subsequent mutation would re-persist the old cart,
//   and every mounted useCart() consumer would still render User A's items.
//
// The vitest environment here is "node" (no jsdom, no React rendering), so
// we use source-level structural assertions — the same technique used in
// use-bulk-selection.test.ts and use-url-state.test.ts — to guard against
// regression without requiring a full component tree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "identity.tsx"), "utf8");

describe("identity.tsx — local state purge on sign-out", () => {
  it("no longer references a cart store (cash-pay retired)", () => {
    // The storefront cart went away with card checkout; there is no
    // in-memory cart left to clear on sign-out.
    expect(SRC).not.toContain("cartStore");
    expect(SRC).not.toContain('removeItem("pennpaps_cart_v1")');
  });

  it("removes the wishlist, compare, and recently-viewed keys directly", () => {
    // These keys have no in-memory store — raw removeItem is correct for them.
    expect(SRC).toContain('removeItem("pennpaps:wishlist:v1")');
    expect(SRC).toContain('removeItem("pennpaps:compare:v1")');
    expect(SRC).toContain('removeItem("pennpaps_recently_viewed_v1")');
  });

  it("still removes the account chat key from sessionStorage", () => {
    expect(SRC).toContain('removeItem("pennpaps_account_chat_v1")');
  });
});

describe("identity.tsx — exports", () => {
  it("exports useShopIdentity", () => {
    expect(SRC).toContain("export function useShopIdentity");
  });

  it("exports SignedIn component", () => {
    expect(SRC).toContain("export const SignedIn");
  });

  it("exports SignedOut component", () => {
    expect(SRC).toContain("export const SignedOut");
  });
});

describe("identity.tsx — sign-out safety properties", () => {
  it("re-throws server-side sign-out errors so the caller can surface them", () => {
    // If /api/auth/sign-out fails, the session cookie is still valid on
    // the server. The error must propagate so the UI can warn the user.
    expect(SRC).toContain("if (serverSignOutError) throw serverSignOutError");
  });

  it("clears local state even when the server sign-out call fails", () => {
    // The localStorage purges appear after the try/catch for
    // authClient.signOut(), ensuring they run regardless of server error.
    const serverSignOutPos = SRC.indexOf("serverSignOutError");
    const wishlistClearPos = SRC.indexOf('removeItem("pennpaps:wishlist:v1")');
    expect(wishlistClearPos).toBeGreaterThan(serverSignOutPos);
  });
});

describe("identity.tsx — SESSION_QUERY_KEY import (PR: namespaced cache key)", () => {
  it("imports SESSION_QUERY_KEY from ./auth-hooks", () => {
    // This PR introduced a namespaced SESSION_QUERY_KEY per auth surface.
    // identity.tsx must import it from ./auth-hooks (not ./admin/auth-hooks)
    // so it invalidates the correct storefront cache entry.
    expect(SRC).toMatch(
      /import\s*\{[^}]*SESSION_QUERY_KEY[^}]*\}\s*from\s*["']\.\/auth-hooks["']/,
    );
  });

  it('uses SESSION_QUERY_KEY in invalidateQueries, not the literal ["auth","me"]', () => {
    // Regression guard: the key must come from the import, not be hardcoded.
    // A hardcoded ["auth","me"] would collide with the admin surface.
    expect(SRC).toContain(
      "queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })",
    );
    // Must NOT contain the old hardcoded key literal.
    expect(SRC).not.toMatch(/queryKey:\s*\["auth",\s*"me"\]/);
  });

  it("SESSION_QUERY_KEY is referenced after authClient.signOut() call (invalidates on sign-out)", () => {
    // Ensure the invalidation happens after the actual sign-out API call.
    const signOutCallPos = SRC.indexOf("authClient.signOut()");
    const invalidatePos = SRC.indexOf(
      "queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })",
    );
    expect(signOutCallPos).toBeGreaterThan(-1);
    expect(invalidatePos).toBeGreaterThan(signOutCallPos);
  });
});
