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

import { humanizeAction } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  applyFeatureFlagPreset,
  isHighRiskFlag,
  listFeatureFlagActivity,
  listFeatureFlags,
  toggleFeatureFlag,
  type ApplyPresetResult,
  type FeatureFlag,
  type FeatureFlagActivity,
} from "@/lib/admin/feature-flags-api";
import { formatAppDate, formatAppDateTime } from "@/lib/utils";
import { APP_MODULES, isAppModuleKey } from "@/lib/admin/app-modules";
import {
  getGetAdminMeQueryKey,
  useGetAdminMe,
} from "@workspace/api-client-react/admin";

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
      <PageHeader
        title="Control Center"
        description="On/off switches for major features. Flipping a switch takes effect within a few seconds — no deploy required. Use these during incidents, vendor outages, or when you need to pause a campaign without canceling it."
      />
      <SummaryTiles />
      <AppModulesCard />
      <PresetCard />
      <FlagsList />
      <ActivityPanel />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Recommended-preset card — one-click "set my flags to the bundle for
// my plan". New tenants already land on the preset at onboarding; this
// lets an EXISTING tenant adopt (or re-baseline to) the recommended set
// after picking or switching a plan, instead of toggling dozens of
// switches by hand.
//
// Flow: click → dry-run POST returns the exact diff → confirm modal
// shows what will change → confirm → apply POST writes it. The shared
// QUERY_KEY/ACTIVITY_QUERY_KEY invalidation refreshes the table, tiles,
// and activity feed. A tenant with no active plan gets a 409 the card
// surfaces as a "pick a plan first" note rather than an error panel.
// ─────────────────────────────────────────────────────────────────

function PresetCard() {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<ApplyPresetResult | null>(null);
  // A short-lived success summary after an apply, e.g. "Applied the growth
  // bundle — 4 changes." Cleared when the operator interacts again.
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  const applyMutation = useMutation({
    mutationFn: () => applyFeatureFlagPreset(false),
    onSuccess: (result) => {
      setPreview(null);
      setLastSummary(
        result.changes.length === 0
          ? `Flags already match the recommended ${result.planCode} bundle.`
          : `Applied the ${result.planCode} bundle — ${result.changes.length} ${
              result.changes.length === 1 ? "flag" : "flags"
            } changed.`,
      );
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ACTIVITY_QUERY_KEY });
    },
  });

  const previewMutation = useMutation({
    mutationFn: () => applyFeatureFlagPreset(true),
    onSuccess: (result) => {
      setLastSummary(null);
      // Clear any error left over from a previous failed apply so the fresh
      // preview modal doesn't open showing a stale message.
      applyMutation.reset();
      setPreview(result);
    },
  });

  // A 409 means the tenant has no active plan to derive a preset from —
  // surface that as guidance, not a generic failure. Anything else is a
  // real error we show verbatim. Checked structurally (ApiError carries a
  // numeric `status`) rather than via `instanceof` so it doesn't depend on
  // the error class's identity surviving the bundle boundary.
  const previewErr = previewMutation.error;
  const noPlan =
    typeof previewErr === "object" &&
    previewErr !== null &&
    "status" in previewErr &&
    (previewErr as { status?: unknown }).status === 409;

  return (
    <section
      aria-label="Recommended preset"
      className="rounded-lg border border-slate-200 bg-white p-4 space-y-2"
      data-testid="control-center-preset"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">
            Recommended setup for your plan
          </h2>
          <p className="mt-1 text-sm text-slate-700">
            Set every switch below to the bundle we recommend for your current
            billing plan. You can still fine-tune any individual flag afterward
            — this just gives you a sensible starting point in one click.
          </p>
        </div>
        <button
          type="button"
          onClick={() => previewMutation.mutate()}
          disabled={previewMutation.isPending || applyMutation.isPending}
          className={[
            "shrink-0 rounded px-3 py-1.5 text-sm font-semibold text-white",
            previewMutation.isPending || applyMutation.isPending
              ? "bg-blue-300 cursor-wait"
              : "bg-blue-600 hover:bg-blue-700",
          ].join(" ")}
          data-testid="control-center-preset-button"
        >
          {previewMutation.isPending ? "Checking…" : "Apply recommended preset"}
        </button>
      </div>

      {noPlan && (
        <p
          className="text-xs text-amber-700"
          data-testid="control-center-preset-no-plan"
        >
          Pick a billing plan first (Settings → Billing) — the recommended set
          of features is based on your plan.
        </p>
      )}
      {previewMutation.isError && !noPlan && (
        <p
          className="text-xs text-rose-700"
          role="alert"
          data-testid="control-center-preset-error"
        >
          Couldn&apos;t load the recommended preset:{" "}
          {previewErr instanceof Error ? previewErr.message : "unknown"}
        </p>
      )}
      {lastSummary && (
        <p
          className="text-xs text-emerald-700"
          data-testid="control-center-preset-summary"
        >
          {lastSummary}
        </p>
      )}

      {preview && (
        <ApplyPresetModal
          preview={preview}
          applying={applyMutation.isPending}
          error={applyMutation.error}
          onCancel={() => {
            setPreview(null);
            // Drop any failed-apply error so reopening the modal starts clean.
            applyMutation.reset();
          }}
          onConfirm={() => applyMutation.mutate()}
        />
      )}
    </section>
  );
}

