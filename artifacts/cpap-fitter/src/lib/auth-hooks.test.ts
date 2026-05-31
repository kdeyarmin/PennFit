// Tests for lib/auth-hooks.ts — focuses on the PR change:
//
//   Adding a namespaced SESSION_QUERY_KEY = ["auth","me","storefront"]
//   so the storefront and admin auth surfaces don't collide in the
//   shared QueryClient.
//
// Source-level assertions are used here because auth-hooks.ts is a
// module-level singleton (no React rendering required) — the key
// contract is that the right constant is exported with the right value
// and passed to createAuthHooks.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "auth-hooks.ts"), "utf8");

describe("lib/auth-hooks.ts — SESSION_QUERY_KEY (PR: namespaced cache key)", () => {
  it("exports SESSION_QUERY_KEY", () => {
    // The constant must be exported so identity.tsx and any other consumer
    // can use it to invalidate the correct cache entry.
    expect(SRC).toContain("export const SESSION_QUERY_KEY");
  });

  it("SESSION_QUERY_KEY is [\"auth\",\"me\",\"storefront\"]", () => {
    // The third element distinguishes the storefront key from the admin key
    // (["auth","me","admin"]) so both can share a QueryClient without collision.
    expect(SRC).toMatch(/SESSION_QUERY_KEY\s*=\s*\["auth",\s*"me",\s*"storefront"\]/);
  });

  it("passes sessionQueryKey to createAuthHooks", () => {
    // Without this the hooks default to ["auth","me"], which would collide
    // with the admin surface when both run in the same SPA.
    expect(SRC).toContain("sessionQueryKey: SESSION_QUERY_KEY");
  });

  it("passes SESSION_QUERY_KEY (not a different value) to createAuthHooks", () => {
    // Regression: verify the option value is the exported constant,
    // not some other inline array.
    expect(SRC).not.toMatch(/sessionQueryKey:\s*\["auth",\s*"me"\]/);
  });

  it("exports authHooks", () => {
    expect(SRC).toContain("export const authHooks");
  });

  it("exports authClient", () => {
    expect(SRC).toContain("export const authClient");
  });

  it("authClient is bound to /api/auth basePath", () => {
    // The storefront auth client must hit the storefront endpoint,
    // not the admin endpoint (/resupply-api/auth).
    expect(SRC).toContain('basePath: "/api/auth"');
  });

  it("does NOT use /resupply-api/auth as the createAuthClient basePath", () => {
    // The basePath config must be /api/auth, not the admin path.
    // (The admin path may appear in comments explaining the distinction.)
    expect(SRC).not.toMatch(/basePath:\s*["']\/resupply-api\/auth["']/);
  });
});