// Behavioural test pinning the CSRF header on shop-api's hand-rolled
// signed-in mutations.
//
// `resendOrderReceipt` and `updateOrderShippingAddress` POST to
// requireSignedIn routes, and the server's app-level CSRF gate
// (requireCsrfWhenSessionOnShopMutations) rejects any shop mutation
// that carries a pf_session cookie without an X-PF-CSRF header. Both
// wrappers shipped WITHOUT the header — a deterministic 403 for every
// signed-in customer (docs/app-review-2026-06-10.md P0-3) that route
// unit tests can't see because they mount the router without the
// app-level middleware. This test captures the headers each wrapper
// actually sends, mirroring custom-fetch-csrf.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

import { resendOrderReceipt, updateOrderShippingAddress } from "./shop-api";

const ORIGINAL_FETCH = globalThis.fetch;

function setupMocks(cookie: string, responseBody: unknown) {
  (globalThis as unknown as { document?: unknown }).document = { cookie };
  const captured: { url: string; headers: Record<string, string> }[] = [];
  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const headersObj: Record<string, string> = {};
    if (init.headers && typeof init.headers === "object") {
      for (const [k, v] of Object.entries(
        init.headers as Record<string, string>,
      )) {
        headersObj[k.toLowerCase()] = v;
      }
    }
    captured.push({
      url: typeof input === "string" ? input : String(input),
      headers: headersObj,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
  return captured;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete (globalThis as unknown as { document?: unknown }).document;
  vi.restoreAllMocks();
});

describe("shop-api signed-in mutations attach X-PF-CSRF", () => {
  it("resendOrderReceipt sends the header from the pf_csrf cookie", async () => {
    const captured = setupMocks("pf_csrf=tok-1", {
      sent: true,
      email: "a***@example.com",
    });
    await resendOrderReceipt("cs_test_123");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers["x-pf-csrf"]).toBe("tok-1");
  });

  it("updateOrderShippingAddress sends the header from the pf_csrf cookie", async () => {
    const captured = setupMocks("pf_csrf=tok-2", {
      order: {
        id: "o1",
        shippingAddress: {},
        shippedAt: null,
        canEditAddress: true,
      },
    });
    await updateOrderShippingAddress("o1", {
      name: "Pat Example",
      line1: "1 Main St",
      city: "Philadelphia",
      state: "PA",
      postalCode: "19103",
      country: "US",
    } as Parameters<typeof updateOrderShippingAddress>[1]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.headers["x-pf-csrf"]).toBe("tok-2");
  });
});
