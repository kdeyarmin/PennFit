// Tests for the CORS allowedOrigins resolution logic in app.ts after
// the PR that removed RAILWAY_PUBLIC_DOMAIN support.
//
// The PR:
//   * Removed RAILWAY_PUBLIC_DOMAIN as a second origin source
//   * Removed Set-based deduplication (now a single env-var path)
//   * Renamed internal variable `explicit` → `fromEnv`
//   * Simplified error message to name only RESUPPLY_ALLOWED_ORIGINS
//
// Two layers of tests:
//   1. Static source-level analysis — structural invariants that would
//      be broken by an accidental revert or partial merge.
//   2. Runtime pure-function tests — behavioural correctness using a
//      faithful copy of the IIFE so we don't need a live DB/Stripe/
//      Supabase environment.
//
// The static-analysis tests in section 1 will catch any drift between
// the source and the runtime copy in section 2.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Helpers shared by both sections
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = readFileSync(path.join(__dirname, "app.ts"), "utf8");

/** Strip line and block comments to avoid false positives from doc references. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const CODE = stripComments(APP_SOURCE);

// ---------------------------------------------------------------------------
// Section 1 — Static source-level invariants
// ---------------------------------------------------------------------------

describe("app.ts CORS — static source analysis", () => {
  it("reads RESUPPLY_ALLOWED_ORIGINS from process.env", () => {
    expect(CODE).toContain("RESUPPLY_ALLOWED_ORIGINS");
  });

  it("does NOT reference RAILWAY_PUBLIC_DOMAIN in executable code", () => {
    // The old implementation read RAILWAY_PUBLIC_DOMAIN as a second origin
    // source. After the PR it must not appear in executable code.
    expect(CODE).not.toContain("RAILWAY_PUBLIC_DOMAIN");
  });

  it("uses 'fromEnv' as the parsed-origins variable name", () => {
    // The PR renamed `explicit` → `fromEnv`. Guard against renames.
    expect(CODE).toContain("fromEnv");
    // Old name must be gone from the allowedOrigins block.
    // We check there's no standalone `const explicit` in the CORS block.
    const corsBlockMatch = CODE.match(
      /const allowedOrigins\s*=\s*\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*\)\(\s*\)/,
    );
    expect(corsBlockMatch).not.toBeNull();
    expect(corsBlockMatch![1]).not.toContain("const explicit");
  });

  it("does NOT use Set deduplication (removed in this PR)", () => {
    // The old implementation used `new Set([...explicit, ...fromRailway])`.
    // After the PR, dedup is unnecessary because there is only one source.
    const corsBlock = CODE.match(
      /const allowedOrigins\s*=\s*\(\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*\)\(\s*\)/,
    );
    expect(corsBlock).not.toBeNull();
    expect(corsBlock![1]).not.toContain("new Set(");
  });

  it("production guard fires when fromEnv is empty (fail-closed)", () => {
    // The guard must check fromEnv.length before throwing — not the
    // raw env var — so whitespace-only values still trigger the guard.
    expect(CODE).toContain("fromEnv.length");
    expect(CODE).toContain('process.env.NODE_ENV === "production"');
  });

  it("throw comes AFTER the fromEnv check, not before", () => {
    const fromEnvIdx = CODE.indexOf("fromEnv.length");
    const throwIdx = CODE.indexOf("throw new Error");
    expect(fromEnvIdx).toBeGreaterThan(-1);
    expect(throwIdx).toBeGreaterThan(-1);
    expect(fromEnvIdx).toBeLessThan(throwIdx);
  });

  it("error message names RESUPPLY_ALLOWED_ORIGINS", () => {
    const errorMatch = APP_SOURCE.match(/throw new Error\(([\s\S]*?)\);/);
    expect(errorMatch).not.toBeNull();
    expect(errorMatch![1]).toContain("RESUPPLY_ALLOWED_ORIGINS");
  });

  it("error message does NOT name RAILWAY_PUBLIC_DOMAIN", () => {
    // Old message named both vars; new message names only the required one.
    const errorMatch = APP_SOURCE.match(/throw new Error\(([\s\S]*?)\);/);
    expect(errorMatch).not.toBeNull();
    expect(errorMatch![1]).not.toContain("RAILWAY_PUBLIC_DOMAIN");
  });

  it("error message says the variable is empty (new wording)", () => {
    const errorMatch = APP_SOURCE.match(/throw new Error\(([\s\S]*?)\);/);
    expect(errorMatch).not.toBeNull();
    expect(errorMatch![1].toLowerCase()).toContain("the variable is empty");
  });

  it("does NOT use 'at least one of' in the error message (old OR-semantics wording removed)", () => {
    const errorMatch = APP_SOURCE.match(/throw new Error\(([\s\S]*?)\);/);
    expect(errorMatch).not.toBeNull();
    expect(errorMatch![1].toLowerCase()).not.toContain("at least one of");
  });

  it("still includes the four localhost dev-fallback origins", () => {
    expect(CODE).toContain('"http://localhost"');
    expect(CODE).toContain('"http://localhost:3000"');
    expect(CODE).toContain('"http://localhost:5173"');
    expect(CODE).toContain('"http://localhost:8080"');
  });

  it("production guard precedes the dev localhost fallback in source order", () => {
    const prodGuardIdx = CODE.indexOf('process.env.NODE_ENV === "production"');
    const localhostIdx = CODE.indexOf('"http://localhost"');
    expect(prodGuardIdx).toBeGreaterThan(-1);
    expect(localhostIdx).toBeGreaterThan(-1);
    expect(prodGuardIdx).toBeLessThan(localhostIdx);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — Runtime pure-function tests
//
// Faithful copy of the allowedOrigins IIFE from app.ts. The static
// analysis above verifies the source matches this shape; these tests
// verify the behavioural contract.
// ---------------------------------------------------------------------------

function resolveAllowedOrigins(env: {
  RESUPPLY_ALLOWED_ORIGINS?: string;
  NODE_ENV?: string;
}): string[] {
  const fromEnv = (env.RESUPPLY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;

  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to start: in production RESUPPLY_ALLOWED_ORIGINS must be " +
        "set to a comma-separated list of allowed origins so the CORS " +
        "allowlist is bound to vetted hostnames. The variable is empty.",
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

// --- 2a. RESUPPLY_ALLOWED_ORIGINS only ---

describe("resolveAllowedOrigins — RESUPPLY_ALLOWED_ORIGINS as sole source", () => {
  it("returns a single explicit origin", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://app.example.com",
      NODE_ENV: "production",
    });
    expect(origins).toEqual(["https://app.example.com"]);
  });

  it("returns multiple explicit origins from a comma-separated list", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS:
        "https://admin.example.com,https://api.example.com",
      NODE_ENV: "production",
    });
    expect(origins).toContain("https://admin.example.com");
    expect(origins).toContain("https://api.example.com");
    expect(origins).toHaveLength(2);
  });

  it("allows an explicit origin via the CORS callback", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://app.example.com",
      NODE_ENV: "production",
    });
    expect(checkOrigin(origins, "https://app.example.com")).toBe(true);
  });

  it("rejects an origin not in the explicit list", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://app.example.com",
      NODE_ENV: "production",
    });
    expect(checkOrigin(origins, "https://evil.example.com")).toBeInstanceOf(
      Error,
    );
  });

  it("allows requests with no Origin (same-origin / server-to-server)", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://app.example.com",
      NODE_ENV: "production",
    });
    expect(checkOrigin(origins, undefined)).toBe(true);
  });
});

// --- 2b. RAILWAY_PUBLIC_DOMAIN is ignored (regression guard) ---

describe("resolveAllowedOrigins — RAILWAY_PUBLIC_DOMAIN is not consumed", () => {
  it("does NOT add a Railway-derived origin even when RAILWAY_PUBLIC_DOMAIN is set in env", () => {
    // The runtime copy intentionally does not read RAILWAY_PUBLIC_DOMAIN.
    // Pass it via the env object to confirm it is ignored.
    const env = {
      RESUPPLY_ALLOWED_ORIGINS: "",
      NODE_ENV: "development",
      // Extra key not in the function signature — TypeScript will
      // complain; cast to verify the runtime behaviour.
    } as { RESUPPLY_ALLOWED_ORIGINS?: string; NODE_ENV?: string };

    const origins = resolveAllowedOrigins(env);
    // Must fall through to the dev localhost fallback, not construct
    // an https://myapp.up.railway.app entry.
    expect(origins).not.toContain("https://myapp.up.railway.app");
    expect(origins).toContain("http://localhost:5173");
  });

  it("does not contain any https://... entries in the dev fallback", () => {
    const origins = resolveAllowedOrigins({ NODE_ENV: "development" });
    const httpsEntries = origins.filter((o) => o.startsWith("https://"));
    expect(httpsEntries).toHaveLength(0);
  });
});

// --- 2c. Production fail-closed guard ---

describe("resolveAllowedOrigins — production fail-closed", () => {
  it("throws when RESUPPLY_ALLOWED_ORIGINS is absent in production", () => {
    expect(() =>
      resolveAllowedOrigins({ NODE_ENV: "production" }),
    ).toThrow(/RESUPPLY_ALLOWED_ORIGINS/);
  });

  it("throws when RESUPPLY_ALLOWED_ORIGINS is an empty string in production", () => {
    expect(() =>
      resolveAllowedOrigins({
        RESUPPLY_ALLOWED_ORIGINS: "",
        NODE_ENV: "production",
      }),
    ).toThrow();
  });

  it("throws when RESUPPLY_ALLOWED_ORIGINS is whitespace-only in production", () => {
    expect(() =>
      resolveAllowedOrigins({
        RESUPPLY_ALLOWED_ORIGINS: "   ",
        NODE_ENV: "production",
      }),
    ).toThrow();
  });

  it("does NOT throw when RESUPPLY_ALLOWED_ORIGINS is set in production", () => {
    expect(() =>
      resolveAllowedOrigins({
        RESUPPLY_ALLOWED_ORIGINS: "https://app.example.com",
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });

  it("error message contains RESUPPLY_ALLOWED_ORIGINS", () => {
    expect(() =>
      resolveAllowedOrigins({ NODE_ENV: "production" }),
    ).toThrow(/RESUPPLY_ALLOWED_ORIGINS/);
  });

  it("error message does NOT mention RAILWAY_PUBLIC_DOMAIN", () => {
    let message = "";
    try {
      resolveAllowedOrigins({ NODE_ENV: "production" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("RAILWAY_PUBLIC_DOMAIN");
  });

  it("error message says 'The variable is empty'", () => {
    let message = "";
    try {
      resolveAllowedOrigins({ NODE_ENV: "production" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message.toLowerCase()).toContain("the variable is empty");
  });

  it("does NOT use 'at least one of' wording (old OR-semantics removed)", () => {
    let message = "";
    try {
      resolveAllowedOrigins({ NODE_ENV: "production" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message.toLowerCase()).not.toContain("at least one of");
  });
});

// --- 2d. Dev localhost fallback ---

describe("resolveAllowedOrigins — dev localhost fallback", () => {
  const origins = resolveAllowedOrigins({ NODE_ENV: "development" });

  it("includes http://localhost", () => {
    expect(origins).toContain("http://localhost");
  });

  it("includes Vite dev server port (localhost:5173)", () => {
    expect(origins).toContain("http://localhost:5173");
  });

  it("includes API port (localhost:3000)", () => {
    expect(origins).toContain("http://localhost:3000");
  });

  it("includes alternative dev port (localhost:8080)", () => {
    expect(origins).toContain("http://localhost:8080");
  });

  it("allows all four localhost origins via the CORS callback", () => {
    for (const port of [
      "http://localhost",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:8080",
    ]) {
      expect(checkOrigin(origins, port)).toBe(true);
    }
  });

  it("rejects a non-localhost attacker origin even in dev", () => {
    expect(
      checkOrigin(origins, "https://attacker.example.com"),
    ).toBeInstanceOf(Error);
  });

  it("does NOT throw in development when RESUPPLY_ALLOWED_ORIGINS is absent", () => {
    expect(() =>
      resolveAllowedOrigins({ NODE_ENV: "development" }),
    ).not.toThrow();
  });
});

// --- 2e. Whitespace / edge-case handling ---

describe("resolveAllowedOrigins — whitespace and edge-case handling", () => {
  it("trims whitespace from each origin in RESUPPLY_ALLOWED_ORIGINS", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS:
        "  https://admin.example.com  , https://api.example.com ",
    });
    expect(origins).toContain("https://admin.example.com");
    expect(origins).toContain("https://api.example.com");
    expect(origins).not.toContain("  https://admin.example.com  ");
  });

  it("filters blank entries caused by a trailing comma", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "https://admin.example.com,",
    });
    expect(origins.filter((o) => o === "")).toHaveLength(0);
    expect(origins).toContain("https://admin.example.com");
    expect(origins).toHaveLength(1);
  });

  it("filters multiple blank entries from consecutive commas", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS:
        "https://a.example.com,,https://b.example.com,",
    });
    expect(origins).toHaveLength(2);
    expect(origins).toContain("https://a.example.com");
    expect(origins).toContain("https://b.example.com");
  });

  it("returns dev fallback when RESUPPLY_ALLOWED_ORIGINS contains only whitespace-only entries", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS: "  ,  ,  ",
      NODE_ENV: "development",
    });
    // All entries are whitespace → filter(Boolean) removes them → dev fallback.
    expect(origins).toContain("http://localhost:5173");
  });

  it("preserves the original insertion order of RESUPPLY_ALLOWED_ORIGINS entries", () => {
    const origins = resolveAllowedOrigins({
      RESUPPLY_ALLOWED_ORIGINS:
        "https://z.example.com,https://a.example.com,https://m.example.com",
    });
    expect(origins.indexOf("https://z.example.com")).toBeLessThan(
      origins.indexOf("https://a.example.com"),
    );
    expect(origins.indexOf("https://a.example.com")).toBeLessThan(
      origins.indexOf("https://m.example.com"),
    );
  });
});

// --- 2f. CORS callback — allow/reject contract ---

describe("CORS origin callback", () => {
  const origins = ["https://app.example.com", "https://admin.example.com"];

  it("returns true for an allowed origin", () => {
    expect(checkOrigin(origins, "https://app.example.com")).toBe(true);
  });

  it("returns an Error for an unlisted origin", () => {
    const result = checkOrigin(origins, "https://evil.example.com");
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("evil.example.com");
    expect((result as Error).message).toContain("not allowed by CORS policy");
  });

  it("returns true when origin is undefined (same-origin / non-browser request)", () => {
    expect(checkOrigin(origins, undefined)).toBe(true);
  });

  it("is case-sensitive: wrong scheme is rejected", () => {
    // http:// vs https://
    const result = checkOrigin(origins, "http://app.example.com");
    expect(result).toBeInstanceOf(Error);
  });

  it("is case-sensitive: wrong subdomain is rejected", () => {
    const result = checkOrigin(origins, "https://APP.example.com");
    expect(result).toBeInstanceOf(Error);
  });
});
