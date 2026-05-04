// PHI sweep status card — surfaces the most-recent
// `prescription.attachment.sweep` audit row on the admin dashboard
// so operators can see at a glance whether the weekly orphan-
// attachment job is healthy.
//
// State machine (visual)
// ----------------------
//                       ┌────────────────────────┐
//   data === null   →   │  Never run             │   muted grey
//                       └────────────────────────┘
//                       ┌────────────────────────┐
//   no errors AND       │  Healthy               │   green tint
//   ran in last 14d →   └────────────────────────┘
//                       ┌────────────────────────┐
//   any error / stale → │  Needs attention       │   amber tint
//                       └────────────────────────┘
//
// "Needs attention" criteria mirror the worker's failure modes:
//   - delete_errors > 0          → object-storage delete API failed
//   - orphans_no_time_created > 0 → bucket entries we couldn't safely
//     age-gate (see worker's `Counters semantics`)
//   - lastRunAt > 14 days        → cron is supposed to fire weekly,
//     so two missed runs is the alarm threshold
//
// Why the relative-time format is hand-rolled
// -------------------------------------------
// The dashboard intentionally has zero day.js / date-fns / moment
// dependency for one tiny piece of "N days ago" formatting. Cheaper
// and clearer to do the arithmetic inline than to pull in a date
// library. Localization is not a goal — admin UI is English-only.

import { useMemo } from "react";
import type { PhiSweepStatus } from "@workspace/api-client-react/admin";

interface Props {
  data: PhiSweepStatus | null | undefined;
  isLoading: boolean;
}

/** 14 days in ms — see `Needs attention` criterion 3 above. */
const STALENESS_MS = 14 * 24 * 60 * 60 * 1000;

type Tone = "loading" | "never" | "healthy" | "attention";

interface ToneStyles {
  bg: string;
  border: string;
  badgeBg: string;
  badgeText: string;
  badgeLabel: string;
}

const TONE_STYLES: Record<Tone, ToneStyles> = {
  loading: {
    bg: "hsl(var(--surface-1))",
    border: "hsl(var(--line-1))",
    badgeBg: "hsl(var(--surface-3))",
    badgeText: "hsl(var(--ink-2))",
    badgeLabel: "Loading…",
  },
  never: {
    bg: "hsl(var(--surface-1))",
    border: "hsl(var(--line-1))",
    badgeBg: "hsl(var(--surface-3))",
    badgeText: "hsl(var(--ink-2))",
    badgeLabel: "No run yet",
  },
  healthy: {
    // Soft brand-aligned emerald — pulls from the --tone-emerald
    // status token so a healthy PHI-sweep card matches every other
    // success-state surface in the console.
    bg: "hsl(var(--tone-emerald) / 0.08)",
    border: "hsl(var(--tone-emerald) / 0.32)",
    badgeBg: "hsl(var(--tone-emerald) / 0.20)",
    badgeText: "hsl(var(--tone-emerald) / 0.95)",
    badgeLabel: "Healthy",
  },
  attention: {
    // Soft amber — pulls from --tone-amber; same vocabulary the
    // status pills + breaching-SLA timers use.
    bg: "hsl(var(--tone-amber) / 0.10)",
    border: "hsl(var(--tone-amber) / 0.45)",
    badgeBg: "hsl(var(--tone-amber) / 0.32)",
    badgeText: "hsl(38 80% 24%)",
    badgeLabel: "Needs attention",
  },
};

