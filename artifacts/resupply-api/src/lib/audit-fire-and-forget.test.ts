// Tests for fireAndForgetAudit.
//
// The bug this guards against (caught in review on #1260): a bare
// `void deps.audit(event)` silences `no-floating-promises` but does NOT attach
// a rejection handler. `AuditWriter` is declared `(event) => Promise<void> |
// void`, and index.ts exits the process on `unhandledRejection` — so an async
// audit adapter that rejects after an otherwise-successful tenant signup or
// account closure would restart the API for every user.
//
// The `emits no unhandledRejection` assertions are the load-bearing ones: the
// old shape failed by KILLING THE PROCESS, not by returning a bad value, so a
// test that only checked the return would have passed against the broken code.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { fireAndForgetAudit } from "./audit-fire-and-forget";

const EVENT = { action: "test.event" } as Parameters<
  typeof fireAndForgetAudit
>[1];

let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

/** Give Node a chance to report an unhandled rejection before asserting. */
async function settle() {
  await new Promise((r) => setTimeout(r, 20));
}

describe("fireAndForgetAudit", () => {
  it("forwards the event to the writer", async () => {
    const audit = vi.fn(() => undefined);
    fireAndForgetAudit(audit, EVENT);
    await settle();
    expect(audit).toHaveBeenCalledWith(EVENT);
    expect(unhandled).toEqual([]);
  });

  it("returns synchronously (safe to call right before responding)", () => {
    const audit = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // No await here: the helper must not block the caller.
    expect(fireAndForgetAudit(audit, EVENT)).toBeUndefined();
    expect(audit).toHaveBeenCalled();
  });

  it("swallows an ASYNC rejection and emits no unhandledRejection", async () => {
    // THE REGRESSION. `void audit(event)` would leak this to the process trap.
    const log = { warn: vi.fn() };
    const audit = vi.fn(() => Promise.reject(new Error("audit db down")));

    fireAndForgetAudit(audit, EVENT, log);
    await settle();

    expect(unhandled).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields] = log.warn.mock.calls[0] as [{ event: string; err: Error }];
    expect(fields.event).toBe("audit_write_failed");
    expect(fields.err).toBeInstanceOf(Error);
  });

  it("swallows a SYNCHRONOUS throw (which never produces a promise to .catch)", async () => {
    const log = { warn: vi.fn() };
    const audit = vi.fn(() => {
      throw new Error("writer blew up before returning");
    });

    expect(() => fireAndForgetAudit(audit, EVENT, log)).not.toThrow();
    await settle();

    expect(unhandled).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the module logger when no request logger is passed", async () => {
    const audit = vi.fn(() => Promise.reject(new Error("nope")));
    // No `log` argument — must still not leak the rejection.
    fireAndForgetAudit(audit, EVENT);
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("rejects a non-Error reason without leaking it", async () => {
    const log = { warn: vi.fn() };
    const audit = vi.fn(() => Promise.reject("just a string"));
    fireAndForgetAudit(audit, EVENT, log);
    await settle();
    expect(unhandled).toEqual([]);
    const [fields] = log.warn.mock.calls[0] as [{ err: Error }];
    expect(fields.err).toBeInstanceOf(Error);
    expect(fields.err.message).toContain("just a string");
  });
});
