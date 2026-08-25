// Unit tests for the signed-in customer chatbot tool dispatcher,
// focused on the escalate_to_human tool (the read-only order /
// subscription / device tools are exercised end-to-end through the
// /shop/me/chat route tests).
//
// escalate_to_human posts to the customer's in-app conversation thread
// via the shared appendCustomerMessage helper, so we drive it through
// the lightweight Supabase mock and assert on the staged round-trips.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Imported after the mock is installed so the helper's
// getSupabaseServiceRoleClient is the mocked one. (customerChatTools
// takes the client via context, but in-app-conversation pulls nothing
// global — we just pass the mocked client in.)
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { IN_APP_MESSAGE_BODY_MAX } from "../messaging/in-app-conversation";
import {
  CUSTOMER_CHAT_TOOLS,
  executeCustomerChatTool,
  serializeCustomerToolResult,
  type CustomerChatToolContext,
} from "./customerChatTools";

function makeCtx(): CustomerChatToolContext {
  return {
    supabase: getSupabaseServiceRoleClient(),
    customerId: "cust_123",
    customerDisplayName: "Pat Patient",
    customerEmail: "pat@example.com",
  };
}

beforeEach(() => {
  supabaseMock.reset();
  // CSR-inbox notification is opt-in; leaving it unset keeps the tool's
  // best-effort notify a silent no-op in tests.
  delete process.env.SHOP_CSR_INBOX_EMAIL;
});

describe("escalate_to_human", () => {
  it("uses the tenant assistant name in the persisted prefix when provided", async () => {
    supabaseMock.stage("conversations", "select", { data: null });
    supabaseMock.stage("conversations", "insert", {
      data: { id: "conv_new" },
    });
    supabaseMock.stage("messages", "insert", { data: { id: "msg_1" } });

    const result = await executeCustomerChatTool(
      "escalate_to_human",
      { summary: "Please call me about my last order." },
      { ...makeCtx(), assistantStorefrontName: "Acme Assistant" },
    );
    expect(result.ok).toBe(true);
    const body = (
      getSupabaseWritePayloads("messages", "insert")[0] as { body: string }
    ).body;
    expect(body).toContain("[Via Acme Assistant · General]");
    expect(body).not.toContain("PennBot");
  });

  it("opens a new support thread and reports it was escalated", async () => {
    // appendCustomerMessage flow for a first-time messager:
    //   conversations.select (find existing) -> none
    //   conversations.insert (create thread) -> id
    //   messages.insert -> id
    //   conversations.update (bump) -> ignored
    supabaseMock.stage("conversations", "select", { data: null });
    supabaseMock.stage("conversations", "insert", {
      data: { id: "conv_new" },
    });
    supabaseMock.stage("messages", "insert", { data: { id: "msg_1" } });

    const result = await executeCustomerChatTool(
      "escalate_to_human",
      {
        summary:
          "I want a refund on order 12345 — the cushion arrived cracked.",
        category: "returns_refund",
      },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      escalated: true,
      threadId: "conv_new",
      threadCreated: true,
    });

    // The customer's message was actually persisted, with the assistant
    // marker prefix and the human-readable category label.
    const msgInserts = getSupabaseWritePayloads("messages", "insert");
    expect(msgInserts).toHaveLength(1);
    const body = (msgInserts[0] as { body: string }).body;
    expect(body).toContain("[Via CareMetric Assistant · Return / refund]");
    expect(body).toContain("cracked");
    expect((msgInserts[0] as { sender_role: string }).sender_role).toBe(
      "customer",
    );
  });

  it("appends to an existing thread without creating a new one", async () => {
    supabaseMock.stage("conversations", "select", {
      data: { id: "conv_existing" },
    });
    supabaseMock.stage("messages", "insert", { data: { id: "msg_2" } });

    const result = await executeCustomerChatTool(
      "escalate_to_human",
      { summary: "Please change my shipping address — I moved." },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      escalated: true,
      threadId: "conv_existing",
      threadCreated: false,
    });
    // No new thread row should have been inserted.
    expect(getSupabaseCallCount("conversations", "insert")).toBe(0);

    // Default category renders as "General" when the model omits it.
    const body = (
      getSupabaseWritePayloads("messages", "insert")[0] as { body: string }
    ).body;
    expect(body).toContain("[Via CareMetric Assistant · General]");
  });

  it("rejects an empty summary without touching the database", async () => {
    const result = await executeCustomerChatTool(
      "escalate_to_human",
      { summary: "   " },
      makeCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/invalid arguments/i);
    expect(getSupabaseCallCount("messages", "insert")).toBe(0);
    expect(getSupabaseCallCount("conversations", "insert")).toBe(0);
  });

  it("clamps an over-long summary into the message body", async () => {
    supabaseMock.stage("conversations", "select", {
      data: { id: "conv_existing" },
    });
    supabaseMock.stage("messages", "insert", { data: { id: "msg_3" } });

    // 1500 chars is the schema max; the prefix pushes the body a little
    // past it, so the tool clamps to IN_APP_MESSAGE_BODY_MAX — here we
    // just confirm the message persists and stays within the cap.
    const longSummary = "x".repeat(1500);
    const result = await executeCustomerChatTool(
      "escalate_to_human",
      { summary: longSummary },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const body = (
      getSupabaseWritePayloads("messages", "insert")[0] as { body: string }
    ).body;
    expect(typeof body).toBe("string");
    expect(body.length).toBeLessThanOrEqual(IN_APP_MESSAGE_BODY_MAX);
  });

  it("serializes the escalation result as compact JSON for the model", () => {
    const serialized = serializeCustomerToolResult({
      ok: true,
      data: { escalated: true, threadId: "conv_x", threadCreated: false },
    });
    expect(JSON.parse(serialized)).toEqual({
      escalated: true,
      threadId: "conv_x",
      threadCreated: false,
    });
  });
});