/**
 * Render a byte count as a short human-friendly string. Same rules
 * the rest of the app uses for attachment sizes (binary KiB/MiB/GiB),
 * with a single decimal at MiB+ for readability. Hand-rolled to keep
 * the dashboard zero-dependency on a humanize-bytes lib.
 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const kib = n / 1024;
  if (kib < 1024) return `${Math.round(kib)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  const gib = mib / 1024;
  return `${gib.toFixed(2)} GiB`;
}

function formatRelative(lastRunAt: string, now: number): string {
  const t = new Date(lastRunAt).getTime();
  if (Number.isNaN(t)) return lastRunAt;
  const deltaMs = now - t;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

export function PhiSweepStatusCard({ data, isLoading }: Props) {
  // Stable "now" for one render — keeps the relative time and the
  // 14-day staleness check aligned even if the component re-renders
  // mid-second.
  const now = useMemo(() => Date.now(), []);

  const tone: Tone = (() => {
    if (isLoading && data === undefined) return "loading";
    if (!data) return "never";
    const lastRunMs = new Date(data.lastRunAt).getTime();
    const stale = Number.isFinite(lastRunMs) && now - lastRunMs > STALENESS_MS;
    const hasErrors =
      data.counters.deleteErrors > 0 || data.counters.orphansNoTimeCreated > 0;
    return hasErrors || stale ? "attention" : "healthy";
  })();

  const styles = TONE_STYLES[tone];

  return (
    <section
      data-testid="phi-sweep-status-card"
      data-tone={tone}
      className="rounded-lg border p-5"
      style={{ backgroundColor: styles.bg, borderColor: styles.border }}
    >
      <header className="flex items-center justify-between mb-3">
        <h2
          className="text-base font-semibold"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Weekly PHI attachment sweep
        </h2>
        <span
          className="text-xs font-medium px-2 py-0.5 rounded-full"
          style={{
            backgroundColor: styles.badgeBg,
            color: styles.badgeText,
          }}
          data-testid="phi-sweep-status-badge"
        >
          {styles.badgeLabel}
        </span>
      </header>

      {tone === "loading" && (
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Loading sweep status…
        </p>
      )}

      {tone === "never" && (
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          No sweep has run yet. The job is scheduled weekly at 03:13 UTC on
          Sunday — first run will appear here once it completes.
        </p>
      )}

      {data && (tone === "healthy" || tone === "attention") && (
        <PhiSweepDetails data={data} now={now} tone={tone} />
      )}
    </section>
  );
}

function PhiSweepDetails({
  data,
  now,
  tone,
}: {
  data: PhiSweepStatus;
  now: number;
  tone: Extract<Tone, "healthy" | "attention">;
}) {
  const c = data.counters;
  const relative = formatRelative(data.lastRunAt, now);
  const lastRunIso = new Date(data.lastRunAt).toISOString();

  // When we're in "attention" tone, surface the failing counters
  // first and prominently. When healthy, show the standard summary
  // line with the most useful stats.
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
        Last ran <strong>{relative}</strong>{" "}
        <time
          dateTime={lastRunIso}
          className="text-xs"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          ({lastRunIso})
        </time>
      </p>

      {tone === "attention" && (
        <ul
          className="text-sm space-y-1"
          style={{ color: "#92400e" }}
          data-testid="phi-sweep-attention-list"
        >
          {c.deleteErrors > 0 && (
            <li>
              <strong>{c.deleteErrors}</strong> delete error
              {c.deleteErrors === 1 ? "" : "s"} — object-storage delete API
              failed; investigate worker logs.
            </li>
          )}
          {c.orphansNoTimeCreated > 0 && (
            <li>
              <strong>{c.orphansNoTimeCreated}</strong> orphan
              {c.orphansNoTimeCreated === 1 ? "" : "s"} could not be age-checked
              (no <code>timeCreated</code>); manual review recommended.
            </li>
          )}
        </ul>
      )}

      <dl
        className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs"
        style={{ color: "hsl(var(--ink-2))" }}
        data-testid="phi-sweep-counters"
      >
        <Counter label="Objects scanned" value={c.objectsScanned} />
        <Counter label="References loaded" value={c.referencesLoaded} />
        <Counter label="Orphans deleted" value={c.orphansDeleted} />
        <Counter
          label="Bytes reclaimed"
          value={formatBytes(c.bytesReclaimed)}
          testId="phi-sweep-bytes-reclaimed"
        />
        <Counter label="Too young (skipped)" value={c.orphansTooYoung} />
        <Counter label="404 (already gone)" value={c.delete404Idempotent} />
        <Counter label="Recheck saved" value={c.recheckSaved} />
      </dl>
    </div>
  );
}

function Counter({
  label,
  value,
  testId,
}: {
  label: string;
  value: number | string;
  testId?: string;
}) {
  return (
    <div className="flex justify-between gap-2" data-testid={testId}>
      <dt>{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
