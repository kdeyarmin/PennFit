// Tests for the smart-trigger send-due cron wrapper.
//
// Same shape as rx-renewal-send: email-first then SMS, AggregateError
// on multi-channel failure, not_configured tolerance.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { runSmartTriggerSendDueMock, listActiveOrgIdsMock } = vi.hoisted(() => ({
  runSmartTriggerSendDueMock: vi.fn(),
  listActiveOrgIdsMock: vi.fn(),
}));
vi.mock("../../lib/smart-triggers/dispatcher", () => ({
  runSmartTriggerSendDue: runSmartTriggerSendDueMock,
}));
// The cron now fans out across active tenants via forEachActiveOrg, which
// calls listActiveOrgIds. Pin it to a single tenant so these orchestration
// tests still assert the per-tenant channel sequencing.
vi.mock("@workspace/resupply-db", () => ({
  listActiveOrgIds: listActiveOrgIdsMock,
}));

vi.mock("../../lib/smart-triggers/renderers", () => ({
  subjectForKind: vi.fn(() => "Subject"),
  textBody: vi.fn(() => "text"),
  htmlBody: vi.fn(() => "<p>html</p>"),
  smsBody: vi.fn(() => "sms"),
  pushBody: vi.fn(() => ({ title: "x", body: "y" })),
}));

vi.mock("../lib/queue-options", () => ({
  createQueueWithDlq: vi.fn(async () => undefined),
  VENDOR_SEND_QUEUE_OPTS: {},
}));

interface FakeBoss {
  work: (job: string, h: () => Promise<void>) => Promise<void>;
  schedule: (job: string, cron: string) => Promise<void>;
}
function makeFakeBoss(): { boss: FakeBoss; run: () => Promise<void> } {
  let handler: () => Promise<void> = async () => {};
  const boss: FakeBoss = {
    work: async (_j, h) => {
      handler = h;
    },
    schedule: async () => undefined,
  };
  return { boss, run: () => handler() };
}

import { registerSmartTriggerSendJob } from "./smart-trigger-send";

beforeEach(() => {
  runSmartTriggerSendDueMock.mockReset();
  listActiveOrgIdsMock.mockReset();
  listActiveOrgIdsMock.mockResolvedValue(["org-1"]);
});

describe("smart-triggers.send-due cron handler", () => {
  it("calls email channel first, then SMS, on clean runs", async () => {
    runSmartTriggerSendDueMock.mockResolvedValue({
      status: "ok",
      considered: 1,
      sent: 1,
      failed: 0,
    });
    const fake = makeFakeBoss();
    await registerSmartTriggerSendJob(fake.boss as never);
    await fake.run();
    expect(runSmartTriggerSendDueMock).toHaveBeenCalledTimes(2);
    expect(runSmartTriggerSendDueMock.mock.calls[0]?.[0]).toBe("email");
    expect(runSmartTriggerSendDueMock.mock.calls[1]?.[0]).toBe("sms");
  });

  it("tolerates not_configured on either channel without throwing", async () => {
    runSmartTriggerSendDueMock
      .mockResolvedValueOnce({ status: "not_configured" })
      .mockResolvedValueOnce({ status: "not_configured" });
    const fake = makeFakeBoss();
    await registerSmartTriggerSendJob(fake.boss as never);
    await expect(fake.run()).resolves.toBeUndefined();
  });

  it("runs SMS even when email throws, isolating the tenant failure", async () => {
    runSmartTriggerSendDueMock
      .mockRejectedValueOnce(new Error("sg 500"))
      .mockResolvedValueOnce({
        status: "ok",
        considered: 1,
        sent: 1,
        failed: 0,
      });
    const fake = makeFakeBoss();
    await registerSmartTriggerSendJob(fake.boss as never);
    // forEachActiveOrg isolates the per-tenant failure (logs + tallies,
    // never rejects); the SMS channel must still have been attempted.
    await expect(fake.run()).resolves.toBeUndefined();
    expect(runSmartTriggerSendDueMock).toHaveBeenCalledTimes(2);
  });

  it("isolates a tenant whose channels both throw without rejecting", async () => {
    runSmartTriggerSendDueMock
      .mockRejectedValueOnce(new Error("sg"))
      .mockRejectedValueOnce(new Error("twilio"));
    const fake = makeFakeBoss();
    await registerSmartTriggerSendJob(fake.boss as never);
    // Per-tenant error isolation keeps the sweep (and scheduler tick) alive.
    await expect(fake.run()).resolves.toBeUndefined();
  });

  it("passes an explicit orgId to each channel", async () => {
    runSmartTriggerSendDueMock.mockResolvedValue({
      status: "ok",
      considered: 0,
      sent: 0,
      failed: 0,
    });
    const fake = makeFakeBoss();
    await registerSmartTriggerSendJob(fake.boss as never);
    await fake.run();
    // Cron path always passes the tenant org as the 4th arg.
    expect(runSmartTriggerSendDueMock.mock.calls[0]?.[3]).toBe("org-1");
    expect(runSmartTriggerSendDueMock.mock.calls[1]?.[3]).toBe("org-1");
  });

  it("passes the system-cron actor identity to the dispatcher", async () => {
    runSmartTriggerSendDueMock.mockResolvedValue({
      status: "ok",
      considered: 0,
      sent: 0,
      failed: 0,
    });
    const fake = makeFakeBoss();
    await registerSmartTriggerSendJob(fake.boss as never);
    await fake.run();
    const actorArg = runSmartTriggerSendDueMock.mock.calls[0]?.[1] as {
      adminEmail: string;
    };
    expect(actorArg.adminEmail).toBe("system:cron:smart-trigger-send");
  });
});
