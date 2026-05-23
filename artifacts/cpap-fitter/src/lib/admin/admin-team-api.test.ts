// Tests for admin-team-api.ts — fetch wrappers for /resupply-api/admin/team
//
// Coverage:
//   listTeam       — GET /admin/team
//   inviteMember   — POST /admin/team/invite (complex error path: checks "member" in json)
//   resendInvite   — POST /admin/team/:id/resend (URL-encodes id)
//   revokeMember   — POST /admin/team/:id/revoke
//   patchMember    — PATCH /admin/team/:id

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  listTeam,
  inviteMember,
  resendInvite,
  revokeMember,
  patchMember,
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

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const SAMPLE_MEMBER = {
  id: "mem-1",
  email: "agent@pennpaps.com",
  authUserId: "auth-abc",
  role: "csr" as const,
  status: "active" as const,
  displayName: "Agent Smith",
  notes: null,
  invitedBy: "admin-001",
  invitedAt: "2025-01-01T00:00:00Z",
  acceptedAt: "2025-01-02T00:00:00Z",
  revokedAt: null,
  revokedBy: null,
  lastLoginAt: "2025-06-01T10:00:00Z",
};

// ---------------------------------------------------------------------------
// listTeam
// ---------------------------------------------------------------------------

describe("listTeam", () => {
  test("requests GET /resupply-api/admin/team", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [] }),
    });

    await listTeam();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team");
  });

  test("sends credentials: include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [] }),
    });

    await listTeam();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  test("sends Accept: application/json header", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [] }),
    });

    await listTeam();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("returns parsed members array on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [SAMPLE_MEMBER] }),
    });

    const result = await listTeam();
    expect(result.members).toHaveLength(1);
    expect(result.members[0]!.email).toBe("agent@pennpaps.com");
    expect(result.members[0]!.role).toBe("csr");
    expect(result.members[0]!.status).toBe("active");
  });

  test("returns empty members array when team is empty", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [] }),
    });

    const result = await listTeam();
    expect(result.members).toEqual([]);
  });

  test("throws with status in message on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    });

    await expect(listTeam()).rejects.toThrow("Failed to load team (403)");
  });

  test("throws with correct status code for 401", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({}),
    });

    await expect(listTeam()).rejects.toThrow("Failed to load team (401)");
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [] }),
    });

    await listTeam();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// inviteMember
// ---------------------------------------------------------------------------

describe("inviteMember", () => {
  const INVITE_BODY = {
    email: "newagent@pennpaps.com",
    role: "csr" as const,
    displayName: "New Agent",
  };

  const INVITE_RESPONSE = {
    member: SAMPLE_MEMBER,
    emailSent: true,
    inviteLink: null,
  };

  test("posts to /resupply-api/admin/team/invite", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember(INVITE_BODY);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/invite");
  });

  test("uses POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember(INVITE_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  test("sends credentials: include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember(INVITE_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  test("sends Content-Type: application/json and Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember(INVITE_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
  });

  test("serialises the invite body as JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember(INVITE_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(INVITE_BODY);
  });

  test("returns InviteResponse with member, emailSent, and inviteLink", async () => {
    const responseWithLink = {
      member: SAMPLE_MEMBER,
      emailSent: false,
      inviteLink: "https://pennpaps.com/invite/token-abc",
    };

    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => responseWithLink,
    });

    const result = await inviteMember(INVITE_BODY);
    expect(result.member.email).toBe("agent@pennpaps.com");
    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toBe("https://pennpaps.com/invite/token-abc");
  });

  test("throws using message field from error JSON on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ message: "email already on team" }),
    });

    await expect(inviteMember(INVITE_BODY)).rejects.toThrow(
      "email already on team",
    );
  });

  test("throws using error field when message is missing", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "invalid_role" }),
    });

    await expect(inviteMember(INVITE_BODY)).rejects.toThrow("invalid_role");
  });

  test("throws fallback message with status when JSON has no message/error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    });

    await expect(inviteMember(INVITE_BODY)).rejects.toThrow(
      "Invite failed (500)",
    );
  });

  test("throws when response is OK but JSON has no 'member' key (bad shape)", async () => {
    // If the API returns 200 OK but the shape is wrong (no 'member' key),
    // the wrapper should treat it as an error.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: "some unexpected error" }),
    });

    await expect(inviteMember(INVITE_BODY)).rejects.toThrow();
  });

  test("includes optional notes when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember({ ...INVITE_BODY, notes: "Handles billing queue" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      notes: "Handles billing queue",
    });
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember(INVITE_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// resendInvite
// ---------------------------------------------------------------------------

describe("resendInvite", () => {
  const RESEND_RESPONSE = {
    member: { ...SAMPLE_MEMBER, status: "pending" as const },
    emailSent: true,
    inviteLink: null,
  };

  test("posts to /resupply-api/admin/team/:id/resend", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => RESEND_RESPONSE,
    });

    await resendInvite("mem-1");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/mem-1/resend");
  });

  test("uses POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => RESEND_RESPONSE,
    });

    await resendInvite("mem-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  test("sends credentials: include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => RESEND_RESPONSE,
    });

    await resendInvite("mem-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  test("URL-encodes the member id in the path", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => RESEND_RESPONSE,
    });

    // An id containing a slash would break routing without encoding
    await resendInvite("mem/special");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("mem%2Fspecial");
    expect(url).not.toContain("mem/special/resend");
  });

  test("returns the InviteResponse on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => RESEND_RESPONSE,
    });

    const result = await resendInvite("mem-1");
    expect(result.member.status).toBe("pending");
    expect(result.emailSent).toBe(true);
  });

  test("throws using message from error JSON on non-OK", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ message: "member not found" }),
    });

    await expect(resendInvite("mem-ghost")).rejects.toThrow("member not found");
  });

  test("throws using error field when message is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "member_already_active" }),
    });

    await expect(resendInvite("mem-1")).rejects.toThrow(
      "member_already_active",
    );
  });

  test("throws fallback message when JSON body is null (parse fails)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(resendInvite("mem-1")).rejects.toThrow("Resend failed (502)");
  });
});

