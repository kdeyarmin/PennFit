// Tests for the smart-trigger evaluator cron wrapper.
//
// Thin wrapper around runSmartTriggerEvaluator. We verify:
//   * The handler runs the evaluator with the system-actor identity
//   * Evaluator errors propagate (so pg-boss + SOC see the gap)

import { describe, it, expect, vi, beforeEach } from "vitest";

const { runSmartTriggerEvaluatorMock, listActiveOrgIdsMock } = vi.hoisted(
  () => ({
    runSmartTriggerEvaluatorMock: vi.fn(),
    listActiveOrgIdsMock: vi.fn(),
  }),
);
vi.mock("../../lib/smart-triggers/evaluator", () => ({
  runSmartTriggerEvaluator: runSmartTriggerEvaluatorMock,
}));
// The cron now fans out across active tenants via forEachActiveOrg, which
// calls listActiveOrgIds. Pin it to a single tenant for these tests.
vi.mock("@workspace/resupply-db", () => ({
  listActiveOrgIds: listActiveOrgIdsMock,
}));

vi.mock("../lib/queue-options", () => ({
  createQueueWithDlq: vi.fn(async () => undefined),
  CRON_SCAN_QUEUE_OPTS: {},
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

import { registerSmartTriggerEvaluatorJob } from "./smart-trigger-evaluator";

beforeEach(() => {
  runSmartTriggerEvaluatorMock.mockReset();
  listActiveOrgIdsMock.mockReset();
  listActiveOrgIdsMock.mockResolvedValue(["org-1"]);
});

describe("smart-triggers.evaluate cron handler", () => {
  it("invokes the evaluator with the system-cron actor identity + explicit org", async () => {
    runSmartTriggerEvaluatorMock.mockResolvedValueOnce({
      patientsScanned: 50,
      triggersFired: 3,
    });
    const fake = makeFakeBoss();
    await registerSmartTriggerEvaluatorJob(fake.boss as never);
    await fake.run();
    // Cron path passes the system actor AND the explicit tenant org (never
    // the seed-org default).
    expect(runSmartTriggerEvaluatorMock).toHaveBeenCalledWith(
      {
        adminEmail: "system:cron:smart-trigger-evaluator",
        adminUserId: null,
        ip: null,
        userAgent: null,
      },
      "org-1",
    );
  });

  it("isolates a tenant's failure without aborting the sweep", async () => {
    // forEachActiveOrg logs + tallies a per-tenant failure and never rejects,
    // so one tenant's broken scan can't crash the shared scheduler tick.
    runSmartTriggerEvaluatorMock.mockRejectedValueOnce(new Error("DB down"));
    const fake = makeFakeBoss();
    await registerSmartTriggerEvaluatorJob(fake.boss as never);
    await expect(fake.run()).resolves.toBeUndefined();
  });
});
