import { describe, expect, test, vi } from "vitest";

import { openBillingPortal } from "./account-api";

describe("openBillingPortal", () => {
  test("throws billing_portal_retired without calling the network", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(openBillingPortal()).rejects.toThrow(/billing_portal_retired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
