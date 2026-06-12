// Tests for the dead-letter-queue monitor (whole-app review
// 2026-06-12, B1): the worker has routed exhausted jobs to per-queue
// DLQs since queue-options.ts landed, but nothing watched them — a
// permanently failed reminder/autopay/claim job was silent until the
// business effect surfaced. The monitor must report only non-empty
// DLQs and stay fail-soft in unconfigured environments.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn();
vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: () => ({ sendEmail }),
  EmailConfigError: class EmailConfigError extends Error {},
}));

import {
  collectDlqDepths,
  renderDlqDigest,
  runDlqMonitor,
} from "./dlq-monitor";

type StubQueues = Record<string, number>;

/** Build the minimal pg-boss surface the monitor consumes. */
function stubBoss(queues: StubQueues) {
  return {
    getQueues: async () =>
      Object.keys(queues).map((name) => ({ name }) as never),
    getQueueSize: async (name: string) => queues[name] ?? 0,
  };
}

describe("collectDlqDepths", () => {
  it("returns only non-empty *.dlq queues, deepest first", async () => {
    const depths = await collectDlqDepths(
      stubBoss({
        "reminders.scan": 3,
        "reminders.scan.dlq": 2,
        "shop.autopay.dlq": 7,
        "metrics.snapshot.dlq": 0,
      }),
    );
    expect(depths).toEqual([
      { queue: "shop.autopay.dlq", count: 7 },
      { queue: "reminders.scan.dlq", count: 2 },
    ]);
  });

  it("ignores main queues even when they have backlog", async () => {
    const depths = await collectDlqDepths(stubBoss({ "reminders.scan": 50 }));
    expect(depths).toEqual([]);
  });
});

describe("renderDlqDigest", () => {
  it("pluralizes and totals the subject", () => {
    const one = renderDlqDigest([{ queue: "a.dlq", count: 1 }]);
    expect(one.subject).toContain("1 dead-lettered job ");
    const many = renderDlqDigest([
      { queue: "a.dlq", count: 2 },
      { queue: "b.dlq", count: 3 },
    ]);
    expect(many.subject).toContain("5 dead-lettered jobs");
  });

  it("lists each queue with its count and points at the runbook", () => {
    const { text, html } = renderDlqDigest([
      { queue: "reminders.scan.dlq", count: 4 },
    ]);
    expect(text).toContain("reminders.scan.dlq: 4");
    expect(text).toContain("docs/runbooks/worker-recovery.md");
    expect(html).toContain("reminders.scan.dlq");
  });

  it("escapes HTML in queue names", () => {
    const { html } = renderDlqDigest([{ queue: "<weird>.dlq", count: 1 }]);
    expect(html).toContain("&lt;weird&gt;.dlq");
  });
});

describe("runDlqMonitor", () => {
  const origEnv = process.env.RESUPPLY_ADMIN_EMAILS;

  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.RESUPPLY_ADMIN_EMAILS;
    else process.env.RESUPPLY_ADMIN_EMAILS = origEnv;
  });

  it("does nothing when every DLQ is empty", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "ops@penn.com";
    const stats = await runDlqMonitor(
      stubBoss({ "a.dlq": 0, "b.dlq": 0, main: 10 }),
    );
    expect(stats).toMatchObject({
      dlqQueues: 2,
      nonEmpty: 0,
      totalDead: 0,
      emailSent: false,
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("emails each recipient one digest when DLQs are non-empty", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "ops@penn.com, owner@penn.com";
    const stats = await runDlqMonitor(stubBoss({ "a.dlq": 2, "b.dlq": 1 }));
    expect(stats).toMatchObject({
      nonEmpty: 2,
      totalDead: 3,
      recipients: 2,
      emailSent: true,
    });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const firstCall = sendEmail.mock.calls[0]![0] as { subject: string };
    expect(firstCall.subject).toContain("3 dead-lettered jobs");
  });

  it("is fail-soft when no recipients are configured", async () => {
    delete process.env.RESUPPLY_ADMIN_EMAILS;
    const stats = await runDlqMonitor(stubBoss({ "a.dlq": 5 }));
    expect(stats).toMatchObject({
      nonEmpty: 1,
      totalDead: 5,
      recipients: 0,
      emailSent: false,
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("reports emailSent=false when every send fails (next run re-notifies)", async () => {
    process.env.RESUPPLY_ADMIN_EMAILS = "ops@penn.com";
    sendEmail.mockRejectedValue(new Error("sendgrid 500"));
    const stats = await runDlqMonitor(stubBoss({ "a.dlq": 1 }));
    expect(stats.emailSent).toBe(false);
  });
});
