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

    // The customer's message was actually persisted, with the PennBot
    // marker prefix and the human-readable category label.
    const msgInserts = getSupabaseWritePayloads("messages", "insert");
    expect(msgInserts).toHaveLength(1);
    const body = (msgInserts[0] as { body: string }).body;
    expect(body).toContain("[Via PennBot · Return / refund]");
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
    expect(body).toContain("[Via PennBot · General]");
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

describe("update_order_shipping_address", () => {
  const ORDER_ID = "11111111-2222-3333-8444-555555555555";
  const validArgs = {
    orderId: ORDER_ID,
    line1: "456 New Address Ln",
    line2: "Suite 9",
    city: "Philadelphia",
    state: "pa",
    postalCode: "19104",
  };

  it("updates the address on a paid, unshipped order and echoes city/state", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        status: "paid",
        shipped_at: null,
        fulfillment_method: "ship",
      },
    });
    stageSupabaseResponse("shop_orders", "update", { data: { id: ORDER_ID } });

    const result = await executeCustomerChatTool(
      "update_order_shipping_address",
      validArgs,
      makeCtx(),
    );
    expect(result).toEqual({
      ok: true,
      data: {
        addressUpdated: true,
        orderId: ORDER_ID,
        city: "Philadelphia",
        // State is normalised to uppercase.
        state: "PA",
      },
    });
    // The persisted address carries the pinned country + uppercased state.
    const writes = getSupabaseWritePayloads("shop_orders", "update");
    expect(writes[0]?.shipping_address_json).toMatchObject({
      line1: "456 New Address Ln",
      line2: "Suite 9",
      city: "Philadelphia",
      state: "PA",
      postalCode: "19104",
      country: "US",
    });
  });

  it("returns not_found (and never writes) for an order that isn't the caller's", async () => {
    // IDOR guard: the customer_id filter means a foreign id selects nothing.
    stageSupabaseResponse("shop_orders", "select", { data: null });

    const result = await executeCustomerChatTool(
      "update_order_shipping_address",
      validArgs,
      makeCtx(),
    );
    expect(result).toEqual({
      ok: true,
      data: { found: false, kind: "order" },
    });
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("refuses (no write) when the order already shipped", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        status: "paid",
        shipped_at: "2026-04-01T00:00:00Z",
        fulfillment_method: "ship",
      },
    });

    const result = await executeCustomerChatTool(
      "update_order_shipping_address",
      validArgs,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already shipped/i);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("refuses (no write) for a pickup order", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        status: "paid",
        shipped_at: null,
        fulfillment_method: "pickup",
      },
    });

    const result = await executeCustomerChatTool(
      "update_order_shipping_address",
      validArgs,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pickup/i);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("refuses (no write) when the order isn't paid", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        status: "pending",
        shipped_at: null,
        fulfillment_method: "ship",
      },
    });

    const result = await executeCustomerChatTool(
      "update_order_shipping_address",
      validArgs,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });

  it("reports a shipped-in-race when the guarded update matches no row", async () => {
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        id: ORDER_ID,
        status: "paid",
        shipped_at: null,
        fulfillment_method: "ship",
      },
    });
    // UPDATE ... WHERE shipped_at IS NULL matched 0 rows (shipped mid-flight).
    stageSupabaseResponse("shop_orders", "update", { data: null });

    const result = await executeCustomerChatTool(
      "update_order_shipping_address",
      validArgs,
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/just shipped/i);
  });

  it("rejects invalid arguments without touching the database", async () => {
    const result = await executeCustomerChatTool(
      "update_order_shipping_address",
      { orderId: ORDER_ID, line1: "1 Main" }, // missing city/state/postalCode
      makeCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invalid arguments/i);
    expect(getSupabaseCallCount("shop_orders", "select")).toBe(0);
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(0);
  });
});
