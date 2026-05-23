// Tests for the report-presets API client (report-presets-api.ts).
//
// Mirrors the feature-flags-api.test.ts pattern: fetch-mocked,
// pinning request shape (URL / method / Content-Type / body) and
// error handling.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  createReportPreset,
  deleteReportPreset,
  listReportPresets,
} from "./report-presets-api";

const ORIGINAL_FETCH = globalThis.fetch;

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("listReportPresets", () => {
  it("GETs /resupply-api/admin/reports/presets with credentials + Accept", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ presets: [] }),
    });

    await listReportPresets();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/resupply-api/admin/reports/presets");
    expect((init as RequestInit).credentials).toBe("include");
    expect(
      ((init as RequestInit).headers as Record<string, string>).Accept,
    ).toBe("application/json");
  });
});

describe("createReportPreset", () => {
  it("POSTs JSON with Content-Type and returns the parsed preset", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        preset: {
          id: "p-1",
          name: "Monthly close",
          slug: "orders",
          format: "iif",
          rangeKind: "preset",
          rangePreset: "preset-last-month",
          rangeFrom: null,
          rangeTo: null,
          recipient: null,
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",
        },
      }),
    });

    const result = await createReportPreset({
      name: "Monthly close",
      slug: "orders",
      format: "iif",
      rangeKind: "preset",
      rangePreset: "preset-last-month",
    });

    expect(result.preset.id).toBe("p-1");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(
      ((init as RequestInit).headers as Record<string, string>)[
        "Content-Type"
      ],
    ).toBe("application/json");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.rangeKind).toBe("preset");
    expect(body.rangePreset).toBe("preset-last-month");
  });
});

describe("deleteReportPreset", () => {
  it("DELETEs /admin/reports/presets/:id and resolves on 204", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("204 has no body");
      },
    });

    // Should resolve cleanly, NOT call res.json().
    await expect(deleteReportPreset("p-abc")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/resupply-api/admin/reports/presets/p-abc");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("encodes the id so a path traversal can't escape", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    await deleteReportPreset("../etc/passwd");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "/resupply-api/admin/reports/presets/..%2Fetc%2Fpasswd",
    );
  });
});

describe("error handling", () => {
  it("surfaces message field over error field", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({
        message: "human-readable message",
        error: "machine_code",
      }),
    });
    await expect(listReportPresets()).rejects.toThrow(
      "human-readable message",
    );
  });

  it("falls back to '<status> <statusText>' when the body has no useful field", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({}),
    });
    await expect(listReportPresets()).rejects.toThrow("502 Bad Gateway");
  });
});
