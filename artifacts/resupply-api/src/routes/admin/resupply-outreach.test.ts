import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  makeRequireAdminMock,
  MOCK_ORG_ID,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
const { admin, send, check, configured, quiet } = vi.hoisted(() => ({
  admin: { current: null as MockAdminCtx | null },
  send: vi.fn(),
  check: vi.fn(),
  configured: vi.fn(),
  quiet: vi.fn(),
}));
vi.mock("../../middlewares/requireAdmin", () => makeRequireAdminMock(admin));
vi.mock("../../worker/index", () => ({ getBoss: () => ({ send }) }));
vi.mock("../../lib/resupply/csr-outreach", () => ({ checkCsrOutreach: check }));
vi.mock("@workspace/resupply-secrets", () => ({ hasLinkHmacKey: () => true }));
vi.mock("../../lib/messaging/messaging-config", () => ({
  readSmsConfigOrNull: configured,
  readEmailConfigOrNull: configured,
}));
vi.mock("../../lib/voice/voice-config", () => ({
  readVoiceConfigOrNull: configured,
}));
vi.mock("../../lib/email/apply-tenant-email-sender", () => ({
  applyTenantEmailSender: async () => ({
    publicBaseUrl: "https://example.test",
  }),
  isPatientEmailClickBaseReady: () => true,
}));
vi.mock("../../worker/jobs/reminders", () => ({
  SEND_SMS_JOB: "reminders.send-sms",
  SEND_EMAIL_JOB: "reminders.send-email",
  isWithinQuietHours: quiet,
}));
vi.mock("../../worker/jobs/reminder-voice", () => ({
  SEND_VOICE_JOB: "reminders.place-call",
}));
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminWriteRateLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  adminRateLimit: () => (_q: unknown, _s: unknown, next: () => void) => next(),
}));
import router from "./resupply-outreach";
const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const app = () => express().use(express.json()).use(router);
beforeEach(() => {
  vi.clearAllMocks();
  admin.current = { userId: "csr", email: "csr@example.test", role: "agent" };
  send.mockResolvedValue("job");
  check.mockImplementation(async (_org, id) => ({
    reason: null,
    patientId: id,
    timezone: "America/New_York",
  }));
  configured.mockReturnValue({ twilioPhoneNumber: "+15555550100" });
  quiet.mockReturnValue(false);
});
describe("CSR individual and bulk outreach", () => {
  it.each([
    ["sms", "reminders.send-sms"],
    ["email", "reminders.send-email"],
    ["voice", "reminders.place-call"],
  ])("queues %s through the existing worker", async (channel, queue) => {
    const result = await request(app())
      .post("/admin/resupply-outreach")
      .send({ episodeIds: [E1, E2], channel });
    expect(result.status).toBe(200);
    expect(
      result.body.results.map((r: { status: string }) => r.status),
    ).toEqual(["queued", "queued"]);
    expect(send).toHaveBeenCalledWith(
      queue,
      expect.objectContaining({
        orgId: MOCK_ORG_ID,
        episodeId: E1,
        patientId: E1,
        csrRequested: true,
      }),
      expect.objectContaining({
        singletonKey: `csr-resupply:${MOCK_ORG_ID}:${E1}`,
      }),
    );
  });
  it("deduplicates episode IDs and patients", async () => {
    check.mockResolvedValue({
      reason: null,
      patientId: "same-patient",
      timezone: "America/New_York",
    });
    const result = await request(app())
      .post("/admin/resupply-outreach")
      .send({ episodeIds: [E1, E1, E2], channel: "sms" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.body.results).toHaveLength(2);
    expect(result.body.results[1].status).toBe("skipped");
  });
  it("reports a partial enqueue failure without losing earlier success", async () => {
    send
      .mockResolvedValueOnce("job")
      .mockRejectedValueOnce(new Error("offline"));
    const result = await request(app())
      .post("/admin/resupply-outreach")
      .send({ episodeIds: [E1, E2], channel: "voice" });
    expect(
      result.body.results.map((r: { status: string }) => r.status),
    ).toEqual(["queued", "error"]);
  });
  it("does not claim duplicate jobs or ineligible patients were queued", async () => {
    check.mockResolvedValueOnce({ reason: "Patient is not active." });
    send.mockResolvedValue(null);
    const result = await request(app())
      .post("/admin/resupply-outreach")
      .send({ episodeIds: [E1, E2], channel: "email" });
    expect(
      result.body.results.every(
        (r: { status: string }) => r.status === "skipped",
      ),
    ).toBe(true);
  });
  it("skips phone outreach outside local contact hours", async () => {
    quiet.mockReturnValue(true);
    const result = await request(app())
      .post("/admin/resupply-outreach")
      .send({ episodeIds: [E1], channel: "voice" });
    expect(result.body.results[0].status).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated, missing tenant, invalid, and unconfigured requests", async () => {
    admin.current = null;
    expect(
      (
        await request(app())
          .post("/admin/resupply-outreach")
          .send({ episodeIds: [E1], channel: "sms" })
      ).status,
    ).toBe(401);
    admin.current = {
      userId: "csr",
      email: "csr@example.test",
      role: "agent",
      orgId: null,
    };
    expect(
      (
        await request(app())
          .post("/admin/resupply-outreach")
          .send({ episodeIds: [E1], channel: "sms" })
      ).status,
    ).toBe(500);
    admin.current.orgId = MOCK_ORG_ID;
    expect(
      (
        await request(app())
          .post("/admin/resupply-outreach")
          .send({ episodeIds: Array(51).fill(E1), channel: "sms" })
      ).status,
    ).toBe(400);
    configured.mockReturnValue(null);
    expect(
      (
        await request(app())
          .post("/admin/resupply-outreach")
          .send({ episodeIds: [E1], channel: "sms" })
      ).status,
    ).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });
});
