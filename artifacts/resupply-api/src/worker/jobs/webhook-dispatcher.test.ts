import { createHmac } from "node:crypto";

import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// ── safe-outbound — stub DNS resolution so tests run without network ─
// assertSafeOutboundHost does a real DNS lookup which fails in sandboxed
// CI environments. Return a stable public IP for example.com so the
// fetchWithPinnedIp URL-substitution path is still exercised.
vi.mock("../../lib/safe-outbound", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../lib/safe-outbound")>();
  return {
    ...real,
    assertSafeOutboundHost: vi.fn(async () => "93.184.216.34"),
  };
});

import { runWebhookDispatcher } from "./webhook-dispatcher";

function stageDispatchableDelivery(opts: {
  attemptCount?: number;
  maxRetries?: number;
  subActive?: boolean;
  targetUrl?: string;
  signingSecret?: string;
} = {}): void {
  const delivery = {
    id: "d-1",
    subscription_id: "s-1",
    event_type: "claim.paid",
    event_payload: { type: "claim.paid", data: { claim_id: "c-1" } },
    attempt_count: opts.attemptCount ?? 0,
  };
  // Two-step claim model: candidate SELECT returns just ids, then
  // an atomic UPDATE … RETURNING gives the full row. Stage both.
  stageSupabaseResponse("webhook_deliveries", "select", {
    data: [{ id: delivery.id }],
  });
  stageSupabaseResponse("webhook_deliveries", "update", {
    data: [delivery],
  });
  stageSupabaseResponse("webhook_subscriptions", "select", {
    data: [
      {
        id: "s-1",
        target_url: opts.targetUrl ?? "https://example.com/wh",
        signing_secret: opts.signingSecret ?? "test-secret",
        max_retries: opts.maxRetries ?? 5,
        is_active: opts.subActive ?? true,
      },
    ],
  });
}

// The first webhook_deliveries.update is the atomic-claim lease
// (bumps next_attempt_at but doesn't change status). The dispatch
// outcome is always written in a subsequent update — that's what
// the existing assertions care about.
function lastDeliveryUpdate(): Record<string, unknown> {
  const updates = getSupabaseWritePayloads("webhook_deliveries", "update");
  return updates[updates.length - 1] as Record<string, unknown>;
}

describe("runWebhookDispatcher", () => {
  beforeEach(() => supabaseMock.reset());

  it("returns zero counts when nothing is due", async () => {
    stageSupabaseResponse("webhook_deliveries", "select", { data: [] });
    const stats = await runWebhookDispatcher({ fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(stats).toEqual({
      scanned: 0,
      delivered: 0,
      retried: 0,
      exhausted: 0,
    });
  });

  it("POSTs with HMAC-SHA256 signature in X-PennFit-Signature header", async () => {
    stageDispatchableDelivery();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi
      .fn()
      .mockImplementation(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("ok", { status: 200 });
      });
    await runWebhookDispatcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // The dispatcher uses fetchWithPinnedIp for SSRF defence — the
    // URL is rewritten to substitute the resolved IP literal, with
    // the original hostname preserved in the Host header for TLS
    // SNI. Assert on the path + Host header rather than the
    // literal URL, since example.com's IP changes over time.
    const calledUrl = new URL(call.url);
    expect(calledUrl.pathname).toBe("/wh");
    const headersInit = call.init.headers;
    const headerEntries =
      headersInit instanceof Headers
        ? Object.fromEntries(headersInit.entries())
        : (headersInit as Record<string, string>);
    // Headers class lowercases names; the literal-object init keeps
    // the original casing. Look up both shapes.
    const sig =
      headerEntries["X-PennFit-Signature"] ??
      headerEntries["x-pennfit-signature"];
    const eventType =
      headerEntries["X-PennFit-Event-Type"] ??
      headerEntries["x-pennfit-event-type"];
    // Host header MUST carry the original hostname (not the
    // pinned IP) so TLS SNI + virtual-host routing on the
    // subscriber side still target the right cert / vhost.
    const host = headerEntries["Host"] ?? headerEntries["host"];
    const expected = createHmac("sha256", "test-secret")
      .update(call.init.body as string)
      .digest("base64");
    expect(sig).toBe(expected);
    expect(eventType).toBe("claim.paid");
    expect(host).toBe("example.com");
  });

  it("marks delivery delivered on a 2xx response", async () => {
    stageDispatchableDelivery();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const stats = await runWebhookDispatcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(stats.delivered).toBe(1);
    const subscriptionUpdates = getSupabaseWritePayloads(
      "webhook_subscriptions",
      "update",
    );
    // Two delivery updates now: 1) atomic-claim lease bump, 2) the
    // delivered-status flip. We assert on the second.
    expect(lastDeliveryUpdate().status).toBe("delivered");
    expect(subscriptionUpdates).toHaveLength(1);
    expect(
      (subscriptionUpdates[0] as Record<string, unknown>).last_delivery_status,
    ).toBe("delivered");
  });

  it("schedules an exponential backoff retry on 5xx", async () => {
    stageDispatchableDelivery({ attemptCount: 1, maxRetries: 5 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("err", { status: 503 }));
    const stats = await runWebhookDispatcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(stats.retried).toBe(1);
    expect(stats.delivered).toBe(0);
    const update = lastDeliveryUpdate();
    expect(update.attempt_count).toBe(2);
    expect(update.last_http_status).toBe(503);
    // 2^2 = 4 minute backoff. We accept anything > 60s as proof
    // the schedule advanced.
    const nextAt = new Date(update.next_attempt_at as string).getTime();
    expect(nextAt - Date.now()).toBeGreaterThan(60_000);
  });

  it("marks delivery exhausted at max_retries", async () => {
    stageDispatchableDelivery({ attemptCount: 4, maxRetries: 5 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("err", { status: 500 }));
    const stats = await runWebhookDispatcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(stats.exhausted).toBe(1);
    expect(lastDeliveryUpdate().status).toBe("exhausted");
  });

  it("rejects non-https target URLs", async () => {
    stageDispatchableDelivery({ targetUrl: "http://example.com/wh" });
    const fetchImpl = vi.fn();
    const stats = await runWebhookDispatcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stats.exhausted).toBe(1);
  });

  it("classifies fetch-thrown errors as transport failures with a retry", async () => {
    stageDispatchableDelivery({ attemptCount: 0 });
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const stats = await runWebhookDispatcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(stats.retried).toBe(1);
    const update = lastDeliveryUpdate();
    expect(update.last_http_status).toBeNull();
    expect((update.last_error as string).includes("ECONNREFUSED")).toBe(true);
  });
});
