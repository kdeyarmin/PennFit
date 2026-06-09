// @vitest-environment jsdom
//
// Tests for createPaymentCheckoutSession after the PR removed csrfHeader()
// and the X-PF-CSRF header injection. The function now posts to
// /api/me/payments/checkout-session WITHOUT the X-PF-CSRF header.
//
// Also covers the formatMoneyCents utility.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  createAutopaySetupSession,
  createPaymentCheckoutSession,
  fetchClaimDetail,
  fetchClaims,
  fetchPaymentMethods,
  formatMoneyCents,
  removePaymentMethod,
  setAutopayEnabled,
} from "./me-billing-api";

// ── fetch mock ──────────────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ── createPaymentCheckoutSession — request wiring ───────────────────────────

describe("createPaymentCheckoutSession — request wiring", () => {
  const VALID_RESPONSE = {
    paymentId: "pay_123",
    url: "https://checkout.stripe.com/test",
    amountCents: 10000,
  };

  it("POSTs to /api/me/payments/checkout-session", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/payments/checkout-session");
  });

  it("uses method POST", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  it("sends credentials: include", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  // Regression: the PR removed csrfHeader() and X-PF-CSRF injection from
  // createPaymentCheckoutSession. This test pins that it is GONE so no
  // accidental re-introduction sends the header from this call.
  it("does NOT send X-PF-CSRF header (csrfHeader removed in PR)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBeUndefined();
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

  it("serialises an empty allocations array", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    await createPaymentCheckoutSession({ allocations: [] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ allocations: [] });
  });

  it("returns the checkout session response on success", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => VALID_RESPONSE,
    });

    const result = await createPaymentCheckoutSession({ allocations: [] });
    expect(result).toEqual(VALID_RESPONSE);
  });
});

// ── createPaymentCheckoutSession — error handling ───────────────────────────

describe("createPaymentCheckoutSession — error handling", () => {
  it("throws with the error field from the JSON body on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "csrf_failed" }),
    });

    await expect(
      createPaymentCheckoutSession({ allocations: [] }),
    ).rejects.toThrow("csrf_failed");
  });

  it("throws with the message field from the JSON body on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ message: "missing allocations" }),
    });

    await expect(
      createPaymentCheckoutSession({ allocations: [] }),
    ).rejects.toThrow("missing allocations");
  });

  it("throws with a status-code message when error body has no message/error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(
      createPaymentCheckoutSession({ allocations: [] }),
    ).rejects.toThrow(/500/);
  });

  it("throws even when res.json() itself throws on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(
      createPaymentCheckoutSession({ allocations: [] }),
    ).rejects.toThrow(/502/);
  });
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

// ── payment methods + autopay ───────────────────────────────────────────────

describe("fetchPaymentMethods", () => {
  it("GETs /api/me/payment-methods with credentials", async () => {
    const body = {
      hasCard: true,
      autopayEnabled: false,
      card: null,
      authorizedAt: null,
    };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body });
    const result = await fetchPaymentMethods();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/payment-methods");
    expect(init.credentials).toBe("include");
    expect(result).toEqual(body);
  });
});

describe("createAutopaySetupSession", () => {
  it("POSTs the enableAutopay flag to setup-session", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "https://checkout.stripe.com/setup" }),
    });
    const result = await createAutopaySetupSession({ enableAutopay: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/payment-methods/setup-session");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ enableAutopay: true });
    expect(result.url).toBe("https://checkout.stripe.com/setup");
  });

  it("surfaces the server error message on failure", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: "stripe_not_configured" }),
    });
    await expect(
      createAutopaySetupSession({ enableAutopay: false }),
    ).rejects.toThrow("stripe_not_configured");
  });
});

describe("setAutopayEnabled", () => {
  it("PATCHes the enabled flag to /autopay", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, autopayEnabled: false }),
    });
    await setAutopayEnabled(false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/payment-methods/autopay");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
  });
});

describe("removePaymentMethod", () => {
  it("DELETEs /api/me/payment-methods without a body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });
    await removePaymentMethod();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/payment-methods");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
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
