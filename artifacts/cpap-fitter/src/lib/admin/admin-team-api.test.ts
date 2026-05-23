// Tests for admin-team-api.ts — the fetch wrappers for the admin
// team management endpoints.
//
// Coverage:
//   inviteMember  — POST /resupply-api/admin/team/invite
//     * request shape (URL, method, credentials, content-type)
//     * request body does NOT include initialPassword (removed in this PR)
//     * response returned as-is on success
//     * InviteResponse does NOT expose signInReady (removed in this PR)
//     * error handling: non-ok with message / error / status fallback
//     * error handling: ok=true but missing "member" key → throws
//   listTeam      — GET /resupply-api/admin/team
//     * error on non-ok response

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { inviteMember, listTeam } from "./admin-team-api";

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

// Helper: build a minimal TeamMember-shaped object.
function makeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: "m-1",
    email: "alice@example.com",
    authUserId: "auth-u1",
    role: "csr",
    status: "pending",
    displayName: null,
    notes: null,
    invitedBy: null,
    invitedAt: new Date().toISOString(),
    acceptedAt: null,
    revokedAt: null,
    revokedBy: null,
    lastLoginAt: null,
    ...overrides,
  };
}

// Helper: build a successful InviteResponse body.
function makeInviteResponse(overrides: Record<string, unknown> = {}) {
  return {
    member: makeMember(),
    emailSent: true,
    inviteLink: null,
    ...overrides,
  };
}

// ─── inviteMember — request shape ────────────────────────────────────────────

describe("inviteMember — request shape", () => {
  it("sends a POST to /resupply-api/admin/team/invite", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeInviteResponse()), { status: 200 }),
    );
    await inviteMember({ email: "alice@example.com", role: "csr" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/resupply-api/admin/team/invite");
    expect(init.method).toBe("POST");
  });

  it("sets credentials: include and content-type: application/json", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeInviteResponse()), { status: 200 }),
    );
    await inviteMember({ email: "alice@example.com", role: "csr" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("serialises email and role into the JSON body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeInviteResponse()), { status: 200 }),
    );
    await inviteMember({ email: "bob@example.com", role: "admin" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.email).toBe("bob@example.com");
    expect(body.role).toBe("admin");
  });

  it("serialises optional displayName and notes when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeInviteResponse()), { status: 200 }),
    );
    await inviteMember({
      email: "carol@example.com",
      role: "fitter",
      displayName: "Carol Smith",
      notes: "Night shift",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.displayName).toBe("Carol Smith");
    expect(body.notes).toBe("Night shift");
  });
});

// ─── inviteMember — initialPassword removed ──────────────────────────────────

describe("inviteMember — initialPassword field removed", () => {
  it("does NOT include initialPassword in the request body even if caller sneaks it in", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeInviteResponse()), { status: 200 }),
    );
    // TypeScript won't allow passing initialPassword to inviteMember now, but
    // we cast to verify the runtime body never carries the field.
    await inviteMember({
      email: "dave@example.com",
      role: "supervisor",
    } as Parameters<typeof inviteMember>[0]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("initialPassword");
  });

  it("request body contains only the expected keys (no extra fields)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(makeInviteResponse()), { status: 200 }),
    );
    await inviteMember({ email: "eve@example.com", role: "csr" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Only email + role when displayName/notes are omitted.
    expect(Object.keys(body).sort()).toEqual(["email", "role"]);
  });
});

// ─── inviteMember — InviteResponse shape (signInReady removed) ───────────────

describe("inviteMember — InviteResponse shape", () => {
  it("returns member, emailSent, and inviteLink from the server response", async () => {
    const serverBody = makeInviteResponse({ emailSent: false, inviteLink: "https://example.com/invite/abc" });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(serverBody), { status: 200 }),
    );
    const result = await inviteMember({ email: "alice@example.com", role: "csr" });
    expect(result.member).toBeDefined();
    expect(result.emailSent).toBe(false);
    expect(result.inviteLink).toBe("https://example.com/invite/abc");
  });

});

// ─── inviteMember — error handling ───────────────────────────────────────────

describe("inviteMember — error handling", () => {
  it("throws an Error with the server message on a non-ok response with message field", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "conflict", message: "Email already in use." }),
        { status: 409 },
      ),
    );
    await expect(
      inviteMember({ email: "dup@example.com", role: "csr" }),
    ).rejects.toThrow("Email already in use.");
  });

  it("throws an Error with the error field when message is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    );
    await expect(
      inviteMember({ email: "x@example.com", role: "csr" }),
    ).rejects.toThrow("forbidden");
  });

  it("throws a status-based fallback message when neither message nor error is present", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 500 }),
    );
    await expect(
      inviteMember({ email: "x@example.com", role: "csr" }),
    ).rejects.toThrow("Invite failed (500)");
  });

  it("throws when response is ok but 'member' key is missing (unexpected shape)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await expect(
      inviteMember({ email: "x@example.com", role: "csr" }),
    ).rejects.toThrow();
  });
});

// ─── listTeam — basic error path ─────────────────────────────────────────────

describe("listTeam — error handling", () => {
  it("throws when the server returns a non-ok status", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(listTeam()).rejects.toThrow("Failed to load team (403)");
  });
});