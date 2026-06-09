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
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Imported after the mock is installed so the helper's
// getSupabaseServiceRoleClient is the mocked one. (customerChatTools
// takes the client via context, but in-app-conversation pulls nothing
// global — we just pass the mocked client in.)
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
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
    // past it, so the tool clamps to IN_APP_MESSAGE_BODY_MAX (4000) —
    // here we just confirm the message persists and stays a string.
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
    expect(body.length).toBeLessThanOrEqual(4000);
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
