// /admin/nps — recent NPS rollup from the post-delivery follow-up
// email. Reads /admin/nps/recent and renders:
//
//   * Headline NPS score (% promoter − % detractor) for the window.
//   * Per-band counts (promoter / passive / detractor).
//   * A tail of the most recent comments with scores, so the CSR +
//     billing teams can act on the qualitative signal — the real
//     reason this surface exists.
//
// Dedicated page (vs. a tile on /admin/today) because NPS analysis
// is its own workflow: someone reads through the comments in one
// sitting, not five per day mixed in with returns and conversations.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, MessageSquare, Star } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { fetchRecentNps, type NpsRecentResponse } from "@/lib/admin/nps-api";

const WINDOW_OPTIONS = [7, 14, 30, 60] as const;

function bandFor(score: number): "promoter" | "passive" | "detractor" {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

const BAND_LABEL: Record<"promoter" | "passive" | "detractor", string> = {
  promoter: "Promoter",
  passive: "Passive",
  detractor: "Detractor",
};

const BAND_TONE: Record<"promoter" | "passive" | "detractor", string> = {
  promoter: "var(--accent-green, #c8efc8)",
  passive: "var(--accent-amber, #ffe2b8)",
  detractor: "var(--accent-rose, #ffd5d5)",
};

export function AdminNpsPage() {
  const [days, setDays] = useState<(typeof WINDOW_OPTIONS)[number]>(7);
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "nps-recent", days] as const,
    queryFn: () => fetchRecentNps({ days, commentLimit: 25 }),
  });

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <BarChart3 className="h-6 w-6" />
            Customer NPS
          </h1>
          <p
            className="text-sm mt-1 max-w-2xl"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Responses to the &ldquo;how likely are you to recommend us?&rdquo;
            question on the post-delivery follow-up email. Most recent rating
            per order; comments shown alongside.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOW_OPTIONS.map((d) => (
            <Button
              key={d}
              intent={d === days ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setDays(d)}
              data-testid={`admin-nps-window-${d}`}
            >
              {d}d
            </Button>
          ))}
        </div>
      </header>

      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <NpsContent data={data} />
      )}
    </div>
  );
}

function NpsContent({ data }: { data: NpsRecentResponse }) {
  return (
    <>
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-2">
          <Stat
            label="NPS"
            value={data.npsScore == null ? "—" : String(data.npsScore)}
            sub={`${data.total} responses · ${data.windowDays}d window`}
          />
          <Stat
            label="Promoters"
            value={String(data.counts.promoter)}
            sub="Score 9-10"
            tone={BAND_TONE.promoter}
          />
          <Stat
            label="Passives"
            value={String(data.counts.passive)}
            sub="Score 7-8"
            tone={BAND_TONE.passive}
          />
          <Stat
            label="Detractors"
            value={String(data.counts.detractor)}
            sub="Score 0-6"
            tone={BAND_TONE.detractor}
          />
        </div>
      </Card>

      <Card>
        <div className="space-y-1 mb-3">
          <p className="text-sm font-semibold flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Recent comments
          </p>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Latest {data.comments.length} responses with a written note. Click
            an order id to open it.
          </p>
        </div>
        {data.comments.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            No comments in the last {data.windowDays} days.
          </p>
        ) : (
          <ul className="space-y-3">
            {data.comments.map((c) => (
              <li
                key={c.id}
                className="rounded-lg border p-3"
                style={{ borderColor: "hsl(var(--surface-3))" }}
                data-testid={`admin-nps-comment-${c.id}`}
              >
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium"
                    style={{
                      backgroundColor: `hsl(${BAND_TONE[bandFor(c.score)]})`,
                    }}
                  >
                    <Star className="h-3 w-3" />
                    {c.score}/10 · {BAND_LABEL[bandFor(c.score)]}
                  </span>
                  <span style={{ color: "hsl(var(--ink-3))" }}>
                    {new Date(c.createdAt).toLocaleString()}
                  </span>
                </div>
                {c.comment && (
                  <p className="text-sm whitespace-pre-line">{c.comment}</p>
                )}
                <p
                  className="text-[11px] font-mono mt-1.5"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  Order {c.orderId.slice(0, 8)}…
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div
      className="rounded-lg p-3"
      style={{
        backgroundColor: tone ? `hsl(${tone})` : "hsl(var(--surface-2))",
      }}
    >
      <p
        className="text-[10px] uppercase tracking-[0.08em] font-medium"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </p>
      <p className="text-2xl font-semibold tabular-nums mt-0.5">{value}</p>
      {sub && (
        <p className="text-[11px] mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          {sub}
        </p>
      )}
    </div>
  );
}
