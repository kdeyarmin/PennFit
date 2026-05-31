// Tests for lib/auth-hooks.ts — focuses on the PR changes:
//
//   1. SESSION_QUERY_KEY exported as ["auth","me","storefront"] so the
//      storefront surface does not collide with the admin surface when
//      they share a single QueryClient.
//   2. authHooks is created with `sessionQueryKey: SESSION_QUERY_KEY` so
//      every React Query operation (useSession, useSignOut, etc.) uses the
//      namespaced key.
//
// These are structural / source-level assertions (readFileSync) — the same
// technique used throughout this package for module-level wiring — so we
// don't need jsdom or React Testing Library.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "auth-hooks.ts"), "utf8");

// ---------------------------------------------------------------------------
// SESSION_QUERY_KEY value — storefront surface
// ---------------------------------------------------------------------------

describe("lib/auth-hooks.ts — SESSION_QUERY_KEY", () => {
  it("exports SESSION_QUERY_KEY as [\"auth\",\"me\",\"storefront\"]", () => {
    // The storefront key must include the "storefront" suffix so it does
    // not collide with the admin key (["auth","me","admin"]) in the shared
    // QueryClient.
    expect(SRC).toContain('["auth", "me", "storefront"]');
  });

  it("SESSION_QUERY_KEY is exported (named export)", () => {
    // Consumers (identity.tsx) import this constant to invalidate the right
    // cache entry on sign-out; if it's not exported the import silently
    // resolves to undefined and the invalidation hits the wrong key.
    expect(SRC).toContain("export const SESSION_QUERY_KEY");
  });

  it("does NOT use [\"auth\",\"me\",\"admin\"] as the storefront key", () => {
    // Regression guard: the storefront and admin surfaces must not share the
    // same suffix, or cache isolation fails entirely.
    expect(SRC).not.toContain('["auth", "me", "admin"]');
  });

  it("does NOT use the bare [\"auth\",\"me\"] default key", () => {
    // The storefront key must be namespaced. The bare default is intentionally
    // reserved for legacy or test usage in the base library.
    expect(SRC).not.toContain('["auth", "me"]');
  });
});

// ---------------------------------------------------------------------------
// authHooks wiring
// ---------------------------------------------------------------------------

describe("lib/auth-hooks.ts — authHooks wiring", () => {
  it("passes sessionQueryKey to createAuthHooks", () => {
    // Without this, createAuthHooks would use the bare SESSION_QUERY_KEY
    // default from the library, which would cause a collision with the admin
    // surface's key when both are mounted in the same QueryClient.
    expect(SRC).toContain("sessionQueryKey: SESSION_QUERY_KEY");
  });

  it("exports authHooks", () => {
    expect(SRC).toContain("export const authHooks");
  });

  it("exports authClient bound to /api/auth", () => {
    // The storefront auth client must point at the storefront's endpoint,
    // not the admin one (/resupply-api/auth).
    expect(SRC).toContain('basePath: "/api/auth"');
    expect(SRC).toContain("export const authClient");
  });
});

// ---------------------------------------------------------------------------
// Isolation from the admin surface
// ---------------------------------------------------------------------------

describe("lib/auth-hooks.ts — isolation from admin surface", () => {
  it("basePath value is /api/auth, not the admin path /resupply-api/auth", () => {
    // The storefront authClient must be bound to /api/auth. Using the admin
    // basePath (/resupply-api/auth) would route all storefront auth requests
    // to the wrong server. Verify the basePath assignment directly.
    expect(SRC).toMatch(/basePath:\s*["']\/api\/auth["']/);
    expect(SRC).not.toMatch(/basePath:\s*["']\/resupply-api\/auth["']/);
  });
});