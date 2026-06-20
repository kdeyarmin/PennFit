// Tests for the cart-abandonment hourly cron registration (A1).
//
// The dispatcher logic itself is covered by the existing
// `routes/admin/abandoned-carts.test.ts` which exercises the same
// helper through the admin POST route. This file pins the worker-
// specific contract:
//
//   * Feature flag — registration is a no-op unless
//     RESUPPLY_CART_ABANDONMENT_CRON_ENABLED=1. Mirrors the posture
//     of fitter-lead.first-day-nudge so a staging deploy with real
//     SendGrid keys doesn't start nudging real abandoned carts.
//   * When enabled, registration calls boss.createQueue / .work /
//     .schedule on the canonical queue name + cron expression.
//   * The handler fans out across active tenants (one dispatch per
//     active org), aggregates the per-tenant stats, isolates a single
//     tenant's failure, and only rethrows if tenant enumeration itself
//     fails (the pg-boss retry signal).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runDispatchMock = vi.hoisted(() =>
  vi.fn(async () => ({
    scanned: 0,
    sent: 0,
    skippedNoConfig: 0,
    skippedFailed: 0,
    skippedOptOut: 0,
    sendgridConfigured: true,
  })),
);
vi.mock("../../lib/cart-abandonment/run-dispatch", () => ({
  runCartAbandonmentDispatch: runDispatchMock,
}));

// The handler fans out across active tenants (forEachActiveOrg →
// listActiveOrgIds) before dispatching per tenant; stub the tenant
// enumeration so the cron contract tests don't hit a real DB.
const listActiveOrgIdsMock = vi.hoisted(() =>
  vi.fn(async () => ["org-1"] as string[]),
);
vi.mock("@workspace/resupply-db", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/resupply-db")>();
  return { ...actual, listActiveOrgIds: listActiveOrgIdsMock };
});

// Capture log calls so we can assert info/error were called with the
// stats payload.
const logCalls = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({
  logger: logCalls,
}));

import {
  registerCartAbandonmentJob,
  CART_ABANDONMENT_JOB,
  CART_ABANDONMENT_CRON,
} from "./cart-abandonment-scan";

interface BossSpy {
  createQueue: ReturnType<typeof vi.fn>;
  work: ReturnType<typeof vi.fn>;
  schedule: ReturnType<typeof vi.fn>;
}

function makeBoss(): BossSpy {
  return {
    createQueue: vi.fn(async () => undefined),
    work: vi.fn(async () => undefined),
    schedule: vi.fn(async () => undefined),
  };
}

const ORIGINAL_FLAG = process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED;

beforeEach(() => {
  runDispatchMock.mockClear();
  runDispatchMock.mockResolvedValue({
    scanned: 0,
    sent: 0,
    skippedNoConfig: 0,
    skippedFailed: 0,
    skippedOptOut: 0,
    sendgridConfigured: true,
  });
  listActiveOrgIdsMock.mockClear();
  listActiveOrgIdsMock.mockResolvedValue(["org-1"]);
  logCalls.info.mockClear();
  logCalls.error.mockClear();
  logCalls.warn.mockClear();
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED;
  } else {
    process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED = ORIGINAL_FLAG;
  }
});

