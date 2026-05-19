// Tests for the openBillingPortal function added in the insurance-claims PR.
//
// Coverage:
//   * openBillingPortal POSTs to /resupply-api/shop/me/billing-portal
//   * default returnPath is "/account"
//   * custom returnPath is passed through in the body
//   * returns the { url } object from the server
//   * throws AccountApiError on 503 (shop not configured)
//   * throws AccountApiError on other 4xx/5xx with status attached
//   * JSON parse failure on error still throws AccountApiError

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { AccountApiError, openBillingPortal } from "./account-api";

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

function okFetch(body: unknown): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function errorFetch(status: number, body: unknown = null): void {
  fetchMock.mockResolvedValue({
    ok: false,
    status,
    json: async () => body,
  });
}

describe("openBillingPortal", () => {
  it("POSTs to /resupply-api/shop/me/billing-portal", async () => {
    okFetch({ url: "https://billing.stripe.com/session/xyz" });
    await openBillingPortal();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/shop/me/billing-portal");
    expect(init.method).toBe("POST");
  });

  it("uses credentials: include for the request", async () => {
    okFetch({ url: "https://billing.stripe.com/session/xyz" });
    await openBillingPortal();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("sends Accept: application/json header", async () => {
    okFetch({ url: "https://billing.stripe.com/session/xyz" });
    await openBillingPortal();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  it("defaults returnPath to /account", async () => {
    okFetch({ url: "https://billing.stripe.com/session/abc" });
    await openBillingPortal();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { returnPath: string };
    expect(body.returnPath).toBe("/account");
  });

  it("passes a custom returnPath in the request body", async () => {
    okFetch({ url: "https://billing.stripe.com/session/abc" });
    await openBillingPortal("/account/billing");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { returnPath: string };
    expect(body.returnPath).toBe("/account/billing");
  });

  it("returns the url from the server response", async () => {
    const expectedUrl = "https://billing.stripe.com/session/return-me";
    okFetch({ url: expectedUrl });
    const result = await openBillingPortal();
    expect(result.url).toBe(expectedUrl);
  });

  it("throws AccountApiError with status 503 when shop is not configured", async () => {
    errorFetch(503, { error: "shop_unavailable" });
    await expect(openBillingPortal()).rejects.toMatchObject(
      expect.objectContaining({ status: 503 }),
    );
  });

  it("throws AccountApiError (not a plain Error) on 503", async () => {
    errorFetch(503, { error: "shop_unavailable" });
    await expect(openBillingPortal()).rejects.toBeInstanceOf(AccountApiError);
  });

  it("throws AccountApiError with the server status on 502", async () => {
    errorFetch(502, { error: "stripe_portal_unavailable" });
    const err = await openBillingPortal().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountApiError);
    expect((err as AccountApiError).status).toBe(502);
  });

  it("throws AccountApiError with status on 401 (sign in required)", async () => {
    errorFetch(401, { error: "sign_in_required" });
    const err = await openBillingPortal().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountApiError);
    expect((err as AccountApiError).status).toBe(401);
  });

  it("still throws AccountApiError when the error response body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    const err = await openBillingPortal().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountApiError);
    expect((err as AccountApiError).status).toBe(500);
  });

  it("serialises the body as JSON (Content-Type reflects the body presence)", async () => {
    okFetch({ url: "https://billing.stripe.com/session/x" });
    await openBillingPortal("/account");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // meFetch adds Content-Type when body is present
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});