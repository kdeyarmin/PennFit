// Pure aggregation for the "cross-channel engagement" analytics surface
// (powers /admin/analytics/channel-engagement). Mirrors the
// read-then-aggregate shape of the sibling aggregators
// (lib/analytics/aggregate.ts, revenue-by-source.ts, voice-metrics.ts):
// the route does the window-bounded DB reads, this module reduces them —
// so the math is unit-testable without Postgres.
//
// One question, one view: "how is the automated outreach system doing
// across every channel it talks to patients through?" PennFit reaches
// patients/customers over four channels, and until now each had to be
// read from a different surface:
//
//   * sms / email / chat — text conversations in resupply.conversations
//                          + resupply.messages (direction inbound/outbound,
//                          delivery_status). Chat is the in-app storefront
//                          assistant; its rows carry channel 'in_app' OR
//                          'chat' — both normalise to "chat" here.
//   * voice (phone)      — the AI voice agent, tracked in the
//                          resupply.voice_calls timing ledger (answered,
//                          duration, status). Voice conversations also
//                          exist in `conversations`, but their messages are
//                          transcripts, not "replies", so voice is reported
//                          from voice_calls ONLY and the 'voice' channel is
//                          excluded from the messaging buckets to avoid
//                          double-counting.
//
// Outcomes (purchases + cash revenue) come from resupply.shop_orders so
// the page can pair engagement with the result it drives. No new schema;
// no PHI (counts + statuses only — message bodies are never read here).

import {
  aggregateVoiceMetrics,
  type VoiceCallRow,
  type VoiceMetricsResult,
} from "./voice-metrics";

/** The three text/conversation channels reported from messages. */
export type MessagingChannel = "sms" | "email" | "chat";

export interface ConversationRow {
  id: string;
  channel: string | null;
}

export interface MessageRow {
  conversationId: string | null;
  direction: string | null;
  deliveryStatus: string | null;
}

export interface OrderRow {
  status: string | null;
  amountTotalCents: number | null;
}

export interface MessagingChannelStats {
  channel: MessagingChannel;
  label: string;
  /** Conversations on this channel with activity in the window. */
  conversations: number;
  /** Messages WE sent (reminders, agent replies, automation). */
  outbound: number;
  /** Messages the patient/customer sent back — i.e. replies. */
  inbound: number;
  /** inbound / outbound. null when nothing was sent. */
  replyRate: number | null;
  /** Outbound messages confirmed delivered/sent by the vendor. */
  delivered: number;
  /** Outbound messages that bounced / failed / were dropped. */
  failed: number;
  /** delivered / (delivered + failed). null when neither is known. */
  deliveryRate: number | null;
}

export interface VoiceChannelStats {
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  answeredCalls: number;
  answerRate: number | null;
  /** Calls that rang but were never answered (no-answer / busy / hang up). */
  missedCalls: number;
  avgDurationSeconds: number | null;
  byStatus: Record<string, number>;
}

export interface ChannelEngagementOutcomes {
  /** Storefront orders that reached a paid state in the window. */
  purchases: number;
  /** Gross cash revenue (cents) from those paid orders. */
  purchaseRevenueCents: number;
}

export interface ChannelEngagementSummary {
  /** Outbound messages + outbound calls across every channel. */
  totalOutbound: number;
  /** Inbound messages + inbound calls across every channel. */
  totalInbound: number;
  /** Engagement responses: messaging replies + answered calls. */
  totalReplies: number;
  /** totalReplies / totalOutbound. null when nothing was sent. */
  overallEngagementRate: number | null;
}

export interface ChannelEngagementResult {
  messaging: MessagingChannelStats[];
  voice: VoiceChannelStats;
  outcomes: ChannelEngagementOutcomes;
  summary: ChannelEngagementSummary;
}

export interface ChannelEngagementInput {
  conversations: readonly ConversationRow[];
  messages: readonly MessageRow[];
  voiceCalls: readonly VoiceCallRow[];
  orders: readonly OrderRow[];
}

const MESSAGING_CHANNELS: readonly MessagingChannel[] = [
  "sms",
  "email",
  "chat",
];

const CHANNEL_LABELS: Record<MessagingChannel, string> = {
  sms: "SMS",
  email: "Email",
  chat: "Chat",
};

// Vendor delivery_status values seen across the SMS (Twilio) and email
// (SendGrid) paths. Anything not listed (queued / pending / deferred /
// received) is treated as "in flight / not an outbound terminal state"
// and so counts toward neither delivered nor failed.
const DELIVERED_STATUSES = new Set(["delivered", "sent"]);
const FAILED_STATUSES = new Set([
  "failed",
  "bounced",
  "dropped",
  "undelivered",
]);

