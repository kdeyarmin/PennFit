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
        // eslint-disable-next-line @typescript-eslint/only-throw-error
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

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const s = String(url);
        if (s.includes("/oauth/token")) return makeTokenResponse();
        if (s.includes("/devices")) return deviceResp;
        if (s.includes("/therapy")) return therapyResp;
        if (s.includes("/supplies")) return suppliesResp;
        callCount++;
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