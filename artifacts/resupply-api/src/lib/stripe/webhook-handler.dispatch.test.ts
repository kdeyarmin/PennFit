// Handler-level dispatch tests for stripeWebhookHandler.
//
// The per-event side effects (markPaid, refund mirroring, subscription
// upsert, customer-phone sync, …) each have their own focused suites.
// What had NO coverage was the 1700-line handler's DISPATCH SKELETON:
// config gating, signature handling, the event-id idempotency gate, and
// event-type routing / ack. These tests drive the handler with a fake
// req/res and a stubbed Stripe client so we can inject any event without
// a real signature, and assert the skeleton's status codes + routing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ── Supabase mock (drives the dedup insert + markStatus update) ──────────────
interface Staged {
  error?: unknown;
  data?: unknown;
  throws?: unknown;
}
const staged = new Map<string, Staged[]>();
const writes = new Map<string, unknown[]>();
function stage(table: string, op: string, resp: Staged): void {
  const k = `${table}.${op}`;
  staged.set(k, [...(staged.get(k) ?? []), resp]);
}
function pop(table: string, op: string): Staged {
  const list = staged.get(`${table}.${op}`);
  return list && list.length > 0 ? list.shift()! : { error: null };
}
function makeBuilder(table: string) {
  let op = "select";
  const record = (o: string, payload?: unknown) => {
    op = o;
    writes.set(`${table}.${o}`, [
      ...(writes.get(`${table}.${o}`) ?? []),
      payload,
    ]);
  };
  const resolve = () => {
    const r = pop(table, op);
    if (r.throws !== undefined) return Promise.reject(r.throws);
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  };
  const b: Record<string, unknown> = {
    select: () => b,
    insert: (p?: unknown) => {
      record("insert", p);
      return b;
    },
    update: (p?: unknown) => {
      record("update", p);
      return b;
    },
    delete: () => {
      record("delete");
      return b;
    },
    upsert: (p?: unknown) => {
      record("upsert", p);
      return b;
    },
    eq: () => b,
    in: () => b,
    is: () => b,
    not: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: resolve,
    single: resolve,
    then: (ok: (v: unknown) => unknown, fail?: (v: unknown) => unknown) =>
      resolve().then(ok, fail),
  };
  return b;
}
vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => ({
    schema: () => ({ from: (t: string) => makeBuilder(t) }),
  }),
}));

// ── Stripe config + client mock ───────────────────────────────────────────────
const constructEventMock = vi.fn();
const VALID_CONFIG = {
  secretKey: "sk_test_x",
  publishableKey: "pk_test_x",
  webhookSigningSecret: "whsec_test",
  publicBaseUrl: "https://shop.example.com",
};
const configState: { current: unknown } = { current: VALID_CONFIG };
vi.mock("./config", () => ({
  readStripeConfigOrNull: () => configState.current,
  getStripeClient: () => ({ webhooks: { constructEvent: constructEventMock } }),
}));

import { stripeWebhookHandler } from "./webhook-handler";

interface InvokeResult {
  status: number;
  body: unknown;
}
async function invoke(opts: {
  signature?: string | undefined;
  body?: unknown;
  event?: unknown;
  signatureThrows?: boolean;
}): Promise<InvokeResult> {
  constructEventMock.mockReset();
  if (opts.signatureThrows) {
    constructEventMock.mockImplementation(() => {
      throw new Error("signature mismatch");
    });
  } else {
    constructEventMock.mockReturnValue(opts.event);
  }
  const headers: Record<string, string> = {};
  if (opts.signature !== undefined)
    headers["stripe-signature"] = opts.signature;
  const req = {
    headers,
    body: "body" in opts ? opts.body : Buffer.from("{}"),
  } as unknown as Request;
  let status = 0;
  let body: unknown;
  const res = {
    status(c: number) {
      status = c;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  } as unknown as Response;
  await stripeWebhookHandler(req, res, () => undefined);
  return { status, body };
}

beforeEach(() => {
  staged.clear();
  writes.clear();
  configState.current = VALID_CONFIG;
});

describe("stripeWebhookHandler — config + signature gating", () => {
  it("503s in production when the webhook secret is unconfigured", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    configState.current = { ...VALID_CONFIG, webhookSigningSecret: null };
    const r = await invoke({ signature: "sig" });
    process.env.NODE_ENV = prev;
    expect(r.status).toBe(503);
    expect((r.body as { error: string }).error).toBe("shop_unavailable");
  });

  it("400s when the stripe-signature header is missing", async () => {
    const r = await invoke({ signature: undefined });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe(
      "missing_stripe_signature",
    );
  });

  it("400s when the raw body is not a Buffer (body-parser order wrong)", async () => {
    const r = await invoke({ signature: "sig", body: '{"not":"a buffer"}' });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("raw_body_missing");
  });

  it("400s when signature verification fails", async () => {
    const r = await invoke({ signature: "bad", signatureThrows: true });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("invalid_signature");
  });
});

describe("stripeWebhookHandler — idempotency gate", () => {
  const event = {
    id: "evt_1",
    type: "checkout.session.expired",
    data: { object: { id: "cs_1" } },
  };

  it("acks 200 deduped when the event id was already recorded (unique violation)", async () => {
    stage("stripe_webhook_events", "insert", { error: { code: "23505" } });
    const r = await invoke({ signature: "sig", event });
    expect(r.status).toBe(200);
    expect((r.body as { deduped?: boolean }).deduped).toBe(true);
    // Deduped events must NOT reach the switch — no order write happened.
    expect(writes.get("shop_orders.update")).toBeUndefined();
  });

  it("500s (so Stripe retries) when the dedup insert errors non-uniquely", async () => {
    stage("stripe_webhook_events", "insert", { error: { code: "08006" } });
    const r = await invoke({ signature: "sig", event });
    expect(r.status).toBe(500);
    expect((r.body as { error: string }).error).toBe("dedup_unavailable");
  });
});

describe("stripeWebhookHandler — routing", () => {
  it("routes a known event to its handler and acks 200", async () => {
    const r = await invoke({
      signature: "sig",
      event: {
        id: "evt_expired",
        type: "checkout.session.expired",
        data: { object: { id: "cs_expired" } },
      },
    });
    expect(r.status).toBe(200);
    expect((r.body as { received?: boolean }).received).toBe(true);
    // The expired handler marks the order status via an update.
    expect(writes.get("shop_orders.update")).toBeDefined();
  });

  it("acks 200 for an unsubscribed/unknown event type without side effects", async () => {
    const r = await invoke({
      signature: "sig",
      event: {
        id: "evt_x",
        type: "radar.early_fraud_warning.created",
        data: { object: {} },
      },
    });
    expect(r.status).toBe(200);
    expect((r.body as { received?: boolean }).received).toBe(true);
    expect(writes.get("shop_orders.update")).toBeUndefined();
  });

  it("rolls back the dedup record and 500s when a handler throws", async () => {
    // Force the expired handler's order update to throw → the catch
    // should delete the dedup row (so Stripe's retry isn't deduped away)
    // and surface 500.
    stage("shop_orders", "update", { throws: new Error("db down") });
    const r = await invoke({
      signature: "sig",
      event: {
        id: "evt_boom",
        type: "checkout.session.expired",
        data: { object: { id: "cs_boom" } },
      },
    });
    expect(r.status).toBe(500);
    expect((r.body as { error: string }).error).toBe("internal_error");
    // dedup row released for retry
    expect(writes.get("stripe_webhook_events.delete")).toBeDefined();
  });
});
