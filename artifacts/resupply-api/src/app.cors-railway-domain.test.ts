// Runtime unit tests for the CORS allowedOrigins resolution logic
// added / changed in this PR.
//
// Background: app.ts's allowedOrigins IIFE was updated to accept
// RAILWAY_PUBLIC_DOMAIN (Railway's auto-injected env var) as a second
// origin source alongside RESUPPLY_ALLOWED_ORIGINS. This file tests
// every branch of that resolution logic at the pure-function level.
//
// Strategy: instead of re-importing app.ts for each scenario (which
// is expensive and has complex mock requirements), we extract the IIFE
// logic into a test-local pure function `resolveAllowedOrigins` whose
// body is a faithful copy of the source. The static-analysis tests in
// app.cors-origins.test.ts verify that the source matches this shape.
// Together the two files give full coverage: structural fidelity
// (static) + behavioral correctness (this file).
//
// The CORS origin callback (which uses allowedOrigins) is also
// reproduced verbatim so we can exercise the full allow/reject path.

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Faithful copy of the allowedOrigins IIFE from app.ts.
// Updated whenever the PR changes the logic — the static analysis tests
// will catch any drift between this copy and the source.
// ---------------------------------------------------------------------------
function resolveAllowedOrigins(env: {
  RESUPPLY_ALLOWED_ORIGINS?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
  NODE_ENV?: string;
}): string[] {
  const explicit = (env.RESUPPLY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const railwayHost = (env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  const fromRailway = railwayHost ? [`https://${railwayHost}`] : [];

  // De-dupe so a custom domain present in both lists doesn't appear twice.
  const merged = Array.from(new Set([...explicit, ...fromRailway]));
  if (merged.length > 0) return merged;

  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to start: in production at least one of " +
        "RESUPPLY_ALLOWED_ORIGINS or RAILWAY_PUBLIC_DOMAIN must be set " +
        "so the CORS allowlist is bound to vetted hostnames. Both are empty.",
    );
  }

  return [
    "http://localhost",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
  ];
}

/** Mirrors the cors `origin` callback in app.ts. */
function checkOrigin(
  allowedOrigins: string[],
  origin: string | undefined,
): true | Error {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  return new Error(`Origin ${origin} not allowed by CORS policy`);
}

