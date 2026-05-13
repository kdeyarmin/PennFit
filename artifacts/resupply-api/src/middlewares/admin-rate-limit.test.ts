// Tests for the adminRateLimit wrapper around rateLimit().
//
// Coverage:
//   * Default preset ("mutation") allows up to 60 calls/hr per actor.
//   * "destroy" preset caps at 10 calls/hr.
//   * Per-actor isolation — admin A's bucket doesn't leak into admin B's.
//   * Missing req.adminUserId falls back to a "no-actor" bucket.
//   * 429 response includes the limiter name and Retry-After.
//   * The underlying rateLimit primitive is exercised indirectly (no
//     standalone test existed for it; this fills that hole).

import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminRateLimit } from "./admin-rate-limit";

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

function makeReq(adminUserId: string | undefined): Request {
  return { adminUserId, ip: "127.0.0.1" } as unknown as Request;
}

function drive(
  mw: ReturnType<typeof adminRateLimit>,
  adminUserId: string | undefined,
): { res: FakeRes; nextCalled: boolean } {
  const req = makeReq(adminUserId);
  const res = makeRes();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  mw(req, res as unknown as Response, next);
  return { res, nextCalled };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-13T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("adminRateLimit", () => {
  it("allows up to the default 60 mutations/hr for a single actor", () => {
    const mw = adminRateLimit({ name: "test.mutation" });
    let allowed = 0;
    for (let i = 0; i < 60; i += 1) {
      const { res, nextCalled } = drive(mw, "admin-1");
      if (nextCalled) allowed += 1;
      expect(res.statusCode).toBe(200);
    }
    expect(allowed).toBe(60);
  });

  it("blocks the 61st call with 429 + Retry-After + named limiter", () => {
    const mw = adminRateLimit({ name: "test.mutation" });
    for (let i = 0; i < 60; i += 1) drive(mw, "admin-1");
    const { res, nextCalled } = drive(mw, "admin-1");
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeDefined();
    expect(res.body).toMatchObject({
      error: "too_many_requests",
      limiter: "test.mutation",
    });
  });

  it("caps the 'destroy' preset at 10/hr", () => {
    const mw = adminRateLimit({ name: "test.destroy", preset: "destroy" });
    for (let i = 0; i < 10; i += 1) {
      const { res } = drive(mw, "admin-1");
      expect(res.statusCode).toBe(200);
    }
    const { res } = drive(mw, "admin-1");
    expect(res.statusCode).toBe(429);
  });

  it("isolates buckets per admin actor", () => {
    const mw = adminRateLimit({ name: "test.destroy", preset: "destroy" });
    // Admin A burns through the cap.
    for (let i = 0; i < 11; i += 1) drive(mw, "admin-a");
    // Admin B's first call should still succeed.
    const { res, nextCalled } = drive(mw, "admin-b");
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("falls back to 'no-actor' when req.adminUserId is missing", () => {
    const mw = adminRateLimit({ name: "test.destroy", preset: "destroy" });
    // 10 calls without an adminUserId all hit the same fallback bucket.
    for (let i = 0; i < 10; i += 1) {
      const { res } = drive(mw, undefined);
      expect(res.statusCode).toBe(200);
    }
    const { res } = drive(mw, undefined);
    expect(res.statusCode).toBe(429);
  });

  it("resets after the window elapses", () => {
    const mw = adminRateLimit({ name: "test.destroy", preset: "destroy" });
    for (let i = 0; i < 10; i += 1) drive(mw, "admin-1");
    // Confirm the cap is reached.
    expect(drive(mw, "admin-1").res.statusCode).toBe(429);
    // Roll the clock past the 1h window.
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    const { res, nextCalled } = drive(mw, "admin-1");
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("honors explicit max / windowMs overrides", () => {
    const mw = adminRateLimit({
      name: "test.custom",
      max: 2,
      windowMs: 1_000,
    });
    drive(mw, "admin-1");
    drive(mw, "admin-1");
    const { res } = drive(mw, "admin-1");
    expect(res.statusCode).toBe(429);
  });
});
