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
import { submitFitterLead, submitFitterComplete, fetchShopProducts } from "./shop-api";

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

// ── fetchShopProducts — new simplified behavior (PR change) ──────────────────
// The PR removed the 404 "unavailable" fallback and the JSON parse guard.
// 503 still degrades gracefully; any other non-ok status now THROWS instead
// of returning { unavailable: true }. A 200 with bad JSON also throws (no
// try/catch guard).

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

  test("fetches /resupply-api/shop/products with Accept: application/json", async () => {
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

  test("degrades to 'unavailable' (with server message) on 503", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: "Stripe is down" }),
    });

    const result = await fetchShopProducts();
    expect(result).toEqual({ unavailable: true, message: "Stripe is down" });
  });

  test("uses default message when 503 body has no message field", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const result = await fetchShopProducts();
    expect(result).toMatchObject({ unavailable: true });
    if ("unavailable" in result) {
      expect(result.message).toMatch(/isn't available/i);
    }
  });

  // A 404 means the JSON API call never reached a live API process: in a
  // mis-routed deploy `/resupply-api/*` falls through to the SPA host's
  // history fallback, which 404s a JSON `Accept` request. Retrying won't
  // help, so fetchShopProducts degrades to the soft "unavailable" card
  // (same as 503) rather than throwing an error at the patient. This was
  // deliberately restored after an earlier "simplify" pass made it throw;
  // keep this guard so the resilience isn't silently removed again.
  test("degrades a 404 to unavailable instead of throwing", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });

    const result = await fetchShopProducts();
    expect(result).toMatchObject({ unavailable: true });
  });

  test("throws on 500", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(fetchShopProducts()).rejects.toThrow(/500/);
  });

  // A 200 whose body isn't JSON is the same mis-routed-deploy symptom as
  // the 404 above: some static hosts answer an unknown path with the SPA
  // HTML shell and a 200. fetchShopProducts guards the res.json() parse
  // and degrades to the soft "unavailable" card rather than letting a
  // SyntaxError escape to the patient.
  test("degrades a non-JSON 200 body to unavailable instead of throwing", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });

    const result = await fetchShopProducts();
    expect(result).toMatchObject({ unavailable: true });
  });

  test("defaults previewMode to false when the field is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ products: [], categories: [], byCategory: {} }),
    });

    const result = await fetchShopProducts();
    if (!("unavailable" in result)) {
      expect(result.previewMode).toBe(false);
    }
  });
});