/** Map a raw conversations.channel value to a reporting bucket, or null
 *  when it isn't one of the messaging channels (voice, attribution
 *  sources like 'organic'/'paid_search', etc. are excluded). */
function normalizeChannel(raw: string | null): MessagingChannel | null {
  const c = (raw ?? "").trim().toLowerCase();
  if (c === "sms") return "sms";
  if (c === "email") return "email";
  if (c === "chat" || c === "in_app") return "chat";
  return null;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round4(numerator / denominator);
}

export function aggregateChannelEngagement(
  input: ChannelEngagementInput,
): ChannelEngagementResult {
  const { conversations, messages, voiceCalls, orders } = input;

  // conversation_id -> reporting channel (only messaging channels kept).
  const channelById = new Map<string, MessagingChannel>();
  const conversationCounts: Record<MessagingChannel, number> = {
    sms: 0,
    email: 0,
    chat: 0,
  };
  for (const conv of conversations) {
    const channel = normalizeChannel(conv.channel);
    if (!channel) continue;
    channelById.set(conv.id, channel);
    conversationCounts[channel] += 1;
  }

  type Acc = {
    outbound: number;
    inbound: number;
    delivered: number;
    failed: number;
  };
  const acc: Record<MessagingChannel, Acc> = {
    sms: { outbound: 0, inbound: 0, delivered: 0, failed: 0 },
    email: { outbound: 0, inbound: 0, delivered: 0, failed: 0 },
    chat: { outbound: 0, inbound: 0, delivered: 0, failed: 0 },
  };

  for (const m of messages) {
    if (!m.conversationId) continue;
    const channel = channelById.get(m.conversationId);
    if (!channel) continue; // voice / unknown / out-of-window conversation
    const dir = (m.direction ?? "").toLowerCase();
    const bucket = acc[channel];
    if (dir === "inbound") {
      bucket.inbound += 1;
    } else if (dir === "outbound") {
      bucket.outbound += 1;
      const ds = (m.deliveryStatus ?? "").toLowerCase();
      if (DELIVERED_STATUSES.has(ds)) bucket.delivered += 1;
      else if (FAILED_STATUSES.has(ds)) bucket.failed += 1;
    }
  }

  const messaging: MessagingChannelStats[] = MESSAGING_CHANNELS.map(
    (channel) => {
      const a = acc[channel];
      return {
        channel,
        label: CHANNEL_LABELS[channel],
        conversations: conversationCounts[channel],
        outbound: a.outbound,
        inbound: a.inbound,
        replyRate: ratio(a.inbound, a.outbound),
        delivered: a.delivered,
        failed: a.failed,
        deliveryRate: ratio(a.delivered, a.delivered + a.failed),
      };
    },
  );

  // ── voice (phone) — reuse the established voice-metrics reducer ──
  const v: VoiceMetricsResult = aggregateVoiceMetrics([...voiceCalls]);
  const voice: VoiceChannelStats = {
    totalCalls: v.totalCalls,
    inboundCalls: v.byDirection.inbound,
    outboundCalls: v.byDirection.outbound,
    answeredCalls: v.answeredCalls,
    answerRate: v.answerRate,
    missedCalls: Math.max(0, v.totalCalls - v.answeredCalls),
    avgDurationSeconds: v.avgHandleSeconds,
    byStatus: v.byStatus,
  };

  // ── outcomes (purchases) ────────────────────────────────────────
  let purchases = 0;
  let purchaseRevenueCents = 0;
  for (const o of orders) {
    if (o.status === "paid") {
      purchases += 1;
      purchaseRevenueCents += o.amountTotalCents ?? 0;
    }
  }

  // ── cross-channel summary ───────────────────────────────────────
  const messagingOutbound = messaging.reduce((s, c) => s + c.outbound, 0);
  const messagingInbound = messaging.reduce((s, c) => s + c.inbound, 0);
  const totalOutbound = messagingOutbound + voice.outboundCalls;
  const totalInbound = messagingInbound + voice.inboundCalls;
  const totalReplies = messagingInbound + voice.answeredCalls;

  return {
    messaging,
    voice,
    outcomes: { purchases, purchaseRevenueCents },
    summary: {
      totalOutbound,
      totalInbound,
      totalReplies,
      overallEngagementRate: ratio(totalReplies, totalOutbound),
    },
  };
}
