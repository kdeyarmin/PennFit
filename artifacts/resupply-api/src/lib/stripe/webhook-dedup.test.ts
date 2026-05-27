// Tests for the Stripe webhook event-id dedup helper.
//
// Coverage:
//   * First-seen events return "inserted"
//   * Duplicate events (UNIQUE-violation 23505) return "duplicate"
//   * Other DB errors return "error" and do NOT throw
//   * Unexpected exceptions from the supabase client return "error"
//     and do NOT throw

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  tryDeleteWebhookEventRecord,
  tryRecordWebhookEvent,
} from "./webhook-handler";

beforeEach(() => {
  supabaseMock.reset();
  vi.useRealTimers();
});

describe("tryRecordWebhookEvent — first-seen", () => {
  it("returns 'inserted' when the INSERT succeeds", async () => {
    stageSupabaseResponse("stripe_webhook_events", "insert", { data: null });
    const outcome = await tryRecordWebhookEvent(
      "evt_first",
      "checkout.session.completed",
      undefined,
    );
    expect(outcome).toBe("inserted");
  });
});

describe("tryRecordWebhookEvent — duplicate", () => {
  it("returns 'duplicate' on 23505 UNIQUE-violation", async () => {
    stageSupabaseResponse("stripe_webhook_events", "insert", {
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "stripe_webhook_events_pkey"',
      },
    });
    const outcome = await tryRecordWebhookEvent(
      "evt_dup",
      "checkout.session.completed",
      undefined,
    );
    expect(outcome).toBe("duplicate");
  });
});

describe("tryRecordWebhookEvent — non-fatal failures", () => {
  it("returns 'error' when the DB rejects for a non-UNIQUE reason", async () => {
    const warns: unknown[] = [];
    const log = { warn: (...args: unknown[]) => warns.push(args) };
    stageSupabaseResponse("stripe_webhook_events", "insert", {
      data: null,
      error: { code: "42501", message: "permission denied" },
    });
    const outcome = await tryRecordWebhookEvent(
      "evt_other_error",
      "checkout.session.completed",
      log,
    );
    expect(outcome).toBe("error");
    // The non-fatal path emits a structured warn so ops can see the
    // dedup gate is offline. We don't pin the exact payload — just
    // confirm the line fired.
    expect(warns.length).toBe(1);
  });
});

describe("tryRecordWebhookEvent — never throws", () => {
  it("returns 'error' (does not propagate) when the supabase client itself throws", async () => {
    // Stage a real throw from the Supabase mock so this test
    // exercises the helper's catch path directly.
    stageSupabaseResponse("stripe_webhook_events", "insert", {
      throws: new Error("connection refused"),
    });
    const outcome = await tryRecordWebhookEvent(
      "evt_thrown",
      "checkout.session.completed",
      undefined,
    );
    expect(outcome).toBe("error");
  });
});

describe("tryDeleteWebhookEventRecord — never throws", () => {
  it("swallows delete exceptions and resolves", async () => {
    stageSupabaseResponse("stripe_webhook_events", "delete", {
      throws: new Error("delete failed"),
    });
    await expect(
      tryDeleteWebhookEventRecord("evt_cleanup_throw", undefined),
    ).resolves.toBeUndefined();
  });
});
