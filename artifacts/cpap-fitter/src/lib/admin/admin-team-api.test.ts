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

  it("prefers message over error in the error body when both are present", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(422, { message: "Email is malformed.", error: "validation_error" }),
    );
    await expect(
      inviteMember({ email: "bad-email", role: "csr" }),
    ).rejects.toThrow("Email is malformed.");
  });
});

// ---------------------------------------------------------------------------
// listTeam — request shape and response parsing
// ---------------------------------------------------------------------------
describe("listTeam — request shape", () => {
  it("sends a GET to /resupply-api/admin/team", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { members: [MEMBER_FIXTURE] }),
    );
    await listTeam();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team");
    expect(init.method).toBeUndefined(); // fetch defaults to GET
  });

  it("uses credentials: include for cookie-based auth", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { members: [] }),
    );
    await listTeam();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("returns the members array on success", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { members: [MEMBER_FIXTURE] }),
    );
    const result = await listTeam();
    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toEqual(MEMBER_FIXTURE);
  });

  it("returns an empty members array when no team members exist", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { members: [] }),
    );
    const result = await listTeam();
    expect(result.members).toHaveLength(0);
  });

  it("throws with status code on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(403, { error: "forbidden" }));
    await expect(listTeam()).rejects.toThrow("Failed to load team (403)");
  });

  it("throws on a 500 server error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, {}));
    await expect(listTeam()).rejects.toThrow("Failed to load team (500)");
  });
});

// ---------------------------------------------------------------------------
// resendInvite — request shape, response, error handling
// ---------------------------------------------------------------------------
describe("resendInvite — request shape", () => {
  it("sends a POST to /resupply-api/admin/team/:id/resend", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await resendInvite("m-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1/resend");
    expect(init.method).toBe("POST");
  });

  it("URL-encodes the member id", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await resendInvite("id with spaces/slashes");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(encodeURIComponent("id with spaces/slashes"));
    expect(url).not.toContain(" ");
  });

  it("uses credentials: include", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: true,
        inviteLink: null,
      }),
    );
    await resendInvite("m-1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("returns the InviteResponse on success", async () => {
    const inviteLink = "https://example.com/invite/xyz";
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        member: MEMBER_FIXTURE,
        emailSent: false,
        inviteLink,
      }),
    );
    const result = await resendInvite("m-1");
    expect(result.member).toEqual(MEMBER_FIXTURE);
    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toBe(inviteLink);
  });
});

describe("resendInvite — error handling", () => {
  it("throws with server message on a 404 not-found", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(404, { message: "Member not found." }),
    );
    await expect(resendInvite("missing-id")).rejects.toThrow("Member not found.");
  });

  it("throws with server error field on a 400 bad-request", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(400, { error: "already_active" }),
    );
    await expect(resendInvite("m-1")).rejects.toThrow("already_active");
  });

  it("throws a fallback message when server body is empty on error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, {}));
    await expect(resendInvite("m-1")).rejects.toThrow("Resend failed (500)");
  });

  it("throws a fallback message when server returns non-JSON on error", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(new Response("Internal Server Error", { status: 503 })),
    );
    await expect(resendInvite("m-1")).rejects.toThrow("Resend failed (503)");
  });
});

// ---------------------------------------------------------------------------
// revokeMember — request shape, response, error handling
// ---------------------------------------------------------------------------
describe("revokeMember — request shape", () => {
  it("sends a POST to /resupply-api/admin/team/:id/revoke", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: { ...MEMBER_FIXTURE, status: "revoked" } }),
    );
    await revokeMember("m-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1/revoke");
    expect(init.method).toBe("POST");
  });

  it("URL-encodes the member id", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: { ...MEMBER_FIXTURE, status: "revoked" } }),
    );
    await revokeMember("m/special&id");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(encodeURIComponent("m/special&id"));
  });

  it("uses credentials: include", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: { ...MEMBER_FIXTURE, status: "revoked" } }),
    );
    await revokeMember("m-1");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("returns the revoked member on success", async () => {
    const revokedMember = { ...MEMBER_FIXTURE, status: "revoked" as const };
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: revokedMember }),
    );
    const result = await revokeMember("m-1");
    expect(result.member).toEqual(revokedMember);
    expect(result.member.status).toBe("revoked");
  });
});