// ---------------------------------------------------------------------------
// 1. RAILWAY_PUBLIC_DOMAIN as sole origin source
// ---------------------------------------------------------------------------
describe("resolveAllowedOrigins — RAILWAY_PUBLIC_DOMAIN as sole source", () => {
  const origins = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "myapp.up.railway.app",
    NODE_ENV: "production",
  });

  it("returns exactly one entry derived from RAILWAY_PUBLIC_DOMAIN", () => {
    expect(origins).toHaveLength(1);
    expect(origins[0]).toBe("https://myapp.up.railway.app");
  });

  it("allows the https:// Railway origin via the CORS callback", () => {
    expect(checkOrigin(origins, "https://myapp.up.railway.app")).toBe(true);
  });

  it("rejects an origin not in the allowlist", () => {
    expect(checkOrigin(origins, "https://evil.example.com")).toBeInstanceOf(
      Error,
    );
  });

  it("allows requests with no Origin (same-origin / server-to-server)", () => {
    expect(checkOrigin(origins, undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. https:// scheme is correctly prepended
// ---------------------------------------------------------------------------
describe("resolveAllowedOrigins — https:// scheme wrapping", () => {
  const origins = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "myapp.up.railway.app",
    NODE_ENV: "development",
  });

  it("wraps the Railway host in https://", () => {
    expect(origins).toContain("https://myapp.up.railway.app");
  });

  it("does NOT include the bare hostname (no scheme)", () => {
    expect(origins).not.toContain("myapp.up.railway.app");
  });

  it("does NOT include an http:// (plain-text) variant", () => {
    expect(origins).not.toContain("http://myapp.up.railway.app");
  });

  it("rejects bare-hostname origin via CORS callback", () => {
    expect(checkOrigin(origins, "myapp.up.railway.app")).toBeInstanceOf(Error);
  });

  it("rejects http:// origin via CORS callback", () => {
    expect(checkOrigin(origins, "http://myapp.up.railway.app")).toBeInstanceOf(
      Error,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. RESUPPLY_ALLOWED_ORIGINS still works without RAILWAY_PUBLIC_DOMAIN
// ---------------------------------------------------------------------------
describe("resolveAllowedOrigins — RESUPPLY_ALLOWED_ORIGINS alone", () => {
  const origins = resolveAllowedOrigins({
    RESUPPLY_ALLOWED_ORIGINS:
      "https://admin.example.com,https://api.example.com",
    NODE_ENV: "production",
  });

  it("includes the first explicit origin", () => {
    expect(origins).toContain("https://admin.example.com");
  });

  it("includes the second explicit origin", () => {
    expect(origins).toContain("https://api.example.com");
  });

  it("allows both explicit origins via the CORS callback", () => {
    expect(checkOrigin(origins, "https://admin.example.com")).toBe(true);
    expect(checkOrigin(origins, "https://api.example.com")).toBe(true);
  });

  it("rejects an origin not in the explicit list", () => {
    expect(checkOrigin(origins, "https://unknown.example.com")).toBeInstanceOf(
      Error,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Both sources — merged list with de-duplication
// ---------------------------------------------------------------------------
describe("resolveAllowedOrigins — both sources, merged and de-duped", () => {
  // The Railway public domain matches one entry in the explicit list
  // (simulates binding a custom domain on Railway AND listing it in
  // RESUPPLY_ALLOWED_ORIGINS).
  const origins = resolveAllowedOrigins({
    RESUPPLY_ALLOWED_ORIGINS:
      "https://shared.example.com,https://extra.example.com",
    RAILWAY_PUBLIC_DOMAIN: "shared.example.com",
    NODE_ENV: "production",
  });

  it("contains https://shared.example.com exactly once (de-dup)", () => {
    const count = origins.filter(
      (o) => o === "https://shared.example.com",
    ).length;
    expect(count).toBe(1);
  });

  it("still contains the explicit-only origin https://extra.example.com", () => {
    expect(origins).toContain("https://extra.example.com");
  });

  it("has two entries total (no phantom duplicates)", () => {
    expect(origins).toHaveLength(2);
  });

  it("allows the shared origin via the CORS callback", () => {
    expect(checkOrigin(origins, "https://shared.example.com")).toBe(true);
  });

  it("allows the extra explicit origin via the CORS callback", () => {
    expect(checkOrigin(origins, "https://extra.example.com")).toBe(true);
  });

  it("rejects an unlisted origin via the CORS callback", () => {
    expect(
      checkOrigin(origins, "https://unlisted.example.com"),
    ).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// 5. Production fail-closed guard
// ---------------------------------------------------------------------------
describe("resolveAllowedOrigins — production fail-closed", () => {
  it("throws when both vars are absent in production", () => {
    expect(() =>
      resolveAllowedOrigins({ NODE_ENV: "production" }),
    ).toThrow(/RESUPPLY_ALLOWED_ORIGINS|RAILWAY_PUBLIC_DOMAIN/);
  });

  it("throws when RESUPPLY_ALLOWED_ORIGINS is empty string and RAILWAY_PUBLIC_DOMAIN is absent", () => {
    expect(() =>
      resolveAllowedOrigins({
        RESUPPLY_ALLOWED_ORIGINS: "",
        NODE_ENV: "production",
      }),
    ).toThrow();
  });

  it("does NOT throw when only RAILWAY_PUBLIC_DOMAIN is set in production", () => {
    // Pre-PR: this would have thrown. Post-PR: must succeed.
    expect(() =>
      resolveAllowedOrigins({
        RAILWAY_PUBLIC_DOMAIN: "myapp.up.railway.app",
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });

  it("does NOT throw when only RESUPPLY_ALLOWED_ORIGINS is set in production", () => {
    expect(() =>
      resolveAllowedOrigins({
        RESUPPLY_ALLOWED_ORIGINS: "https://admin.example.com",
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });

  it("error message mentions both variable names", () => {
    expect(() =>
      resolveAllowedOrigins({ NODE_ENV: "production" }),
    ).toThrow(/RESUPPLY_ALLOWED_ORIGINS.*RAILWAY_PUBLIC_DOMAIN|RAILWAY_PUBLIC_DOMAIN.*RESUPPLY_ALLOWED_ORIGINS/);
  });
});

// ---------------------------------------------------------------------------
// 6. Dev localhost fallback (non-production, no vars set)
// ---------------------------------------------------------------------------
describe("resolveAllowedOrigins — dev localhost fallback", () => {
  const origins = resolveAllowedOrigins({ NODE_ENV: "development" });

  it("includes http://localhost", () => {
    expect(origins).toContain("http://localhost");
  });

  it("includes the Vite dev server port (localhost:5173)", () => {
    expect(origins).toContain("http://localhost:5173");
  });

  it("includes the API port (localhost:3000)", () => {
    expect(origins).toContain("http://localhost:3000");
  });

  it("includes the alternative dev port (localhost:8080)", () => {
    expect(origins).toContain("http://localhost:8080");
  });

  it("allows all four localhost origins via the CORS callback", () => {
    const ports = [
      "http://localhost",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:8080",
    ];
    for (const origin of ports) {
      expect(checkOrigin(origins, origin)).toBe(true);
    }
  });

  it("rejects a non-localhost attacker origin even in dev", () => {
    expect(
      checkOrigin(origins, "https://attacker.example.com"),
    ).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// 7. Whitespace / empty-string edge cases
// ---------------------------------------------------------------------------
describe("resolveAllowedOrigins — whitespace and empty string handling", () => {
  it("ignores whitespace-only RAILWAY_PUBLIC_DOMAIN (does not create https:// entry)", () => {
    const origins = resolveAllowedOrigins({
      RAILWAY_PUBLIC_DOMAIN: "   ",
      NODE_ENV: "development",
    });
    expect(origins).not.toContain("https://");
    expect(origins).not.toContain("https:// ");
    // Falls through to dev fallback.
    expect(origins).toContain("http://localhost:5173");
  });

  it("ignores empty RAILWAY_PUBLIC_DOMAIN", () => {
    const origins = resolveAllowedOrigins({
      RAILWAY_PUBLIC_DOMAIN: "",
      NODE_ENV: "development",
    });
    expect(origins).not.toContain("https://");
    expect(origins).toContain("http://localhost");
  });

  it("trims whitespace from RESUPPLY_ALLOWED_ORIGINS entries", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "  https://admin.example.com  , https://api.example.com ",
      NODE_ENV: "development",
    });
    expect(origins).toContain("https://admin.example.com");
    expect(origins).toContain("https://api.example.com");
    // Must not include the padded version.
    expect(origins).not.toContain("  https://admin.example.com  ");
  });

  it("filters blank entries from RESUPPLY_ALLOWED_ORIGINS (e.g. trailing comma)", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://admin.example.com,",
      NODE_ENV: "development",
    });
    // Only one real entry; the trailing-comma empty string is dropped.
    expect(origins.filter((o) => o === "")).toHaveLength(0);
    expect(origins).toContain("https://admin.example.com");
  });
});
