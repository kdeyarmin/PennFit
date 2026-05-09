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
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

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
  "TWILIO_FAX_FROM_NUMBER",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
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
  supabaseMock.reset();
});

afterEach(() => {
  for (const k of ALL_VENDOR_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

/**
 * Stage the 8 head:true count probes the route makes, in order:
 *   1. shop_abandoned_carts (abandoned-cart eligible)
 *   2. shop_orders (review-request eligible)
 *   3. prescriptions (rx-renewal eligible)
 *   4. patient_smart_trigger_events (smart-trigger eligible)
 *   5. physician_fax_outreach (fax-outreach pending)
 *   6/7/8. admin_users — same table queried three times
 *           (active admins / active agents / pending invites)
 */
function queueCounts(counts: number[]): void {
  if (counts.length !== 8) {
    throw new Error("queueCounts expects exactly 8 values");
  }
  stageSupabaseResponse("shop_abandoned_carts", "select", {
    data: null,
    count: counts[0],
  });
  stageSupabaseResponse("shop_orders", "select", {
    data: null,
    count: counts[1],
  });
  stageSupabaseResponse("prescriptions", "select", {
    data: null,
    count: counts[2],
  });
  stageSupabaseResponse("patient_smart_trigger_events", "select", {
    data: null,
    count: counts[3],
  });
  stageSupabaseResponse("physician_fax_outreach", "select", {
    data: null,
    count: counts[4],
  });
  // admin_users is queried three times in this Promise.all; my
  // supabase mock's per-(table, op) queue is FIFO and Promise.all
  // attaches .then() to inputs in array order, so these consume in
  // the same order they're staged.
  stageSupabaseResponse("admin_users", "select", {
    data: null,
    count: counts[5],
  });
  stageSupabaseResponse("admin_users", "select", {
    data: null,
    count: counts[6],
  });
  stageSupabaseResponse("admin_users", "select", {
    data: null,
    count: counts[7],
  });
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
      twilioFax: false,
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
    process.env.TWILIO_FAX_FROM_NUMBER = "+15005550006";
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://example.com";
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    process.env.PRIVATE_OBJECT_DIR = "/objects";
    queueCounts([0, 0, 0, 0, 0, 0, 0, 0]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.body.vendors).toEqual({
      sendgrid: true,
      twilioVoice: true,
      twilioSms: true,
      twilioFax: true,
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
      pendingFax: { eligibleNow: 0 },
    });
  });

  it("returns the Phase G.16 fax-outreach pending count under dispatchers.pendingFax", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    queueCounts([0, 0, 0, 0, 4, 0, 0, 0]);
    const res = await request(makeApp()).get("/admin/ops-status");
    expect(res.body.dispatchers.pendingFax).toEqual({ eligibleNow: 4 });
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
    expect(res.body.serverTime).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(new Date(res.body.serverTime).toISOString()).toBe(
      res.body.serverTime,
    );
  });
});
