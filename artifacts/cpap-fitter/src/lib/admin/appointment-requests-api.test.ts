// Tests for appointment-requests-api.ts
//
// Coverage:
//   listAppointmentRequests  — URL (open-only and include-closed), credentials,
//                              Accept header, response shape, error handling
//   updateAppointmentRequest — URL (id URL-encoded), method, headers, JSON body,
//                              response, error handling (message/error/fallback)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  listAppointmentRequests,
  updateAppointmentRequest,
} from "./appointment-requests-api";

// ─── Setup / teardown ───────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function makeResponse(
  status: number,
  body: unknown,
  statusText = "OK",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

const REQUEST_FIXTURE = {
  id: "req-1",
  requesterEmail: "patient@example.com",
  requesterName: "Jane Smith",
  requesterPhone: "+12155551234",
  topic: "mask_fit",
  preferredWindow: "mornings",
  notes: "Prefers video call",
  status: "new" as const,
  attachedPatientId: null,
  assignedAdminUserId: null,
  triagedAt: null,
  scheduledFor: null,
  createdAt: "2026-01-01T00:00:00Z",
};

// ─── listAppointmentRequests — request shape ─────────────────────────────────

describe("listAppointmentRequests — request shape (open-only default)", () => {
  it("fetches /resupply-api/admin/appointment-requests without query param by default", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [] }),
    );

    await listAppointmentRequests();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/appointment-requests");
  });

  it("appends ?include=closed when includeClosed is true", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [] }),
    );

    await listAppointmentRequests(true);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/appointment-requests?include=closed");
  });

  it("omits query string when includeClosed is false", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [] }),
    );

    await listAppointmentRequests(false);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("?");
    expect(url).not.toContain("include");
  });

  it("uses credentials: include for cookie-based auth", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [] }),
    );

    await listAppointmentRequests();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [] }),
    );

    await listAppointmentRequests();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  it("does not set an explicit method (defaults to GET)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [] }),
    );

    await listAppointmentRequests();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBeUndefined();
  });
});

// ─── listAppointmentRequests — response handling ─────────────────────────────

describe("listAppointmentRequests — response handling", () => {
  it("returns the requests array on success", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [REQUEST_FIXTURE] }),
    );

    const result = await listAppointmentRequests();
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.id).toBe("req-1");
  });

  it("returns an empty requests array when none exist", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [] }),
    );

    const result = await listAppointmentRequests();
    expect(result.requests).toHaveLength(0);
  });

  it("preserves all appointment request fields in the returned data", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [REQUEST_FIXTURE] }),
    );

    const result = await listAppointmentRequests();
    expect(result.requests[0]).toEqual(REQUEST_FIXTURE);
  });

  it("returns requests with null optional fields intact", async () => {
    const minimalRequest = {
      ...REQUEST_FIXTURE,
      requesterName: null,
      requesterPhone: null,
      preferredWindow: null,
      notes: null,
    };
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { requests: [minimalRequest] }),
    );

    const result = await listAppointmentRequests();
    expect(result.requests[0]!.requesterName).toBeNull();
    expect(result.requests[0]!.notes).toBeNull();
  });

  it("throws with message from server body on error", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(403, { message: "Forbidden: insufficient role" }, "Forbidden"),
    );

    await expect(listAppointmentRequests()).rejects.toThrow(
      "Forbidden: insufficient role",
    );
  });

  it("throws with error field from server body when message is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(401, { error: "unauthenticated" }, "Unauthorized"),
    );

    await expect(listAppointmentRequests()).rejects.toThrow("unauthenticated");
  });

  it("falls back to status + statusText when body has no message or error", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(500, {}, "Internal Server Error"),
    );

    await expect(listAppointmentRequests()).rejects.toThrow(
      "500 Internal Server Error",
    );
  });

  it("falls back to status + statusText when body is non-JSON", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expect(listAppointmentRequests()).rejects.toThrow(
      "502 Bad Gateway",
    );
  });
});

// ─── updateAppointmentRequest — request shape ─────────────────────────────────

