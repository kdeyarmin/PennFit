// Tests for the top-level Express error handler.
//
// The load-bearing case is a PLAIN-OBJECT rejection. supabase-js/PostgREST and
// node-postgres reject with `{ code, message, details, hint }` rather than an
// `Error`, and Supabase is this app's only data path — so that shape is the
// most common cause of a 5xx. The handler used to attach the thrown value only
// when it was `instanceof Error`, which meant every data-layer failure logged
// as `errName: "object"` with no code, no message, and nothing to grep. A real
// example: `GET /admin/billing/ai-queue` 500'd on every request for every
// tenant (an ambiguous PostgREST embed rejecting with PGRST201) and the log
// line said nothing but "object".

import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const errorMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/logger", () => ({
  logger: { error: errorMock },
}));

import { errorHandler } from "./errorHandler";

function makeRes(): Response & {
  statusCode?: number;
  body?: unknown;
  headersSent: boolean;
} {
  const res = {
    headersSent: false,
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode?: number;
    body?: unknown;
    headersSent: boolean;
  };
}

function makeReq(id = "req-1"): Request {
  return { id } as unknown as Request;
}

/** The single log payload the handler emitted. */
function loggedPayload(): Record<string, unknown> {
  expect(errorMock).toHaveBeenCalledTimes(1);
  return errorMock.mock.calls[0]![0] as Record<string, unknown>;
}

describe("errorHandler", () => {
  beforeEach(() => {
    errorMock.mockClear();
  });

  it("logs a plain-object rejection under `err` so its code is recoverable", () => {
    const postgrestError = {
      code: "PGRST201",
      message: "Could not embed because more than one relationship was found",
      details: [{ cardinality: "one-to-many" }],
      hint: "Try changing 'insurance_claims' to one of the following: ...",
    };

    errorHandler(postgrestError, makeReq(), makeRes(), vi.fn());

    const payload = loggedPayload();
    expect(payload["event"]).toBe("unhandled_route_error");
    // Nesting under `err` is what subjects the PHI-bearing text fields to
    // pino's `err.*` redaction allowlist while letting `err.code` through.
    expect(payload["err"]).toBe(postgrestError);
    expect((payload["err"] as { code: string }).code).toBe("PGRST201");
  });

  it("still logs Error instances under `err`", () => {
    const err = new Error("boom");

    errorHandler(err, makeReq(), makeRes(), vi.fn());

    const payload = loggedPayload();
    expect(payload["err"]).toBe(err);
    expect(payload["errName"]).toBe("Error");
  });

  it("does not attach a thrown primitive to `err`", () => {
    // A bare string/number has no diagnostic fields to recover and could be
    // arbitrary text, so it is deliberately summarised by `errName` only
    // rather than logged verbatim.
    errorHandler("kaboom", makeReq(), makeRes(), vi.fn());

    const payload = loggedPayload();
    expect(payload).not.toHaveProperty("err");
    expect(payload["errName"]).toBe("string");
  });

  it("returns a 500 envelope with the request id and no error detail", () => {
    const res = makeRes();

    errorHandler(
      { code: "23505", message: "duplicate key value violates ..." },
      makeReq("req-42"),
      res,
      vi.fn(),
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: "internal_error",
      message: "Something went wrong. Please try again in a moment.",
      requestId: "req-42",
    });
    // The response must never echo the underlying failure: it can carry the
    // offending row's column values on a constraint violation.
    expect(JSON.stringify(res.body)).not.toContain("duplicate key");
    expect(JSON.stringify(res.body)).not.toContain("23505");
  });

  it("delegates to Express when the response has already started", () => {
    const res = makeRes();
    res.headersSent = true;
    const next = vi.fn();
    const err = new Error("mid-stream");

    errorHandler(err, makeReq(), res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.statusCode).toBeUndefined();
    expect(errorMock).not.toHaveBeenCalled();
  });
});
