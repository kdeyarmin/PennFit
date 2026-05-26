// Tests for lib/admin/delivery-failures-api.ts
//
// The system-events stream reads from the retired `audit_log` table, so
// the route short-circuits to a degraded response (CLAUDE.md hard rule:
// no new `audit_log` readers). DeliveryFailuresResponse therefore models
// that contract:
//   - `auditEventsUnavailable?` (audit-log retirement notice flag)
//   - `counts.auditFailures` is `number | null` (null when unavailable)
//
// Coverage:
//   1. DeliveryFailuresResponse carries `auditEventsUnavailable`.
//   2. counts.auditFailures is typed as `number | null`.
//   3. fetchDeliveryFailures() calls the correct URL.
//   4. fetchDeliveryFailures() uses the sinceDays parameter.
//   5. fetchDeliveryFailures() propagates HTTP errors.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchDeliveryFailures } from "./delivery-failures-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "delivery-failures-api.ts"),
  "utf8",
);

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

// ---------------------------------------------------------------------------
// Type shape — DeliveryFailuresResponse
// ---------------------------------------------------------------------------

// The interface's own closing brace sits at column 0 (`\n}`), so anchor
// on that rather than the first `}` — which would stop inside the inline
// `counts: { ... }` object literal.
function deliveryFailuresIfaceBody(): string {
  const ifaceStart = SRC.indexOf("interface DeliveryFailuresResponse {");
  expect(ifaceStart).toBeGreaterThan(-1);
  const ifaceEnd = SRC.indexOf("\n}", ifaceStart);
  expect(ifaceEnd).toBeGreaterThan(-1);
  return SRC.slice(ifaceStart, ifaceEnd);
}

describe("delivery-failures-api — DeliveryFailuresResponse type shape", () => {
  it("declares the `auditEventsUnavailable` retirement flag", () => {
    expect(deliveryFailuresIfaceBody()).toContain("auditEventsUnavailable");
  });

  it("counts.auditFailures is nullable (`number | null` — null when unavailable)", () => {
    expect(deliveryFailuresIfaceBody()).toContain(
      "auditFailures: number | null",
    );
  });

  it("declares all expected top-level fields", () => {
    const ifaceBody = deliveryFailuresIfaceBody();
    expect(ifaceBody).toContain("sinceDays");
    expect(ifaceBody).toContain("counts");
    expect(ifaceBody).toContain("failureStatuses");
    expect(ifaceBody).toContain("messageEvents");
    expect(ifaceBody).toContain("auditEvents");
  });
});

// ---------------------------------------------------------------------------
// fetchDeliveryFailures() — network behaviour
// ---------------------------------------------------------------------------

describe("fetchDeliveryFailures", () => {
  it("calls the correct URL with the default sinceDays=14", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        sinceDays: 14,
        counts: { messageFailures: 0, auditFailures: 0 },
        failureStatuses: [],
        messageEvents: [],
        auditEvents: [],
      }),
    });

    await fetchDeliveryFailures();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/delivery-failures?sinceDays=14",
    );
  });

  it("passes a custom sinceDays value in the query string", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        sinceDays: 7,
        counts: { messageFailures: 3, auditFailures: 1 },
        failureStatuses: ["failed"],
        messageEvents: [],
        auditEvents: [],
      }),
    });

    await fetchDeliveryFailures(7);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("sinceDays=7");
  });

  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        sinceDays: 14,
        counts: { messageFailures: 0, auditFailures: 0 },
        failureStatuses: [],
        messageEvents: [],
        auditEvents: [],
      }),
    });

    await fetchDeliveryFailures();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
  });

  it("returns the parsed JSON body on success", async () => {
    const payload = {
      sinceDays: 14,
      counts: { messageFailures: 2, auditFailures: 1 },
      failureStatuses: ["failed", "undelivered"],
      messageEvents: [
        {
          kind: "message" as const,
          id: "msg-1",
          occurredAt: "2026-05-01T10:00:00Z",
          channel: "sms" as const,
          direction: "outbound",
          senderRole: "system",
          deliveryStatus: "failed",
          deliveryError: "30005",
          conversationId: null,
          patientId: "p-123",
          patientName: "Jane Doe",
        },
      ],
      auditEvents: [],
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await fetchDeliveryFailures(14);
    expect(result).toEqual(payload);
  });

  it("throws when the server returns a non-ok status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    });

    await expect(fetchDeliveryFailures()).rejects.toThrow("Failed to load failures (403)");
  });

  // Negative / boundary: the response should work even when auditFailures
  // is 0 (not null), confirming the non-nullable typing in practice.
  it("handles a response where auditFailures is 0 (non-null numeric value)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        sinceDays: 14,
        counts: { messageFailures: 5, auditFailures: 0 },
        failureStatuses: [],
        messageEvents: [],
        auditEvents: [],
      }),
    });

    const result = await fetchDeliveryFailures();
    expect(result.counts.auditFailures).toBe(0);
  });
});