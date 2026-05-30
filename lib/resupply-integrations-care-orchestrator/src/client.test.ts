// Tests for the fetchWithTimeout helper introduced in the PR, exercised
// through the public fetchCareOrchestratorSnapshot function.
//
// Scope: only the timeout / error-mapping logic added by this PR.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CareOrchestratorConfig } from "./config";
import { fetchCareOrchestratorSnapshot } from "./client";

const CONFIG: CareOrchestratorConfig = {
  apiBaseUrl: "https://care.example.com",
  oauthTokenUrl: "https://care.example.com/oauth/token",
  clientId: "co-client",
  clientSecret: "co-secret",
  partnerId: "partner-99",
};

function makeTokenResponse() {
  return new Response(
    JSON.stringify({ access_token: "tok-co", expires_in: 3600 }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

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
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── TimeoutError mapping ──────────────────────────────────────────────────────

describe("fetchWithTimeout → TimeoutError (CareOrchestrator)", () => {
  it("maps TimeoutError on API call to { ok: false, error: 'unavailable' }", async () => {
    const timeoutErr = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    });

    vi.stubGlobal(
      "fetch",
      mockFetch(() => Promise.reject(timeoutErr)),
    );

    const result = await fetchCareOrchestratorSnapshot(CONFIG, {
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

    const result = await fetchCareOrchestratorSnapshot(CONFIG, {
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

describe("fetchWithTimeout → AbortError (CareOrchestrator)", () => {
  it("maps AbortError to { ok: false, error: 'unavailable' }", async () => {
    const abortErr = Object.assign(new Error("AbortError"), {
      name: "AbortError",
    });

    vi.stubGlobal(
      "fetch",
      mockFetch(() => Promise.reject(abortErr)),
    );

    const result = await fetchCareOrchestratorSnapshot(CONFIG, {
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

describe("fetchWithTimeout → TypeError (CareOrchestrator)", () => {
  it("maps TypeError (network failure) to { ok: false, error: 'unavailable' }", async () => {
    const netErr = Object.assign(new TypeError("Failed to fetch"), {
      name: "TypeError",
    });

    vi.stubGlobal(
      "fetch",
      mockFetch(() => Promise.reject(netErr)),
    );

    const result = await fetchCareOrchestratorSnapshot(CONFIG, {
      partnerPatientId: "p4",
      windowDays: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unavailable");
    }
  });
});

// ── Unknown error re-thrown ───────────────────────────────────────────────────

describe("fetchWithTimeout → unknown error type (CareOrchestrator)", () => {
  it("re-throws non-mapped errors, surfacing as unknown_error", async () => {
    const weirdErr = Object.assign(new Error("something internal"), {
      name: "CustomError",
    });

    vi.stubGlobal(
      "fetch",
      mockFetch(() => Promise.reject(weirdErr)),
    );

    const result = await fetchCareOrchestratorSnapshot(CONFIG, {
      partnerPatientId: "p5",
      windowDays: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unknown_error");
    }
  });

  it("non-Error throws surface as unknown_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/oauth/token")) return makeTokenResponse();
        throw "string exception";
      }),
    );

    const result = await fetchCareOrchestratorSnapshot(CONFIG, {
      partnerPatientId: "p6",
      windowDays: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("unknown_error");
    }
  });
});

// ── Happy path (regression guard) ────────────────────────────────────────────

describe("fetchWithTimeout → successful request (CareOrchestrator)", () => {
  it("returns ok:true with snapshot data when upstream responds correctly", async () => {
    const deviceResp = new Response(
      JSON.stringify({ modelName: "DreamStation 2", serialNumber: "DS-001" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const therapyResp = new Response(
      JSON.stringify({
        sessions: [{ sessionDate: "2024-01-01", usageMinutes: 300, ahi: 1.5 }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const suppliesResp = new Response(JSON.stringify({ supplies: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const s = String(url);
        if (s.includes("/oauth/token")) return makeTokenResponse();
        if (s.includes("/device")) return deviceResp;
        if (s.includes("/sessions")) return therapyResp;
        if (s.includes("/supplies")) return suppliesResp;
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );

    const result = await fetchCareOrchestratorSnapshot(CONFIG, {
      partnerPatientId: "patient-co-1",
      windowDays: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.source).toBe("philips_care");
      expect(result.snapshot.settings?.deviceModel).toBe("DreamStation 2");
    }
  });
});

// ── configKey secret rotation — cache invalidation (PR change) ───────────────
//
// PR change: configKey() now includes a SHA-256 hash of the client secret
// so rotating the secret invalidates any cached OAuth token minted with
// the old secret. Without this, the stale token would be reused until
// it naturally expired, causing 401s on every API call.
//
// The configKey function is private; we test the observable contract:
// when the only difference between two configs is the clientSecret, the
// OAuth /token endpoint must be called again (cache miss).

describe("configKey secret rotation — CareOrchestrator cache invalidation (PR change)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
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
            JSON.stringify({ access_token: "tok-co-123", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const { fetchCareOrchestratorSnapshot: snap } = await import("./client");

    const CONFIG_A: CareOrchestratorConfig = {
      ...CONFIG,
      clientSecret: "co-secret-v1",
    };
    const CONFIG_B: CareOrchestratorConfig = {
      ...CONFIG,
      clientSecret: "co-secret-v2",
    };

    // First call: primes the cache with co-secret-v1's token
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
    expect(tokenFetchCountAfterRotation).toBeGreaterThan(
      tokenFetchCountAfterRepeat,
    );
  });

  it("uses the same cached token for repeated calls with the same config", async () => {
    const tokenFetchCount = { count: 0 };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/oauth/token")) {
          tokenFetchCount.count++;
          return new Response(
            JSON.stringify({ access_token: "tok-co-stable", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({}), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const { fetchCareOrchestratorSnapshot: snap } = await import("./client");

    await snap(CONFIG, { partnerPatientId: "p1", windowDays: 1 });
    const afterFirst = tokenFetchCount.count;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await snap(CONFIG, { partnerPatientId: "p1", windowDays: 1 });
    // Token fetch count must NOT increase — cache was used
    expect(tokenFetchCount.count).toBe(afterFirst);
  });
});
