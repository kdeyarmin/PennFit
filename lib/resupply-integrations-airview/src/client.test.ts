// Tests for the fetchWithTimeout helper introduced in the PR, exercised
// through the public fetchAirviewSnapshot function.
//
// Scope: only the timeout / error-mapping logic added by this PR.
// Pre-existing HTTP status mapping is NOT retested here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AirviewConfig } from "./config";
import { fetchAirviewSnapshot } from "./client";

const CONFIG: AirviewConfig = {
  apiBaseUrl: "https://airview.example.com",
  oauthTokenUrl: "https://airview.example.com/oauth/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  dmeId: "dme-42",
};

/** Minimal successful OAuth token response. */
function makeTokenResponse() {
  return new Response(
    JSON.stringify({ access_token: "tok-abc", expires_in: 3600 }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * Mock global fetch to return the token response for OAuth URLs and
 * the provided `apiResponse` for all other URLs.
 */
function mockFetch(
  apiResponse: Response | (() => Promise<never>),
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/oauth/token")) {
      return makeTokenResponse();
    }
    if (typeof apiResponse === "function") {
      return apiResponse();
    }
    return apiResponse;
  });
}

beforeEach(() => {
  // Vitest isolates module state, but the module-level cachedToken in
  // client.ts can persist within a test file. Force the cache to miss by
  // resetting the module between tests via explicit mock management.
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── TimeoutError mapping ──────────────────────────────────────────────────────

describe("fetchWithTimeout → TimeoutError on API call", () => {
  it("maps TimeoutError to { ok: false, error: 'unavailable' }", async () => {
    const timeoutErr = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/oauth/token")) return makeTokenResponse();
        throw timeoutErr;
      }),
    );

    const result = await fetchAirviewSnapshot(CONFIG, {
      partnerPatientId: "p1",
      windowDays: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });

  it("maps TimeoutError on OAuth fetch to { ok: false, error: 'unavailable' }", async () => {
    const timeoutErr = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutErr;
      }),
    );

    const result = await fetchAirviewSnapshot(CONFIG, {
      partnerPatientId: "p2",
      windowDays: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });
});

// ── AbortError mapping ────────────────────────────────────────────────────────

describe("fetchWithTimeout → AbortError on API call", () => {
  it("maps AbortError to { ok: false, error: 'unavailable' }", async () => {
    const abortErr = Object.assign(new Error("AbortError"), {
      name: "AbortError",
    });

    vi.stubGlobal("fetch", mockFetch(() => Promise.reject(abortErr)));

    const result = await fetchAirviewSnapshot(CONFIG, {
      partnerPatientId: "p3",
      windowDays: 14,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });
});

// ── TypeError mapping ─────────────────────────────────────────────────────────

describe("fetchWithTimeout → TypeError on API call", () => {
  it("maps TypeError (network failure) to { ok: false, error: 'unavailable' }", async () => {
    const netErr = Object.assign(new TypeError("Failed to fetch"), {
      name: "TypeError",
    });

    vi.stubGlobal("fetch", mockFetch(() => Promise.reject(netErr)));

    const result = await fetchAirviewSnapshot(CONFIG, {
      partnerPatientId: "p4",
      windowDays: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });
});

// ── Unknown / non-classified error is re-thrown ───────────────────────────────

describe("fetchWithTimeout → unknown error type", () => {
  it("re-throws errors that are not TimeoutError/AbortError/TypeError, surfacing as unknown_error", async () => {
    // An Error whose name is none of the mapped names should propagate
    // and be caught by fetchAirviewSnapshot's outer catch, returning unknown_error.
    const weirdErr = Object.assign(new Error("something internal"), {
      name: "CustomError",
    });

    vi.stubGlobal("fetch", mockFetch(() => Promise.reject(weirdErr)));

    const result = await fetchAirviewSnapshot(CONFIG, {
      partnerPatientId: "p5",
      windowDays: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unknown_error");
    }
  });

  it("non-Error throws propagate as unknown_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/oauth/token")) return makeTokenResponse();
        // Throwing a non-Error (string) must not accidentally map to unavailable.
        throw "string exception";
      }),
    );

    const result = await fetchAirviewSnapshot(CONFIG, {
      partnerPatientId: "p6",
      windowDays: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unknown_error");
    }
  });
});

