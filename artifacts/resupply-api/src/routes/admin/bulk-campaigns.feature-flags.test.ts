// Tests for the bulk-campaigns Control Center feature gate.
//
// The feature flag "bulk_campaigns.send" blocks the "start" and "resume"
// transition actions but allows "pause" and "cancel" through even when
// the flag is disabled. This keeps operators from getting stuck — they
// can always stop a running campaign even after they've turned the
// feature off.
//
// Coverage:
//   1. POST /:id/start returns 503 with error "feature_disabled" when
//      bulk_campaigns.send is off.
//   2. POST /:id/resume returns 503 with error "feature_disabled" when
//      bulk_campaigns.send is off.
//   3. POST /:id/pause proceeds normally (no 503) when the flag is off.
//   4. POST /:id/cancel proceeds normally (no 503) when the flag is off.
//   5. The 503 response body includes a human-readable message.
//   6. POST /:id/start proceeds normally when the flag is on.

import { describe, it, expect, vi, beforeEach } from "vitest";
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

// ─── Supabase mock ────────────────────────────────────────────────────────

const supabaseMock = installSupabaseMock();

// ─── Auth mock ────────────────────────────────────────────────────────────

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
}));

// ─── Feature flag mock ────────────────────────────────────────────────────

const isFeatureEnabledMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

// ─── Suppress side-effect modules ────────────────────────────────────────

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

vi.mock("../../worker/index.js", () => ({
  getBoss: vi.fn(() => null),
}));

vi.mock("../../worker/jobs/bulk-campaign-tick.js", () => ({
  enqueueImmediateTick: vi.fn(async () => undefined),
}));

vi.mock("../../lib/bulk-campaigns/fetch-candidates", () => ({
  fetchAudienceCandidates: vi.fn(async () => []),
}));

vi.mock("../../lib/bulk-campaigns/resolve-audience", () => ({
  resolveAudience: vi.fn(async () => ({ count: 0, patientIds: [] })),
}));

// ─── SUT ──────────────────────────────────────────────────────────────────

import bulkCampaignsRouter from "./bulk-campaigns";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(bulkCampaignsRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

const DRAFT_CAMPAIGN_ID = "11111111-2222-3333-4444-555555555555";

function stageCampaignSelect(
  status: string,
  extras: Record<string, unknown> = {},
) {
  stageSupabaseResponse("bulk_campaigns", "select", {
    data: {
      id: DRAFT_CAMPAIGN_ID,
      status,
      total_recipients: 10,
      suppressed_count: 0,
      ...extras,
    },
  });
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  isFeatureEnabledMock.mockClear();
  isFeatureEnabledMock.mockResolvedValue(true);
});

// ─── Feature gate: start ──────────────────────────────────────────────────

describe("POST /admin/bulk-campaigns/:id/start — feature flag gate", () => {
  it("returns 503 with error 'feature_disabled' when bulk_campaigns.send is off", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);
    stageCampaignSelect("draft");

    const res = await request(makeApp()).post(
      `/admin/bulk-campaigns/${DRAFT_CAMPAIGN_ID}/start`,
    );

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("feature_disabled");
  });

  it("includes a human-readable message in the 503 response", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);
    stageCampaignSelect("draft");

    const res = await request(makeApp()).post(
      `/admin/bulk-campaigns/${DRAFT_CAMPAIGN_ID}/start`,
    );

    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
    expect(res.body.message.toLowerCase()).toContain("disabled");
  });

  it("proceeds normally (no 503) when the flag is on", async () => {
    stubAdmin();
    stageCampaignSelect("draft");
    stageSupabaseResponse("bulk_campaigns", "update", {
      data: [{ id: DRAFT_CAMPAIGN_ID }],
    });

    const res = await request(makeApp()).post(
      `/admin/bulk-campaigns/${DRAFT_CAMPAIGN_ID}/start`,
    );

    // 200 OK (or a non-503 status if there's an update issue — the important
    // thing is it doesn't return 503 when the flag is enabled).
    expect(res.status).not.toBe(503);
  });
});

// ─── Feature gate: resume ─────────────────────────────────────────────────

describe("POST /admin/bulk-campaigns/:id/resume — feature flag gate", () => {
  it("returns 503 with error 'feature_disabled' when bulk_campaigns.send is off", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);
    stageCampaignSelect("paused");

    const res = await request(makeApp()).post(
      `/admin/bulk-campaigns/${DRAFT_CAMPAIGN_ID}/resume`,
    );

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("feature_disabled");
  });

  it("proceeds normally (no 503) when the flag is on", async () => {
    stubAdmin();
    stageCampaignSelect("paused");
    stageSupabaseResponse("bulk_campaigns", "update", {
      data: [{ id: DRAFT_CAMPAIGN_ID }],
    });

    const res = await request(makeApp()).post(
      `/admin/bulk-campaigns/${DRAFT_CAMPAIGN_ID}/resume`,
    );

    expect(res.status).not.toBe(503);
  });
});

// ─── Feature gate does NOT block pause ───────────────────────────────────

describe("POST /admin/bulk-campaigns/:id/pause — feature flag gate", () => {
  it("does NOT return 503 for pause even when bulk_campaigns.send is off", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);
    stageCampaignSelect("sending");
    stageSupabaseResponse("bulk_campaigns", "update", {
      data: [{ id: DRAFT_CAMPAIGN_ID }],
    });

    const res = await request(makeApp()).post(
      `/admin/bulk-campaigns/${DRAFT_CAMPAIGN_ID}/pause`,
    );

    expect(res.status).not.toBe(503);
  });
});

// ─── Feature gate does NOT block cancel ──────────────────────────────────

describe("POST /admin/bulk-campaigns/:id/cancel — feature flag gate", () => {
  it("does NOT return 503 for cancel even when bulk_campaigns.send is off", async () => {
    stubAdmin();
    isFeatureEnabledMock.mockResolvedValue(false);
    stageCampaignSelect("draft");
    stageSupabaseResponse("bulk_campaigns", "update", {
      data: [{ id: DRAFT_CAMPAIGN_ID }],
    });

    const res = await request(makeApp()).post(
      `/admin/bulk-campaigns/${DRAFT_CAMPAIGN_ID}/cancel`,
    );

    expect(res.status).not.toBe(503);
  });
});