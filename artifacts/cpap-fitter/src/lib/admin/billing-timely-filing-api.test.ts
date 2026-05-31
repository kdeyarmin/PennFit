// Tests for the timely-filing API client (billing-timely-filing-api.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { listTimelyFiling } from "./billing-timely-filing-api";

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

const BODY = {
  claims: [],
  counts: { overdue: 0, dueSoon: 0, ok: 0, unknown: 0, total: 0 },
  generatedAt: "2026-05-31T00:00:00.000Z",
};

describe("listTimelyFiling", () => {
  it("fetches the base URL with credentials:include when no filter is given", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => BODY,
    });

    const result = await listTimelyFiling();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/billing/timely-filing");
    expect(init.credentials).toBe("include");
    expect(result.counts.total).toBe(0);
  });

  it("omits the query string for the 'all' filter", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => BODY,
    });
    await listTimelyFiling("all");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/resupply-api/admin/billing/timely-filing");
  });

  it("appends ?status= for a specific bucket", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => BODY,
    });
    await listTimelyFiling("overdue");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "/resupply-api/admin/billing/timely-filing?status=overdue",
    );
  });

  it("throws when the server returns a non-ok status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers(),
      text: async () => "",
      json: async () => ({ requiredPermission: "reports.read" }),
    });

    await expect(listTimelyFiling()).rejects.toThrow();
  });
});