// ---------------------------------------------------------------------------
// revokeMember
// ---------------------------------------------------------------------------

describe("revokeMember", () => {
  const REVOKE_RESPONSE = {
    member: { ...SAMPLE_MEMBER, status: "revoked" as const, revokedAt: "2025-06-01T00:00:00Z" },
  };

  test("posts to /resupply-api/admin/team/:id/revoke", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => REVOKE_RESPONSE,
    });

    await revokeMember("mem-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/mem-1/revoke");
    expect(init.method).toBe("POST");
  });

  test("sends credentials: include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => REVOKE_RESPONSE,
    });

    await revokeMember("mem-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  test("URL-encodes the member id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => REVOKE_RESPONSE,
    });

    await revokeMember("mem+special");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("mem%2Bspecial");
  });

  test("returns { member } with revoked status on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => REVOKE_RESPONSE,
    });

    const result = await revokeMember("mem-1");
    expect(result.member.status).toBe("revoked");
    expect(result.member.revokedAt).toBe("2025-06-01T00:00:00Z");
  });

  test("throws using message from error JSON on non-OK", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ message: "member not found" }),
    });

    await expect(revokeMember("mem-ghost")).rejects.toThrow("member not found");
  });

  test("throws using error field when message is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ error: "already_revoked" }),
    });

    await expect(revokeMember("mem-1")).rejects.toThrow("already_revoked");
  });

  test("throws fallback message when JSON parse fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "ISE",
      json: async () => {
        throw new SyntaxError("bad body");
      },
    });

    await expect(revokeMember("mem-1")).rejects.toThrow("Revoke failed (500)");
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => REVOKE_RESPONSE,
    });

    await revokeMember("mem-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// patchMember
// ---------------------------------------------------------------------------

describe("patchMember", () => {
  const PATCH_RESPONSE = {
    member: { ...SAMPLE_MEMBER, role: "supervisor" as const },
  };

  test("sends PATCH to /resupply-api/admin/team/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => PATCH_RESPONSE,
    });

    await patchMember("mem-1", { role: "supervisor" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/mem-1");
    expect(init.method).toBe("PATCH");
  });

  test("sends credentials: include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => PATCH_RESPONSE,
    });

    await patchMember("mem-1", { role: "admin" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  test("sends Content-Type: application/json and Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => PATCH_RESPONSE,
    });

    await patchMember("mem-1", { role: "supervisor" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
  });

  test("serialises the patch body as JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => PATCH_RESPONSE,
    });

    const body = { role: "fitter" as const, displayName: "Field Tech" };
    await patchMember("mem-1", body);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  test("URL-encodes the member id in the path", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => PATCH_RESPONSE,
    });

    await patchMember("mem/id-123", { role: "csr" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("mem%2Fid-123");
  });

  test("returns { member } with updated role on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => PATCH_RESPONSE,
    });

    const result = await patchMember("mem-1", { role: "supervisor" });
    expect(result.member.role).toBe("supervisor");
  });

  test("serialises null displayName to clear the field", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => PATCH_RESPONSE,
    });

    await patchMember("mem-1", { displayName: null });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);
    expect(parsed.displayName).toBeNull();
  });

  test("throws using message from error JSON on non-OK", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ message: "insufficient permissions" }),
    });

    await expect(patchMember("mem-1", { role: "admin" })).rejects.toThrow(
      "insufficient permissions",
    );
  });

  test("throws using error field when message is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "invalid_role_transition" }),
    });

    await expect(patchMember("mem-1", { role: "compliance_officer" })).rejects.toThrow(
      "invalid_role_transition",
    );
  });

  test("throws fallback message when JSON parse fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 504,
      statusText: "Gateway Timeout",
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(patchMember("mem-1", { role: "csr" })).rejects.toThrow(
      "Patch failed (504)",
    );
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => PATCH_RESPONSE,
    });

    await patchMember("mem-1", { notes: "Updated notes" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TeamRole values — verify all seven roles are accepted
// ---------------------------------------------------------------------------

describe("admin-team-api — all TeamRole values accepted", () => {
  const roles = [
    "admin",
    "supervisor",
    "csr",
    "fitter",
    "fulfillment",
    "compliance_officer",
    "agent",
  ] as const;

  for (const role of roles) {
    test(`patchMember accepts role '${role}'`, async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ member: { ...SAMPLE_MEMBER, role } }),
      });

      const result = await patchMember("mem-1", { role });
      expect(result.member.role).toBe(role);
    });
  }
});
