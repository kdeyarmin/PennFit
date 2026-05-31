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

describe("identity.tsx — cartStore integration (regression: cart stayed populated after sign-out)", () => {
  it("imports cartStore from @/hooks/use-cart", () => {
    // The store must be imported so sign-out can call cartStore.clear().
    expect(SRC).toMatch(/import\s*\{[^}]*cartStore[^}]*\}\s*from\s*["']@\/hooks\/use-cart["']/);
  });

  it("calls cartStore.clear() during sign-out", () => {
    // The shared in-memory store must be cleared, not just localStorage.
    expect(SRC).toContain("cartStore.clear()");
  });

  it("does NOT call localStorage.removeItem with the cart storage key directly", () => {
    // Regression guard: the old code used raw localStorage.removeItem which
    // left the module-level state array intact. This must never reappear.
    expect(SRC).not.toContain('removeItem("pennpaps_cart_v1")');
  });

  it("still removes the wishlist, compare, and recently-viewed keys directly", () => {
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
    // localStorage/store clears appear after the try/catch for authClient.signOut(),
    // ensuring they run regardless of server error.
    const serverSignOutPos = SRC.indexOf("serverSignOutError");
    const cartClearPos = SRC.indexOf("cartStore.clear()");
    // cartStore.clear() must come AFTER the serverSignOutError capture block
    // (i.e., after the authClient.signOut() call), so local state is always purged.
    expect(cartClearPos).toBeGreaterThan(serverSignOutPos);
  });
});

// ---------------------------------------------------------------------------
// SESSION_QUERY_KEY namespacing (PR change)
// ---------------------------------------------------------------------------
//
// The PR replaced the hardcoded `["auth","me"]` query key with the
// exported `SESSION_QUERY_KEY` constant from `./auth-hooks`. This ensures
// the storefront surface uses its own namespaced key
// (`["auth","me","storefront"]`) rather than the bare default, preventing
// cache collisions with the admin surface when they share a QueryClient.

describe("identity.tsx — SESSION_QUERY_KEY namespacing (PR regression guard)", () => {
  it("imports SESSION_QUERY_KEY from ./auth-hooks", () => {
    // The named import must be present — the storefront surface must not
    // rely on a different module's key or define its own inline constant.
    expect(SRC).toMatch(
      /import\s*\{[^}]*SESSION_QUERY_KEY[^}]*\}\s*from\s*["']\.\/auth-hooks["']/,
    );
  });

  it("uses SESSION_QUERY_KEY in the invalidateQueries call during sign-out", () => {
    // The cache invalidation must reference the imported constant, not a
    // hardcoded literal, so both identity.tsx and auth-hooks.ts stay in sync.
    expect(SRC).toContain(
      "queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY })",
    );
  });

  it("does NOT contain a hardcoded [\"auth\",\"me\"] array literal in the invalidation call", () => {
    // Regression guard: the old code passed a literal that didn't match the
    // admin surface's key. If someone reverts to a literal, this catches it.
    // We allow the string to appear in comments but not in a queryKey argument.
    const queryKeyLiteralPattern =
      /queryKey:\s*\[\s*["']auth["']\s*,\s*["']me["']\s*\]/;
    expect(SRC).not.toMatch(queryKeyLiteralPattern);
  });
});