describe("revokeMember — error handling", () => {
  it("throws with server message on a 404", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(404, { message: "Member not found." }),
    );
    await expect(revokeMember("missing")).rejects.toThrow("Member not found.");
  });

  it("throws with server error field when message is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(409, { error: "already_revoked" }),
    );
    await expect(revokeMember("m-1")).rejects.toThrow("already_revoked");
  });

  it("throws a fallback message when server body has neither message nor error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, {}));
    await expect(revokeMember("m-1")).rejects.toThrow("Revoke failed (500)");
  });

  it("throws a fallback message when server returns non-JSON on error", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(new Response("Bad Gateway", { status: 502 })),
    );
    await expect(revokeMember("m-1")).rejects.toThrow("Revoke failed (502)");
  });
});

// ---------------------------------------------------------------------------
// patchMember — request shape, response, error handling
// ---------------------------------------------------------------------------
describe("patchMember — request shape", () => {
  it("sends a PATCH to /resupply-api/admin/team/:id", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: MEMBER_FIXTURE }),
    );
    await patchMember("m-1", { role: "admin" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1");
    expect(init.method).toBe("PATCH");
  });

  it("URL-encodes the member id in the PATCH URL", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: MEMBER_FIXTURE }),
    );
    await patchMember("m/1+special", { role: "csr" });
    const [url] = fetchMock.mock.calls[0] as [string];
    // The URL should end with the encoded id (no literal "/" or "+" in
    // the last segment). Verify with the exact composed URL.
    expect(url).toBe(
      `/resupply-api/admin/team/${encodeURIComponent("m/1+special")}`,
    );
  });

  it("uses credentials: include", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: MEMBER_FIXTURE }),
    );
    await patchMember("m-1", { displayName: "Alice" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("sends content-type: application/json", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: MEMBER_FIXTURE }),
    );
    await patchMember("m-1", { role: "supervisor" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("serializes the patch body as JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: MEMBER_FIXTURE }),
    );
    await patchMember("m-1", {
      role: "fitter",
      displayName: "Bob",
      notes: "On probation",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.role).toBe("fitter");
    expect(body.displayName).toBe("Bob");
    expect(body.notes).toBe("On probation");
  });

  it("allows null values for displayName and notes", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: MEMBER_FIXTURE }),
    );
    await patchMember("m-1", { displayName: null, notes: null });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.displayName).toBeNull();
    expect(body.notes).toBeNull();
  });

  it("sends a partial body with only role when that is all that is provided", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: MEMBER_FIXTURE }),
    );
    await patchMember("m-1", { role: "compliance_officer" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["role"]);
    expect(body.role).toBe("compliance_officer");
  });

  it("returns the updated member on success", async () => {
    const updatedMember = {
      ...MEMBER_FIXTURE,
      role: "admin" as const,
      displayName: "Alice Admin",
    };
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { member: updatedMember }),
    );
    const result = await patchMember("m-1", { role: "admin" });
    expect(result.member).toEqual(updatedMember);
  });
});

describe("patchMember — error handling", () => {
  it("throws with server message on a 404", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(404, { message: "Member not found." }),
    );
    await expect(patchMember("missing", { role: "csr" })).rejects.toThrow(
      "Member not found.",
    );
  });

  it("throws with server error field when message is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(400, { error: "invalid_role" }),
    );
    await expect(patchMember("m-1", { role: "csr" })).rejects.toThrow(
      "invalid_role",
    );
  });

  it("throws a fallback message when server body is empty on error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, {}));
    await expect(patchMember("m-1", { role: "csr" })).rejects.toThrow(
      "Patch failed (500)",
    );
  });

  it("throws a fallback message when server returns non-JSON on error", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve(new Response("Service Unavailable", { status: 503 })),
    );
    await expect(patchMember("m-1", { role: "csr" })).rejects.toThrow(
      "Patch failed (503)",
    );
  });

  it("prefers message over error field in the error body", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(422, {
        message: "Role transition not allowed.",
        error: "invalid_transition",
      }),
    );
    await expect(patchMember("m-1", { role: "admin" })).rejects.toThrow(
      "Role transition not allowed.",
    );
  });
});