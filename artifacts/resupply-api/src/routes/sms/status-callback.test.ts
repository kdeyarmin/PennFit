// Route tests for POST /sms/status-callback.
//
// Signature middleware is replaced with a passthrough — the signature
// behavior itself is exhaustively tested in @workspace/resupply-telecom.
// Coverage here is the correlation split: conversation-message callbacks
// update the messages row by SID; recall-notification callbacks (the
// `recallNotificationId` query param baked into the signed callback URL
// by the recall send sweep) update the recall_notifications row by id.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    requireTwilioSignature:
      () =>
      (_req: unknown, _res: unknown, next: (err?: unknown) => void): void => {
        next();
      },
  };
});

import { installSupabaseMock } from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const safeAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/messaging/safe-audit", () => ({
  safeAudit: (...a: unknown[]) => safeAuditMock(...a),
}));

import statusCallbackRouter from "./status-callback";

const RECALL_NOTIFICATION_ID = "66666666-6666-4666-8666-666666666666";
const VIDEO_VISIT_ID = "77777777-7777-4777-8777-777777777777";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_SID = "SM_test_sid";

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/resupply-api", statusCallbackRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  safeAuditMock.mockClear();
});

describe("POST /sms/status-callback (recall notifications)", () => {
  it("stamps delivery outcome onto the recall row, not messages", async () => {
    const res = await request(makeApp())
      .post(
        `/resupply-api/sms/status-callback?recallNotificationId=${RECALL_NOTIFICATION_ID}`,
      )
      .type("form")
      .send({ MessageSid: MESSAGE_SID, MessageStatus: "delivered" });

    expect(res.status).toBe(200);
    expect(supabaseMock.callCount("recall_notifications", "update")).toBe(1);
    expect(supabaseMock.callCount("messages", "update")).toBe(0);

    const [payload] = supabaseMock.writePayloads(
      "recall_notifications",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(payload).toMatchObject({
      delivery_status: "delivered",
      delivery_error_code: null,
      twilio_message_sid: MESSAGE_SID,
    });
    expect(
      supabaseMock.filterCalls("recall_notifications", "update"),
    ).toContainEqual({ verb: "eq", args: ["id", RECALL_NOTIFICATION_ID] });
  });

  it("records the error code and audits on a delivery failure", async () => {
    const res = await request(makeApp())
      .post(
        `/resupply-api/sms/status-callback?recallNotificationId=${RECALL_NOTIFICATION_ID}`,
      )
      .type("form")
      .send({
        MessageSid: MESSAGE_SID,
        MessageStatus: "undelivered",
        ErrorCode: "30005",
      });

    expect(res.status).toBe(200);
    const [payload] = supabaseMock.writePayloads(
      "recall_notifications",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(payload).toMatchObject({
      delivery_status: "undelivered",
      delivery_error_code: "30005",
    });
    expect(safeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "messaging.delivery.failed",
        targetTable: "recall_notifications",
        targetId: RECALL_NOTIFICATION_ID,
        metadata: expect.objectContaining({
          recall_notification_id: RECALL_NOTIFICATION_ID,
          twilio_message_sid: MESSAGE_SID,
          status: "undelivered",
          error_code: "30005",
        }),
      }),
    );
  });

  it("guards a late `sent` against regressing a final delivery state", async () => {
    await request(makeApp())
      .post(
        `/resupply-api/sms/status-callback?recallNotificationId=${RECALL_NOTIFICATION_ID}`,
      )
      .type("form")
      .send({ MessageSid: MESSAGE_SID, MessageStatus: "sent" });

    expect(
      supabaseMock.filterCalls("recall_notifications", "update"),
    ).toContainEqual({
      verb: "or",
      args: [
        "delivery_status.is.null,delivery_status.not.in.(delivered,undelivered,failed)",
      ],
    });
  });

  it("ignores a malformed recallNotificationId and falls back to the messages path", async () => {
    await request(makeApp())
      .post("/resupply-api/sms/status-callback?recallNotificationId=not-a-uuid")
      .type("form")
      .send({ MessageSid: MESSAGE_SID, MessageStatus: "delivered" });

    expect(supabaseMock.callCount("recall_notifications", "update")).toBe(0);
    expect(supabaseMock.callCount("messages", "update")).toBe(1);
  });
});

