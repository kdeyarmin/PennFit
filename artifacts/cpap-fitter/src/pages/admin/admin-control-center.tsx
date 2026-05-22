// /admin/control-center — on/off toggles for major features.
//
// Backed by /admin/feature-flags. Reads are reports.read-gated; writes
// require admin.tools.manage (super_admin in the current 3-role
// catalog). The page calls listFeatureFlags() on mount and groups
// the rows by `category` so the Voice & AI controls sit together
// regardless of insertion order.
//
// Each toggle is optimistic: clicking the switch flips the local cache
// immediately, then patches the server. On any error we roll the
// optimistic value back and surface a per-row inline error so the
// admin sees which flag rejected.

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listFeatureFlags,
  toggleFeatureFlag,
  type FeatureFlag,
} from "@/lib/admin/feature-flags-api";

const QUERY_KEY = ["admin-feature-flags"] as const;

export function AdminControlCenterPage() {
  return (
    <div
      className="space-y-6 max-w-5xl"
      data-testid="admin-control-center-page"
    >
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Control Center
        </h1>
        <p className="text-sm text-slate-600">
          On/off switches for major features. Flipping a switch takes
          effect within a few seconds — no deploy required. Use these
          during incidents, vendor outages, or when you need to pause a
          campaign without canceling it.
        </p>
        <p className="text-xs text-slate-500">
          Changes are audited in <code>resupply.audit_log</code> with
          the action <code>feature_flag.toggle</code>.
        </p>
      </header>
      <SummaryTiles />
      <FlagsList />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Summary tiles — at-a-glance status above the flag table.
//
// Reads from the same /admin/feature-flags query that drives the
// table below. The shared queryKey means the tiles re-render
// automatically when an admin flips a switch (the table's optimistic
// update writes back to the same cache).
// ─────────────────────────────────────────────────────────────────

function SummaryTiles() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listFeatureFlags,
  });

  // We render three tiles regardless of load state (empty/loading
  // placeholders are simpler than gating the whole row). On error,
  // the table below will surface the actual message — tiles just
  // render zero counts.
  const flags = query.data?.flags ?? [];
  const total = flags.length;
  const enabled = flags.filter((f) => f.enabled).length;
  const disabled = total - enabled;

  // The seed migration inserts every flag with updated_by_email
  // NULL. An admin toggle writes the email + a fresh updated_at.
  // Filter to operator-attributed rows so the "last toggle" tile
  // doesn't show the seed time.
  const operatorTouched = flags.filter(
    (f) => f.updatedByEmail !== null && f.updatedByEmail !== undefined,
  );
  const lastToggle =
    operatorTouched.length > 0
      ? operatorTouched.reduce((latest, f) =>
          new Date(f.updatedAt).getTime() >
          new Date(latest.updatedAt).getTime()
            ? f
            : latest,
        )
      : null;

  return (
    <section
      aria-label="Feature flag summary"
      className="grid gap-3 sm:grid-cols-3"
      data-testid="control-center-summary"
    >
      <Tile
        label="Features enabled"
        value={
          query.isPending ? "—" : `${enabled} of ${total}`
        }
        accent={disabled === 0 ? "ok" : "warn"}
        testId="tile-enabled"
      />
      <Tile
        label="Disabled overrides"
        value={query.isPending ? "—" : String(disabled)}
        accent={disabled === 0 ? "ok" : "warn"}
        testId="tile-disabled"
      />
      <Tile
        label="Last toggle"
        value={
          query.isPending
            ? "—"
            : lastToggle
              ? renderRelativeAge(new Date(lastToggle.updatedAt))
              : "No operator toggles yet"
        }
        // The "by foo@example.com on <flag>" detail goes under the value.
        sublabel={
          lastToggle
            ? `${lastToggle.updatedByEmail ?? "unknown"} • ${lastToggle.key}`
            : "Seed defaults active"
        }
        accent="neutral"
        testId="tile-last-toggle"
      />
    </section>
  );
}

