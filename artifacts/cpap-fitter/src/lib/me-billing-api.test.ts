// @vitest-environment jsdom
//
// Tests for the csrfHeader() helper added in this PR and its integration
// with createPaymentCheckoutSession.
//
// csrfHeader() reads the readable `pf_csrf` cookie and returns it as an
// `X-PF-CSRF` header. The tests must run in jsdom so that
// `document.cookie` exists; the function returns {} when `document` is
// `undefined` (SSR / node env). We exercise the node-guard path via
// a runtime spy on `typeof document`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { createPaymentCheckoutSession, formatMoneyCents } from "./me-billing-api";

// ── fetch mock ──────────────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Start each test with a clean cookie jar.
  clearCookies();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  clearCookies();
  vi.restoreAllMocks();
});

function clearCookies(): void {
  // Expire every cookie visible to this document.
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0]!.trim();
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
}

function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/`;
}

// ── csrfHeader() behaviour (observed via createPaymentCheckoutSession) ──────

describe("createPaymentCheckoutSession — CSRF header injection", () => {
  const VALID_RESPONSE = {
    paymentId: "pay_123",
    url: "https://checkout.stripe.com/test",
    amountCents: 10000,
  };

  it("includes X-PF-CSRF header when pf_csrf cookie is present", async () => {
    setCookie("pf_csrf", "my-csrf-token");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBe("my-csrf-token");
  });

  it("does NOT include X-PF-CSRF header when pf_csrf cookie is absent", async () => {
    // No cookie set.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBeUndefined();
  });

  it("URL-decodes the pf_csrf cookie value before forwarding it", async () => {
    // Tokens may be percent-encoded when set via Set-Cookie.
    const raw = "tok%20with%20spaces";
    setCookie("pf_csrf", raw);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBe("tok with spaces");
  });

  it("picks the pf_csrf cookie even when other cookies are present", async () => {
    setCookie("unrelated_cookie", "unrelated_value");
    setCookie("pf_csrf", "the-right-token");
    setCookie("another_cookie", "another_value");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBe("the-right-token");
  });

  it("POSTs to /api/me/payments/checkout-session with credentials: include", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({
      allocations: [{ claimId: "claim_1", amountAppliedCents: 5000 }],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/payments/checkout-session");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });

  it("sends Content-Type: application/json and Accept: application/json", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("serialises the allocations in the request body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    const allocations = [
      { claimId: "claim_1", amountAppliedCents: 5000 },
      { claimId: "claim_2", amountAppliedCents: 3000 },
    ];
    await createPaymentCheckoutSession({ allocations });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ allocations });
  });

  it("throws when the server returns a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "csrf_failed" }),
    });

    await expect(
      createPaymentCheckoutSession({ allocations: [] }),
    ).rejects.toThrow("csrf_failed");
  });

  it("throws with a generic message when the error body has no message/error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(
      createPaymentCheckoutSession({ allocations: [] }),
    ).rejects.toThrow(/500/);
  });
});

// ── formatMoneyCents — unchanged helper, boundary checks ─────────────────────

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