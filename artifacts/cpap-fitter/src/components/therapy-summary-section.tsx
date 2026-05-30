import React, { useEffect, useState } from "react";
import { Activity, Moon, Wind, Gauge } from "lucide-react";

import { fetchTherapySummary, type TherapySummary } from "@/lib/account-api";

/**
 * "Your therapy data" section on /account.
 *
 * Surfaces the signed-in patient's last 30 nights of CPAP usage —
 * average hours, AHI, leak rate, and Medicare-style adherence rate
 * (≥4 hours on what fraction of nights). Renders a compact set of
 * stat cards plus a bar chart of nightly usage.
 *
 * Hides itself entirely when the server reports no patient match
 * (anonymous shop customer, or email not linked to a patient row).
 * Shows a "we'll surface your data here once nightly imports start
 * flowing" empty state when the patient is linked but has no nights.
 */
export function TherapySummarySection() {
  const [summary, setSummary] = useState<TherapySummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchTherapySummary();
        if (!cancelled) setSummary(r);
      } catch {
        // Silent — additive surface like InsightsSection.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return null;
  // Anonymous customer or email not linked → render nothing.
  if (!summary || !summary.patientLinked) return null;

  return (
    <section
      className="glass-card rounded-2xl p-6 space-y-4"
      data-testid="account-therapy-summary"
    >
      <div className="flex items-center gap-2">
        <Activity className="h-5 w-5 text-[hsl(var(--penn-gold))]" />
        <h2 className="font-semibold">Your therapy data</h2>
      </div>

      {!summary.hasData ? (
        <p className="text-sm text-muted-foreground">
          We&apos;ll surface your nightly usage, AHI and mask seal numbers here
          once your device starts sending data. If your CPAP isn&apos;t already
          paired with us, message us from the chat below and we&apos;ll get you
          connected.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Last {summary.nightsWithData}{" "}
            {summary.nightsWithData === 1 ? "night" : "nights"} of therapy. The
            same numbers your physician and our team are looking at.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              icon={<Moon className="h-4 w-4" />}
              label="Avg hours / night"
              value={
                summary.avgUsageHours == null
                  ? "—"
                  : summary.avgUsageHours.toFixed(1)
              }
              hint={
                summary.avgUsageHours != null && summary.avgUsageHours >= 4
                  ? "Above the 4-hour Medicare threshold"
                  : undefined
              }
            />
            <StatCard
              icon={<Gauge className="h-4 w-4" />}
              label="Avg AHI"
              value={summary.avgAhi == null ? "—" : summary.avgAhi.toFixed(1)}
              hint={
                summary.avgAhi != null && summary.avgAhi < 5
                  ? "Within target (<5)"
                  : undefined
              }
            />
            <StatCard
              icon={<Wind className="h-4 w-4" />}
              label="Avg leak (L/min)"
              value={
                summary.avgLeakLMin == null
                  ? "—"
                  : summary.avgLeakLMin.toFixed(1)
              }
            />
            <StatCard
              icon={<Activity className="h-4 w-4" />}
              label="Adherence"
              value={
                summary.complianceRate == null
                  ? "—"
                  : `${Math.round(summary.complianceRate * 100)}%`
              }
              hint={
                summary.complianceRate != null && summary.complianceRate >= 0.7
                  ? "Meets Medicare 70% threshold"
                  : summary.complianceRate != null
                    ? `${summary.compliantNights ?? 0} of ${summary.nightsWithData} nights ≥4 hrs`
                    : undefined
              }
            />
          </div>
          <UsageBars nights={summary.nights} />
        </>
      )}
    </section>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-[hsl(var(--line-1))] p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/**
 * Tiny bar chart of nightly usage hours. SVG-only; no chart library
 * to keep the bundle thin (this component lives on /account, which
 * is on the account-tier critical path).
 *
 * Bars are colored gold when the night cleared the 4-hour adherence
 * threshold and gray otherwise, so a patient sees their compliance
 * pattern at a glance without reading numbers.
 */
function UsageBars({ nights }: { nights: TherapySummary["nights"] }) {
  if (nights.length === 0) return null;
  // Server returns newest-first; reverse for left-to-right oldest-to-newest.
  const ordered = [...nights].reverse();
  const max = Math.max(8, ...ordered.map((n) => n.usageHours ?? 0));
  const barWidth = 100 / ordered.length;

  return (
    <div className="mt-2">
      <div
        className="flex items-end gap-px h-24"
        role="img"
        aria-label="Nightly CPAP usage hours"
      >
        {ordered.map((n) => {
          const hours = n.usageHours ?? 0;
          const heightPct = (hours / max) * 100;
          const compliant = hours >= 4;
          return (
            <div
              key={n.date}
              className="relative h-full flex items-end"
              style={{ width: `${barWidth}%` }}
              title={`${n.date}: ${
                n.usageHours == null ? "no data" : `${hours.toFixed(1)} hrs`
              }${n.ahi != null ? ` · AHI ${n.ahi.toFixed(1)}` : ""}`}
            >
              <div
                className="w-full rounded-sm"
                style={{
                  height: `${heightPct}%`,
                  backgroundColor: compliant
                    ? "hsl(var(--penn-gold))"
                    : "hsl(var(--line-2))",
                  minHeight: hours > 0 ? "2px" : "0px",
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{ordered[0]?.date ?? ""}</span>
        <span>4-hour threshold shown in gold</span>
        <span>{ordered[ordered.length - 1]?.date ?? ""}</span>
      </div>
    </div>
  );
}