function Tile({
  label,
  value,
  sublabel,
  accent,
  testId,
}: {
  label: string;
  value: string;
  sublabel?: string;
  accent: "ok" | "warn" | "neutral";
  testId: string;
}) {
  const accentClass =
    accent === "ok"
      ? "border-emerald-200 bg-emerald-50"
      : accent === "warn"
        ? "border-amber-200 bg-amber-50"
        : "border-slate-200 bg-white";
  return (
    <div
      className={[
        "rounded-lg border p-3 space-y-0.5",
        accentClass,
      ].join(" ")}
      data-testid={testId}
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-600">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums text-slate-900">
        {value}
      </div>
      {sublabel && (
        <div
          className="text-xs text-slate-600 truncate"
          title={sublabel}
          data-testid={`${testId}-sublabel`}
        >
          {sublabel}
        </div>
      )}
    </div>
  );
}

// Compact "5m ago" / "2h ago" / "3d ago" formatter. Falls back to a
// localised timestamp once we're past a week — relative times stop
// being useful at that horizon.
function renderRelativeAge(when: Date): string {
  const deltaMs = Date.now() - when.getTime();
  if (Number.isNaN(deltaMs) || deltaMs < 0) {
    return when.toLocaleString();
  }
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return when.toLocaleDateString();
}

function FlagsList() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listFeatureFlags,
  });

  const grouped = useMemo(() => {
    const byCategory = new Map<string, FeatureFlag[]>();
    for (const f of query.data?.flags ?? []) {
      const list = byCategory.get(f.category) ?? [];
      list.push(f);
      byCategory.set(f.category, list);
    }
    return Array.from(byCategory.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );
  }, [query.data]);

  if (query.isPending) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }
  if (query.isError) {
    return (
      <div
        className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
        role="alert"
      >
        Couldn&apos;t load feature flags:{" "}
        {query.error instanceof Error ? query.error.message : "unknown"}
      </div>
    );
  }
  if (grouped.length === 0) {
    return (
      <div className="text-sm text-slate-500">
        No feature flags configured. (The seed migration may not have
        run on this environment yet.)
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {grouped.map(([category, flags]) => (
        <section key={category}>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600 mb-2">
            {category}
          </h2>
          <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-200">
            {flags.map((flag) => (
              <FlagRow key={flag.key} flag={flag} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FlagRow({ flag }: { flag: FeatureFlag }) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (next: boolean) => toggleFeatureFlag(flag.key, next),
    onMutate: async (next: boolean) => {
      // Optimistic: swap the row's enabled flag immediately so the
      // switch UI doesn't jitter back to the prior state while the
      // server round-trip is in flight.
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const prior = queryClient.getQueryData<{ flags: FeatureFlag[] }>(
        QUERY_KEY,
      );
      if (prior) {
        queryClient.setQueryData<{ flags: FeatureFlag[] }>(QUERY_KEY, {
          flags: prior.flags.map((f) =>
            f.key === flag.key ? { ...f, enabled: next } : f,
          ),
        });
      }
      return { prior };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prior) {
        queryClient.setQueryData(QUERY_KEY, ctx.prior);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const updatedRelative = flag.updatedByEmail
    ? `Last changed by ${flag.updatedByEmail} • ${new Date(flag.updatedAt).toLocaleString()}`
    : "Default value";

  return (
    <div
      className="flex items-start justify-between gap-4 px-4 py-3"
      data-testid={`flag-row-${flag.key}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-700">
            {flag.key}
          </code>
          {!flag.enabled && (
            <span className="rounded bg-amber-100 text-amber-800 px-1.5 py-0.5 text-xs font-semibold">
              Disabled
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-700">{flag.description}</p>
        <p className="mt-1 text-xs text-slate-500">{updatedRelative}</p>
        {mutation.isError && (
          <p
            className="mt-1 text-xs text-rose-700"
            role="alert"
            data-testid={`flag-row-${flag.key}-error`}
          >
            Couldn&apos;t toggle:{" "}
            {mutation.error instanceof Error
              ? mutation.error.message
              : "unknown"}
          </p>
        )}
      </div>
      <ToggleSwitch
        enabled={flag.enabled}
        loading={mutation.isPending}
        onChange={(next) => mutation.mutate(next)}
        ariaLabel={`Toggle ${flag.key}`}
      />
    </div>
  );
}

function ToggleSwitch({
  enabled,
  loading,
  onChange,
  ariaLabel,
}: {
  enabled: boolean;
  loading: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={ariaLabel}
      onClick={() => onChange(!enabled)}
      disabled={loading}
      className={[
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
        enabled ? "bg-blue-600" : "bg-slate-300",
        loading ? "opacity-60 cursor-wait" : "",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform",
          enabled ? "translate-x-5" : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
}
