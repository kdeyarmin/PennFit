// Unit tests for the /admin/system-info fetch boundary in admin-settings.tsx.
//
// Why this exists: the Settings page renderer (`Body`) derefs every nested
// object of the response directly. A 200 response with a missing/partial
// shape — most notably the client-side demo sandbox's empty-object (`{}`)
// fallback for unhandled API GETs — used to slip past the `res.ok` check,
// reach `Body`, and throw a raw `TypeError` mid-render that bubbled to the
// top-level ErrorBoundary ("Something went wrong"). On the Settings page
// that also traps the user, because the demo on/off toggle lives there.
//
// fetchSystemInfo now validates the shape and rejects on a bad body, which
// routes the page to its graceful `query.isError` branch instead.

import { describe, it, expect, vi, afterEach } from "vitest";

import { fetchSystemInfo, isSystemInfo } from "./admin-settings";

const VALID = {
  server: {
    now: new Date().toISOString(),
    nodeVersion: "v24.0.0",
    pgVersion: null,
    uptimeSeconds: 100,
    gitSha: null,
    nodeEnv: "production",
  },
  database: { migrationCount: 0, lastMigrationAt: null },
  publicUrls: { shop: null, voice: null, dashboard: null },
  auth: {
    adminAllowlistCount: 0,
    agentAllowlistCount: 0,
    legacyAdminAllowlistCount: 0,
  },
  vendors: { openai: { apiKeyConfigured: false } },
  secrets: { linkHmacKeyConfigured: false },
};

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const res = {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => res),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isSystemInfo", () => {
  it("rejects the demo empty-object fallback", () => {
    expect(isSystemInfo({})).toBe(false);
  });

  it("rejects null / non-objects", () => {
    expect(isSystemInfo(null)).toBe(false);
    expect(isSystemInfo(undefined)).toBe(false);
    expect(isSystemInfo("nope")).toBe(false);
  });

  it("rejects a payload missing a single nested object", () => {
    const { secrets: _omit, ...partial } = VALID;
    expect(isSystemInfo(partial)).toBe(false);
  });

  it("accepts a fully-shaped payload", () => {
    expect(isSystemInfo(VALID)).toBe(true);
  });
});

describe("fetchSystemInfo", () => {
  it("rejects on a 200 with the empty-object body (no global crash)", async () => {
    mockFetchOnce({});
    await expect(fetchSystemInfo()).rejects.toThrow(/expected fields/i);
  });

  it("rejects on a non-ok response", async () => {
    mockFetchOnce({}, false, 403);
    await expect(fetchSystemInfo()).rejects.toThrow(/403/);
  });

  it("resolves with a fully-shaped payload", async () => {
    mockFetchOnce(VALID);
    await expect(fetchSystemInfo()).resolves.toMatchObject({
      secrets: { linkHmacKeyConfigured: false },
    });
  });
});
