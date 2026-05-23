// Tests for admin-team-api.ts — the fetch wrappers for team management
// endpoints.
//
// Coverage:
//   inviteMember   — POST body shape, no initialPassword field,
//                    InviteResponse shape (no signInReady), error handling
//   listTeam       — GET URL, credentials
//   resendInvite   — POST to /:id/resend
//   revokeMember   — POST to /:id/revoke
//   patchMember    — PATCH to /:id with body

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

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

const MEMBER_FIXTURE = {
  id: "m-1",
  email: "alice@example.com",
  authUserId: "u-auth-1",
  role: "csr" as const,
  status: "pending" as const,
  displayName: null,
  notes: null,
  invitedBy: "admin-1",
  invitedAt: "2024-01-01T00:00:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  revokedBy: null,
  lastLoginAt: null,
};

// ─── inviteMember ─────────────────────────────────────────────────────────

describe("inviteMember", () => {
  it("sends POST to /resupply-api/admin/team/invite", async () => {
    const response: { member: typeof MEMBER_FIXTURE; emailSent: boolean; inviteLink: string | null } = {
      member: MEMBER_FIXTURE,
      emailSent: true,
      inviteLink: null,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await inviteMember({ email: "alice@example.com", role: "csr" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/invite");
  });

  it("sends POST method with JSON body and credentials: include", async () => {
    const response = { member: MEMBER_FIXTURE, emailSent: true, inviteLink: null };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await inviteMember({ email: "alice@example.com", role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });

  // Regression: initialPassword was removed from the invite flow. The POST
  // body must NOT include initialPassword even if the caller somehow passes it.
  it("POST body contains only email and role (no initialPassword)", async () => {
    const response = { member: MEMBER_FIXTURE, emailSent: true, inviteLink: null };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await inviteMember({ email: "bob@example.com", role: "admin" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody).toEqual({ email: "bob@example.com", role: "admin" });
    expect(parsedBody).not.toHaveProperty("initialPassword");
  });

  it("includes optional displayName and notes in POST body when provided", async () => {
    const response = {
      member: { ...MEMBER_FIXTURE, displayName: "Bob Smith", notes: "CSR team" },
      emailSent: true,
      inviteLink: null,
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await inviteMember({
      email: "bob@example.com",
      role: "csr",
      displayName: "Bob Smith",
      notes: "CSR team",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsedBody = JSON.parse(init.body as string);
    expect(parsedBody.displayName).toBe("Bob Smith");
    expect(parsedBody.notes).toBe("CSR team");
    expect(parsedBody).not.toHaveProperty("initialPassword");
  });

  // Regression: signInReady was removed from InviteResponse.
  it("returns InviteResponse without signInReady field", async () => {
    const serverResponse = {
      member: MEMBER_FIXTURE,
      emailSent: true,
      inviteLink: null,
      // signInReady intentionally absent — regression check
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(serverResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await inviteMember({ email: "alice@example.com", role: "csr" });

    expect(result).not.toHaveProperty("signInReady");
    expect(result).toHaveProperty("member");
    expect(result).toHaveProperty("emailSent");
    expect(result).toHaveProperty("inviteLink");
  });

  it("returns the parsed InviteResponse on success", async () => {
    const serverResponse = {
      member: MEMBER_FIXTURE,
      emailSent: false,
      inviteLink: "https://example.com/invite?token=abc123",
    };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(serverResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await inviteMember({ email: "alice@example.com", role: "csr" });

    expect(result.member).toEqual(MEMBER_FIXTURE);
    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toBe("https://example.com/invite?token=abc123");
  });

  it("throws with server message on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "already_exists", message: "Email already on the team." }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      inviteMember({ email: "existing@example.com", role: "csr" }),
    ).rejects.toThrow("Email already on the team.");
  });

  it("throws with status code message when server gives no message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow("Invite failed (500)");
  });

  it("throws when response body is missing the member key", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ emailSent: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      inviteMember({ email: "alice@example.com", role: "csr" }),
    ).rejects.toThrow();
  });
});

// ─── listTeam ─────────────────────────────────────────────────────────────

describe("listTeam", () => {
  it("sends GET to /resupply-api/admin/team with credentials: include", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ members: [MEMBER_FIXTURE] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await listTeam();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team");
    expect(init.credentials).toBe("include");
    expect(init.method).toBeUndefined(); // default GET
  });

  it("returns parsed members list", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ members: [MEMBER_FIXTURE] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await listTeam();
    expect(result.members).toHaveLength(1);
    expect(result.members[0]!.email).toBe("alice@example.com");
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("", { status: 401 }),
    );
    await expect(listTeam()).rejects.toThrow("Failed to load team (401)");
  });
});

// ─── resendInvite ─────────────────────────────────────────────────────────

describe("resendInvite", () => {
  it("sends POST to /resupply-api/admin/team/:id/resend", async () => {
    const response = { member: MEMBER_FIXTURE, emailSent: true, inviteLink: null };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await resendInvite("m-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1/resend");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });

  it("URL-encodes the member id", async () => {
    const response = { member: MEMBER_FIXTURE, emailSent: true, inviteLink: null };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await resendInvite("member/with/slashes");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/member%2Fwith%2Fslashes/resend");
  });
});

// ─── revokeMember ─────────────────────────────────────────────────────────

describe("revokeMember", () => {
  it("sends POST to /resupply-api/admin/team/:id/revoke", async () => {
    const revokedMember = { ...MEMBER_FIXTURE, status: "revoked" as const };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ member: revokedMember }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await revokeMember("m-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1/revoke");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });

  it("throws with server error message on failure", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "Cannot revoke yourself." }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(revokeMember("self")).rejects.toThrow("Cannot revoke yourself.");
  });
});

// ─── patchMember ─────────────────────────────────────────────────────────

describe("patchMember", () => {
  it("sends PATCH to /resupply-api/admin/team/:id", async () => {
    const updated = { ...MEMBER_FIXTURE, role: "supervisor" as const };
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ member: updated }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await patchMember("m-1", { role: "supervisor" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1");
    expect(init.method).toBe("PATCH");
    expect(init.credentials).toBe("include");
  });

  it("sends the patch body as JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ member: MEMBER_FIXTURE }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await patchMember("m-1", { displayName: "Alice B.", notes: "Lead CSR" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ displayName: "Alice B.", notes: "Lead CSR" });
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message: "Role not allowed." }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(patchMember("m-1", { role: "admin" })).rejects.toThrow("Role not allowed.");
  });
});