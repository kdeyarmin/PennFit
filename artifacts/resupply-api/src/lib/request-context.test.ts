// Unit tests for the AsyncLocalStorage request-context propagation
// (P3.7). The contract that matters in production is "log lines and
// audit rows from arbitrary helper depth carry the same request_id
// pino-http put on the access log". These tests pin the primitive
// behaviour that contract relies on:
//
//   1. getRequestId() is null outside any scope.
//   2. Inside a runWithRequestContext scope, getRequestId() returns
//      the bound id — even after `await` boundaries.
//   3. The Express middleware reads `req.id` (or a sentinel when it
//      is absent) and runs `next()` inside the scope.
//   4. Concurrent requests don't bleed ids between each other.

import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

import {
  getRequestContext,
  getRequestId,
  requestContextMiddleware,
  runWithRequestContext,
} from "./request-context";

describe("request-context", () => {
  it("getRequestId returns null outside any scope", () => {
    expect(getRequestId()).toBeNull();
    expect(getRequestContext()).toBeNull();
  });

  it("propagates the requestId across awaits inside the scope", async () => {
    const seen: Array<string | null> = [];
    await runWithRequestContext({ requestId: "req-abc" }, async () => {
      seen.push(getRequestId());
      await Promise.resolve();
      seen.push(getRequestId());
      await new Promise((r) => setTimeout(r, 0));
      seen.push(getRequestId());
    });
    expect(seen).toEqual(["req-abc", "req-abc", "req-abc"]);
    // Outside the scope the store is restored.
    expect(getRequestId()).toBeNull();
  });

  it("middleware uses req.id and runs next() inside the scope", () => {
    let observed: string | null = null;
    const req = { id: "req-xyz" } as unknown as Request;
    const res = {} as Response;
    const next: NextFunction = () => {
      observed = getRequestId();
    };
    requestContextMiddleware(req, res, next);
    expect(observed).toBe("req-xyz");
  });

  it("middleware coerces non-string req.id to a string", () => {
    let observed: string | null = null;
    const req = { id: 12345 } as unknown as Request;
    const res = {} as Response;
    requestContextMiddleware(req, res, () => {
      observed = getRequestId();
    });
    expect(observed).toBe("12345");
  });

  it("middleware falls back to 'anon' when req.id is missing", () => {
    let observed: string | null = null;
    const req = {} as unknown as Request;
    const res = {} as Response;
    requestContextMiddleware(req, res, () => {
      observed = getRequestId();
    });
    expect(observed).toBe("anon");
  });

  it("concurrent scopes do not bleed ids", async () => {
    // Two interleaved request scopes; each captures its own id at
    // multiple await points and asserts the id stayed stable.
    const collect = (id: string, work: number): Promise<string[]> =>
      runWithRequestContext({ requestId: id }, async () => {
        const out: string[] = [];
        for (let i = 0; i < work; i++) {
          await new Promise((r) => setTimeout(r, 0));
          const here = getRequestId();
          if (here != null) out.push(here);
        }
        return out;
      });

    const [a, b, c] = await Promise.all([
      collect("req-A", 3),
      collect("req-B", 3),
      collect("req-C", 3),
    ]);
    expect(a).toEqual(["req-A", "req-A", "req-A"]);
    expect(b).toEqual(["req-B", "req-B", "req-B"]);
    expect(c).toEqual(["req-C", "req-C", "req-C"]);
  });

  it("logger mixin pattern: a function reading getRequestId from inside a deferred callback sees the active scope", async () => {
    // Mirrors what `lib/logger.ts`'s pino mixin does: pino calls the
    // mixin synchronously when it builds a log line; the mixin reads
    // getRequestId(); whichever ALS scope is active at the call site
    // wins.
    const mixin = (): Record<string, string> => {
      const id = getRequestId();
      return id ? { requestId: id } : {};
    };

    const result = vi.fn();
    await runWithRequestContext({ requestId: "req-mix" }, async () => {
      // Simulate a route handler that calls a helper which logs.
      await Promise.resolve();
      result(mixin());
    });
    expect(result).toHaveBeenCalledWith({ requestId: "req-mix" });
  });
});
