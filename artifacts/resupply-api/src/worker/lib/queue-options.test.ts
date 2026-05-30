import { describe, expect, it, vi } from "vitest";

import {
  buildQueueConfig,
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
  VENDOR_SEND_QUEUE_OPTS,
  WEBHOOK_DISPATCH_QUEUE_OPTS,
} from "./queue-options";

// ──────────────────────────────────────────────────────────────────────────────
// buildQueueConfig
// ──────────────────────────────────────────────────────────────────────────────

describe("buildQueueConfig", () => {
  it("sets name to the provided queue name", () => {
    const cfg = buildQueueConfig("my.queue", VENDOR_SEND_QUEUE_OPTS);
    expect(cfg.name).toBe("my.queue");
  });

  it("always sets deadLetter to '<name>.dlq'", () => {
    const cfg = buildQueueConfig("my.queue", VENDOR_SEND_QUEUE_OPTS);
    expect(cfg.deadLetter).toBe("my.queue.dlq");
  });

  it("spreads all preset fields onto the returned config", () => {
    const cfg = buildQueueConfig("test.queue", VENDOR_SEND_QUEUE_OPTS);
    expect(cfg.retryLimit).toBe(VENDOR_SEND_QUEUE_OPTS.retryLimit);
    expect(cfg.retryBackoff).toBe(VENDOR_SEND_QUEUE_OPTS.retryBackoff);
    expect(cfg.retryDelay).toBe(VENDOR_SEND_QUEUE_OPTS.retryDelay);
    expect(cfg.expireInMinutes).toBe(VENDOR_SEND_QUEUE_OPTS.expireInMinutes);
  });

  it("applies overrides on top of the preset", () => {
    const cfg = buildQueueConfig("test.queue", VENDOR_SEND_QUEUE_OPTS, {
      retryLimit: 99,
      retryBackoff: false,
    });
    expect(cfg.retryLimit).toBe(99);
    expect(cfg.retryBackoff).toBe(false);
    // Other preset fields are still present
    expect(cfg.retryDelay).toBe(VENDOR_SEND_QUEUE_OPTS.retryDelay);
  });

  it("deadLetter is always the DLQ name even when overrides provide a different value", () => {
    // The implementation always sets deadLetter AFTER spreading overrides,
    // so an override attempting to change the DLQ name is silently ignored.
    const cfg = buildQueueConfig("foo.job", CRON_SCAN_QUEUE_OPTS, {
      deadLetter: "other.dlq",
    } as never);
    expect(cfg.deadLetter).toBe("foo.job.dlq");
  });

  it("works with CRON_SCAN_QUEUE_OPTS preset", () => {
    const cfg = buildQueueConfig("reminders.scan", CRON_SCAN_QUEUE_OPTS);
    expect(cfg.name).toBe("reminders.scan");
    expect(cfg.deadLetter).toBe("reminders.scan.dlq");
    expect(cfg.retryLimit).toBe(CRON_SCAN_QUEUE_OPTS.retryLimit);
    expect(cfg.retryBackoff).toBe(CRON_SCAN_QUEUE_OPTS.retryBackoff);
    expect(cfg.retryDelay).toBe(CRON_SCAN_QUEUE_OPTS.retryDelay);
    expect(cfg.expireInMinutes).toBe(CRON_SCAN_QUEUE_OPTS.expireInMinutes);
  });

  it("works with WEBHOOK_DISPATCH_QUEUE_OPTS preset", () => {
    const cfg = buildQueueConfig(
      "webhooks.dispatch",
      WEBHOOK_DISPATCH_QUEUE_OPTS,
    );
    expect(cfg.name).toBe("webhooks.dispatch");
    expect(cfg.deadLetter).toBe("webhooks.dispatch.dlq");
    expect(cfg.retryLimit).toBe(WEBHOOK_DISPATCH_QUEUE_OPTS.retryLimit);
  });

  it("returns an object with exactly name + preset keys + deadLetter (no extra)", () => {
    const cfg = buildQueueConfig("q", VENDOR_SEND_QUEUE_OPTS);
    const expectedKeys = new Set([
      "name",
      "deadLetter",
      ...Object.keys(VENDOR_SEND_QUEUE_OPTS),
    ]);
    for (const k of Object.keys(cfg)) {
      expect(expectedKeys.has(k)).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Preset value contracts
// ──────────────────────────────────────────────────────────────────────────────

describe("VENDOR_SEND_QUEUE_OPTS", () => {
  it("has retryLimit 5 (handles brief vendor outages without exhausting on first blip)", () => {
    expect(VENDOR_SEND_QUEUE_OPTS.retryLimit).toBe(5);
  });

  it("uses exponential backoff", () => {
    expect(VENDOR_SEND_QUEUE_OPTS.retryBackoff).toBe(true);
  });

  it("starts backoff at 10 seconds (doubles each attempt: 10s, 20s, 40s, 80s, 160s)", () => {
    expect(VENDOR_SEND_QUEUE_OPTS.retryDelay).toBe(10);
  });

  it("expires in 15 minutes", () => {
    expect(VENDOR_SEND_QUEUE_OPTS.expireInMinutes).toBe(15);
  });

  it("does not include a name property (preset is name-less)", () => {
    expect("name" in VENDOR_SEND_QUEUE_OPTS).toBe(false);
  });

  it("does not include a deadLetter property (added by buildQueueConfig)", () => {
    expect("deadLetter" in VENDOR_SEND_QUEUE_OPTS).toBe(false);
  });
});

describe("CRON_SCAN_QUEUE_OPTS", () => {
  it("has retryLimit 1 (one retry for transient DB blip; next cron tick handles the rest)", () => {
    expect(CRON_SCAN_QUEUE_OPTS.retryLimit).toBe(1);
  });

  it("does not use exponential backoff", () => {
    expect(CRON_SCAN_QUEUE_OPTS.retryBackoff).toBe(false);
  });

  it("has a 5 second fixed retry delay", () => {
    expect(CRON_SCAN_QUEUE_OPTS.retryDelay).toBe(5);
  });

  it("expires in 5 minutes (short — scans are lightweight)", () => {
    expect(CRON_SCAN_QUEUE_OPTS.expireInMinutes).toBe(5);
  });

  it("has a lower retryLimit than VENDOR_SEND_QUEUE_OPTS", () => {
    expect(CRON_SCAN_QUEUE_OPTS.retryLimit).toBeLessThan(
      VENDOR_SEND_QUEUE_OPTS.retryLimit!,
    );
  });
});

describe("WEBHOOK_DISPATCH_QUEUE_OPTS", () => {
  it("has retryLimit 8 (generous — subscriber deploys cause brief 5xx windows)", () => {
    expect(WEBHOOK_DISPATCH_QUEUE_OPTS.retryLimit).toBe(8);
  });

  it("uses exponential backoff", () => {
    expect(WEBHOOK_DISPATCH_QUEUE_OPTS.retryBackoff).toBe(true);
  });

  it("starts backoff at 5 seconds", () => {
    expect(WEBHOOK_DISPATCH_QUEUE_OPTS.retryDelay).toBe(5);
  });

  it("has a tight 3 minute expiry (prevents wedged HTTP sockets holding a worker slot)", () => {
    expect(WEBHOOK_DISPATCH_QUEUE_OPTS.expireInMinutes).toBe(3);
  });

  it("has a higher retryLimit than VENDOR_SEND_QUEUE_OPTS", () => {
    expect(WEBHOOK_DISPATCH_QUEUE_OPTS.retryLimit).toBeGreaterThan(
      VENDOR_SEND_QUEUE_OPTS.retryLimit!,
    );
  });

  it("has a shorter expiry than VENDOR_SEND_QUEUE_OPTS", () => {
    expect(WEBHOOK_DISPATCH_QUEUE_OPTS.expireInMinutes).toBeLessThan(
      VENDOR_SEND_QUEUE_OPTS.expireInMinutes!,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildQueueConfig — override + deadLetter ordering invariant (regression)
// ──────────────────────────────────────────────────────────────────────────────
//
// The PR change that introduced these tests moved `deadLetter` AFTER
// `...overrides` in buildQueueConfig's return expression. This block adds
// further coverage to pin that contract against future re-ordering.

describe("buildQueueConfig — deadLetter ordering invariant (regression)", () => {
  it("override retryLimit wins, but deadLetter still resolves to <name>.dlq", () => {
    // An override of both retryLimit (tuneable knob) and deadLetter
    // (non-tuneable): the knob takes effect, the DLQ is still forced.
    const cfg = buildQueueConfig("my.queue", VENDOR_SEND_QUEUE_OPTS, {
      retryLimit: 1,
      deadLetter: "some.other.dlq",
    } as never);
    expect(cfg.retryLimit).toBe(1); // override applied
    expect(cfg.deadLetter).toBe("my.queue.dlq"); // DLQ name wins
  });

  it("override expireInMinutes wins, deadLetter is still forced", () => {
    const cfg = buildQueueConfig("expiry.test", CRON_SCAN_QUEUE_OPTS, {
      expireInMinutes: 60,
      deadLetter: "wrong.dlq",
    } as never);
    expect(cfg.expireInMinutes).toBe(60);
    expect(cfg.deadLetter).toBe("expiry.test.dlq");
  });

  it("empty overrides object: deadLetter is still set and preset fields survive", () => {
    const cfg = buildQueueConfig("empty.overrides", VENDOR_SEND_QUEUE_OPTS, {});
    expect(cfg.deadLetter).toBe("empty.overrides.dlq");
    expect(cfg.retryLimit).toBe(VENDOR_SEND_QUEUE_OPTS.retryLimit);
    expect(cfg.retryBackoff).toBe(VENDOR_SEND_QUEUE_OPTS.retryBackoff);
  });

  it("omitted overrides (undefined): deadLetter is still set", () => {
    // Callers that omit the third argument get the same DLQ contract.
    const cfg = buildQueueConfig("no.overrides", WEBHOOK_DISPATCH_QUEUE_OPTS);
    expect(cfg.deadLetter).toBe("no.overrides.dlq");
    expect(cfg.retryLimit).toBe(WEBHOOK_DISPATCH_QUEUE_OPTS.retryLimit);
  });

  it("queue name with dots produces the correct <name>.dlq", () => {
    // Verify the template literal `${name}.dlq` handles names that
    // already contain dots (common in the repo: 'reminders.scan', etc.).
    const cfg = buildQueueConfig("a.b.c.job", CRON_SCAN_QUEUE_OPTS);
    expect(cfg.deadLetter).toBe("a.b.c.job.dlq");
  });

  it("preset retryBackoff:false is NOT overwritten by the DLQ placement", () => {
    // Regression: the old code placed deadLetter BEFORE ...overrides.
    // Verifying the new order does not accidentally clobber boolean falsy
    // values from either preset or overrides.
    const cfg = buildQueueConfig("scan.job", CRON_SCAN_QUEUE_OPTS);
    expect(cfg.retryBackoff).toBe(false); // CRON preset: no backoff
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// createQueueWithDlq — DLQ-first ordering invariant (regression)
// ──────────────────────────────────────────────────────────────────────────────
//
// pg-boss v10 enforces a self-referential FK on queue.dead_letter: the DLQ
// row must exist BEFORE the main queue row references it. If a register
// function calls boss.createQueue(name, buildQueueConfig(...)) without
// pre-creating `${name}.dlq`, the FIRST boot of that queue crashes the API
// with "queue_dead_letter_fkey". The createQueueWithDlq helper enforces the
// correct ordering. These tests pin that contract so a future refactor of
// the helper (e.g. accidentally reordering the two awaits) can't silently
// resurrect the boot crash.

describe("createQueueWithDlq", () => {
  function makeBossSpy() {
    const calls: Array<{ name: string; opts?: object }> = [];
    const createQueue = vi.fn(async (name: string, opts?: object) => {
      calls.push({ name, opts });
    });
    // Cast through `never` so the helper accepts the spy without us pulling
    // in the full PgBoss type surface — we only exercise createQueue.
    return { boss: { createQueue } as never, calls, createQueue };
  }

  it("creates the DLQ before the main queue (strict ordering)", async () => {
    const { boss, calls } = makeBossSpy();
    await createQueueWithDlq(boss, "my.queue", VENDOR_SEND_QUEUE_OPTS);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.name).toBe("my.queue.dlq");
    expect(calls[1]?.name).toBe("my.queue");
  });

  it("DLQ is created with no options (idempotent bare-name upsert)", async () => {
    const { boss, calls } = makeBossSpy();
    await createQueueWithDlq(boss, "scan.job", CRON_SCAN_QUEUE_OPTS);
    expect(calls[0]).toEqual({ name: "scan.job.dlq", opts: undefined });
  });

  it("main queue is created with the buildQueueConfig output (preset + locked deadLetter)", async () => {
    const { boss, calls } = makeBossSpy();
    await createQueueWithDlq(boss, "vendor.send", VENDOR_SEND_QUEUE_OPTS);
    const mainCallOpts = calls[1]?.opts as Record<string, unknown>;
    expect(mainCallOpts.name).toBe("vendor.send");
    expect(mainCallOpts.deadLetter).toBe("vendor.send.dlq");
    expect(mainCallOpts.retryLimit).toBe(VENDOR_SEND_QUEUE_OPTS.retryLimit);
    expect(mainCallOpts.retryBackoff).toBe(VENDOR_SEND_QUEUE_OPTS.retryBackoff);
    expect(mainCallOpts.retryDelay).toBe(VENDOR_SEND_QUEUE_OPTS.retryDelay);
    expect(mainCallOpts.expireInMinutes).toBe(
      VENDOR_SEND_QUEUE_OPTS.expireInMinutes,
    );
  });

  it("applies overrides onto the main queue config", async () => {
    const { boss, calls } = makeBossSpy();
    await createQueueWithDlq(boss, "tuned.queue", VENDOR_SEND_QUEUE_OPTS, {
      retryLimit: 99,
    });
    const mainCallOpts = calls[1]?.opts as Record<string, unknown>;
    expect(mainCallOpts.retryLimit).toBe(99);
    // deadLetter is still locked even when overrides attempt to change it
    expect(mainCallOpts.deadLetter).toBe("tuned.queue.dlq");
  });

  it("override attempting to redirect deadLetter is ignored (same invariant as buildQueueConfig)", async () => {
    const { boss, calls } = makeBossSpy();
    await createQueueWithDlq(boss, "locked.dlq.queue", CRON_SCAN_QUEUE_OPTS, {
      deadLetter: "foreign.dlq",
    } as never);
    const mainCallOpts = calls[1]?.opts as Record<string, unknown>;
    expect(mainCallOpts.deadLetter).toBe("locked.dlq.queue.dlq");
  });

  it("if DLQ creation rejects, the main queue is NOT created (fail-closed)", async () => {
    const calls: string[] = [];
    const boss = {
      createQueue: vi.fn(async (name: string) => {
        calls.push(name);
        if (name.endsWith(".dlq")) throw new Error("simulated DLQ failure");
      }),
    } as never;
    await expect(
      createQueueWithDlq(boss, "fragile.queue", VENDOR_SEND_QUEUE_OPTS),
    ).rejects.toThrow("simulated DLQ failure");
    // Only the DLQ attempt happened — the main queue create must NOT run
    // when DLQ pre-create fails, otherwise we'd re-introduce the FK crash.
    expect(calls).toEqual(["fragile.queue.dlq"]);
  });

  it("queue names with dots produce a single-suffix DLQ name", async () => {
    const { boss, calls } = makeBossSpy();
    await createQueueWithDlq(boss, "a.b.c.queue", CRON_SCAN_QUEUE_OPTS);
    expect(calls[0]?.name).toBe("a.b.c.queue.dlq");
    expect((calls[1]?.opts as Record<string, unknown>).deadLetter).toBe(
      "a.b.c.queue.dlq",
    );
  });

  it("works with WEBHOOK_DISPATCH_QUEUE_OPTS preset", async () => {
    const { boss, calls } = makeBossSpy();
    await createQueueWithDlq(
      boss,
      "webhook.dispatch",
      WEBHOOK_DISPATCH_QUEUE_OPTS,
    );
    const mainCallOpts = calls[1]?.opts as Record<string, unknown>;
    expect(mainCallOpts.retryLimit).toBe(
      WEBHOOK_DISPATCH_QUEUE_OPTS.retryLimit,
    );
    expect(mainCallOpts.expireInMinutes).toBe(
      WEBHOOK_DISPATCH_QUEUE_OPTS.expireInMinutes,
    );
  });
});
