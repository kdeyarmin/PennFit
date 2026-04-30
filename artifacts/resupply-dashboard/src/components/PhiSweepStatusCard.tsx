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
import type { PhiSweepStatus } from "@workspace/resupply-api-client";

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
    bg: "#f9fafb",
    border: "#e5e7eb",
    badgeBg: "#e5e7eb",
    badgeText: "#374151",
    badgeLabel: "Loading…",
  },
  never: {
    bg: "#f9fafb",
    border: "#e5e7eb",
    badgeBg: "#e5e7eb",
    badgeText: "#374151",
    badgeLabel: "No run yet",
  },
  healthy: {
    // Soft green — matches Tailwind emerald-50 / emerald-200 / emerald-700
    bg: "#ecfdf5",
    border: "#a7f3d0",
    badgeBg: "#a7f3d0",
    badgeText: "#065f46",
    badgeLabel: "Healthy",
  },
  attention: {
    // Soft amber — matches Tailwind amber-50 / amber-300 / amber-800
    bg: "#fffbeb",
    border: "#fcd34d",
    badgeBg: "#fcd34d",
    badgeText: "#92400e",
    badgeLabel: "Needs attention",
  },
};

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
    const stale =
      Number.isFinite(lastRunMs) && now - lastRunMs > STALENESS_MS;
    const hasErrors =
      data.counters.deleteErrors > 0 ||
      data.counters.orphansNoTimeCreated > 0;
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
          style={{ color: "#0a1f44" }}
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
        <p className="text-sm" style={{ color: "#374151" }}>
          Loading sweep status…
        </p>
      )}

      {tone === "never" && (
        <p className="text-sm" style={{ color: "#374151" }}>
          No sweep has run yet. The job is scheduled weekly at
          03:13 UTC on Sunday — first run will appear here once it
          completes.
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
      <p className="text-sm" style={{ color: "#374151" }}>
        Last ran <strong>{relative}</strong>{" "}
        <time
          dateTime={lastRunIso}
          className="text-xs"
          style={{ color: "#6b7280" }}
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
              {c.deleteErrors === 1 ? "" : "s"} — object-storage
              delete API failed; investigate worker logs.
            </li>
          )}
          {c.orphansNoTimeCreated > 0 && (
            <li>
              <strong>{c.orphansNoTimeCreated}</strong> orphan
              {c.orphansNoTimeCreated === 1 ? "" : "s"} could not be
              age-checked (no <code>timeCreated</code>); manual
              review recommended.
            </li>
          )}
        </ul>
      )}

      <dl
        className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs"
        style={{ color: "#374151" }}
        data-testid="phi-sweep-counters"
      >
        <Counter label="Objects scanned" value={c.objectsScanned} />
        <Counter label="References loaded" value={c.referencesLoaded} />
        <Counter label="Orphans deleted" value={c.orphansDeleted} />
        <Counter label="Too young (skipped)" value={c.orphansTooYoung} />
        <Counter
          label="404 (already gone)"
          value={c.delete404Idempotent}
        />
        <Counter label="Recheck saved" value={c.recheckSaved} />
      </dl>
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