// ── parseTimeoutEnv — env-variable-driven timeout configuration ───────────────
//
// parseTimeoutEnv is module-level code evaluated at import time.
// To test it with different env values we must reset the module registry
// so the module re-evaluates with fresh process.env values.

describe("parseTimeoutEnv via env variable overrides", () => {
  // Save / restore the env vars touched by these tests.
  const OAUTH_KEY = "RESUPPLY_AIRVIEW_OAUTH_TIMEOUT_MS";
  const API_KEY = "RESUPPLY_AIRVIEW_API_TIMEOUT_MS";
  const originalOauth = process.env[OAUTH_KEY];
  const originalApi = process.env[API_KEY];

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalOauth === undefined) delete process.env[OAUTH_KEY];
    else process.env[OAUTH_KEY] = originalOauth;
    if (originalApi === undefined) delete process.env[API_KEY];
    else process.env[API_KEY] = originalApi;
  });

  it("uses the default 30 s OAuth timeout when env var is unset", async () => {
    delete process.env[OAUTH_KEY];
    vi.resetModules();

    // Spy on AbortSignal.timeout BEFORE loading the module so we capture
    // the timeout value passed to it on the OAuth fetch.
    const timeouts: number[] = [];
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return origTimeout(ms);
    });

    // Import fresh module to pick up the (reset) env.
    const { fetchAirviewSnapshot: snap } = await import("./client");

    // Make OAuth call fail immediately so we only capture the OAuth timeout.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("abort"), { name: "TimeoutError" });
      }),
    );

    await snap(CONFIG, { partnerPatientId: "px", windowDays: 30 });

    // The first AbortSignal.timeout call is from the OAuth fetch (30 s default).
    expect(timeouts[0]).toBe(30_000);
  });

  it("applies an explicit OAuth timeout from env var", async () => {
    process.env[OAUTH_KEY] = "10000"; // 10 seconds
    vi.resetModules();

    const timeouts: number[] = [];
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return origTimeout(ms);
    });

    const { fetchAirviewSnapshot: snap } = await import("./client");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("abort"), { name: "TimeoutError" });
      }),
    );

    await snap(CONFIG, { partnerPatientId: "px", windowDays: 30 });

    expect(timeouts[0]).toBe(10_000);
  });

  it("caps the OAuth timeout at 5 minutes (300 000 ms) for extreme values", async () => {
    process.env[OAUTH_KEY] = "999999999"; // way over 5 min
    vi.resetModules();

    const timeouts: number[] = [];
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return origTimeout(ms);
    });

    const { fetchAirviewSnapshot: snap } = await import("./client");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("abort"), { name: "TimeoutError" });
      }),
    );

    await snap(CONFIG, { partnerPatientId: "px", windowDays: 30 });

    // Must be capped at exactly 5 * 60 * 1000.
    expect(timeouts[0]).toBe(5 * 60_000);
  });

  it("falls back to the default when env var is not a valid number", async () => {
    process.env[OAUTH_KEY] = "not-a-number";
    vi.resetModules();

    const timeouts: number[] = [];
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return origTimeout(ms);
    });

    const { fetchAirviewSnapshot: snap } = await import("./client");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("abort"), { name: "TimeoutError" });
      }),
    );

    await snap(CONFIG, { partnerPatientId: "px", windowDays: 30 });

    // Non-numeric env var must fall through to 30 s default.
    expect(timeouts[0]).toBe(30_000);
  });

  it("falls back to the default when env var is zero or negative", async () => {
    process.env[OAUTH_KEY] = "0";
    vi.resetModules();

    const timeouts: number[] = [];
    const origTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return origTimeout(ms);
    });

    const { fetchAirviewSnapshot: snap } = await import("./client");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("abort"), { name: "TimeoutError" });
      }),
    );

    await snap(CONFIG, { partnerPatientId: "px", windowDays: 30 });

    expect(timeouts[0]).toBe(30_000);
  });
});

