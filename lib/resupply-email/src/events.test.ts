import { describe, expect, it } from "vitest";

import { parseSendgridEventBatch, SENDGRID_HANDLED_EVENTS } from "./events";

describe("parseSendgridEventBatch", () => {
  it("parses a typical delivered event", () => {
    const batch = parseSendgridEventBatch([
      {
        email: "patient@example.com",
        timestamp: 1719000000,
        event: "delivered",
        sg_message_id: "msg-1",
        sg_event_id: "evt-1",
        conversation_id: "conv-1",
      },
    ]);
    expect(batch).toHaveLength(1);
    expect(batch[0]?.event).toBe("delivered");
    expect(batch[0]?.conversation_id).toBe("conv-1");
  });

  it("parses bounce events with reason", () => {
    const batch = parseSendgridEventBatch([
      {
        email: "patient@example.com",
        event: "bounce",
        reason: "550 5.1.1 user not found",
        type: "bounce",
        sg_message_id: "msg-2",
      },
    ]);
    expect(batch[0]?.reason).toBe("550 5.1.1 user not found");
  });

  it("preserves unknown fields via passthrough", () => {
    const batch = parseSendgridEventBatch([
      {
        event: "delivered",
        sg_message_id: "msg-3",
        custom_unknown_field: "anything",
      },
    ]);
    expect((batch[0] as Record<string, unknown>).custom_unknown_field).toBe(
      "anything",
    );
  });

  it("parses an empty batch", () => {
    const batch = parseSendgridEventBatch([]);
    expect(batch).toEqual([]);
  });

  it("rejects a non-array payload", () => {
    expect(() => parseSendgridEventBatch({ event: "delivered" })).toThrow();
  });

  it("rejects an event without `event` field", () => {
    expect(() => parseSendgridEventBatch([{ sg_message_id: "x" }])).toThrow();
  });

  it("HANDLED list contains the events the audit handler reacts to", () => {
    expect(SENDGRID_HANDLED_EVENTS).toContain("delivered");
    expect(SENDGRID_HANDLED_EVENTS).toContain("bounce");
    expect(SENDGRID_HANDLED_EVENTS).toContain("dropped");
  });
});
