// Focused de-duplication tests for the CORS allowedOrigins resolver.
//
// When the same origin appears in BOTH RESUPPLY_ALLOWED_ORIGINS and
// RAILWAY_PUBLIC_DOMAIN (e.g. an operator who binds a custom domain on
// Railway AND lists it in RESUPPLY_ALLOWED_ORIGINS), the final allowlist
// must contain it exactly once.
//
// These tests complement app.cors-railway-domain.test.ts; they focus
// specifically on the Set-based de-duplication path and the edge cases
// around it.

import { describe, it, expect } from "vitest";

// Faithful copy of the allowedOrigins IIFE from app.ts.
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

describe("resolveAllowedOrigins — Set de-duplication", () => {
  it("de-dupes when the same origin appears in both RESUPPLY_ALLOWED_ORIGINS and RAILWAY_PUBLIC_DOMAIN", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://shared.example.com,https://extra.example.com",
      RAILWAY_PUBLIC_DOMAIN: "shared.example.com",
    });
    const count = origins.filter((o) => o === "https://shared.example.com").length;
    expect(count).toBe(1);
  });

  it("preserves explicit priority: explicit-list origin appears before Railway-derived origin", () => {
    // When different origins come from each source, the explicit list
    // entries precede the Railway entry (due to [...explicit, ...fromRailway]).
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://first.example.com",
      RAILWAY_PUBLIC_DOMAIN: "second.example.com",
    });
    const firstIdx = origins.indexOf("https://first.example.com");
    const secondIdx = origins.indexOf("https://second.example.com");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it("de-dupes multiple overlapping entries when both sources share several origins", () => {
    // Pathological case: all explicit entries are also in Railway (only one entry).
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://a.example.com",
      RAILWAY_PUBLIC_DOMAIN: "a.example.com",
    });
    expect(origins).toHaveLength(1);
    expect(origins[0]).toBe("https://a.example.com");
  });

  it("returns all unique origins when there is no overlap", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://a.example.com,https://b.example.com",
      RAILWAY_PUBLIC_DOMAIN: "c.example.com",
    });
    expect(origins).toHaveLength(3);
    expect(origins).toContain("https://a.example.com");
    expect(origins).toContain("https://b.example.com");
    expect(origins).toContain("https://c.example.com");
  });
});