// Regression tests for the POST /shop/me/chat rate-limit (429) responder.
//
// Why this file exists
// --------------------
// The 429 handler resolves the tenant's own support phone so the copy carries
// the right brand. It used to be an `async handler` with NO try/catch:
//
//     handler: async (req, res) => {
//       const info = req.orgId ? await getCompanyInfo(req.orgId) : …
//
// express-rate-limit types `handler` as returning void and never awaits it, so
// a rejection there did not surface as a 500 — it escaped as an
// unhandledRejection, and index.ts installs a process-level trap that
// deliberately EXITS on one. A rate-limited patient plus one company-info
// failure would therefore have restarted the whole API for every user.
//
// The handler is now synchronous, driving its await through a `void`-ed IIFE
// with its own try/catch. These tests pin the three properties that matter:
//   1. the limiter still returns a well-formed 429 body,
//   2. a REJECTING company-info lookup still yields a 429 (degraded copy),
//   3. that failure produces NO unhandledRejection — the actual bug.
//
// The limiter is module-scoped and keyed by customer id, so each test uses a
// distinct signed-in customer to get a fresh bucket.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import { makeRequireSignedInMock } from "../../test-helpers/auth-mocks";
import { installSupabaseMock } from "../../test-helpers/supabase-mock";
import { RATE_LIMITS } from "../../lib/rate-limits-config";

installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: { current: null as string | null },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

// Company-info resolution is the call that used to sink the process.
const { getCompanyInfoMock, getCompanyInfoSyncMock } = vi.hoisted(() => ({
  getCompanyInfoMock: vi.fn(),
  getCompanyInfoSyncMock: vi.fn(),
}));
vi.mock("../../lib/company-info", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/company-info")>();
  return {
    ...actual,
    getCompanyInfo: getCompanyInfoMock,
    getCompanyInfoSync: getCompanyInfoSyncMock,
  };
});

import chatRouter from "./me-chat";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(chatRouter);
  return app;
}

const LIMIT = RATE_LIMITS.me_chat.limit;

/** A minimal CompanyInfo-shaped stub; only the phone field is read here. */
function companyInfo(supportPhoneDisplay: string | null) {
  return { supportPhoneDisplay } as unknown as Awaited<
    ReturnType<typeof import("../../lib/company-info").getCompanyInfo>
  >;
}

/**
 * Drive the limiter past its budget for `customerId` and return the first 429.
 * Sends an INVALID body so each call short-circuits at validation (fast, no
 * LLM path) — express-rate-limit counts every request, not just successes.
 */
async function exhaustLimiter(customerId: string) {
  mockSignedIn.current = customerId;
  const app = makeApp();
  let last: request.Response | undefined;
  for (let i = 0; i <= LIMIT; i++) {
    last = await request(app).post("/shop/me/chat").send({ messages: [] });
    if (last.status === 429) break;
  }
  return last!;
}

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  getCompanyInfoMock.mockReset();
  getCompanyInfoSyncMock.mockReset();
  getCompanyInfoSyncMock.mockReturnValue(companyInfo(null));
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

/** Let any pending rejection be reported before asserting on the trap. */
async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 20));
}

describe("POST /shop/me/chat — 429 responder", () => {
  it("returns a well-formed 429 body once the budget is exhausted", async () => {
    getCompanyInfoMock.mockResolvedValue(companyInfo(null));

    const res = await exhaustLimiter("cust_429_shape");

    expect(res.status).toBe(429);
    expect(res.body.rateLimited).toBe(true);
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply).toContain("too quickly");
  });

  it("includes the tenant's own support phone in the 429 copy", async () => {
    getCompanyInfoMock.mockResolvedValue(companyInfo("(555) 010-7788"));

    const res = await exhaustLimiter("cust_429_phone");

    expect(res.status).toBe(429);
    expect(res.body.reply).toContain("(555) 010-7788");
    expect(res.body.reply).toContain("immediate help");
  });

  it("still answers 429 — and does NOT emit an unhandledRejection — when company-info rejects", async () => {
    // THE REGRESSION. Before the fix this rejection escaped the un-awaited
    // async handler and tripped index.ts's process-exit trap.
    getCompanyInfoMock.mockRejectedValue(new Error("supabase unreachable"));

    const res = await exhaustLimiter("cust_429_reject");
    await flushMicrotasks();

    expect(res.status).toBe(429);
    expect(res.body.rateLimited).toBe(true);
    // Degraded copy: no phone clause, but still a usable message.
    expect(res.body.reply).toContain("too quickly");
    expect(res.body.reply).not.toContain("immediate help");
    expect(getCompanyInfoMock).toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
