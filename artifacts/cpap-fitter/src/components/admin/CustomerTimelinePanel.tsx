// Cross-channel customer activity timeline for the customer-360 page
// (Phase 4, CSR #12). One chronological feed — newest first — merging
// every way this person has touched us: in-app conversations, orders,
// returns, CSR follow-ups, and product reviews. Answers "what's the
// whole story with this customer?" without opening five separate cards.
//
// Read-only and metadata-only: each row is a kind + a short status
// descriptor + a timestamp. No message bodies, no PHI. The conversation
// rows deep-link to the existing thread; the rest are context crumbs.
// Server-gated on conversations.manage (the Customer360 scope).

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  History,
  MessageSquare,
  Package,
  RotateCcw,
  CalendarClock,
  Star,
} from "lucide-react";

import { Card } from "./Card";
import { Spinner } from "./Spinner";
import { Badge } from "./Badge";
import { ErrorPanel } from "./ErrorPanel";
import {
  getAdminCustomerTimeline,
  type CustomerEventKind,
  type CustomerTimelineEvent,
} from "@/lib/admin/customer-timeline-api";

interface Props {
  userId: string;
}

const KIND_META: Record<
  CustomerEventKind,
  {
    label: string;
    Icon: React.ComponentType<{ size?: number }>;
    variant: "info" | "success" | "warning" | "muted" | "neutral";
  }
> = {
  conversation: { label: "Message", Icon: MessageSquare, variant: "info" },
  order: { label: "Order", Icon: Package, variant: "success" },
  return: { label: "Return", Icon: RotateCcw, variant: "warning" },
  followup: { label: "Follow-up", Icon: CalendarClock, variant: "neutral" },
  review: { label: "Review", Icon: Star, variant: "muted" },
};

export function CustomerTimelinePanel({ userId }: Props) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "shop", "customers", userId, "timeline"] as const,
    queryFn: () => getAdminCustomerTimeline(userId),
    staleTime: 30_000,
  });

  return (
    <Card>
      <div style={{ padding: 16 }} data-testid="admin-customer-timeline">
        <h2
          style={{
            margin: 0,
            fontSize: 14,
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <History size={14} />
          Activity timeline
          {data && data.count > 0 && (
            <span
              style={{ color: "var(--text-muted, #475569)", fontWeight: 400 }}
            >
              ({data.count})
            </span>
          )}
        </h2>

        {isPending ? (
          <Spinner label="Loading timeline…" />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.events.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-muted, #475569)" }}>
            No activity yet — orders, messages, returns, follow-ups, and reviews
            will show up here as they happen.
          </p>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 2,
            }}
          >
            {data.events.map((e, i) => (
              <TimelineRow key={`${e.kind}:${e.refId}:${i}`} event={e} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function TimelineRow({ event }: { event: CustomerTimelineEvent }) {
  const meta = KIND_META[event.kind];
  const { Icon } = meta;
  const when = formatWhen(event.at);

  const body = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 6px",
        borderBottom: "1px solid var(--border, #e2e8f0)",
        fontSize: 13,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          color: "var(--text-muted, #475569)",
          display: "inline-flex",
          flexShrink: 0,
        }}
      >
        <Icon size={14} />
      </span>
      <Badge variant={meta.variant}>{meta.label}</Badge>
      <span style={{ color: "hsl(var(--ink-2))", flex: 1, minWidth: 0 }}>
        {event.label}
      </span>
      <span
        style={{
          color: "var(--text-muted, #475569)",
          fontSize: 12,
          whiteSpace: "nowrap",
        }}
        title={new Date(event.at).toLocaleString()}
      >
        {when}
      </span>
    </div>
  );

  // Conversations have a dedicated thread page; deep-link them. The
  // other kinds are context crumbs without a standalone view.
  if (event.kind === "conversation") {
    return (
      <li>
        <Link
          href={`/admin/conversations/${encodeURIComponent(event.refId)}`}
          className="block hover:bg-slate-50"
          data-testid="customer-timeline-conversation-link"
        >
          {body}
        </Link>
      </li>
    );
  }
  return <li>{body}</li>;
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const now = Date.now();
  const diffDays = Math.floor((now - t) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(t).toLocaleDateString();
}
