// Tests for requireCsrf — the storefront / admin CSRF middleware.
//
// Coverage:
//   * Matching cookie + header → next() is called, no body written.
//   * Missing cookie → 403 with `csrf_failed`.
//   * Missing header → 403 with `csrf_failed`.
//   * Mismatch → 403 with `csrf_failed`.
//   * Constant-time padding holds even when lengths differ (smoke).
//   * 403 body never leaks WHICH half was missing (no `reason` in
//     response).
//
// The underlying `checkCsrf` primitive in lib/resupply-auth has its
// own unit tests; this file only exercises the middleware wiring.

import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import {
  requireCsrf,
  requireCsrfOnAdminMutations,
  requireCsrfWhenSession,
} from "./csrf";

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeReq(opts: {
  cookie?: string;
  header?: string;
  session?: string;
}): Request {
  // `checkCsrf` reads cookies from the raw `Cookie:` header (see
  // `lib/resupply-auth/src/cookies.ts` readCookie), not from any
  // pre-parsed `req.cookies` map, so the fake req carries the header.
  const cookieParts: string[] = [];
  if (opts.cookie) cookieParts.push(`pf_csrf=${opts.cookie}`);
  if (opts.session) cookieParts.push(`pf_session=${opts.session}`);
  const cookieHeader = cookieParts.length > 0 ? cookieParts.join("; ") : undefined;
  return {
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(opts.header ? { "x-pf-csrf": opts.header } : {}),
    },
    method: "POST",
    path: "/orders",
  } as unknown as Request;
}

