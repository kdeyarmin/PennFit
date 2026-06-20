// Tests for the Rx-renewal cron registration wrapper.
//
// The cron handler is a thin orchestrator that calls
// runRxRenewalSendDue("email") then runRxRenewalSendDue("sms"). The
// underlying dispatcher is tested separately. Here we focus on the
// orchestration contract:
//
//   * Both channels run regardless of which one throws
//   * Errors aggregate into an AggregateError so pg-boss marks failure
//   * "not_configured" on either channel logs + skips, doesn't throw
//   * On all-clean run, the handler resolves cleanly

import { describe, it, expect, vi, beforeEach } from "vitest";

const { runRxRenewalSendDueMock, listActiveOrgIdsMock } = vi.hoisted(() => ({
  runRxRenewalSendDueMock: vi.fn(),
  listActiveOrgIdsMock: vi.fn(),
}));
vi.mock("../../lib/rx-renewal/dispatcher", () => ({
  runRxRenewalSendDue: runRxRenewalSendDueMock,
}));
// The cron now fans out across active tenants via forEachActiveOrg, which
// calls listActiveOrgIds. Pin it to a single tenant so these orchestration
// tests still assert the per-tenant channel sequencing.
vi.mock("@workspace/resupply-db", () => ({
  listActiveOrgIds: listActiveOrgIdsMock,
}));

interface FakeBoss {
  work: (job: string, handler: () => Promise<void>) => Promise<void>;
  schedule: (job: string, cron: string) => Promise<void>;
}

function makeFakeBoss(): { boss: FakeBoss; handler: () => Promise<void> } {
  let handler: () => Promise<void> = async () => {};
  const boss: FakeBoss = {
    work: async (_job, h) => {
      handler = h;
    },
    schedule: async () => undefined,
  };
  return {
    boss,
    handler: () => handler(),
  };
}

vi.mock("../lib/queue-options", () => ({
  createQueueWithDlq: vi.fn(async () => undefined),
  VENDOR_SEND_QUEUE_OPTS: {},
}));

import { registerRxRenewalSendJob } from "./rx-renewal-send";

beforeEach(() => {
  runRxRenewalSendDueMock.mockReset();
  listActiveOrgIdsMock.mockReset();
  listActiveOrgIdsMock.mockResolvedValue(["org-1"]);
});

describe("rx-renewal.send-due cron handler", () => {
  it("calls both email and sms channels on a clean run", async () => {
    runRxRenewalSendDueMock.mockResolvedValue({
      status: "ok",
      considered: 1,
      sent: 1,
      failed: 0,
    });
    const fake = makeFakeBoss();
    await registerRxRenewalSendJob(fake.boss as never);
    await fake.handler();
    expect(runRxRenewalSendDueMock).toHaveBeenCalledTimes(2);
    expect(runRxRenewalSendDueMock.mock.calls[0]?.[0]).toBe("email");
    expect(runRxRenewalSendDueMock.mock.calls[1]?.[0]).toBe("sms");
  });

  it("tolerates 'not_configured' on either channel without throwing", async () => {
    runRxRenewalSendDueMock
      .mockResolvedValueOnce({ status: "not_configured" })
      .mockResolvedValueOnce({ status: "not_configured" });
    const fake = makeFakeBoss();
    await registerRxRenewalSendJob(fake.boss as never);
    await expect(fake.handler()).resolves.toBeUndefined();
  });

  it("passes an explicit orgId to each channel", async () => {
    runRxRenewalSendDueMock.mockResolvedValue({
      status: "ok",
      considered: 1,
      sent: 1,
      failed: 0,
    });
    const fake = makeFakeBoss();
    await registerRxRenewalSendJob(fake.boss as never);
    await fake.handler();
    // Cron path always passes the tenant org as the 3rd arg (never the
    // seed-org default).
    expect(runRxRenewalSendDueMock.mock.calls[0]?.[2]).toBe("org-1");
    expect(runRxRenewalSendDueMock.mock.calls[1]?.[2]).toBe("org-1");
  });

  it("runs the SMS channel even when email throws", async () => {
    runRxRenewalSendDueMock
      .mockRejectedValueOnce(new Error("sendgrid 500"))
      .mockResolvedValueOnce({
        status: "ok",
        considered: 1,
        sent: 1,
        failed: 0,
      });
    const fake = makeFakeBoss();
    await registerRxRenewalSendJob(fake.boss as never);
    // forEachActiveOrg isolates the per-tenant failure (it logs + tallies
    // and never rejects), but the SMS channel must still have been called.
    await expect(fake.handler()).resolves.toBeUndefined();
    expect(runRxRenewalSendDueMock).toHaveBeenCalledTimes(2);
    expect(runRxRenewalSendDueMock.mock.calls[1]?.[0]).toBe("sms");
  });

  it("isolates a tenant whose channels both throw without rejecting", async () => {
    runRxRenewalSendDueMock
      .mockRejectedValueOnce(new Error("sg down"))
      .mockRejectedValueOnce(new Error("twilio down"));
    const fake = makeFakeBoss();
    await registerRxRenewalSendJob(fake.boss as never);
    // Per-tenant error isolation: the bad tenant is logged + tallied, the
    // sweep resolves so other tenants (and the scheduler tick) aren't aborted.
    await expect(fake.handler()).resolves.toBeUndefined();
  });
});
