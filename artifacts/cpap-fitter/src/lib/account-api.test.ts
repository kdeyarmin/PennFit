// Tests for the openBillingPortal API wrapper in account-api.ts.
//
// openBillingPortal() is the only new export introduced in this PR.
// It delegates to the private meFetch helper which:
//   * sends credentials: "include"
//   * reads pf_csrf from document.cookie for write requests
//   * adds X-PF-CSRF header when a CSRF token is present
//   * throws AccountApiError on non-OK responses
//
// In the vitest node environment `document` is undefined so
// getCsrfToken() returns null and no CSRF header is emitted. We
// verify the header is absent in that case and also simulate a
// browser environment with a stubbed cookie string.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { AccountApiError, openBillingPortal } from "./account-api";

const ORIGINAL_FETCH = globalThis.fetch;
// document is undefined in the node test environment; we poke a fake
// one in when we need to test CSRF header behaviour.
const ORIGINAL_DOCUMENT = globalThis.document;

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Ensure document is clean before each test.
  // @ts-expect-error – assigning undefined to a required global for testing
  globalThis.document = undefined;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  // @ts-expect-error — the test runs in node where globalThis.document
  // is undefined; we restore the (possibly-undefined) original.
  globalThis.document = ORIGINAL_DOCUMENT;
  vi.restoreAllMocks();
});

describe("openBillingPortal", () => {
  test("posts to /resupply-api/shop/me/billing-portal", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/session/test" }),
    });

    await openBillingPortal();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/shop/me/billing-portal");
  });

  test("uses POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/session/test" }),
    });

    await openBillingPortal();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  test("sends credentials: include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/session/test" }),
    });

    await openBillingPortal();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  test("serialises returnPath as JSON body with default /account", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/session/test" }),
    });

    await openBillingPortal();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ returnPath: "/account" });
  });

  test("serialises a custom returnPath into the body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/session/test" }),
    });

    await openBillingPortal("/account?tab=billing");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      returnPath: "/account?tab=billing",
    });
  });

  test("sends Content-Type: application/json because a body is present", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/session/test" }),
    });

    await openBillingPortal();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/session/test" }),
    });

    await openBillingPortal();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("does NOT send X-PF-CSRF when document is undefined (node env)", async () => {
    // document is undefined in the node test environment.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/session/test" }),
    });

    await openBillingPortal();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBeUndefined();
  });

  test("sends X-PF-CSRF header when pf_csrf cookie is present", async () => {
    // Simulate browser environment with a CSRF cookie.
    // @ts-expect-error – assigning a fake document for testing
    globalThis.document = { cookie: "pf_csrf=test-csrf-token-abc" };

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/session/test" }),
    });

    await openBillingPortal();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBe("test-csrf-token-abc");
  });

  test("returns the url from the response", async () => {
    const portalUrl = "https://billing.stripe.com/session/xyz123";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: portalUrl }),
    });

    const result = await openBillingPortal();
    expect(result.url).toBe(portalUrl);
  });

  test("throws AccountApiError with status 503 on shop-unavailable response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: "shop_unavailable",
        message: "Shop is not configured",
      }),
    });

    const err = await openBillingPortal().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountApiError);
    expect((err as AccountApiError).status).toBe(503);
  });

  test("throws AccountApiError with status 401 on unauthenticated response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "sign_in_required" }),
    });

    const err = await openBillingPortal().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountApiError);
    expect((err as AccountApiError).status).toBe(401);
  });

  test("throws AccountApiError when response.json() throws (no body)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("no body");
      },
    });

    const err = await openBillingPortal().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountApiError);
    expect((err as AccountApiError).status).toBe(502);
  });

  test("AccountApiError.payload carries the error code from the response body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "shop_unavailable" }),
    });

    const err = await openBillingPortal().catch((e: unknown) => e);
    expect((err as AccountApiError).payload).toEqual({
      error: "shop_unavailable",
    });
  });

  test("calls fetch exactly once per invocation", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://billing.stripe.com/test" }),
    });

    await openBillingPortal();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
