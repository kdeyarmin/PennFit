// Tests for appointment-requests-api.ts — fetch wrappers for /admin/appointment-requests
//
// Coverage:
//   jsonFetch shared behaviour   — URL, credentials, Accept header, error handling
//   listAppointmentRequests      — GET with/without includeClosed flag
//   updateAppointmentRequest     — PATCH for status and field updates

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  listAppointmentRequests,
  updateAppointmentRequest,
} from "./appointment-requests-api";

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
// jsonFetch shared behaviour (via listAppointmentRequests)
// ---------------------------------------------------------------------------

describe("jsonFetch shared behaviour (via listAppointmentRequests)", () => {
  test("requests the correct URL with /resupply-api prefix", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requests: [] }),
    });

    await listAppointmentRequests();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/appointment-requests");
  });

  test("sends credentials: include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requests: [] }),
    });

    await listAppointmentRequests();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requests: [] }),
    });

    await listAppointmentRequests();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("throws Error on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    });

    await expect(listAppointmentRequests()).rejects.toThrow("403");
  });

  test("throws using message field from error JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable",
      json: async () => ({ message: "invalid status transition" }),
    });

    await expect(listAppointmentRequests()).rejects.toThrow(
      "invalid status transition",
    );
  });

  test("throws using error field when message is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "bad_input" }),
    });

    await expect(listAppointmentRequests()).rejects.toThrow("bad_input");
  });

  test("falls back to status when JSON body is not parseable", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(listAppointmentRequests()).rejects.toThrow("500");
  });

  test("calls fetch exactly once per invocation", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requests: [] }),
    });

    await listAppointmentRequests();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// listAppointmentRequests
// ---------------------------------------------------------------------------

const SAMPLE_REQUEST = {
  id: "req-1",
  requesterEmail: "patient@example.com",
  requesterName: "Jane Doe",
  requesterPhone: null,
  topic: "mask fitting",
  preferredWindow: "mornings",
  notes: null,
  status: "new" as const,
  attachedPatientId: null,
  assignedAdminUserId: null,
  triagedAt: null,
  scheduledFor: null,
  createdAt: "2025-01-01T10:00:00Z",
};

describe("listAppointmentRequests", () => {
  test("requests /admin/appointment-requests without query string by default", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requests: [] }),
    });

    await listAppointmentRequests();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/appointment-requests");
    expect(url).not.toContain("include=closed");
  });

  test("appends ?include=closed when includeClosed is true", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requests: [] }),
    });

    await listAppointmentRequests(true);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/appointment-requests?include=closed");
  });

  test("does not append the query string when includeClosed is false", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requests: [] }),
    });

    await listAppointmentRequests(false);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("include=closed");
  });

  test("returns the parsed requests array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requests: [SAMPLE_REQUEST] }),
    });

    const result = await listAppointmentRequests();
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.requesterEmail).toBe("patient@example.com");
    expect(result.requests[0]!.status).toBe("new");
  });

  test("returns an empty requests array when none exist", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requests: [] }),
    });

    const result = await listAppointmentRequests();
    expect(result.requests).toEqual([]);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "ISE",
      json: async () => ({}),
    });
    await expect(listAppointmentRequests()).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// updateAppointmentRequest
// ---------------------------------------------------------------------------

describe("updateAppointmentRequest", () => {
  test("sends PATCH to /resupply-api/admin/appointment-requests/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await updateAppointmentRequest("req-abc", { status: "contacted" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/appointment-requests/req-abc");
    expect(init.method).toBe("PATCH");
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await updateAppointmentRequest("req-1", { status: "scheduled" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("serialises status change in the request body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await updateAppointmentRequest("req-1", { status: "declined" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ status: "declined" });
  });

  test("serialises all optional fields when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const body = {
      status: "scheduled" as const,
      attachedPatientId: "pt-999",
      assignedAdminUserId: "admin-001",
      scheduledFor: "2025-03-01T09:00:00Z",
      notes: "Called, left message",
    };
    await updateAppointmentRequest("req-1", body);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  test("serialises null values for clearable fields", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await updateAppointmentRequest("req-1", {
      attachedPatientId: null,
      scheduledFor: null,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);
    expect(parsed.attachedPatientId).toBeNull();
    expect(parsed.scheduledFor).toBeNull();
  });

  test("returns { ok: true } on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await updateAppointmentRequest("req-1", {
      status: "contacted",
    });
    expect(result).toEqual({ ok: true });
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
    });
    await expect(
      updateAppointmentRequest("req-ghost", { status: "contacted" }),
    ).rejects.toThrow("404");
  });

  test("throws using message from error JSON when non-OK", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ message: "already in terminal state" }),
    });
    await expect(
      updateAppointmentRequest("req-1", { status: "cancelled" }),
    ).rejects.toThrow("already in terminal state");
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await updateAppointmentRequest("req-1", { status: "contacted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