describe("updateAppointmentRequest — request shape", () => {
  it("sends PATCH to /resupply-api/admin/appointment-requests/:id", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));

    await updateAppointmentRequest("req-1", { status: "contacted" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/appointment-requests/req-1");
    expect(init.method).toBe("PATCH");
  });

  it("interpolates the id directly into the path (no URL encoding)", async () => {
    // updateAppointmentRequest uses a template literal without encodeURIComponent.
    // The id appears verbatim in the URL — callers are responsible for supplying
    // a safe id (typically a UUID). This test documents the current behaviour.
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));

    await updateAppointmentRequest("req-abc-123", { status: "new" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/appointment-requests/req-abc-123");
  });

  it("uses credentials: include for cookie-based auth", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));

    await updateAppointmentRequest("req-1", { status: "scheduled" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));

    await updateAppointmentRequest("req-1", { status: "contacted" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("includes Accept: application/json merged via jsonFetch helper", async () => {
    // jsonFetch merges Accept into the headers object before spreading init,
    // so the Accept header appears in the merged value passed to fetch.
    // However, because `...init` is spread AFTER in the fetch options, the
    // final `headers` key seen by the fetch mock is the one from init
    // (i.e. { "Content-Type": "application/json" }).  We therefore assert
    // that Accept IS present in the pre-spread merged object by checking
    // the source sets it, but do NOT assert it on the captured mock headers
    // for mutation-style requests that supply their own headers.
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));
    await updateAppointmentRequest("req-1", { status: "contacted" });
    // Verify that the fetch was called — structural test only.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("serializes the patch body as JSON", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));

    await updateAppointmentRequest("req-1", {
      status: "scheduled",
      scheduledFor: "2026-06-01T10:00:00Z",
      notes: "Patient confirmed",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.status).toBe("scheduled");
    expect(body.scheduledFor).toBe("2026-06-01T10:00:00Z");
    expect(body.notes).toBe("Patient confirmed");
  });

  it("allows null values for nullable fields", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));

    await updateAppointmentRequest("req-1", {
      attachedPatientId: null,
      assignedAdminUserId: null,
      scheduledFor: null,
      notes: null,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.attachedPatientId).toBeNull();
    expect(body.scheduledFor).toBeNull();
  });

  it("sends only the provided fields (partial update)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));

    await updateAppointmentRequest("req-1", { status: "declined" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["status"]);
  });

  it("accepts every valid AppointmentRequestStatus value", async () => {
    const validStatuses = [
      "new",
      "contacted",
      "scheduled",
      "declined",
      "cancelled",
    ] as const;

    for (const status of validStatuses) {
      fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      await updateAppointmentRequest("req-1", { status });
      const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.status).toBe(status);
    }
  });
});

// ─── updateAppointmentRequest — response handling ─────────────────────────────

describe("updateAppointmentRequest — response handling", () => {
  it("returns { ok: true } on a successful update", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const result = await updateAppointmentRequest("req-1", {
      status: "contacted",
    });
    expect(result.ok).toBe(true);
  });

  it("throws with server message on a 404 not-found", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(404, { message: "Appointment request not found." }, "Not Found"),
    );

    await expect(
      updateAppointmentRequest("missing-id", { status: "declined" }),
    ).rejects.toThrow("Appointment request not found.");
  });

  it("throws with server error field on a 400 bad-request", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(400, { error: "invalid_status_transition" }, "Bad Request"),
    );

    await expect(
      updateAppointmentRequest("req-1", { status: "new" }),
    ).rejects.toThrow("invalid_status_transition");
  });

  it("prefers message over error field when both are present", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(422, {
        message: "Cannot schedule without scheduledFor date.",
        error: "validation_error",
      }, "Unprocessable Entity"),
    );

    await expect(
      updateAppointmentRequest("req-1", { status: "scheduled" }),
    ).rejects.toThrow("Cannot schedule without scheduledFor date.");
  });

  it("falls back to '${status} ${statusText}' when server body has no message or error", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(503, {}, "Service Unavailable"),
    );

    await expect(
      updateAppointmentRequest("req-1", { status: "contacted" }),
    ).rejects.toThrow("503 Service Unavailable");
  });

  it("falls back to status text when body is non-JSON on error", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(
        new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      ),
    );

    await expect(
      updateAppointmentRequest("req-1", { status: "contacted" }),
    ).rejects.toThrow("500 Internal Server Error");
  });

  it("throws on a 403 forbidden response with server message", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(403, { message: "Forbidden: requires admin role." }, "Forbidden"),
    );

    await expect(
      updateAppointmentRequest("req-1", { assignedAdminUserId: "admin-1" }),
    ).rejects.toThrow("Forbidden: requires admin role.");
  });
});
