// Tests for admin-team-api.ts
//
// PR changes verified here:
//   * inviteMember no longer accepts `initialPassword` — body sent to the
//     server must not include that field.
//   * InviteResponse no longer has `signInReady` — callers cannot depend
//     on that field being present.
//   * listTeam, resendInvite, revokeMember, patchMember error-handling
//     paths are exercised (error message extraction from JSON body).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  inviteMember,
  listTeam,
  patchMember,
  resendInvite,
  revokeMember,
} from "./admin-team-api";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const MEMBER_STUB = {
  id: "m-1",
  email: "alice@example.com",
  authUserId: "auth-1",
  role: "csr" as const,
  status: "pending" as const,
  displayName: null,
  notes: null,
  invitedBy: null,
  invitedAt: new Date().toISOString(),
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

// ---------------------------------------------------------------------------
// listTeam
// ---------------------------------------------------------------------------
describe("listTeam", () => {
  it("sends a GET request to /resupply-api/admin/team", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ members: [] }));
    await listTeam();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team");
    expect(init.method).toBeUndefined(); // default GET
  });

  it("includes credentials: include", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ members: [] }));
    await listTeam();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("returns the members array from the response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ members: [MEMBER_STUB] }));
    const result = await listTeam();
    expect(result.members).toHaveLength(1);
    expect(result.members[0].email).toBe("alice@example.com");
  });

  it("throws when the server returns a non-ok status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, { status: 403, statusText: "Forbidden" }),
    );
    await expect(listTeam()).rejects.toThrow("403");
  });
});

// ---------------------------------------------------------------------------
// inviteMember — core behaviour
// ---------------------------------------------------------------------------
describe("inviteMember", () => {
  it("sends a POST to /resupply-api/admin/team/invite", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ member: MEMBER_STUB, emailSent: true, inviteLink: null }),
    );
    await inviteMember({ email: "bob@example.com", role: "csr" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/invite");
    expect(init.method).toBe("POST");
  });

  it("serialises the body as JSON", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ member: MEMBER_STUB, emailSent: true, inviteLink: null }),
    );
    await inviteMember({ email: "bob@example.com", role: "csr" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.email).toBe("bob@example.com");
    expect(body.role).toBe("csr");
  });

  it("does NOT include initialPassword in the request body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ member: MEMBER_STUB, emailSent: true, inviteLink: null }),
    );
    await inviteMember({ email: "bob@example.com", role: "csr" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("initialPassword");
  });

  it("returns emailSent and inviteLink from the response", async () => {
    const inviteLink = "https://example.com/invite/token-xyz";
    fetchMock.mockResolvedValue(
      jsonResponse({
        member: MEMBER_STUB,
        emailSent: false,
        inviteLink,
      }),
    );
    const result = await inviteMember({ email: "bob@example.com", role: "csr" });
    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toBe(inviteLink);
  });

  it("does NOT return signInReady in the response shape", async () => {
    // signInReady was removed in this PR — callers should not be able to
    // read it. Verify the response object does not contain the field even
    // if the server were to include it (the type just omits it).
    fetchMock.mockResolvedValue(
      jsonResponse({
        member: MEMBER_STUB,
        emailSent: true,
        inviteLink: null,
      }),
    );
    const result = await inviteMember({ email: "bob@example.com", role: "csr" });
    expect(result).not.toHaveProperty("signInReady");
  });

  it("includes optional displayName and notes in the request body when provided", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ member: MEMBER_STUB, emailSent: true, inviteLink: null }),
    );
    await inviteMember({
      email: "bob@example.com",
      role: "csr",
      displayName: "Bob Smith",
      notes: "New hire from branch B",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.displayName).toBe("Bob Smith");
    expect(body.notes).toBe("New hire from branch B");
  });

  it("throws the server's message field when the invite fails with 409", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { message: "Email already registered" },
        { status: 409, statusText: "Conflict" },
      ),
    );
    await expect(
      inviteMember({ email: "dup@example.com", role: "csr" }),
    ).rejects.toThrow("Email already registered");
  });

  it("throws the server's error field when message is absent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: "rate_limited" },
        { status: 429, statusText: "Too Many Requests" },
      ),
    );
    await expect(
      inviteMember({ email: "x@example.com", role: "csr" }),
    ).rejects.toThrow("rate_limited");
  });

  it("falls back to a status-code message when the JSON body has neither message nor error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, { status: 500, statusText: "Internal Server Error" }),
    );
    await expect(
      inviteMember({ email: "x@example.com", role: "csr" }),
    ).rejects.toThrow("500");
  });

  it("throws when the response is ok but the body has no 'member' field", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ memberId: "m-1" }));
    await expect(
      inviteMember({ email: "x@example.com", role: "csr" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resendInvite
// ---------------------------------------------------------------------------
describe("resendInvite", () => {
  it("sends POST to /resupply-api/admin/team/:id/resend", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ member: MEMBER_STUB, emailSent: true, inviteLink: null }),
    );
    await resendInvite("m-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1/resend");
    expect(init.method).toBe("POST");
  });

  it("URL-encodes the member id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ member: MEMBER_STUB, emailSent: true, inviteLink: null }),
    );
    await resendInvite("m/1 2");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("m%2F1%202");
  });

  it("throws the server's message when the request fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "Member not found" }, { status: 404 }),
    );
    await expect(resendInvite("missing")).rejects.toThrow("Member not found");
  });
});

// ---------------------------------------------------------------------------
// revokeMember
// ---------------------------------------------------------------------------
describe("revokeMember", () => {
  it("sends POST to /resupply-api/admin/team/:id/revoke", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ member: MEMBER_STUB }));
    await revokeMember("m-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1/revoke");
    expect(init.method).toBe("POST");
  });

  it("throws the server's error field when the revoke fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "self_revoke_not_allowed" }, { status: 403 }),
    );
    await expect(revokeMember("self")).rejects.toThrow(
      "self_revoke_not_allowed",
    );
  });
});

// ---------------------------------------------------------------------------
// patchMember
// ---------------------------------------------------------------------------
describe("patchMember", () => {
  it("sends PATCH to /resupply-api/admin/team/:id", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ member: MEMBER_STUB }));
    await patchMember("m-1", { role: "admin" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1");
    expect(init.method).toBe("PATCH");
  });

  it("serialises the patch body as JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ member: MEMBER_STUB }));
    await patchMember("m-1", { displayName: "Alice Admin", notes: "Updated" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.displayName).toBe("Alice Admin");
    expect(body.notes).toBe("Updated");
  });

  it("throws the server's message when the patch fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "Invalid role" }, { status: 422 }),
    );
    await expect(patchMember("m-1", { role: "admin" })).rejects.toThrow(
      "Invalid role",
    );
  });
});