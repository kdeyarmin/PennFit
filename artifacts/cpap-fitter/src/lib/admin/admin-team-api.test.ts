// Tests for admin-team-api.ts — the invite flow simplification in this PR.
//
// PR changes:
//   * inviteMember body no longer accepts `initialPassword`
//   * InviteResponse no longer includes `signInReady`
//
// Covers:
//   * inviteMember sends only email/role/displayName/notes (no initialPassword)
//   * inviteMember throws on non-ok responses
//   * inviteMember returns member/emailSent/inviteLink (no signInReady)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { inviteMember } from "./admin-team-api";

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

function makeResponse(
  status: number,
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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
  invitedBy: "admin-1",
  invitedAt: "2024-01-01T00:00:00Z",
  acceptedAt: null,
  revokedAt: null,
  revokedBy: null,
  lastLoginAt: null,
};

// ---------------------------------------------------------------------------
// inviteMember — request shape
// ---------------------------------------------------------------------------
describe("inviteMember — request shape", () => {
  it("sends a POST to /resupply-api/admin/team/invite", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await inviteMember({ email: "alice@example.com", role: "csr" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/resupply-api/admin/team/invite");
  });

  it("uses credentials: include for cookie-based auth", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await inviteMember({ email: "alice@example.com", role: "csr" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("sends email and role in the JSON body", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await inviteMember({ email: "alice@example.com", role: "admin" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.email).toBe("alice@example.com");
    expect(body.role).toBe("admin");
  });

  it("does NOT include initialPassword in the request body", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await inviteMember({
      email: "alice@example.com",
      role: "csr",
      displayName: "Alice",
      notes: "New hire",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("initialPassword");
  });

  it("includes displayName and notes when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await inviteMember({
      email: "alice@example.com",
      role: "csr",
      displayName: "Alice",
      notes: "some notes",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.displayName).toBe("Alice");
    expect(body.notes).toBe("some notes");
  });
});

// ---------------------------------------------------------------------------
// inviteMember — response shape
// ---------------------------------------------------------------------------
describe("inviteMember — response shape", () => {
  it("returns member, emailSent, and inviteLink on success", async () => {
    const inviteLink = "https://example.com/invite/abc123";
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: false,
        inviteLink,
      }),
    );
    const result = await inviteMember({ email: "alice@example.com", role: "csr" });
    expect(result.member).toEqual(MEMBER_FIXTURE);
    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toBe(inviteLink);
  });

  it("does NOT include signInReady in the response", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
        signInReady: true, // server may send; client must not expose it
      }),
    );
    const result = await inviteMember({ email: "alice@example.com", role: "csr" });
    expect(result).not.toHaveProperty("signInReady");
  });

  it("sets inviteLink to null when emailSent is true", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    const result = await inviteMember({ email: "alice@example.com", role: "csr" });
    expect(result.emailSent).toBe(true);
    expect(result.inviteLink).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inviteMember — error handling
// ---------------------------------------------------------------------------
describe("inviteMember — error handling", () => {
  it("throws with server message on a 409 conflict", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(409, { message: "Email already in use." }),
    );
    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow("Email already in use.");
  });

  it("throws with server error field on a 400 bad-request", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(400, { error: "invalid_input" }),
    );
    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow("invalid_input");
  });

  it("throws a fallback message when the server body has neither message nor error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, {}));
    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow("Invite failed (500)");
  });

  it("throws when the response is ok but the body has no 'member' field", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { ok: true }),
    );
    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow();
  });

  it("throws when fetch itself rejects (network error)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow("Failed to fetch");
  });

  it("throws on 403 forbidden (caller is not an admin)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(403, { error: "forbidden" }),
    );
    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// inviteMember — request Content-Type header
// ---------------------------------------------------------------------------
describe("inviteMember — Content-Type header", () => {
  it("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(201, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await inviteMember({ email: "alice@example.com", role: "csr" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("content-type")).toContain("application/json");
  });
});

// ---------------------------------------------------------------------------
// inviteMember — optional fields handling
// ---------------------------------------------------------------------------
describe("inviteMember — optional fields", () => {
  it("omits displayName from body when not provided", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(201, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await inviteMember({ email: "alice@example.com", role: "admin" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // When displayName is not passed, the body should not have it or have undefined
    expect(Object.keys(body)).not.toContain("displayName");
  });

  it("sends displayName: null when explicitly passed as null", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(201, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await inviteMember({
      email: "alice@example.com",
      role: "admin",
      displayName: null,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.displayName).toBeNull();
  });

  it("handles 201 Created status (new member, not a re-invite)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(201, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    const result = await inviteMember({
      email: "alice@example.com",
      role: "csr",
    });
    expect(result.member).toEqual(MEMBER_FIXTURE);
    expect(result.emailSent).toBe(true);
  });
});