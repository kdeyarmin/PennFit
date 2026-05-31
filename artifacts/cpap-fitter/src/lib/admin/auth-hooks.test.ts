// Tests for lib/admin/auth-hooks.ts — focuses on the PR change:
//
//   Adding a namespaced SESSION_QUERY_KEY = ["auth","me","admin"]
//   so the admin and storefront auth surfaces don't collide in the
//   shared QueryClient.
//
// Source-level assertions are used here because admin/auth-hooks.ts is a
// module-level singleton — the key contract is that the right constant is
// exported with the right value and passed to createAuthHooks.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "auth-hooks.ts"), "utf8");

describe("lib/admin/auth-hooks.ts — SESSION_QUERY_KEY (PR: namespaced cache key)", () => {
  it("exports SESSION_QUERY_KEY", () => {
    // The constant must be exported so admin/identity.ts can use it to
    // invalidate the correct cache entry on sign-out.
    expect(SRC).toContain("export const SESSION_QUERY_KEY");
  });

  it("SESSION_QUERY_KEY is [\"auth\",\"me\",\"admin\"]", () => {
    // The third element distinguishes the admin key from the storefront key
    // (["auth","me","storefront"]) so both surfaces share a QueryClient safely.
    expect(SRC).toMatch(/SESSION_QUERY_KEY\s*=\s*\["auth",\s*"me",\s*"admin"\]/);
  });

  it("passes sessionQueryKey to createAuthHooks", () => {
    // Without this the hooks would default to ["auth","me"], which would
    // collide with the storefront surface.
    expect(SRC).toContain("sessionQueryKey: SESSION_QUERY_KEY");
  });

  it("passes SESSION_QUERY_KEY (not a different inline array) to createAuthHooks", () => {
    // Regression: the option value must be the exported constant.
    expect(SRC).not.toMatch(/sessionQueryKey:\s*\["auth",\s*"me"\]/);
  });

  it("SESSION_QUERY_KEY is distinct from the storefront key", () => {
    // The admin key must NOT be the storefront key value.
    expect(SRC).not.toMatch(/SESSION_QUERY_KEY\s*=\s*\["auth",\s*"me",\s*"storefront"\]/);
  });

  it("exports authHooks", () => {
    expect(SRC).toContain("export const authHooks");
  });

  it("exports authClient", () => {
    expect(SRC).toContain("export const authClient");
  });

  it("authClient is bound to /resupply-api/auth basePath", () => {
    // The admin auth client must hit the admin endpoint,
    // not the storefront endpoint (/api/auth).
    expect(SRC).toContain('basePath: "/resupply-api/auth"');
  });

  it("does NOT reference the storefront basePath", () => {
    // Guard: the admin hooks must not accidentally bind to the customer endpoint.
    expect(SRC).not.toContain('basePath: "/api/auth"');
  });
});