function run(req: Request): { res: FakeRes; nextCalled: boolean } {
  const res = makeRes();
  let nextCalled = false;
  requireCsrf(req, res as unknown as Response, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

function runWhenSession(req: Request): {
  res: FakeRes;
  nextCalled: boolean;
} {
  const res = makeRes();
  let nextCalled = false;
  requireCsrfWhenSession(req, res as unknown as Response, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

describe("requireCsrf", () => {
  it("calls next() when cookie and header match", () => {
    const token = "abc123def456ghi789";
    const { res, nextCalled } = run(
      makeReq({ cookie: token, header: token }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("returns 403 csrf_failed when the header is missing", () => {
    const { res, nextCalled } = run(makeReq({ cookie: "abc123" }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when the cookie is missing", () => {
    const { res, nextCalled } = run(makeReq({ header: "abc123" }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when the cookie and header don't match", () => {
    const { res, nextCalled } = run(
      makeReq({ cookie: "abc123", header: "xyz789" }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when cookie and header have different lengths", () => {
    // The primitive pads both sides to 128 bytes for constant-time
    // comparison. A length mismatch is still a failure — verify the
    // middleware surfaces it the same way as a content mismatch.
    const { res, nextCalled } = run(
      makeReq({ cookie: "short", header: "much-longer-value-here" }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("does not leak the failure reason in the response body", () => {
    // Surveyors and threat-modelers both flag the reason as an
    // enumeration aid. The middleware logs it via req.log but the
    // 403 body must contain only the generic `csrf_failed` envelope.
    const { res } = run(makeReq({ cookie: "abc" }));
    const body = res.body as { error?: string; reason?: string };
    expect(body.reason).toBeUndefined();
    expect(body.error).toBe("csrf_failed");
  });

  it("invokes req.log.warn with structured context when present", () => {
    const warn = vi.fn();
    const req = makeReq({ cookie: "abc" });
    (req as unknown as { log: { warn: typeof warn } }).log = { warn };
    requireCsrf(req, makeRes() as unknown as Response, () => undefined);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatchObject({
      event: "csrf_failed",
      reason: "missing_header",
      method: "POST",
      path: "/orders",
    });
  });
});

describe("requireCsrfWhenSession", () => {
  it("passes through when no session cookie is present", () => {
    // Anonymous storefront caller: no pf_session, no auth, no
    // replay surface. Letting the request through preserves the
    // anonymous-order flow.
    const { res, nextCalled } = runWhenSession(makeReq({}));
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("passes through anonymous requests even when the CSRF header is set", () => {
    // Some clients may attach the header regardless. Without a
    // session cookie, the header is irrelevant — still allow.
    const { res, nextCalled } = runWhenSession(
      makeReq({ header: "abc" }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("enforces double-submit when the session cookie is present", () => {
    // Signed-in caller: pf_session present → CSRF gate applies.
    // Missing the matching header → 403.
    const { res, nextCalled } = runWhenSession(
      makeReq({ session: "sess-1", cookie: "abc123" }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("calls next() when cookie + header match and session is present", () => {
    const token = "abc123def456";
    const { res, nextCalled } = runWhenSession(
      makeReq({ session: "sess-1", cookie: token, header: token }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("returns 403 csrf_failed when session is present but both cookie and header are absent", () => {
    // Only pf_session cookie set — no pf_csrf cookie, no X-PF-CSRF header.
    // The gate should detect missing CSRF material and deny.
    const { res, nextCalled } = runWhenSession(makeReq({ session: "sess-1" }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when session present and tokens mismatch", () => {
    const { res, nextCalled } = runWhenSession(
      makeReq({ session: "sess-1", cookie: "token-A", header: "token-B" }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("does not leak the failure reason in the response body", () => {
    const { res } = runWhenSession(
      makeReq({ session: "sess-1", cookie: "abc" }),
    );
    const body = res.body as { error?: string; reason?: string };
    expect(body.reason).toBeUndefined();
    expect(body.error).toBe("csrf_failed");
  });
});

describe("requireCsrfOnAdminMutations", () => {
  function makePathReq(opts: {
    method: string;
    path: string;
    cookie?: string;
    header?: string;
  }): Request {
    const cookieHeader = opts.cookie ? `pf_csrf=${opts.cookie}` : undefined;
    return {
      headers: {
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(opts.header ? { "x-pf-csrf": opts.header } : {}),
      },
      method: opts.method,
      path: opts.path,
    } as unknown as Request;
  }

  function runPath(req: Request): { res: FakeRes; nextCalled: boolean } {
    const res = makeRes();
    let nextCalled = false;
    requireCsrfOnAdminMutations(req, res as unknown as Response, () => {
      nextCalled = true;
    });
    return { res, nextCalled };
  }

  it.each(["GET", "HEAD", "OPTIONS"])(
    "passes through %s requests on admin paths",
    (method) => {
      const { res, nextCalled } = runPath(
        makePathReq({ method, path: "/api/admin/users" }),
      );
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
    },
  );

  it("passes through non-admin POST paths", () => {
    // Storefront mutations (e.g. POST /api/orders) opt into CSRF on
    // their own — this middleware must not gate them.
    const { res, nextCalled } = runPath(
      makePathReq({ method: "POST", path: "/api/orders" }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("passes through non-admin POST under /resupply-api", () => {
    const { res, nextCalled } = runPath(
      makePathReq({ method: "POST", path: "/resupply-api/voice/inbound" }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("enforces CSRF on POST /api/admin/* mutations", () => {
    const { res, nextCalled } = runPath(
      makePathReq({ method: "POST", path: "/api/admin/users/invite" }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("enforces CSRF on PATCH /resupply-api/admin/* mutations", () => {
    const { res, nextCalled } = runPath(
      makePathReq({
        method: "PATCH",
        path: "/resupply-api/admin/shop/orders/abc/notes",
      }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("enforces CSRF on DELETE under admin trees", () => {
    const { res, nextCalled } = runPath(
      makePathReq({
        method: "DELETE",
        path: "/resupply-api/admin/csr-macros/m_42",
      }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("calls next() when CSRF cookie + header match on an admin path", () => {
    const token = "valid-csrf-token";
    const { res, nextCalled } = runPath(
      makePathReq({
        method: "POST",
        path: "/api/admin/users/invite",
        cookie: token,
        header: token,
      }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("does not match prefixes that merely contain 'admin' substrings", () => {
    // Regression guard: '/api/admin-export' must NOT match
    // '/api/admin/'. The middleware accepts only an exact match of
    // the admin prefix or a continuation with a trailing slash, so
    // look-alike paths fall through to their own gates.
    const { res, nextCalled } = runPath(
      makePathReq({ method: "POST", path: "/api/admin-export" }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it.each([
    "/API/ADMIN/users/invite",
    "/Api/Admin/users/invite",
    "/api/Admin/users/invite",
    "/RESUPPLY-API/ADMIN/shop/orders/abc/notes",
  ])("enforces CSRF on the mixed-case admin path %s", (path) => {
    // Express's default routing is case-insensitive (`case sensitive
    // routing` is off), so a mutation aimed at the admin route
    // arrives here with whatever casing the attacker chose. A
    // case-sensitive `startsWith` would silently bypass the gate —
    // verify the lowercase-normalized check holds.
    const { res, nextCalled } = runPath(
      makePathReq({ method: "POST", path }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("gates a request to the bare /api/admin path (no trailing slash)", () => {
    // Defensive: no route mounts at exactly `/api/admin` today, but
    // the contract should hold if a future router lands there.
    const { res, nextCalled } = runPath(
      makePathReq({ method: "POST", path: "/api/admin" }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe("requireCsrf — response envelope", () => {
  it("includes a human-readable message field alongside the error code", () => {
    // The 403 body must carry both `error` (machine-readable) and
    // `message` (user-readable) so the SPA can surface a toast.
    const { res } = run(makeReq({ cookie: "abc" }));
    const body = res.body as { error?: string; message?: string };
    expect(body.error).toBe("csrf_failed");
    expect(typeof body.message).toBe("string");
    expect(body.message!.length).toBeGreaterThan(0);
  });

  it("does not call next() on a missing cookie even when header is present", () => {
    // Regression guard: ensure the gate is not accidentally inverted
    // (i.e. blocking on missing header but ignoring missing cookie).
    const { res, nextCalled } = run(makeReq({ header: "x".repeat(32) }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("does not call next() when both cookie and header are absent", () => {
    // A request with no CSRF material at all must be blocked.
    const { res, nextCalled } = run(makeReq({}));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("does not write a log entry on a successful CSRF check", () => {
    // On success, log.warn should NOT be called — the warn path is
    // for failures only.
    const warn = vi.fn();
    const token = "valid-token-xyz";
    const req = makeReq({ cookie: token, header: token });
    (req as unknown as { log: { warn: typeof warn } }).log = { warn };
    requireCsrf(req, makeRes() as unknown as Response, () => undefined);
    expect(warn).not.toHaveBeenCalled();
  });
});
