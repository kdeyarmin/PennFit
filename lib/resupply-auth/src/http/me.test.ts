// Direct unit tests for handleMe — the GET /auth/me handler.
//
// handleMe is now a plain synchronous function (not a factory).
// These tests verify the response shape after removing the
// mustChangePassword field and the credential-lookup logic.
//
// Coverage:
//   * Returns 200 with the correct user fields (no mustChangePassword)
//   * Returns 401 when req.authUser is absent (belt-and-braces guard)
//   * emailVerified is derived from emailVerifiedAt (null → false)
//   * emailVerified is derived from emailVerifiedAt (non-null → true)
//   * displayName is forwarded as-is (null or string)

import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";

import { handleMe } from "./me";
import type { AuthUser } from "../repository";

// Minimal fake response matching the subset handleMe uses.
function makeRes() {
  const res = {
    _status: 0,
    _body: undefined as unknown,
    status(s: number) {
      res._status = s;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res;
}

// Build a minimal AuthUser. Only the fields handleMe reads are needed.
function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u-123",
    emailLower: "alice@example.com",
    displayName: null,
    role: "admin",
    status: "active",
    emailVerifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("handleMe — 200 response shape", () => {
  it("returns 200 with id, email, role, displayName, and emailVerified", () => {
    const user = makeUser({
      id: "u-42",
      emailLower: "bob@example.com",
      role: "admin",
      displayName: "Bob",
      emailVerifiedAt: new Date(),
    });
    const req = { authUser: user } as unknown as Request;
    const res = makeRes();
    handleMe(req, res as unknown as Response);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({
      id: "u-42",
      email: "bob@example.com",
      role: "admin",
      displayName: "Bob",
      emailVerified: true,
    });
  });

  it("does NOT include mustChangePassword in the response", () => {
    const user = makeUser({ emailVerifiedAt: new Date() });
    const req = { authUser: user } as unknown as Request;
    const res = makeRes();
    handleMe(req, res as unknown as Response);
    expect(res._status).toBe(200);
    const body = res._body as Record<string, unknown>;
    expect(body).not.toHaveProperty("mustChangePassword");
  });

  it("sets emailVerified=false when emailVerifiedAt is null", () => {
    const user = makeUser({ emailVerifiedAt: null });
    const req = { authUser: user } as unknown as Request;
    const res = makeRes();
    handleMe(req, res as unknown as Response);
    const body = res._body as Record<string, unknown>;
    expect(body["emailVerified"]).toBe(false);
  });

  it("sets emailVerified=true when emailVerifiedAt is a Date", () => {
    const user = makeUser({ emailVerifiedAt: new Date("2024-01-01") });
    const req = { authUser: user } as unknown as Request;
    const res = makeRes();
    handleMe(req, res as unknown as Response);
    const body = res._body as Record<string, unknown>;
    expect(body["emailVerified"]).toBe(true);
  });

  it("forwards a non-null displayName", () => {
    const user = makeUser({ displayName: "Alice Wonderland" });
    const req = { authUser: user } as unknown as Request;
    const res = makeRes();
    handleMe(req, res as unknown as Response);
    const body = res._body as Record<string, unknown>;
    expect(body["displayName"]).toBe("Alice Wonderland");
  });

  it("forwards null displayName", () => {
    const user = makeUser({ displayName: null });
    const req = { authUser: user } as unknown as Request;
    const res = makeRes();
    handleMe(req, res as unknown as Response);
    const body = res._body as Record<string, unknown>;
    expect(body["displayName"]).toBeNull();
  });

  it("uses emailLower as the email field in the response", () => {
    const user = makeUser({ emailLower: "carol@example.com" });
    const req = { authUser: user } as unknown as Request;
    const res = makeRes();
    handleMe(req, res as unknown as Response);
    const body = res._body as Record<string, unknown>;
    expect(body["email"]).toBe("carol@example.com");
  });

  it("response has exactly the expected keys (regression — no extra fields)", () => {
    const user = makeUser({ emailVerifiedAt: new Date() });
    const req = { authUser: user } as unknown as Request;
    const res = makeRes();
    handleMe(req, res as unknown as Response);
    const body = res._body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["displayName", "email", "emailVerified", "id", "role"].sort(),
    );
  });
});

describe("handleMe — 401 belt-and-braces guard", () => {
  it("returns 401 with session_required when req.authUser is undefined", () => {
    // In production this is unreachable because requireSession runs first.
    // The guard is a defensive belt-and-braces check.
    const req = { authUser: undefined } as unknown as Request;
    const res = makeRes();
    handleMe(req, res as unknown as Response);
    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "session_required" });
  });
});
