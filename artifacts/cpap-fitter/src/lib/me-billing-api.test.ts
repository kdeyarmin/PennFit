// @vitest-environment jsdom
//
// Tests for the patient billing API wrapper, including CSRF wiring for
// signed-in /api/me/* mutations and the formatMoneyCents utility.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  fetchClaimDetail,
  fetchClaims,
  formatMoneyCents,
} from "./me-billing-api";

// ── fetch mock ──────────────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function setDocumentCookie(raw: string): void {
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => raw,
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  setDocumentCookie("");
});

// ── formatMoneyCents ─────────────────────────────────────────────────────────

describe("formatMoneyCents", () => {
  it("formats whole-dollar amounts", () => {
    expect(formatMoneyCents(1000)).toBe("$10.00");
  });

  it("formats fractional-cent amounts", () => {
    expect(formatMoneyCents(199)).toBe("$1.99");
  });

  it("returns em-dash for null", () => {
    expect(formatMoneyCents(null)).toBe("—");
  });

  it("returns em-dash for undefined", () => {
    expect(formatMoneyCents(undefined)).toBe("—");
  });

  it("returns em-dash for NaN", () => {
    expect(formatMoneyCents(NaN)).toBe("—");
  });

  it("formats zero", () => {
    expect(formatMoneyCents(0)).toBe("$0.00");
  });
});

// ── claims (charges & credits) ───────────────────────────────────────────────

describe("fetchClaims / fetchClaimDetail", () => {
  it("GETs the claims list", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ claims: [] }),
    });
    await fetchClaims();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/claims");
  });

  it("GETs a single claim's detail by id", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ claim: {}, lineItems: [], events: [] }),
    });
    await fetchClaimDetail("claim-123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/claims/claim-123");
    expect(init.credentials).toBe("include");
  });
});
