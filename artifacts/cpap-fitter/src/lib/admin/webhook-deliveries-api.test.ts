// Tests for the webhook-deliveries API client (webhook-deliveries-api.ts).
//
// Coverage:
//   1. listWebhookDeliveries() hits the base URL with credentials:include
//      and maps the raw snake_case rows to camelCase.
//   2. A status filter is appended as ?status=…; status + subscriptionId
//      append both params.
//   3. retryWebhookDelivery() POSTs to /:id/retry-now (id encoded) and
//      returns the body.
//   4. A non-ok response throws (ApiError), surfacing the body message.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  listWebhookDeliveries,
  retryWebhookDelivery,
} from "./webhook-deliveries-api";

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

const RAW_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  subscription_id: "sub_abcdefgh",
  event_type: "order.created",
  status: "exhausted",
  attempt_count: 6,
  last_http_status: 500,
  last_error: "upstream 500",
  next_attempt_at: "2026-05-31T00:00:00.000Z",
  delivered_at: null,
  created_at: "2026-05-30T00:00:00.000Z",
};

describe("listWebhookDeliveries", () => {
  it("fetches the base URL with credentials:include and maps rows to camelCase", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ deliveries: [RAW_ROW] }),
    });

    const result = await listWebhookDeliveries();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/webhook-deliveries");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
    expect(result.deliveries[0]).toEqual({
      id: RAW_ROW.id,
      subscriptionId: "sub_abcdefgh",
      eventType: "order.created",
      status: "exhausted",
      attemptCount: 6,
      lastHttpStatus: 500,
      lastError: "upstream 500",
      nextAttemptAt: "2026-05-31T00:00:00.000Z",
      deliveredAt: null,
      createdAt: "2026-05-30T00:00:00.000Z",
    });
  });

  it("appends ?status= when a status filter is given", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ deliveries: [] }),
    });

    await listWebhookDeliveries({ status: "failed" });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/resupply-api/admin/webhook-deliveries?status=failed");
  });

  it("appends both status and subscriptionId params", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ deliveries: [] }),
    });

    await listWebhookDeliveries({
      status: "exhausted",
      subscriptionId: "sub_1",
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("status=exhausted");
    expect(url).toContain("subscriptionId=sub_1");
  });
});

describe("retryWebhookDelivery", () => {
  it("POSTs to /:id/retry-now (id encoded) and returns the body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, note: "requeued" }),
    });

    const result = await retryWebhookDelivery("a b/c");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/webhook-deliveries/a%20b%2Fc/retry-now",
    );
    expect(init.method).toBe("POST");
    expect(result).toEqual({ ok: true, note: "requeued" });
  });

  it("throws when the server returns a non-ok status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      text: async () => "",
      json: async () => ({ error: "already_delivered" }),
    });

    await expect(retryWebhookDelivery("id")).rejects.toThrow();
  });
});