describe("cart-abandonment.scan — feature-flag gating", () => {
  it("does NOT create/work/schedule the queue when the flag is unset", async () => {
    delete process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED;
    const boss = makeBoss();
    await registerCartAbandonmentJob(boss as never);
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
    // Logs the "disabled" event so the operator can see why nothing
    // runs in their environment.
    expect(logCalls.info).toHaveBeenCalledWith(
      { event: "cart-abandonment.scan.disabled" },
      expect.stringContaining("not registered"),
    );
  });

  it("does NOT create/work/schedule the queue when the flag is '0'", async () => {
    process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED = "0";
    const boss = makeBoss();
    await registerCartAbandonmentJob(boss as never);
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it("registers + schedules the queue when the flag is '1'", async () => {
    process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED = "1";
    const boss = makeBoss();
    await registerCartAbandonmentJob(boss as never);
    // createQueue now takes a second arg (the buildQueueConfig output
    // with retry/backoff/DLQ presets). Assert the queue name is the
    // first arg without pinning the exact config object.
    expect(boss.createQueue).toHaveBeenCalledWith(
      CART_ABANDONMENT_JOB,
      expect.objectContaining({ name: CART_ABANDONMENT_JOB }),
    );
    expect(boss.work).toHaveBeenCalledWith(
      CART_ABANDONMENT_JOB,
      expect.any(Function),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      CART_ABANDONMENT_JOB,
      CART_ABANDONMENT_CRON,
    );
  });
});

describe("cart-abandonment.scan — handler behaviour", () => {
  it("dispatches once for the single active tenant and logs the aggregate envelope", async () => {
    process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED = "1";
    const boss = makeBoss();
    runDispatchMock.mockResolvedValueOnce({
      scanned: 5,
      sent: 3,
      skippedNoConfig: 0,
      skippedFailed: 1,
      skippedOptOut: 1,
      sendgridConfigured: true,
    });
    await registerCartAbandonmentJob(boss as never);

    // Pull the handler that was registered with boss.work and invoke
    // it ourselves — pg-boss isn't running, but the handler is the
    // same function we'd want to assert on.
    const workCall = boss.work.mock.calls[0];
    expect(workCall).toBeDefined();
    const handler = workCall[1] as () => Promise<void>;
    await handler();

    expect(runDispatchMock).toHaveBeenCalledTimes(1);
    expect(runDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
    );
    expect(logCalls.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cart-abandonment.scan.completed",
        tenants: 1,
        succeeded: 1,
        failedOrgIds: [],
        scanned: 5,
        sent: 3,
        skippedFailed: 1,
        skippedOptOut: 1,
      }),
      expect.stringContaining("completed"),
    );
    expect(logCalls.error).not.toHaveBeenCalled();
  });

  it("fans out once per active tenant and sums their stats", async () => {
    process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED = "1";
    listActiveOrgIdsMock.mockResolvedValueOnce(["org-1", "org-2"]);
    const boss = makeBoss();
    runDispatchMock
      .mockResolvedValueOnce({
        scanned: 4,
        sent: 2,
        skippedNoConfig: 0,
        skippedFailed: 1,
        skippedOptOut: 1,
        sendgridConfigured: true,
      })
      .mockResolvedValueOnce({
        scanned: 3,
        sent: 3,
        skippedNoConfig: 0,
        skippedFailed: 0,
        skippedOptOut: 0,
        sendgridConfigured: true,
      });
    await registerCartAbandonmentJob(boss as never);

    const handler = boss.work.mock.calls[0][1] as () => Promise<void>;
    await handler();

    expect(runDispatchMock).toHaveBeenCalledTimes(2);
    expect(runDispatchMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ orgId: "org-1" }),
    );
    expect(runDispatchMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ orgId: "org-2" }),
    );
    expect(logCalls.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cart-abandonment.scan.completed",
        tenants: 2,
        succeeded: 2,
        failedOrgIds: [],
        scanned: 7,
        sent: 5,
        skippedFailed: 1,
        skippedOptOut: 1,
      }),
      expect.stringContaining("completed"),
    );
    expect(logCalls.error).not.toHaveBeenCalled();
  });

  it("isolates a single tenant's dispatch failure (continues + tallies, does NOT rethrow)", async () => {
    process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED = "1";
    listActiveOrgIdsMock.mockResolvedValueOnce(["org-1", "org-2"]);
    const boss = makeBoss();
    runDispatchMock
      .mockRejectedValueOnce(new Error("org-1 DB down"))
      .mockResolvedValueOnce({
        scanned: 2,
        sent: 2,
        skippedNoConfig: 0,
        skippedFailed: 0,
        skippedOptOut: 0,
        sendgridConfigured: true,
      });
    await registerCartAbandonmentJob(boss as never);

    const handler = boss.work.mock.calls[0][1] as () => Promise<void>;
    // The healthy tenant still ran; the bad one was isolated.
    await expect(handler()).resolves.toBeUndefined();

    expect(runDispatchMock).toHaveBeenCalledTimes(2);
    // forEachActiveOrg logs the per-tenant failure.
    expect(logCalls.error).toHaveBeenCalled();
    expect(logCalls.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cart-abandonment.scan.completed",
        tenants: 2,
        succeeded: 1,
        failedOrgIds: ["org-1"],
        // Only the healthy tenant's stats land in the aggregate.
        scanned: 2,
        sent: 2,
      }),
      expect.stringContaining("completed"),
    );
  });

  it("rethrows after logging when tenant enumeration fails (pg-boss retry signal)", async () => {
    process.env.RESUPPLY_CART_ABANDONMENT_CRON_ENABLED = "1";
    listActiveOrgIdsMock.mockRejectedValueOnce(new Error("orgs query down"));
    const boss = makeBoss();
    await registerCartAbandonmentJob(boss as never);

    const handler = boss.work.mock.calls[0][1] as () => Promise<void>;
    await expect(handler()).rejects.toThrow("orgs query down");
    expect(logCalls.error).toHaveBeenCalled();
    // No tenant was dispatched — enumeration failed first.
    expect(runDispatchMock).not.toHaveBeenCalled();
  });
});

describe("cart-abandonment.scan — cron schedule", () => {
  it("uses an hourly slot offset from the other resupply crons", () => {
    // We don't pin the exact minute — just verify it's a real
    // hourly cron string and not at :00 (which is the cron-thundering-
    // herd minute) and not at :07/:19 (which are already taken by
    // reminders.scan / fitter-lead.first-day-nudge).
    expect(CART_ABANDONMENT_CRON).toMatch(/^\d+ \* \* \* \*$/);
    const minute = Number(CART_ABANDONMENT_CRON.split(" ")[0]);
    expect(minute).not.toBe(0);
    expect(minute).not.toBe(7);
    expect(minute).not.toBe(19);
  });
});