describe("unknown tool", () => {
  it("returns an error result rather than throwing", async () => {
    const result = await executeCustomerChatTool(
      "does_not_exist",
      {},
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unknown tool/i);
  });
});

describe("update_order_shipping_address is gone", () => {
  it("is not a dispatchable tool any more", async () => {
    // A patient address change raises a CSR compliance alert and holds
    // the next shipment — a deliberate review step. The old tool wrote
    // shop_orders.shipping_address_json, which no fulfillment reads, so
    // a patient was told their address was fixed when nothing moved.
    // Asserting the absence keeps a re-add deliberate.
    const result = await executeCustomerChatTool(
      "update_order_shipping_address",
      { orderId: "x", line1: "1 Main", city: "Philadelphia", state: "PA" },
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown tool/i);
  });

  it("is not advertised to the model", () => {
    const names = CUSTOMER_CHAT_TOOLS.map((t) => t.function.name);
    expect(names).not.toContain("update_order_shipping_address");
    // …and the hand-off that replaces it is still there.
    expect(names).toContain("escalate_to_human");
  });
});

describe("shipment tools read the live insurance path", () => {
  const PATIENT_ID = "99999999-8888-7777-6666-555555555555";

  /** Bind the caller to exactly one patient chart. */
  function stagePatientLink(): void {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: "cust_123", email_lower: "pat@example.com" },
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: PATIENT_ID }],
    });
  }

  it("get_my_recent_orders reads fulfillments, never shop_orders", async () => {
    stagePatientLink();
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          id: "ful_1",
          item_sku: "A7032",
          quantity: "2",
          status: "queued",
          shipped_at: null,
          delivered_at: null,
          created_at: "2026-08-01T00:00:00Z",
          substituted_from_sku: null,
        },
      ],
    });

    const result = await executeCustomerChatTool(
      "get_my_recent_orders",
      {},
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    expect(getSupabaseCallCount("fulfillments", "select")).toBe(1);
    expect(getSupabaseCallCount("shop_orders", "select")).toBe(0);
  });

  it("reports a queued row as with_warehouse, not as 'not shipped'", async () => {
    stagePatientLink();
    stageSupabaseResponse("fulfillments", "select", {
      data: [
        {
          id: "ful_1",
          item_sku: "A7032",
          quantity: "1",
          status: "queued",
          shipped_at: null,
          delivered_at: null,
          created_at: "2026-08-01T00:00:00Z",
          substituted_from_sku: null,
        },
      ],
    });

    const result = await executeCustomerChatTool(
      "get_my_recent_orders",
      {},
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { orders: Array<{ status: string }> };
    // The warehouse stamps shipped_at out of band, so a NULL there must
    // never be reported to a patient as "it hasn't shipped".
    expect(data.orders[0]!.status).toBe("with_warehouse");
  });

  it("says patientLinked: false rather than 'no orders' on an ambiguous email", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: "cust_123", email_lower: "shared@example.com" },
    });
    // Two charts carry the address (household share) — binding to either
    // would read another patient's shipments to this caller.
    stageSupabaseResponse("patients", "select", {
      data: [{ id: PATIENT_ID }, { id: "other-patient" }],
    });

    const result = await executeCustomerChatTool(
      "get_my_recent_orders",
      {},
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      patientLinked: boolean;
      orders: unknown[];
    };
    expect(data.patientLinked).toBe(false);
    expect(data.orders).toEqual([]);
    // Never went looking for shipments it could not safely attribute.
    expect(getSupabaseCallCount("fulfillments", "select")).toBe(0);
  });

  it("get_order_details scopes the lookup to the caller's own chart", async () => {
    stagePatientLink();
    stageSupabaseResponse("fulfillments", "select", { data: null });

    const result = await executeCustomerChatTool(
      "get_order_details",
      { orderId: "someone-elses-fulfillment" },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // patient_id in the WHERE clause is the ownership check: a forged id
    // simply does not match.
    expect((result.data as { found: boolean }).found).toBe(false);
  });
});
