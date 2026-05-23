// Tests for admin-team-api.ts
//
// PR changes:
//   * `inviteMember` no longer accepts `initialPassword` in its body type —
//     the "set their password for them" invite flow has been removed.
//   * `InviteResponse` no longer includes `signInReady` — the server no longer
//     returns it and the client no longer reads it.
//
// Uses globalThis.fetch mocking (same pattern as inbound-faxes-api.test.ts)
// since these are hand-rolled fetch wrappers, not generated API clients.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { inviteMember, listTeam } from "./admin-team-api";

const ORIGINAL_FETCH = globalThis.fetch;

let fetchMock: Mock;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const MEMBER_FIXTURE = {
  id: "m-1",
  email: "alice@example.com",
  authUserId: "u-1",
  role: "csr" as const,
  status: "pending" as const,
  displayName: "Alice",
  notes: null,
  invitedBy: "u-admin",
  invitedAt: "2026-01-01T00:00:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  revokedBy: null,
  lastLoginAt: null,
};

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("inviteMember", () => {
  it("POSTs to /resupply-api/admin/team/invite", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );

    await inviteMember({ email: "alice@example.com", role: "csr" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/invite");
  });

  it("sends credentials: include for cookie-based auth", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );

    await inviteMember({ email: "alice@example.com", role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("serializes the body as JSON without an initialPassword field", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );

    await inviteMember({
      email: "alice@example.com",
      role: "supervisor",
      displayName: "Alice Smith",
      notes: "Remote fitter",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body.email).toBe("alice@example.com");
    expect(body.role).toBe("supervisor");
    expect(body.displayName).toBe("Alice Smith");
    expect(body.notes).toBe("Remote fitter");
    // The "set their password for them" flow has been removed —
    // initialPassword must NOT be in the request body.
    expect(body).not.toHaveProperty("initialPassword");
  });

  it("returns the member, emailSent, and inviteLink fields (no signInReady)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        member: MEMBER_FIXTURE,
        emailSent: false,
        inviteLink: "https://example.com/admin/reset-password?token=abc",
      }),
    );

    const result = await inviteMember({
      email: "alice@example.com",
      role: "csr",
    });

    expect(result.member).toMatchObject({ id: "m-1", email: "alice@example.com" });
    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toBe(
      "https://example.com/admin/reset-password?token=abc",
    );
    // signInReady was removed from InviteResponse — it must not be accessible.
    expect(result).not.toHaveProperty("signInReady");
  });

  it("throws an Error with the server message when the response is non-ok", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { message: "alice@example.com is already an active member." },
        { status: 409, statusText: "Conflict" },
      ),
    );

    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow("alice@example.com is already an active member.");
  });

  it("throws using the 'error' field when 'message' is absent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: "too_many_requests" },
        { status: 429, statusText: "Too Many Requests" },
      ),
    );

    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow("too_many_requests");
  });

  it("falls back to a status-code message when neither message nor error is present", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow("500");
  });

  it("throws when the response is ok but the body has no 'member' key", async () => {
    // The server returned 200 but with an unexpected shape (e.g. already_active
    // returns a 409, but a badly-wired gateway might return 200 with an error body).
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "already_active_member", memberId: "m-1" }),
    );

    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow();
  });

  it("always sets the new member status to 'pending' (signInReady flow removed)", async () => {
    // Previously when signInReady was true the member status would be 'active'.
    // After the removal, inviteMember can only produce a 'pending' member via
    // the email-link flow.
    fetchMock.mockResolvedValue(
      jsonResponse({
        member: { ...MEMBER_FIXTURE, status: "pending" },
        emailSent: true,
        inviteLink: null,
      }),
    );

    const result = await inviteMember({
      email: "alice@example.com",
      role: "csr",
    });

    expect(result.member.status).toBe("pending");
  });
});

describe("listTeam", () => {
  it("GETs /resupply-api/admin/team", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ members: [MEMBER_FIXTURE] }),
    );

    await listTeam();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team");
  });

  it("throws when the response is not ok", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "sign_in_required" }, { status: 401 }),
    );

    await expect(listTeam()).rejects.toThrow("401");
  });

  it("preserves network errors as-is (not wrapped)", async () => {
    const networkError = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(networkError);

    await expect(listTeam()).rejects.toBe(networkError);
  });
});