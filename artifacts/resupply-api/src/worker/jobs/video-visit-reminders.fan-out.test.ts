// Video-visit reminder sweep: per-tenant flag gate + multi-tenant fan-out.
//
// The pure target-selection / compose logic is covered in
// video-visit-reminders.test.ts, and the full claim-and-send body runs
// against a real PostgREST surface in the integration suite
// (video-visit-reminders.integration.test.ts). Here we cover the control
// flow the fan-out introduced: the telehealth + per-channel reminder flags
// are evaluated PER TENANT (with the org_id), and the sweep walks every
// active tenant (and no-ops cleanly when there are none).

import { describe, it, expect, vi, beforeEach } from "vitest";

const isFeatureEnabledMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

const listActiveOrgIdsMock = vi.hoisted(() => vi.fn());
const orgScopedFromMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/resupply-db", () => ({
  listActiveOrgIds: listActiveOrgIdsMock,
  resolveSeedOrgId: vi.fn(),
  getOrgScopedClient: vi.fn(() => ({ from: orgScopedFromMock })),
  getSupabaseServiceRoleClient: vi.fn(),
}));

// SendGrid constructs (email channel available); Twilio does not. So the
// fan-out has something deliverable and proceeds to the per-tenant body.
// The error classes are declared INSIDE the factories — vi.mock is hoisted
// above any top-level declarations, so referencing an outer class throws.
const sendEmailMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@workspace/resupply-email", () => {
  class EmailConfigError extends Error {}
  return {
    createSendgridClient: () => ({ sendEmail: sendEmailMock }),
    EmailConfigError,
  };
});
vi.mock("@workspace/resupply-telecom", () => {
  class TwilioConfigError extends Error {}
  return {
    createTwilioSmsClient: () => {
      throw new TwilioConfigError("no creds in test");
    },
    TwilioConfigError,
  };
});

vi.mock("../../lib/messaging/messaging-config", () => ({
  readPracticeName: () => "PennPaps",
}));

import { runVideoVisitReminderSweep } from "./video-visit-reminders";

// A chainable PostgREST stub whose terminal `.limit()` yields an empty
// page — so each swept tenant scans zero visits and the body completes.
function emptyVisitQuery() {
  const builder: Record<string, unknown> = {};
  for (const verb of ["select", "eq", "is", "gte", "lte", "order"]) {
    builder[verb] = () => builder;
  }
  builder.limit = async () => ({ data: [], error: null });
  return builder;
}

beforeEach(() => {
  isFeatureEnabledMock.mockReset().mockResolvedValue(true);
  listActiveOrgIdsMock.mockReset().mockResolvedValue([]);
  orgScopedFromMock.mockReset().mockImplementation(() => emptyVisitQuery());
  sendEmailMock.mockReset();
});

describe("runVideoVisitReminderSweep — per-tenant flag gate + fan-out", () => {
  it("walks every active tenant, checking telehealth.video with the org_id", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a", "org-b"]);
    const stats = await runVideoVisitReminderSweep(new Date());

    // Empty rosters → nothing sent, but both tenants were swept.
    expect(stats.scanned).toBe(0);
    expect(stats.errors).toBe(0);
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "telehealth.video",
      "org-a",
    );
    expect(isFeatureEnabledMock).toHaveBeenCalledWith(
      "telehealth.video",
      "org-b",
    );
    // Each enabled tenant read its own visits queue (org-scoped client).
    expect(orgScopedFromMock).toHaveBeenCalledTimes(2);
    expect(orgScopedFromMock).toHaveBeenCalledWith("video_visits");
  });

  it("does not sweep a tenant whose telehealth.video flag is OFF", async () => {
    listActiveOrgIdsMock.mockResolvedValue(["org-a"]);
    isFeatureEnabledMock.mockImplementation(async (key: string) =>
      key === "telehealth.video" ? false : true,
    );
    const stats = await runVideoVisitReminderSweep(new Date());
    expect(stats.scanned).toBe(0);
    // Flag off → no visits read for that tenant.
    expect(orgScopedFromMock).not.toHaveBeenCalled();
  });

  it("no-ops when there are no active tenants (no flag check)", async () => {
    listActiveOrgIdsMock.mockResolvedValue([]);
    const stats = await runVideoVisitReminderSweep(new Date());
    expect(stats).toEqual({
      scanned: 0,
      sent: 0,
      skippedNoChannel: 0,
      skippedClaimRace: 0,
      errors: 0,
    });
    expect(isFeatureEnabledMock).not.toHaveBeenCalled();
  });
});
