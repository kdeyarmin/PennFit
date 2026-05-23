// Tests for admin-team-api.ts.
//
// This PR:
//   1. Added csrfHeader() to inviteMember, resendInvite, revokeMember, patchMember.
//   2. Removed initialPassword from inviteMember's parameter type.
//   3. Removed signInReady from InviteResponse.
//
// Coverage:
//   listTeam          — URL, credentials, Accept header
//   inviteMember      — method, URL, headers (incl. X-PF-CSRF), body, error handling;
//                       does NOT accept initialPassword (removed in this PR)
//   resendInvite      — method, URL, X-PF-CSRF header, error handling
//   revokeMember      — method, URL, X-PF-CSRF header, error handling
//   patchMember       — method, URL, headers, body, X-PF-CSRF header, error handling

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  inviteMember,
  listTeam,
  patchMember,
  resendInvite,
  revokeMember,
  type TeamMember,
} from "./admin-team-api";

// ─── Shared fixture ─────────────────────────────────────────────────────────

const MEMBER: TeamMember = {
  id: "m-1",
  email: "pat@example.com",
  authUserId: "auth-uuid",
  role: "csr",
  status: "pending",
  displayName: "Pat",
  notes: null,
  invitedBy: "admin@example.com",
  invitedAt: "2026-01-01T00:00:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  revokedBy: null,
  lastLoginAt: null,
};

const INVITE_RESPONSE = {
  member: MEMBER,
  emailSent: true,
  inviteLink: null,
};

// ─── Setup / teardown ───────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function setDocumentCookie(cookie: string | null) {
  if (cookie === null) {
    delete (globalThis as unknown as { document?: unknown }).document;
  } else {
    (globalThis as unknown as { document?: unknown }).document = { cookie };
  }
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Default: no CSRF cookie. Individual tests override as needed.
  setDocumentCookie("");
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete (globalThis as unknown as { document?: unknown }).document;
  vi.restoreAllMocks();
});

// ─── listTeam ────────────────────────────────────────────────────────────────

describe("listTeam", () => {
  it("fetches /resupply-api/admin/team with credentials:include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [MEMBER] }),
    });

    await listTeam();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
  });

  it("returns the members array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ members: [MEMBER] }),
    });

    const result = await listTeam();
    expect(result.members).toHaveLength(1);
    expect(result.members[0]!.email).toBe("pat@example.com");
  });

  it("throws on non-OK status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(listTeam()).rejects.toThrow("403");
  });
});

// ─── inviteMember ────────────────────────────────────────────────────────────

describe("inviteMember — request shape", () => {
  it("POSTs to /resupply-api/admin/team/invite", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember({ email: "new@example.com", role: "csr" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/invite");
    expect(init.method).toBe("POST");
  });

  it("sends credentials:include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember({ email: "new@example.com", role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("sends Content-Type and Accept application/json headers", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember({ email: "new@example.com", role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("includes X-PF-CSRF header when pf_csrf cookie is present", async () => {
    setDocumentCookie("pf_csrf=csrf-token-abc");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember({ email: "new@example.com", role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBe("csrf-token-abc");
  });

  it("does not include X-PF-CSRF when pf_csrf cookie is absent", async () => {
    setDocumentCookie("other=foo");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember({ email: "new@example.com", role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect("X-PF-CSRF" in headers).toBe(false);
  });

  it("serialises the required fields in the body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember({ email: "new@example.com", role: "admin" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      email: "new@example.com",
      role: "admin",
    });
  });

  it("serialises optional displayName and notes when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember({
      email: "new@example.com",
      role: "csr",
      displayName: "Test User",
      notes: "Some notes",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.displayName).toBe("Test User");
    expect(body.notes).toBe("Some notes");
  });

  it("does NOT include initialPassword in the request body (field was removed)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await inviteMember({ email: "new@example.com", role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect("initialPassword" in body).toBe(false);
  });
});

describe("inviteMember — response handling", () => {
  it("returns member, emailSent, and inviteLink on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    const result = await inviteMember({ email: "new@example.com", role: "csr" });
    expect(result.member.email).toBe("pat@example.com");
    expect(result.emailSent).toBe(true);
    expect(result.inviteLink).toBeNull();
  });

  it("response does NOT have a signInReady field (field was removed)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    const result = await inviteMember({ email: "new@example.com", role: "csr" });
    expect("signInReady" in result).toBe(false);
  });

  it("returns emailSent:false and non-null inviteLink when email not sent", async () => {
    const resp = {
      member: MEMBER,
      emailSent: false,
      inviteLink: "https://example.com/invite/abc",
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => resp,
    });

    const result = await inviteMember({ email: "new@example.com", role: "csr" });
    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toBe("https://example.com/invite/abc");
  });

  it("throws with server message field when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: "email already in use" }),
    });

    await expect(
      inviteMember({ email: "dup@example.com", role: "csr" }),
    ).rejects.toThrow("email already in use");
  });

  it("throws with server error field when message is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_role" }),
    });

    await expect(
      inviteMember({ email: "x@example.com", role: "csr" }),
    ).rejects.toThrow("invalid_role");
  });

  it("throws with generic message as fallback", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(
      inviteMember({ email: "x@example.com", role: "csr" }),
    ).rejects.toThrow("500");
  });
});

