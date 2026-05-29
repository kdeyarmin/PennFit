// Tests for the submitFitterLead API wrapper in shop-api.ts.
//
// Covers the fetch contract for the fitter-consent capture endpoint:
//   * happy path — 200 with { ok: true }
//   * HTTP error with a JSON error code
//   * HTTP error when response.json() throws (no body)
//   * HTTP error when JSON body lacks an `error` string field
//   * correct HTTP method, URL, and Content-Type header
//   * honeypot field is serialised into the request body unchanged

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import {
  submitFitterLead,
  submitFitterComplete,
  fetchShopProducts,
} from "./shop-api";

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

const VALID_INPUT = {
  email: "alice@example.com",
  marketingOptIn: true,
  website: "",
};

describe("submitFitterLead", () => {
  test("returns { ok: true } when the server responds 200", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await submitFitterLead(VALID_INPUT);
    expect(result).toEqual({ ok: true });
  });

  test("posts to /resupply-api/shop/fitter-leads with POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await submitFitterLead(VALID_INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/shop/fitter-leads");
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json and Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await submitFitterLead(VALID_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
  });

  test("serialises the input as JSON in the request body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await submitFitterLead(VALID_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(VALID_INPUT);
  });

  test("passes the honeypot website field through in the body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await submitFitterLead({ ...VALID_INPUT, website: "http://spam.example" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.website).toBe("http://spam.example");
  });

  test("throws an Error with the JSON error code on a non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "marketing_opt_in_required" }),
    });

    await expect(submitFitterLead(VALID_INPUT)).rejects.toThrow(
      "marketing_opt_in_required",
    );
  });

  test("throws http_<status> when JSON response has no error string field", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "some message without error key" }),
    });

    await expect(submitFitterLead(VALID_INPUT)).rejects.toThrow("http_400");
  });

  test("throws http_<status> when response.json() throws (no JSON body)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("invalid json");
      },
    });

    await expect(submitFitterLead(VALID_INPUT)).rejects.toThrow("http_500");
  });

  test("throws http_429 on rate-limit response with no JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => {
        throw new SyntaxError("unexpected end of JSON");
      },
    });

    await expect(submitFitterLead(VALID_INPUT)).rejects.toThrow("http_429");
  });
});

// ─────────────────────────────────────────────────────────────────
// submitFitterComplete
// ─────────────────────────────────────────────────────────────────
//
// Covers:
//   * happy path with enrolled=true
//   * enrolled=false when body.enrolled is falsy
//   * HTTP error with a JSON error code
//   * HTTP error when JSON body has no error string
//   * HTTP error when response.json() throws
//   * correct method, URL, and headers

const VALID_COMPLETE_INPUT = {
  email: "alice@example.com",
  recommendedMaskId: "mask-airfit-p30i",
  recommendedMaskName: "ResMed AirFit P30i",
  recommendedMaskType: "nasalPillow" as const,
};

describe("submitFitterComplete", () => {
  test("returns { ok: true, enrolled: true } when the server responds 200 with enrolled=true", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, enrolled: true }),
    });

    const result = await submitFitterComplete(VALID_COMPLETE_INPUT);
    expect(result).toEqual({ ok: true, enrolled: true });
  });

  test("returns { ok: true, enrolled: false } when body.enrolled is falsy", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, enrolled: false }),
    });

    const result = await submitFitterComplete(VALID_COMPLETE_INPUT);
    expect(result).toEqual({ ok: true, enrolled: false });
  });

  test("treats a missing enrolled field as false", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await submitFitterComplete(VALID_COMPLETE_INPUT);
    expect(result.enrolled).toBe(false);
  });

  test("POSTs to /resupply-api/shop/fitter-complete", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, enrolled: true }),
    });

    await submitFitterComplete(VALID_COMPLETE_INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/shop/fitter-complete");
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json and Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, enrolled: true }),
    });

    await submitFitterComplete(VALID_COMPLETE_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
  });

  test("serialises all four input fields as JSON in the request body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, enrolled: true }),
    });

    await submitFitterComplete(VALID_COMPLETE_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.email).toBe(VALID_COMPLETE_INPUT.email);
    expect(body.recommendedMaskId).toBe(VALID_COMPLETE_INPUT.recommendedMaskId);
    expect(body.recommendedMaskName).toBe(VALID_COMPLETE_INPUT.recommendedMaskName);
    expect(body.recommendedMaskType).toBe(VALID_COMPLETE_INPUT.recommendedMaskType);
  });

  test("throws an Error with the JSON error code on a non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_body" }),
    });

    await expect(submitFitterComplete(VALID_COMPLETE_INPUT)).rejects.toThrow(
      "invalid_body",
    );
  });

  test("throws http_<status> when JSON body has no error string field", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: "unprocessable" }),
    });

    await expect(submitFitterComplete(VALID_COMPLETE_INPUT)).rejects.toThrow(
      "http_422",
    );
  });

  test("throws http_<status> when response.json() throws (no JSON body)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("invalid json");
      },
    });

    await expect(submitFitterComplete(VALID_COMPLETE_INPUT)).rejects.toThrow(
      "http_500",
    );
  });

  test("throws http_429 on rate-limit with no JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(submitFitterComplete(VALID_COMPLETE_INPUT)).rejects.toThrow(
      "http_429",
    );
  });
});

describe("fetchShopProducts", () => {
  const CATALOG = {
    previewMode: false,
    categories: ["mask"],
    products: [{ id: "prod_1", name: "Mask" }],
    byCategory: { mask: [{ id: "prod_1", name: "Mask" }] },
  };

  test("returns the catalog on a 200 JSON response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CATALOG,
    });

    const result = await fetchShopProducts();
    expect("unavailable" in result).toBe(false);
    expect(result).toMatchObject({
      previewMode: false,
      products: [{ id: "prod_1", name: "Mask" }],
    });
  });

  test("fetches /resupply-api/shop/products with a JSON Accept header", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CATALOG,
    });

    await fetchShopProducts();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/shop/products");
    expect((init.headers as Record<string, string>).Accept).toBe(
      "application/json",
    );
  });

  test("degrades to 'unavailable' (with the server message) on 503", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: "Stripe is down" }),
    });

    const result = await fetchShopProducts();
    expect(result).toEqual({ unavailable: true, message: "Stripe is down" });
  });

  // Regression: a misconfigured deploy where /resupply-api/* isn't
  // routed to a live API lands this call on the SPA history-fallback,
  // which returns 404 for a JSON request. We must NOT throw
  // "Failed to load shop products (404)" at the patient — degrade to
  // the friendly "unavailable" card instead.
  test("degrades to 'unavailable' on 404 instead of throwing", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    const result = await fetchShopProducts();
    expect("unavailable" in result).toBe(true);
    if ("unavailable" in result) {
      expect(result.unavailable).toBe(true);
      expect(result.message).toMatch(/isn't available/i);
    }
  });

  // A 200 whose body is the SPA HTML shell (some static hosts answer
  // unknown paths with index.html + 200) must not throw a SyntaxError
  // out of res.json() — it degrades gracefully.
  test("degrades to 'unavailable' when a 200 body isn't JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });

    const result = await fetchShopProducts();
    expect("unavailable" in result).toBe(true);
  });

  // 5xx still throws so the shop page's one-shot auto-retry can ride
  // out a transient server blip (existing behavior, preserved).
  test("throws on a 500 so the caller can auto-retry", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(fetchShopProducts()).rejects.toThrow(/500/);
  });
});