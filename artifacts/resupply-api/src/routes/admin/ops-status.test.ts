// Route tests for /admin/ops-status (Phase G.18).
//
// Covers the operations-center status feed end-to-end:
//   * 401 without admin
//   * vendor flag presence (sendgrid / twilio / stripe / object-storage)
//   * dispatcher-eligible counts (cart, review, rx renewal, smart trigger)
//   * Phase G.16 queues block (faxOutreachPending)
//   * team counts shape

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// We script the SELECT count() answers in order. Each helper returns
// a chainable { from, where }-shaped object whose terminal call
// resolves the queued result.
//
// The shift() THROWS on an empty queue rather than silently
// returning 0 — without this, adding a SELECT to the route or
// forgetting to script a count would still keep the tests green
// with a bogus zero, defeating the safety net these helpers
// provide.
const selectQueue: number[] = [];
const dbStub = {
  select: vi.fn(() => {
    if (selectQueue.length === 0) {
      throw new Error(
        "ops-status test: selectQueue exhausted — the route made " +
          "more SELECT count() calls than the test scripted answers " +
          "for. Add a queueCounts() entry for the new query.",
      );
    }
    const value = selectQueue.shift()!;
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => Promise.resolve([{ count: value }]),
    };
    return obj;
  }),
};

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

import opsStatusRouter from "./ops-status";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(opsStatusRouter);
  return app;
}

const ALL_VENDOR_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "STRIPE_SECRET_KEY",
  "PRIVATE_OBJECT_DIR",
] as const;

const originalEnv: Partial<
  Record<(typeof ALL_VENDOR_KEYS)[number], string | undefined>
> = {};

beforeEach(() => {
  for (const k of ALL_VENDOR_KEYS) originalEnv[k] = process.env[k];
  for (const k of ALL_VENDOR_KEYS) delete process.env[k];
  mockAdmin.current = null;
  selectQueue.length = 0;
});

afterEach(() => {
  for (const k of ALL_VENDOR_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

/**
 * Push the 8 SELECT count() answers the route makes, in order:
 *   1. abandoned-cart eligible
 *   2. review-request eligible
 *   3. rx-renewal eligible
 *   4. smart-trigger eligible
 *   5. fax-outreach pending (Phase G.16)
 *   6. active admin count
 *   7. active agent count
 *   8. pending invite count
 */
function queueCounts(counts: number[]) {
  for (const c of counts) selectQueue.push(c);
}

describe("GET /admin/ops-status", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.status).toBe(401);
  });

  it("returns all-false vendor flags when no env vars are set", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    queueCounts([0, 0, 0, 0, 0, 0, 0, 0]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.status).toBe(200);
    expect(res.body.vendors).toEqual({
      sendgrid: false,
      twilioVoice: false,
      twilioSms: false,
      stripe: false,
      objectStorage: false,
    });
  });

  it("flags sendgrid only when both API key + from email are set", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    process.env.SENDGRID_API_KEY = "SG.xxx";
    // FROM_EMAIL deliberately missing.
    queueCounts([0, 0, 0, 0, 0, 0, 0, 0]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.body.vendors.sendgrid).toBe(false);
  });

  it("flags twilioSms only when SID + token + messaging service are all set", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    process.env.TWILIO_ACCOUNT_SID = "ACxxx";
    process.env.TWILIO_AUTH_TOKEN = "auth";
    // MESSAGING_SERVICE_SID missing → SMS off but Voice still on.
    queueCounts([0, 0, 0, 0, 0, 0, 0, 0]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.body.vendors.twilioVoice).toBe(true);
    expect(res.body.vendors.twilioSms).toBe(false);
  });

  // True-branch coverage: with every vendor's env triple set, every
  // flag flips on. Catches typos in the env-name string literals
  // (e.g. SENDGRID_API_KEY → SENDGIRD_API_KEY) that the all-false +
  // partial-config tests above would miss because they only exercise
  // the falsy branch.
  it("flags every vendor when its full env triple is set", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    process.env.SENDGRID_API_KEY = "SG.xxx";
    process.env.SENDGRID_FROM_EMAIL = "info@pennpaps.com";
    process.env.TWILIO_ACCOUNT_SID = "ACxxx";
    process.env.TWILIO_AUTH_TOKEN = "auth";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MGxxx";
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.PRIVATE_OBJECT_DIR = "/objects";
    queueCounts([0, 0, 0, 0, 0, 0, 0, 0]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.body.vendors).toEqual({
      sendgrid: true,
      twilioVoice: true,
      twilioSms: true,
      stripe: true,
      objectStorage: true,
    });
  });

  it("returns dispatcher counts in the correct shape", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    queueCounts([3, 5, 7, 11, 0, 0, 0, 0]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.body.dispatchers).toEqual({
      abandonedCart: { eligibleNow: 3 },
      reviewRequest: { eligibleNow: 5 },
      rxRenewal: { eligibleNow: 7 },
      smartTrigger: { eligibleNow: 11 },
    });
  });

  it("returns the Phase G.16 queues block with faxOutreachPending count", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    queueCounts([0, 0, 0, 0, 4, 0, 0, 0]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.body.queues).toEqual({
      faxOutreachPending: { count: 4 },
    });
  });

  it("returns team counts in the correct shape", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    queueCounts([0, 0, 0, 0, 0, 2, 6, 1]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.body.team).toEqual({
      activeAdmins: 2,
      activeAgents: 6,
      pendingInvites: 1,
    });
  });

  it("includes serverTime as ISO 8601 timestamp", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    queueCounts([0, 0, 0, 0, 0, 0, 0, 0]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(typeof res.body.serverTime).toBe("string");
    // Roundtrip through Date must equal the input — catches a
    // regression to toString() / RFC2822 (which Date can parse but
    // produces a different canonical form).
    const parsed = new Date(res.body.serverTime);
    expect(parsed.toISOString()).toBe(res.body.serverTime);
    // Defence-in-depth: explicit ISO 8601 shape match.
    expect(res.body.serverTime).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});