// ─── resendInvite ────────────────────────────────────────────────────────────

describe("resendInvite", () => {
  it("POSTs to /resupply-api/admin/team/:id/resend", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await resendInvite("m-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1/resend");
    expect(init.method).toBe("POST");
  });

  it("URL-encodes the id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await resendInvite("id with spaces");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("id%20with%20spaces");
  });

  it("sends credentials:include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await resendInvite("m-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("includes X-PF-CSRF when pf_csrf cookie is present", async () => {
    setDocumentCookie("pf_csrf=resend-token");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await resendInvite("m-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-PF-CSRF"]).toBe(
      "resend-token",
    );
  });

  it("omits X-PF-CSRF when pf_csrf cookie is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => INVITE_RESPONSE,
    });

    await resendInvite("m-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect("X-PF-CSRF" in (init.headers as Record<string, string>)).toBe(false);
  });

  it("throws with message from error body on failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: "member not found" }),
    });

    await expect(resendInvite("missing")).rejects.toThrow("member not found");
  });

  it("throws generic message when body is not parseable", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new SyntaxError("no body"); },
    });

    await expect(resendInvite("m-1")).rejects.toThrow("500");
  });
});

// ─── revokeMember ────────────────────────────────────────────────────────────

describe("revokeMember", () => {
  it("POSTs to /resupply-api/admin/team/:id/revoke", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: { ...MEMBER, status: "revoked" } }),
    });

    await revokeMember("m-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1/revoke");
    expect(init.method).toBe("POST");
  });

  it("URL-encodes special characters in the id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: MEMBER }),
    });

    await revokeMember("id/with/slashes");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("id%2Fwith%2Fslashes");
  });

  it("includes X-PF-CSRF when pf_csrf cookie is present", async () => {
    setDocumentCookie("pf_csrf=revoke-csrf");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: MEMBER }),
    });

    await revokeMember("m-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-PF-CSRF"]).toBe(
      "revoke-csrf",
    );
  });

  it("throws with message from error body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: "insufficient permissions" }),
    });

    await expect(revokeMember("m-1")).rejects.toThrow("insufficient permissions");
  });

  it("returns { member } on success", async () => {
    const revokedMember = { ...MEMBER, status: "revoked" as const };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: revokedMember }),
    });

    const result = await revokeMember("m-1");
    expect(result.member.status).toBe("revoked");
  });
});

// ─── patchMember ─────────────────────────────────────────────────────────────

describe("patchMember", () => {
  it("sends PATCH to /resupply-api/admin/team/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: MEMBER }),
    });

    await patchMember("m-1", { role: "admin" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/m-1");
    expect(init.method).toBe("PATCH");
  });

  it("sends credentials:include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: MEMBER }),
    });

    await patchMember("m-1", { role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  it("sends Content-Type and Accept application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: MEMBER }),
    });

    await patchMember("m-1", { role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("includes X-PF-CSRF when pf_csrf cookie is present", async () => {
    setDocumentCookie("pf_csrf=patch-csrf-token");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: MEMBER }),
    });

    await patchMember("m-1", { displayName: "Updated" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-PF-CSRF"]).toBe(
      "patch-csrf-token",
    );
  });

  it("omits X-PF-CSRF when cookie is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: MEMBER }),
    });

    await patchMember("m-1", { role: "csr" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect("X-PF-CSRF" in (init.headers as Record<string, string>)).toBe(false);
  });

  it("serialises partial fields correctly (role only)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: MEMBER }),
    });

    await patchMember("m-1", { role: "supervisor" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ role: "supervisor" });
  });

  it("serialises null displayName", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: MEMBER }),
    });

    await patchMember("m-1", { displayName: null });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ displayName: null });
  });

  it("throws with message from error body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "invalid role" }),
    });

    await expect(patchMember("m-1", { role: "csr" })).rejects.toThrow(
      "invalid role",
    );
  });

  it("throws generic message fallback when body is empty", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new SyntaxError("no body"); },
    });

    await expect(patchMember("m-1", { role: "csr" })).rejects.toThrow("500");
  });

  it("returns { member } on success", async () => {
    const updated = { ...MEMBER, role: "admin" as const };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ member: updated }),
    });

    const result = await patchMember("m-1", { role: "admin" });
    expect(result.member.role).toBe("admin");
  });
});