// Confirmation modal for applying a plan preset. Shows the exact diff
// (what turns on, what turns off) before writing, and calls out any
// high-risk flag that would be disabled. Styling mirrors
// ConfirmDisableModal so the two confirmation surfaces feel consistent.
function ApplyPresetModal({
  preview,
  applying,
  error,
  onConfirm,
  onCancel,
}: {
  preview: ApplyPresetResult;
  applying: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const toEnable = preview.changes.filter((c) => c.to);
  const toDisable = preview.changes.filter((c) => !c.to);
  const riskyDisables = toDisable.filter((c) => isHighRiskFlag(c.key));
  const nothingToDo = preview.changes.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="apply-preset-title"
      onClick={onCancel}
      data-testid="apply-preset-modal"
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-xl border border-slate-200 p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-1">
          <h3
            id="apply-preset-title"
            className="text-base font-bold text-slate-900"
          >
            Apply the recommended {preview.planCode} bundle?
          </h3>
          <p className="text-sm text-slate-700">
            {nothingToDo
              ? "Your flags already match the recommended set — nothing to change."
              : `This will change ${preview.changes.length} ${
                  preview.changes.length === 1 ? "flag" : "flags"
                } to match the recommended set for your ${preview.planCode} plan. It takes effect within seconds.`}
          </p>
        </div>

        {riskyDisables.length > 0 && (
          <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 space-y-1">
            <p className="font-semibold">Heads up — this turns off:</p>
            <ul className="list-disc pl-5">
              {riskyDisables.map((c) => (
                <li key={c.key}>
                  {humanizeAction(c.key)} (immediate revenue / clinical impact)
                </li>
              ))}
            </ul>
          </div>
        )}

        {!nothingToDo && (
          <div className="max-h-56 overflow-auto rounded border border-slate-200 divide-y divide-slate-100 text-sm">
            {toEnable.length > 0 && (
              <ChangeGroup
                label={`Turn on (${toEnable.length})`}
                tone="on"
                changes={toEnable}
              />
            )}
            {toDisable.length > 0 && (
              <ChangeGroup
                label={`Turn off (${toDisable.length})`}
                tone="off"
                changes={toDisable}
              />
            )}
          </div>
        )}

        {error != null && (
          <p className="text-xs text-rose-700" role="alert">
            Couldn&apos;t apply:{" "}
            {error instanceof Error ? error.message : "unknown"}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            data-testid="apply-preset-cancel"
          >
            {nothingToDo ? "Close" : "Cancel"}
          </button>
          {!nothingToDo && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={applying}
              className={[
                "rounded px-3 py-1.5 text-sm font-semibold text-white",
                applying
                  ? "bg-blue-300 cursor-wait"
                  : "bg-blue-600 hover:bg-blue-700",
              ].join(" ")}
              data-testid="apply-preset-confirm"
            >
              {applying ? "Applying…" : "Apply preset"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChangeGroup({
  label,
  tone,
  changes,
}: {
  label: string;
  tone: "on" | "off";
  changes: { key: string }[];
}) {
  return (
    <div className="px-3 py-2">
      <div
        className={[
          "text-xs font-semibold uppercase tracking-wider mb-1",
          tone === "on" ? "text-emerald-700" : "text-amber-700",
        ].join(" ")}
      >
        {label}
      </div>
      <ul className="space-y-0.5">
        {changes.map((c) => (
          <li key={c.key} className="text-slate-800">
            {humanizeAction(c.key)}
          </li>
        ))}
      </ul>
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
          new Date(f.updatedAt).getTime() > new Date(latest.updatedAt).getTime()
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
        value={query.isPending ? "—" : `${enabled} of ${total}`}
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
            ? `${lastToggle.updatedByEmail ?? "unknown"} • ${humanizeAction(lastToggle.key)}`
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
      className={["rounded-lg border p-3 space-y-0.5", accentClass].join(" ")}
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
    return formatAppDateTime(when);
  }
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatAppDate(when);
}

// ─────────────────────────────────────────────────────────────────
// App Modules — "which parts of this product do we actually use?"
//
// This is a different question from every other switch on the page. The
// rest are incident controls: pause the dispatcher, stop auto-submitting
// claims, take voice offline — flipped when something is wrong, flipped
// back when it's fixed. A module switch is a setup decision that a
// tenant makes once ("we will never open a claims worklist" / "hide the
// fitter") and it pays off on every page load afterwards, because
// turning one off REMOVES that part of the console from the sidebar.
//
// So it gets its own card, at the top, grouped by where each module
// lives in the console rather than alphabetically by category — the
// order an operator thinks in when deciding what to hide. The rows come
// from the same query as the list below (no extra request) and reuse
// FlagRow, so optimistic toggling, error handling, and the
// needs-redeploy badge all behave identically.
// ─────────────────────────────────────────────────────────────────

function AppModulesCard() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listFeatureFlags,
  });

  const grouped = useMemo(() => {
    const byKey = new Map(
      (query.data?.flags ?? []).map((f) => [f.key, f] as const),
    );
    // Walk APP_MODULES (not the server rows) so the order and grouping are
    // this build's, and a module the API hasn't seeded yet simply doesn't
    // render rather than appearing in an arbitrary spot.
    const out: Array<{
      group: string;
      rows: Array<{ flag: FeatureFlag; label: string; hides: string }>;
    }> = [];
    for (const mod of APP_MODULES) {
      const flag = byKey.get(mod.key);
      if (!flag) continue;
      let bucket = out.find((g) => g.group === mod.group);
      if (!bucket) {
        bucket = { group: mod.group, rows: [] };
        out.push(bucket);
      }
      bucket.rows.push({ flag, label: mod.label, hides: mod.hides });
    }
    return out;
  }, [query.data]);

  const offCount = useMemo(
    () =>
      grouped.reduce(
        (sum, g) => sum + g.rows.filter((r) => !r.flag.enabled).length,
        0,
      ),
    [grouped],
  );

  if (query.isPending) return <Spinner />;
  // A load failure is already surfaced by FlagsList below (same query,
  // same error) — repeating the panel here would just be noise.
  if (query.isError || grouped.length === 0) return null;

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white"
      data-testid="control-center-app-modules"
    >
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">
          Parts of the app
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Switch off anything your company doesn&apos;t use and it disappears
          from the sidebar, so your team only navigates the parts they actually
          work in. Nothing is deleted — switch it back on and every page returns
          exactly as it was.
        </p>
        {offCount > 0 && (
          <p
            className="mt-1 text-xs font-semibold text-amber-700"
            data-testid="control-center-app-modules-off-count"
          >
            {offCount} {offCount === 1 ? "part is" : "parts are"} currently
            hidden from the sidebar.
          </p>
        )}
      </div>
      {grouped.map((group) => (
        <div key={group.group}>
          <h3 className="bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-slate-600">
            {group.group}
          </h3>
          <div className="divide-y divide-slate-200">
            {group.rows.map((row) => (
              <FlagRow
                key={row.flag.key}
                flag={row.flag}
                title={row.label}
                subtitle={row.hides}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function FlagsList() {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listFeatureFlags,
  });
  // A standalone Virtual Mask Fitter tenant reaches this page for exactly
  // one reason: to switch the clinical fitting engine on after their
  // clinician has signed off the size bands they dispense. Showing them
  // the whole platform's flag catalog would list toggles for modules
  // their plan does not include and their console cannot reach — inert
  // switches that read as features they own. Narrow it to theirs.
  const { data: adminMe } = useGetAdminMe();
  const fitterOnly = adminMe?.productScope === "mask_fitter";

  const grouped = useMemo(() => {
    const byCategory = new Map<string, FeatureFlag[]>();
    for (const f of query.data?.flags ?? []) {
      // App modules get their own card above, grouped by where they live
      // in the console instead of alphabetically by category. Listing
      // them twice would make the page longer AND less clear.
      if (isAppModuleKey(f.key)) continue;
      if (fitterOnly && !f.key.startsWith("fitter.")) continue;
      const list = byCategory.get(f.category) ?? [];
      list.push(f);
      byCategory.set(f.category, list);
    }
    return Array.from(byCategory.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    );
  }, [query.data, fitterOnly]);

  if (query.isPending) {
    return <Spinner />;
  }
  if (query.isError) {
    return (
      <ErrorPanel
        error={query.error}
        onRetry={() => void query.refetch()}
        title="Couldn't load feature flags"
      />
    );
  }
  if (grouped.length === 0) {
    return (
      <div className="text-sm text-slate-500">
        No feature flags configured. (The seed migration may not have run on
        this environment yet.)
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

function FlagRow({
  flag,
  title,
  subtitle,
}: {
  flag: FeatureFlag;
  /** Overrides the humanized key. Used by the App Modules card, where
   *  "Billing & claims" reads better than "Module billing". */
  title?: string;
  /** Overrides the server-supplied description line. */
  subtitle?: string;
}) {
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
      // The sidebar reads its disabled-module set from /admin/me, a
      // DIFFERENT query — and the app-wide defaults are staleTime 60s
      // with refetchOnWindowFocus off, so without this the operator
      // flips a module and the navigation keeps its old shape for up to
      // a minute with no way to hurry it but a reload. That reads as
      // "the switch is broken", which is a bad first impression for the
      // one feature whose entire point is visible.
      void queryClient.invalidateQueries({ queryKey: getGetAdminMeQueryKey() });
    },
  });

  // A flag whose key isn't in the running API build's catalog can't be
  // toggled — PATCH would 404 `unknown_flag`. This happens during a
  // deploy-drift window: the DB has been migrated forward to seed a newer
  // flag while the running build predates the catalog entry, so the flag
  // lists here but the switch is dead. A missing `manageable` (an older
  // API mid-deploy that doesn't send the field) is treated as toggleable
  // — the historical default.
  const manageable = flag.manageable !== false;

  // Drive the toggle UI through this single handler so the
  // "high-risk disable needs a typed confirmation" rule is enforced
  // in exactly one place. Re-enables (next=true) and disables of
  // non-high-risk flags fall straight through to the optimistic
  // mutation — only the dangerous direction routes through the modal.
  const handleToggle = (next: boolean) => {
    // Dead toggle: the running build doesn't know this key. The switch is
    // disabled too; this guard is belt-and-suspenders against a
    // programmatic call.
    if (!manageable) return;
    if (!next && isHighRiskFlag(flag.key)) {
      setPendingDisable(flag);
      return;
    }
    mutation.mutate(next);
  };

  const updatedRelative = flag.updatedByEmail
    ? `Last changed by ${flag.updatedByEmail} • ${formatAppDateTime(flag.updatedAt)}`
    : "Default value";
  const highRisk = isHighRiskFlag(flag.key);

  return (
    <div
      className="flex items-start justify-between gap-4 px-4 py-3"
      data-testid={`flag-row-${flag.key}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-sm font-semibold text-slate-900"
            title={flag.key}
          >
            {title ?? humanizeAction(flag.key)}
          </span>
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
          {!manageable && (
            <span
              className="rounded bg-indigo-100 text-indigo-800 px-1.5 py-0.5 text-xs font-semibold"
              title="This flag was added in a newer release than the one currently deployed. Redeploy to manage it here."
              data-testid={`flag-row-${flag.key}-unmanageable-badge`}
            >
              Needs redeploy
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-slate-700">
          {subtitle ?? flag.description}
        </p>
        <p className="mt-1 text-xs text-slate-500">{updatedRelative}</p>
        {!manageable && (
          <p
            className="mt-1 text-xs text-indigo-700"
            data-testid={`flag-row-${flag.key}-unmanageable-note`}
          >
            Added in a newer release than the one currently deployed — redeploy
            to manage this flag here.
          </p>
        )}
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
        disabled={!manageable}
        onChange={handleToggle}
        ariaLabel={`Toggle ${humanizeAction(flag.key)}`}
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
  // Confirm against the human-readable feature name (e.g. "Voice Agent")
  // rather than the raw `voice.agent` slug — the rest of the Control
  // Center no longer surfaces the code-level key, so asking an operator
  // to type it would mean retyping a string they can't see.
  const flagLabel = humanizeAction(flag.key);
  const matches = typed === flagLabel;

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
          <p className="font-semibold">
            This change takes effect within seconds.
          </p>
          <p>
            Type the feature name below to confirm. The disable button stays
            inactive until it matches exactly.
          </p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Type <span className="font-semibold">{flagLabel}</span> to confirm
          </label>
          <input
            ref={inputRef}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Type the feature name to confirm"
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
  disabled = false,
  onChange,
  ariaLabel,
}: {
  enabled: boolean;
  loading: boolean;
  disabled?: boolean;
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
      disabled={loading || disabled}
      className={[
        "relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
        enabled ? "bg-blue-600" : "bg-slate-300",
        disabled
          ? "opacity-50 cursor-not-allowed"
          : loading
            ? "opacity-60 cursor-wait"
            : "cursor-pointer",
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
            No toggle events recorded yet. Flipping a switch above will show up
            here.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {(query.data?.activity ?? []).map((row, i) => (
              <ActivityRow
                key={`${row.occurredAt}-${row.key}-${i}`}
                row={row}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ActivityRow({ row }: { row: FeatureFlagActivity }) {
  const when = new Date(row.occurredAt);
  const directionLabel =
    row.from && !row.to
      ? "Disabled"
      : !row.from && row.to
        ? "Enabled"
        : "Changed";
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
        className={[
          "rounded px-1.5 py-0.5 text-xs font-semibold",
          chipClass,
        ].join(" ")}
      >
        {directionLabel}
      </span>
      <span className="font-medium text-slate-800" title={row.key}>
        {humanizeAction(row.key)}
      </span>
      <span className="text-slate-600 truncate">
        {row.operatorEmail ?? "system"}
      </span>
      <span
        className="ml-auto text-xs text-slate-500"
        title={formatAppDateTime(when)}
      >
        {renderRelativeAge(when)}
      </span>
    </li>
  );
}
