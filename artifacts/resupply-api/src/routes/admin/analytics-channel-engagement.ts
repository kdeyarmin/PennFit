// GET /admin/analytics/channel-engagement?days=30       — JSON
// GET /admin/analytics/channel-engagement.csv?days=30   — CSV
//
// One unified scoreboard for the automated outreach system across every
// channel it reaches patients/customers through — SMS, email, chat, and
// phone (the AI voice agent) — plus the purchases that engagement drives.
//
// Answers, at a glance: how many messages did we send, how many replies
// came back, how many calls were answered vs missed/hung up, and how many
// purchases landed in the window. Pairs the existing single-channel
// surfaces (/admin/voice/metrics, the messaging inbox) into one
// admin-facing view of "is the automation working?".
//
// Read-only, window-bounded aggregation in the established analytics shape
// (route reads, lib/analytics/channel-engagement.ts reduces). No new
// schema. reports.read-gated like the sibling analytics routes.
//
// PHI: message bodies and phone numbers are never read — only
// conversation channel, message direction + delivery_status, voice-call
// timing/status, and order status + amount. shop_orders carries no PHI.

import { Router, type IRouter, type Response } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  aggregateChannelEngagement,
  type ConversationRow,
  type MessageRow,
  type OrderRow,
} from "../../lib/analytics/channel-engagement";
import { type VoiceCallRow } from "../../lib/analytics/voice-metrics";
import { safeCsvCell } from "../../lib/safe-csv-cell";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const windowSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const READ_CAP = 50_000;

// Thrown when a window holds more rows than we read in one page, so the
// aggregate would silently undercount. The route converts it to a clear
// 422 rather than returning wrong totals. (A SQL aggregation RPC would
// remove the cap entirely — tracked as a scale-out follow-up.)
class EngagementWindowTooLargeError extends Error {
  constructor(readonly cap: number) {
    super("engagement_window_too_large");
    this.name = "EngagementWindowTooLargeError";
  }
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

async function loadChannelEngagement(cutoff: string) {
  const supabase = getSupabaseServiceRoleClient();

  const [convRes, msgRes, voiceRes, orderRes] = await Promise.all([
    // Conversations active in the window (last_message_at), used to map
    // each message to its channel + count active conversations.
    supabase
      .schema("resupply")
      .from("conversations")
      .select("id, channel", { count: "exact" })
      .gte("last_message_at", cutoff)
      .order("last_message_at", { ascending: false })
      .limit(READ_CAP),
    supabase
      .schema("resupply")
      .from("messages")
      .select("conversation_id, direction, delivery_status", {
        count: "exact",
      })
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(READ_CAP),
    supabase
      .schema("resupply")
      .from("voice_calls")
      .select("status, direction, duration_seconds, initiated_at, answered_at", {
        count: "exact",
      })
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(READ_CAP),
    supabase
      .schema("resupply")
      .from("shop_orders")
      .select("status, amount_total_cents", { count: "exact" })
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(READ_CAP),
  ]);
  if (convRes.error) throw convRes.error;
  if (msgRes.error) throw msgRes.error;
  if (voiceRes.error) throw voiceRes.error;
  if (orderRes.error) throw orderRes.error;

  // Fail fast rather than silently undercount: if any capped read matched
  // more rows than we pulled, the aggregate would be wrong.
  if (
    (convRes.count ?? 0) > READ_CAP ||
    (msgRes.count ?? 0) > READ_CAP ||
    (voiceRes.count ?? 0) > READ_CAP ||
    (orderRes.count ?? 0) > READ_CAP
  ) {
    throw new EngagementWindowTooLargeError(READ_CAP);
  }

  const conversations: ConversationRow[] = (convRes.data ?? []).map((r) => ({
    id: r.id as string,
    channel: r.channel as string | null,
  }));
  const messages: MessageRow[] = (msgRes.data ?? []).map((r) => ({
    conversationId: r.conversation_id as string | null,
    direction: r.direction as string | null,
    deliveryStatus: r.delivery_status as string | null,
  }));
  const voiceCalls: VoiceCallRow[] = (voiceRes.data ?? []).map((r) => ({
    status: r.status as string | null,
    direction: r.direction as string | null,
    durationSeconds: r.duration_seconds as number | null,
    initiatedAt: r.initiated_at as string | null,
    answeredAt: r.answered_at as string | null,
  }));
  const orders: OrderRow[] = (orderRes.data ?? []).map((r) => ({
    status: r.status as string | null,
    amountTotalCents: r.amount_total_cents as number | null,
  }));

  return aggregateChannelEngagement({
    conversations,
    messages,
    voiceCalls,
    orders,
  });
}

// Translate the window-too-large sentinel into a 422 the caller can act
// on (reduce `days`). Returns true when it handled the error.
function handleWindowTooLarge(err: unknown, res: Response): boolean {
  if (err instanceof EngagementWindowTooLargeError) {
    res.status(422).json({
      error: "window_too_large",
      message: `Too many records in this window to aggregate accurately (> ${err.cap}). Choose a shorter window.`,
    });
    return true;
  }
  return false;
}

router.get(
  "/admin/analytics/channel-engagement",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    try {
      const result = await loadChannelEngagement(isoDaysAgo(days));
      res.json({ windowDays: days, ...result });
    } catch (err) {
      if (handleWindowTooLarge(err, res)) return;
      throw err;
    }
  },
);

router.get(
  "/admin/analytics/channel-engagement.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    let result: Awaited<ReturnType<typeof loadChannelEngagement>>;
    try {
      result = await loadChannelEngagement(isoDaysAgo(days));
    } catch (err) {
      if (handleWindowTooLarge(err, res)) return;
      throw err;
    }

    const filename = `channel-engagement-${days}d-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(
      "channel,conversations,outbound,inbound,reply_rate,delivered,failed,delivery_rate\n",
    );
    for (const c of result.messaging) {
      res.write(
        `${safeCsvCell(c.label)},${c.conversations},${c.outbound},${c.inbound},${
          c.replyRate ?? ""
        },${c.delivered},${c.failed},${c.deliveryRate ?? ""}\n`,
      );
    }
    // Voice is reported from the call ledger (answered vs missed), so its
    // columns map differently: conversations->totalCalls, outbound->
    // outboundCalls, inbound->inboundCalls, delivered->answeredCalls,
    // failed->missedCalls, delivery_rate->answerRate.
    const v = result.voice;
    res.write(
      `Phone (voice),${v.totalCalls},${v.outboundCalls},${v.inboundCalls},,${
        v.answeredCalls
      },${v.missedCalls},${v.answerRate ?? ""}\n`,
    );
    res.write("\n");
    res.write("metric,value\n");
    res.write(`Total outbound,${result.summary.totalOutbound}\n`);
    res.write(`Total inbound,${result.summary.totalInbound}\n`);
    res.write(`Total replies,${result.summary.totalReplies}\n`);
    res.write(
      `Overall engagement rate,${result.summary.overallEngagementRate ?? ""}\n`,
    );
    res.write(`Purchases,${result.outcomes.purchases}\n`);
    res.write(
      `Purchase revenue (USD),${(
        result.outcomes.purchaseRevenueCents / 100
      ).toFixed(2)}\n`,
    );
    res.end();
  },
);

export default router;
