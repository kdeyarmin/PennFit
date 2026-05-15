// Tests for adminMutationLooseLimit — the path+method-aware
// defense-in-depth IP rate limit applied at the app level on
// `/admin/*` mutations.
//
// Coverage:
//   * Safe methods (GET/HEAD/OPTIONS) pass through on admin paths.
//   * Non-admin POST paths pass through (storefront mutations gate
//     themselves via their own limiters / requireCsrf).
//   * POST on /api/admin/* and PATCH on /resupply-api/admin/* are
//     gated by the IP-keyed bucket.
//   * Look-alike admin prefixes (/api/admin-export) don't match.
//   * 429 envelope carries the limiter name + Retry-After when the
//     bucket overflows.
//
// The underlying rateLimit primitive's bucket logic is exercised
// indirectly here; admin-rate-limit.test.ts covers the unwrapped
// version against the same primitive.

import type { NextFunction, Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { adminMutationLooseLimit } from "./rate-limit";

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status(code: number): FakeRes;
  setHeader(k: string, v: string): void;
  json(payload: unknown): FakeRes;
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeReq(opts: {
  method: string;
  path: string;
  ip?: string;
}): Request {
  return {
    method: opts.method,
    path: opts.path,
    ip: opts.ip ?? "127.0.0.1",
    socket: { remoteAddress: opts.ip ?? "127.0.0.1" },
  } as unknown as Request;
}

function drive(
  mw: ReturnType<typeof adminMutationLooseLimit>,
  req: Request,
): { res: FakeRes; nextCalled: boolean } {
  const res = makeRes();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  mw(req, res as unknown as Response, next);
  return { res, nextCalled };
}

describe("adminMutationLooseLimit", () => {
  it.each(["GET", "HEAD", "OPTIONS"])(
    "passes through %s requests under /api/admin/",
    (method) => {
      const mw = adminMutationLooseLimit();
      const { res, nextCalled } = drive(
        mw,
        makeReq({ method, path: "/api/admin/users" }),
      );
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
    },
  );

  it("passes through POST on non-admin paths", () => {
    const mw = adminMutationLooseLimit();
    const { res, nextCalled } = drive(
      mw,
      makeReq({ method: "POST", path: "/api/orders" }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("does not match look-alike admin prefixes", () => {
    // Regression guard: '/api/admin-export' must NOT match
    // '/api/admin/'. The middleware uses a trailing slash to bound
    // the prefix so look-alike paths fall through.
    const mw = adminMutationLooseLimit();
    const { res, nextCalled } = drive(
      mw,
      makeReq({ method: "POST", path: "/api/admin-export" }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("gates POST on /api/admin/* and PATCH on /resupply-api/admin/*", () => {
    const mw = adminMutationLooseLimit();
    const r1 = drive(mw, makeReq({ method: "POST", path: "/api/admin/users/invite" }));
    expect(r1.nextCalled).toBe(true);
    expect(r1.res.headers["X-RateLimit-Limit"]).toBe("300");

    const r2 = drive(
      mw,
      makeReq({ method: "PATCH", path: "/resupply-api/admin/shop/orders/abc" }),
    );
    expect(r2.nextCalled).toBe(true);
    expect(r2.res.headers["X-RateLimit-Limit"]).toBe("300");
  });

  it("shares one bucket across both mount prefixes when keyed by IP", () => {
    // Both /api/admin/* and /resupply-api/admin/* are paths the same
    // attacker session could hammer. The limiter is IP-keyed, so the
    // counter must accumulate across both prefixes — not be reset
    // per-path.
    const mw = adminMutationLooseLimit();
    let lastRemaining: number | null = null;
    for (let i = 0; i < 3; i++) {
      const path =
        i % 2 === 0 ? "/api/admin/users" : "/resupply-api/admin/customers";
      const { res } = drive(mw, makeReq({ method: "POST", path, ip: "1.2.3.4" }));
      lastRemaining = Number(res.headers["X-RateLimit-Remaining"]);
    }
    // After 3 hits, remaining should be 297 — proving the bucket
    // didn't reset between the two prefixes.
    expect(lastRemaining).toBe(297);
  });

  it("isolates buckets by IP", () => {
    const mw = adminMutationLooseLimit();
    drive(mw, makeReq({ method: "POST", path: "/api/admin/users", ip: "1.1.1.1" }));
    drive(mw, makeReq({ method: "POST", path: "/api/admin/users", ip: "1.1.1.1" }));
    const { res } = drive(
      mw,
      makeReq({ method: "POST", path: "/api/admin/users", ip: "2.2.2.2" }),
    );
    // 2.2.2.2's first hit — remaining should still be near the cap.
    expect(Number(res.headers["X-RateLimit-Remaining"])).toBe(299);
  });

  it("returns 429 with limiter name + retry-after when over budget", () => {
    const mw = adminMutationLooseLimit();
    const ip = "9.9.9.9";
    // Fire 300 successful requests; the 301st must 429.
    for (let i = 0; i < 300; i++) {
      drive(mw, makeReq({ method: "POST", path: "/api/admin/users", ip }));
    }
    const { res, nextCalled } = drive(
      mw,
      makeReq({ method: "POST", path: "/api/admin/users", ip }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({
      error: "too_many_requests",
      limiter: "admin_mutation_loose_ip",
    });
    expect(res.headers["Retry-After"]).toBeDefined();
  });
});
