// Tests for the smart-trigger evaluator cron wrapper.
//
// Thin wrapper around runSmartTriggerEvaluator. We verify:
//   * The handler runs the evaluator with the system-actor identity
//   * Evaluator errors propagate (so pg-boss + SOC see the gap)

import { describe, it, expect, vi, beforeEach } from "vitest";

const { runSmartTriggerEvaluatorMock } = vi.hoisted(() => ({
  runSmartTriggerEvaluatorMock: vi.fn(),
}));
vi.mock("../../lib/smart-triggers/evaluator", () => ({
  runSmartTriggerEvaluator: runSmartTriggerEvaluatorMock,
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
});

describe("smart-triggers.evaluate cron handler", () => {
  it("invokes the evaluator with the system-cron actor identity", async () => {
    runSmartTriggerEvaluatorMock.mockResolvedValueOnce({
      patientsScanned: 50,
      triggersFired: 3,
    });
    const fake = makeFakeBoss();
    await registerSmartTriggerEvaluatorJob(fake.boss as never);
    await fake.run();
    expect(runSmartTriggerEvaluatorMock).toHaveBeenCalledWith({
      adminEmail: "system:cron:smart-trigger-evaluator",
      adminUserId: null,
      ip: null,
      userAgent: null,
    });
  });

  it("propagates errors so pg-boss marks the job failed", async () => {
    runSmartTriggerEvaluatorMock.mockRejectedValueOnce(new Error("DB down"));
    const fake = makeFakeBoss();
    await registerSmartTriggerEvaluatorJob(fake.boss as never);
    await expect(fake.run()).rejects.toThrow("DB down");
  });
});