// ── Happy path (regression guard) ────────────────────────────────────────────

describe("fetchWithTimeout → successful request", () => {
  it("returns ok:true with snapshot data when upstream responds correctly", async () => {
    const deviceResp = new Response(
      JSON.stringify({ model: "AirSense 11", serialNumber: "SN-001" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const therapyResp = new Response(
      JSON.stringify({ nights: [{ date: "2024-01-01", usageMinutes: 360, ahi: 2 }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const suppliesResp = new Response(
      JSON.stringify({ items: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const s = String(url);
        if (s.includes("/oauth/token")) return makeTokenResponse();
        if (s.includes("/devices")) return deviceResp;
        if (s.includes("/therapy")) return therapyResp;
        if (s.includes("/supplies")) return suppliesResp;
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const result = await fetchAirviewSnapshot(CONFIG, {
      partnerPatientId: "patient-1",
      windowDays: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.source).toBe("resmed_airview");
      expect(result.snapshot.settings?.deviceModel).toBe("AirSense 11");
    }
  });
});

// ── configKey secret rotation (PR change) ────────────────────────────────────
//
// PR change: configKey() now includes a SHA-256 hash of the client secret
// so rotating the secret invalidates any cached OAuth token minted with
// the old secret. Without this, the stale token would be reused until
// it naturally expired (up to 1 hour), causing 401s on every API call.
//
// The configKey function is private; we test the observable contract:
// when the only difference between two configs is the clientSecret, the
// OAuth /token endpoint must be called again (cache miss).

describe("configKey secret rotation — cache invalidation (PR change)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // Reset module-level cachedToken between tests by reloading the module
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a new OAuth token when the clientSecret changes", async () => {
    const tokenFetchUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const s = String(url);
        tokenFetchUrls.push(s);
        if (s.includes("/oauth/token")) {
          return new Response(
            JSON.stringify({ access_token: "tok-123", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // API call returns empty/error so we can focus on token calls
        return new Response(
          JSON.stringify({ error: "not_found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    // Re-import with clean module cache to reset cachedToken
    const { fetchAirviewSnapshot: snap } = await import("./client");

    const CONFIG_A: AirviewConfig = {
      ...CONFIG,
      clientSecret: "secret-v1",
    };
    const CONFIG_B: AirviewConfig = {
      ...CONFIG,
      clientSecret: "secret-v2",
    };

    // First call: primes the cache with secret-v1's token
    await snap(CONFIG_A, { partnerPatientId: "p1", windowDays: 1 });
    const tokenFetchCountAfterFirst = tokenFetchUrls.filter((u) =>
      u.includes("/oauth/token"),
    ).length;

    // Second call with the same config: cache hit, no new token fetch
    await snap(CONFIG_A, { partnerPatientId: "p1", windowDays: 1 });
    const tokenFetchCountAfterRepeat = tokenFetchUrls.filter((u) =>
      u.includes("/oauth/token"),
    ).length;
    expect(tokenFetchCountAfterRepeat).toBe(tokenFetchCountAfterFirst);

    // Third call with rotated secret: cache miss → new token fetch
    await snap(CONFIG_B, { partnerPatientId: "p1", windowDays: 1 });
    const tokenFetchCountAfterRotation = tokenFetchUrls.filter((u) =>
      u.includes("/oauth/token"),
    ).length;
    expect(tokenFetchCountAfterRotation).toBeGreaterThan(tokenFetchCountAfterRepeat);
  });

  it("uses the same cached token for repeated calls with the same config", async () => {
    const tokenFetchCount = { count: 0 };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/oauth/token")) {
          tokenFetchCount.count++;
          return new Response(
            JSON.stringify({ access_token: "tok-stable", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({}),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const { fetchAirviewSnapshot: snap } = await import("./client");

    await snap(CONFIG, { partnerPatientId: "p1", windowDays: 1 });
    const afterFirst = tokenFetchCount.count;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await snap(CONFIG, { partnerPatientId: "p1", windowDays: 1 });
    // Token fetch count must NOT increase — cache was used
    expect(tokenFetchCount.count).toBe(afterFirst);
  });
});