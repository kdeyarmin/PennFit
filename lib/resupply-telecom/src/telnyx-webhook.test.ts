// Unit tests for Telnyx fax webhook parsing (telnyx-webhook.ts).

import { describe, it, expect } from "vitest";
import { parseTelnyxFaxEvent } from "./telnyx-webhook";

describe("parseTelnyxFaxEvent", () => {
  it("parses a wrapped fax.received (inbound) event", () => {
    const body = {
      data: {
        event_type: "fax.received",
        id: "evt-1",
        occurred_at: "2026-06-09T00:00:00Z",
        record_type: "event",
        payload: {
          fax_id: "f72eebbe-f9b6-4f0f-b652-03e742e110d5",
          connection_id: "1447842681660114324",
          direction: "inbound",
          from: "+16132484850",
          to: "+17733372863",
          status: "received",
          page_count: 2,
          media_url: "https://s3.amazonaws.com/telnyx/fax.pdf",
        },
      },
      meta: { attempt: 1 },
    };
    const result = parseTelnyxFaxEvent(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      eventType: "fax.received",
      faxId: "f72eebbe-f9b6-4f0f-b652-03e742e110d5",
      direction: "inbound",
      status: "received",
      from: "+16132484850",
      to: "+17733372863",
      pageCount: 2,
      mediaUrl: "https://s3.amazonaws.com/telnyx/fax.pdf",
      failureReason: null,
    });
  });

  it("parses a flattened fax.delivered (outbound) event", () => {
    const body = {
      event_type: "fax.delivered",
      id: "evt-2",
      payload: {
        fax_id: "c62be5bc-9b13-4b6c-abda-34dd8b541287",
        direction: "outbound",
        from: "+19459457421",
        to: "+13129457420",
        status: "delivered",
        page_count: 1,
      },
    };
    const result = parseTelnyxFaxEvent(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.eventType).toBe("fax.delivered");
    expect(result.event.faxId).toBe("c62be5bc-9b13-4b6c-abda-34dd8b541287");
    expect(result.event.status).toBe("delivered");
    expect(result.event.pageCount).toBe(1);
    expect(result.event.mediaUrl).toBeNull();
  });

  it("captures failure_reason on fax.failed", () => {
    const body = {
      data: {
        event_type: "fax.failed",
        payload: {
          fax_id: "f7b303ed-674c-4962-951b-848380510893",
          direction: "outbound",
          status: "failed",
          failure_reason: "user_busy",
        },
      },
    };
    const result = parseTelnyxFaxEvent(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.eventType).toBe("fax.failed");
    expect(result.event.failureReason).toBe("user_busy");
  });

  it("returns ok:false when payload.fax_id is missing", () => {
    const body = {
      data: { event_type: "fax.delivered", payload: { status: "delivered" } },
    };
    expect(parseTelnyxFaxEvent(body).ok).toBe(false);
  });

  it("returns ok:false when event_type is missing", () => {
    const body = { data: { payload: { fax_id: "x" } } };
    expect(parseTelnyxFaxEvent(body).ok).toBe(false);
  });

  it("returns ok:false on a non-object body", () => {
    expect(parseTelnyxFaxEvent(null).ok).toBe(false);
    expect(parseTelnyxFaxEvent("nope").ok).toBe(false);
  });
});
