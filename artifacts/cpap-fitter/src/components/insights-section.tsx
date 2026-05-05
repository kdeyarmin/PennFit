import React, { useEffect, useState } from "react";
import { Link } from "wouter";
import { Activity, ArrowRight, Sparkles } from "lucide-react";
import { fetchInsights, type CustomerInsight } from "@/lib/account-api";

/**
 * "What we noticed" section on /account (Phase G.4).
 *
 * Surfaces patient-side smart-trigger detections (leak trending up,
 * usage dropping, cushion wear, humidifier/tubing drop) when the
 * signed-in customer's email matches a patient row that has at
 * least one active trigger.
 *
 * The section is hidden entirely when the server returns an empty
 * list — most patients won't have an active detection on any given
 * day, and rendering an "all good" empty card just adds visual
 * noise.
 *
 * Why a separate route from the dashboard digest: the email-match
 * lookup is per-request scope and orthogonal to the
 * subscription/order data the dashboard digest assembles. Keeping
 * them split lets each fail (or 503) without compromising the
 * other.
 */
export function InsightsSection() {
  const [items, setItems] = useState<CustomerInsight[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchInsights();
        if (!cancelled) setItems(r.insights);
      } catch {
        // Silent failure — additive surface, see ReorderSuggestionsSection.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || !items || items.length === 0) return null;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-insights"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-[hsl(var(--penn-gold))]" />
        <h2 className="font-semibold">What we&apos;ve noticed</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Heads-ups from your therapy data. These don&apos;t replace your
        physician&apos;s advice — they&apos;re the same patterns we&apos;d flag
        to you on a check-in call.
      </p>
      <ul className="space-y-3">
        {items.map((insight) => (
          <InsightCard key={insight.id} insight={insight} />
        ))}
      </ul>
    </section>
  );
}

function InsightCard({ insight }: { insight: CustomerInsight }) {
  const detected = new Date(insight.detectedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return (
    <li
      className="rounded-lg border border-border/40 p-4 space-y-2"
      data-testid={`account-insight-${insight.kind}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <Activity className="h-4 w-4 text-[hsl(var(--penn-navy))]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
              {insight.headline}
            </h3>
            {insight.notified && (
              <span
                className="text-[10px] uppercase tracking-wide text-emerald-700 bg-emerald-50 rounded-full px-2 py-0.5"
                title="We've already emailed you about this"
              >
                Notified
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{insight.body}</p>
          <div className="text-[11px] text-muted-foreground mt-1">
            Noticed {detected}
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <Link
          href={insight.cta.url}
          className="inline-flex items-center gap-1 text-xs font-medium text-[hsl(var(--penn-navy))] hover:underline"
          data-testid={`account-insight-cta-${insight.kind}`}
        >
          {insight.cta.label}
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </li>
  );
}
