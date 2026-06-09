import { describe, it, expect } from "vitest";

import {
  aggregateChannelEngagement,
  type ConversationRow,
  type MessageRow,
  type OrderRow,
} from "./channel-engagement";
import { type VoiceCallRow } from "./voice-metrics";

const conv = (r: Partial<ConversationRow>): ConversationRow => ({
  id: "c1",
  channel: "sms",
  ...r,
});

const msg = (r: Partial<MessageRow>): MessageRow => ({
  conversationId: "c1",
  direction: "outbound",
  deliveryStatus: null,
  ...r,
});

const call = (r: Partial<VoiceCallRow>): VoiceCallRow => ({
  status: null,
  direction: null,
  durationSeconds: null,
  initiatedAt: null,
  answeredAt: null,
  ...r,
});

const order = (r: Partial<OrderRow>): OrderRow => ({
  status: "paid",
  amountTotalCents: 0,
  ...r,
});

describe("aggregateChannelEngagement", () => {
  it("returns a zeroed shape with no data", () => {
    const result = aggregateChannelEngagement({
      conversations: [],
      messages: [],
      voiceCalls: [],
      orders: [],
    });
    expect(result.messaging.map((m) => m.channel)).toEqual([
      "sms",
      "email",
      "chat",
    ]);
    for (const m of result.messaging) {
      expect(m).toMatchObject({
        conversations: 0,
        outbound: 0,
        inbound: 0,
        replyRate: null,
        delivered: 0,
        failed: 0,
        deliveryRate: null,
      });
    }
    expect(result.voice.totalCalls).toBe(0);
    expect(result.outcomes).toEqual({
      purchases: 0,
      purchaseRevenueCents: 0,
    });
    expect(result.summary).toEqual({
      totalOutbound: 0,
      totalInbound: 0,
      totalReplies: 0,
      overallEngagementRate: null,
    });
  });

  it("buckets messages by their conversation's channel", () => {
    const conversations: ConversationRow[] = [
      conv({ id: "sms1", channel: "sms" }),
      conv({ id: "em1", channel: "email" }),
      conv({ id: "chat1", channel: "in_app" }), // in_app normalises to chat
      conv({ id: "voice1", channel: "voice" }), // excluded from messaging
    ];
    const messages: MessageRow[] = [
      // sms: 2 out (1 delivered, 1 failed), 1 in
      msg({
        conversationId: "sms1",
        direction: "outbound",
        deliveryStatus: "delivered",
      }),
      msg({
        conversationId: "sms1",
        direction: "outbound",
        deliveryStatus: "failed",
      }),
      msg({ conversationId: "sms1", direction: "inbound" }),
      // email: 1 out (sent), 2 in
      msg({
        conversationId: "em1",
        direction: "outbound",
        deliveryStatus: "sent",
      }),
      msg({ conversationId: "em1", direction: "inbound" }),
      msg({ conversationId: "em1", direction: "inbound" }),
      // chat: 1 out, 0 in
      msg({ conversationId: "chat1", direction: "outbound" }),
      // voice channel messages are ignored entirely
      msg({ conversationId: "voice1", direction: "inbound" }),
      msg({ conversationId: "voice1", direction: "outbound" }),
      // message for an unknown conversation is dropped
      msg({ conversationId: "ghost", direction: "inbound" }),
    ];

    const result = aggregateChannelEngagement({
      conversations,
      messages,
      voiceCalls: [],
      orders: [],
    });

    const sms = result.messaging.find((m) => m.channel === "sms")!;
    expect(sms).toMatchObject({
      conversations: 1,
      outbound: 2,
      inbound: 1,
      replyRate: 0.5,
      delivered: 1,
      failed: 1,
      deliveryRate: 0.5,
    });

    const email = result.messaging.find((m) => m.channel === "email")!;
    expect(email).toMatchObject({
      conversations: 1,
      outbound: 1,
      inbound: 2,
      replyRate: 2,
      delivered: 1,
      failed: 0,
      deliveryRate: 1,
    });

    const chat = result.messaging.find((m) => m.channel === "chat")!;
    expect(chat).toMatchObject({
      conversations: 1,
      outbound: 1,
      inbound: 0,
      replyRate: 0,
      delivered: 0,
      failed: 0,
      deliveryRate: null,
    });
  });

  it("reports voice from the voice_calls ledger", () => {
    const result = aggregateChannelEngagement({
      conversations: [],
      messages: [],
      voiceCalls: [
        call({
          direction: "inbound",
          status: "completed",
          answeredAt: "2026-06-01T00:00:10.000Z",
          initiatedAt: "2026-06-01T00:00:00.000Z",
          durationSeconds: 60,
        }),
        call({ direction: "inbound", status: "no-answer" }),
        call({
          direction: "outbound",
          status: "completed",
          answeredAt: "2026-06-01T00:00:05.000Z",
          durationSeconds: 30,
        }),
      ],
      orders: [],
    });
    expect(result.voice).toMatchObject({
      totalCalls: 3,
      inboundCalls: 2,
      outboundCalls: 1,
      answeredCalls: 2,
      answerRate: 0.6667,
      missedCalls: 1,
      avgDurationSeconds: 45,
    });
    expect(result.voice.byStatus).toEqual({
      completed: 2,
      "no-answer": 1,
    });
  });

  it("counts only paid orders toward purchases and revenue", () => {
    const result = aggregateChannelEngagement({
      conversations: [],
      messages: [],
      voiceCalls: [],
      orders: [
        order({ status: "paid", amountTotalCents: 1999 }),
        order({ status: "paid", amountTotalCents: 500 }),
        order({ status: "pending", amountTotalCents: 9999 }),
      ],
    });
    expect(result.outcomes).toEqual({
      purchases: 2,
      purchaseRevenueCents: 2499,
    });
  });

  it("rolls a cross-channel summary across messaging + voice", () => {
    const result = aggregateChannelEngagement({
      conversations: [conv({ id: "sms1", channel: "sms" })],
      messages: [
        msg({ conversationId: "sms1", direction: "outbound" }),
        msg({ conversationId: "sms1", direction: "outbound" }),
        msg({ conversationId: "sms1", direction: "inbound" }),
      ],
      voiceCalls: [
        call({ direction: "outbound", answeredAt: "2026-06-01T00:00:05.000Z" }),
        call({ direction: "inbound" }),
      ],
      orders: [],
    });
    // outbound: 2 msgs + 1 outbound call = 3
    // inbound:  1 msg  + 1 inbound call  = 2
    // replies:  1 msg  + 1 answered call = 2
    expect(result.summary).toEqual({
      totalOutbound: 3,
      totalInbound: 2,
      totalReplies: 2,
      overallEngagementRate: 0.6667,
    });
  });
});
