// /admin/analytics/channel-engagement — one scoreboard for the automated
// outreach system across every channel it talks to patients/customers
// through: SMS, email, and chat (messages sent, replies received,
// delivery health) plus phone (the AI voice agent: calls answered vs
// missed). Paired with the purchases that engagement drives so the admin
// can read "is the automation working?" at a glance.
//
// reports.read-gated server-side; aggregates only — no per-message PHI.

import { useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  MessageSquare,
  Mail,
  MessagesSquare,
  Phone,
  Radio,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  channelEngagementCsvUrl,
  fetchChannelEngagement,
  type ChannelEngagementResponse,
  type MessagingChannel,
  type MessagingChannelStats,
  type VoiceChannelStats,
} from "@/lib/admin/analytics-channel-engagement-api";

const WINDOWS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "12 months" },
];

const CHANNEL_ICON: Record<
  MessagingChannel,
  ComponentType<{ className?: string }>
> = {
  sms: MessageSquare,
  email: Mail,
  chat: MessagesSquare,
};

function num(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

function pct(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toLocaleString("en-US", {
    maximumFractionDigits: 1,
  })}%`;
}

function money(cents: number | null): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function duration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function AdminAnalyticsChannelEngagementPage() {
  const [days, setDays] = useState(30);

  const query = useQuery({
    queryKey: ["admin", "analytics", "channel-engagement", days] as const,
    queryFn: () => fetchChannelEngagement(days),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-analytics-channel-engagement-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Radio className="h-6 w-6" />
            Channel engagement
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            How the automated outreach system is performing across every channel
            — messages sent and replies received over SMS, email, and chat;
            calls answered vs missed on the AI phone agent — paired with the
            purchases that engagement drives.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            Window
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1 text-xs"
            >
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <a
            href={channelEngagementCsvUrl(days)}
            download
            className="inline-flex items-center gap-1 rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </a>
        </div>
      </header>

      {query.isPending ? (
        <Spinner label="Loading engagement…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <HeadlineCards data={query.data} />
          <MessagingTable rows={query.data.messaging} />
          <VoicePanel voice={query.data.voice} />
        </>
      )}
    </div>
  );
}

function HeadlineCards({ data }: { data: ChannelEngagementResponse }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Metric
        label="Outbound touches"
        value={num(data.summary.totalOutbound)}
        hint="Messages + calls we initiated"
      />
      <Metric
        label="Replies & answers"
        value={num(data.summary.totalReplies)}
        hint={`${pct(data.summary.overallEngagementRate)} engagement rate`}
      />
      <Metric
        label="Purchases"
        value={num(data.outcomes.purchases)}
        hint={`${money(data.outcomes.purchaseRevenueCents)} revenue`}
      />
      <Metric
        label="Inbound total"
        value={num(data.summary.totalInbound)}
        hint="Replies + inbound calls"
      />
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <p
        className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-1"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </p>
      <p
        className="text-2xl font-semibold tabular-nums leading-none"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {value}
      </p>
      {hint && (
        <p className="text-[11px] mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          {hint}
        </p>
      )}
    </Card>
  );
}

function MessagingTable({ rows }: { rows: MessagingChannelStats[] }) {
  const allEmpty = rows.every(
    (r) => r.outbound === 0 && r.inbound === 0 && r.conversations === 0,
  );
  return (
    <section className="space-y-2">
      <h2
        className="text-sm font-semibold"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        Messaging channels
      </h2>
      {allEmpty ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No messaging activity in this window.
          </p>
        </Card>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Channel</th>
                <th className="text-right px-3 py-2">Conversations</th>
                <th className="text-right px-3 py-2">Sent</th>
                <th className="text-right px-3 py-2">Replies</th>
                <th className="text-right px-3 py-2">Reply rate</th>
                <th className="text-right px-3 py-2">Delivered</th>
                <th className="text-right px-3 py-2">Failed</th>
                <th className="text-right px-3 py-2">Delivery rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const Icon = CHANNEL_ICON[r.channel];
                return (
                  <tr
                    key={r.channel}
                    className="border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3 py-2 text-slate-900">
                      <span className="inline-flex items-center gap-2">
                        <Icon className="h-4 w-4 text-slate-500" />
                        {r.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {num(r.conversations)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {num(r.outbound)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {num(r.inbound)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">
                      {pct(r.replyRate)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {num(r.delivered)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.failed > 0 ? (
                        <span className="text-red-600">{num(r.failed)}</span>
                      ) : (
                        num(r.failed)
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {pct(r.deliveryRate)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function VoicePanel({ voice }: { voice: VoiceChannelStats }) {
  const statusEntries = Object.entries(voice.byStatus).sort(
    (a, b) => b[1] - a[1],
  );
  return (
    <section className="space-y-2">
      <h2
        className="text-sm font-semibold flex items-center gap-2"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        <Phone className="h-4 w-4" />
        Phone (AI voice agent)
      </h2>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Metric label="Total calls" value={num(voice.totalCalls)} />
        <Metric
          label="Answered"
          value={num(voice.answeredCalls)}
          hint={`${pct(voice.answerRate)} answer rate`}
        />
        <Metric label="Missed / hung up" value={num(voice.missedCalls)} />
        <Metric
          label="Inbound / outbound"
          value={`${num(voice.inboundCalls)} / ${num(voice.outboundCalls)}`}
        />
        <Metric
          label="Avg call length"
          value={duration(voice.avgDurationSeconds)}
        />
      </div>
      {statusEntries.length > 0 && (
        <Card>
          <p
            className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-2"
            style={{ color: "hsl(var(--penn-gold-deep))" }}
          >
            Calls by status
          </p>
          <div className="flex flex-wrap gap-2">
            {statusEntries.map(([status, count]) => (
              <span
                key={status}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700"
              >
                <span className="font-medium">{status}</span>
                <span className="tabular-nums text-slate-500">
                  {num(count)}
                </span>
              </span>
            ))}
          </div>
        </Card>
      )}
    </section>
  );
}
