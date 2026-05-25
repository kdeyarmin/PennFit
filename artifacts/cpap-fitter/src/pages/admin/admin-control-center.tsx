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

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  isHighRiskFlag,
  listFeatureFlagActivity,
  listFeatureFlags,
  toggleFeatureFlag,
  type FeatureFlag,
  type FeatureFlagActivity,
} from "@/lib/admin/feature-flags-api";

const QUERY_KEY = ["admin-feature-flags"] as const;
const ACTIVITY_QUERY_KEY = ["admin-feature-flags-activity"] as const;

/**
 * Renders the admin Control Center page with a header and three main sections: summary tiles, feature flags list, and recent activity panel.
 *
 * This component is purely presentational; child components handle data fetching and interactions.
 *
 * @returns The Control Center page React element.
 */
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
      </header>
      <SummaryTiles />
      <FlagsList />
      <ActivityPanel />
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
  // Confirmation modal state for high-risk disables. `null` = modal
  // closed. A non-null value means "the admin clicked the switch to
  // turn this off; show the modal and only commit when they type the
  // flag key correctly". Re-enabling never opens the modal — see the
  // onChange handler below.
  const [pendingDisable, setPendingDisable] = useState<FeatureFlag | null>(
    null,
  );

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
      // A successful (or even failed-then-corrected) toggle writes
      // an audit row, so the activity panel needs a refetch too.
      // Without this invalidation the panel stays stale until the
      // user manually reloads the page.
      void queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY });
    },
  });

  // Drive the toggle UI through this single handler so the
  // "high-risk disable needs a typed confirmation" rule is enforced
  // in exactly one place. Re-enables (next=true) and disables of
  // non-high-risk flags fall straight through to the optimistic
  // mutation — only the dangerous direction routes through the modal.
  const handleToggle = (next: boolean) => {
    if (!next && isHighRiskFlag(flag.key)) {
      setPendingDisable(flag);
      return;
    }
    mutation.mutate(next);
  };

  const updatedRelative = flag.updatedByEmail
    ? `Last changed by ${flag.updatedByEmail} • ${new Date(flag.updatedAt).toLocaleString()}`
    : "Default value";
  const highRisk = isHighRiskFlag(flag.key);

  return (
    <div
      className="flex items-start justify-between gap-4 px-4 py-3"
      data-testid={`flag-row-${flag.key}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-700">
            {flag.key}
          </code>
          {!flag.enabled && (
            <span className="rounded bg-amber-100 text-amber-800 px-1.5 py-0.5 text-xs font-semibold">
              Disabled
            </span>
          )}
          {highRisk && (
            <span
              className="rounded bg-rose-100 text-rose-800 px-1.5 py-0.5 text-xs font-semibold"
              title="Disabling this flag has immediate revenue or clinical impact. Confirmation required."
              data-testid={`flag-row-${flag.key}-high-risk-badge`}
            >
              High-risk
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
        onChange={handleToggle}
        ariaLabel={`Toggle ${flag.key}`}
      />
      {pendingDisable && (
        <ConfirmDisableModal
          flag={pendingDisable}
          onCancel={() => setPendingDisable(null)}
          onConfirm={() => {
            setPendingDisable(null);
            mutation.mutate(false);
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Confirmation modal for high-risk flag disables.
//
// UX contract: the admin must type the flag key EXACTLY for the
// "Disable" button to enable. Pressing Esc / clicking Cancel /
// clicking the backdrop closes the modal without firing the
// mutation. The modal is rendered into the row's existing DOM
// rather than into a portal — the admin console doesn't have
// nested-scroll containers that would clip a fixed-position
// overlay, and avoiding a portal keeps the test surface simpler.
// ─────────────────────────────────────────────────────────────────

function ConfirmDisableModal({
  flag,
  onConfirm,
  onCancel,
}: {
  flag: FeatureFlag;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const matches = typed === flag.key;

  // Focus the input on open + Esc to dismiss. A modal that doesn't
  // grab focus or respond to Esc fails the keyboard-only operator
  // test (we lean on keyboard nav for the console).
  useEffect(() => {
    inputRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`confirm-disable-title-${flag.key}`}
      onClick={onCancel}
      data-testid={`confirm-disable-${flag.key}`}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-xl border border-slate-200 p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1">
          <h3
            id={`confirm-disable-title-${flag.key}`}
            className="text-base font-bold text-slate-900"
          >
            Disable high-risk feature?
          </h3>
          <p className="text-sm text-slate-700">{flag.description}</p>
        </div>
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 space-y-1">
          <p className="font-semibold">This change takes effect within seconds.</p>
          <p>
            Type the flag key below to confirm. The disable button stays
            inactive until the key matches exactly.
          </p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Type <code className="font-mono">{flag.key}</code> to confirm
          </label>
          <input
            ref={inputRef}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Type the flag key to confirm"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
            data-testid={`confirm-disable-${flag.key}-input`}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            data-testid={`confirm-disable-${flag.key}-cancel`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!matches}
            className={[
              "rounded px-3 py-1.5 text-sm font-semibold text-white",
              matches
                ? "bg-rose-600 hover:bg-rose-700"
                : "bg-rose-300 cursor-not-allowed",
            ].join(" ")}
            data-testid={`confirm-disable-${flag.key}-confirm`}
          >
            Disable
          </button>
        </div>
      </div>
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

// ─────────────────────────────────────────────────────────────────
// Recent toggle activity panel.
//
// Last N feature-flag toggle events from feature_flag_events,
// newest first. Each line shows operator email, the flag, and the
// direction (on → off or off → on). Useful during incidents
// ("did anyone flip checkout off in the last hour?") and for
// multi-admin coordination.
//
// The panel polls every 60 seconds in case another admin made a
// change while this tab was open. Toggling a switch on this page
// also invalidates the cache (see the mutation's onSettled) so
// the feed reflects the operator's own action immediately.
/**
 * Render the Recent toggle activity panel showing recent feature-flag toggle events.
 *
 * Polls the server every 60 seconds and requests up to 20 recent activity events; renders a loading state while pending, an error message on failure, an empty-state message when no events exist, or a list of ActivityRow entries when data is available.
 *
 * @returns A section element containing the recent activity list or an appropriate loading/error/empty-state message.
 */

function ActivityPanel() {
  const query = useQuery({
    queryKey: ACTIVITY_QUERY_KEY,
    queryFn: () => listFeatureFlagActivity(20),
    refetchInterval: 60_000,
  });

  return (
    <section
      aria-label="Recent toggle activity"
      data-testid="control-center-activity"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600 mb-2">
        Recent toggle activity
      </h2>
      <div className="rounded-lg border border-slate-200 bg-white">
        {query.isPending ? (
          <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>
        ) : query.isError ? (
          <p
            className="px-4 py-3 text-sm text-rose-700"
            role="alert"
            data-testid="control-center-activity-error"
          >
            Couldn&apos;t load activity:{" "}
            {query.error instanceof Error ? query.error.message : "unknown"}
          </p>
        ) : (query.data?.activity ?? []).length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">
            No toggle events recorded yet. Flipping a switch above will
            show up here.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {(query.data?.activity ?? []).map((row, i) => (
              <ActivityRow key={`${row.occurredAt}-${row.key}-${i}`} row={row} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ActivityRow({ row }: { row: FeatureFlagActivity }) {
  const when = new Date(row.occurredAt);
  const directionLabel = row.from && !row.to ? "Disabled" : !row.from && row.to ? "Enabled" : "Changed";
  // Re-enables are green; disables are amber. "Changed" (the
  // theoretical from===to case) shouldn't show up because the
  // toggle handler skips no-op writes, but if it ever does we
  // render a neutral chip.
  const chipClass =
    directionLabel === "Disabled"
      ? "bg-amber-100 text-amber-800"
      : directionLabel === "Enabled"
        ? "bg-emerald-100 text-emerald-800"
        : "bg-slate-100 text-slate-700";

  return (
    <li
      className="flex items-center gap-3 px-4 py-2 text-sm"
      data-testid={`activity-row-${row.key}`}
    >
      <span
        className={["rounded px-1.5 py-0.5 text-xs font-semibold", chipClass].join(" ")}
      >
        {directionLabel}
      </span>
      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-700">
        {row.key}
      </code>
      <span className="text-slate-600 truncate">
        {row.operatorEmail ?? "system"}
      </span>
      <span
        className="ml-auto text-xs text-slate-500"
        title={when.toLocaleString()}
      >
        {renderRelativeAge(when)}
      </span>
    </li>
  );
}