describe("POST /sms/status-callback (video visit invites)", () => {
  it("stamps the invite delivery outcome onto the visit row, not messages", async () => {
    const res = await request(makeApp())
      .post(`/resupply-api/sms/status-callback?videoVisitId=${VIDEO_VISIT_ID}`)
      .type("form")
      .send({ MessageSid: MESSAGE_SID, MessageStatus: "delivered" });

    expect(res.status).toBe(200);
    expect(supabaseMock.callCount("video_visits", "update")).toBe(1);
    expect(supabaseMock.callCount("messages", "update")).toBe(0);

    const [payload] = supabaseMock.writePayloads(
      "video_visits",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(payload).toMatchObject({
      invite_delivery_status: "delivered",
      invite_delivery_error_code: null,
      invite_twilio_message_sid: MESSAGE_SID,
    });
    expect(supabaseMock.filterCalls("video_visits", "update")).toContainEqual({
      verb: "eq",
      args: ["id", VIDEO_VISIT_ID],
    });
    // First-writer-or-match guard: NULL (the callback beat the send
    // path's SID write) or the same SID — a superseded re-sent invite's
    // SID matches neither, so it can't clobber the current invite.
    expect(supabaseMock.filterCalls("video_visits", "update")).toContainEqual({
      verb: "or",
      args: [
        `invite_twilio_message_sid.is.null,invite_twilio_message_sid.eq.${JSON.stringify(
          MESSAGE_SID,
        )}`,
      ],
    });
  });

  it("records the error code and audits on a delivery failure", async () => {
    const res = await request(makeApp())
      .post(`/resupply-api/sms/status-callback?videoVisitId=${VIDEO_VISIT_ID}`)
      .type("form")
      .send({
        MessageSid: MESSAGE_SID,
        MessageStatus: "undelivered",
        ErrorCode: "30034",
      });

    expect(res.status).toBe(200);
    const [payload] = supabaseMock.writePayloads(
      "video_visits",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(payload).toMatchObject({
      invite_delivery_status: "undelivered",
      invite_delivery_error_code: "30034",
    });
    expect(safeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "messaging.delivery.failed",
        targetTable: "video_visits",
        targetId: VIDEO_VISIT_ID,
        metadata: expect.objectContaining({
          video_visit_id: VIDEO_VISIT_ID,
          twilio_message_sid: MESSAGE_SID,
          status: "undelivered",
          error_code: "30034",
        }),
      }),
    );
  });

  it("guards a late `sent` against regressing a final delivery state", async () => {
    await request(makeApp())
      .post(`/resupply-api/sms/status-callback?videoVisitId=${VIDEO_VISIT_ID}`)
      .type("form")
      .send({ MessageSid: MESSAGE_SID, MessageStatus: "sent" });

    expect(supabaseMock.filterCalls("video_visits", "update")).toContainEqual({
      verb: "or",
      args: [
        "invite_delivery_status.is.null,invite_delivery_status.not.in.(delivered,undelivered,failed)",
      ],
    });
  });

  it("ignores a malformed videoVisitId and falls back to the messages path", async () => {
    await request(makeApp())
      .post("/resupply-api/sms/status-callback?videoVisitId=not-a-uuid")
      .type("form")
      .send({ MessageSid: MESSAGE_SID, MessageStatus: "delivered" });

    expect(supabaseMock.callCount("video_visits", "update")).toBe(0);
    expect(supabaseMock.callCount("messages", "update")).toBe(1);
  });
});

describe("POST /sms/status-callback (conversation messages)", () => {
  it("still updates the messages row by SID when no recall param is present", async () => {
    const res = await request(makeApp())
      .post(
        `/resupply-api/sms/status-callback?conversationId=${CONVERSATION_ID}`,
      )
      .type("form")
      .send({ MessageSid: MESSAGE_SID, MessageStatus: "delivered" });

    expect(res.status).toBe(200);
    expect(supabaseMock.callCount("messages", "update")).toBe(1);
    expect(supabaseMock.callCount("recall_notifications", "update")).toBe(0);
    expect(supabaseMock.filterCalls("messages", "update")).toContainEqual({
      verb: "filter",
      args: ["vendor_metadata->>twilio_message_sid", "eq", MESSAGE_SID],
    });
  });

  it("ignores intermediate (non-terminal) statuses quietly", async () => {
    const res = await request(makeApp())
      .post(
        `/resupply-api/sms/status-callback?recallNotificationId=${RECALL_NOTIFICATION_ID}`,
      )
      .type("form")
      .send({ MessageSid: MESSAGE_SID, MessageStatus: "queued" });

    expect(res.status).toBe(200);
    expect(supabaseMock.callCount("recall_notifications", "update")).toBe(0);
    expect(supabaseMock.callCount("messages", "update")).toBe(0);
  });
});
